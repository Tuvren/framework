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
import type { PathValue, RunCompletionStatus } from "@tuvren/kernel-protocol";
import type { ContextManifest, RuntimeResolution } from "@tuvren/runtime-api";
import type { LoopState } from "./runtime-core-loop.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

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
