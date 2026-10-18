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

import { DEFAULT_SCOPE } from "@tuvren/core";
import type { InputSignal } from "@tuvren/core/execution";
import { IDENTITY_PAYLOAD_CODEC } from "@tuvren/core/lifecycle";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import type { RuntimeKernel, TurnNode } from "@tuvren/kernel-protocol";

import { DEFAULT_AGENT_SCHEMA } from "../src/index.ts";
import { encryptMessageRecord } from "../src/lib/payload-codec-seam.ts";
import { recoverExpiredExecutionBranchIfNeeded } from "../src/lib/runtime-core-expired-recovery.ts";
import type { RuntimeCoreExpiredRecoveryHost } from "../src/lib/runtime-core-expired-recovery.ts";
import { loadHeadState } from "../src/lib/runtime-core-head-state.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import { createFakeRunLivenessKernelHarness } from "./fake-run-liveness-kernel.ts";

const payloadCodecBinding = {
  codec: IDENTITY_PAYLOAD_CODEC,
  scope: DEFAULT_SCOPE,
};

const prepareRecovery = async (suffix: string) => {
  const harness = createFakeKernelHarness();
  const livenessHarness = createFakeRunLivenessKernelHarness(harness);
  const { kernel } = livenessHarness;
  const thread = await kernel.thread.create(
    `thread_${suffix}`,
    DEFAULT_AGENT_SCHEMA.schemaId,
    `branch_${suffix}`
  );
  const turn = await kernel.turn.create(
    `turn_${suffix}`,
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );
  const inputRunId = `run_${suffix}_input`;

  await kernel.run.create(
    inputRunId,
    turn.turnId,
    thread.branchId,
    DEFAULT_AGENT_SCHEMA.schemaId,
    thread.rootTurnNodeHash,
    [{ deterministic: false, id: "incorporate_input", sideEffects: true }]
  );
  await kernel.run.beginStep(inputRunId, "incorporate_input");
  await kernel.staging.stage(
    inputRunId,
    await encryptMessageRecord(
      payloadCodecBinding,
      encodeDeterministicKernelRecord({
        admissionKey: "recovery-admission-key",
        parts: [{ text: "resume this request", type: "text" as const }],
        role: "user" as const,
      } satisfies Parameters<typeof encodeDeterministicKernelRecord>[0])
    ),
    "input_message",
    "message",
    "completed"
  );
  const inputCheckpoint = await kernel.run.completeStep(
    inputRunId,
    "incorporate_input"
  );
  await kernel.run.complete(inputRunId, "completed");

  if (inputCheckpoint.turnNodeHash === undefined) {
    throw new Error("expected an input checkpoint");
  }

  const staleRunId = `run_${suffix}_stale`;
  await kernel.runLiveness.createLeasedRun({
    branchId: thread.branchId,
    executionOwnerId: "stale-worker",
    leaseExpiresAtMs: 1,
    runId: staleRunId,
    schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
    startTurnNodeHash: inputCheckpoint.turnNodeHash,
    steps: [
      { deterministic: false, id: "incorporate_input", sideEffects: true },
    ],
    turnId: turn.turnId,
  });

  const host: RuntimeCoreExpiredRecoveryHost = {
    getNow: () => 2,
    getPayloadCodecBinding: () => payloadCodecBinding,
    getRunLivenessOptions: () => ({ executionOwnerId: "replacement-worker" }),
    getRuntimeKernel: () => kernel,
    async loadHeadState(branchId) {
      return await loadHeadState(kernel, payloadCodecBinding, branchId);
    },
    publishTurnEnd() {
      // Recovery classification does not publish terminal status.
    },
    async readRecoveredActiveAgentName() {
      await Promise.resolve();
    },
    async readRecoveredRuntimeStatus() {
      await Promise.resolve();
    },
  };

  const inputTurnNode = await kernel.node.get(inputCheckpoint.turnNodeHash);
  const inputStagedResult = inputTurnNode?.consumedStagedResults.find(
    (stagedResult) => stagedResult.taskId === "input_message"
  );

  if (inputStagedResult === undefined) {
    throw new Error(
      "expected the input message to be consumed at the checkpoint"
    );
  }

  return {
    harness,
    host,
    inputMessageHash: inputStagedResult.objectHash,
    kernel,
    thread,
    turn,
  };
};

const signal: InputSignal = {
  admissionKey: "recovery-admission-key",
  parts: [{ text: "resume this request", type: "text" }],
};

const instrumentWalkBack = (
  kernel: RuntimeKernel,
  onClose: () => void,
  closeError?: Error
): RuntimeKernel["node"]["walkBack"] => {
  const originalWalkBack = kernel.node.walkBack.bind(kernel.node);

  return (
    fromHash: Parameters<RuntimeKernel["node"]["walkBack"]>[0]
  ): AsyncIterable<TurnNode> => {
    const iterator = originalWalkBack(fromHash)[Symbol.asyncIterator]();

    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return await iterator.next();
          },
          async return() {
            onClose();
            if (closeError !== undefined) {
              await iterator.return?.();
              throw closeError;
            }

            const result = await iterator.return?.();
            return result ?? { done: true, value: undefined };
          },
        };
      },
    };
  };
};

describe("recoverExpiredExecutionBranchIfNeeded iterator cleanup", () => {
  test("closes the lineage iterator after reaching the turn start boundary", async () => {
    const { host, kernel, thread } = await prepareRecovery("boundary_close");
    let iteratorClosed = false;
    const instrumentedKernel: RuntimeKernel = {
      ...kernel,
      node: {
        ...kernel.node,
        walkBack: instrumentWalkBack(kernel, () => {
          iteratorClosed = true;
        }),
      },
    };
    const recoveryHost = {
      ...host,
      getRuntimeKernel: () => instrumentedKernel,
    };

    const result = await recoverExpiredExecutionBranchIfNeeded(
      recoveryHost,
      thread.branchId,
      signal
    );

    expect(result).toMatchObject({ mode: "reuse_turn", preempted: true });
    expect(iteratorClosed).toBe(true);
  });

  test("closes the lineage iterator when reading a staged input fails and keeps that error primary", async () => {
    const { host, inputMessageHash, kernel, thread } =
      await prepareRecovery("read_failure");
    const originalGet = kernel.store.get.bind(kernel.store);
    const readError = new Error("durable message read failed");
    const closeError = new Error("iterator cleanup failed");
    let iteratorClosed = false;
    const instrumentedKernel: RuntimeKernel = {
      ...kernel,
      node: {
        ...kernel.node,
        walkBack: instrumentWalkBack(
          kernel,
          () => {
            iteratorClosed = true;
          },
          closeError
        ),
      },
      store: {
        ...kernel.store,
        async get(hash) {
          if (hash === inputMessageHash) {
            throw readError;
          }

          return await originalGet(hash);
        },
      },
    };
    const recoveryHost = {
      ...host,
      getRuntimeKernel: () => instrumentedKernel,
    };

    let recoveryError: unknown;
    try {
      await recoverExpiredExecutionBranchIfNeeded(
        recoveryHost,
        thread.branchId,
        signal
      );
    } catch (error: unknown) {
      recoveryError = error;
    }

    expect(recoveryError).toBe(readError);
    expect(iteratorClosed).toBe(true);
  });
});
