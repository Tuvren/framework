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
import { frameworkStreamTestFixtures } from "../src/index.ts";

describe("@tuvren/framework-testkit conformance assets", () => {
  test("loads boundary-owned framework stream fixtures", () => {
    // The compatibility suite claims more than basic loadability, so this test
    // asserts the event ordering and the load-bearing payloads that later
    // implementations must preserve when they consume this shared asset set.
    expect(
      frameworkStreamTestFixtures.completedTurn.map((event) => event.type)
    ).toEqual([
      "turn.start",
      "iteration.start",
      "message.start",
      "text.delta",
      "text.done",
      "tool_call.start",
      "tool_call.args_delta",
      "tool_call.done",
      "tool.start",
      "tool.result",
      "state.snapshot",
      "custom",
      "message.done",
      "iteration.end",
      "turn.end",
    ]);
    expect(frameworkStreamTestFixtures.completedTurn[6]).toMatchObject({
      callId: "call-search",
      delta: '{"query":"docs"}',
      type: "tool_call.args_delta",
    });
    expect(frameworkStreamTestFixtures.completedTurn[10]).toMatchObject({
      manifest: {
        byRole: {
          assistant: 1,
          system: 0,
          tool: 1,
          user: 1,
        },
        messageCount: 3,
        toolCalls: {
          byName: {
            search: 1,
          },
          total: 1,
        },
      },
      type: "state.snapshot",
    });
    expect(frameworkStreamTestFixtures.completedTurn[14]).toMatchObject({
      status: "completed",
      type: "turn.end",
    });
    expect(frameworkStreamTestFixtures.failedTurn).toEqual([
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
    ]);
    expect(frameworkStreamTestFixtures.pausedTurn).toEqual([
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
    ]);
  });
});
