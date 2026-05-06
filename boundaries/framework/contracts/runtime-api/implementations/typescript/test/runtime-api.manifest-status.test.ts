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
import { isExecutionStatus } from "../src/index.ts";
import { frameworkContractFixtures } from "./runtime-api-fixtures.js";

describe("runtime-api manifest and status contracts", () => {
  test("accepts manifests with multiple user messages in a single turn", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(true);
  });

  test("accepts manifests whose first user turn starts after a system message", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 1,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: 2,
          lastUserMessageIndex: 3,
          messageCount: 4,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [1, 3],
        },
        phase: "running",
      })
    ).toBe(true);
  });

  test("rejects manifests that skip the earliest possible first user turn", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [1],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests whose turn boundary collides with the known last assistant index", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 1,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: 1,
          lastUserMessageIndex: 3,
          messageCount: 4,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [1],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with malformed optional fields", () => {
    expect(
      isExecutionStatus({
        approval: "oops",
        iterationCount: 1,
        phase: "paused",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with undeclared fields", () => {
    expect(
      isExecutionStatus({
        extra: 1,
        iterationCount: 0,
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests with undeclared nested fields", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            extra: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 0,
          messageCount: 1,
          tokenEstimate: 12,
          toolCalls: {
            byName: {},
            extra: 1,
            total: 0,
          },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          extra: 1,
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 0,
          messageCount: 1,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with invalid phase invariants", () => {
    expect(
      isExecutionStatus({
        iterationCount: 1,
        phase: "paused",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        approval: frameworkContractFixtures.approvalRequest,
        iterationCount: 1,
        phase: "running",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        iterationCount: 1,
        pauseReason: "approval_required",
        phase: "completed",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        approval: frameworkContractFixtures.approvalRequest,
        iterationCount: 1,
        phase: "paused",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with non-finite manifest token estimates", () => {
    expect(
      isExecutionStatus({
        iterationCount: 1,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: Number.NaN,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        iterationCount: 1,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: -5,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with non-serializable extension state", () => {
    expect(
      isExecutionStatus({
        iterationCount: 1,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {
            myExt: {
              fn() {
                return 1;
              },
            },
          },
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with negative manifest counters", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: -1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: -2 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("accepts first-turn manifests with sentinel assistant indexes", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 0,
          messageCount: 1,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(true);
  });

  test("rejects manifests with inconsistent summary indexes and totals", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 99,
          lastUserMessageIndex: 0,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: { search: 2 }, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [5, 0, 5],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests whose turn boundaries do not match user-turn count", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 0,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: -1,
          messageCount: 1,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(true);
  });

  test("rejects manifests whose turn boundaries contradict the last user index", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests with empty tool-name buckets", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: { "": 1 }, total: 1 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests with impossible last-role summary indexes", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 2,
            system: 0,
            tool: 0,
            user: 0,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: -1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests with impossible multi-turn boundaries", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 2,
          messageCount: 3,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [1],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests whose final turn boundary cannot match the last user", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 1,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 2,
          messageCount: 3,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0, 1],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects multi-turn boundaries that exceed the last user index", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 1,
          messageCount: 3,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0, 2],
        },
        phase: "running",
      })
    ).toBe(false);
  });
});
