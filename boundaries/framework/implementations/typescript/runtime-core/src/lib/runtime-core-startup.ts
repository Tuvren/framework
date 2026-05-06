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
  ContextManifest,
  RuntimeResolution,
  ToolRegistry,
} from "@tuvren/runtime-api";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import { runBeforeTurnHooks } from "./extension-runtime.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import {
  createCancelledLoopOutcome,
  type ExpiredExecutionRecovery,
} from "./runtime-core-recovery.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { ExecutionSessionRequest } from "./runtime-execution-types.js";

export interface RuntimeCoreStartupHost {
  applyTerminalAgentTransitionIfNeeded(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    resolution: RuntimeResolution,
    loopState: LoopState,
    stableHeadTurnNodeHash?: HashString
  ): Promise<boolean>;
  checkpointResumeRunningStatus(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    iterationCount: number,
    emitObservability?: boolean
  ): Promise<
    | {
        iterationCount: number;
        manifest?: ContextManifest;
        turnNodeHash: HashString;
      }
    | undefined
  >;
  commitPendingExtensionStateUpdates(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    updates: ExtensionStateUpdate[],
    iterationCount: number
  ): Promise<void>;
  completeExecution(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    partial: boolean,
    loopState: LoopState,
    enteredIterationLoop: boolean
  ): Promise<void>;
  createActiveToolRegistry(
    runtimeTools: ExecutionSessionRequest["tools"] | undefined,
    config: LoopState["activeConfig"]
  ): ToolRegistry;
  createId(): string;
  defaultDriverId(): string;
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): Promise<void>;
  loadHeadState(branchId: string): Promise<HeadState>;
  now(): number;
  publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void;
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: {
      resumedFrom?: HashString;
      request?: unknown;
      response?: unknown;
      status?: string;
      threadId?: string;
      timestamp: number;
      turnId?: string;
      type: string;
    },
    loopState: LoopState
  ): void;
  publishPauseOutcome(
    handle: RuntimeExecutionHandle,
    pauseContext: unknown,
    loopState: LoopState
  ): boolean;
  publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ): void;
  resolveActiveConfig(
    handle: RuntimeExecutionHandle,
    recoveredExecution?: ExpiredExecutionRecovery
  ): LoopState["activeConfig"];
  resolveBranchHeadHash(
    branchId: string,
    threadId: string
  ): Promise<HashString>;
  resolveParentTurnId(
    threadId: string,
    branchId: string,
    explicitParentTurnId?: string | null
  ): Promise<string | null>;
  resumePausedToolExecution(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    resumeContext: NonNullable<RuntimeExecutionHandle["resumedFrom"]>
  ): Promise<{
    partial?: boolean;
    pauseContext?: unknown;
    resolution: RuntimeResolution;
  }>;
  turnCreate(
    turnId: string,
    threadId: string,
    branchId: string,
    parentTurnId: string | null,
    branchHeadHash: HashString
  ): Promise<void>;
}

export function createExecutionLoopState(
  host: RuntimeCoreStartupHost,
  handle: RuntimeExecutionHandle,
  recoveredExecution?: ExpiredExecutionRecovery
): LoopState {
  const resumedPauseContext = handle.resumedFrom?.pauseContext;
  const initialActiveConfig = host.resolveActiveConfig(
    handle,
    recoveredExecution
  );

  return {
    activeConfig: initialActiveConfig,
    activeDriverId:
      resumedPauseContext?.activeDriverId ??
      handle.request.driverId ??
      host.defaultDriverId(),
    activeToolRegistry:
      resumedPauseContext?.activeToolRegistry ??
      host.createActiveToolRegistry(handle.request.tools, initialActiveConfig),
    carriedStateUpdates: [...(resumedPauseContext?.carriedStateUpdates ?? [])],
    enteredIterationLoop: false,
  };
}

export async function createExecutionTurnIfNeeded(
  host: RuntimeCoreStartupHost,
  handle: RuntimeExecutionHandle,
  branchHeadHash: HashString,
  reuseRecoveredTurn: boolean
): Promise<void> {
  if (handle.resumedFrom !== undefined || reuseRecoveredTurn) {
    return;
  }

  const parentTurnId = await host.resolveParentTurnId(
    handle.request.threadId,
    handle.request.branchId,
    handle.request.parentTurnId
  );

  await host.turnCreate(
    handle.turnId,
    handle.request.threadId,
    handle.request.branchId,
    parentTurnId,
    branchHeadHash
  );
}

export function publishTurnStart(
  host: RuntimeCoreStartupHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState
): void {
  host.publishEvent(
    handle,
    {
      resumedFrom: handle.resumedFrom?.pausedTurnNodeHash,
      threadId: handle.request.threadId,
      timestamp: host.now(),
      turnId: handle.turnId,
      type: "turn.start",
    },
    loopState
  );
}

