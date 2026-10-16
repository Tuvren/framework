/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// biome-ignore-all lint/suspicious/useAwait: Test runners intentionally match the async framework runner contract.
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
import {
  createFakeKernelHarness,
  createFakeRunLivenessKernelHarness,
} from "./fake-kernel.ts";
import { prepareExpiredToolBatch } from "./runtime-core-cold-recovery-test-helpers.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  textSignal,
  toOptionalRecord,
} from "./runtime-core-test-helpers.ts";

function requireAssistantMessage(
  message: TuvrenMessage
): Extract<TuvrenMessage, { role: "assistant" }> {
  if (message.role !== "assistant") {
    throw new Error("expected assistant message");
  }
  return message;
}

function toolResultMessage(callId: string, value: number): TuvrenMessage {
  return {
    parts: [
      {
        callId,
        name: "lookup",
        output: { value },
        type: "tool_result",
      },
    ],
    role: "tool",
  };
}

function createRunnerRegistry(runners: RuntimeRunner[] = []) {
  return createBaseRunnerRegistry(runners);
}

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
  let releaseHeld: (() => void) | undefined;
  let enteredHeld: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredHeld = resolve;
  });
  const runner = {
    id: "fake",
    async execute() {
      return {
        messages: [assistantText("done")],
        resolution: { reason: "done", type: "end_turn" },
      };
    },
  } satisfies RuntimeRunner;
  const first = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: fixture.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runnerRegistry: createRunnerRegistry([runner]),
    runLiveness: {
      executionOwnerId: "first-recovery",
      leaseDurationMs: 50_000,
    },
  });
  const firstHandle = first.executeTurn({
    branchId: fixture.thread.branchId,
    threadId: fixture.thread.threadId,
    signal: textSignal("Recover twice"),
    config: {
      name: "primary",
      tools: [
        {
          name: "lookup",
          description: "lookup",
          inputSchema: { type: "object" },
          async execute(_input, context) {
            if (context.callId === "held-recovery") {
              enteredHeld?.();
              await held;
            }
            return { callId: context.callId };
          },
        },
      ],
    },
  });
  const firstEvents = collectEvents(firstHandle.events());
  await entered;
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }

  const secondDispatches: string[] = [];
  const runnerDispatchCounts: number[] = [];
  const second = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: fixture.kernel,
    now: () => 60_000,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runnerRegistry: createRunnerRegistry([
      {
        id: "fake",
        async execute() {
          runnerDispatchCounts.push(secondDispatches.length);
          return {
            messages: [assistantText("done")],
            resolution: { reason: "done", type: "end_turn" },
          };
        },
      },
    ]),
    runLiveness: {
      executionOwnerId: "second-recovery",
      leaseDurationMs: 50_000,
    },
  });
  const secondHandle = second.executeTurn({
    branchId: fixture.thread.branchId,
    threadId: fixture.thread.threadId,
    signal: textSignal("Recover twice"),
    config: {
      name: "primary",
      tools: [
        {
          name: "lookup",
          description: "lookup",
          inputSchema: { type: "object" },
          execute(_input, context) {
            secondDispatches.push(context.callId);
            return {};
          },
        },
      ],
    },
  });
  await collectEvents(secondHandle.events());
  releaseHeld?.();
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
  const inputHead = (await fixture.kernel.branch.get(fixture.thread.branchId))
    ?.headTurnNodeHash;
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
      lastTurnNodeHash: inputHead,
      consumedStagedResults: [],
      uncommittedStagedResults: recoveredRun.uncommittedStagedResults,
    };
  };
  let runnerCalls = 0;
  const runtime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: fixture.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runnerRegistry: createRunnerRegistry([
      {
        id: "fake",
        async execute() {
          runnerCalls += 1;
          return {
            messages: [assistantText("unexpected extra iteration")],
            resolution: { reason: "done", type: "end_turn" },
          };
        },
      },
    ]),
    runLiveness: {
      executionOwnerId: "count-recovery",
      leaseDurationMs: 50_000,
    },
  });
  const handle = runtime.executeTurn({
    branchId: fixture.thread.branchId,
    threadId: fixture.thread.threadId,
    signal: textSignal("Recover count"),
    config: {
      name: "primary",
      maxIterations: 1,
      tools: [
        {
          name: "lookup",
          description: "lookup",
          inputSchema: { type: "object" },
          execute() {
            return {};
          },
        },
      ],
    },
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
  const inputHead = (await fixture.kernel.branch.get(fixture.thread.branchId))
    ?.headTurnNodeHash;
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
      lastTurnNodeHash: inputHead,
      consumedStagedResults: [],
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
    runnerRegistry: createRunnerRegistry([
      {
        id: "fake",
        async execute(context) {
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
        },
      },
    ]),
    runLiveness: {
      executionOwnerId: "context-recovery",
      leaseDurationMs: 50_000,
    },
  });
  const handle = runtime.executeTurn({
    branchId: fixture.thread.branchId,
    threadId: fixture.thread.threadId,
    signal: textSignal("Recover context history"),
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
  let stagedReady: (() => void) | undefined;
  let releaseStage: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    stagedReady = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });
  const stage = liveness.kernel.staging.stage.bind(liveness.kernel.staging);
  let intercept = true;
  liveness.kernel.staging.stage = async (...args) => {
    const result = await stage(...args);
    if (intercept && args[2] === "message_1_0") {
      intercept = false;
      stagedReady?.();
      await held;
    }
    return result;
  };
  const original = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runnerRegistry: createRunnerRegistry([
      {
        id: "fake",
        async execute() {
          return {
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
          };
        },
      },
    ]),
    runLiveness: {
      executionOwnerId: "partial-original",
      leaseDurationMs: 50_000,
    },
  });
  const thread = await original.createThread({});
  const baseTool = {
    name: "charge",
    description: "charge",
    inputSchema: { type: "object" },
    execute() {
      return {};
    },
  };
  const first = original.executeTurn({
    branchId: thread.branchId,
    threadId: thread.threadId,
    signal: textSignal("Recover failed partial"),
    config: { name: "primary", tools: [baseTool] },
  });
  const firstEvents = collectEvents(first.events());
  await ready;
  let dispatches = 0;
  const replacement = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 60_000,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runnerRegistry: createRunnerRegistry([
      {
        id: "fake",
        async execute() {
          return {
            messages: [assistantText("recovered")],
            resolution: { reason: "done", type: "end_turn" },
          };
        },
      },
    ]),
    runLiveness: {
      executionOwnerId: "partial-replacement",
      leaseDurationMs: 50_000,
    },
  });
  const second = replacement.executeTurn({
    branchId: thread.branchId,
    threadId: thread.threadId,
    signal: textSignal("Recover failed partial"),
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
  });
  await collectEvents(second.events());
  releaseStage?.();
  await firstEvents;

  expect(second.status().phase).toBe("completed");
  expect(dispatches).toBe(0);
});

