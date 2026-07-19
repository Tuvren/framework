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
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import { readFrameworkStreamFixtures } from "@tuvren/framework-testkit";
import {
  createFixtureStream,
  createReplayBuffer,
  createSequencedTuvrenStreamEvents,
  decodeResumeCursor,
  streamAdapterFixtures,
  teeTuvrenStreamEvents,
} from "@tuvren/stream-core";
import {
  decodeSseStream,
  type TuvrenSseFrame,
  toResumableSseFrames,
  toSseFrames,
  toSseResponse,
} from "../src/index.ts";

const frameworkStreamFixtures = await readFrameworkStreamFixtures();

describe("stream-sse", () => {
  test("projects canonical events into EventSource-compatible frames", async () => {
    const frames = await collectStreamValues(
      toSseFrames(createFixtureStream(frameworkStreamFixtures.completedTurn))
    );

    expect(frames[0]).toEqual({
      data: '{"threadId":"thread-main","timestamp":1,"turnId":"turn-main","type":"turn.start"}',
      event: "turn.start",
    });

    const toolResultFrame = frames.find((frame) =>
      frame.data.includes('"type":"tool.result"')
    );

    expect(toolResultFrame?.event).toBe("tool.result");
    expect(toolResultFrame?.data).toContain('"hits":2');
  });

  test("creates streaming SSE responses with default headers and caller overrides", async () => {
    const response = toSseResponse(
      createFixtureStream(frameworkStreamFixtures.completedTurn),
      {
        headers: {
          "cache-control": "private, no-store",
          "content-type": "text/plain",
        },
      }
    );

    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("connection")).toBe("keep-alive");

    const payload = await response.text();

    expect(payload).toContain("event: turn.start");
    expect(payload).toContain('data: {"threadId":"thread-main"');
    expect(payload).toContain("event: turn.end");
  });

  test("warns when binary file payloads need JSON-safe encoding", async () => {
    const warnings: string[] = [];
    const binaryFileEvents: readonly TuvrenStreamEvent[] = [
      {
        data: new Uint8Array([7, 8]),
        mediaType: "application/octet-stream",
        messageId: "message-binary",
        timestamp: 99,
        type: "file.done",
      },
    ];
    const frames = await collectStreamValues(
      toSseFrames(createFixtureStream(binaryFileEvents), {
        onWarning(warning) {
          warnings.push(warning.code);
        },
      })
    );

    expect(warnings).toEqual(["sse_binary_payload_json_encoded"]);
    expect(JSON.parse(frames[0]?.data ?? "")).toEqual({
      data: {
        data: [7, 8],
        type: "Uint8Array",
      },
      mediaType: "application/octet-stream",
      messageId: "message-binary",
      timestamp: 99,
      type: "file.done",
    });
  });

  test("subscribes eagerly so delayed SSE consumption still receives turn.start", async () => {
    const [sseBranch, directBranch] = teeTuvrenStreamEvents(
      createFixtureStream(frameworkStreamFixtures.completedTurn),
      2
    );
    const sseFrames = toSseFrames(sseBranch);
    const directIterator = directBranch[Symbol.asyncIterator]();

    expect(await directIterator.next()).toMatchObject({
      done: false,
      value: frameworkStreamFixtures.completedTurn[0],
    });
    await waitForAsyncTurn();
    await directIterator.return?.();

    const frames = await collectStreamValues(sseFrames);

    expect(frames[0]).toMatchObject({
      event: "turn.start",
    });
  });
});

async function collectStreamValues<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const value of values) {
    collected.push(value);
  }

  return collected;
}

async function waitForAsyncTurn(): Promise<void> {
  await Promise.resolve();
}

describe("toResumableSseFrames", () => {
  test("populates every frame id with the envelope's resume cursor", async () => {
    const sequenced = createSequencedTuvrenStreamEvents(
      createFixtureStream(streamAdapterFixtures.completedTurn)
    );
    const frames: TuvrenSseFrame[] = [];

    for await (const frame of toResumableSseFrames(sequenced)) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(streamAdapterFixtures.completedTurn.length);

    for (const [index, frame] of frames.entries()) {
      expect(frame.id).toBeDefined();
      const payload = decodeResumeCursor(frame.id as string);
      expect(payload?.turnId).toBe("turn-main");
      expect(payload?.sequence).toBe(index);
      expect(frame.event).toBe(
        streamAdapterFixtures.completedTurn[index]?.type as string
      );
    }
  });

  test("a decoded Last-Event-ID resumes the stream through a replay buffer", async () => {
    const sequenced = createSequencedTuvrenStreamEvents(
      createFixtureStream(streamAdapterFixtures.completedTurn)
    );
    const buffer = createReplayBuffer({ capacity: 32 });
    const wireFrames: string[] = [];

    // Server side: record each sequenced frame while emitting SSE wire text.
    const recording = (async function* () {
      for await (const frame of sequenced) {
        buffer.record(frame);
        yield frame;
      }
    })();

    for await (const frame of toResumableSseFrames(recording)) {
      wireFrames.push(
        `event: ${frame.event}\nid: ${frame.id}\ndata: ${frame.data}\n\n`
      );
    }

    // Client side: decode a truncated trace (disconnect mid-turn), then
    // present the WHATWG lastEventId back as the resume cursor.
    const truncated = wireFrames.slice(0, 5).join("");
    const decoded = decodeSseStream(truncated);

    expect(decoded.lastEventId).toBeDefined();

    const result = buffer.replayFrom(decoded.lastEventId as string);

    expect(result.status).toBe("resumed");

    if (result.status === "resumed") {
      expect(result.events.map((frame) => frame.sequence)).toEqual(
        Array.from(
          { length: streamAdapterFixtures.completedTurn.length - 5 },
          (_unused, index) => index + 5
        )
      );
    }
  });

  test("keeps toSseFrames id-less for hosts that do not opt in", async () => {
    const frames: TuvrenSseFrame[] = [];

    for await (const frame of toSseFrames(
      createFixtureStream(streamAdapterFixtures.completedTurn)
    )) {
      frames.push(frame);
    }

    expect(frames.every((frame) => frame.id === undefined)).toBe(true);
  });
});
