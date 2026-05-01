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
import type { TuvrenStreamEvent } from "@tuvren/event-stream";
import {
  assertStreamEventTypes,
  collectTuvrenStreamEvents,
  createFixtureEventStream,
  startAsyncCapture,
  waitForAsyncTurn,
} from "../src/index.ts";

const completedTurnFixture: readonly TuvrenStreamEvent[] = [
  {
    threadId: "thread-main",
    timestamp: 1,
    turnId: "turn-main",
    type: "turn.start",
  },
  {
    iterationCount: 1,
    timestamp: 2,
    type: "iteration.start",
  },
  {
    messageId: "message-main",
    role: "assistant",
    timestamp: 3,
    type: "message.start",
  },
];
const failedTurnFixture: readonly TuvrenStreamEvent[] = [
  {
    threadId: "thread-failed",
    timestamp: 21,
    turnId: "turn-failed",
    type: "turn.start",
  },
  {
    error: {
      code: "runtime_execution_cancelled",
      message: "execution cancelled",
    },
    fatal: true,
    timestamp: 22,
    type: "error",
  },
  {
    status: "failed",
    timestamp: 23,
    turnId: "turn-failed",
    type: "turn.end",
  },
];

describe("@tuvren/framework-testkit", () => {
  test("provides validated stream collectors without owning fixtures", async () => {
    const events = await collectTuvrenStreamEvents(
      createFixtureEventStream(completedTurnFixture)
    );

    assertStreamEventTypes(events.slice(0, 3), [
      "turn.start",
      "iteration.start",
      "message.start",
    ]);
    expect(events[0]).not.toBe(completedTurnFixture[0]);
  });

  test("captures asynchronous streams without consuming test assertions", async () => {
    const capture = startAsyncCapture(
      createFixtureEventStream(failedTurnFixture)
    );

    await waitForAsyncTurn();
    await capture.done;

    assertStreamEventTypes(capture.events, ["turn.start", "error", "turn.end"]);
  });
});
