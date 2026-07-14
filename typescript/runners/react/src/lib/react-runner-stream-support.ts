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

import { randomUUID } from "node:crypto";
import type { EpochMs } from "@tuvren/core";
import { TuvrenProviderError, TuvrenRuntimeError } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  ProviderNativeInvocationRecord,
  ProviderStreamChunk,
  TuvrenModelResponse,
} from "@tuvren/provider-api";

interface PendingToolCall {
  argsDelta: string;
  callId: string;
  done: boolean;
  input?: unknown;
  name: string;
  providerCallId: string;
  providerMetadata?: Record<string, unknown>;
}

type AccumulatedPart =
  | { done: boolean; kind: "text"; text: string }
  | { done: boolean; kind: "reasoning"; text: string; signature?: string }
  | {
      data?: unknown;
      delta: string;
      done: boolean;
      kind: "structured";
      name?: string;
    }
  | { kind: "tool_call"; state: PendingToolCall };

/**
 * Absorbs `ProviderStreamChunk`s from a provider stream and does two jobs at
 * once (framework spec §6.2 "Two Parallel Outputs"):
 *
 * - Translates each chunk into the `TuvrenStreamEvent`(s) it should produce
 *   on the live path, returned from {@link absorb} for immediate emission.
 * - Accumulates content parts (text, reasoning, structured output, tool
 *   calls, provider tool results) into a complete `TuvrenModelResponse` for
 *   the durable path, produced by {@link finalize}.
 *
 * Text and reasoning deltas coalesce onto an open part of the same kind;
 * structured-output and tool-call parts track raw JSON deltas alongside a
 * `done` flag and are only parsed once complete (or, for partial/cancelled
 * finalization, best-effort parsed from whatever was accumulated so far). A
 * `tool_call_start` chunk implicitly closes any still-open text/reasoning
 * part, since providers do not explicitly terminate those before a tool call
 * begins.
 *
 * One `StreamAccumulator` is scoped to exactly one `messageId` / one
 * provider call.
 */
export class StreamAccumulator {
  private readonly parts: AccumulatedPart[] = [];
  private readonly toolCalls = new Map<string, PendingToolCall>();
  private readonly _providerToolResults: ProviderNativeInvocationRecord[] = [];
  private finishChunk:
    | Extract<ProviderStreamChunk, { type: "finish" }>
    | undefined;
  private messageDonePublished = false;
  private readonly messageId: string;
  private readonly now: () => EpochMs;

  /**
   * @param messageId - Stamped on every event this accumulator produces.
   * @param now - Clock used to timestamp produced events.
   */
  constructor(messageId: string, now: () => EpochMs) {
    this.messageId = messageId;
    this.now = now;
  }

  /**
   * Absorbs one provider stream chunk, updating internal accumulation state
   * and returning the `TuvrenStreamEvent`(s) it produces for immediate live
   * emission (zero, one, or — for a `tool_call_start` that also closes a
   * still-open text/reasoning part — more than one).
   *
   * A `"finish"` chunk marks the message as done (see
   * {@link StreamAccumulator.messageDoneEmitted | messageDoneEmitted}) and
   * asserts every structured/tool-call part completed before it.
   *
   * @throws TuvrenProviderError when the chunk is an `"error"` chunk, or (via
   *   {@link assertCompletedProviderParts}) when `"finish"` arrives with an
   *   incomplete structured or tool-call part.
   * @throws TuvrenRuntimeError with code
   *   `react_runner_invalid_provider_stream` when an args-delta or done chunk
   *   references a `providerCallId` that was never started.
   */
  absorb(chunk: ProviderStreamChunk): TuvrenStreamEvent[] {
    switch (chunk.type) {
      case "text_delta":
        this.appendText(chunk.text);
        return [
          {
            delta: chunk.text,
            messageId: this.messageId,
            timestamp: this.now(),
            type: "text.delta",
          },
        ];
      case "reasoning_delta":
        this.appendReasoning(chunk.text, chunk.signature);
        return chunk.text.length === 0
          ? []
          : [
              {
                delta: chunk.text,
                messageId: this.messageId,
                timestamp: this.now(),
                type: "reasoning.delta",
              },
            ];
      case "reasoning_done":
        return this.completeReasoning()
          ? [
              {
                messageId: this.messageId,
                timestamp: this.now(),
                type: "reasoning.done",
              },
            ]
          : [];
      case "structured_delta":
        this.appendStructuredDelta(chunk.delta);
        return [
          {
            delta: chunk.delta,
            messageId: this.messageId,
            timestamp: this.now(),
            type: "structured.delta",
          },
        ];
      case "structured_done":
        return this.completeStructuredAndCreateEvents(chunk.data, chunk.name);
      case "tool_call_start":
        return [
          ...this.completeOpenAssistantPartsForToolCall(),
          this.startToolCall(chunk.providerCallId, chunk.name),
        ];
      case "tool_call_args_delta":
        this.appendToolCallArgs(chunk.providerCallId, chunk.delta);
        return [
          {
            callId: this.requireToolCall(chunk.providerCallId).callId,
            delta: chunk.delta,
            timestamp: this.now(),
            type: "tool_call.args_delta",
          },
        ];
      case "tool_call_done":
        return this.completeToolCallAndCreateEvents(
          chunk.providerCallId,
          chunk.input,
          chunk.name,
          chunk.providerMetadata
        );
      case "provider_tool_result": {
        // Accumulate provider-native/mediated result for pre-staging (AY002/AY004).
        const rawClass = chunk.providerMetadata?.executionClass;
        const executionClass: ProviderNativeInvocationRecord["executionClass"] =
          rawClass === "provider-native" || rawClass === "provider-mediated"
            ? rawClass
            : "provider-native";
        this._providerToolResults.push({
          callId: randomUUID(),
          executionClass,
          ...(chunk.isError === true ? { isError: true } : {}),
          name: chunk.name,
          providerCallId: chunk.providerCallId,
          ...(chunk.providerMetadata === undefined
            ? {}
            : { providerMetadata: chunk.providerMetadata }),
          result: chunk.result,
        });
        return [];
      }
      case "finish":
        this.finishChunk = cloneValue(chunk);
        this.assertCompletedProviderParts();
        this.messageDonePublished = true;
        return this.createTerminalEventsFromFinish(chunk);
      case "error":
        throw toProviderError(chunk.error);
      default:
        return [];
    }
  }

