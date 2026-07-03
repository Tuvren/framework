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
import type {
  DriverAssistantEventReconciliation,
  DriverExecutionContext,
  DriverExtensionStateUpdate,
} from "@tuvren/core/driver";
import type { CustomEvent } from "@tuvren/core/events";
import type {
  AroundModelContext,
  AroundModelResult,
  TuvrenExtension,
} from "@tuvren/core/extensions";
import type { TuvrenModelResponse, TuvrenPrompt } from "@tuvren/core/provider";
import {
  createAroundModelContextSnapshot,
  createExtensionStateSnapshot,
  type NormalizedAroundModelResult,
  normalizeAroundModelResult,
  normalizeNextAroundModelContext,
} from "./react-driver-prompt.js";
import {
  type BufferedAssistantSequence,
  createBufferedAssistantSequence,
} from "./react-driver-stream.js";

export interface ModelExecutionOutcome {
  assistantEventReconciliation?: DriverAssistantEventReconciliation;
  assistantSequences: BufferedAssistantSequence[];
  cancelled?: boolean;
  response: TuvrenModelResponse;
  responseFormat?: TuvrenPrompt["responseFormat"];
  stateUpdates: DriverExtensionStateUpdate[];
}

export async function runAroundModelChain(input: {
  callProvider(
    aroundContext: AroundModelContext
  ): Promise<ModelExecutionOutcome>;
  context: DriverExecutionContext;
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

async function emitPostNextAroundModelError(
  context: DriverExecutionContext,
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
    name: "react_driver.around_model_error",
    timestamp: context.runtime.now(),
    type: "custom",
  };

  try {
    await context.runtime.emit(event);
  } catch {
    // Logging must not turn a recovered post-next wrapper failure into a model failure.
  }
}

function collectAroundModelStateUpdates(
  extensionName: string,
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[]
): DriverExtensionStateUpdate[] {
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
        code: "react_driver_invalid_around_model_recovery",
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

function cloneAssistantSequences(
  sequences: readonly BufferedAssistantSequence[]
): BufferedAssistantSequence[] {
  return sequences.map((sequence) => ({
    events: sequence.events.map((event) => cloneValue(event)),
    published: sequence.published,
    response: cloneValue(sequence.response),
  }));
}

function responsesMatch(
  left: TuvrenModelResponse,
  right: TuvrenModelResponse
): boolean {
  return isDeepStrictEqual(stripUndefinedDeep(left), stripUndefinedDeep(right));
}

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

function finishReasonMatchesDurableAssistantContent(
  finishReason: TuvrenModelResponse["finishReason"],
  parts: TuvrenModelResponse["parts"]
): boolean {
  if (parts.some((part) => part.type === "tool_call")) {
    return finishReason === "tool_call";
  }

  return finishReason !== "tool_call";
}

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
      code: "react_driver_invalid_around_model_retry",
      details: {
        finalNextResponse: lastOutcome.response,
        nextCallCount: nextOutcomes.length,
        returnedResponse: result.response,
      },
    }
  );
}

function resolveAssistantEventReconciliation(
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[]
): DriverAssistantEventReconciliation | undefined {
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
