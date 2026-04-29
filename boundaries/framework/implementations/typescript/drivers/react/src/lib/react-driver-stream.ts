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
import type { EpochMs } from "@tuvren/core-types";
import { TuvrenProviderError, TuvrenRuntimeError } from "@tuvren/core-types";
import type { DriverRuntimePort } from "@tuvren/driver-api";
import type {
  ProviderStreamChunk,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/provider-api";
import {
  assertProviderStreamChunk,
  assertTuvrenModelResponse,
} from "@tuvren/provider-api";
import type { TuvrenMessage, TuvrenStreamEvent } from "@tuvren/runtime-api";

export interface BufferedAssistantSequence {
  cancelled?: boolean;
  events: TuvrenStreamEvent[];
  published: boolean;
  response: TuvrenModelResponse;
}

export async function executeGenerateCall(input: {
  now: () => EpochMs;
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
  signal?: AbortSignal;
}): Promise<BufferedAssistantSequence> {
  throwIfAborted(input.signal);
  const response = await waitForAbortable(
    input.provider.generate(cloneValue(input.prompt)),
    input.signal
  );
  throwIfAborted(input.signal);
  assertTuvrenModelResponse(response, "provider generate response");
  return createBufferedAssistantSequence(cloneValue(response), input.now);
}

export async function executeStreamCall(input: {
  now: () => EpochMs;
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
  runtime: DriverRuntimePort;
  signal?: AbortSignal;
}): Promise<BufferedAssistantSequence> {
  throwIfAborted(input.signal);
  const messageId = randomUUID();
  const accumulator = new StreamAccumulator(messageId, input.now);
  const events: TuvrenStreamEvent[] = [];
  await appendAndEmit(
    events,
    {
      messageId,
      role: "assistant",
      timestamp: input.now(),
      type: "message.start",
    },
    input.runtime
  );

  const iterator = input.provider
    .stream(cloneValue(input.prompt))
    [Symbol.asyncIterator]();

  try {
    while (true) {
      const iteration = await waitForAbortable(iterator.next(), input.signal);
      throwIfAborted(input.signal);

      if (iteration.done === true) {
        break;
      }

      const chunk = iteration.value;
      assertProviderStreamChunk(chunk, "provider stream chunk");
      await appendAllAndEmit(events, accumulator.absorb(chunk), input.runtime);
    }
  } catch (error: unknown) {
    if (!isExecutionCancelledError(error)) {
      closeProviderIterator(iterator);
      throw error;
    }

    closeProviderIterator(iterator);
    const response = accumulator.finalize({
      finishReason: "error",
      partial: true,
    });

    if (!accumulator.messageDoneEmitted) {
      await appendAllAndEmit(
        events,
        accumulator.createTerminalEvents(response, { partial: true }),
        input.runtime
      );
    }

    return {
      cancelled: true,
      events,
      published: true,
      response,
    };
  }

  const response = accumulator.finalize();

  if (!accumulator.messageDoneEmitted) {
    await appendAllAndEmit(
      events,
      accumulator.createTerminalEvents(response),
      input.runtime
    );
  }

  return {
    events,
    published: true,
    response,
  };
}

export function createBufferedAssistantSequence(
  response: TuvrenModelResponse,
  now: () => EpochMs
): BufferedAssistantSequence {
  const messageId = randomUUID();

  return {
    events: [
      {
        messageId,
        role: "assistant",
        timestamp: now(),
        type: "message.start",
      },
      ...synthesizeAssistantEvents(response, messageId, now),
    ],
    published: false,
    response: cloneValue(response),
  };
}

export async function flushBufferedAssistantSequences(
  sequences: readonly BufferedAssistantSequence[],
  runtime: DriverRuntimePort
): Promise<void> {
  for (const sequence of sequences) {
    await publishBufferedAssistantSequence(sequence, runtime);
  }
}

export function inferAssistantFinishReason(
  message: Extract<TuvrenMessage, { role: "assistant" }>
): TuvrenModelResponse["finishReason"] {
  return message.parts.some((part) => part.type === "tool_call")
    ? "tool_call"
    : "stop";
}

function synthesizeAssistantEvents(
  response: TuvrenModelResponse,
  messageId: string,
  now: () => EpochMs
): TuvrenStreamEvent[] {
  const events: TuvrenStreamEvent[] = [];

  for (const part of response.parts) {
    switch (part.type) {
      case "text":
        events.push({
          delta: part.text,
          messageId,
          timestamp: now(),
          type: "text.delta",
        });
        events.push({
          messageId,
          text: part.text,
          timestamp: now(),
          type: "text.done",
        });
        break;
      case "reasoning":
        if (!part.redacted) {
          events.push({
            delta: part.text,
            messageId,
            timestamp: now(),
            type: "reasoning.delta",
          });
        }

        events.push({
          messageId,
          timestamp: now(),
          type: "reasoning.done",
        });
        break;
      case "structured":
        events.push({
          delta: serializeAssistantDeltaValue(part.data),
          messageId,
          timestamp: now(),
          type: "structured.delta",
        });
        events.push({
          data: cloneValue(part.data),
          messageId,
          name: part.name,
          timestamp: now(),
          type: "structured.done",
        });
        break;
      case "file":
        events.push({
          data:
            typeof part.data === "string"
              ? part.data
              : new Uint8Array(part.data),
          filename: part.filename,
          mediaType: part.mediaType,
          messageId,
          timestamp: now(),
          type: "file.done",
        });
        break;
      case "tool_call":
        events.push({
          callId: part.callId,
          messageId,
          name: part.name,
          timestamp: now(),
          type: "tool_call.start",
        });
        events.push({
          callId: part.callId,
          delta: JSON.stringify(part.input) ?? "null",
          timestamp: now(),
          type: "tool_call.args_delta",
        });
        events.push({
          callId: part.callId,
          input: cloneValue(part.input),
          name: part.name,
          providerMetadata: cloneValue(part.providerMetadata),
          timestamp: now(),
          type: "tool_call.done",
        });
        break;
      case "tool_result":
        throw new TuvrenRuntimeError(
          "provider responses must not emit tool_result parts",
          {
            code: "react_driver_invalid_model_response",
            details: {
              part,
            },
          }
        );
      default:
        break;
    }
  }

  events.push({
    finishReason: response.finishReason,
    messageId,
    timestamp: now(),
    type: "message.done",
    usage: response.usage,
  });

  return events;
}

async function publishBufferedAssistantSequence(
  sequence: BufferedAssistantSequence,
  runtime: DriverRuntimePort
): Promise<void> {
  if (sequence.published) {
    return;
  }

  for (const event of sequence.events) {
    await runtime.emit(event);
  }

  sequence.published = true;
}

async function appendAndEmit(
  events: TuvrenStreamEvent[],
  event: TuvrenStreamEvent,
  runtime: DriverRuntimePort
): Promise<void> {
  events.push(event);
  await runtime.emit(event);
}

async function appendAllAndEmit(
  events: TuvrenStreamEvent[],
  emittedEvents: readonly TuvrenStreamEvent[],
  runtime: DriverRuntimePort
): Promise<void> {
  for (const event of emittedEvents) {
    await appendAndEmit(events, event, runtime);
  }
}

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
  | { kind: "text"; text: string }
  | { done: boolean; kind: "reasoning"; text: string; signature?: string }
  | {
      data?: unknown;
      delta: string;
      done: boolean;
      kind: "structured";
      name?: string;
    }
  | { kind: "tool_call"; state: PendingToolCall };

class StreamAccumulator {
  private readonly parts: AccumulatedPart[] = [];
  private readonly toolCalls = new Map<string, PendingToolCall>();
  private finishChunk:
    | Extract<ProviderStreamChunk, { type: "finish" }>
    | undefined;
  private messageDonePublished = false;
  private readonly messageId: string;
  private readonly now: () => EpochMs;

  constructor(messageId: string, now: () => EpochMs) {
    this.messageId = messageId;
    this.now = now;
  }

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
        this.completeReasoning();
        return [
          {
            messageId: this.messageId,
            timestamp: this.now(),
            type: "reasoning.done",
          },
        ];
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
        return [this.startToolCall(chunk.providerCallId, chunk.name)];
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
      providerMetadata: cloneValue(this.finishChunk?.providerMetadata),
      usage: cloneValue(this.finishChunk?.usage),
    };
  }

  private assertCompletedProviderParts(): void {
    for (const part of this.parts) {
      switch (part.kind) {
        case "structured":
          if (!part.done) {
            throw new TuvrenProviderError(
              "provider stream finished before structured output completed",
              {
                code: "react_driver_invalid_provider_stream",
              }
            );
          }
          break;
        case "tool_call":
          if (!part.state.done) {
            throw new TuvrenProviderError(
              "provider stream finished before tool call completed",
              {
                code: "react_driver_invalid_provider_stream",
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

  get messageDoneEmitted(): boolean {
    return this.messageDonePublished;
  }

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

  private appendText(delta: string): void {
    const lastPart = this.parts.at(-1);

    if (lastPart?.kind === "text") {
      lastPart.text += delta;
      return;
    }

    this.parts.push({
      kind: "text",
      text: delta,
    });
  }

  private appendReasoning(delta: string, signature?: string): void {
    const lastPart = this.parts.at(-1);

    if (lastPart?.kind === "reasoning") {
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

  private completeReasoning(): void {
    const lastPart = this.parts.at(-1);

    if (lastPart?.kind === "reasoning") {
      lastPart.done = true;
    }
  }

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

  private appendToolCallArgs(providerCallId: string, delta: string): void {
    this.requireToolCall(providerCallId).argsDelta += delta;
  }

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

  private createPartialCompletionEvents(): TuvrenStreamEvent[] {
    const events: TuvrenStreamEvent[] = [];

    for (const part of this.parts) {
      switch (part.kind) {
        case "text":
          events.push({
            messageId: this.messageId,
            text: part.text,
            timestamp: this.now(),
            type: "text.done",
          });
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
            const data = parsePartialStructuredPart(part, true);

            if (data !== undefined) {
              events.push({
                data: cloneValue(data),
                messageId: this.messageId,
                name: part.name,
                timestamp: this.now(),
                type: "structured.done",
              });
              part.done = true;
            }
          }
          break;
        case "tool_call":
          if (!part.state.done) {
            const input = parsePartialToolCallInput(part.state, true);

            if (input !== undefined) {
              events.push({
                callId: part.state.callId,
                input: cloneValue(input),
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
          }
          break;
        default:
          break;
      }
    }

    return events;
  }

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

  private createCompletionEvents(): TuvrenStreamEvent[] {
    const events: TuvrenStreamEvent[] = [];

    for (const part of this.parts) {
      switch (part.kind) {
        case "text":
          events.push({
            messageId: this.messageId,
            text: part.text,
            timestamp: this.now(),
            type: "text.done",
          });
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

  private requireToolCall(providerCallId: string): PendingToolCall {
    const state = this.toolCalls.get(providerCallId);

    if (state !== undefined) {
      return state;
    }

    throw new TuvrenRuntimeError(
      "tool call chunks must start before args or done",
      {
        code: "react_driver_invalid_provider_stream",
        details: {
          providerCallId,
        },
      }
    );
  }
}

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
        code: "react_driver_invalid_model_response",
      });
  }
}

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
        code: "react_driver_invalid_provider_stream",
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

function buildToolCallProviderMetadata(
  providerCallId: string,
  providerMetadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  return {
    ...(providerMetadata === undefined ? {} : cloneValue(providerMetadata)),
    providerCallId,
  };
}

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

function closeProviderIterator(
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

function detachCleanup(promise: PromiseLike<unknown>): void {
  Promise.resolve(promise).catch(() => {
    // Cleanup errors must not mask the provider/cancellation outcome already in flight.
  });
}

function parseStructuredValue(value: string): unknown {
  if (value.length === 0) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error: unknown) {
    throw new TuvrenProviderError("provider returned invalid structured JSON", {
      cause: error,
      code: "react_driver_invalid_provider_stream",
      details: {
        value,
      },
    });
  }
}

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

function serializeAssistantDeltaValue(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

async function waitForAbortable<T>(
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw createExecutionCancelledError(signal);
  }
}

function createExecutionCancelledError(
  signal: AbortSignal | undefined
): TuvrenRuntimeError {
  return new TuvrenRuntimeError("execution cancelled", {
    code: "react_driver_execution_cancelled",
    details: normalizeUnknownError(signal?.reason),
  });
}

function isExecutionCancelledError(error: unknown): boolean {
  return (
    error instanceof TuvrenRuntimeError &&
    error.code === "react_driver_execution_cancelled"
  );
}

function toProviderError(error: unknown): TuvrenProviderError {
  if (error instanceof TuvrenProviderError) {
    return error;
  }

  return new TuvrenProviderError("provider stream failed", {
    cause: error,
    code: "react_driver_provider_failure",
    details: normalizeUnknownError(error),
  });
}

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
