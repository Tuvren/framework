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

import type {
  AroundToolContext,
  AroundToolResult,
  TuvrenExtension,
} from "@tuvren/core/extensions";
import type { ToolResultPart } from "@tuvren/core/messages";
import type {
  RunnerExecutionResult,
  RuntimeRunner,
  RuntimeRunnerFactory,
} from "@tuvren/core/runner";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";

import {
  createRunnerRegistry as createBaseRunnerRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  delay,
  extractToolMessages,
  hasAssistantText,
  readQueryInput,
  textSignal,
  toOptionalRecord,
} from "./runtime-core-test-helpers.ts";

interface TestRuntimeRunner {
  execute: (
    context: Parameters<RuntimeRunner["execute"]>[0]
  ) => RunnerExecutionResult | Promise<RunnerExecutionResult>;
  id: string;
  resume?: (
    context: Parameters<NonNullable<RuntimeRunner["resume"]>>[0]
  ) => RunnerExecutionResult | Promise<RunnerExecutionResult>;
}

const isKrakenRunnerFactory = (
  entry: TestRuntimeRunner | RuntimeRunnerFactory
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

const wrapRunner = (runner: TestRuntimeRunner): RuntimeRunner => {
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
};

const wrapRunnerEntry = (
  entry: TestRuntimeRunner | RuntimeRunnerFactory
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
  runners: (TestRuntimeRunner | RuntimeRunnerFactory)[] = []
) => createBaseRunnerRegistry(runners.map(wrapRunnerEntry));
describe("framework-runtime-core", () => {
  test("preserves receiver context for function and object-form aroundTool handlers", async () => {
    interface MethodAroundToolExtension extends TuvrenExtension {
      aroundTool: (
        context: AroundToolContext,
        next: (context?: AroundToolContext) => Promise<ToolResultPart>
      ) => Promise<AroundToolResult> | AroundToolResult;
      aroundToolCalls: number;
      label: string;
    }

    interface AroundToolSpecReceiver {
      calls: number;
      handler: (
        context: AroundToolContext,
        next: (context?: AroundToolContext) => Promise<ToolResultPart>
      ) => Promise<AroundToolResult> | AroundToolResult;
      label: string;
      tools: string[];
    }

    const harness = createFakeKernelHarness();
    const originalMetadata = {
      channel: "primary",
    };
    let sameAroundToolRef = false;
    let sameAroundMetadataRef = false;
    let sameExecuteMetadataRef = false;
    const methodExtension: MethodAroundToolExtension = {
      async aroundTool(_context, next) {
        this.aroundToolCalls += 1;

        if (this.label !== "method" || this.aroundToolCalls !== 1) {
          throw new Error("lost function-form aroundTool receiver");
        }

        return await next();
      },
      aroundToolCalls: 0,
      label: "method",
      name: "method-around-tool",
    };
    const aroundToolSpec: AroundToolSpecReceiver = {
      calls: 0,
      async handler(context, next) {
        this.calls += 1;

        if (
          this.label !== "spec" ||
          this.calls !== 1 ||
          !this.tools.includes(context.tool.name)
        ) {
          throw new Error("lost object-form aroundTool receiver");
        }

        return await next();
      },
      label: "spec",
      tools: ["email"],
    };
    const specExtension: TuvrenExtension = {
      aroundTool: aroundToolSpec,
      name: "spec-around-tool",
    };
    const originalTool: TuvrenToolDefinition = {
      description: "Send email",
      execute(_input, context) {
        sameExecuteMetadataRef = context.metadata === originalMetadata;

        if (
          context.metadata !== undefined &&
          typeof context.metadata === "object" &&
          !Array.isArray(context.metadata)
        ) {
          context.metadata.channel = "mutated-in-execute";
        }

        return { sent: true };
      },
      inputSchema: {
        properties: {
          subject: { type: "string" },
          to: { type: "string" },
        },
        required: ["to", "subject"],
        type: "object",
      },
      metadata: originalMetadata,
      name: "email",
    };
    methodExtension.aroundTool = async function aroundTool(context, next) {
      this.aroundToolCalls += 1;
      sameAroundToolRef = context.tool === originalTool;
      sameAroundMetadataRef = context.tool.metadata === originalMetadata;

      if (
        context.tool.metadata !== undefined &&
        typeof context.tool.metadata === "object" &&
        !Array.isArray(context.tool.metadata)
      ) {
        context.tool.metadata.channel = "mutated-in-around";
      }

      if (this.label !== "method" || this.aroundToolCalls !== 1) {
        throw new Error("lost function-form aroundTool receiver");
      }

      return await next();
    };
    const runner = {
      execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: {
                    subject: "Receiver binding",
                    to: "ops@example.com",
                  },
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
            toolExecutionMode: "parallel",
          };
        }

        const receiverLost = toolMessages.some((message) =>
          message.parts.some((part) => part.isError === true)
        );

        return {
          messages: [
            assistantText(
              receiverLost
                ? "aroundTool receivers lost."
                : "aroundTool receivers preserved."
            ),
          ],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [methodExtension, specExtension],
        name: "primary",
        tools: [originalTool],
      },
      signal: textSignal("Exercise aroundTool receivers"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "aroundTool receivers preserved."
      )
    ).toBe(true);
    expect(sameAroundToolRef).toBe(false);
    expect(sameAroundMetadataRef).toBe(false);
    expect(sameExecuteMetadataRef).toBe(false);
    expect(originalMetadata.channel).toBe("primary");
  });

  test("keeps later resumed tool results when an earlier resumed call pauses again", async () => {
    const harness = createFakeKernelHarness();
    let searchCalls = 0;
    const runner = {
      execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-review",
                  input: { item: "proposal" },
                  name: "review",
                },
                {
                  callId: "call-search",
                  input: { query: "follow-up" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Waiting for the remaining approval.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async aroundTool(context, next) {
              if (
                context.tool.name === "review" &&
                context.approvalDecision?.type === "approve"
              ) {
                return {
                  approval: {
                    completedResults: [],
                    toolCalls: [
                      {
                        callId: context.callId,
                        decisions: ["approve", "reject"],
                        input: context.input,
                        message: "Need a second approval for review.",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return await next();
            },
            name: "review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Review a proposal",
            execute() {
              return {
                reviewed: true,
              };
            },
            inputSchema: {
              properties: {
                item: { type: "string" },
              },
              required: ["item"],
              type: "object",
            },
            name: "review",
          },
          {
            approval: true,
            description: "Run a follow-up search",
            execute(input: unknown) {
              searchCalls += 1;
              return {
                query: readQueryInput(input),
                status: "ok",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Resume both tools"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-review", type: "approve" },
        { callId: "call-search", type: "approve" },
      ],
    });

    await collectEvents(resumedHandle.events());

    expect(searchCalls).toBe(1);
    expect(resumedHandle.status().phase).toBe("paused");
    expect(resumedHandle.status().approval?.completedResults).toHaveLength(1);
    expect(resumedHandle.status().manifest?.toolResults.total).toBe(1);
  });

  test("rejects aroundTool pauses returned after next()", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const runner = {
      execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "run once" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Tool completed once.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async aroundTool(context, next) {
              const invokeNext = next;
              await invokeNext();
              return {
                approval: {
                  completedResults: [],
                  toolCalls: [
                    {
                      callId: context.callId,
                      decisions: ["approve"],
                      input: context.input,
                      message: "This pause should be ignored.",
                      name: context.tool.name,
                    },
                  ],
                },
                state: {
                  attemptedPauseAfterNext: true,
                },
                verdict: "pause",
              };
            },
            name: "late-pause",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search once",
            execute(input: unknown) {
              executeCalls += 1;
              return {
                query: readQueryInput(input),
                status: "ok",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Late pause"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(executeCalls).toBe(1);
    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false
    );
    expect(events.some((event) => event.type === "tool.result")).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Late pause", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("surfaces after-next aroundTool errors without discarding the executed result", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "preserve result" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("After-next error was surfaced.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async aroundTool(_context, next) {
              const invokeNext = next;
              await invokeNext();
              await delay(1);
              throw new Error("aroundTool exploded after next");
            },
            name: "post-next-error",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search successfully",
            execute(input: unknown) {
              return {
                query: readQueryInput(input),
                status: "ok",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Surface after-next error"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );
    const toolMessages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(handle.status().phase).toBe("completed");
    expect(errorEvent?.fatal).toBe(false);
    expect(errorEvent?.error.message).toBe("aroundTool exploded after next");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.parts[0]).toEqual({
      callId: "call-search",
      name: "search",
      output: {
        query: "preserve result",
        status: "ok",
      },
      type: "tool_result",
    });
  });

  test("isolates aroundTool manifest state and shared exports between extensions", async () => {
    const harness = createFakeKernelHarness();
    let observedState:
      | {
          extensionState: Record<string, unknown>;
          manifestState: Record<string, unknown> | undefined;
          sharedExports: Record<string, unknown> | undefined;
        }
      | undefined;
    const runner = {
      execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "isolate state" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("AroundTool contexts stayed isolated.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async aroundTool(context, next) {
              if (
                context.manifest.extensions.b !== null &&
                typeof context.manifest.extensions.b === "object" &&
                !Array.isArray(context.manifest.extensions.b)
              ) {
                Reflect.set(context.manifest.extensions.b, "leaked", true);
              }

              if (context.sharedExports.b !== undefined) {
                context.sharedExports.b.leaked = true;
              }

              return await next();
            },
            name: "a",
            state: {
              shared: "alpha",
            },
          },
          {
            async aroundTool(context, next) {
              observedState = {
                extensionState: globalThis.structuredClone(
                  context.extensionState
                ),
                manifestState: toOptionalRecord(context.manifest.extensions.b),
                sharedExports: toOptionalRecord(context.sharedExports.b),
              };
              return await next();
            },
            exports: ["shared"],
            name: "b",
            state: {
              shared: "beta",
            },
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search successfully",
            execute(input: unknown) {
              return {
                query: readQueryInput(input),
                status: "ok",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Isolate aroundTool state"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(observedState).toEqual({
      extensionState: {
        shared: "beta",
      },
      manifestState: {
        shared: "beta",
      },
      sharedExports: {
        shared: "beta",
      },
    });
  });
});
