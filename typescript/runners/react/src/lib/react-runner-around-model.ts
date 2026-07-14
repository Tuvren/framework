/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { isDeepStrictEqual } from "node:util";
import { TuvrenRuntimeError } from "@tuvren/core";
import type { CustomEvent } from "@tuvren/core/events";
import type {
  AroundModelContext,
  AroundModelResult,
  TuvrenExtension,
} from "@tuvren/core/extensions";
import type { TuvrenModelResponse, TuvrenPrompt } from "@tuvren/core/provider";
import type {
  RunnerAssistantEventReconciliation,
  RunnerExecutionContext,
  RunnerExtensionStateUpdate,
} from "@tuvren/core/runner";
import {
  createAroundModelContextSnapshot,
  createExtensionStateSnapshot,
  type NormalizedAroundModelResult,
  normalizeAroundModelResult,
  normalizeNextAroundModelContext,
} from "./react-runner-prompt.js";
import {
  type BufferedAssistantSequence,
  createBufferedAssistantSequence,
} from "./react-runner-stream.js";

/**
 * Result of running the `aroundModel` chain (or its terminal provider call)
 * for one iteration: the final model response plus everything needed to
 * finish building the `RunnerExecutionResult` and flush live stream events.
 */
export interface ModelExecutionOutcome {
  /**
   * Set to `"allow_final_sequence_divergence"` when a wrapper replaced the
   * durable response after already-published live assistant events diverge
   * from it (framework spec §5.6/§6.5 post-stream replacement).
   */
  assistantEventReconciliation?: RunnerAssistantEventReconciliation;
  /**
   * Assistant stream-event sequences produced across the chain, in emission
   * order, to be flushed to `context.runtime` once the final result is
   * assembled (see `flushBufferedAssistantSequences`).
   */
  assistantSequences: BufferedAssistantSequence[];
  /** True when the provider call underlying this outcome was cancelled. */
  cancelled?: boolean;
  /** The response this outcome represents (post short-circuit/replacement/retry). */
  response: TuvrenModelResponse;
  /** `responseFormat` in effect for the prompt that produced `response`. */
  responseFormat?: TuvrenPrompt["responseFormat"];
  /** Extension state updates accumulated across the chain, outermost last. */
  stateUpdates: RunnerExtensionStateUpdate[];
}

/**
 * Runs the `aroundModel` extension chain (framework spec §5.6/§6.5) and
 * terminates in `input.callProvider` once every wrapper has been invoked (or
 * immediately, when no agent extension declares `aroundModel`).
 *
 * Each wrapper receives an isolated `AroundModelContext` snapshot (its own
 * extension-state view) and a `next()` that recurses into the remaining
 * chain, reconciling any context replacement the wrapper passes to `next()`
 * via {@link normalizeNextAroundModelContext}. Multiple `next()` calls (retry
 * across providers) are supported: every call's outcome is collected, and the
 * final returned result is validated to match the last `next()` outcome via
 * {@link validateAroundModelRetryDurability}.
 *
 * A wrapper that throws **after** at least one `next()` call already
 * produced an outcome is treated as a recoverable "post-next" failure: the
 * error is reported through `context.runtime.emit` as a
 * `react_runner.around_model_error` custom event (swallowing emit failures)
 * and the chain falls back to the last `next()` outcome via
 * {@link createPostNextAroundModelFallbackOutcome} rather than failing the
 * turn. A wrapper that throws **before** any `next()` call propagates the
 * error unchanged — it is a genuine wrapper failure, not a recoverable
 * post-stream defect.
 *
 * @param input.callProvider - Terminal step invoked once the chain is
 *   exhausted; normally issues the actual provider call.
 * @param input.context - The runner's execution context (used for `emit` and
 *   `now` on the post-next fallback path).
 * @param input.initialContext - The `AroundModelContext` snapshot passed to
 *   the first wrapper (or directly to `callProvider` if there are none).
 * @param input.normalizeExecutionError - Converts a thrown value to an
 *   `Error` before it is reported as a post-next custom event.
 * @returns The outcome from the outermost wrapper (or the terminal call).
 */
