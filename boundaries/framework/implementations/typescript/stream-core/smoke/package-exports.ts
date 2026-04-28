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
  createFixtureStream,
  serializeTuvrenStreamEvent,
  streamAdapterFixtures,
  teeTuvrenStreamEvents,
} from "@tuvren/stream-core";

describe("stream-core package exports", () => {
  test("expose tee helpers and canonical fixture utilities", async () => {
    const [events] = teeTuvrenStreamEvents(
      createFixtureStream(streamAdapterFixtures.completedTurn),
      1
    );
    const iterator = events[Symbol.asyncIterator]();
    const nextEvent = await iterator.next();

    expect(nextEvent.done).toBe(false);

    if (nextEvent.done || nextEvent.value.type !== "turn.start") {
      throw new Error("expected turn.start fixture event");
    }

    expect(serializeTuvrenStreamEvent(nextEvent.value)).toContain("turn-main");
    await iterator.return?.();
  });
});
