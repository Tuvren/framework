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

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  decodeSseStream,
  reportSseWireCompliance,
  toSseResponse,
} from "../src/index.ts";

interface SseTraceFixture {
  traces: Record<
    string,
    {
      encodedBytes: string;
      expectedDecodedStream: {
        events: Record<string, unknown>[];
        lastEventId?: string;
        reconnectDelayMs?: number;
      };
    }
  >;
  wireCompliance: Record<string, boolean>;
}

const FIXTURE_PATH =
  "../../../../spec/conformance/streaming/fixtures/event-stream-sse-traces.json";
const fixture = JSON.parse(
  await readFile(new URL(FIXTURE_PATH, import.meta.url), "utf8")
) as SseTraceFixture;

describe("sse-decoder", () => {
  for (const [traceName, trace] of Object.entries(fixture.traces)) {
    test(`decodes ${traceName} per WHATWG`, () => {
      const decoded = decodeSseStream(trace.encodedBytes);

      expect(decoded.events).toEqual(
        trace.expectedDecodedStream.events as {
          data: string;
          id?: string;
          retryMs?: number;
          type: string;
        }[]
      );

      if (trace.expectedDecodedStream.lastEventId !== undefined) {
        expect(decoded.lastEventId).toBe(
          trace.expectedDecodedStream.lastEventId
        );
      }

      if (trace.expectedDecodedStream.reconnectDelayMs !== undefined) {
        expect(decoded.reconnectDelayMs).toBe(
          trace.expectedDecodedStream.reconnectDelayMs
        );
      }
    });
  }

  test("reports wire compliance booleans matching the fixture", async () => {
    const report = await reportSseWireCompliance(observeEncoderForTest);
    expect(report as unknown as Record<string, boolean>).toEqual(
      fixture.wireCompliance
    );
  });
});

async function observeEncoderForTest(): Promise<{
  body: Uint8Array;
  contentType: string;
}> {
  // biome-ignore lint/suspicious/useAwait: encoder probe stream is a sync generator wrapped to satisfy AsyncIterable; toSseResponse consumes it asynchronously
  const events = (async function* () {
    yield {
      data: { value: "probe" },
      messageId: "probe-msg",
      threadId: "probe-thread",
      timestamp: 0,
      turnId: "probe-turn",
      type: "turn.start",
    };
  })();
  const response = toSseResponse(
    events as unknown as AsyncIterable<never> & AsyncIterator<never>
  );
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "",
  };
}
