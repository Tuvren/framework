/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { expect, test } from "bun:test";

import { TuvrenRuntimeError } from "@tuvren/core";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import { IDENTITY_PAYLOAD_CODEC } from "@tuvren/core/lifecycle";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { RuntimeRunner } from "@tuvren/core/runner";
import { decodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";

import {
  createRunnerRegistry as createBaseRunnerRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import { createFakeRunLivenessKernelHarness } from "./fake-run-liveness-kernel.ts";
import { prepareExpiredToolBatch } from "./runtime-core-cold-recovery-test-helpers.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  fromSynchronousVariadicAwaited,
  textSignal,
  toOptionalRecord,
} from "./runtime-core-test-helpers.ts";

const requireAssistantMessage = (
  message: TuvrenMessage
): Extract<TuvrenMessage, { role: "assistant" }> => {
  if (message.role !== "assistant") {
    throw new Error("expected assistant message");
  }
  return message;
};

const toolResultMessage = (callId: string, value: number): TuvrenMessage => ({
  parts: [
    {
      callId,
      name: "lookup",
      output: { value },
      type: "tool_result",
    },
  ],
  role: "tool",
});

const createRunnerRegistry = (runners: RuntimeRunner[] = []) =>
  createBaseRunnerRegistry(runners);
test("retains the original batch and missing calls after a second recovery crash", async () => {
  const assistant = requireAssistantMessage(
    assistantToolCalls([
      { callId: "done-original", input: {}, name: "lookup" },
      { callId: "fast-recovery", input: {}, name: "lookup" },
      { callId: "held-recovery", input: {}, name: "lookup" },
    ])
  );
  const fixture = await prepareExpiredToolBatch(
    "recovery_twice",
    "Recover twice",
    [assistant, toolResultMessage("done-original", 1)]
  );
  const { promise: held, resolve: releaseHeld } = Promise.withResolvers<true>();
  const { promise: entered, resolve: enteredHeld } =
    Promise.withResolvers<true>();
  const { promise: fastCompleted, resolve: markFastCompleted } =
    Promise.withResolvers<true>();
  const runner = {
    execute: fromSynchronousVariadicAwaited(() => ({
      messages: [assistantText("done")],
      resolution: { reason: "done", type: "end_turn" },
    })),
    id: "fake",
  } satisfies RuntimeRunner;
  const first = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: fixture.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "first-recovery",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const firstHandle = first.executeTurn({
    branchId: fixture.thread.branchId,
    config: {
      name: "primary",
      tools: [
        {
          description: "lookup",
          async execute(_input, context) {
            if (context.callId === "held-recovery") {
              enteredHeld(true);
              await held;
            } else if (context.callId === "fast-recovery") {
              markFastCompleted(true);
            }
            return { callId: context.callId };
          },
          inputSchema: { type: "object" },
          name: "lookup",
        },
      ],
    },
    signal: textSignal("Recover twice"),
    threadId: fixture.thread.threadId,
  });
  const firstEvents = collectEvents(firstHandle.events());
  await Promise.all([entered, fastCompleted]);

  const secondDispatches: string[] = [];
  const runnerDispatchCounts: number[] = [];
  const second = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: fixture.kernel,
    now: () => 60_000,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "second-recovery",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([
      {
        execute: fromSynchronousVariadicAwaited(() => {
          runnerDispatchCounts.push(secondDispatches.length);
          return {
            messages: [assistantText("done")],
            resolution: { reason: "done", type: "end_turn" },
          };
        }),
        id: "fake",
      },
    ]),
  });
  const secondHandle = second.executeTurn({
    branchId: fixture.thread.branchId,
    config: {
      name: "primary",
      tools: [
        {
          description: "lookup",
          execute(_input, context) {
            secondDispatches.push(context.callId);
            return {};
          },
          inputSchema: { type: "object" },
          name: "lookup",
        },
      ],
    },
    signal: textSignal("Recover twice"),
    threadId: fixture.thread.threadId,
  });
  await collectEvents(secondHandle.events());
  releaseHeld(true);
  await firstEvents;

  expect(secondHandle.status().phase).toBe("completed");
  expect(secondDispatches).toEqual(["held-recovery"]);
  expect(runnerDispatchCounts).toEqual([1]);
});