export async function runAroundModelChain(input: {
  callProvider(
    aroundContext: AroundModelContext
  ): Promise<ModelExecutionOutcome>;
  context: RunnerExecutionContext;
  initialContext: AroundModelContext;
  normalizeExecutionError(error: unknown): Error;
}): Promise<ModelExecutionOutcome> {
  const handlers = (input.context.config.extensions ?? []).filter(
    (
      extension
    ): extension is TuvrenExtension & {
      aroundModel: NonNullable<TuvrenExtension["aroundModel"]>;
    } => extension.aroundModel !== undefined
  );

  const invokeAt = async (
    index: number,
    currentContext: AroundModelContext
  ): Promise<ModelExecutionOutcome> => {
    if (index >= handlers.length) {
      return await input.callProvider(currentContext);
    }

    const extension = handlers[index];
    const nextOutcomes: ModelExecutionOutcome[] = [];
    const extensionContext = createAroundModelContextSnapshot({
      config: currentContext.config,
      emit: currentContext.emit,
      extensionState: createExtensionStateSnapshot(
        currentContext.manifest,
        extension.name
      ),
      iterationCount: currentContext.iterationCount,
      manifest: currentContext.manifest,
      messages: currentContext.messages,
      prompt: currentContext.prompt,
      sharedExports: currentContext.sharedExports,
      tools: currentContext.tools,
    });
    let rawResult: AroundModelResult;

    try {
      rawResult = await extension.aroundModel(
        extensionContext,
        async (nextContext) => {
          const normalizedNextContext = normalizeNextAroundModelContext(
            currentContext,
            nextContext ?? extensionContext
          );
          const nextOutcome = await invokeAt(index + 1, normalizedNextContext);
          nextOutcomes.push(nextOutcome);
          return cloneValue(nextOutcome.response);
        }
      );
    } catch (error: unknown) {
      if (nextOutcomes.length === 0) {
        throw error;
      }

      await emitPostNextAroundModelError(
        input.context,
        extension.name,
        error,
        input.normalizeExecutionError
      );
      return createPostNextAroundModelFallbackOutcome(
        extension.name,
        nextOutcomes,
        input.context.runtime.now
      );
    }

    const result = normalizeAroundModelResult(rawResult);
    validateAroundModelRetryDurability(result, nextOutcomes);

    return {
      assistantEventReconciliation: resolveAssistantEventReconciliation(
        result,
        nextOutcomes
      ),
      assistantSequences: finalizeAroundModelSequences(
        result,
        nextOutcomes,
        input.context.runtime.now
      ),
      cancelled: resolveAroundModelCancellation(result, nextOutcomes),
      response: result.response,
      responseFormat: resolveAroundModelResponseFormat(
        result,
        nextOutcomes,
        currentContext,
        extensionContext
      ),
      stateUpdates: collectAroundModelStateUpdates(
        extension.name,
        result,
        nextOutcomes
      ),
    };
  };

  return await invokeAt(0, input.initialContext);
}

/**
 * Reports a wrapper failure that occurred after its `next()` call already
 * produced an outcome, as a `react_runner.around_model_error` custom event.
 * Emission failures are swallowed: logging must never turn an already
 * recovered wrapper failure into a model failure.
 */
async function emitPostNextAroundModelError(
  context: RunnerExecutionContext,
  extensionName: string,
  error: unknown,
  normalizeExecutionError: (error: unknown) => Error
): Promise<void> {
  const normalizedError = normalizeExecutionError(error);
  const event: CustomEvent = {
    data: {
      extensionName,
      message: normalizedError.message,
      name: normalizedError.name,
      phase: "post_next",
    },
    name: "react_runner.around_model_error",
    timestamp: context.runtime.now(),
    type: "custom",
  };

  try {
    await context.runtime.emit(event);
  } catch {
    // Logging must not turn a recovered post-next wrapper failure into a model failure.
  }
}

/**
 * Merges one wrapper's own returned `state` (if any) after the last `next()`
 * outcome's state updates, preserving innermost-to-outermost order.
 */
