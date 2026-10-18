/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { assertKernelRecord, DEFAULT_SCOPE } from "@tuvren/core";
import { IDENTITY_PAYLOAD_CODEC } from "@tuvren/core/lifecycle";
import type { TuvrenMessage } from "@tuvren/core/messages";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import type { RuntimeKernel } from "@tuvren/kernel-protocol";

import { DEFAULT_AGENT_SCHEMA } from "../src/index.ts";
import { encryptMessageRecord } from "../src/lib/payload-codec-seam.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import { createFakeRunLivenessKernelHarness } from "./fake-run-liveness-kernel.ts";

const stageTestMessage = async (
  kernel: RuntimeKernel,
  runId: string,
  taskId: string,
  message: TuvrenMessage
): Promise<void> => {
  const record: unknown = message;
  assertKernelRecord(record, `cold recovery message for task "${taskId}"`);
  await kernel.staging.stage(
    runId,
    await encryptMessageRecord(
      { codec: IDENTITY_PAYLOAD_CODEC, scope: DEFAULT_SCOPE },
      encodeDeterministicKernelRecord(record)
    ),
    taskId,
    "message",
    "completed"
  );
};

const stageInterruptedMessages = async (
  kernel: RuntimeKernel,
  runId: string,
  messages: readonly TuvrenMessage[],
  index = 0
): Promise<void> => {
  const message = messages[index];

  if (message === undefined) {
    return;
  }

  await stageTestMessage(
    kernel,
    runId,
    `interrupted_message_${index.toString()}`,
    message
  );
  await stageInterruptedMessages(kernel, runId, messages, index + 1);
};

export const prepareExpiredToolBatch = async (
  suffix: string,
  signalText: string,
  interruptedMessages: TuvrenMessage[]
) => {
  const harness = createFakeKernelHarness();
  const livenessHarness = createFakeRunLivenessKernelHarness(harness);
  const thread = await livenessHarness.kernel.thread.create(
    `thread_${suffix}`,
    DEFAULT_AGENT_SCHEMA.schemaId,
    `branch_${suffix}`
  );
  const staleTurn = await livenessHarness.kernel.turn.create(
    `turn_${suffix}`,
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );
  const inputRunId = `run_${suffix}_input`;
  await livenessHarness.kernel.run.create(
    inputRunId,
    staleTurn.turnId,
    thread.branchId,
    DEFAULT_AGENT_SCHEMA.schemaId,
    thread.rootTurnNodeHash,
    [{ deterministic: false, id: "incorporate_input", sideEffects: true }]
  );
  await livenessHarness.kernel.run.beginStep(inputRunId, "incorporate_input");
  await stageTestMessage(livenessHarness.kernel, inputRunId, "durable_user", {
    parts: [{ text: signalText, type: "text" }],
    role: "user",
  });
  const inputCheckpoint = await livenessHarness.kernel.run.completeStep(
    inputRunId,
    "incorporate_input"
  );
  await livenessHarness.kernel.run.complete(inputRunId, "completed");
  if (inputCheckpoint.turnNodeHash === undefined) {
    throw new Error("expected durable input checkpoint");
  }

  await livenessHarness.kernel.turn.updateHead(
    staleTurn.turnId,
    inputCheckpoint.turnNodeHash
  );
  const staleRunId = `run_${suffix}_stale`;
  await livenessHarness.kernel.runLiveness.createLeasedRun({
    branchId: thread.branchId,
    executionOwnerId: "worker-that-crashed",
    leaseExpiresAtMs: 20,
    runId: staleRunId,
    schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
    startTurnNodeHash: inputCheckpoint.turnNodeHash,
    steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
    turnId: staleTurn.turnId,
  });
  await livenessHarness.kernel.run.beginStep(staleRunId, "iterate");

  await stageInterruptedMessages(
    livenessHarness.kernel,
    staleRunId,
    interruptedMessages
  );

  return {
    harness,
    kernel: livenessHarness.kernel,
    staleTurn,
    thread,
  };
};
