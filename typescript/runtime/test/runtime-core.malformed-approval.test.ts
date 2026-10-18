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
import { setTimeout as sleep } from "node:timers/promises";

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
  delay,
  extractToolMessages,
  readQueryInput,
  settleWithin,
  TIMEOUT_TOKEN,
  textSignal,
} from "./runtime-core-test-helpers.ts";

const waitForSearchCompletion = async (
  signal: AbortSignal | undefined
): Promise<void> => {
  if (signal === undefined) {
    await sleep(40);
    return;
  }

  try {
    await sleep(40, undefined, { signal });
  } catch (error: unknown) {
    if (signal.aborted) {
      throw new Error("search aborted", { cause: error });
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("search timer failed", { cause: error });
  }
};

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
  test("rejects malformed aroundTool approval requests before pause state is published", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "invalid approval" },
                name: "search",
              },
            ]),
          ],
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
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            aroundTool(context) {
              return {
                approval: {
                  completedResults: [
                    {
                      callId: context.callId,
                      name: context.tool.name,
                      output: { duplicate: true },
                      type: "tool_result",
                    },
                  ],
                  toolCalls: [
                    {
                      callId: context.callId,
                      decisions: ["approve"],
                      input: context.input,
                      message: "Duplicate call id should be rejected.",
                      name: context.tool.name,
                    },
                  ],
                },
                verdict: "pause",
              };
            },
            name: "broken-approval",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search once",
            execute() {
              return {
                ok: true,
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
      signal: textSignal("Reject invalid approval request"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false
    );
  });

  test("does not hang mixed batches when malformed approvals race immediate tool errors", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-missing",
                input: { query: "missing" },
                name: "missing",
              },
              {
                callId: "call-review",
                input: { item: "mixed" },
                name: "review",
              },
            ]),
          ],
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
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            aroundTool(context) {
              if (context.tool.name !== "review") {
                throw new Error("unexpected tool");
              }

              return {
                approval: {
                  completedResults: [
                    {
                      callId: context.callId,
                      name: context.tool.name,
                      output: { duplicate: true },
                      type: "tool_result",
                    },
                  ],
                  toolCalls: [
                    {
                      callId: context.callId,
                      decisions: ["approve"],
                      input: context.input,
                      message: "broken mixed approval",
                      name: context.tool.name,
                    },
                  ],
                },
                verdict: "pause",
              };
            },
            name: "broken-mixed-approval",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Review docs",
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
        ],
      },
      signal: textSignal("Break the mixed approval batch"),
      threadId: thread.threadId,
    });

    const events = await settleWithin(collectEvents(handle.events()), 100);

    expect(events).not.toBe(TIMEOUT_TOKEN);

    if (events === TIMEOUT_TOKEN) {
      throw new Error("expected malformed mixed approval batch to terminate");
    }

    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
  });

  test("aborts cooperative sibling tools without checkpointing malformed initial approval batches", async () => {
    const harness = createFakeKernelHarness();
    let searchSideEffectCount = 0;
    const runner = {
      execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "abort me" },
                name: "search",
              },
              {
                callId: "call-review",
                input: { item: "abort me" },
                name: "review",
              },
            ]),
          ],
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
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async aroundTool(context, next) {
              if (context.tool.name === "review") {
                return {
                  approval: {
                    completedResults: [
                      {
                        callId: context.callId,
                        name: context.tool.name,
                        output: { duplicate: true },
                        type: "tool_result",
                      },
                    ],
                    toolCalls: [
                      {
                        callId: context.callId,
                        decisions: ["approve"],
                        input: context.input,
                        message: "broken initial approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return await next();
            },
            name: "broken-initial-review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search docs slowly",
            async execute(_input, context) {
              await waitForSearchCompletion(context.signal);
              searchSideEffectCount += 1;
              return {
                ok: true,
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
          {
            description: "Review docs",
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
        ],
      },
      signal: textSignal("Continue sibling tools on malformed approval"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    await delay(60);

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(searchSideEffectCount).toBe(0);
    expect(
      extractToolMessages(await harness.readBranchMessages(thread.branchId))
    ).toHaveLength(0);
  });

  test("waits for non-cooperative sibling tools to settle before surfacing malformed initial approval failures", async () => {
    const harness = createFakeKernelHarness();
    let slowSideEffectCount = 0;
    const runner = {
      execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "slow side effect" },
                name: "search",
              },
              {
                callId: "call-review",
                input: { item: "broken approval" },
                name: "review",
              },
            ]),
          ],
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
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async aroundTool(context, next) {
              if (context.tool.name === "review") {
                return {
                  approval: {
                    completedResults: [
                      {
                        callId: context.callId,
                        name: context.tool.name,
                        output: { duplicate: true },
                        type: "tool_result",
                      },
                    ],
                    toolCalls: [
                      {
                        callId: context.callId,
                        decisions: ["approve"],
                        input: context.input,
                        message: "broken initial approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return await next();
            },
            name: "broken-initial-review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Ignore abort and finish later",
            async execute() {
              await delay(40);
              slowSideEffectCount += 1;
              return {
                ok: true,
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
          {
            description: "Review docs",
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
        ],
      },
      signal: textSignal("Wait for the slow sibling"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(slowSideEffectCount).toBe(1);
    expect(
      extractToolMessages(await harness.readBranchMessages(thread.branchId))
    ).toHaveLength(0);
  });

  test("does not checkpoint resumed sibling tool progress when resume approval is malformed", async () => {
    const harness = createFakeKernelHarness();
    let searchCalls = 0;
    const runner = {
      execute(context) {
        const toolMessages = extractToolMessages(context.messages);

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "resume batch" },
                  name: "search",
                },
                {
                  callId: "call-review",
                  input: { item: "resume batch" },
                  name: "review",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("This should not be reached.")],
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
                    completedResults: [
                      {
                        callId: context.callId,
                        name: context.tool.name,
                        output: { duplicate: true },
                        type: "tool_result",
                      },
                    ],
                    toolCalls: [
                      {
                        callId: context.callId,
                        decisions: ["approve", "reject"],
                        input: context.input,
                        message: "broken resume approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return await next();
            },
            name: "broken-resume-review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Search docs",
            execute(input: unknown) {
              searchCalls += 1;
              return {
                query: readQueryInput(input),
                result: "ok",
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
          {
            approval: true,
            description: "Review docs",
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
        ],
      },
      signal: textSignal("Break the resumed approval batch"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-search", type: "approve" },
        { callId: "call-review", type: "approve" },
      ],
    });
    const events = await collectEvents(resumedHandle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(searchCalls).toBe(1);
    expect(resumedHandle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Break the resumed approval batch", type: "text" }],
        role: "user",
      },
      {
        parts: [
          {
            callId: "call-search",
            input: { query: "resume batch" },
            name: "search",
            type: "tool_call",
          },
          {
            callId: "call-review",
            input: { item: "resume batch" },
            name: "review",
            type: "tool_call",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("aborts cooperative resumed sibling tools without checkpointing malformed approvals", async () => {
    const harness = createFakeKernelHarness();
    let searchSideEffectCount = 0;
    const runner = {
      execute(context) {
        const toolMessages = extractToolMessages(context.messages);

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "resume abort" },
                  name: "search",
                },
                {
                  callId: "call-review",
                  input: { item: "resume abort" },
                  name: "review",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("This should not be reached.")],
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
                    completedResults: [
                      {
                        callId: context.callId,
                        name: context.tool.name,
                        output: { duplicate: true },
                        type: "tool_result",
                      },
                    ],
                    toolCalls: [
                      {
                        callId: context.callId,
                        decisions: ["approve", "reject"],
                        input: context.input,
                        message: "broken resume approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return await next();
            },
            name: "broken-resume-review-abort-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Search docs slowly",
            async execute(_input, context) {
              await waitForSearchCompletion(context.signal);
              searchSideEffectCount += 1;
              return {
                ok: true,
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
          {
            approval: true,
            description: "Review docs",
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
        ],
      },
      signal: textSignal(
        "Continue resumed sibling tools on malformed approval"
      ),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-search", type: "approve" },
        { callId: "call-review", type: "approve" },
      ],
    });
    await collectEvents(resumedHandle.events());

    await delay(60);

    expect(resumedHandle.status().phase).toBe("failed");
    expect(searchSideEffectCount).toBe(0);
    expect(
      extractToolMessages(await harness.readBranchMessages(thread.branchId))
    ).toHaveLength(0);
  });
});
