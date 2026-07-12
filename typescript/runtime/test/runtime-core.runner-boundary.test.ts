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
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  readBranchContextManifest,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("rejects malformed initial input signals before staging branch history", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      async execute(_context) {
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
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});

    expect(() =>
      runtime.executeTurn({
        branchId: thread.branchId,
        config: { name: "primary" },
        signal: JSON.parse('{"parts":[123]}'),
        threadId: thread.threadId,
      })
    ).toThrow("request.signal must be a valid TuvrenMessage");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([]);
  });

  test("does not start a fresh handle when it is canceled before the first stream pull", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const runner = {
      async execute() {
        executeCalls += 1;
        return {
          messages: [assistantText("This should never run.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Never start"),
      threadId: thread.threadId,
    });

    handle.cancel();
    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("failed");
    expect(events).toEqual([]);
    expect(executeCalls).toBe(0);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([]);
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toBeNull();
  });

  test("fails malformed runner messages before they can be checkpointed", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      async execute(_context) {
        return {
          messages: JSON.parse('[{"role":"assistant","parts":[123]}]'),
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
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject malformed runner output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_tuvren_message");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject malformed runner output", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("fails invalid runner resolutions at the execution boundary", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      async execute(_context) {
        return {
          messages: [assistantText("Invalid resolution payload.")],
          resolution: JSON.parse('{"bogus":true}'),
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
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject invalid runner resolution"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_runner_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject invalid runner resolution", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects malformed runner handoff plans at the execution boundary", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      async execute() {
        return JSON.parse(
          '{"activeAgent":"primary","messages":[{"role":"assistant","parts":[{"type":"text","text":"Bad handoff"}]}],"resolution":{"type":"handoff","targetAgent":"reviewer","contextPlan":{"targetAgent":"reviewer"}}}'
        );
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
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject malformed handoff"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_runner_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject malformed handoff", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects runner messages that bypass the shared tool-result path", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      async execute() {
        return {
          messages: [
            {
              parts: [
                {
                  callId: "call-search",
                  name: "search",
                  output: { hits: 1 },
                  type: "tool_result",
                },
              ],
              role: "assistant",
            },
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
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject runner tool result"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_runner_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject runner tool result", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects removed runner response fields at the runtime boundary", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      async execute() {
        return {
          messages: [assistantText("Plain assistant output.")],
          response: {
            finishReason: "tool_call",
            parts: [
              {
                callId: "call-search",
                input: { query: "mismatch" },
                name: "search",
                type: "tool_call",
              },
            ],
          },
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
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject contradictory runner response"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_runner_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject contradictory runner response", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects runner handoff resolutions whose target disagrees with the context plan", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      async execute(context) {
        return {
          messages: [assistantText("Mismatched handoff target.")],
          resolution: {
            contextPlan: context.handoff.createContextPlan({
              reason: "handoff",
              targetAgent: "worker",
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
      resolveAgentConfig: (agentName) =>
        ({
          primary: { name: "primary" },
          reviewer: { name: "reviewer" },
          worker: { name: "worker" },
        })[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject handoff target mismatch"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_runner_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject handoff target mismatch", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects raw handoff plans whose source context target disagrees with the plan target", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      planner: { name: "planner" },
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    const runner = {
      async execute(context) {
        return {
          resolution: {
            contextPlan: {
              builder(sourceContext) {
                return sourceContext.helpers.storeMessages([
                  {
                    parts: [
                      {
                        text: `prepared-for:${sourceContext.targetAgent.name}`,
                        type: "text",
                      },
                    ],
                    role: "user",
                  },
                ]);
              },
              mode: "preserve_trace",
              reason: "delegate",
              sourceContext: {
                handoffIntent: {
                  reason: "delegate",
                  targetAgent: "planner",
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
                targetAgent: agents.planner,
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
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Reject raw handoff mismatch"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_runner_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject raw handoff mismatch", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects terminal runner resolutions that still contain executable tool calls before persistence", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      async execute() {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "invalid" },
                name: "search",
              },
            ]),
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
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject terminal tool call"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_runner_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject terminal tool call", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects runner state updates for extensions that are not active in the current turn", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      async execute() {
        return {
          messages: [assistantText("ghost state")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
          stateUpdates: [
            {
              extensionName: "ghost-extension",
              state: { leaked: true },
            },
          ],
        } satisfies RunnerExecutionResult;
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
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject ghost extension state"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );
    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_runner_result");
    expect(manifest.extensions).toEqual({});
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject ghost extension state", type: "text" }],
        role: "user",
      },
    ]);
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
