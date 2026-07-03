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

// biome-ignore-all lint/suspicious/useAwait: Test drivers intentionally match the async framework driver contract.
import { describe, expect, test } from "bun:test";
import type { AgentConfig, HandoffSourceContext } from "@tuvren/core/execution";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import type {
  RuntimeRunner as KrakenRunner,
  RuntimeRunnerFactory as KrakenRunnerFactory,
  RunnerExecutionResult,
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
  test("lets drivers build valid handoff plans through RunnerExecutionContext.handoff", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [
                  assistantText("Passing this through the driver helper."),
                ],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    reason: "driver_helper_handoff",
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
        } satisfies KrakenRunner,
      ]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) =>
        agentName === "reviewer" ? { name: "reviewer" } : undefined,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Use the driver handoff helper"),
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

  test("driver helper handoff plans accept provider-backed agent configs with extra provider state", async () => {
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
      driverRegistry: createRunnerRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [
                  assistantText("Passing this through the driver helper."),
                ],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    reason: "driver_helper_handoff",
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
        } satisfies KrakenRunner,
      ]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Use the provider-backed driver handoff helper"),
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

  test("driver helper handoff plans use the latest source context at apply time", async () => {
    const harness = createFakeKernelHarness();
    let capturedSourceContext: HandoffSourceContext | undefined;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [
                  assistantText("Passing this through the driver helper."),
                ],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    builder: (sourceContext) => {
                      capturedSourceContext = sourceContext;
                      return createPreserveTraceHandoffContextBuilder()(
                        sourceContext
                      );
                    },
                    reason: "driver_helper_handoff",
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
        } satisfies KrakenRunner,
      ]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) =>
        agentName === "reviewer" ? { name: "reviewer" } : undefined,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Use the driver handoff helper"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capturedSourceContext?.messages).toEqual([
      {
        parts: [{ text: "Use the driver handoff helper", type: "text" }],
        role: "user",
      },
      {
        parts: [
          { text: "Passing this through the driver helper.", type: "text" },
        ],
        role: "assistant",
      },
    ]);
    expect(capturedSourceContext?.manifest.messageCount).toBe(2);
    expect(capturedSourceContext?.manifest.lastAssistantMessageIndex).toBe(1);
  });

  test("driver helper last_output_only handoffs forward the just-produced assistant output", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([
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
        } satisfies KrakenRunner,
      ]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) =>
        agentName === "reviewer" ? { name: "reviewer" } : undefined,
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
              return undefined;
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
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([handoffRunner]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
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
  drivers: Array<KrakenRunner | KrakenRunnerFactory> = []
) {
  return createBaseRunnerRegistry(drivers.map(wrapRunnerEntry));
}

function wrapRunnerEntry(
  entry: KrakenRunner | KrakenRunnerFactory
): KrakenRunner | KrakenRunnerFactory {
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
  entry: KrakenRunner | KrakenRunnerFactory
): entry is KrakenRunnerFactory {
  return "create" in entry && typeof entry.create === "function";
}

function wrapRunner(driver: KrakenRunner): KrakenRunner {
  const resume = driver.resume;

  return {
    async execute(context) {
      return normalizeRunnerResult(await driver.execute(context));
    },
    id: driver.id,
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
