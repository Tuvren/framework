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

// biome-ignore-all lint/suspicious/useAwait: Test runners intentionally match the async framework runner contract.
import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "@tuvren/core/execution";
import type {
  RunnerExecutionResult,
  RuntimeRunner,
  RuntimeRunnerFactory,
} from "@tuvren/core/runner";
import {
  createRunnerRegistry as createBaseRunnerRegistry,
  createPreserveTraceHandoffContextBuilder,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  buildHandoffPlan,
  collectEvents,
  hasAssistantText,
  textSignal,
  toOptionalRecord,
} from "./runtime-core-test-helpers.ts";

function _hasAssistantTextMessage(
  messages: readonly unknown[],
  expectedText: string
): boolean {
  return messages.some((message) => {
    const record = toOptionalRecord(message);

    if (record?.role !== "assistant" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord = toOptionalRecord(part);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  });
}

function _countUserTextMessages(
  messages: readonly unknown[],
  expectedText: string
): number {
  return messages.filter((message) => {
    const record = toOptionalRecord(message);

    if (record?.role !== "user" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord = toOptionalRecord(part);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  }).length;
}

describe("framework-runtime-core", () => {
  test("applies handoffs through the shared runtime layer and swaps active agents", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    const handoffBuilder = createPreserveTraceHandoffContextBuilder();
    const handoffRunner = {
      async execute(context) {
        if (context.config.name === "primary") {
          return {
            messages: [assistantText("Passing this to review.")],
            resolution: {
              contextPlan: buildHandoffPlan(
                context,
                agents.primary,
                agents.reviewer,
                handoffBuilder
              ),
              targetAgent: "reviewer",
              type: "handoff",
            },
          };
        }

        return {
          messages: [assistantText("Review complete.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([handoffRunner]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start handoff"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(
      events.some(
        (event) => event.type === "custom" && event.name === "handoff.start"
      )
    ).toBe(true);
    expect(handle.status().activeAgent).toBe("reviewer");
    expect(handle.status().phase).toBe("completed");
  });

  test("preserves the handed-off activeAgent when later execution fails", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: {
        contextPolicy: {
          evaluate() {
            throw new Error("reviewer context policy boom");
          },
        },
        name: "reviewer",
      },
    };
    const handoffRunner = {
      async execute(context) {
        if (context.config.name === "primary") {
          return {
            messages: [assistantText("Pass this to the reviewer.")],
            resolution: {
              contextPlan: context.handoff.createContextPlan({
                reason: "handoff",
                targetAgent: "reviewer",
              }),
              targetAgent: "reviewer",
              type: "handoff",
            },
          };
        }

        return {
          messages: [assistantText("This should not run.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([handoffRunner]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start failing handoff"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(errorEvent?.error.message).toContain("reviewer context policy boom");
    expect(handle.status().phase).toBe("failed");
    expect(handle.status().activeAgent).toBe("reviewer");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "reviewer",
      state: "failed",
    });
  });

  test("fails invalid handoff builders before persisting a corrupted branch head", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    const handoffRunner = {
      async execute(context) {
        return {
          messages: [],
          resolution: {
            contextPlan: {
              mode: "broken",
              reason: "return a missing hash",
              builder() {
                return ["missing-handoff-message"];
              },
              sourceContext: {
                handoffIntent: {
                  targetAgent: "reviewer",
                },
                helpers: {
                  loadMessage() {
                    return null;
                  },
                  storeMessage() {
                    return "unused";
                  },
                  storeMessages() {
                    return [];
                  },
                },
                manifest: context.manifest,
                messages: context.messages,
                sourceAgent: agents.primary,
                targetAgent: agents.reviewer,
              },
              targetAgent: "reviewer",
            },
            targetAgent: "reviewer",
            type: "handoff",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([handoffRunner]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start broken handoff"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("missing_message");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Start broken handoff", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rolls back pre-handoff assistant output when the handoff builder fails", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    const runner = {
      async execute(context) {
        return {
          messages: [assistantText("Passing this to review.")],
          resolution: {
            contextPlan: context.handoff.createContextPlan({
              builder() {
                return ["missing-handoff-message"];
              },
              reason: "delegate",
              targetAgent: "reviewer",
            }),
            targetAgent: "reviewer",
            type: "handoff",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start rollback handoff"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("missing_message");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Start rollback handoff", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("does not leak per-turn tools across handoff transitions", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    const handoffRunner = {
      async execute(context) {
        if (context.config.name === "primary") {
          return {
            messages: [assistantText("Passing this to review.")],
            resolution: {
              contextPlan: buildHandoffPlan(
                context,
                agents.primary,
                agents.reviewer,
                createPreserveTraceHandoffContextBuilder()
              ),
              targetAgent: "reviewer",
              type: "handoff",
            },
          };
        }

        return {
          messages: [
            assistantText(`adhoc:${String(context.toolRegistry.has("adhoc"))}`),
          ],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([handoffRunner]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start handoff"),
      threadId: thread.threadId,
      tools: [
        {
          description: "Ad-hoc tool",
          execute() {
            return {
              adhoc: true,
            };
          },
          inputSchema: {
            type: "object",
          },
          name: "adhoc",
        },
      ],
    });

    await collectEvents(handle.events());

    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "adhoc:false"
      )
    ).toBe(true);
  });
});

function createRunnerRegistry(
  runners: Array<RuntimeRunner | RuntimeRunnerFactory> = []
) {
  return createBaseRunnerRegistry(runners.map(wrapRunnerEntry));
}

function wrapRunnerEntry(
  entry: RuntimeRunner | RuntimeRunnerFactory
): RuntimeRunner | RuntimeRunnerFactory {
  if (isKrakenRunnerFactory(entry)) {
    return {
      create() {
        return wrapRunner(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapRunner(entry);
}

function isKrakenRunnerFactory(
  entry: RuntimeRunner | RuntimeRunnerFactory
): entry is RuntimeRunnerFactory {
  return "create" in entry && typeof entry.create === "function";
}

function wrapRunner(runner: RuntimeRunner): RuntimeRunner {
  const resume = runner.resume;

  return {
    async execute(context) {
      return normalizeRunnerResult(await runner.execute(context));
    },
    id: runner.id,
    ...(resume === undefined
      ? {}
      : {
          async resume(context) {
            return normalizeRunnerResult(await resume(context));
          },
        }),
  };
}

function normalizeRunnerResult(
  result: RunnerExecutionResult
): RunnerExecutionResult {
  if (
    result.toolExecutionMode !== undefined ||
    !requestsToolExecution(result)
  ) {
    return result;
  }

  return {
    ...result,
    toolExecutionMode: "parallel",
  };
}

function requestsToolExecution(result: RunnerExecutionResult): boolean {
  return (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );
}
