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
  assertDriverExecutionResult,
  assertKrakenDriver,
  type DriverExecutionContext,
  isKrakenDriver,
  type KrakenDriver,
} from "../src/index.ts";

describe("driver-api", () => {
  test("accepts explicit driver contracts", async () => {
    const continueIteration = {
      type: "continue_iteration",
    } satisfies { type: "continue_iteration" };
    const driver = {
      execute(_context) {
        return Promise.resolve({
          resolution: continueIteration,
        });
      },
      id: "react",
      resume(_context) {
        return Promise.resolve({
          resolution: continueIteration,
        });
      },
    } satisfies KrakenDriver;

    expect(isKrakenDriver(driver)).toBe(true);
    expect(() => assertKrakenDriver(driver)).not.toThrow();

    const context = createDriverExecutionContext();
    await expect(driver.execute(context)).resolves.toEqual({
      resolution: { type: "continue_iteration" },
    });
    expect(() =>
      assertDriverExecutionResult({
        resolution: { type: "continue_iteration" },
      })
    ).not.toThrow();
    expect(
      context.handoff.createContextPlan({
        reason: "handoff",
        targetAgent: "reviewer",
      }).targetAgent
    ).toBe("reviewer");
  });

  test("accepts driver contracts without a resume method", () => {
    const continueIteration = {
      type: "continue_iteration",
    } satisfies { type: "continue_iteration" };
    const driver = {
      execute() {
        return Promise.resolve({
          resolution: continueIteration,
        });
      },
      id: "react",
    } satisfies KrakenDriver;

    expect(isKrakenDriver(driver)).toBe(true);
    expect(() => assertKrakenDriver(driver)).not.toThrow();
  });

  test("accepts toolExecutionMode when assistant messages request tool calls", () => {
    expect(() =>
      assertDriverExecutionResult({
        messages: [
          {
            parts: [
              {
                callId: "call-search",
                input: { query: "kraken" },
                name: "search",
                type: "tool_call",
              },
            ],
            role: "assistant",
          },
        ],
        resolution: { type: "continue_iteration" },
        toolExecutionMode: "sequential",
      })
    ).not.toThrow();
  });

  test("rejects driver results with more than one assistant message", () => {
    expect(() =>
      assertDriverExecutionResult({
        messages: [
          {
            parts: [{ text: "first", type: "text" }],
            role: "assistant",
          },
          {
            parts: [{ text: "second", type: "text" }],
            role: "assistant",
          },
        ],
        resolution: { reason: "done", type: "end_turn" },
      })
    ).toThrow("messages must not contain more than one assistant message");
  });

  test("permits failed partial execution results when assistant output is staged", () => {
    expect(() =>
      assertDriverExecutionResult({
        messages: [
          {
            parts: [{ text: "Interrupted output", type: "text" }],
            role: "assistant",
          },
        ],
        partial: true,
        resolution: {
          error: new Error("execution cancelled"),
          fatality: "hard",
          type: "fail",
        },
      })
    ).not.toThrow();
  });

  test("rejects partial execution results that are not failed assistant output", () => {
    expect(() =>
      assertDriverExecutionResult({
        partial: true,
        resolution: { reason: "done", type: "end_turn" },
      })
    ).toThrow("partial is only valid for failed execution results");
  });

  test("rejects driver results that bypass framework-owned tool results", () => {
    expect(() =>
      assertDriverExecutionResult({
        messages: [
          {
            parts: [
              {
                callId: "call-search",
                name: "search",
                output: { leaked: true },
                type: "tool_result",
              },
            ],
            role: "assistant",
          },
        ],
        resolution: { type: "continue_iteration" },
      })
    ).toThrow("must not be a tool_result");
  });

  test("rejects superseded driver result fields from the old branch shape", () => {
    expect(() =>
      assertDriverExecutionResult({
        activeAgent: "primary",
        resolution: { type: "continue_iteration" },
      })
    ).toThrow('must not include unsupported field "activeAgent"');

    expect(() =>
      assertDriverExecutionResult({
        messages: [
          {
            parts: [{ text: "Visible output", type: "text" }],
            role: "assistant",
          },
        ],
        resolution: { reason: "done", type: "end_turn" },
        response: {
          finishReason: "stop",
          parts: [{ text: "Visible output", type: "text" }],
        },
      })
    ).toThrow('must not include unsupported field "response"');

    expect(() =>
      assertDriverExecutionResult({
        resolution: { type: "continue_iteration" },
        toolExecutionMode: "sequential",
      })
    ).toThrow(
      "toolExecutionMode is only valid when driver messages request tool calls"
    );
  });

  test("requires toolExecutionMode when assistant messages request tool calls", () => {
    expect(() =>
      assertDriverExecutionResult({
        messages: [
          {
            parts: [
              {
                callId: "call-search",
                input: { query: "kraken" },
                name: "search",
                type: "tool_call",
              },
            ],
            role: "assistant",
          },
        ],
        resolution: { type: "continue_iteration" },
      })
    ).toThrow(
      "toolExecutionMode is required when driver messages request tool calls"
    );
  });

  test("rejects handoff resolutions whose targetAgent contradicts the context plan", () => {
    const context = createDriverExecutionContext();

    expect(() =>
      assertDriverExecutionResult({
        resolution: {
          contextPlan: context.handoff.createContextPlan({
            reason: "handoff",
            targetAgent: "reviewer",
          }),
          targetAgent: "planner",
          type: "handoff",
        },
      })
    ).toThrow("targetAgent must match");
  });

  test("rejects raw handoff plans whose sourceContext target disagrees with the plan target", () => {
    const context = createDriverExecutionContext();

    expect(() =>
      assertDriverExecutionResult({
        resolution: {
          contextPlan: {
            ...context.handoff.createContextPlan({
              reason: "handoff",
              targetAgent: "reviewer",
            }),
            sourceContext: {
              ...context.handoff.createContextPlan({
                reason: "handoff",
                targetAgent: "reviewer",
              }).sourceContext,
              handoffIntent: {
                reason: "handoff",
                targetAgent: "planner",
              },
              targetAgent: { name: "planner" },
            },
          },
          targetAgent: "reviewer",
          type: "handoff",
        },
      })
    ).toThrow("sourceContext.handoffIntent.targetAgent must match");
  });

  test("rejects raw handoff plans whose sourceContext agents are not valid AgentConfig snapshots", () => {
    const context = createDriverExecutionContext();

    expect(() =>
      assertDriverExecutionResult({
        resolution: {
          contextPlan: {
            ...context.handoff.createContextPlan({
              reason: "handoff",
              targetAgent: "reviewer",
            }),
            sourceContext: {
              ...context.handoff.createContextPlan({
                reason: "handoff",
                targetAgent: "reviewer",
              }).sourceContext,
              targetAgent: {
                name: "reviewer",
                tools: 42,
              },
            },
          },
          targetAgent: "reviewer",
          type: "handoff",
        },
      })
    ).toThrow("sourceContext.targetAgent.tools must be an array");
  });

  test("rejects terminal resolutions paired with assistant tool calls", () => {
    expect(() =>
      assertDriverExecutionResult({
        messages: [
          {
            parts: [
              {
                callId: "call-search",
                input: { query: "kraken" },
                name: "search",
                type: "tool_call",
              },
            ],
            role: "assistant",
          },
        ],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
        toolExecutionMode: "parallel",
      })
    ).toThrow(
      "resolution must continue iteration when driver messages request tool calls"
    );
  });

  test("rejects pause resolutions that are not rooted in assistant tool calls", () => {
    expect(() =>
      assertDriverExecutionResult({
        messages: [
          {
            parts: [
              { text: "Need approval without a tool call", type: "text" },
            ],
            role: "assistant",
          },
        ],
        resolution: {
          approval: {
            completedResults: [],
            toolCalls: [
              {
                callId: "call-search",
                decisions: ["approve"],
                input: { query: "kraken" },
                message: "Need approval",
                name: "search",
              },
            ],
          },
          reason: "approval_required",
          type: "pause",
        },
      })
    ).toThrow("resolution.pause requires driver messages with tool calls");
  });

  test("rejects stale nested fields on exact-shape resolutions", () => {
    expect(() =>
      assertDriverExecutionResult({
        resolution: {
          reason: "stale",
          type: "continue_iteration",
        },
      })
    ).toThrow('resolution must not include unsupported field "reason"');
  });
});