function collectAroundModelStateUpdates(
  extensionName: string,
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[]
): RunnerExtensionStateUpdate[] {
  const lastOutcome = nextOutcomes.at(-1);
  const updates =
    lastOutcome === undefined
      ? []
      : lastOutcome.stateUpdates.map((update) => ({
          extensionName: update.extensionName,
          state: cloneValue(update.state),
        }));

  if (result.state !== undefined) {
    updates.push({
      extensionName,
      state: cloneValue(result.state),
    });
  }

  return updates;
}

/**
 * Builds the fallback {@link ModelExecutionOutcome} used when a wrapper
 * throws after its `next()` call already produced a result: the outcome
 * reuses the last `next()` outcome's response verbatim, since that is the
 * last known-good state.
 *
 * @throws TuvrenRuntimeError with code
 *   `react_runner_invalid_around_model_recovery` if called with no prior
 *   `next()` outcome (should be unreachable given the caller's guard).
 */
function createPostNextAroundModelFallbackOutcome(
  extensionName: string,
  nextOutcomes: ModelExecutionOutcome[],
  now: () => number
): ModelExecutionOutcome {
  const lastOutcome = nextOutcomes.at(-1);

  if (lastOutcome === undefined) {
    throw new TuvrenRuntimeError(
      "post-next aroundModel recovery requires a next() outcome",
      {
        code: "react_runner_invalid_around_model_recovery",
      }
    );
  }

  const result: NormalizedAroundModelResult = {
    response: cloneValue(lastOutcome.response),
  };

  return {
    assistantEventReconciliation: resolveAssistantEventReconciliation(
      result,
      nextOutcomes
    ),
    assistantSequences: finalizeAroundModelSequences(result, nextOutcomes, now),
    cancelled: resolveAroundModelCancellation(result, nextOutcomes),
    response: result.response,
    responseFormat: cloneValue(lastOutcome.responseFormat),
    stateUpdates: collectAroundModelStateUpdates(
      extensionName,
      result,
      nextOutcomes
    ),
  };
}

/**
 * Determines the assistant stream-event sequences to carry forward from this
 * chain step.
 *
 * - No `next()` calls (short-circuit): synthesizes a fresh unpublished
 *   sequence for the returned response (framework spec §6.5 short-circuit).
 * - `next()` called: sequences from every retry attempt except the last are
 *   kept as-is (they were already published live and cannot be recalled).
 *   The last attempt's sequences are kept too when its response matches the
 *   final result (no replacement) or when they were already published
 *   (nothing left to replace); otherwise — an unpublished post-stream
 *   replacement — a fresh synthesized sequence for the final response
 *   replaces them.
 */
function finalizeAroundModelSequences(
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[],
  now: () => number
): BufferedAssistantSequence[] {
  if (nextOutcomes.length === 0) {
    return [createBufferedAssistantSequence(result.response, now)];
  }

  const priorSequences = nextOutcomes
    .slice(0, -1)
    .flatMap((outcome) => cloneAssistantSequences(outcome.assistantSequences));
  const lastOutcome = nextOutcomes.at(-1);

  if (lastOutcome === undefined) {
    return priorSequences;
  }

  if (responsesMatch(lastOutcome.response, result.response)) {
    return [
      ...priorSequences,
      ...cloneAssistantSequences(lastOutcome.assistantSequences),
    ];
  }

  const lastSequences = cloneAssistantSequences(lastOutcome.assistantSequences);

  if (lastSequences.some((sequence) => sequence.published)) {
    return [...priorSequences, ...lastSequences];
  }

  return [
    ...priorSequences,
    createBufferedAssistantSequence(result.response, now),
  ];
}

/** Deep-clones buffered assistant sequences, preserving each one's `published` flag. */
function cloneAssistantSequences(
  sequences: readonly BufferedAssistantSequence[]
): BufferedAssistantSequence[] {
  return sequences.map((sequence) => ({
    events: sequence.events.map((event) => cloneValue(event)),
    published: sequence.published,
    response: cloneValue(sequence.response),
  }));
}

/** Structural equality for two responses, ignoring `undefined`-valued fields. */
function responsesMatch(
  left: TuvrenModelResponse,
  right: TuvrenModelResponse
): boolean {
  return isDeepStrictEqual(stripUndefinedDeep(left), stripUndefinedDeep(right));
}

