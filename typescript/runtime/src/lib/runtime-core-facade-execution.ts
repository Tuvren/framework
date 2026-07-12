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

import type { HashString } from "@tuvren/core";
import { TuvrenRuntimeError } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  ContextEngineeringPlan,
  ContextManifest,
  HandoffContextBuilder,
  HandoffContextPlan,
  InputSignal,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type {
  ToolCallPart,
  ToolResultPart,
  TuvrenMessage,
} from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import type {
  RunnerExecutionContext,
  RuntimeRunner,
} from "@tuvren/core/runner";
import type { ApprovalResponse } from "@tuvren/core/tools";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import {
  applyRuntimeAfterIterationResolutionFacade,
  applyRuntimeContextEngineeringPlanFacade,
  applyRuntimeRequestedToolBatchIfNeededFacade,
  commitRuntimePendingExtensionStateUpdatesFacade,
  completeRuntimeIterationArtifactsFacade,
  completeRuntimeIterationRunFacade,
  createRuntimeIterationTreeFacade,
  createRuntimeRunnerExecutionContextFacade,
  createRuntimeRunnerHandoffContextPlanFacade,
  createRuntimeToolBatchEnvironmentFacade,
  incorporateRuntimeInputFacade,
  incorporateRuntimeSteeringFacade,
  resumeRuntimePausedToolExecutionFacade,
  stageRuntimeRunnerMessagesFacade,
} from "./runtime-core-execution-orchestration.js";
import type { RuntimeCoreFacadeHosts } from "./runtime-core-facade-hosts.js";
import {
  completeExecution as completeRuntimeExecution,
  handleExecutionFailure as handleRuntimeExecutionFailure,
  publishApprovalResolved as publishRuntimeApprovalResolved,
  publishPauseOutcome as publishRuntimePauseOutcome,
} from "./runtime-core-finalization.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type {
  ExpiredExecutionRecovery,
  LoopOutcome,
} from "./runtime-core-recovery.js";
import { executeRunner as executeRuntimeRunner } from "./runtime-core-runner-support.js";
import {
  createExecutionLoopState as createRuntimeExecutionLoopState,
  createExecutionTurnIfNeeded as createRuntimeExecutionTurnIfNeeded,
  finishResumedExecutionStart as finishRuntimeResumedExecutionStart,
  prepareFreshExecutionStart as prepareRuntimeFreshExecutionStart,
  publishTurnStart as publishRuntimeTurnStart,
  resolveExecutionBranchHead as resolveRuntimeExecutionBranchHead,
} from "./runtime-core-startup.js";
import { failActiveRunIfNeeded as failRuntimeActiveRunIfNeeded } from "./runtime-core-status.js";
import { failTrackedRunWithoutBranchAdvance as failRuntimeTrackedRunWithoutBranchAdvance } from "./runtime-core-turn-progress.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { PauseContext, ResumeContext } from "./runtime-execution-types.js";
import type {
  ToolBatchEnvironment,
  ToolExecutionMode,
} from "./tool-execution.js";

export async function resolveRuntimeCoreExecutionBranchHead(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle
): Promise<HashString> {
  return await resolveRuntimeExecutionBranchHead(
    hosts.startup,
    handle.request.branchId,
    handle.request.threadId
  );
}

export async function createRuntimeCoreExecutionTurnIfNeeded(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  branchHeadHash: HashString,
  reuseRecoveredTurn: boolean
): Promise<void> {
  await createRuntimeExecutionTurnIfNeeded(
    hosts.startup,
    handle,
    branchHeadHash,
    reuseRecoveredTurn
  );
}

export function createRuntimeCoreExecutionLoopState(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  recoveredExecution?: ExpiredExecutionRecovery
): LoopState {
  return createRuntimeExecutionLoopState(
    hosts.startup,
    handle,
    recoveredExecution
  );
}

export function publishRuntimeCoreTurnStart(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  loopState: LoopState
): void {
  publishRuntimeTurnStart(hosts.startup, handle, loopState);
}

export async function prepareRuntimeCoreFreshExecutionStart(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  recoveredExecutionMode: ExpiredExecutionRecovery["mode"],
  recoveredIterationCount: number | undefined,
  needsInputReincorporation: boolean | undefined,
  incorporateInput: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ) => Promise<void>
): Promise<boolean> {
  return await prepareRuntimeFreshExecutionStart(
    hosts.startup,
    handle,
    schemaId,
    loopState,
    recoveredExecutionMode,
    recoveredIterationCount,
    needsInputReincorporation ?? false,
    incorporateInput
  );
}