test("keeps earlier iteration count when an interrupted assistant is uncommitted", async () => {
  const assistant = requireAssistantMessage(
    assistantToolCalls([
      { callId: "uncommitted-missing", input: {}, name: "lookup" },
    ])
  );
  const fixture = await prepareExpiredToolBatch(
    "uncommitted_iteration_count",
    "Recover count",
    [assistant]
  );
  const inputBranch = await fixture.kernel.branch.get(fixture.thread.branchId);
  const inputHead = inputBranch?.headTurnNodeHash;
  const preemptExpired = fixture.kernel.runLiveness.preemptExpired.bind(
    fixture.kernel.runLiveness
  );
  fixture.kernel.runLiveness.preemptExpired = async (...args) => {
    const recoveredRun = await fixture.kernel.run.recover(args[0]);
    const recoveryState = await preemptExpired(...args);
    if (inputHead === undefined) {
      throw new Error("expected durable input checkpoint");
    }
    await fixture.kernel.branch.setHead(fixture.thread.branchId, inputHead);
    return {
      ...recoveryState,
      consumedStagedResults: [],
      lastTurnNodeHash: inputHead,
      uncommittedStagedResults: recoveredRun.uncommittedStagedResults,
    };
  };
  let runnerCalls = 0;
  const runtime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: fixture.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "count-recovery",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([
      {
        execute: fromSynchronousVariadicAwaited(() => {
          runnerCalls += 1;
          return {
            messages: [assistantText("unexpected extra iteration")],
            resolution: { reason: "done", type: "end_turn" },
          };
        }),
        id: "fake",
      },
    ]),
  });
  const handle = runtime.executeTurn({
    branchId: fixture.thread.branchId,
    config: {
      maxIterations: 1,
      name: "primary",
      tools: [
        {
          description: "lookup",
          execute() {
            return {};
          },
          inputSchema: { type: "object" },
          name: "lookup",
        },
      ],
    },
    signal: textSignal("Recover count"),
    threadId: fixture.thread.threadId,
  });
  await collectEvents(handle.events());

  expect(handle.status().phase).toBe("completed");
  expect(runnerCalls).toBe(0);
});

test("context plans persist the same uncommitted recovered message history they inspect", async () => {
  const assistant = requireAssistantMessage(
    assistantToolCalls([
      { callId: "uncommitted-completed", input: {}, name: "lookup" },
    ])
  );
  const fixture = await prepareExpiredToolBatch(
    "uncommitted_context_plan",
    "Recover context history",
    [assistant, toolResultMessage("uncommitted-completed", 1)]
  );
  const inputBranch = await fixture.kernel.branch.get(fixture.thread.branchId);
  const inputHead = inputBranch?.headTurnNodeHash;
  const preemptExpired = fixture.kernel.runLiveness.preemptExpired.bind(
    fixture.kernel.runLiveness
  );
  fixture.kernel.runLiveness.preemptExpired = async (...args) => {
    const recoveredRun = await fixture.kernel.run.recover(args[0]);
    const recoveryState = await preemptExpired(...args);
    if (inputHead === undefined) {
      throw new Error("expected durable input checkpoint");
    }
    await fixture.kernel.branch.setHead(fixture.thread.branchId, inputHead);
    return {
      ...recoveryState,
      consumedStagedResults: [],
      lastTurnNodeHash: inputHead,
      uncommittedStagedResults: recoveredRun.uncommittedStagedResults,
    };
  };
  let inspectedMessages: TuvrenMessage[] = [];
  let runnerSawRecoveredHistory = false;
  const runtime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: fixture.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "context-recovery",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([
      {
        execute: fromSynchronousVariadicAwaited(
          (context: Parameters<RuntimeRunner["execute"]>[0]) => {
            runnerSawRecoveredHistory ||= context.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some(
                  (part) =>
                    part.type === "tool_call" &&
                    part.callId === "uncommitted-completed"
                )
            );
            return {
              messages: [assistantText("context history persisted")],
              resolution: { reason: "done", type: "end_turn" },
            };
          }
        ),
        id: "fake",
      },
    ]),
  });
  const handle = runtime.executeTurn({
    branchId: fixture.thread.branchId,
    config: {
      contextPolicy: {
        evaluate() {
          return {
            action: "retain recovered history",
            execute(context) {
              if (inspectedMessages.length === 0) {
                inspectedMessages = [...context.messages];
              }
              return context.messageHashes;
            },
          };
        },
      },
      name: "primary",
    },
    signal: textSignal("Recover context history"),
    threadId: fixture.thread.threadId,
  });
  await collectEvents(handle.events());

  expect(handle.status().phase).toBe("completed");
  expect(
    inspectedMessages.some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some(
          (part) =>
            part.type === "tool_call" && part.callId === "uncommitted-completed"
        )
    )
  ).toBe(true);
  expect(runnerSawRecoveredHistory).toBe(true);
  expect(
    await fixture.harness.readBranchMessages(fixture.thread.branchId)
  ).toEqual([
    {
      parts: [{ text: "Recover context history", type: "text" }],
      role: "user",
    },
    assistant,
    toolResultMessage("uncommitted-completed", 1),
    assistantText("context history persisted"),
  ]);
});