export async function prepareFreshExecutionStart(
  host: RuntimeCoreStartupHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  recoveredExecutionMode: ExpiredExecutionRecovery["mode"],
  recoveredIterationCount?: number,
  needsInputReincorporation = false,
  incorporateInput?: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ) => Promise<void>
): Promise<boolean> {
  if (
    (recoveredExecutionMode === undefined || needsInputReincorporation) &&
    incorporateInput !== undefined
  ) {
    await incorporateInput(handle, schemaId, loopState);
  }

  const headState = await host.loadHeadState(handle.request.branchId);
  const initialIterationCount = recoveredIterationCount ?? 0;
  handle.updateStatus({
    activeAgent: loopState.activeConfig.name,
    iterationCount: initialIterationCount,
    manifest: headState.manifest,
    phase: "running",
  });

  if (recoveredExecutionMode === "skip_fresh_prelude") {
    return false;
  }

  const beforeTurn = await runBeforeTurnHooks({
    emit: (event) => {
      host.publishCustomEvent(handle, event, loopState);
    },
    extensions: loopState.activeConfig.extensions ?? [],
    iterationCount: initialIterationCount,
    manifest: headState.manifest,
    messages: headState.messages,
    runId: host.createId(),
    turnId: handle.turnId,
  });
  loopState.carriedStateUpdates.push(...beforeTurn.updates);

  if (beforeTurn.resolution === undefined) {
    return false;
  }

  if (
    beforeTurn.resolution.type === "fail" &&
    beforeTurn.resolution.fatality === "soft"
  ) {
    host.publishProjectedError(
      handle,
      beforeTurn.resolution.error,
      false,
      loopState
    );
    return false;
  }

  await host.commitPendingExtensionStateUpdates(
    handle,
    schemaId,
    loopState,
    loopState.carriedStateUpdates,
    0
  );
  loopState.carriedStateUpdates = [];
  await host.completeExecution(
    handle,
    beforeTurn.resolution,
    false,
    loopState,
    false
  );
  return true;
}

export async function prepareResumedExecutionStartPrelude(
  host: RuntimeCoreStartupHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  storeEventRecord: (event: Record<string, unknown>) => Promise<HashString>,
  runComplete: (
    runId: string,
    status: "failed",
    eventHash: HashString
  ) => Promise<unknown>
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
> {
  const resumeContext = handle.resumedFrom;

  if (resumeContext === undefined) {
    return undefined;
  }

  await runComplete(
    resumeContext.pausedRunId,
    "failed",
    await storeEventRecord({
      turnId: handle.turnId,
      type: "paused_run_resolved",
    })
  );
  const pendingStateObservability = await host.checkpointResumeRunningStatus(
    handle,
    schemaId,
    loopState,
    resumeContext.pauseContext.pausedIteration.iterationCount,
    false
  );
  return {
    completed: false,
    pendingStateObservability,
  };
}

export async function finishResumedExecutionStart(
  host: RuntimeCoreStartupHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState
): Promise<boolean> {
  const resumeContext = handle.resumedFrom;

  if (resumeContext === undefined) {
    return false;
  }

  handle.clearPendingResumeCancellation();
  const cancelledOutcome = createCancelledLoopOutcome(handle);

  if (cancelledOutcome !== undefined) {
    await host.completeExecution(
      handle,
      cancelledOutcome.resolution,
      cancelledOutcome.partial ?? false,
      loopState,
      false
    );
    return true;
  }

  const resumedOutcome = await host.resumePausedToolExecution(
    handle,
    schemaId,
    loopState,
    resumeContext
  );

  if (
    host.publishPauseOutcome(handle, resumedOutcome.pauseContext, loopState)
  ) {
    return true;
  }

  if (
    resumedOutcome.resolution.type === "fail" &&
    resumedOutcome.resolution.fatality === "soft"
  ) {
    host.publishProjectedError(
      handle,
      resumedOutcome.resolution.error,
      false,
      loopState
    );
    return false;
  }

  if (
    resumedOutcome.resolution.type !== "continue_iteration" &&
    !(await host.applyTerminalAgentTransitionIfNeeded(
      handle,
      schemaId,
      resumedOutcome.resolution,
      loopState
    ))
  ) {
    await host.completeExecution(
      handle,
      resumedOutcome.resolution,
      resumedOutcome.partial ?? false,
      loopState,
      true
    );
    return true;
  }

  return false;
}

export async function resolveExecutionBranchHead(
  host: RuntimeCoreStartupHost,
  branchId: string,
  threadId: string
): Promise<HashString> {
  return await host.resolveBranchHeadHash(branchId, threadId);
}