function createDriverExecutionContext(): DriverExecutionContext {
  return {
    branchId: "branch-1",
    config: { name: "primary" },
    handoff: {
      createContextPlan: (input) => ({
        builder:
          input.builder ?? ((context) => context.helpers.storeMessages([])),
        mode: input.mode ?? "preserve_trace",
        reason: input.reason,
        sourceContext: {
          handoffIntent: {
            payload: input.payload,
            reason: input.reason,
            targetAgent: input.targetAgent,
          },
          helpers: {
            loadMessage: () => null,
            storeMessage: () => "1".repeat(64),
            storeMessages: () => [],
          },
          manifest: {
            byRole: {
              assistant: 0,
              system: 0,
              tool: 0,
              user: 0,
            },
            extensions: {},
            lastAssistantMessageIndex: -1,
            lastUserMessageIndex: -1,
            messageCount: 0,
            tokenEstimate: 0,
            toolCalls: {
              byName: {},
              total: 0,
            },
            toolResults: {
              byName: {},
              total: 0,
            },
            turnBoundaries: [],
          },
          messages: [],
          sourceAgent: { name: "primary" },
          targetAgent: { name: input.targetAgent },
        },
        targetAgent: input.targetAgent,
      }),
    },
    iterationCount: 1,
    manifest: {
      byRole: {
        assistant: 0,
        system: 0,
        tool: 0,
        user: 0,
      },
      extensions: {},
      lastAssistantMessageIndex: -1,
      lastUserMessageIndex: -1,
      messageCount: 0,
      tokenEstimate: 0,
      toolCalls: {
        byName: {},
        total: 0,
      },
      toolResults: {
        byName: {},
        total: 0,
      },
      turnBoundaries: [],
    },
    messages: [],
    runtime: {
      emit: () => undefined,
      now: () => 0,
    },
    schemaId: "schema-1",
    threadId: "thread-1",
    toolRegistry: {
      get: () => undefined,
      has: () => false,
      list: () => [],
      register: () => undefined,
      toDefinitions: () => [],
    },
    turnId: "turn-1",
  };
}