  /** Provider-native/mediated invocation results absorbed so far (AY002/AY004). */
  get providerToolResults(): ProviderNativeInvocationRecord[] {
    return this._providerToolResults;
  }

  /**
   * Builds the complete `TuvrenModelResponse` from everything absorbed so
   * far.
   *
   * Non-partial finalization (the default) requires every structured/tool-call
   * part to be complete first. Partial finalization (`options.partial: true`,
   * used on cooperative cancellation) instead best-effort-parses whatever
   * content accumulated, dropping parts that never produced usable content
   * (see {@link finalizeAccumulatedPart}).
   *
   * @param options.finishReason - Overrides the inferred finish reason (used
   *   to force `"error"` on cancellation); defaults to the finish chunk's
   *   reason, or `"tool_call"`/`"stop"` inferred from the finalized parts.
   * @param options.partial - Finalizes best-effort from incomplete state
   *   instead of requiring completion.
   * @throws TuvrenProviderError (via {@link assertCompletedProviderParts})
   *   when called non-partial with an incomplete structured or tool-call part.
   */
  finalize(options?: {
    finishReason?: TuvrenModelResponse["finishReason"];
    partial?: boolean;
  }): TuvrenModelResponse {
    const parts: TuvrenModelResponse["parts"] = [];
    const partial = options?.partial === true;
    const pendingReasoningProviderMetadata = collectReasoningProviderMetadata(
      this.finishChunk?.providerMetadata
    );

    if (!partial) {
      this.assertCompletedProviderParts();
    }

    for (const part of this.parts) {
      const finalizedPart = finalizeAccumulatedPart({
        part,
        partial,
        pendingReasoningProviderMetadata,
      });

      if (finalizedPart !== undefined) {
        parts.push(finalizedPart);
      }
    }

    return {
      finishReason:
        options?.finishReason ??
        this.finishChunk?.finishReason ??
        (parts.some((part) => part.type === "tool_call")
          ? "tool_call"
          : "stop"),
      parts,
      ...(this._providerToolResults.length > 0
        ? { providerToolResults: [...this._providerToolResults] }
        : {}),
      providerMetadata: cloneValue(this.finishChunk?.providerMetadata),
      usage: cloneValue(this.finishChunk?.usage),
    };
  }

  /** True once a `"finish"` chunk has been absorbed (its `message.done` already emitted). */
  get messageDoneEmitted(): boolean {
    return this.messageDonePublished;
  }

  /**
   * Builds the trailing events needed to close out the message when the
   * provider stream ended without a `"finish"` chunk: completion events for
   * any still-open parts, plus a final `message.done` — unless
   * `options.partial` is set and content is still incomplete (see
   * {@link hasOpenPartialContent}), in which case only the completable
   * content events are returned and `message.done` is withheld.
   */
  createTerminalEvents(
    response: TuvrenModelResponse,
    options?: { partial?: boolean }
  ): TuvrenStreamEvent[] {
    const contentEvents =
      options?.partial === true
        ? this.createPartialCompletionEvents()
        : this.createCompletionEvents();

    if (options?.partial === true && this.hasOpenPartialContent()) {
      return contentEvents;
    }

    return [
      ...contentEvents,
      {
        finishReason: response.finishReason,
        messageId: this.messageId,
        timestamp: this.now(),
        type: "message.done",
        usage: response.usage,
      },
    ];
  }

