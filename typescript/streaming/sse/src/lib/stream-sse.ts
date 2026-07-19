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

import type { TuvrenStreamEvent } from "@tuvren/core/events";
import {
  createStreamAdapterWarningReporter,
  type SequencedTuvrenStreamEvent,
  type StreamAdapterOptions,
  serializeTuvrenStreamEvent,
} from "@tuvren/stream-core";

const SSE_RESPONSE_HEADERS = {
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "content-type": "text/event-stream; charset=utf-8",
} as const;
const SSE_NEWLINE_PATTERN = /\r?\n/u;

/** One SSE frame ready for wire formatting; `data` is the JSON-serialized `TuvrenStreamEvent`. */
export interface TuvrenSseFrame {
  data: string;
  /** SSE `event:` field; set to the source event's `type`. */
  event?: string;
  id?: string;
  retry?: number;
}

/**
 * Maps a `TuvrenStreamEvent` stream to {@link TuvrenSseFrame}s, one frame per
 * event, with `event` set to the event's `type` and `data` its JSON
 * serialization (via `serializeTuvrenStreamEvent`, which encodes any
 * `Uint8Array` payload as a JSON marker object).
 *
 * A `file.done` event carrying binary (`Uint8Array`) `data` triggers a
 * `sse_binary_payload_json_encoded` warning through `options.onWarning`,
 * since SSE has no native binary framing and the payload is JSON-encoded
 * instead.
 *
 * The source iterator is claimed synchronously (before any `await`) so that,
 * when `events` is a `teeTuvrenStreamEvents` branch, this adapter satisfies
 * the tee's claim-before-first-pull rule immediately upon being called,
 * regardless of when its returned iterable is actually first iterated —
 * letting sibling branches still subscribe afterward.
 */
export function toSseFrames(
  events: AsyncIterable<TuvrenStreamEvent>,
  options?: StreamAdapterOptions
): AsyncIterable<TuvrenSseFrame> {
  // Claim tee-backed sources immediately so sibling adapter branches can still
  // subscribe before any one consumer starts pulling the shared source stream.
  return toSseFramesSubscribed(
    createIteratorIterable(events[Symbol.asyncIterator]()),
    options
  );
}

/**
 * Maps a sequenced stream (ADR-061, `createSequencedTuvrenStreamEvents` from
 * `@tuvren/stream-core`) to {@link TuvrenSseFrame}s exactly like
 * {@link toSseFrames}, additionally populating each frame's `id` with the
 * envelope's opaque resume cursor — so WHATWG `Last-Event-ID` reconnection
 * carries the cursor natively and a host can resume the stream through a
 * replay buffer.
 *
 * `toSseFrames` is unchanged: hosts that do not opt into resumability keep
 * emitting id-less frames.
 *
 * The source iterator is claimed synchronously for the same
 * claim-before-first-pull reason as {@link toSseFrames}.
 *
 * @experimental
 */
export function toResumableSseFrames(
  sequencedEvents: AsyncIterable<SequencedTuvrenStreamEvent>,
  options?: StreamAdapterOptions
): AsyncIterable<TuvrenSseFrame> {
  // Claim tee-backed sources immediately so sibling adapter branches can still
  // subscribe before any one consumer starts pulling the shared source stream.
  return toResumableSseFramesSubscribed(
    createIteratorIterable(sequencedEvents[Symbol.asyncIterator]()),
    options
  );
}

async function* toResumableSseFramesSubscribed(
  sequencedEvents: AsyncIterable<SequencedTuvrenStreamEvent>,
  options?: StreamAdapterOptions
): AsyncIterable<TuvrenSseFrame> {
  const reportWarning = createStreamAdapterWarningReporter(options);

  for await (const sequenced of sequencedEvents) {
    const event = sequenced.event;

    if (event.type === "file.done" && event.data instanceof Uint8Array) {
      reportWarning({
        code: "sse_binary_payload_json_encoded",
        message:
          "SSE file.done binary payloads were encoded into a JSON marker object.",
        details: {
          messageId: event.messageId,
        },
      });
    }

    yield {
      data: serializeTuvrenStreamEvent(event),
      event: event.type,
      id: sequenced.cursor,
    };
  }
}

