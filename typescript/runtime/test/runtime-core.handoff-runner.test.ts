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

import type { HashString } from "@tuvren/core";
import type {
  AgentConfig,
  HandoffContextPlan,
  HandoffSourceContext,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
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
  readBranchCheckpointEventTypes,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("projects admission keys from direct, handoff, and helper runner messages", async () => {
    const harness = createFakeKernelHarness();
    let runtime: ReturnType<typeof createTuvrenRuntime> | undefined;
    let threadId: string | undefined;
    let directMessages: readonly TuvrenMessage[] | undefined;
    let handoffPlan: HandoffContextPlan | undefined;
    let helperMessage: TuvrenMessage | null | undefined;
    let handoffBuilderMessages: readonly TuvrenMessage[] | undefined;
    let handoffBuilderHelperMessage: TuvrenMessage | null | undefined;
    let initialMessageHash: HashString | undefined;
    const runner = {
      async execute(context) {
        if (context.config.name === "primary") {
          directMessages = context.messages;
          if (runtime === undefined) {
            throw new Error("runtime was not initialized");
          }
          if (threadId === undefined) {
            throw new Error("thread was not initialized");
          }
          const snapshot = await runtime.getTurnState({
            branchId: context.branchId,
            threadId,
          });
          const messageHashes = snapshot.paths.messages;
          initialMessageHash = messageHashes?.[0];
          if (initialMessageHash === undefined) {
            throw new Error("expected the initial input message hash");
          }
          handoffPlan = context.handoff.createContextPlan({
            builder(sourceContext) {
              if (initialMessageHash === undefined) {
                throw new Error("expected the initial input message hash");
              }
              handoffBuilderMessages = sourceContext.messages;
              handoffBuilderHelperMessage =
                sourceContext.helpers.loadMessage(initialMessageHash);
              return [initialMessageHash];
            },
            reason: "admission-key-projection",
            targetAgent: "reviewer",
          });
          helperMessage =
            handoffPlan.sourceContext.helpers.loadMessage(initialMessageHash);
          return {
            messages: [assistantText("Processed the keyed input.")],
            resolution: {
              contextPlan: handoffPlan,
              targetAgent: "reviewer",
              type: "handoff",
            },
          };
        }

        return {
          messages: [assistantText("Reviewer completed keyed input.")],
          resolution: { reason: "done", type: "end_turn" },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies RuntimeRunner;
    runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) =>
        agentName === "reviewer" ? { name: "reviewer" } : undefined,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    threadId = thread.threadId;
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: {
        admissionKey: "runner-handoff-key",
        parts: [{ text: "Keep this keyed through handoff", type: "text" }],
      },
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(directMessages).toEqual([
      {
        parts: [{ text: "Keep this keyed through handoff", type: "text" }],
        role: "user",
      },
    ]);
    expect(handoffPlan?.sourceContext.messages).toEqual([
      {
        parts: [{ text: "Keep this keyed through handoff", type: "text" }],
        role: "user",
      },
    ]);
    expect(helperMessage).toEqual({
      parts: [{ text: "Keep this keyed through handoff", type: "text" }],
      role: "user",
    });
    expect(handoffBuilderMessages).toEqual([
      {
        parts: [{ text: "Keep this keyed through handoff", type: "text" }],
        role: "user",
      },
      assistantText("Processed the keyed input."),
    ]);
    expect(handoffBuilderHelperMessage).toEqual({
      parts: [{ text: "Keep this keyed through handoff", type: "text" }],
      role: "user",
    });
    if (runtime === undefined || initialMessageHash === undefined) {
      throw new Error("expected the runtime and initial message hash");
    }
    const finalTurnState = await runtime.getTurnState({
      branchId: thread.branchId,
      threadId: thread.threadId,
    });
    expect(finalTurnState.paths.messages).toContain(initialMessageHash);
    expect(
      (await runtime.readBranchMessages({ branchId: thread.branchId })).messages
    ).toContainEqual({
      admissionKey: "runner-handoff-key",
      parts: [{ text: "Keep this keyed through handoff", type: "text" }],
      role: "user",
    });
  });

  test("lets runners build valid handoff plans through RunnerExecutionContext.handoff", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) =>
        agentName === "reviewer" ? { name: "reviewer" } : undefined,
      runnerRegistry: createRunnerRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [
                  assistantText("Passing this through the runner helper."),
                ],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    reason: "runner_helper_handoff",
                    targetAgent: "reviewer",
                  }),
                  targetAgent: "reviewer",
                  type: "handoff",
                },
              };
            }

            return {
              messages: [assistantText("Runner helper handoff completed.")],
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
        } satisfies RuntimeRunner,
      ]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Use the runner handoff helper"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().activeAgent).toBe("reviewer");
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Runner helper handoff completed."
      )
    ).toBe(true);
    expect(
      await readBranchCheckpointEventTypes(harness.kernel, thread.branchId)
    ).toEqual(expect.arrayContaining(["handoff_applied"]));
  });

  test("runner helper handoff plans accept provider-backed agent configs with extra provider state", async () => {
    const harness = createFakeKernelHarness();
    const primaryProvider = {
      extra: true,
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "unused primary provider output", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "primary-provider",
      async *stream() {
        yield* [];
      },
    };
    const reviewerProvider = {
      extra: true,
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "unused reviewer provider output", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "reviewer-provider",
      async *stream() {
        yield* [];
      },
    };
    const agents: Record<string, AgentConfig> = {
      primary: {
        model: primaryProvider,
        name: "primary",
      },
      reviewer: {
        model: reviewerProvider,
        name: "reviewer",
      },
    };
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
      runnerRegistry: createRunnerRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [
                  assistantText("Passing this through the runner helper."),
                ],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    reason: "runner_helper_handoff",
                    targetAgent: "reviewer",
                  }),
                  targetAgent: "reviewer",
                  type: "handoff",
                },
              };
            }

            return {
              messages: [
                assistantText("Provider-backed helper handoff completed."),
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
        } satisfies RuntimeRunner,
      ]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Use the provider-backed runner handoff helper"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().activeAgent).toBe("reviewer");
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Provider-backed helper handoff completed."
      )
    ).toBe(true);
  });

  test("runner helper handoff plans use the latest source context at apply time", async () => {
    const harness = createFakeKernelHarness();
    let capturedSourceContext: HandoffSourceContext | undefined;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) =>
        agentName === "reviewer" ? { name: "reviewer" } : undefined,
      runnerRegistry: createRunnerRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [
                  assistantText("Passing this through the runner helper."),
                ],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    builder: (sourceContext) => {
                      capturedSourceContext = sourceContext;
                      return createPreserveTraceHandoffContextBuilder()(
                        sourceContext
                      );
                    },
                    reason: "runner_helper_handoff",
                    targetAgent: "reviewer",
                  }),
                  targetAgent: "reviewer",
                  type: "handoff",
                },
              };
            }

            return {
              messages: [assistantText("Reviewer complete.")],
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
        } satisfies RuntimeRunner,
      ]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Use the runner handoff helper"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capturedSourceContext?.messages).toEqual([
      {
        parts: [{ text: "Use the runner handoff helper", type: "text" }],
        role: "user",
      },
      {
        parts: [
          { text: "Passing this through the runner helper.", type: "text" },
        ],
        role: "assistant",
      },
    ]);
    expect(capturedSourceContext?.manifest.messageCount).toBe(2);
    expect(capturedSourceContext?.manifest.lastAssistantMessageIndex).toBe(1);
  });

  test("runner helper last_output_only handoffs forward the just-produced assistant output", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) =>
        agentName === "reviewer" ? { name: "reviewer" } : undefined,
      runnerRegistry: createRunnerRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [
                  assistantText(
                    "Passing this through the last_output_only helper."
                  ),
                ],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    mode: "last_output_only",
                    reason: "delegate",
                    targetAgent: "reviewer",
                  }),
                  targetAgent: "reviewer",
                  type: "handoff",
                },
              };
            }

            return {
              messages: [
                assistantText("Reviewer completed the pipeline step."),
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
        } satisfies RuntimeRunner,
      ]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Start the pipeline"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [
          {
            text: "Passing this through the last_output_only helper.",
            type: "text",
          },
        ],
        role: "user",
      },
      {
        parts: [
          {
            text: "Reviewer completed the pipeline step.",
            type: "text",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("seeds target extension state during handoff before the next iteration hooks run", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: {
        extensions: [
          {
            beforeIteration(context) {
              context.emit({
                data: context.extensionState,
                name: "reviewer.state",
              });
              return;
            },
            name: "reviewer-state",
            state: {
              enabled: true,
            },
          },
        ],
        name: "reviewer",
      },
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
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
      runnerRegistry: createRunnerRegistry([handoffRunner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start seeded handoff"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const reviewerStateEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "custom" }> =>
        event.type === "custom" && event.name === "reviewer.state"
    );

    expect(reviewerStateEvent?.data).toEqual({
      enabled: true,
    });
    expect(handle.status().manifest?.extensions["reviewer-state"]).toEqual({
      enabled: true,
    });
  });
});

function createRunnerRegistry(
  runners: (RuntimeRunner | RuntimeRunnerFactory)[] = []
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
  const { resume } = runner;

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