  /**
   * @throws TuvrenProviderError with code
   *   `react_runner_invalid_provider_stream` if any accumulated structured or
   *   tool-call part has not been marked done — the provider stream ended
   *   (or finished) with dangling content.
   */
  private assertCompletedProviderParts(): void {
    for (const part of this.parts) {
      switch (part.kind) {
        case "structured":
          if (!part.done) {
            throw new TuvrenProviderError(
              "provider stream finished before structured output completed",
              {
                code: "react_runner_invalid_provider_stream",
              }
            );
          }
          break;
        case "tool_call":
          if (!part.state.done) {
            throw new TuvrenProviderError(
              "provider stream finished before tool call completed",
              {
                code: "react_runner_invalid_provider_stream",
                details: {
                  providerCallId: part.state.providerCallId,
                },
              }
            );
          }
          break;
        default:
          break;
      }
    }
  }

  /** Coalesces `delta` onto the open text part, or starts a new one. */
  private appendText(delta: string): void {
    const lastPart = this.parts.at(-1);

    if (lastPart?.kind === "text" && !lastPart.done) {
      lastPart.text += delta;
      return;
    }

    this.parts.push({
      done: false,
      kind: "text",
      text: delta,
    });
  }

  /** Coalesces `delta` (and the latest `signature`) onto the open reasoning part, or starts a new one. */
  private appendReasoning(delta: string, signature?: string): void {
    const lastPart = this.parts.at(-1);

    if (lastPart?.kind === "reasoning" && !lastPart.done) {
      lastPart.text += delta;
      lastPart.signature = signature ?? lastPart.signature;
      return;
    }

    this.parts.push({
      done: false,
      kind: "reasoning",
      signature,
      text: delta,
    });
  }

  /**
   * Marks the most recent not-yet-done reasoning part as done.
   *
   * @returns `true` if an open reasoning part was found and closed, `false`
   *   if there was none (a stray `reasoning_done` with no matching part).
   */
  private completeReasoning(): boolean {
    for (let index = this.parts.length - 1; index >= 0; index -= 1) {
      const part = this.parts[index];

      if (part?.kind !== "reasoning") {
        continue;
      }

      if (part.done) {
        return false;
      }

      part.done = true;
      return true;
    }

    return false;
  }

  /** Appends `delta` onto the current structured-output raw JSON buffer. */
  private appendStructuredDelta(delta: string): void {
    const lastPart = this.parts.at(-1);

    if (lastPart?.kind === "structured") {
      lastPart.delta += delta;
      return;
    }

    this.parts.push({
      delta,
      done: false,
      kind: "structured",
    });
  }

  /** Marks the current structured-output part done with its final `data`/`name`. */
  private completeStructured(
    data: unknown,
    name?: string
  ): Extract<AccumulatedPart, { kind: "structured" }> {
    const lastPart = this.parts.at(-1);

    if (lastPart?.kind === "structured") {
      lastPart.data = cloneValue(data);
      lastPart.done = true;
      lastPart.name = name;
      return lastPart;
    }

    const part: Extract<AccumulatedPart, { kind: "structured" }> = {
      data: cloneValue(data),
      delta: "",
      done: true,
      kind: "structured",
      name,
    };
    this.parts.push(part);
    return part;
  }

  /**
   * Completes the structured-output part and returns its `structured.done`
   * event, synthesizing a `structured.delta` first if the provider's
   * `structured_done` chunk arrived with no preceding delta chunks.
   */
  private completeStructuredAndCreateEvents(
    data: unknown,
    name?: string
  ): TuvrenStreamEvent[] {
    const part = this.completeStructured(data, name);
    const events: TuvrenStreamEvent[] = [];

    if (part.delta === "") {
      const synthesizedDelta = serializeAssistantDeltaValue(data);
      part.delta = synthesizedDelta;
      events.push({
        delta: synthesizedDelta,
        messageId: this.messageId,
        timestamp: this.now(),
        type: "structured.delta",
      });
    }

    events.push({
      data: cloneValue(data),
      messageId: this.messageId,
      name,
      timestamp: this.now(),
      type: "structured.done",
    });

    return events;
  }