export async function finishRuntimeCoreResumedExecutionStart(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState
): Promise<boolean> {
  return await finishRuntimeResumedExecutionStart(
    hosts.startup,
    handle,
    schemaId,
    loopState
  );
}

export function publishRuntimeCorePauseOutcome(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  pauseContext: PauseContext | undefined,
  loopState: LoopState
): boolean {
  return publishRuntimePauseOutcome(
    hosts.finalization,
    handle,
    pauseContext,
    loopState
  );
}

export function publishRuntimeCoreApprovalResolved(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  response: ApprovalResponse | undefined,
  loopState: LoopState
): void {
  publishRuntimeApprovalResolved(
    hosts.finalization,
    handle,
    response,
    loopState
  );
}

export async function handleRuntimeCoreExecutionFailure(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  error: unknown
): Promise<void> {
  await handleRuntimeExecutionFailure(
    hosts.finalization,
    handle,
    error,
    async (failedHandle) =>
      await failRuntimeActiveRunIfNeeded(hosts.status, failedHandle)
  );
}

export async function completeRuntimeCoreExecution(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  resolution: RuntimeResolution,
  partial: boolean,
  loopState: LoopState,
  enteredIterationLoop: boolean
): Promise<void> {
  await completeRuntimeExecution(
    hosts.finalization,
    handle,
    resolution,
    partial,
    loopState,
    enteredIterationLoop
  );
}

export async function failRuntimeCoreInvalidPauseResolutionIfNeeded(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  iterationRunId: string,
  stableHeadTurnNodeHash: HashString,
  requestedToolCallCount: number,
  resolution: RuntimeResolution
): Promise<
  | {
      kind: "outcome";
      outcome: LoopOutcome;
    }
  | undefined
> {
  if (resolution.type !== "pause" || requestedToolCallCount > 0) {
    return undefined;
  }

  const invalidPauseResolution = new TuvrenRuntimeError(
    "shared core only permits approval pauses that originate from requested tool calls",
    {
      code: "invalid_runner_resolution",
      details: {
        resolutionType: resolution.type,
        toolCallCount: requestedToolCallCount,
      },
    }
  );
  await failRuntimeTrackedRunWithoutBranchAdvance(
    hosts.turnProgress,
    handle,
    iterationRunId,
    stableHeadTurnNodeHash
  );
  return {
    kind: "outcome",
    outcome: {
      resolution: {
        error: invalidPauseResolution,
        fatality: "hard",
        type: "fail",
      },
    },
  };
}

export function createRuntimeCoreRunnerExecutionContext(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  headState: HeadState,
  iterationCount: number,
  emittedRunnerEvents: TuvrenStreamEvent[]
): RunnerExecutionContext {
  return createRuntimeRunnerExecutionContextFacade(
    hosts.runner,
    handle,
    schemaId,
    loopState,
    headState,
    iterationCount,
    emittedRunnerEvents
  );
}

export async function stageRuntimeCoreRunnerMessages(
  hosts: RuntimeCoreFacadeHosts,
  runId: string,
  messages: TuvrenMessage[],
  iterationCount: number
): Promise<HashString[]> {
  return await stageRuntimeRunnerMessagesFacade(
    hosts.runner,
    runId,
    messages,
    iterationCount
  );
}

export async function applyRuntimeCoreRequestedToolBatchIfNeeded(
  hosts: RuntimeCoreFacadeHosts,
  input: {
    handle: RuntimeExecutionHandle;
    headState: HeadState;
    iterationCount: number;
    loopState: LoopState;
    requestedToolCalls: ToolCallPart[];
    resolution: RuntimeResolution;
    runId: string;
    stagedMessageHashes: HashString[];
    stagedMessages: TuvrenMessage[];
    toolExecutionMode: ToolExecutionMode;
    toolResults: ToolResultPart[];
  }
): Promise<LoopOutcome | RuntimeResolution> {
  return await applyRuntimeRequestedToolBatchIfNeededFacade(
    hosts.runner,
    input
  );
}

export async function completeRuntimeCoreIterationArtifacts(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  headState: HeadState,
  iterationCount: number,
  runId: string,
  resolution: RuntimeResolution,
  manifest: ContextManifest,
  appendedMessageHashes: HashString[]
): Promise<HashString | undefined> {
  return await completeRuntimeIterationArtifactsFacade(
    hosts.runner,
    handle,
    schemaId,
    loopState,
    headState,
    iterationCount,
    runId,
    resolution,
    manifest,
    appendedMessageHashes
  );
}

