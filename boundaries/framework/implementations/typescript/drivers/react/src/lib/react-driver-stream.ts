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
import { assertProviderStreamChunk } from "@tuvren/provider-api";
import type { TuvrenMessage, TuvrenStreamEvent } from "@tuvren/runtime-api";

export interface BufferedAssistantSequence {
  events: TuvrenStreamEvent[];
  published: boolean;
  response: TuvrenModelResponse;
}

export async function executeGenerateCall(input: {
  now: () => EpochMs;
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
}): Promise<BufferedAssistantSequence> {
  const response = cloneValue(
    await input.provider.generate(cloneValue(input.prompt))
  );
  return createBufferedAssistantSequence(response, input.now);
}

export async function executeStreamCall(input: {
  now: () => EpochMs;
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
  runtime: DriverRuntimePort;
}): Promise<BufferedAssistantSequence> {
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

  for await (const chunk of input.provider.stream(cloneValue(input.prompt))) {
    const validatedChunk = cloneValue(chunk);
    assertProviderStreamChunk(validatedChunk, "provider stream chunk");
    await appendAllAndEmit(
      events,
      accumulator.absorb(validatedChunk),
      input.runtime
    );
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
          delta: JSON.stringify(part.data) ?? "null",
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
    await runtime.emit(cloneValue(event));
  }

  sequence.published = true;
}

async function appendAndEmit(
  events: TuvrenStreamEvent[],
  event: TuvrenStreamEvent,
  runtime: DriverRuntimePort
): Promise<void> {
  events.push(event);
  await runtime.emit(cloneValue(event));
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
        return [
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
        this.completeStructured(chunk.data, chunk.name);
        return [
          {
            data: cloneValue(chunk.data),
            messageId: this.messageId,
            name: chunk.name,
            timestamp: this.now(),
            type: "structured.done",
          },
        ];
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
          chunk.name
        );
      case "finish":
        this.finishChunk = cloneValue(chunk);
        this.messageDonePublished = true;
        return this.createTerminalEventsFromFinish(chunk);
      case "error":
        throw toProviderError(chunk.error);
      default:
        return [];
    }
  }

  finalize(): TuvrenModelResponse {
    const parts = this.parts.map((part) => {
      switch (part.kind) {
        case "text":
          return {
            text: part.text,
            type: "text",
          } satisfies TuvrenModelResponse["parts"][number];
        case "reasoning":
          return {
            providerMetadata:
              part.signature === undefined
                ? undefined
                : {
                    signature: part.signature,
                  },
            redacted: false,
            text: part.text,
            type: "reasoning",
          } satisfies TuvrenModelResponse["parts"][number];
        case "structured":
          return {
            data: part.data ?? parseStructuredValue(part.delta),
            name: part.name,
            type: "structured",
          } satisfies TuvrenModelResponse["parts"][number];
        case "tool_call":
          return {
            callId: part.state.callId,
            input:
              part.state.input ?? parseStructuredValue(part.state.argsDelta),
            name: part.state.name,
            providerMetadata: {
              providerCallId: part.state.providerCallId,
            },
            type: "tool_call",
          } satisfies TuvrenModelResponse["parts"][number];
        default:
          throw new TuvrenRuntimeError("unsupported accumulated content part", {
            code: "react_driver_invalid_model_response",
          });
      }
    });

    return {
      finishReason:
        this.finishChunk?.finishReason ??
        (parts.some((part) => part.type === "tool_call")
          ? "tool_call"
          : "stop"),
      parts,
      providerMetadata: cloneValue(this.finishChunk?.providerMetadata),
      usage: cloneValue(this.finishChunk?.usage),
    };
  }

  get messageDoneEmitted(): boolean {
    return this.messageDonePublished;
  }

  createTerminalEvents(response: TuvrenModelResponse): TuvrenStreamEvent[] {
    return [
      ...this.createCompletionEvents(),
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

  private completeStructured(data: unknown, name?: string): void {
    const lastPart = this.parts.at(-1);

    if (lastPart?.kind === "structured") {
      lastPart.data = cloneValue(data);
      lastPart.done = true;
      lastPart.name = name;
      return;
    }

    this.parts.push({
      data: cloneValue(data),
      delta: "",
      done: true,
      kind: "structured",
      name,
    });
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
    name: string
  ): void {
    const state = this.requireToolCall(providerCallId);
    state.done = true;
    state.input = cloneValue(input);
    state.name = name;
  }

  private completeToolCallAndCreateEvents(
    providerCallId: string,
    input: unknown,
    name: string
  ): TuvrenStreamEvent[] {
    this.completeToolCall(providerCallId, input, name);
    const state = this.requireToolCall(providerCallId);
    const events: TuvrenStreamEvent[] = [];

    if (state.argsDelta === "") {
      const synthesizedArgsDelta = JSON.stringify(input) ?? "null";
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
      timestamp: this.now(),
      type: "tool_call.done",
    });

    return events;
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

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
