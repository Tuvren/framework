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
import { TuvrenRuntimeError } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { RunnerRuntimePort } from "@tuvren/core/runner";
import type {
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/provider-api";
import {
  assertProviderStreamChunk,
  assertTuvrenModelResponse,
} from "@tuvren/provider-api";
import {
  closeProviderIterator,
  isExecutionCancelledError,
  StreamAccumulator,
  serializeAssistantDeltaValue,
  throwIfAborted,
  waitForAbortable,
} from "./react-runner-stream-support.js";

/**
 * One complete assistant message-start-through-message-done event sequence
 * produced by a single provider call, paired with the durable response it
 * reconciles to.
 *
 * `published` tracks whether {@link flushBufferedAssistantSequences} has
 * already emitted `events` on `context.runtime`; a sequence created by
 * {@link createBufferedAssistantSequence} for a short-circuited or replaced
 * response starts unpublished, while one produced by
 * {@link executeStreamCall} is published immediately as it streams and is
 * recorded here only for later reconciliation bookkeeping.
 */
export interface BufferedAssistantSequence {
  /** True when the provider call this sequence represents was cancelled. */
  cancelled?: boolean;
  /** The assistant stream events for this sequence, in emission order. */
  events: TuvrenStreamEvent[];
  /** True once `events` have been emitted on the runtime (or were emitted live). */
  published: boolean;
  /** The durable response this sequence reconciles to. */
  response: TuvrenModelResponse;
}

/**
 * Clone the prompt for the provider call and attach the cooperative
 * cancellation signal out-of-band (ADR-043, KRT-BD006). The signal is attached
 * after `cloneValue` because an `AbortSignal` is not structured-cloneable;
 * owned bridges forward it to the underlying provider request for full resource
 * containment when the framework stops awaiting at a bound.
 */
function cloneProviderPrompt(
  prompt: TuvrenPrompt,
  signal: AbortSignal | undefined
): TuvrenPrompt {
  const cloned = cloneValue(prompt);
  if (signal !== undefined) {
    cloned.signal = signal;
  }
  return cloned;
}

/**
 * Non-streaming provider call path (framework spec §6.3): calls
 * `provider.generate` and wraps the complete response into a
 * {@link BufferedAssistantSequence} whose synthesized events are not yet
 * published (published by the caller once the iteration result is finalized).
 *
 * @throws A cancellation error (see {@link throwIfAborted}) if `signal` is
 *   already aborted before or after the call, or aborts during it.
 */
export async function executeGenerateCall(input: {
  now: () => EpochMs;
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
  signal?: AbortSignal;
}): Promise<BufferedAssistantSequence> {
  throwIfAborted(input.signal);
  const response = await waitForAbortable(
    input.provider.generate(cloneProviderPrompt(input.prompt, input.signal)),
    input.signal
  );
  throwIfAborted(input.signal);
  assertTuvrenModelResponse(response, "provider generate response");
  return createBufferedAssistantSequence(cloneValue(response), input.now);
}

/**
 * Streaming provider call path (framework spec §6.2): calls `provider.stream`
 * and emits each translated event on `input.runtime` live, as chunks arrive,
 * while a {@link StreamAccumulator} absorbs the same chunks into a complete
 * `TuvrenModelResponse` for the durable path.
 *
 * On cooperative cancellation mid-stream (ADR-043, KRT-BD006), the provider
 * iterator is closed, the accumulator is finalized with `finishReason:
 * "error"` and `partial: true`, and any still-missing terminal events are
 * emitted before returning a `cancelled: true` sequence with whatever
 * content had accumulated. Any other stream error propagates after closing
 * the iterator.
 *
 * @returns A sequence whose `published` is always `true` — its events were
 *   already emitted live during the call, unlike
 *   {@link createBufferedAssistantSequence}'s synthesized sequences.
 * @throws Any error the provider stream raises, other than cooperative
 *   cancellation (which is handled and returned instead of thrown).
 */
export async function executeStreamCall(input: {
  now: () => EpochMs;
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
  runtime: RunnerRuntimePort;
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
    .stream(cloneProviderPrompt(input.prompt, input.signal))
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

/**
 * Synthesizes a complete `message.start` → content-done → `message.done`
 * event sequence from an already-complete response, for the non-streaming
 * fallback and `aroundModel` short-circuit/replacement paths (framework spec
 * §6.3/§6.5). The sequence is returned unpublished; the caller flushes it
 * via {@link flushBufferedAssistantSequences} once ready.
 */
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

/**
 * Publishes every not-yet-published sequence's events on `runtime`, in
 * order, and marks each as published. Already-published sequences (from a
 * live `executeStreamCall`) are skipped, so this is safe to call with a mix
 * of live and synthesized sequences without double-emitting.
 */
export async function flushBufferedAssistantSequences(
  sequences: readonly BufferedAssistantSequence[],
  runtime: RunnerRuntimePort
): Promise<void> {
  for (const sequence of sequences) {
    await publishBufferedAssistantSequence(sequence, runtime);
  }
}

/**
 * Infers a `finishReason` from an assistant message's parts alone:
 * `"tool_call"` when it requests any tool call, otherwise `"stop"`.
 */
export function inferAssistantFinishReason(
  message: Extract<TuvrenMessage, { role: "assistant" }>
): TuvrenModelResponse["finishReason"] {
  return message.parts.some((part) => part.type === "tool_call")
    ? "tool_call"
    : "stop";
}

/**
 * Synthesizes one delta+done event pair per content part of a complete
 * response (framework spec §6.3), followed by a trailing `message.done`.
 * `tool_call` parts additionally get a synthesized `tool_call.start` before
 * their delta+done pair, matching the shape a live stream would have
 * produced.
 *
 * @throws TuvrenRuntimeError with code `react_runner_invalid_model_response`
 *   if `response.parts` contains a `tool_result` part — provider responses
 *   must never contain one.
 */
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
            code: "react_runner_invalid_model_response",
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

/** Emits one sequence's events on `runtime` if not already published; a no-op otherwise. */
async function publishBufferedAssistantSequence(
  sequence: BufferedAssistantSequence,
  runtime: RunnerRuntimePort
): Promise<void> {
  if (sequence.published) {
    return;
  }

  for (const event of sequence.events) {
    await runtime.emit(event);
  }

  sequence.published = true;
}

/** Records `event` in the live sequence buffer and emits it on `runtime` immediately. */
async function appendAndEmit(
  events: TuvrenStreamEvent[],
  event: TuvrenStreamEvent,
  runtime: RunnerRuntimePort
): Promise<void> {
  events.push(event);
  await runtime.emit(event);
}

/** Applies {@link appendAndEmit} to each event in order. */
async function appendAllAndEmit(
  events: TuvrenStreamEvent[],
  emittedEvents: readonly TuvrenStreamEvent[],
  runtime: RunnerRuntimePort
): Promise<void> {
  for (const event of emittedEvents) {
    await appendAndEmit(events, event, runtime);
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
