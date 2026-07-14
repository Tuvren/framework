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

/**
 * Resolves the branch head hash the execution starts from, using the branch
 * and thread identifiers on the handle's request.
 *
 * Delegates to the startup host slice of {@link RuntimeCoreFacadeHosts}.
 */
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

/**
 * Creates the kernel turn for this execution when one is needed.
 *
 * The underlying startup flow skips turn creation when the handle resumes a
 * paused turn or when `reuseRecoveredTurn` indicates an expired-execution
 * recovery already owns the turn.
 */
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

/**
 * Builds the initial {@link LoopState} for an execution session, restoring
 * the paused runner id, tool registry, and carried extension-state updates
 * from the pause context when the handle resumes a paused turn.
 *
 * @param recoveredExecution - Recovery record from an expired execution, used
 *   by the startup host when resolving the active config.
 */
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

/**
 * Publishes the `turn.start` stream event for the execution, carrying the
 * paused turn-node hash as `resumedFrom` when the handle resumes a pause.
 */
export function publishRuntimeCoreTurnStart(
  hosts: RuntimeCoreFacadeHosts,
  handle: RuntimeExecutionHandle,
  loopState: LoopState
): void {
  publishRuntimeTurnStart(hosts.startup, handle, loopState);
}

/**
 * Runs the fresh (non-resumed) execution start prelude: input incorporation,
 * initial running-status update, and before-turn extension hooks.
 *
 * Input is incorporated when the execution is not a recovery, or when the
 * recovery flagged that the original input never reached the turn
 * (`needsInputReincorporation`). A `skip_fresh_prelude` recovery mode skips
 * the before-turn hooks entirely.
 *
 * @param incorporateInput - Callback used to commit the request input into
 *   the turn when the prelude requires it.
 * @returns `true` when a before-turn hook produced a terminal resolution and
 *   the execution was completed during the prelude; `false` when the caller
 *   should continue into the iteration loop.
 */
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

/**
 * Finishes the startup path for an execution that resumes a paused turn:
 * honors a pending resume cancellation, replays the paused tool batch, and
 * publishes any resulting pause or terminal outcome.
 *
 * @returns `true` when the resumed outcome terminated the execution (it was
 *   completed, cancelled, or paused again); `false` when the execution should
 *   continue into the iteration loop. Always `false` for non-resumed handles.
 */
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

/**
 * Publishes the pause outcome for an approval pause: remembers the pause
 * context on the handle and emits `approval.requested` followed by a paused
 * `turn.end` event.
 *
 * @returns `true` when a pause context was present and published; `false`
 *   when `pauseContext` is `undefined` and nothing was emitted.
 */
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

/**
 * Publishes the `approval.resolved` stream event for a resolved approval
 * response; a no-op when `response` is `undefined`.
 */
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

/**
 * Handles a fatal execution failure: fails the active tracked run (if any)
 * through the status host, then routes the error through the finalization
 * host so the failure is projected and the turn ends with status `failed`.
 */
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

/**
 * Completes the execution with a terminal runner resolution via the
 * finalization host, finalizing turn status and emitting the closing events.
 *
 * @param partial - Whether the resolution represents a partial completion.
 * @param enteredIterationLoop - Whether the iteration loop actually ran; the
 *   finalization path uses this to distinguish prelude-only completions.
 */
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

/**
 * Rejects a runner `pause` resolution that did not originate from requested
 * tool calls.
 *
 * The shared core only permits approval pauses that carry at least one
 * requested tool call. When a runner returns `pause` with zero requested
 * calls, the tracked iteration run is failed without advancing the branch
 * head and a hard-fail loop outcome with code `invalid_runner_resolution` is
 * returned for the caller to surface.
 *
 * @returns The hard-fail loop outcome when the pause resolution is invalid,
 *   or `undefined` when the resolution is not a pause (or is a valid pause)
 *   and normal processing should continue.
 */
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

/**
 * Builds the {@link RunnerExecutionContext} handed to a runner for one
 * iteration, delegating to the runner host slice.
 *
 * @param emittedRunnerEvents - Sink array that collects the stream events the
 *   runner emits during the iteration.
 */
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

/**
 * Stages the messages produced by a runner iteration into the kernel store.
 *
 * @returns The kernel hashes of the staged messages, in input order.
 */
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

/**
 * Applies the tool batch a runner requested for the current iteration, if
 * any, delegating to the runner host slice.
 *
 * @returns A {@link LoopOutcome} when tool execution decided the iteration
 *   (for example an approval pause), or the possibly-updated
 *   {@link RuntimeResolution} when the loop should keep processing the
 *   iteration result.
 */
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

/**
 * Persists the durable artifacts of a finished iteration (staged manifest,
 * appended messages, and runtime status) via the runner host slice.
 *
 * @returns The new iteration tree hash, or `undefined` when no tree was
 *   produced for this iteration.
 */
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

/**
 * Runs the after-iteration processing for a runner resolution (extension
 * after-iteration hooks over the iteration's response, tool results, and
 * message context) via the runner host slice.
 *
 * @returns The resolution to continue the loop with, which may differ from
 *   the runner's original resolution when a hook overrides it.
 */
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

/**
 * Resumes a tool execution that paused for approval, replaying the paused
 * tool batch with the approval decision carried in `resumeContext`.
 *
 * Delegates to the tool-resume host slice.
 */
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

/**
 * Builds the {@link ToolBatchEnvironment} used to execute a batch of tool
 * calls for the given iteration, delegating to the runner-support host slice.
 */
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

/**
 * Builds the {@link HandoffContextPlan} for a runner-initiated agent handoff,
 * resolving the target agent and default context builder through the
 * runner-support host slice.
 *
 * @param input - Handoff request fields: the target agent name, a reason
 *   string, and an optional explicit builder, mode, and payload.
 */
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

/**
 * Executes a single runner call against the prepared execution context,
 * delegating to the shared runner-support execution path.
 */
export async function executeRuntimeCoreRunnerCall(
  runner: RuntimeRunner,
  context: RunnerExecutionContext
) {
  return await executeRuntimeRunner(runner, context);
}

/**
 * Completes the tracked kernel run for an iteration and advances turn
 * progress via the turn-progress host slice.
 *
 * @returns The turn-node hash the branch advanced to, or `undefined` when the
 *   completion did not advance the branch head.
 */
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

/**
 * Creates the kernel tree node for an iteration from the base turn tree, the
 * base and appended message hashes, the staged manifest hash, and an optional
 * runtime-status hash.
 *
 * @returns The hash of the created iteration tree.
 */
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

/**
 * Commits the execution request's input into the turn as durable state via
 * the state-commit host slice.
 */
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

/**
 * Commits a mid-turn steering {@link InputSignal} into the turn as durable
 * state via the state-commit host slice.
 */
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

/**
 * Commits pending {@link ExtensionStateUpdate} entries into the turn's
 * durable manifest state via the state-commit host slice.
 */
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

/**
 * Applies a {@link ContextEngineeringPlan} (context rewriting requested by an
 * extension or host) to the turn via the context-ops host slice, committing
 * the resulting state alongside any pending extension-state updates.
 */
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
