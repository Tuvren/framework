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
import type { PathValue, RunCompletionStatus } from "@tuvren/kernel-protocol";
import type { LoopState } from "./runtime-core-loop.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

/**
 * Host seam for advancing durable turn progress at iteration boundaries.
 *
 * Provides kernel-run and run-step completion, tree creation, branch-head
 * manipulation, event-record storage, lease synchronization, and state
 * observability used by {@link completeIterationRun},
 * {@link createIterationTree}, {@link failTrackedRunWithoutBranchAdvance},
 * and the checkpointed-pause reconciliation helpers.
 */
export interface RuntimeCoreTurnProgressHost {
  advanceTurnAndBranchHead(
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ): Promise<void>;
  branchSetHead(branchId: string, turnNodeHash: HashString): Promise<void>;
  completeKernelRun(
    runId: string,
    status: RunCompletionStatus,
    eventHash?: HashString
  ): Promise<{ turnNodeHash?: HashString }>;
  completeRunStep(
    runId: string,
    stepId: string,
    eventHash: HashString,
    treeHash?: HashString
  ): Promise<{
    lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs };
    turnNodeHash?: HashString;
  }>;
  completeTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    status: RunCompletionStatus,
    event?: KernelRecord
  ): Promise<{ turnNodeHash?: HashString }>;
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): Promise<void>;
  storeEventRecord(event: KernelRecord): Promise<HashString>;
  syncRunLeaseStateFromStepResult(
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
  ): void;
  treeCreate(
    schemaId: string,
    changes: Record<string, PathValue>,
    baseTurnTreeHash: HashString
  ): Promise<HashString>;
}

/**
 * Complete an iteration's tracked kernel run according to its resolution.
 *
 * Hard failures complete the run as `failed` with an `iteration_failed`
 * event and never commit the iteration tree. All other resolutions first
 * complete the `iterate` step (committing `treeHash` when provided and
 * syncing the run lease), then complete the run as `paused` (with a
 * `paused` event) or `completed` (with an `iteration_completed` event).
 * When a turn node hash results, the turn and branch head advance and state
 * observability is emitted.
 *
 * @param treeHash - Turn tree produced by the iteration; committed with the
 *   `iterate` step when present.
 * @returns The new turn node hash, or `undefined` when the completion did
 *   not advance the turn.
 */
export async function completeIterationRun(
  host: RuntimeCoreTurnProgressHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  resolution: RuntimeResolution,
  manifest: ContextManifest,
  iterationCount: number,
  loopState: LoopState,
  treeHash?: HashString
): Promise<HashString | undefined> {
  let turnNodeHash: HashString | undefined;

  if (resolution.type === "fail" && resolution.fatality === "hard") {
    const completion = await host.completeTrackedRun(handle, runId, "failed", {
      fatality: resolution.fatality,
      message: resolution.error.message,
      turnId: handle.turnId,
      type: "iteration_failed",
    });
    turnNodeHash = completion.turnNodeHash;
  } else {
    const stepEventHash = await host.storeEventRecord({
      iteration: iterationCount,
      turnId: handle.turnId,
      type: "iteration_step_completed",
    });
    const stepResult = await host.completeRunStep(
      runId,
      "iterate",
      stepEventHash,
      treeHash
    );
    host.syncRunLeaseStateFromStepResult(handle, runId, stepResult);
    const completion = await host.completeTrackedRun(
      handle,
      runId,
      resolution.type === "pause" ? "paused" : "completed",
      resolution.type === "pause"
        ? {
            reason: resolution.reason,
            turnId: handle.turnId,
            type: "paused",
          }
        : {
            iteration: iterationCount,
            turnId: handle.turnId,
            type: "iteration_completed",
          }
    );
    turnNodeHash = completion.turnNodeHash ?? stepResult.turnNodeHash;
  }

  if (turnNodeHash !== undefined) {
    await host.advanceTurnAndBranchHead(handle, turnNodeHash);
    await host.emitStateObservability(
      handle,
      loopState,
      turnNodeHash,
      iterationCount,
      manifest
    );
  }

  return turnNodeHash;
}

/**
 * Create the turn tree for a completed iteration.
 *
 * The tree extends `baseTurnTreeHash` with the full ordered message list
 * (base hashes followed by the iteration's appended hashes), the new
 * context-manifest hash, and — when provided — a `runtime.status` hash.
 *
 * @returns Hash of the newly created turn tree.
 */
export async function createIterationTree(
  host: RuntimeCoreTurnProgressHost,
  schemaId: string,
  baseTurnTreeHash: HashString,
  baseMessageHashes: HashString[],
  appendedMessageHashes: HashString[],
  manifestHash: HashString,
  runtimeStatusHash?: HashString
): Promise<HashString> {
  const changes: Record<string, PathValue> = {
    "context.manifest": manifestHash,
    messages: [...baseMessageHashes, ...appendedMessageHashes],
  };

  if (runtimeStatusHash !== undefined) {
    changes["runtime.status"] = runtimeStatusHash;
  }

  return await host.treeCreate(schemaId, changes, baseTurnTreeHash);
}

/**
 * Fail a tracked run while keeping the branch head at its stable position.
 *
 * Completes the run as `failed`; if that completion produced a turn node
 * (which would otherwise advance the branch), the branch head is reset to
 * `stableHeadTurnNodeHash` so failed iteration work is not observable on the
 * branch.
 */
export async function failTrackedRunWithoutBranchAdvance(
  host: RuntimeCoreTurnProgressHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  stableHeadTurnNodeHash: HashString
): Promise<void> {
  const completion = await host.completeTrackedRun(handle, runId, "failed");

  if (completion.turnNodeHash === undefined) {
    return;
  }

  await host.branchSetHead(handle.request.branchId, stableHeadTurnNodeHash);
}

/**
 * Reconcile a durable pause checkpoint with the iteration's final
 * resolution.
 *
 * When a pause was checkpointed but the runner ultimately resolved to
 * something other than `pause`, the checkpointed paused run is overridden
 * via {@link resolveCheckpointedPausedRun}; otherwise this is a no-op.
 *
 * @returns The resolution, unchanged.
 */
export async function reconcileCheckpointedPauseResolution(
  host: RuntimeCoreTurnProgressHost,
  checkpointedPause: boolean,
  runId: string,
  turnId: string,
  resolution: RuntimeResolution
): Promise<RuntimeResolution> {
  if (!checkpointedPause || resolution.type === "pause") {
    return resolution;
  }

  await resolveCheckpointedPausedRun(host, runId, turnId, resolution);
  return resolution;
}

/**
 * Override a kernel run that was durably checkpointed as paused.
 *
 * Completes the run as `failed` with a `paused_run_overridden` event that
 * records the superseding resolution type (and, for failures, its fatality
 * and message), so the durable pause cannot be resumed later.
 */
export async function resolveCheckpointedPausedRun(
  host: RuntimeCoreTurnProgressHost,
  runId: string,
  turnId: string,
  resolution: RuntimeResolution
): Promise<void> {
  if (resolution.type === "fail") {
    await host.completeKernelRun(
      runId,
      "failed",
      await host.storeEventRecord({
        fatality: resolution.fatality,
        message: resolution.error.message,
        resolutionType: resolution.type,
        turnId,
        type: "paused_run_overridden",
      })
    );
    return;
  }

  await host.completeKernelRun(
    runId,
    "failed",
    await host.storeEventRecord({
      resolutionType: resolution.type,
      turnId,
      type: "paused_run_overridden",
    })
  );
}