  /**
   * Registers a new pending tool call keyed by the provider's own call id and
   * assigns it a framework-owned `callId` (framework spec §1.5 "`callId` is
   * framework-owned").
   */
  private startToolCall(
    providerCallId: string,
    name: string
  ): Extract<TuvrenStreamEvent, { type: "tool_call.start" }> {
    const state: PendingToolCall = {
      argsDelta: "",
      callId: randomUUID(),
      done: false,
      name,
      providerCallId,
    };
    this.toolCalls.set(providerCallId, state);
    this.parts.push({
      kind: "tool_call",
      state,
    });
    return {
      callId: state.callId,
      messageId: this.messageId,
      name,
      timestamp: this.now(),
      type: "tool_call.start",
    };
  }

  /**
   * @throws TuvrenRuntimeError with code
   *   `react_runner_invalid_provider_stream` if no tool call was started for
   *   `providerCallId` (via {@link requireToolCall}).
   */
  private appendToolCallArgs(providerCallId: string, delta: string): void {
    this.requireToolCall(providerCallId).argsDelta += delta;
  }

  /**
   * Marks a pending tool call done, storing its final `input` and merging in
   * `providerMetadata` (see {@link mergeProviderMetadata}).
   *
   * @throws TuvrenRuntimeError with code
   *   `react_runner_invalid_provider_stream` if no tool call was started for
   *   `providerCallId`.
   */
  private completeToolCall(
    providerCallId: string,
    input: unknown,
    name: string,
    providerMetadata?: Record<string, unknown>
  ): void {
    const state = this.requireToolCall(providerCallId);
    state.done = true;
    state.input = cloneValue(input);
    state.name = name;
    state.providerMetadata = mergeProviderMetadata(
      state.providerMetadata,
      providerMetadata
    );
  }

  /**
   * Completes the tool call and returns its `tool_call.done` event,
   * synthesizing a `tool_call.args_delta` first if the provider's
   * `tool_call_done` chunk arrived with no preceding args-delta chunks.
   */
  private completeToolCallAndCreateEvents(
    providerCallId: string,
    input: unknown,
    name: string,
    providerMetadata?: Record<string, unknown>
  ): TuvrenStreamEvent[] {
    this.completeToolCall(providerCallId, input, name, providerMetadata);
    const state = this.requireToolCall(providerCallId);
    const events: TuvrenStreamEvent[] = [];

    if (state.argsDelta === "") {
      const synthesizedArgsDelta = serializeAssistantDeltaValue(input);
      state.argsDelta = synthesizedArgsDelta;
      events.push({
        callId: state.callId,
        delta: synthesizedArgsDelta,
        timestamp: this.now(),
        type: "tool_call.args_delta",
      });
    }

    events.push({
      callId: state.callId,
      input: cloneValue(input),
      name,
      providerMetadata: buildToolCallProviderMetadata(
        state.providerCallId,
        state.providerMetadata
      ),
      timestamp: this.now(),
      type: "tool_call.done",
    });

    return events;
  }

  /**
   * Closes any still-open text/reasoning part when a `tool_call_start` chunk
   * arrives — providers do not explicitly terminate preceding content parts
   * before starting a tool call, so the accumulator does it implicitly.
   */
  private completeOpenAssistantPartsForToolCall(): TuvrenStreamEvent[] {
    const events: TuvrenStreamEvent[] = [];

    for (const part of this.parts) {
      const event = this.createToolCallBoundaryCompletionEvent(part);

      if (event !== undefined) {
        events.push(event);
      }
    }

    return events;
  }

  /** Per-part helper for {@link completeOpenAssistantPartsForToolCall}; only text/reasoning parts close. */
  private createToolCallBoundaryCompletionEvent(
    part: AccumulatedPart
  ): TuvrenStreamEvent | undefined {
    switch (part.kind) {
      case "reasoning":
        if (part.done) {
          return undefined;
        }

        part.done = true;
        return {
          messageId: this.messageId,
          timestamp: this.now(),
          type: "reasoning.done",
        };
      case "text":
        if (part.done) {
          return undefined;
        }

        part.done = true;
        return {
          messageId: this.messageId,
          text: part.text,
          timestamp: this.now(),
          type: "text.done",
        };
      default:
        return undefined;
    }
  }

  /** Best-effort completion events for every part, used by partial finalization. */
  private createPartialCompletionEvents(): TuvrenStreamEvent[] {
    const events: TuvrenStreamEvent[] = [];

    for (const part of this.parts) {
      const event = this.createPartialCompletionEvent(part);

      if (event !== undefined) {
        events.push(event);
      }
    }

    return events;
  }

