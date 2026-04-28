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
import { type AGUIEvent, EventType } from "@ag-ui/core";
import { toAgUiEvents } from "@tuvren/stream-agui";
import {
  createFixtureStream,
  streamAdapterFixtures,
} from "@tuvren/stream-core";

describe("stream-agui package exports", () => {
  test("export the AG-UI adapter with the official event union", async () => {
    const events = toAgUiEvents(
      createFixtureStream(streamAdapterFixtures.completedTurn)
    );
    const iterator = events[Symbol.asyncIterator]();
    const nextEvent = (await iterator.next()).value as AGUIEvent | undefined;

    expect(nextEvent?.type).toBe(EventType.RUN_STARTED);
    await iterator.return?.();
  });
});
