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
  collectTuvrenStreamEvents,
  createFixtureEventStream,
} from "@tuvren/framework-testkit";

const pausedTurnFixture: readonly TuvrenStreamEvent[] = [
  {
    threadId: "thread-paused",
    timestamp: 31,
    turnId: "turn-paused",
    type: "turn.start",
  },
  {
    request: {
      completedResults: [],
      toolCalls: [
        {
          callId: "call-email",
          decisions: ["approve", "reject"],
          input: {
            to: "team@example.com",
          },
          message: "Approve this email?",
          name: "send_email",
        },
      ],
    },
    timestamp: 32,
    type: "approval.requested",
  },
  {
    status: "paused",
    timestamp: 33,
    turnId: "turn-paused",
    type: "turn.end",
  },
];

describe("@tuvren/framework-testkit package exports", () => {
  test("exposes framework stream test helpers", async () => {
    const events = await collectTuvrenStreamEvents(
      createFixtureEventStream(pausedTurnFixture)
    );

    expect(events.map((event) => event.type)).toEqual([
      "turn.start",
      "approval.requested",
      "turn.end",
    ]);
  });
});