/**
 * True when `liveResponse` (already emitted as live stream events) and
 * `durableResponse` (the final response to be checkpointed) would produce
 * the same assistant stream-event sequence, part by part.
 *
 * This is the check behind the `assistantEventReconciliation` opt-in
 * (framework spec §5.6): equivalence — not identity — is what lets shared
 * core skip requiring `"allow_final_sequence_divergence"` when a
 * post-`next()` wrapper edit did not actually change observable content.
 */
function responsesEmitEquivalentAssistantEvents(
  liveResponse: TuvrenModelResponse,
  durableResponse: TuvrenModelResponse
): boolean {
  if (
    !finishReasonMatchesDurableAssistantContent(
      liveResponse.finishReason,
      durableResponse.parts
    )
  ) {
    return false;
  }

  if (liveResponse.parts.length !== durableResponse.parts.length) {
    return false;
  }

  for (const [index, livePart] of liveResponse.parts.entries()) {
    const durablePart = durableResponse.parts[index];

    if (durablePart === undefined) {
      return false;
    }

    if (!partsEmitEquivalentAssistantEvents(livePart, durablePart)) {
      return false;
    }
  }

  return true;
}

/**
 * True when a live `finishReason` is consistent with whether the durable
 * response's parts request tool calls: `"tool_call"` iff a `tool_call` part
 * is present.
 */
function finishReasonMatchesDurableAssistantContent(
  finishReason: TuvrenModelResponse["finishReason"],
  parts: TuvrenModelResponse["parts"]
): boolean {
  if (parts.some((part) => part.type === "tool_call")) {
    return finishReason === "tool_call";
  }

  return finishReason !== "tool_call";
}

/**
 * Per-part-type equivalence check backing
 * {@link responsesEmitEquivalentAssistantEvents}. Redacted reasoning parts
 * compare only on the `redacted` flag (text is not meaningfully comparable
 * once redacted); every other part type requires matching type and
 * structurally equal payload fields.
 */
function partsEmitEquivalentAssistantEvents(
  livePart: TuvrenModelResponse["parts"][number],
  durablePart: TuvrenModelResponse["parts"][number]
): boolean {
  switch (livePart.type) {
    case "file":
      return (
        durablePart.type === "file" &&
        livePart.filename === durablePart.filename &&
        livePart.mediaType === durablePart.mediaType &&
        isDeepStrictEqual(livePart.data, durablePart.data)
      );
    case "reasoning":
      return (
        durablePart.type === "reasoning" &&
        livePart.redacted === durablePart.redacted &&
        (livePart.redacted || livePart.text === durablePart.text)
      );
    case "structured":
      return (
        durablePart.type === "structured" &&
        livePart.name === durablePart.name &&
        isDeepStrictEqual(livePart.data, durablePart.data)
      );
    case "text":
      return durablePart.type === "text" && livePart.text === durablePart.text;
    case "tool_call":
      return (
        durablePart.type === "tool_call" &&
        livePart.callId === durablePart.callId &&
        livePart.name === durablePart.name &&
        isDeepStrictEqual(livePart.input, durablePart.input)
      );
    case "tool_result":
      return (
        durablePart.type === "tool_result" &&
        isDeepStrictEqual(
          stripUndefinedDeep(livePart),
          stripUndefinedDeep(durablePart)
        )
      );
    default:
      return false;
  }
}

/**
 * Determines which `responseFormat` produced `result.response`.
 *
 * When no `next()` was called, the final context's `responseFormat` applies
 * directly. When `next()` was called and the wrapper also changed
 * `responseFormat` on the context it passed in (compared to the initial
 * context), that changed value wins outright. Otherwise the format is
 * attributed to whichever prior `next()` outcome's response matches the
 * returned response (via {@link findMatchingNextOutcome}), falling back to
 * the last `next()` outcome's format for an unmatched replacement response.
 */