  /**
   * Per-part helper for {@link createPartialCompletionEvents}. Text and
   * reasoning always complete (their accumulated value, however partial, is
   * valid). Structured and tool-call parts only complete when their raw JSON
   * buffer parses successfully; an incomplete JSON fragment is left open
   * (see {@link hasOpenPartialContent}).
   */
  private createPartialCompletionEvent(
    part: AccumulatedPart
  ): TuvrenStreamEvent | undefined {
    switch (part.kind) {
      case "text":
        if (part.done) {
          return undefined;
        }

        part.done = true;
        return {
          messageId: this.messageId,
          text: part.text,
          timestamp: this.now(),
          type: "text.done",
        };
      case "reasoning":
        if (part.done) {
          return undefined;
        }

        part.done = true;
        return {
          messageId: this.messageId,
          timestamp: this.now(),
          type: "reasoning.done",
        };
      case "structured":
        return this.createPartialStructuredDoneEvent(part);
      case "tool_call":
        return this.createPartialToolCallDoneEvent(part.state);
      default:
        return undefined;
    }
  }

  /**
   * @returns A `structured.done` event if the buffered JSON parses (best
   *   effort, via {@link parsePartialStructuredPart}), `undefined` for an
   *   already-done or still-unparseable part.
   */
  private createPartialStructuredDoneEvent(
    part: Extract<AccumulatedPart, { kind: "structured" }>
  ): Extract<TuvrenStreamEvent, { type: "structured.done" }> | undefined {
    if (part.done) {
      return undefined;
    }

    const data = parsePartialStructuredPart(part, true);

    if (data === undefined) {
      return undefined;
    }

    part.done = true;
    return {
      data: cloneValue(data),
      messageId: this.messageId,
      name: part.name,
      timestamp: this.now(),
      type: "structured.done",
    };
  }

  /**
   * @returns A `tool_call.done` event if the buffered args JSON parses (best
   *   effort, via {@link parsePartialToolCallInput}), `undefined` for an
   *   already-done or still-unparseable call.
   */
  private createPartialToolCallDoneEvent(
    state: PendingToolCall
  ): Extract<TuvrenStreamEvent, { type: "tool_call.done" }> | undefined {
    if (state.done) {
      return undefined;
    }

    const input = parsePartialToolCallInput(state, true);

    if (input === undefined) {
      return undefined;
    }

    state.done = true;
    return {
      callId: state.callId,
      input: cloneValue(input),
      name: state.name,
      providerMetadata: buildToolCallProviderMetadata(
        state.providerCallId,
        state.providerMetadata
      ),
      timestamp: this.now(),
      type: "tool_call.done",
    };
  }

  /**
   * True when at least one structured or tool-call part's raw JSON buffer
   * has not (yet) parsed to a value — the signal
   * {@link StreamAccumulator.createTerminalEvents | createTerminalEvents}
   * uses to withhold `message.done` on a partial finalization.
   */
  private hasOpenPartialContent(): boolean {
    return this.parts.some((part) => {
      switch (part.kind) {
        case "structured":
          return !part.done;
        case "tool_call":
          return !part.state.done;
        default:
          return false;
      }
    });
  }

  /** Completion events for any still-open parts, plus `message.done` from the finish chunk. */
  private createTerminalEventsFromFinish(
    finish: Extract<ProviderStreamChunk, { type: "finish" }>
  ): TuvrenStreamEvent[] {
    return [
      ...this.createCompletionEvents(),
      {
        finishReason: finish.finishReason,
        messageId: this.messageId,
        timestamp: this.now(),
        type: "message.done",
        usage: cloneValue(finish.usage),
      },
    ];
  }

  /**
   * Completion (`*.done`) events for every not-yet-done part, parsing
   * structured/tool-call raw JSON buffers to their final value (non-partial
   * — expected to always parse at this point, since the caller has already
   * asserted completeness).
   */
  private createCompletionEvents(): TuvrenStreamEvent[] {
    const events: TuvrenStreamEvent[] = [];

    for (const part of this.parts) {
      switch (part.kind) {
        case "text":
          if (!part.done) {
            events.push({
              messageId: this.messageId,
              text: part.text,
              timestamp: this.now(),
              type: "text.done",
            });
            part.done = true;
          }
          break;
        case "reasoning":
          if (!part.done) {
            events.push({
              messageId: this.messageId,
              timestamp: this.now(),
              type: "reasoning.done",
            });
            part.done = true;
          }
          break;
        case "structured":
          if (!part.done) {
            events.push({
              data: cloneValue(part.data ?? parseStructuredValue(part.delta)),
              messageId: this.messageId,
              name: part.name,
              timestamp: this.now(),
              type: "structured.done",
            });
            part.done = true;
          }
          break;
        case "tool_call":
          if (!part.state.done) {
            events.push({
              callId: part.state.callId,
              input:
                part.state.input ?? parseStructuredValue(part.state.argsDelta),
              name: part.state.name,
              providerMetadata: buildToolCallProviderMetadata(
                part.state.providerCallId,
                part.state.providerMetadata
              ),
              timestamp: this.now(),
              type: "tool_call.done",
            });
            part.state.done = true;
          }
          break;
        default:
          break;
      }
    }

    return events;
  }

