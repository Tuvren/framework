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
import { TuvrenProviderError, TuvrenRuntimeError } from "@tuvren/core-types";
import type { DriverRuntimePort } from "@tuvren/driver-api";
import type { TuvrenMessage, TuvrenStreamEvent } from "@tuvren/runtime-api";
import type {
  ProviderStreamChunk,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/provider-api";

export async function executeGenerateCall(input: {
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
  runtime: DriverRuntimePort;
}): Promise<TuvrenModelResponse> {
  const response = await input.provider.generate(cloneValue(input.prompt));
  await emitAssistantResponseEvents(response, input.runtime);
  return cloneValue(response);
}

export async function executeStreamCall(input: {
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
  runtime: DriverRuntimePort;
}): Promise<TuvrenModelResponse> {
  const runtime = input.runtime;
  const messageId = randomUUID();
  const accumulator = new StreamAccumulator(messageId);

  await runtime.emit({
    messageId,
    role: "assistant",
    timestamp: runtime.now(),
    type: "message.start",
  });

  for await (const chunk of input.provider.stream(cloneValue(input.prompt))) {
    const events = accumulator.absorb(chunk);

    for (const event of events) {
      await runtime.emit({
        ...event,
        timestamp: runtime.now(),
      });
    }
  }

  const response = accumulator.finalize();

  if (!accumulator.messageDoneEmitted) {
    await runtime.emit({
      finishReason: response.finishReason,
      messageId,
      timestamp: runtime.now(),
      type: "message.done",
      usage: response.usage,
    });
  }

  return response;
}

export async function emitAssistantResponseEvents(
  response: TuvrenModelResponse,
  runtime: DriverRuntimePort
): Promise<void> {
  const messageId = randomUUID();

  await runtime.emit({
    messageId,
    role: "assistant",
    timestamp: runtime.now(),
    type: "message.start",
  });

  for (const event of synthesizeAssistantEvents(response, messageId, runtime)) {
    await runtime.emit(event);
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
  runtime: DriverRuntimePort
): TuvrenStreamEvent[] {
  const events: TuvrenStreamEvent[] = [];

  for (const part of response.parts) {
    switch (part.type) {
      case "text":
        events.push({
          delta: part.text,
          messageId,
          timestamp: runtime.now(),
          type: "text.delta",
        });
        events.push({
          messageId,
          text: part.text,
          timestamp: runtime.now(),
          type: "text.done",
        });
        break;
      case "reasoning":
        if (!part.redacted) {
          events.push({
            delta: part.text,
            messageId,
            timestamp: runtime.now(),
            type: "reasoning.delta",
          });
        }

        events.push({
          messageId,
          timestamp: runtime.now(),
          type: "reasoning.done",
        });
        break;
      case "structured":
        events.push({
          delta: JSON.stringify(part.data) ?? "null",
          messageId,
          timestamp: runtime.now(),
          type: "structured.delta",
        });
        events.push({
          data: cloneValue(part.data),
          messageId,
          name: part.name,
          timestamp: runtime.now(),
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
          timestamp: runtime.now(),
          type: "file.done",
        });
        break;
      case "tool_call":
        events.push({
          callId: part.callId,
          messageId,
          name: part.name,
          timestamp: runtime.now(),
          type: "tool_call.start",
        });
        events.push({
          callId: part.callId,
          delta: JSON.stringify(part.input) ?? "null",
          timestamp: runtime.now(),
          type: "tool_call.args_delta",
        });
        events.push({
          callId: part.callId,
          input: cloneValue(part.input),
          name: part.name,
          timestamp: runtime.now(),
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
    timestamp: runtime.now(),
    type: "message.done",
    usage: response.usage,
  });

  return events;
}

interface PendingToolCall {
  argsDelta: string;
  callId: string;
  input?: unknown;
  name: string;
  providerCallId: string;
}

type AccumulatedPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; signature?: string }
  | { kind: "structured"; data?: unknown; delta: string; name?: string }
  | { kind: "tool_call"; state: PendingToolCall };

class StreamAccumulator {
  private readonly parts: AccumulatedPart[] = [];
  private readonly toolCalls = new Map<string, PendingToolCall>();
  private finishChunk:
    | Extract<ProviderStreamChunk, { type: "finish" }>
    | undefined;
  private messageDonePublished = false;

  constructor(private readonly messageId: string) {}

  absorb(chunk: ProviderStreamChunk): TuvrenStreamEvent[] {
    switch (chunk.type) {
      case "text_delta":
        this.appendText(chunk.text);
        return [
          {
            delta: chunk.text,
            messageId: this.messageId,
            timestamp: 0,
            type: "text.delta",
          },
        ];
      case "reasoning_delta":
        this.appendReasoning(chunk.text, chunk.signature);
        return [
          {
            delta: chunk.text,
            messageId: this.messageId,
            timestamp: 0,
            type: "reasoning.delta",
          },
        ];
      case "reasoning_done":
        return [
          {
            messageId: this.messageId,
            timestamp: 0,
            type: "reasoning.done",
          },
        ];
      case "structured_delta":
        this.appendStructuredDelta(chunk.delta);
        return [
          {
            delta: chunk.delta,
            messageId: this.messageId,
            timestamp: 0,
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
            timestamp: 0,
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
            timestamp: 0,
            type: "tool_call.args_delta",
          },
        ];
      case "tool_call_done":
        this.completeToolCall(chunk.providerCallId, chunk.input, chunk.name);
        return [
          {
            callId: this.requireToolCall(chunk.providerCallId).callId,
            input: cloneValue(chunk.input),
            name: chunk.name,
            timestamp: 0,
            type: "tool_call.done",
          },
        ];
      case "finish":
        this.finishChunk = cloneValue(chunk);
        this.messageDonePublished = true;
        return [
          ...this.createCompletionEvents(),
          {
            finishReason: chunk.finishReason,
            messageId: this.messageId,
            timestamp: 0,
            type: "message.done",
            usage: cloneValue(chunk.usage),
          },
        ];
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
        (parts.some((part) => part.type === "tool_call") ? "tool_call" : "stop"),
      parts,
      providerMetadata: cloneValue(this.finishChunk?.providerMetadata),
      usage: cloneValue(this.finishChunk?.usage),
    };
  }

  get messageDoneEmitted(): boolean {
    return this.messageDonePublished;
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
      kind: "reasoning",
      signature,
      text: delta,
    });
  }

  private createCompletionEvents(): TuvrenStreamEvent[] {
    const events: TuvrenStreamEvent[] = [];

    for (const part of this.parts) {
      switch (part.kind) {
        case "text":
          events.push({
            messageId: this.messageId,
            text: part.text,
            timestamp: 0,
            type: "text.done",
          });
          break;
        default:
          break;
      }
    }

    return events;
  }

  private appendStructuredDelta(delta: string): void {
    const lastPart = this.parts.at(-1);

    if (lastPart?.kind === "structured") {
      lastPart.delta += delta;
      return;
    }

    this.parts.push({
      delta,
      kind: "structured",
    });
  }

  private completeStructured(data: unknown, name?: string): void {
    const lastPart = this.parts.at(-1);

    if (lastPart?.kind === "structured") {
      lastPart.data = cloneValue(data);
      lastPart.name = name;
      return;
    }

    this.parts.push({
      data: cloneValue(data),
      delta: "",
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
      timestamp: 0,
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
    state.input = cloneValue(input);
    state.name = name;
  }

  private requireToolCall(providerCallId: string): PendingToolCall {
    const state = this.toolCalls.get(providerCallId);

    if (state !== undefined) {
      return state;
    }

    throw new TuvrenRuntimeError("tool call chunks must start before args or done", {
      code: "react_driver_invalid_provider_stream",
      details: {
        providerCallId,
      },
    });
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