function resolveAroundModelResponseFormat(
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[],
  initialContext: AroundModelContext,
  finalContext: AroundModelContext
): TuvrenPrompt["responseFormat"] {
  const finalResponseFormat = finalContext.prompt.responseFormat;

  if (nextOutcomes.length === 0) {
    return cloneValue(finalResponseFormat);
  }

  if (
    !isDeepStrictEqual(
      stripUndefinedDeep(initialContext.prompt.responseFormat),
      stripUndefinedDeep(finalResponseFormat)
    )
  ) {
    return cloneValue(finalResponseFormat);
  }

  const matchingOutcome = findMatchingNextOutcome(
    result.response,
    nextOutcomes
  );

  if (matchingOutcome !== undefined) {
    return cloneValue(matchingOutcome.responseFormat);
  }

  return cloneValue(nextOutcomes.at(-1)?.responseFormat ?? finalResponseFormat);
}

/**
 * Enforces that a wrapper calling `next()` more than once returns the final
 * `next()` call's response verbatim (framework spec §6.5 retry: "Only the
 * final response ... is staged on the durable path"). A single `next()` call
 * is unconstrained — the wrapper may still transform that one response
 * (post-stream replacement).
 *
 * @throws TuvrenRuntimeError with code
 *   `react_runner_invalid_around_model_retry` when the returned response
 *   differs from the last `next()` outcome's response after two or more
 *   `next()` calls.
 */
function validateAroundModelRetryDurability(
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[]
): void {
  if (nextOutcomes.length <= 1) {
    return;
  }

  const lastOutcome = nextOutcomes.at(-1);

  if (lastOutcome === undefined) {
    return;
  }

  if (responsesMatch(lastOutcome.response, result.response)) {
    return;
  }

  throw new TuvrenRuntimeError(
    "aroundModel handlers that call next() multiple times must return the final next() response",
    {
      code: "react_runner_invalid_around_model_retry",
      details: {
        finalNextResponse: lastOutcome.response,
        nextCallCount: nextOutcomes.length,
        returnedResponse: result.response,
      },
    }
  );
}

/**
 * Determines whether this chain step's outcome needs
 * `"allow_final_sequence_divergence"` (framework spec §5.6/§6.5): required
 * when the last `next()` outcome already published live assistant events
 * that diverge from the returned durable response. Otherwise the last
 * outcome's own reconciliation flag (if any) propagates unchanged, and a
 * short-circuited step (`nextOutcomes` empty) needs none.
 */
function resolveAssistantEventReconciliation(
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[]
): RunnerAssistantEventReconciliation | undefined {
  if (nextOutcomes.length === 0) {
    return undefined;
  }

  const lastOutcome = nextOutcomes.at(-1);

  if (lastOutcome === undefined) {
    return undefined;
  }

  if (
    !responsesEmitEquivalentAssistantEvents(
      lastOutcome.response,
      result.response
    ) &&
    lastOutcome.assistantSequences.some((sequence) => sequence.published)
  ) {
    return "allow_final_sequence_divergence";
  }

  return lastOutcome.assistantEventReconciliation;
}

/**
 * True when some prior `next()` outcome was cancelled and its response
 * matches the returned response (i.e. the wrapper propagated the cancelled
 * result unchanged); `undefined` otherwise so the field is omitted rather
 * than explicitly `false`.
 */
function resolveAroundModelCancellation(
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[]
): boolean | undefined {
  return nextOutcomes.some(
    (outcome) =>
      outcome.cancelled === true &&
      responsesMatch(outcome.response, result.response)
  )
    ? true
    : undefined;
}

/**
 * Finds the most recent `next()` outcome whose response structurally matches
 * `response`, searching from the last call backward.
 */
function findMatchingNextOutcome(
  response: TuvrenModelResponse,
  nextOutcomes: ModelExecutionOutcome[]
): ModelExecutionOutcome | undefined {
  for (let index = nextOutcomes.length - 1; index >= 0; index -= 1) {
    const outcome = nextOutcomes[index];

    if (outcome !== undefined && responsesMatch(outcome.response, response)) {
      return outcome;
    }
  }

  return undefined;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefinedDeep(entry)) as T;
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, stripUndefinedDeep(entry)])
    ) as T;
  }

  return value;
}