test("keeps failed partial tool calls context-only through a crash", async () => {
  const harness = createFakeKernelHarness();
  const liveness = createFakeRunLivenessKernelHarness(harness);
  const { promise: ready, resolve: stagedReady } =
    Promise.withResolvers<true>();
  const { promise: held, resolve: releaseStage } =
    Promise.withResolvers<true>();
  const stage = liveness.kernel.staging.stage.bind(liveness.kernel.staging);
  let intercept = true;
  liveness.kernel.staging.stage = async (...args) => {
    const result = await stage(...args);
    if (intercept && args[2] === "message_1_0") {
      intercept = false;
      stagedReady(true);
      await held;
    }
    return result;
  };
  const original = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "partial-original",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([
      {
        execute: fromSynchronousVariadicAwaited(() => ({
          messages: [
            assistantToolCalls([
              { callId: "must-not-execute", input: {}, name: "charge" },
            ]),
          ],
          partial: true,
          resolution: {
            error: new TuvrenRuntimeError("partial failed", {
              code: "probe_partial_failure",
            }),
            fatality: "hard",
            type: "fail",
          },
          toolExecutionMode: "sequential",
        })),
        id: "fake",
      },
    ]),
  });
  const thread = await original.createThread({});
  const baseTool = {
    description: "charge",
    execute() {
      return {};
    },
    inputSchema: { type: "object" },
    name: "charge",
  };
  const first = original.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary", tools: [baseTool] },
    signal: textSignal("Recover failed partial"),
    threadId: thread.threadId,
  });
  const firstEvents = collectEvents(first.events());
  await ready;
  let dispatches = 0;
  const replacement = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 60_000,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "partial-replacement",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([
      {
        execute: fromSynchronousVariadicAwaited(() => ({
          messages: [assistantText("recovered")],
          resolution: { reason: "done", type: "end_turn" },
        })),
        id: "fake",
      },
    ]),
  });
  const second = replacement.executeTurn({
    branchId: thread.branchId,
    config: {
      name: "primary",
      tools: [
        {
          ...baseTool,
          execute() {
            dispatches += 1;
            return {};
          },
        },
      ],
    },
    signal: textSignal("Recover failed partial"),
    threadId: thread.threadId,
  });
  await collectEvents(second.events());
  releaseStage(true);
  await firstEvents;

  expect(second.status().phase).toBe("completed");
  expect(dispatches).toBe(0);
});

