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

import type { HashString, KernelRecord } from "@tuvren/core";
import type {
  ContextManifest,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { PathValue, RunCompletionStatus } from "@tuvren/kernel-protocol";
import { updateContextManifest } from "./context-manifest.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type { DurableRuntimeStatus } from "./runtime-core-recovery.js";
import { resolutionToPhase } from "./runtime-core-response.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

export interface RuntimeCoreStatusHost {
  advanceTurnAndBranchHead(
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ): Promise<void>;
  beginRunStep(runId: string, stepId: string): Promise<void>;
  completeRunStep(
    runId: string,
    stepId: string,
    eventHash: HashString,
    treeHash?: HashString
  ): Promise<{
    lease?: { fencingToken: string; leaseExpiresAtMs: number };
    turnNodeHash?: HashString;
  }>;
  completeTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    status: RunCompletionStatus,
    event?: KernelRecord
  ): Promise<{ turnNodeHash?: HashString }>;
  createId(): string;
  createTrackedRun(
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
  ): Promise<void>;
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): Promise<void>;
  loadHeadState(branchId: string): Promise<HeadState>;
  stageManifest(
    runId: string,
    manifest: ContextManifest,
    warningContext?: {
      handle: RuntimeExecutionHandle;
      loopState: LoopState;
    }
  ): Promise<HashString>;
  stageRuntimeStatus(
    runId: string,
    status: DurableRuntimeStatus,
    taskId: string
  ): Promise<HashString>;
  storeEventRecord(event: KernelRecord): Promise<HashString>;
  syncRunLeaseStateFromStepResult(
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: number } }
  ): void;
  treeCreate(
    schemaId: string,
    changes: Record<string, PathValue>,
    baseTurnTreeHash: HashString
  ): Promise<HashString>;
}

export async function failActiveRunIfNeeded(
  host: RuntimeCoreStatusHost,
  handle: RuntimeExecutionHandle
): Promise<void> {
  const activeRunId = handle.takeActiveRunId();

  if (activeRunId === undefined) {
    return;
  }

  await host.completeTrackedRun(handle, activeRunId, "failed");
}

export async function finalizeTurnStatus(
  host: RuntimeCoreStatusHost,
  handle: RuntimeExecutionHandle,
  resolution: RuntimeResolution,
  partial: boolean,
  loopState: LoopState
): Promise<void> {
  const phase = resolutionToPhase(resolution);
  const headState = await host.loadHeadState(handle.request.branchId);
  const runId = host.createId();
  await host.createTrackedRun(
    handle,
    runId,
    handle.turnId,
    handle.request.branchId,
    handle.schemaId,
    headState.branchHeadHash,
    [
      {
        deterministic: false,
        id: "finalize_turn_status",
        sideEffects: false,
      },
    ]
  );
  await host.beginRunStep(runId, "finalize_turn_status");
  await host.stageRuntimeStatus(
    runId,
    {
      activeAgent: loopState.activeConfig.name,
      partial: phase === "failed" && partial ? true : undefined,
      state: phase,
    },
    "runtime_status_final"
  );
  const stepResult = await completeRunStep(
    host,
    handle,
    runId,
    {
      status: phase,
      turnId: handle.turnId,
      type: "turn_status_finalized",
    },
    "finalize_turn_status"
  );
  await host.completeTrackedRun(handle, runId, "completed");

  if (stepResult.turnNodeHash !== undefined) {
    await host.advanceTurnAndBranchHead(handle, stepResult.turnNodeHash);
    await host.emitStateObservability(
      handle,
      loopState,
      stepResult.turnNodeHash,
      handle.status().iterationCount
    );
  }
}

export async function checkpointResumeRunningStatus(
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
  const headState = await host.loadHeadState(handle.request.branchId);
  const nextManifest =
    loopState.carriedStateUpdates.length === 0
      ? headState.manifest
      : updateContextManifest(
          headState.manifest,
          [],
          loopState.carriedStateUpdates
        );
  const runId = host.createId();
  await host.createTrackedRun(
    handle,
    runId,
    handle.turnId,
    handle.request.branchId,
    schemaId,
    headState.branchHeadHash,
    [
      {
        deterministic: false,
        id: "resume_running_status",
        sideEffects: false,
      },
    ]
  );
  await host.beginRunStep(runId, "resume_running_status");
  const runtimeStatusHash = await host.stageRuntimeStatus(
    runId,
    {
      activeAgent: loopState.activeConfig.name,
      state: "running",
    },
    "runtime_status_running"
  );
  const changes: Record<string, PathValue> = {
    "runtime.status": runtimeStatusHash,
  };

  if (loopState.carriedStateUpdates.length > 0) {
    changes["context.manifest"] = await host.stageManifest(
      runId,
      nextManifest,
      {
        handle,
        loopState,
      }
    );
  }

  const nextTreeHash = await host.treeCreate(
    schemaId,
    changes,
    headState.turnNode.turnTreeHash
  );
  const stepResult = await completeRunStep(
    host,
    handle,
    runId,
    {
      iteration: iterationCount,
      turnId: handle.turnId,
      type: "runtime_status_resumed",
    },
    "resume_running_status",
    nextTreeHash
  );
  await host.completeTrackedRun(handle, runId, "completed");

  if (stepResult.turnNodeHash !== undefined) {
    await host.advanceTurnAndBranchHead(handle, stepResult.turnNodeHash);

    const pendingStateObservability = {
      iterationCount,
      manifest:
        loopState.carriedStateUpdates.length === 0 ? undefined : nextManifest,
      turnNodeHash: stepResult.turnNodeHash,
    };

    if (emitObservability) {
      await host.emitStateObservability(
        handle,
        loopState,
        pendingStateObservability.turnNodeHash,
        pendingStateObservability.iterationCount,
        pendingStateObservability.manifest
      );
    }

    handle.updateStatus({
      activeAgent: loopState.activeConfig.name,
      iterationCount,
      manifest: nextManifest,
      phase: "running",
    });
    loopState.carriedStateUpdates = [];
    return pendingStateObservability;
  }

  handle.updateStatus({
    activeAgent: loopState.activeConfig.name,
    iterationCount,
    manifest: nextManifest,
    phase: "running",
  });
  loopState.carriedStateUpdates = [];
  return undefined;
}

async function completeRunStep(
  host: RuntimeCoreStatusHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  event: KernelRecord,
  stepId: string,
  treeHash?: HashString
) {
  const stepResult = await host.completeRunStep(
    runId,
    stepId,
    await host.storeEventRecord(event),
    treeHash
  );
  host.syncRunLeaseStateFromStepResult(handle, runId, stepResult);
  return stepResult;
}