  /**
   * @throws TuvrenRuntimeError with code
   *   `react_runner_invalid_provider_stream` when no tool call was started
   *   for `providerCallId` — args/done chunks must always follow a `start`.
   */
  private requireToolCall(providerCallId: string): PendingToolCall {
    const state = this.toolCalls.get(providerCallId);

    if (state !== undefined) {
      return state;
    }

    throw new TuvrenRuntimeError(
      "tool call chunks must start before args or done",
      {
        code: "react_runner_invalid_provider_stream",
        details: {
          providerCallId,
        },
      }
    );
  }
}

/**
 * Converts one accumulated part into its final `TuvrenModelResponse` part
 * shape, or `undefined` when a partial finalization has nothing usable yet
 * (see {@link finalizeStructuredPart}, {@link finalizeToolCallPart}).
 *
 * @throws TuvrenRuntimeError with code `react_runner_invalid_model_response`
 *   for an unrecognized accumulated part kind (defensive; should be
 *   unreachable given {@link AccumulatedPart}'s closed union).
 */
function finalizeAccumulatedPart(input: {
  part: AccumulatedPart;
  partial: boolean;
  pendingReasoningProviderMetadata: Record<string, unknown>[];
}): TuvrenModelResponse["parts"][number] | undefined {
  switch (input.part.kind) {
    case "text":
      return {
        text: input.part.text,
        type: "text",
      };
    case "reasoning":
      return finalizeReasoningPart(
        input.part,
        input.partial,
        input.pendingReasoningProviderMetadata
      );
    case "structured":
      return finalizeStructuredPart(input.part, input.partial);
    case "tool_call":
      return finalizeToolCallPart(input.part, input.partial);
    default:
      throw new TuvrenRuntimeError("unsupported accumulated content part", {
        code: "react_runner_invalid_model_response",
      });
  }
}

/**
 * Finalizes a reasoning part, pairing it with the next queued provider
 * metadata entry when the part has a signature or is empty (redacted
 * reasoning carries no text but does carry provider metadata). An
 * empty/unsigned/metadata-less reasoning part is dropped when `partial`, and
 * otherwise indicates a malformed provider stream.
 *
 * @throws TuvrenProviderError with code `react_runner_invalid_provider_stream`
 *   for a non-partial finalization of an empty reasoning part with no
 *   signature or provider metadata (redacted reasoning must carry metadata).
 */
function finalizeReasoningPart(
  part: Extract<AccumulatedPart, { kind: "reasoning" }>,
  partial: boolean,
  pendingReasoningProviderMetadata: Record<string, unknown>[]
):
  | Extract<TuvrenModelResponse["parts"][number], { type: "reasoning" }>
  | undefined {
  const providerMetadata =
    part.signature !== undefined || part.text.length === 0
      ? pendingReasoningProviderMetadata.shift()
      : undefined;

  if (
    part.text.length === 0 &&
    part.signature === undefined &&
    providerMetadata === undefined
  ) {
    if (partial) {
      return undefined;
    }

    throw new TuvrenProviderError(
      "provider stream produced empty reasoning without redacted metadata",
      {
        code: "react_runner_invalid_provider_stream",
      }
    );
  }

  return {
    providerMetadata:
      providerMetadata ??
      (part.signature === undefined
        ? undefined
        : {
            signature: part.signature,
          }),
    redacted: hasAnthropicRedactedData(providerMetadata),
    text: part.text,
    type: "reasoning",
  };
}

/**
 * Finalizes a structured-output part.
 *
 * @returns `undefined` when `partial` and the buffered raw JSON has not
 *   parsed yet (see {@link parsePartialStructuredPart}).
 */
function finalizeStructuredPart(
  part: Extract<AccumulatedPart, { kind: "structured" }>,
  partial: boolean
):
  | Extract<TuvrenModelResponse["parts"][number], { type: "structured" }>
  | undefined {
  const data = parsePartialStructuredPart(part, partial);

  return data === undefined
    ? undefined
    : {
        data,
        name: part.name,
        type: "structured",
      };
}

/**
 * Finalizes a tool-call part.
 *
 * @returns `undefined` when `partial` and the buffered raw args JSON has not
 *   parsed yet (see {@link parsePartialToolCallInput}).
 */