test("preserves sequential recovery mode and the first approval gate", async () => {
  const harness = createFakeKernelHarness();
  const liveness = createFakeRunLivenessKernelHarness(harness);
  const { promise: ready, resolve: stagedReady } =
    Promise.withResolvers<true>();
  const { promise: heldStage, resolve: releaseStage } =
    Promise.withResolvers<true>();
  const stage = liveness.kernel.staging.stage.bind(liveness.kernel.staging);
  let intercept = true;
  liveness.kernel.staging.stage = async (...args) => {
    const result = await stage(...args);
    if (intercept && args[2] === "message_1_0") {
      intercept = false;
      stagedReady(true);
      await heldStage;
    }
    return result;
  };
  const original = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "sequential-original",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([
      {
        execute: fromSynchronousVariadicAwaited(() => ({
          messages: [
            assistantToolCalls([
              { callId: "first-sequential", input: {}, name: "lookup" },
              { callId: "second-sequential", input: {}, name: "lookup" },
            ]),
          ],
          resolution: { type: "continue_iteration" },
          toolExecutionMode: "sequential",
        })),
        id: "fake",
      },
    ]),
  });
  const thread = await original.createThread({});
  const config = {
    maxIterations: 1,
    name: "primary",
    tools: [
      {
        description: "lookup",
        execute() {
          return {};
        },
        inputSchema: { type: "object" },
        name: "lookup",
      },
    ],
  };
  const first = original.executeTurn({
    branchId: thread.branchId,
    config,
    signal: textSignal("Recover sequential"),
    threadId: thread.threadId,
  });
  const firstEvents = collectEvents(first.events());
  await ready;
  const { promise: heldFirst, resolve: releaseFirst } =
    Promise.withResolvers<true>();
  const { promise: entered, resolve: enteredFirst } =
    Promise.withResolvers<true>();
  let secondStarted = false;
  const replacement = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 60_000,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "sequential-replacement",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([
      {
        execute: fromSynchronousVariadicAwaited(() => ({
          messages: [assistantText("done")],
          resolution: { reason: "done", type: "end_turn" },
        })),
        id: "fake",
      },
    ]),
  });
  const second = replacement.executeTurn({
    branchId: thread.branchId,
    config: {
      ...config,
      tools: [
        {
          ...config.tools[0],
          async execute(_input, context) {
            if (context.callId === "first-sequential") {
              enteredFirst(true);
              await heldFirst;
            } else {
              secondStarted = true;
            }
            return {};
          },
        },
      ],
    },
    signal: textSignal("Recover sequential"),
    threadId: thread.threadId,
  });
  const secondEvents = collectEvents(second.events());
  await entered;
  const secondStartedWhileFirstBlocked = secondStarted;
  releaseFirst(true);
  await secondEvents;
  releaseStage(true);
  await firstEvents;

  expect(secondStartedWhileFirstBlocked).toBe(false);
});

test("restores original call order after parallel results stage out of order", async () => {
  const assistant = requireAssistantMessage(
    assistantToolCalls([
      { callId: "slow-first", input: {}, name: "lookup" },
      { callId: "fast-second", input: {}, name: "lookup" },
    ])
  );
  const fixture = await prepareExpiredToolBatch(
    "parallel_recovery_order",
    "Recover order",
    [assistant, toolResultMessage("fast-second", 2)]
  );
  let observedCallIds: string[] = [];
  let afterIterationCallIds: string[] = [];
  const runtime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: fixture.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "order-recovery",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([
      {
        execute: fromSynchronousVariadicAwaited(
          (context: Parameters<RuntimeRunner["execute"]>[0]) => {
            observedCallIds = context.messages
              .filter((message) => message.role === "tool")
              .flatMap((message) =>
                message.parts.flatMap((part) =>
                  part.type === "tool_result" ? [part.callId] : []
                )
              );
            return {
              messages: [assistantText("recovered in original order")],
              resolution: { reason: "done", type: "end_turn" },
            };
          }
        ),
        id: "fake",
      },
    ]),
  });
  const handle = runtime.executeTurn({
    branchId: fixture.thread.branchId,
    config: {
      extensions: [
        {
          afterIteration(context) {
            const toolResults = context.toolResults ?? [];
            if (toolResults.length > 0) {
              afterIterationCallIds = toolResults.map(
                (result) => result.callId
              );
            }
          },
          name: "capture-finalized-tool-batch",
        },
      ],
      name: "primary",
      tools: [
        {
          description: "lookup",
          execute() {
            return { value: 1 };
          },
          inputSchema: { type: "object" },
          name: "lookup",
        },
      ],
    },
    signal: textSignal("Recover order"),
    threadId: fixture.thread.threadId,
  });
  await collectEvents(handle.events());

  expect(handle.status().phase).toBe("completed");
  expect(observedCallIds).toEqual(["slow-first", "fast-second"]);
  expect(afterIterationCallIds).toEqual(["slow-first", "fast-second"]);
  expect(
    await fixture.harness.readBranchMessages(fixture.thread.branchId)
  ).toEqual([
    { parts: [{ text: "Recover order", type: "text" }], role: "user" },
    assistant,
    toolResultMessage("slow-first", 1),
    toolResultMessage("fast-second", 2),
    assistantText("recovered in original order"),
  ]);
});