test("preserves sequential recovery mode and the first approval gate", async () => {
  const harness = createFakeKernelHarness();
  const liveness = createFakeRunLivenessKernelHarness(harness);
  let stagedReady: (() => void) | undefined;
  let releaseStage: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    stagedReady = resolve;
  });
  const heldStage = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });
  const stage = liveness.kernel.staging.stage.bind(liveness.kernel.staging);
  let intercept = true;
  liveness.kernel.staging.stage = async (...args) => {
    const result = await stage(...args);
    if (intercept && args[2] === "message_1_0") {
      intercept = false;
      stagedReady?.();
      await heldStage;
    }
    return result;
  };
  const original = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runnerRegistry: createRunnerRegistry([
      {
        id: "fake",
        async execute() {
          return {
            messages: [
              assistantToolCalls([
                { callId: "first-sequential", input: {}, name: "lookup" },
                { callId: "second-sequential", input: {}, name: "lookup" },
              ]),
            ],
            resolution: { type: "continue_iteration" },
            toolExecutionMode: "sequential",
          };
        },
      },
    ]),
    runLiveness: {
      executionOwnerId: "sequential-original",
      leaseDurationMs: 50_000,
    },
  });
  const thread = await original.createThread({});
  const config = {
    name: "primary",
    maxIterations: 1,
    tools: [
      {
        name: "lookup",
        description: "lookup",
        inputSchema: { type: "object" },
        execute() {
          return {};
        },
      },
    ],
  };
  const first = original.executeTurn({
    branchId: thread.branchId,
    threadId: thread.threadId,
    signal: textSignal("Recover sequential"),
    config,
  });
  const firstEvents = collectEvents(first.events());
  await ready;
  let releaseFirst: (() => void) | undefined;
  let enteredFirst: (() => void) | undefined;
  const heldFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  let secondStarted = false;
  const replacement = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 60_000,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runnerRegistry: createRunnerRegistry([
      {
        id: "fake",
        async execute() {
          return {
            messages: [assistantText("done")],
            resolution: { reason: "done", type: "end_turn" },
          };
        },
      },
    ]),
    runLiveness: {
      executionOwnerId: "sequential-replacement",
      leaseDurationMs: 50_000,
    },
  });
  const second = replacement.executeTurn({
    branchId: thread.branchId,
    threadId: thread.threadId,
    signal: textSignal("Recover sequential"),
    config: {
      ...config,
      tools: [
        {
          ...config.tools[0],
          async execute(_input, context) {
            if (context.callId === "first-sequential") {
              enteredFirst?.();
              await heldFirst;
            } else {
              secondStarted = true;
            }
            return {};
          },
        },
      ],
    },
  });
  const secondEvents = collectEvents(second.events());
  await entered;
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
  const secondStartedWhileFirstBlocked = secondStarted;
  releaseFirst?.();
  await secondEvents;
  releaseStage?.();
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
    runnerRegistry: createRunnerRegistry([
      {
        id: "fake",
        async execute(context) {
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
        },
      },
    ]),
    runLiveness: {
      executionOwnerId: "order-recovery",
      leaseDurationMs: 50_000,
    },
  });
  const handle = runtime.executeTurn({
    branchId: fixture.thread.branchId,
    threadId: fixture.thread.threadId,
    signal: textSignal("Recover order"),
    config: {
      name: "primary",
      extensions: [
        {
          name: "capture-finalized-tool-batch",
          afterIteration(context) {
            const toolResults = context.toolResults ?? [];
            if (toolResults.length > 0) {
              afterIterationCallIds = toolResults.map(
                (result) => result.callId
              );
            }
            return undefined;
          },
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "lookup",
          inputSchema: { type: "object" },
          execute() {
            return { value: 1 };
          },
        },
      ],
    },
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
    runnerRegistry: createRunnerRegistry([
      {
        id: "fake",
        async execute() {
          return {
            messages: [assistantText("single recovered result")],
            resolution: { reason: "done", type: "end_turn" },
          };
        },
      },
    ]),
    runLiveness: {
      executionOwnerId: "single-recovery-manifest",
      leaseDurationMs: 50_000,
    },
  });
  const handle = runtime.executeTurn({
    branchId: fixture.thread.branchId,
    threadId: fixture.thread.threadId,
    signal: textSignal("Recover one result"),
    config: {
      name: "primary",
      tools: [
        {
          name: "lookup",
          description: "lookup",
          inputSchema: { type: "object" },
          execute() {
            return { value: 1 };
          },
        },
      ],
    },
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
    runnerRegistry: createRunnerRegistry([
      {
        id: "fake",
        async execute() {
          return {
            messages: [assistantText("approved recovered result")],
            resolution: { reason: "done", type: "end_turn" },
          };
        },
      },
    ]),
    runLiveness: {
      executionOwnerId: "approval-recovery-order",
      leaseDurationMs: 50_000,
    },
  });
  const paused = runtime.executeTurn({
    branchId: fixture.thread.branchId,
    threadId: fixture.thread.threadId,
    signal: textSignal("Resume in original order"),
    config: {
      name: "primary",
      tools: [
        {
          approval: true,
          name: "lookup",
          description: "lookup",
          inputSchema: { type: "object" },
          execute() {
            return { value: 1 };
          },
        },
      ],
    },
  });
  await collectEvents(paused.events());
  expect(paused.status().phase).toBe("paused");

  const resumed = paused.resolveApproval({
    decisions: [{ callId: "approval-first", type: "approve" }],
  });
  await collectEvents(resumed.events());

  expect(resumed.status().phase).toBe("completed");
  const resultCallIds = (
    await fixture.harness.readBranchMessages(fixture.thread.branchId)
  ).flatMap((message) => {
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
  let resultStaged: (() => void) | undefined;
  let releaseStage: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resultStaged = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });
  const stage = liveness.kernel.staging.stage.bind(liveness.kernel.staging);
  let intercept = true;
  liveness.kernel.staging.stage = async (...args) => {
    const result = await stage(...args);
    if (intercept && args[2] === "tool_result_0_stateful-call") {
      intercept = false;
      resultStaged?.();
      await held;
    }
    return result;
  };
  const runner = {
    id: "fake",
    async execute(context) {
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
    },
  } satisfies RuntimeRunner;
  let sideEffectCalls = 0;
  const extension = {
    name: "__tuvren_interrupted_tool_batch",
    aroundTool(_context, next) {
      return next().then((result) => ({
        result,
        state: { completedCall: "stateful-call" },
      }));
    },
  } satisfies TuvrenExtension;
  const firstRuntime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runnerRegistry: createRunnerRegistry([runner]),
    runLiveness: {
      executionOwnerId: "state-original",
      leaseDurationMs: 50_000,
    },
  });
  const thread = await firstRuntime.createThread({});
  const config = {
    name: "primary",
    extensions: [extension],
    tools: [
      {
        name: "lookup",
        description: "lookup",
        inputSchema: { type: "object" },
        execute() {
          sideEffectCalls += 1;
          return {};
        },
      },
    ],
  };
  const first = firstRuntime.executeTurn({
    branchId: thread.branchId,
    threadId: thread.threadId,
    signal: textSignal("Recover state"),
    config,
  });
  const firstEvents = collectEvents(first.events());
  await ready;

  const replacement = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 60_000,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runnerRegistry: createRunnerRegistry([runner]),
    runLiveness: {
      executionOwnerId: "state-replacement",
      leaseDurationMs: 50_000,
    },
  });
  const second = replacement.executeTurn({
    branchId: thread.branchId,
    threadId: thread.threadId,
    signal: textSignal("Recover state"),
    config,
  });
  await collectEvents(second.events());
  const stateAtRecovery = second.status().manifest?.extensions ?? {};
  releaseStage?.();
  await firstEvents;

  const treeManifest = await harness.readBranchManifest(thread.branchId);
  const contextManifestHash = treeManifest["context.manifest"];
  if (typeof contextManifestHash !== "string") {
    throw new Error("expected recovered context manifest");
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