function finalizeToolCallPart(
  part: Extract<AccumulatedPart, { kind: "tool_call" }>,
  partial: boolean
):
  | Extract<TuvrenModelResponse["parts"][number], { type: "tool_call" }>
  | undefined {
  const input = parsePartialToolCallInput(part.state, partial);

  return input === undefined
    ? undefined
    : {
        callId: part.state.callId,
        input,
        name: part.state.name,
        providerMetadata: buildToolCallProviderMetadata(
          part.state.providerCallId,
          part.state.providerMetadata
        ),
        type: "tool_call",
      };
}

/** Stamps the internal `providerCallId` onto a tool call's provider metadata for correlation. */
function buildToolCallProviderMetadata(
  providerCallId: string,
  providerMetadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  return {
    ...(providerMetadata === undefined ? {} : cloneValue(providerMetadata)),
    providerCallId,
  };
}

/**
 * Merges two provider-metadata records recursively, per provider namespace,
 * so a later chunk's metadata cannot erase keys an earlier chunk already
 * contributed under the same namespace. Provider namespaces such as
 * google/vertex can accrete continuity tokens across multiple stream chunks,
 * which motivates deep rather than shallow merging.
 */
function mergeProviderMetadata(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!isPlainObject(next)) {
    return current === undefined ? undefined : cloneValue(current);
  }

  if (!isPlainObject(current)) {
    return cloneValue(next);
  }

  const merged = cloneValue(current);

  for (const [providerName, providerValue] of Object.entries(next)) {
    const currentProviderValue = merged[providerName];

    // Provider namespaces such as google/vertex can accrete continuity tokens
    // across multiple stream chunks. Merge nested objects recursively so later
    // chunks cannot erase earlier keys that still matter for replay.
    merged[providerName] =
      isPlainObject(currentProviderValue) && isPlainObject(providerValue)
        ? mergeProviderMetadata(currentProviderValue, providerValue)
        : cloneValue(providerValue);
  }

  return merged;
}

/**
 * Extracts per-reasoning-block provider metadata from the AI SDK bridge's
 * `streamPartMetadata` array (an interop shim for providers bridged through
 * the Vercel AI SDK), keyed by the bridge's own reasoning block id and
 * merged across `reasoning-start`/`-delta`/`-end` entries, in first-seen
 * order. Returns an empty array when no bridge metadata is present.
 */
function collectReasoningProviderMetadata(
  providerMetadata: Record<string, unknown> | undefined
): Record<string, unknown>[] {
  const aiSdkBridge = isPlainObject(providerMetadata?.aiSdkBridge)
    ? providerMetadata.aiSdkBridge
    : undefined;
  const streamPartMetadata = Array.isArray(aiSdkBridge?.streamPartMetadata)
    ? aiSdkBridge.streamPartMetadata
    : [];
  const reasoningMetadataById = new Map<string, Record<string, unknown>>();
  const reasoningMetadataInOrder: Record<string, unknown>[] = [];

  for (const entry of streamPartMetadata) {
    if (
      !isPlainObject(entry) ||
      (entry.type !== "reasoning-start" &&
        entry.type !== "reasoning-delta" &&
        entry.type !== "reasoning-end") ||
      typeof entry.id !== "string"
    ) {
      continue;
    }

    const entryProviderMetadata = isPlainObject(entry.providerMetadata)
      ? entry.providerMetadata
      : undefined;

    if (entryProviderMetadata === undefined) {
      continue;
    }

    let reasoningMetadata = reasoningMetadataById.get(entry.id);

    if (reasoningMetadata === undefined) {
      reasoningMetadata = {};
      reasoningMetadataById.set(entry.id, reasoningMetadata);
      reasoningMetadataInOrder.push(reasoningMetadata);
    }

    for (const [providerName, providerValue] of Object.entries(
      entryProviderMetadata
    )) {
      reasoningMetadata[providerName] = cloneValue(providerValue);
    }
  }

  return reasoningMetadataInOrder;
}

/** True when `providerMetadata.anthropic.redactedData` is present, marking a reasoning part as redacted. */
function hasAnthropicRedactedData(
  providerMetadata: Record<string, unknown> | undefined
): boolean {
  if (!isPlainObject(providerMetadata)) {
    return false;
  }

  const anthropicMetadata = providerMetadata.anthropic;

  return (
    isPlainObject(anthropicMetadata) &&
    typeof anthropicMetadata.redactedData === "string"
  );
}

/**
 * Best-effort closes a provider stream iterator (calls `iterator.return()`
 * when present) after an error or cancellation, without awaiting or
 * propagating cleanup failures — the original outcome already in flight
 * takes priority.
 */
export function closeProviderIterator(
  iterator: AsyncIterator<ProviderStreamChunk>
): void {
  if (iterator.return === undefined) {
    return;
  }

  try {
    detachCleanup(iterator.return());
  } catch {
    // Cleanup errors must not mask the provider/cancellation outcome already in flight.
  }
}