test("rebuilds the recovered manifest when one missing call is completed", async () => {
  const assistant = requireAssistantMessage(
    assistantToolCalls([
      { callId: "single-recovered", input: {}, name: "lookup" },
    ])
  );
  const fixture = await prepareExpiredToolBatch(
    "single_recovered_manifest",
    "Recover one result",
    [assistant]
  );
  const runtime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: fixture.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "single-recovery-manifest",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([
      {
        execute: fromSynchronousVariadicAwaited(() => ({
          messages: [assistantText("single recovered result")],
          resolution: { reason: "done", type: "end_turn" },
        })),
        id: "fake",
      },
    ]),
  });
  const handle = runtime.executeTurn({
    branchId: fixture.thread.branchId,
    config: {
      name: "primary",
      tools: [
        {
          description: "lookup",
          execute() {
            return { value: 1 };
          },
          inputSchema: { type: "object" },
          name: "lookup",
        },
      ],
    },
    signal: textSignal("Recover one result"),
    threadId: fixture.thread.threadId,
  });
  await collectEvents(handle.events());

  expect(handle.status().phase).toBe("completed");
  expect(handle.status().manifest?.toolResults.total).toBe(1);
});

test("approval resume keeps missing and durable results in original call order", async () => {
  const assistant = requireAssistantMessage(
    assistantToolCalls([
      { callId: "approval-first", input: {}, name: "lookup" },
      { callId: "durable-second", input: {}, name: "lookup" },
    ])
  );
  const fixture = await prepareExpiredToolBatch(
    "approval_recovery_order",
    "Resume in original order",
    [assistant, toolResultMessage("durable-second", 2)]
  );
  const runtime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: fixture.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "approval-recovery-order",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([
      {
        execute: fromSynchronousVariadicAwaited(() => ({
          messages: [assistantText("approved recovered result")],
          resolution: { reason: "done", type: "end_turn" },
        })),
        id: "fake",
      },
    ]),
  });
  const paused = runtime.executeTurn({
    branchId: fixture.thread.branchId,
    config: {
      name: "primary",
      tools: [
        {
          approval: true,
          description: "lookup",
          execute() {
            return { value: 1 };
          },
          inputSchema: { type: "object" },
          name: "lookup",
        },
      ],
    },
    signal: textSignal("Resume in original order"),
    threadId: fixture.thread.threadId,
  });
  await collectEvents(paused.events());
  expect(paused.status().phase).toBe("paused");

  const resumed = paused.resolveApproval({
    decisions: [{ callId: "approval-first", type: "approve" }],
  });
  await collectEvents(resumed.events());

  expect(resumed.status().phase).toBe("completed");
  const branchMessages = await fixture.harness.readBranchMessages(
    fixture.thread.branchId
  );
  const resultCallIds = branchMessages.flatMap((message) => {
    const messageRecord = toOptionalRecord(message);
    if (messageRecord?.role !== "tool" || !Array.isArray(messageRecord.parts)) {
      return [];
    }
    return messageRecord.parts.flatMap((part) => {
      const partRecord = toOptionalRecord(part);
      return typeof partRecord?.callId === "string" ? [partRecord.callId] : [];
    });
  });
  expect(resultCallIds).toEqual(["approval-first", "durable-second"]);
});

