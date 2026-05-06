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

import type { HashString } from "@tuvren/core-types";
import type {
  ApprovalResponse,
  ContextManifest,
  RuntimeResolution,
} from "@tuvren/runtime-api";
import { cloneAgentConfigForRequest } from "./runtime-core-facade-utils.js";
import type { LoopState } from "./runtime-core-loop.js";
import type {
  ExpiredExecutionRecovery,
  LoopOutcome,
} from "./runtime-core-recovery.js";
import { createStaleRecoveryContendedError } from "./runtime-core-response.js";
import {
  RuntimeExecutionHandle,
  type RuntimeExecutionHandleRuntime,
} from "./runtime-execution-handle.js";
import type {
  ExecutionSessionRequest,
  PauseContext,
} from "./runtime-execution-types.js";

interface RuntimeExecutionStartDependencies {
  completeExecution(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    partial: boolean,
    loopState: LoopState,
    enteredIterationLoop: boolean
  ): Promise<void>;
  completeRecoveredTerminalExecution(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    recoveredExecution: ExpiredExecutionRecovery
  ): Promise<void>;
  createExecutionLoopState(
    handle: RuntimeExecutionHandle,
    recoveredExecution?: ExpiredExecutionRecovery
  ): LoopState;
  createExecutionTurnIfNeeded(
    handle: RuntimeExecutionHandle,
    branchHeadHash: HashString,
    reuseRecoveredTurn: boolean
  ): Promise<void>;
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): void;
  finishResumedExecutionStart(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<boolean>;
  handleExecutionFailure(
    handle: RuntimeExecutionHandle,
    error: unknown
  ): Promise<void>;
  prepareFreshExecutionStart(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    recoveredExecutionMode: ExpiredExecutionRecovery["mode"],
    recoveredIterationCount?: number,
    needsInputReincorporation?: boolean
  ): Promise<boolean>;
  prepareResumedExecutionStartPrelude(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<
    | {
        completed: boolean;
        pendingStateObservability?: {
          iterationCount: number;
          manifest?: ContextManifest;
          turnNodeHash: HashString;
        };
      }
    | undefined
  >;
  publishApprovalResolved(
    handle: RuntimeExecutionHandle,
    response: ApprovalResponse | undefined,
    loopState: LoopState
  ): void;
  publishPauseOutcome(
    handle: RuntimeExecutionHandle,
    pauseContext: PauseContext | undefined,
    loopState: LoopState
  ): boolean;
  publishTurnStart(handle: RuntimeExecutionHandle, loopState: LoopState): void;
  recoverExpiredExecutionBranchIfNeeded(
    branchId: string,
    signal: ExecutionSessionRequest["signal"]
  ): Promise<ExpiredExecutionRecovery | undefined>;
  resolveExecutionBranchHead(
    handle: RuntimeExecutionHandle
  ): Promise<HashString>;
  resolveExecutionSchemaId(request: ExecutionSessionRequest): Promise<string>;
  runExecutionLoop(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<LoopOutcome>;
  stopRunLeaseLoop(handle: RuntimeExecutionHandle): void;
}

export function createRuntimeExecutionHandle(
  owner: RuntimeExecutionHandleRuntime,
  request: ExecutionSessionRequest,
  createId: () => string,
  defaultAgentSchemaId: string,
  createFrozenSnapshot: <T>(value: T) => T,
  normalizeInputSignal: (
    signal: ExecutionSessionRequest["signal"],
    label: string
  ) => ExecutionSessionRequest["signal"]
): RuntimeExecutionHandle {
  const normalizedSignal = normalizeInputSignal(
    request.signal,
    "request.signal"
  );

  return new RuntimeExecutionHandle(
    owner,
    {
      ...request,
      config: cloneAgentConfigForRequest(request.config),
      tools:
        request.tools === undefined
          ? undefined
          : createFrozenSnapshot(request.tools),
      signal: normalizedSignal,
    },
    createId(),
    request.schemaId ?? defaultAgentSchemaId
  );
}

export function createRuntimeResumedExecutionHandle(
  owner: RuntimeExecutionHandleRuntime,
  previousHandle: RuntimeExecutionHandle,
  pauseContext: PauseContext,
  response: ApprovalResponse
): RuntimeExecutionHandle {
  const handle = new RuntimeExecutionHandle(
    owner,
    {
      ...previousHandle.request,
      config: cloneAgentConfigForRequest(pauseContext.activeConfig),
      driverId: pauseContext.activeDriverId,
    },
    previousHandle.turnId,
    previousHandle.schemaId,
    {
      approval: response,
      pauseContext,
      pausedRunId: pauseContext.pausedRunId,
      pausedTurnNodeHash: pauseContext.pausedTurnNodeHash,
    }
  );
  handle.reuseDriverCache(previousHandle);
  previousHandle.moveSteeringQueueTo(handle);
  handle.primeResumedCancellation(pauseContext);
  handle.replaceStatus({
    activeAgent: pauseContext.activeConfig.name,
    iterationCount: previousHandle.status().iterationCount,
    manifest: previousHandle.status().manifest,
    phase: "running",
  });
  return handle;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Session startup intentionally linearizes recovery, resume, publication, and prelude checkpoints in one place.
export async function startRuntimeExecutionSession(
  dependencies: RuntimeExecutionStartDependencies,
  handle: RuntimeExecutionHandle
): Promise<void> {
  try {
    const pendingPausedCancellation = handle.getPendingPausedCancellation();

    if (pendingPausedCancellation !== undefined) {
      await pendingPausedCancellation;
      return;
    }

    if (handle.status().phase !== "running") {
      return;
    }

    if (handle.resumedFrom === undefined && handle.abortSignal.aborted) {
      return;
    }

    const schemaId = await dependencies.resolveExecutionSchemaId(
      handle.request
    );
    handle.setSchemaId(schemaId);
    const initialBranchHeadHash =
      await dependencies.resolveExecutionBranchHead(handle);
    const recoveredExecution =
      await dependencies.recoverExpiredExecutionBranchIfNeeded(
        handle.request.branchId,
        handle.request.signal
      );

    if (recoveredExecution?.recoveryContended === true) {
      throw createStaleRecoveryContendedError();
    }

    if (recoveredExecution?.turnId !== undefined) {
      handle.setTurnId(recoveredExecution.turnId);
    }

    const branchHeadHash =
      recoveredExecution?.preempted === true
        ? await dependencies.resolveExecutionBranchHead(handle)
        : initialBranchHeadHash;
    await dependencies.createExecutionTurnIfNeeded(
      handle,
      branchHeadHash,
      recoveredExecution?.turnId !== undefined
    );
    const loopState = dependencies.createExecutionLoopState(
      handle,
      recoveredExecution
    );

    const resumedStart = await dependencies.prepareResumedExecutionStartPrelude(
      handle,
      schemaId,
      loopState
    );

    if (resumedStart?.completed === true) {
      return;
    }

    dependencies.publishTurnStart(handle, loopState);

    if (resumedStart !== undefined) {
      dependencies.publishApprovalResolved(
        handle,
        handle.resumedFrom?.approval,
        loopState
      );

      if (resumedStart.pendingStateObservability !== undefined) {
        dependencies.emitStateObservability(
          handle,
          loopState,
          resumedStart.pendingStateObservability.turnNodeHash,
          resumedStart.pendingStateObservability.iterationCount,
          resumedStart.pendingStateObservability.manifest
        );
      }
    }

    if (
      resumedStart !== undefined &&
      (await dependencies.finishResumedExecutionStart(
        handle,
        schemaId,
        loopState
      ))
    ) {
      return;
    }

    if (
      resumedStart === undefined &&
      recoveredExecution?.mode === "complete_terminal_status"
    ) {
      await dependencies.completeRecoveredTerminalExecution(
        handle,
        loopState,
        recoveredExecution
      );
      return;
    }

    if (
      resumedStart === undefined &&
      (await dependencies.prepareFreshExecutionStart(
        handle,
        schemaId,
        loopState,
        recoveredExecution?.mode,
        recoveredExecution?.iterationCount,
        recoveredExecution?.needsInputReincorporation ?? false
      ))
    ) {
      return;
    }

    const outcome = await dependencies.runExecutionLoop(
      handle,
      schemaId,
      loopState
    );

    if (
      dependencies.publishPauseOutcome(handle, outcome.pauseContext, loopState)
    ) {
      return;
    }

    await dependencies.completeExecution(
      handle,
      outcome.resolution,
      outcome.partial ?? false,
      loopState,
      loopState.enteredIterationLoop
    );
  } catch (error: unknown) {
    await dependencies.handleExecutionFailure(handle, error);
  } finally {
    dependencies.stopRunLeaseLoop(handle);
    handle.finish();
  }
}
