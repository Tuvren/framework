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
  streamAdapterFixtures,
} from "@tuvren/stream-core";
import { toSseFrames, toSseResponse } from "@tuvren/stream-sse";

describe("stream-sse package exports", () => {
  test("export the frame adapter and response helper", async () => {
    const frames = toSseFrames(
      createFixtureStream(streamAdapterFixtures.completedTurn)
    );
    const iterator = frames[Symbol.asyncIterator]();
    const nextFrame = await iterator.next();

    expect(nextFrame.done).toBe(false);
    expect(nextFrame.value?.event).toBe("turn.start");
    await iterator.return?.();

    const response = toSseResponse(
      createFixtureStream(streamAdapterFixtures.completedTurn)
    );
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8"
    );
  });
});
