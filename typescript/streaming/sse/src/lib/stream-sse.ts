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
  type StreamAdapterOptions,
  serializeTuvrenStreamEvent,
} from "@tuvren/stream-core";

const SSE_RESPONSE_HEADERS = {
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "content-type": "text/event-stream; charset=utf-8",
} as const;
const SSE_NEWLINE_PATTERN = /\r?\n/u;

export interface TuvrenSseFrame {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

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

  const payloadLines = frame.data.split(SSE_NEWLINE_PATTERN);

  if (payloadLines.length === 0) {
    lines.push("data:");
  } else {
    for (const payloadLine of payloadLines) {
      lines.push(`data: ${payloadLine}`);
    }
  }

  return `${lines.join("\n")}\n\n`;
}

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

function sanitizeSseField(value: string): string {
  return value.replaceAll(/\r?\n/gu, " ");
}

function createIteratorIterable<T>(
  iterator: AsyncIterator<T>
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return iterator;
    },
  };
}
