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

import { type EpochMs, TuvrenRuntimeError } from "@tuvren/core";
import type { InputSignal } from "@tuvren/core/execution";
import type {
  RuntimeKernel as KrakenKernel,
  RuntimeKernelRunLiveness,
} from "@tuvren/kernel-protocol";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import {
  classifyRecoveredExecutionMode,
  classifyRecoveredTurnSignalState,
  classifyStaleRecoveryRace,
  type DurableRuntimeStatus,
  doesSignalMatchRecoveredTurn,
  type ExpiredExecutionRecovery,
} from "./runtime-core-recovery.js";
import { toOrderedHashArray } from "./runtime-core-response.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

export interface RuntimeCoreExpiredRecoveryOptions {
  executionOwnerId: string;
}

export interface RuntimeCoreExpiredRecoveryHost {
  getNow(): EpochMs;
  getRunLivenessOptions(): RuntimeCoreExpiredRecoveryOptions | undefined;
  getRuntimeKernel(): (KrakenKernel & RuntimeKernelRunLiveness) | KrakenKernel;
  loadHeadState(branchId: string): Promise<HeadState>;
  publishTurnEnd(
    handle: RuntimeExecutionHandle,
    status: "completed" | "failed",
    loopState: LoopState
  ): void;
  readRecoveredActiveAgentName(
    turnTreeHash: string
  ): Promise<string | undefined>;
  readRecoveredRuntimeStatus(
    turnTreeHash: string
  ): Promise<DurableRuntimeStatus | undefined>;
}

export async function recoverExpiredExecutionBranchIfNeeded(
  host: RuntimeCoreExpiredRecoveryHost,
  branchId: string,
  signal: InputSignal
): Promise<ExpiredExecutionRecovery | undefined> {
  const kernel = host.getRuntimeKernel();
  const livenessOptions = host.getRunLivenessOptions();

  if (!("runLiveness" in kernel) || livenessOptions === undefined) {
    return undefined;
  }

  const expiredRun = (await kernel.runLiveness.listExpired(host.getNow()))
    .filter((candidate) => candidate.branchId === branchId)
    .at(0);

  if (expiredRun === undefined) {
    return undefined;
  }

  let recoveryState: Awaited<
    ReturnType<RuntimeKernelRunLiveness["runLiveness"]["preemptExpired"]>
  >;

  try {
    recoveryState = await kernel.runLiveness.preemptExpired(
      expiredRun.runId,
      livenessOptions.executionOwnerId,
      host.getNow(),
      "stale_running_recovery"
    );
  } catch (error: unknown) {
    const raceResolution = classifyStaleRecoveryRace(error);

    if (raceResolution === undefined) {
      throw error;
    }

    return raceResolution;
  }

  const recoveredHeadState = await host.loadHeadState(branchId);
  const recoveredMode = classifyRecoveredExecutionMode(recoveryState);

  if (recoveredMode === "reuse_turn") {
    switch (
      classifyRecoveredTurnSignalState(signal, recoveredHeadState.messages)
    ) {
      case "match":
        return {
          iterationCount: 0,
          mode: recoveredMode,
          needsInputReincorporation: false,
          preempted: true,
          turnId: expiredRun.turnId,
        };
      case "missing":
        return {
          iterationCount: 0,
          mode: recoveredMode,
          needsInputReincorporation: true,
          preempted: true,
          turnId: expiredRun.turnId,
        };
      case "mismatch":
        return {
          preempted: true,
        };
      default:
        return {
          preempted: true,
        };
    }
  }

  if (!doesSignalMatchRecoveredTurn(signal, recoveredHeadState.messages)) {
    return {
      preempted: true,
    };
  }

  return {
    activeAgentName: await host.readRecoveredActiveAgentName(
      recoveredHeadState.turnNode.turnTreeHash
    ),
    iterationCount: await estimateRecoveredIterationCount(
      kernel,
      expiredRun.turnId,
      recoveredHeadState
    ),
    mode: recoveredMode,
    preempted: true,
    runtimeStatus: await host.readRecoveredRuntimeStatus(
      recoveredHeadState.turnNode.turnTreeHash
    ),
    turnId: expiredRun.turnId,
  };
}

export async function completeRecoveredTerminalExecution(
  host: RuntimeCoreExpiredRecoveryHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  recoveredExecution: ExpiredExecutionRecovery
): Promise<void> {
  const recoveredRuntimeStatus = recoveredExecution.runtimeStatus;

  if (
    recoveredRuntimeStatus === undefined ||
    (recoveredRuntimeStatus.state !== "completed" &&
      recoveredRuntimeStatus.state !== "failed")
  ) {
    throw new TuvrenRuntimeError(
      "recovered terminal execution requires a durable terminal runtime status",
      { code: "missing_recovered_terminal_status" }
    );
  }

  const recoveredHeadState = await host.loadHeadState(handle.request.branchId);
  handle.replaceStatus({
    activeAgent:
      recoveredRuntimeStatus.activeAgent ?? loopState.activeConfig.name,
    iterationCount: handle.status().iterationCount,
    manifest: recoveredHeadState.manifest,
    phase: recoveredRuntimeStatus.state,
  });
  host.publishTurnEnd(handle, recoveredRuntimeStatus.state, loopState);
}

async function estimateRecoveredIterationCount(
  kernel: KrakenKernel,
  turnId: string,
  recoveredHeadState: HeadState
): Promise<number> {
  const turn = await kernel.turn.get(turnId);

  if (turn === null) {
    return 1;
  }

  const startTurnNode = await kernel.node.get(turn.startTurnNodeHash);

  if (startTurnNode === null) {
    return 1;
  }

  const startMessageHashes = toOrderedHashArray(
    await kernel.tree.resolve(startTurnNode.turnTreeHash, "messages")
  );

  if (
    recoveredHeadState.messageHashes.length >= startMessageHashes.length &&
    startMessageHashes.every(
      (hash, index) => recoveredHeadState.messageHashes[index] === hash
    )
  ) {
    const assistantIterations = recoveredHeadState.messages
      .slice(startMessageHashes.length)
      .filter((message) => message.role === "assistant").length;

    if (assistantIterations > 0) {
      return assistantIterations;
    }
  }

  return 1;
}
