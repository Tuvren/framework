/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { expect, test } from "bun:test";

import { assertKernelRecord, DEFAULT_SCOPE } from "@tuvren/core";
import { IDENTITY_PAYLOAD_CODEC } from "@tuvren/core/lifecycle";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { RuntimeRunner } from "@tuvren/core/runner";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import type { RuntimeKernel } from "@tuvren/kernel-protocol";

import {
  createRunnerRegistry as createBaseRunnerRegistry,
  createTuvrenRuntime,
  DEFAULT_AGENT_SCHEMA,
} from "../src/index.ts";
import { encryptMessageRecord } from "../src/lib/payload-codec-seam.ts";
import {
  createFakeKernelHarness,
  createFakeRunLivenessKernelHarness,
} from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  fromSynchronousVariadicAwaited,
  textSignal,
} from "./runtime-core-test-helpers.ts";

interface TestRuntimeRunner {
  execute: (
    context: Parameters<RuntimeRunner["execute"]>[0]
  ) =>
    | Awaited<ReturnType<RuntimeRunner["execute"]>>
    | ReturnType<RuntimeRunner["execute"]>;
  id: string;
}

const createRunnerRegistry = (runners: TestRuntimeRunner[] = []) =>
  createBaseRunnerRegistry(
    runners.map((runner): RuntimeRunner => ({
      execute: fromSynchronousVariadicAwaited(runner.execute),
      id: runner.id,
    }))
  );

const forEachSequentially = async <T>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<void>,
  index = 0
): Promise<void> => {
  if (index < values.length) {
    const value = values[index];
    if (value === undefined) {
      throw new Error(`missing sequential value at index ${index.toString()}`);
    }
    await operation(value, index);
    await forEachSequentially(values, operation, index + 1);
  }
};

const stageMessage = async (
  kernel: RuntimeKernel,
  runId: string,
  taskId: string,
  message: TuvrenMessage
): Promise<void> => {
  assertKernelRecord(message, "recovery repair staged message");
  await kernel.staging.stage(
    runId,
    await encryptMessageRecord(
      { codec: IDENTITY_PAYLOAD_CODEC, scope: DEFAULT_SCOPE },
      encodeDeterministicKernelRecord(message)
    ),
    taskId,
    "message",
    "completed"
  );
};
test("recovery dispatches missing calls before any context-engineering run", async () => {
  const harness = createFakeKernelHarness();
  const liveness = createFakeRunLivenessKernelHarness(harness);
  const thread = await liveness.kernel.thread.create(
    "thread_order_repair_window",
    DEFAULT_AGENT_SCHEMA.schemaId,
    "branch_order_repair_window"
  );
  const turn = await liveness.kernel.turn.create(
    "turn_order_repair_window",
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );
  const inputRun = "run_order_repair_window_input";
  await liveness.kernel.run.create(
    inputRun,
    turn.turnId,
    thread.branchId,
    DEFAULT_AGENT_SCHEMA.schemaId,
    thread.rootTurnNodeHash,
    [{ deterministic: false, id: "incorporate_input", sideEffects: true }]
  );
  await liveness.kernel.run.beginStep(inputRun, "incorporate_input");
  await stageMessage(liveness.kernel, inputRun, "user", {
    parts: [{ text: "recover batch", type: "text" }],
    role: "user",
  });
  const inputCheckpoint = await liveness.kernel.run.completeStep(
    inputRun,
    "incorporate_input"
  );
  if (inputCheckpoint.turnNodeHash === undefined) {
    throw new Error("expected input checkpoint");
  }
  await liveness.kernel.run.complete(inputRun, "completed");
  await liveness.kernel.turn.updateHead(
    turn.turnId,
    inputCheckpoint.turnNodeHash
  );

  const staleRun = "run_order_repair_window_stale";
  await liveness.kernel.runLiveness.createLeasedRun({
    branchId: thread.branchId,
    executionOwnerId: "crashed-owner",
    leaseExpiresAtMs: 20,
    runId: staleRun,
    schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
    startTurnNodeHash: inputCheckpoint.turnNodeHash,
    steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
    turnId: turn.turnId,
  });
  await liveness.kernel.run.beginStep(staleRun, "iterate");
  const assistant = assistantToolCalls([
    { callId: "first", input: {}, name: "lookup" },
    { callId: "second", input: {}, name: "lookup" },
    { callId: "missing-third", input: {}, name: "lookup" },
  ]);
  await stageMessage(liveness.kernel, staleRun, "assistant", assistant);
  await forEachSequentially(["second", "first"], async (callId, index) => {
    await stageMessage(liveness.kernel, staleRun, `result_${index}`, {
      parts: [{ callId, name: "lookup", output: {}, type: "tool_result" }],
      role: "tool",
    });
  });

  let contextEngineeringRuns = 0;
  const dispatched: string[] = [];
  const beginStep = liveness.kernel.run.beginStep.bind(liveness.kernel.run);
  liveness.kernel.run.beginStep = async (...args) => {
    if (args[1] === "context_engineering") {
      contextEngineeringRuns += 1;
    }
    return await beginStep(...args);
  };
  const runner: TestRuntimeRunner = {
    execute() {
      return {
        messages: [assistantText("done")],
        resolution: { reason: "done", type: "end_turn" },
      };
    },
    id: "fake",
  };
  const runtime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel: liveness.kernel,
    now: () => 21,
    payloadCodec: IDENTITY_PAYLOAD_CODEC,
    runLiveness: {
      executionOwnerId: "replacement-owner",
      leaseDurationMs: 50_000,
    },
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      name: "primary",
      tools: [
        {
          description: "lookup",
          execute(_input, context) {
            dispatched.push(context.callId);
            return {};
          },
          inputSchema: { type: "object" },
          name: "lookup",
        },
      ],
    },
    signal: textSignal("recover batch"),
    threadId: thread.threadId,
  });
  await collectEvents(handle.events());

  expect(handle.status().phase).toBe("completed");
  expect(dispatched).toEqual(["missing-third"]);
  expect(contextEngineeringRuns).toBe(0);
});