test("recovers aroundTool state before accepting its durable tool result", async () => {
  const harness = createFakeKernelHarness();
  const liveness = createFakeRunLivenessKernelHarness(harness);
  const { promise: ready, resolve: resultStaged } =
    Promise.withResolvers<true>();
  const { promise: held, resolve: releaseStage } =
    Promise.withResolvers<true>();
  const stage = liveness.kernel.staging.stage.bind(liveness.kernel.staging);
  let intercept = true;
  liveness.kernel.staging.stage = async (...args) => {
    const result = await stage(...args);
    if (intercept && args[2] === "tool_result_0_stateful-call") {
      intercept = false;
      resultStaged(true);
      await held;
    }
    return result;
  };
  const runner = {
    execute: fromSynchronousVariadicAwaited(
      (context: Parameters<RuntimeRunner["execute"]>[0]) => {
        if (context.messages.some((message) => message.role === "tool")) {
          return {
            messages: [assistantText("state recovered")],
            resolution: { reason: "done", type: "end_turn" },
          };
        }
        return {
          messages: [
            assistantToolCalls([
              { callId: "stateful-call", input: {}, name: "lookup" },
            ]),
          ],
          resolution: { type: "continue_iteration" },
          toolExecutionMode: "parallel",
        };
      }
    ),
    id: "fake",
  } satisfies RuntimeRunner;
  let sideEffectCalls = 0;
  const extension = {
    async aroundTool(_context, next) {
      return await next().then((result) => ({
        result,
        state: { completedCall: "stateful-call" },
      }));
    },
    name: "__tuvren_interrupted_tool_batch",
  } satisfies TuvrenExtension;
  const firstRuntime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "state-original",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await firstRuntime.createThread({});
  const config = {
    extensions: [extension],
    name: "primary",
    tools: [
      {
        description: "lookup",
        execute() {
          sideEffectCalls += 1;
          return {};
        },
        inputSchema: { type: "object" },
        name: "lookup",
      },
    ],
  };
  const first = firstRuntime.executeTurn({
    branchId: thread.branchId,
    config,
    signal: textSignal("Recover state"),
    threadId: thread.threadId,
  });
  const firstEvents = collectEvents(first.events());
  await ready;

  const replacement = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 60_000,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "state-replacement",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const second = replacement.executeTurn({
    branchId: thread.branchId,
    config,
    signal: textSignal("Recover state"),
    threadId: thread.threadId,
  });
  await collectEvents(second.events());
  const stateAtRecovery = second.status().manifest?.extensions ?? {};
  releaseStage(true);
  await firstEvents;

  const treeManifest = await harness.readBranchManifest(thread.branchId);
  const contextManifestHash = treeManifest["context.manifest"];
  if (typeof contextManifestHash !== "string") {
    throw new TypeError("expected recovered context manifest");
  }
  const contextManifestPayload =
    await liveness.kernel.store.get(contextManifestHash);
  if (contextManifestPayload === null) {
    throw new Error("expected context manifest payload");
  }
  const manifest = decodeDeterministicKernelRecord(contextManifestPayload);
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new Error("expected decoded context manifest record");
  }
  expect(second.status().phase).toBe("completed");
  expect(stateAtRecovery).toMatchObject({
    __tuvren_interrupted_tool_batch: { completedCall: "stateful-call" },
  });
  expect(sideEffectCalls).toBe(1);
  expect(toOptionalRecord(manifest)?.extensions).toMatchObject({
    __tuvren_interrupted_tool_batch: {
      completedCall: "stateful-call",
    },
  });
});