export async function applyRuntimeCoreAfterIterationResolution(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  iterationCount: number,
  runId: string,
  resolution: RuntimeResolution,
  response: TuvrenModelResponse,
  toolResults: ToolResultPart[],
  headMessages: TuvrenMessage[],
  stagedMessages: TuvrenMessage[],
  manifest: ContextManifest
): Promise<RuntimeResolution> {
  return await applyRuntimeAfterIterationResolutionFacade(
    hosts.runner,
    handle,
    loopState,
    iterationCount,
    runId,
    resolution,
    response,
    toolResults,
    headMessages,
    stagedMessages,
    manifest
  );
}

export async function resumeRuntimeCorePausedToolExecution(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  resumeContext: ResumeContext
): Promise<LoopOutcome> {
  return await resumeRuntimePausedToolExecutionFacade(
    hosts.toolResume,
    handle,
    schemaId,
    loopState,
    resumeContext
  );
}

export function createRuntimeCoreToolBatchEnvironment(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  manifest: ContextManifest,
  iterationCount: number,
  runId: string
): ToolBatchEnvironment {
  return createRuntimeToolBatchEnvironmentFacade(
    hosts.runnerSupport,
    handle,
    loopState,
    manifest,
    iterationCount,
    runId
  );
}

export function createRuntimeCoreRunnerHandoffContextPlan(
  hosts: RuntimeCoreFacadeHosts,
  input: {
    builder?: HandoffContextBuilder;
    mode?: string;
    payload?: unknown;
    reason: string;
    targetAgent: string;
  },
  headState: HeadState,
  loopState: LoopState
): HandoffContextPlan {
  return createRuntimeRunnerHandoffContextPlanFacade(
    hosts.runnerSupport,
    input,
    headState,
    loopState
  );
}

export async function executeRuntimeCoreRunnerCall(
  runner: RuntimeRunner,
  context: RunnerExecutionContext
) {
  return await executeRuntimeRunner(runner, context);
}

export async function completeRuntimeCoreIterationRun(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  runId: string,
  resolution: RuntimeResolution,
  manifest: ContextManifest,
  iterationCount: number,
  loopState: LoopState,
  treeHash?: HashString
): Promise<HashString | undefined> {
  return await completeRuntimeIterationRunFacade(
    hosts.turnProgress,
    handle,
    runId,
    resolution,
    manifest,
    iterationCount,
    loopState,
    treeHash
  );
}

export async function createRuntimeCoreIterationTree(
  hosts: RuntimeCoreFacadeHosts,
  schemaId: string,
  baseTurnTreeHash: HashString,
  baseMessageHashes: HashString[],
  appendedMessageHashes: HashString[],
  manifestHash: HashString,
  runtimeStatusHash?: HashString
): Promise<HashString> {
  return await createRuntimeIterationTreeFacade(
    hosts.turnProgress,
    schemaId,
    baseTurnTreeHash,
    baseMessageHashes,
    appendedMessageHashes,
    manifestHash,
    runtimeStatusHash
  );
}

export async function incorporateRuntimeCoreInput(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState
): Promise<void> {
  await incorporateRuntimeInputFacade(
    hosts.stateCommit,
    handle,
    schemaId,
    loopState
  );
}

export async function incorporateRuntimeCoreSteering(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  signal: InputSignal,
  loopState: LoopState
): Promise<void> {
  await incorporateRuntimeSteeringFacade(
    hosts.stateCommit,
    handle,
    schemaId,
    signal,
    loopState
  );
}

export async function commitRuntimeCorePendingExtensionStateUpdates(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  updates: ExtensionStateUpdate[],
  iterationCount: number
): Promise<void> {
  await commitRuntimePendingExtensionStateUpdatesFacade(
    hosts.stateCommit,
    handle,
    schemaId,
    loopState,
    updates,
    iterationCount
  );
}

export async function applyRuntimeCoreContextEngineeringPlan(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  plan: ContextEngineeringPlan,
  loopState: LoopState,
  updates: ExtensionStateUpdate[]
): Promise<void> {
  await applyRuntimeContextEngineeringPlanFacade(
    hosts.contextOps,
    handle,
    schemaId,
    plan,
    loopState,
    updates
  );
}
