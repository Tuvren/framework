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
  assertStreamEventTypes,
  collectTuvrenStreamEvents,
  createFixtureEventStream,
  frameworkStreamTestFixtures,
  startAsyncCapture,
  waitForAsyncTurn,
} from "../src/index.ts";

describe("@tuvren/framework-testkit", () => {
  test("provides validated canonical stream fixtures and collectors", async () => {
    const events = await collectTuvrenStreamEvents(
      createFixtureEventStream(frameworkStreamTestFixtures.completedTurn)
    );

    assertStreamEventTypes(events.slice(0, 3), [
      "turn.start",
      "iteration.start",
      "message.start",
    ]);
    expect(events[0]).not.toBe(frameworkStreamTestFixtures.completedTurn[0]);
  });

  test("captures asynchronous streams without consuming test assertions", async () => {
    const capture = startAsyncCapture(
      createFixtureEventStream(frameworkStreamTestFixtures.failedTurn)
    );

    await waitForAsyncTurn();
    await capture.done;

    assertStreamEventTypes(capture.events, ["turn.start", "error", "turn.end"]);
  });
});
