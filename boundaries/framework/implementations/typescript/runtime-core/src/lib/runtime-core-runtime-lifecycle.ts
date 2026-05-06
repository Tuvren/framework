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

import type { EpochMs, HashString, KernelRecord } from "@tuvren/core-types";
import type {
  RuntimeKernel as KrakenKernel,
  RunCompletionStatus,
} from "@tuvren/kernel-protocol";
import type { ContextManifest, RuntimeResolution } from "@tuvren/runtime-api";
import {
  completeRecoveredTerminalExecution as completeRuntimeRecoveredTerminalExecution,
  type RuntimeCoreExpiredRecoveryHost,
  recoverExpiredExecutionBranchIfNeeded as recoverRuntimeExpiredExecutionBranchIfNeeded,
} from "./runtime-core-expired-recovery.js";
import { advanceTurnAndBranchHeadFacade } from "./runtime-core-facade-ops.js";
import {
  completeTrackedRun as completeRuntimeTrackedRun,
  createTrackedRun as createRuntimeTrackedRun,
  type RuntimeCoreLivenessHost,
  stopRunLeaseLoop as stopRuntimeRunLeaseLoop,
  syncRunLeaseStateFromStepResult as syncRuntimeRunLeaseStateFromStepResult,
} from "./runtime-core-liveness.js";
import type { LoopState } from "./runtime-core-loop.js";
import type { ExpiredExecutionRecovery } from "./runtime-core-recovery.js";
import {
  checkpointResumeRunningStatus as checkpointRuntimeResumeRunningStatus,
  failActiveRunIfNeeded as failRuntimeActiveRunIfNeeded,
  type RuntimeCoreStatusHost,
} from "./runtime-core-status.js";
import {
  failTrackedRunWithoutBranchAdvance as failRuntimeTrackedRunWithoutBranchAdvance,
  type RuntimeCoreTurnProgressHost,
  reconcileCheckpointedPauseResolution as reconcileRuntimeCheckpointedPauseResolution,
  resolveCheckpointedPausedRun as resolveRuntimeCheckpointedPausedRun,
} from "./runtime-core-turn-progress.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { ExecutionSessionRequest } from "./runtime-execution-types.js";

export async function failRuntimeCoreActiveRunIfNeeded(
  host: RuntimeCoreStatusHost,
  handle: RuntimeExecutionHandle
): Promise<void> {
  await failRuntimeActiveRunIfNeeded(host, handle);
}

export async function checkpointRuntimeCoreResumeRunningStatus(
  host: RuntimeCoreStatusHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  iterationCount: number,
  emitObservability = true
): Promise<
  | {
      iterationCount: number;
      manifest?: ContextManifest;
      turnNodeHash: HashString;
    }
  | undefined
> {
  return await checkpointRuntimeResumeRunningStatus(
    host,
    handle,
    schemaId,
    loopState,
    iterationCount,
    emitObservability
  );
}

export async function createRuntimeCoreTrackedRun(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  turnId: string,
  branchId: string,
  schemaId: string,
  startTurnNodeHash: HashString,
  steps: Array<{
    deterministic: boolean;
    id: string;
    sideEffects: boolean;
  }>
): Promise<void> {
  await createRuntimeTrackedRun(
    host,
    handle,
    runId,
    turnId,
    branchId,
    schemaId,
    startTurnNodeHash,
    steps
  );
}

export async function recoverRuntimeCoreExpiredExecutionBranchIfNeeded(
  host: RuntimeCoreExpiredRecoveryHost,
  branchId: string,
  signal: ExecutionSessionRequest["signal"]
): Promise<ExpiredExecutionRecovery | undefined> {
  return await recoverRuntimeExpiredExecutionBranchIfNeeded(
    host,
    branchId,
    signal
  );
}

export async function completeRuntimeCoreTrackedRun(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  status: RunCompletionStatus,
  event?: KernelRecord
): Promise<{ turnNodeHash?: HashString }> {
  return await completeRuntimeTrackedRun(host, handle, runId, status, event);
}

export function stopRuntimeCoreRunLeaseLoop(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  runId?: string
): void {
  stopRuntimeRunLeaseLoop(host, handle, runId);
}

export async function completeRuntimeCoreRecoveredTerminalExecution(
  host: RuntimeCoreExpiredRecoveryHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  recoveredExecution: ExpiredExecutionRecovery
): Promise<void> {
  await completeRuntimeRecoveredTerminalExecution(
    host,
    handle,
    loopState,
    recoveredExecution
  );
}

export function syncRuntimeCoreRunLeaseStateFromStepResult(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
): void {
  syncRuntimeRunLeaseStateFromStepResult(host, handle, runId, stepResult);
}

export async function advanceRuntimeCoreTurnAndBranchHead(
  kernel: KrakenKernel,
  handle: RuntimeExecutionHandle,
  turnNodeHash: HashString
): Promise<void> {
  await advanceTurnAndBranchHeadFacade(kernel, handle, turnNodeHash);
}

export async function failRuntimeCoreTrackedRunWithoutBranchAdvance(
  host: RuntimeCoreTurnProgressHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  stableHeadTurnNodeHash: HashString
): Promise<void> {
  await failRuntimeTrackedRunWithoutBranchAdvance(
    host,
    handle,
    runId,
    stableHeadTurnNodeHash
  );
}

export async function reconcileRuntimeCoreCheckpointedPauseResolution(
  host: RuntimeCoreTurnProgressHost,
  checkpointedPause: boolean,
  runId: string,
  turnId: string,
  resolution: RuntimeResolution
): Promise<RuntimeResolution> {
  return await reconcileRuntimeCheckpointedPauseResolution(
    host,
    checkpointedPause,
    runId,
    turnId,
    resolution
  );
}

export async function resolveRuntimeCoreCheckpointedPausedRun(
  host: RuntimeCoreTurnProgressHost,
  runId: string,
  turnId: string,
  resolution: RuntimeResolution
): Promise<void> {
  await resolveRuntimeCheckpointedPausedRun(host, runId, turnId, resolution);
}
