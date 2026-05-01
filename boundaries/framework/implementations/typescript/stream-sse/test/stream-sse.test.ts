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
import {
  assertTuvrenStreamEvent,
  type TuvrenStreamEvent,
} from "@tuvren/event-stream";
import {
  createFixtureStream,
  teeTuvrenStreamEvents,
} from "@tuvren/stream-core";
import { loadConformancePlan } from "../../../../../../tools/conformance/plan-compiler/index.js";
import { toSseFrames, toSseResponse } from "../src/index.ts";

const frameworkStreamFixtures = await readFrameworkStreamFixtures();

interface FrameworkStreamFixtureSet {
  completedTurn: readonly TuvrenStreamEvent[];
  failedTurn: readonly TuvrenStreamEvent[];
  pausedTurn: readonly TuvrenStreamEvent[];
}

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

async function readFrameworkStreamFixtures(): Promise<FrameworkStreamFixtureSet> {
  const plan = await loadConformancePlan(
    "boundaries/framework/conformance/plans/event-stream-core.json"
  );
  const fixture = plan.fixtures.get("stream-events");

  // The fixture bytes are plan-owned; this assertion only narrows the
  // TypeScript binding projection used by these adapter mechanics tests.
  assertFrameworkStreamFixtureSet(fixture, "stream-events fixture");
  return fixture;
}

function assertFrameworkStreamFixtureSet(
  value: unknown,
  label: string
): asserts value is FrameworkStreamFixtureSet {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertTuvrenStreamEvents(value.completedTurn, `${label}.completedTurn`);
  assertTuvrenStreamEvents(value.failedTurn, `${label}.failedTurn`);
  assertTuvrenStreamEvents(value.pausedTurn, `${label}.pausedTurn`);
}

function assertTuvrenStreamEvents(
  value: unknown,
  label: string
): asserts value is readonly TuvrenStreamEvent[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  for (const [index, event] of value.entries()) {
    assertTuvrenStreamEvent(event, `${label}[${index}]`);
  }
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
