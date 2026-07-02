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

import {
  decodeSseStream,
  reportSseWireCompliance,
  toSseResponse,
} from "@tuvren/stream-sse";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";

export function createFrameworkAdapterEventStreamSse(): {
  runDecodeTrace(input: unknown): Promise<AdapterProjection>;
  runReportWireCompliance(input: unknown): Promise<AdapterProjection>;
} {
  async function runDecodeTrace(input: unknown): Promise<AdapterProjection> {
    // The shared runner resolves the plan's `fixturePath` against the SSE
    // trace fixture and passes the resolved value on `input.fixture`. For
    // every check in `event-stream-sse.json`, that value is the
    // `encodedBytes` string for one WHATWG-normative trace, so the adapter's
    // only responsibility is to feed the bytes through the language-local
    // WHATWG decoder and surface the result under `result.sse.decoded` —
    // the shape the SSE plan's `resultField` and `schemaValid` assertions
    // walk.
    await Promise.resolve();
    const encodedBytes = readEncodedBytes(input);
    const decoded = decodeSseStream(encodedBytes);

    return {
      result: {
        sse: {
          decoded,
        },
      },
    };
  }

  async function runReportWireCompliance(
    _input: unknown
  ): Promise<AdapterProjection> {
    // The wire-compliance booleans are derived from real observations: a
    // one-shot probe of `toSseResponse` for the response-header surface,
    // plus targeted decoder probes for each WHATWG line-terminator,
    // BOM-stripping, leading-space, dispatch, and comment-handling rule.
    // A regression in `@tuvren/stream-sse` (encoder headers, decoder
    // behavior) flips the appropriate boolean to false and the plan's
    // independent assertions surface it.
    const wire = await reportSseWireCompliance(observeSseEncoder);

    return {
      result: {
        sse: {
          wire,
        },
      },
    };
  }

  return { runDecodeTrace, runReportWireCompliance };
}

async function observeSseEncoder(): Promise<{
  body: Uint8Array;
  contentType: string;
}> {
  // Drive `toSseResponse` with a one-event probe stream and read both the
  // surfaced `Content-Type` header and the encoded body bytes. This is the
  // observation surface the wire-compliance report consumes — it confirms
  // the encoder emits `text/event-stream` and that the body is valid UTF-8
  // without coupling either claim to a hardcoded `true` literal.
  // biome-ignore lint/suspicious/useAwait: encoder probe stream is a sync generator wrapped to satisfy AsyncIterable; toSseResponse consumes it asynchronously
  const events = (async function* () {
    yield {
      data: { value: "wire-compliance-probe" },
      messageId: "probe-1",
      threadId: "thread-probe",
      timestamp: 0,
      turnId: "turn-probe",
      type: "turn.start",
    };
  })();
  const response = toSseResponse(
    events as unknown as AsyncIterable<never> & AsyncIterator<never>
  );
  const body = new Uint8Array(await response.arrayBuffer());

  return {
    body,
    contentType: response.headers.get("content-type") ?? "",
  };
}

function readEncodedBytes(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    "fixture" in input &&
    typeof (input as { fixture: unknown }).fixture === "string"
  ) {
    return (input as { fixture: string }).fixture;
  }

  throw new Error(
    "event-stream-sse.decode-trace expects the runner to supply the resolved encodedBytes string under input.fixture"
  );
}
