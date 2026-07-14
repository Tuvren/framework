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

import type { EpochMs, HashString, KernelRecord } from "@tuvren/core";
import type {
  ContextManifest,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type {
  RunCompletionStatus,
  RuntimeKernel,
} from "@tuvren/kernel-protocol";
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

/**
 * Facade over the status module's `failActiveRunIfNeeded`: fail the
 * handle's active tracked run if one is still registered.
 */
export async function failRuntimeCoreActiveRunIfNeeded(
  host: RuntimeCoreStatusHost,
  handle: RuntimeExecutionHandle
): Promise<void> {
  await failRuntimeActiveRunIfNeeded(host, handle);
}

/**
 * Facade over the status module's `checkpointResumeRunningStatus`: durably
 * checkpoint a `running` runtime status (folding in any carried extension
 * state) when resuming execution, returning the pending state-observability
 * payload when a new turn node was produced.
 */
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

/**
 * Facade over the liveness module's `createTrackedRun`: create a kernel run
 * with the given step plan and register it on the handle as the active
 * tracked run.
 */
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

/**
 * Facade over the expired-recovery module's
 * `recoverExpiredExecutionBranchIfNeeded`: detect and preempt an expired
 * run on the branch, returning the recovery classification or `undefined`
 * when there is nothing to recover.
 */
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

/**
 * Facade over the liveness module's `completeTrackedRun`: complete a
 * tracked kernel run (stopping its lease-renewal loop and clearing the
 * handle's active-run bookkeeping), returning the completion result with
 * the advanced turn node hash when the run moved the turn forward.
 */
export async function completeRuntimeCoreTrackedRun(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  status: RunCompletionStatus,
  event?: KernelRecord
): Promise<{ turnNodeHash?: HashString }> {
  return await completeRuntimeTrackedRun(host, handle, runId, status, event);
}

/**
 * Facade over the liveness module's `stopRunLeaseLoop`: stop the handle's
 * background lease-renewal loop, optionally only when it belongs to the
 * given run.
 */
export function stopRuntimeCoreRunLeaseLoop(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  runId?: string
): void {
  stopRuntimeRunLeaseLoop(host, handle, runId);
}

/**
 * Facade over the expired-recovery module's
 * `completeRecoveredTerminalExecution`: replay a recovered execution's
 * durable terminal status onto the handle and publish the matching turn-end
 * event.
 */
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

/**
 * Facade over the liveness module's `syncRunLeaseStateFromStepResult`: fold
 * lease data piggybacked on a step-completion result into the handle's
 * active lease so the renewal loop never renews with a stale fencing token.
 */
export function syncRuntimeCoreRunLeaseStateFromStepResult(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
): void {
  syncRuntimeRunLeaseStateFromStepResult(host, handle, runId, stepResult);
}

/**
 * Facade over the facade-ops module's `advanceTurnAndBranchHeadFacade`:
 * advance the turn and branch head in the kernel to the given turn node.
 */
export async function advanceRuntimeCoreTurnAndBranchHead(
  kernel: RuntimeKernel,
  handle: RuntimeExecutionHandle,
  turnNodeHash: HashString
): Promise<void> {
  await advanceTurnAndBranchHeadFacade(kernel, handle, turnNodeHash);
}

/**
 * Facade over the turn-progress module's
 * `failTrackedRunWithoutBranchAdvance`: fail a tracked run and restore the
 * branch head to its stable position so failed work is not observable.
 */
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

/**
 * Facade over the turn-progress module's
 * `reconcileCheckpointedPauseResolution`: when a pause was durably
 * checkpointed but the final resolution is not `pause`, override the paused
 * run; returns the resolution unchanged.
 */
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

/**
 * Facade over the turn-progress module's `resolveCheckpointedPausedRun`:
 * complete a durably checkpointed paused run as `failed` with a
 * `paused_run_overridden` event recording the superseding resolution.
 */
export async function resolveRuntimeCoreCheckpointedPausedRun(
  host: RuntimeCoreTurnProgressHost,
  runId: string,
  turnId: string,
  resolution: RuntimeResolution
): Promise<void> {
  await resolveRuntimeCheckpointedPausedRun(host, runId, turnId, resolution);
}
