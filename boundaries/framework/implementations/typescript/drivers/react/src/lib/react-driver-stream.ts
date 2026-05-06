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
import { TuvrenRuntimeError } from "@tuvren/core-types";
import type { DriverRuntimePort } from "@tuvren/driver-api";
import type {
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/provider-api";
import {
  assertProviderStreamChunk,
  assertTuvrenModelResponse,
} from "@tuvren/provider-api";
import type { TuvrenMessage, TuvrenStreamEvent } from "@tuvren/runtime-api";
import {
  closeProviderIterator,
  isExecutionCancelledError,
  StreamAccumulator,
  serializeAssistantDeltaValue,
  throwIfAborted,
  waitForAbortable,
} from "./react-driver-stream-support.js";

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

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