async function* toSseFramesSubscribed(
  events: AsyncIterable<TuvrenStreamEvent>,
  options?: StreamAdapterOptions
): AsyncIterable<TuvrenSseFrame> {
  const reportWarning = createStreamAdapterWarningReporter(options);

  for await (const event of events) {
    if (event.type === "file.done" && event.data instanceof Uint8Array) {
      reportWarning({
        code: "sse_binary_payload_json_encoded",
        message:
          "SSE file.done binary payloads were encoded into a JSON marker object.",
        details: {
          messageId: event.messageId,
        },
      });
    }

    yield {
      data: serializeTuvrenStreamEvent(event),
      event: event.type,
    };
  }
}

/**
 * Wraps {@link toSseFrames} in a streaming `Response` with EventSource-compatible
 * headers (`content-type: text/event-stream; charset=utf-8`,
 * `cache-control: no-cache, no-transform`, `connection: keep-alive`).
 *
 * Frames are pulled and encoded to bytes lazily, one per `ReadableStream`
 * `pull()`; consumer cancellation (`body.cancel()`) calls the underlying
 * frame iterator's `return()` so upstream resources (including a tee branch)
 * are released promptly. A pull-time error is surfaced via
 * `controller.error()` rather than throwing synchronously.
 *
 * @param options - Combines {@link StreamAdapterOptions} (forwarded to
 *   {@link toSseFrames}) with a standard `ResponseInit`; caller-supplied
 *   headers are merged in but `content-type` is always forced back to the
 *   SSE value (see {@link mergeSseHeaders}).
 */
export function toSseResponse(
  events: AsyncIterable<TuvrenStreamEvent>,
  options?: StreamAdapterOptions & ResponseInit
): Response {
  const iterator = toSseFrames(events, options)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async cancel() {
      await iterator.return?.();
    },
    async pull(controller) {
      try {
        const nextFrame = await iterator.next();

        if (nextFrame.done) {
          controller.close();
          return;
        }

        controller.enqueue(encoder.encode(formatSseFrame(nextFrame.value)));
      } catch (error: unknown) {
        controller.error(error);
      }
    },
  });
  const responseInit = options ?? {};

  return new Response(body, {
    ...responseInit,
    headers: mergeSseHeaders(responseInit.headers),
  });
}

/**
 * Formats a {@link TuvrenSseFrame} as wire-ready SSE text: one `field: value`
 * line per set optional field, `data:` split across one line per line of
 * payload (matching the WHATWG multi-line `data` convention), terminated by
 * the blank line that dispatches the event.
 */
function formatSseFrame(frame: TuvrenSseFrame): string {
  const lines: string[] = [];

  if (frame.event !== undefined) {
    lines.push(`event: ${sanitizeSseField(frame.event)}`);
  }

  if (frame.id !== undefined) {
    lines.push(`id: ${sanitizeSseField(frame.id)}`);
  }

  if (frame.retry !== undefined) {
    lines.push(`retry: ${frame.retry}`);
  }

  // String.prototype.split never yields an empty array (an empty payload
  // splits to [""]), so every frame emits at least one `data:` line.
  for (const payloadLine of frame.data.split(SSE_NEWLINE_PATTERN)) {
    lines.push(`data: ${payloadLine}`);
  }

  return `${lines.join("\n")}\n\n`;
}

/**
 * Merges caller-supplied headers onto the canonical SSE header set, then
 * re-forces `content-type` to the SSE value — callers may tune cache or
 * transfer headers, but this helper must always remain EventSource-compatible.
 */
function mergeSseHeaders(headersInit: HeadersInit | undefined): Headers {
  const headers = new Headers(SSE_RESPONSE_HEADERS);

  if (headersInit === undefined) {
    return headers;
  }

  const incomingHeaders = new Headers(headersInit);

  for (const [key, value] of incomingHeaders.entries()) {
    headers.set(key, value);
  }

  // Callers may tune cache or transfer headers, but this helper must always
  // remain EventSource-compatible.
  headers.set("content-type", SSE_RESPONSE_HEADERS["content-type"]);
  return headers;
}

/** Replaces embedded line breaks in an `event`/`id` field value with spaces, since SSE fields are single-line. */
function sanitizeSseField(value: string): string {
  return value.replaceAll(/\r?\n/gu, " ");
}

/** Wraps an already-obtained iterator as a single-use `AsyncIterable` that always returns the same iterator. */
function createIteratorIterable<T>(
  iterator: AsyncIterator<T>
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return iterator;
    },
  };
}
