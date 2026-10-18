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

import type { AgentConfig, InputSignal } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
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
  fromSynchronousVariadicAwaited,
  assistantText,
  assistantToolCalls,
  collectEvents,
  readBranchContextManifest,
  textSignal,
} from "./runtime-core-test-helpers.ts";

const isKrakenRunnerFactory = (
  entry: RuntimeRunner | RuntimeRunnerFactory
): entry is RuntimeRunnerFactory =>
  "create" in entry && typeof entry.create === "function";

const requestsToolExecution = (result: RunnerExecutionResult): boolean =>
  (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );

const normalizeRunnerResult = (
  result: RunnerExecutionResult
): RunnerExecutionResult => {
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
};

const wrapRunner = (runner: RuntimeRunner): RuntimeRunner => {
  const resume = runner.resume?.bind(runner);

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
};

const wrapRunnerEntry = (
  entry: RuntimeRunner | RuntimeRunnerFactory
): RuntimeRunner | RuntimeRunnerFactory => {
  if (isKrakenRunnerFactory(entry)) {
    return {
      create() {
        return wrapRunner(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapRunner(entry);
};

const createRunnerRegistry = (
  runners: (RuntimeRunner | RuntimeRunnerFactory)[] = []
) => createBaseRunnerRegistry(runners.map(wrapRunnerEntry));

const signalWithAdmissionKey = (
  text: string,
  admissionKey: unknown
): InputSignal => {
  const signal = textSignal(text);
  Object.defineProperty(signal, "admissionKey", { value: admissionKey });
  return signal;
};

const malformedPartsSignal = (): InputSignal => {
  const signal = textSignal("invalid");
  Object.defineProperty(signal, "parts", { value: [123] });
  return signal;
};

const malformedAssistantMessage = (): TuvrenMessage => {
  const message = assistantText("invalid");
  Object.defineProperty(message, "parts", { value: [123] });
  return message;
};
describe("framework-runtime-core", () => {
  test("rejects malformed initial input signals before staging branch history", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      execute: fromSynchronousVariadicAwaited((_context) => ({
        messages: [assistantText("This should not run.")],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      })),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});

    expect(() =>
      runtime.executeTurn({
        branchId: thread.branchId,
        config: { name: "primary" },
        signal: malformedPartsSignal(),
        threadId: thread.threadId,
      })
    ).toThrow("request.signal must be a valid TuvrenMessage");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([]);
  });

  test("preserves the host admission key on initial input", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      execute: fromSynchronousVariadicAwaited(() => ({
        messages: [assistantText("Admission key observed.")],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      })),
      id: "fake",
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: signalWithAdmissionKey(
        "Keyed initial input",
        "  host-key-initial  "
      ),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    const [storedMessage] = await harness.readBranchMessages(thread.branchId);
    expect(storedMessage).toEqual({
      admissionKey: "  host-key-initial  ",
      parts: [{ text: "Keyed initial input", type: "text" }],
      role: "user",
    });
  });

  test("rejects empty and non-string admission keys before staging", async () => {
    await Promise.all(
      ["", 7].map(async (admissionKey) => {
        const harness = createFakeKernelHarness();
        const runtime = createTuvrenRuntime({
          defaultRunnerId: "fake",
          kernel: harness.kernel,
          runnerRegistry: createRunnerRegistry([]),
        });
        const thread = await runtime.createThread({});
        const signal = signalWithAdmissionKey(
          "Invalid keyed input",
          admissionKey
        );

        expect(() =>
          runtime.executeTurn({
            branchId: thread.branchId,
            config: { name: "primary" },
            signal,
            threadId: thread.threadId,
          })
        ).toThrow("request.signal must be a valid TuvrenMessage");
        expect(await harness.readBranchMessages(thread.branchId)).toEqual([]);
      })
    );
  });

  test("does not start a fresh handle when it is canceled before the first stream pull", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const runner = {
      execute: fromSynchronousVariadicAwaited(() => {
        executeCalls += 1;
        return {
          messages: [assistantText("This should never run.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      }),
      id: "fake",
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
      execute: fromSynchronousVariadicAwaited((_context) => ({
        messages: [malformedAssistantMessage()],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      })),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
      execute: fromSynchronousVariadicAwaited((_context) => {
        const result: RunnerExecutionResult = {
          messages: [assistantText("Invalid resolution payload.")],
          resolution: { reason: "done", type: "end_turn" },
        };
        Object.defineProperty(result, "resolution", {
          value: { bogus: true },
        });
        return result;
      }),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
      execute: fromSynchronousVariadicAwaited(() => {
        const result: RunnerExecutionResult = {
          messages: [assistantText("Bad handoff")],
          resolution: { reason: "done", type: "end_turn" },
        };
        Object.defineProperties(result, {
          activeAgent: { value: "primary" },
          resolution: {
            value: {
              contextPlan: { targetAgent: "reviewer" },
              targetAgent: "reviewer",
              type: "handoff",
            },
          },
        });
        return result;
      }),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
      execute: fromSynchronousVariadicAwaited(() => ({
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
      })),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
      execute: fromSynchronousVariadicAwaited(() => ({
        messages: [assistantText("Plain assistant output.")],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
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
      })),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
      execute: fromSynchronousVariadicAwaited((context) => ({
        messages: [assistantText("Mismatched handoff target.")],
        resolution: {
          contextPlan: context.handoff.createContextPlan({
            reason: "handoff",
            targetAgent: "worker",
          }),
          targetAgent: "reviewer",
          type: "handoff",
        },
      })),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) =>
        ({
          primary: { name: "primary" },
          reviewer: { name: "reviewer" },
          worker: { name: "worker" },
        })[agentName],
      runnerRegistry: createRunnerRegistry([runner]),
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
      execute: fromSynchronousVariadicAwaited((context) => ({
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
      })),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
      runnerRegistry: createRunnerRegistry([runner]),
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
      execute: fromSynchronousVariadicAwaited(() => ({
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
      })),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
      execute: fromSynchronousVariadicAwaited(
        () =>
          ({
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
          }) satisfies RunnerExecutionResult
      ),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
