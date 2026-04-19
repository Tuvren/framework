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
          activeAgent: "primary",
          resolution: continueIteration,
        });
      },
      id: "react",
      resume(_context) {
        return Promise.resolve({
          activeAgent: "primary",
          resolution: continueIteration,
        });
      },
    } satisfies KrakenDriver;

    expect(isKrakenDriver(driver)).toBe(true);
    expect(() => assertKrakenDriver(driver)).not.toThrow();
    const context: DriverExecutionContext = {
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

    await expect(driver.execute(context)).resolves.toEqual({
      activeAgent: "primary",
      resolution: { type: "continue_iteration" },
    });
    expect(() =>
      assertDriverExecutionResult({
        activeAgent: "primary",
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

  test("permits drivers to return a complete KrakenModelResponse alongside messages", async () => {
    const context: DriverExecutionContext = {
      branchId: "branch-1",
      config: { name: "primary" },
      handoff: {
        createContextPlan: (input) => ({
          builder: (handoffContext) => handoffContext.helpers.storeMessages([]),
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
    const driver = {
      execute(_context) {
        return Promise.resolve({
          activeAgent: "primary",
          messages: [
            {
              parts: [{ text: "Truncated output", type: "text" }],
              role: "assistant",
            },
          ],
          response: {
            finishReason: "length",
            parts: [{ text: "Truncated output", type: "text" }],
            providerMetadata: { stop: "max_tokens" },
            usage: {
              inputTokens: 12,
              outputTokens: 4,
            },
          },
          resolution: { reason: "done", type: "end_turn" },
        });
      },
      id: "react",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;

    await expect(driver.execute(context)).resolves.toEqual({
      activeAgent: "primary",
      messages: [
        {
          parts: [{ text: "Truncated output", type: "text" }],
          role: "assistant",
        },
      ],
      response: {
        finishReason: "length",
        parts: [{ text: "Truncated output", type: "text" }],
        providerMetadata: { stop: "max_tokens" },
        usage: {
          inputTokens: 12,
          outputTokens: 4,
        },
      },
      resolution: { reason: "done", type: "end_turn" },
    });
    expect(() =>
      assertDriverExecutionResult({
        activeAgent: "primary",
        messages: [
          {
            parts: [{ text: "Truncated output", type: "text" }],
            role: "assistant",
          },
        ],
        response: {
          finishReason: "length",
          parts: [{ text: "Truncated output", type: "text" }],
          providerMetadata: { stop: "max_tokens" },
          usage: {
            inputTokens: 12,
            outputTokens: 4,
          },
        },
        resolution: { reason: "done", type: "end_turn" },
      })
    ).not.toThrow();
  });

  test("rejects driver results that bypass framework-owned tool results", () => {
    expect(() =>
      assertDriverExecutionResult({
        activeAgent: "primary",
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

  test("rejects driver responses that contradict staged assistant tool-call semantics", () => {
    expect(() =>
      assertDriverExecutionResult({
        activeAgent: "primary",
        messages: [
          {
            parts: [{ text: "Plain answer", type: "text" }],
            role: "assistant",
          },
        ],
        response: {
          finishReason: "tool_call",
          parts: [
            {
              callId: "call-search",
              input: { query: "leak" },
              name: "search",
              type: "tool_call",
            },
          ],
        },
        resolution: { reason: "done", type: "end_turn" },
      })
    ).toThrow(
      "must agree with the staged assistant message about tool-call semantics"
    );
  });

  test("rejects handoff resolutions whose targetAgent contradicts the context plan", () => {
    const context = createDriverExecutionContext();

    expect(() =>
      assertDriverExecutionResult({
        activeAgent: "primary",
        resolution: {
          contextPlan: context.handoff.createContextPlan({
            reason: "handoff",
            targetAgent: "reviewer",
          }),
          targetAgent: "worker",
          type: "handoff",
        },
      })
    ).toThrow("must match value.resolution.contextPlan.targetAgent");
  });

  test("rejects malformed driver contracts", () => {
    const continueIteration = {
      type: "continue_iteration",
    } satisfies { type: "continue_iteration" };
    expect(isKrakenDriver({ id: "react" })).toBe(false);
    expect(() => assertKrakenDriver({ id: "react" })).toThrow(
      "must be a valid KrakenDriver"
    );
    expect(
      isKrakenDriver({
        execute: () => undefined,
        id: "",
        resume: () => undefined,
      })
    ).toBe(false);
    expect(
      isKrakenDriver({
        execute: () => undefined,
        id: "   ",
        resume: () => undefined,
      })
    ).toBe(false);

    const hostileDriver = {
      execute: () =>
        Promise.resolve({
          activeAgent: "primary",
          resolution: continueIteration,
        }),
      get id() {
        throw new Error("boom");
      },
      resume: () =>
        Promise.resolve({
          activeAgent: "primary",
          resolution: continueIteration,
        }),
    };

    expect(() => isKrakenDriver(hostileDriver)).not.toThrow();
    expect(isKrakenDriver(hostileDriver)).toBe(false);
  });
});

function createDriverExecutionContext(): DriverExecutionContext {
  return {
    branchId: "branch-1",
    config: { name: "primary" },
    handoff: {
      createContextPlan: (input) => ({
        builder: (handoffContext) => handoffContext.helpers.storeMessages([]),
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