/** Fires `promise` without awaiting it, swallowing any rejection. */
function detachCleanup(promise: PromiseLike<unknown>): void {
  Promise.resolve(promise).catch(() => {
    // Cleanup errors must not mask the provider/cancellation outcome already in flight.
  });
}

/**
 * Parses a raw JSON buffer to its final value; an empty buffer parses to
 * `null` (a structured/tool-call chunk sequence with no delta content).
 *
 * @throws TuvrenProviderError with code `react_runner_invalid_provider_stream`
 *   when `value` is non-empty and not valid JSON.
 */
function parseStructuredValue(value: string): unknown {
  if (value.length === 0) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error: unknown) {
    throw new TuvrenProviderError("provider returned invalid structured JSON", {
      cause: error,
      code: "react_runner_invalid_provider_stream",
      details: {
        value,
      },
    });
  }
}

/**
 * Resolves a structured-output part's data: the already-completed `data`
 * when set, otherwise the raw delta buffer parsed strictly (`partial`
 * falsy/undefined, throwing on invalid JSON) or best-effort (`partial: true`,
 * returning `undefined` on invalid/incomplete JSON instead of throwing).
 */
function parsePartialStructuredPart(
  part: Extract<AccumulatedPart, { kind: "structured" }>,
  partial?: boolean
): unknown {
  if (part.data !== undefined) {
    return part.data;
  }

  if (partial === true) {
    return parsePartialStructuredValue(part.delta);
  }

  return parseStructuredValue(part.delta);
}

/** Tool-call analog of {@link parsePartialStructuredPart}, over a pending tool call's args buffer. */
function parsePartialToolCallInput(
  state: PendingToolCall,
  partial?: boolean
): unknown {
  if (state.input !== undefined) {
    return state.input;
  }

  if (partial === true) {
    return parsePartialStructuredValue(state.argsDelta);
  }

  return parseStructuredValue(state.argsDelta);
}

/** Best-effort JSON parse: returns `undefined` for empty or invalid input instead of throwing. */
function parsePartialStructuredValue(value: string): unknown {
  if (value.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Serializes a value for a synthesized delta event
 * ({@link createBufferedAssistantSequence}'s single-shot delta+done pairs),
 * falling back to the literal string `"null"` for values `JSON.stringify`
 * itself returns `undefined` for (e.g. a bare `undefined` input).
 */
export function serializeAssistantDeltaValue(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/**
 * Races `operation` against `signal` aborting, rejecting with a cancellation
 * error ({@link createExecutionCancelledError}) the instant the signal aborts
 * — even if `operation` was already about to resolve — rather than waiting
 * for `operation` to settle on its own.
 *
 * @throws The cancellation error if `signal` is already aborted, aborts
 *   during the wait, or is found aborted right as `operation` resolves.
 */
export async function waitForAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  throwIfAborted(signal);

  if (signal === undefined) {
    return await operation;
  }

  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(createExecutionCancelledError(signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();

        if (signal.aborted) {
          reject(createExecutionCancelledError(signal));
          return;
        }

        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

/**
 * @throws A `TuvrenRuntimeError` with code `react_runner_execution_cancelled`
 *   when `signal` is already aborted; a no-op otherwise.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw createExecutionCancelledError(signal);
  }
}

/** Builds the canonical cancellation error, carrying `signal.reason` as `details`. */
function createExecutionCancelledError(
  signal: AbortSignal | undefined
): TuvrenRuntimeError {
  return new TuvrenRuntimeError("execution cancelled", {
    code: "react_runner_execution_cancelled",
    details: normalizeUnknownError(signal?.reason),
  });
}

/** True for the cancellation error produced by {@link createExecutionCancelledError}. */
export function isExecutionCancelledError(error: unknown): boolean {
  return isRuntimeErrorWithCode(error, "react_runner_execution_cancelled");
}

/** Wraps a non-`TuvrenProviderError` stream failure as a `react_runner_provider_failure` provider error. */
function toProviderError(error: unknown): TuvrenProviderError {
  if (error instanceof TuvrenProviderError) {
    return error;
  }

  return new TuvrenProviderError("provider stream failed", {
    cause: error,
    code: "react_runner_provider_failure",
    details: normalizeUnknownError(error),
  });
}

/** True when `error` is a `TuvrenRuntimeError` with the exact given `code`. */
function isRuntimeErrorWithCode(
  error: unknown,
  code: string
): error is TuvrenRuntimeError {
  return error instanceof TuvrenRuntimeError && error.code === code;
}

/** Extracts a message/stack pair from an unknown thrown value for error `details`. */
function normalizeUnknownError(error: unknown): {
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
