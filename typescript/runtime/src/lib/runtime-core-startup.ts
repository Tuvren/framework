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
import type {
  ContextManifest,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { ToolRegistry } from "@tuvren/core/tools";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import { runBeforeTurnHooks } from "./extension-runtime.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import {
  createCancelledLoopOutcome,
  type ExpiredExecutionRecovery,
} from "./runtime-core-recovery.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { ExecutionSessionRequest } from "./runtime-execution-types.js";

/**
 * Capability surface the execution-startup helpers require from the runtime
 * core.
 *
 * The startup helpers in this module are pure orchestration: every kernel,
 * event, and configuration effect is delegated through this host so the
 * runtime core facade can supply its own implementations while the startup
 * sequencing stays testable in isolation.
 */
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
    config: LoopState["activeConfig"],
    clientEndpointBoundary?: import("@tuvren/core/capabilities").ClientEndpointBoundary
  ): ToolRegistry;
  createClientEndpointBoundaryFromConfig(
    config: LoopState["activeConfig"]
  ): import("@tuvren/core/capabilities").ClientEndpointBoundary | undefined;
  createId(): string;
  defaultRunnerId(): string;
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

/**
 * Build the initial {@link LoopState} for an execution session.
 *
 * When the handle resumes a paused turn, the paused runner id, tool registry,
 * client endpoint boundary, and carried extension-state updates are restored
 * from the pause context so the resumed turn continues with the exact
 * instances it paused with; otherwise fresh instances are derived from the
 * resolved active config and the request.
 *
 * @param host - Runtime capability surface used to resolve config, tools, and
 *   client endpoint boundaries.
 * @param handle - Execution handle whose request (and optional resume
 *   context) seeds the state.
 * @param recoveredExecution - Recovery record from an expired execution, used
 *   by the host when resolving the active config.
 * @returns A fresh loop state with `enteredIterationLoop` set to `false`.
 */
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

  // Create the client endpoint boundary from the config (if any client
  // endpoints are configured). When resuming a paused turn, reuse the
  // existing boundary from the pause context so the same endpoint instances
  // are used throughout the turn's lifetime. (KRT-AZ001)
  const clientEndpointBoundary =
    resumedPauseContext?.clientEndpointBoundary ??
    host.createClientEndpointBoundaryFromConfig(initialActiveConfig);

  return {
    activeConfig: initialActiveConfig,
    activeRunnerId:
      resumedPauseContext?.activeRunnerId ??
      handle.request.runnerId ??
      host.defaultRunnerId(),
    activeToolRegistry:
      resumedPauseContext?.activeToolRegistry ??
      host.createActiveToolRegistry(
        handle.request.tools,
        initialActiveConfig,
        clientEndpointBoundary
      ),
    carriedStateUpdates: [...(resumedPauseContext?.carriedStateUpdates ?? [])],
    clientEndpointBoundary,
    enteredIterationLoop: false,
  };
}

/**
 * Create the kernel turn record for a fresh execution, if one is needed.
 *
 * Skipped entirely when the handle resumes a paused turn or when a recovered
 * turn is being reused (`reuseRecoveredTurn`), since the turn already exists
 * in the kernel in both cases. Otherwise the parent turn id is resolved
 * (validating branch lineage via the host) and a new turn is created against
 * the given branch head.
 *
 * @param branchHeadHash - Branch head the new turn is anchored to.
 * @param reuseRecoveredTurn - `true` when recovery already assigned an
 *   existing turn id to the handle.
 */
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

/**
 * Publish the `turn.start` stream event for this execution.
 *
 * When the handle resumes a paused turn, the event carries the paused turn
 * node hash as `resumedFrom` so consumers can correlate the resumption with
 * the original pause point.
 */
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

/**
 * Run the fresh-start prelude before the iteration loop is entered.
 *
 * Incorporates the request input (unless recovery already did, and only when
 * an `incorporateInput` callback is supplied), loads the branch head state,
 * moves the handle status to `running`, and runs the extensions'
 * before-turn hooks. State updates produced by the hooks are carried on the
 * loop state for the first iteration to commit.
 *
 * The prelude can short-circuit the whole execution: when a before-turn hook
 * yields a resolution, a soft failure is projected as a non-fatal error event
 * (and the loop still runs), while any other resolution commits the pending
 * extension-state updates and completes the execution immediately.
 *
 * @param recoveredExecutionMode - Recovery mode; `"skip_fresh_prelude"`
 *   suppresses the before-turn hooks while still restoring running status.
 * @param recoveredIterationCount - Iteration count restored from a recovered
 *   execution; defaults to `0` for a truly fresh start.
 * @param needsInputReincorporation - Forces input incorporation even when a
 *   recovery mode is present.
 * @param incorporateInput - Callback that incorporates the request signal
 *   into the branch; omitted by callers that already incorporated it.
 * @returns `true` when the execution was completed by a before-turn hook
 *   resolution and the caller must not enter the iteration loop.
 */
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

/**
 * Run the resume-side prelude for an execution resumed from a pause.
 *
 * Marks the paused run as `failed` (recording a `paused_run_resolved` event
 * so the pause is durably resolved) and checkpoints the running status at the
 * paused iteration count. The state-observability emission produced by that
 * checkpoint is deferred to the caller, which publishes it only after
 * `turn.start` so the event order stays stable.
 *
 * @returns `undefined` when the handle is not resuming (fresh start);
 *   otherwise `{ completed: false, pendingStateObservability }` where the
 *   pending observability payload, if present, must be emitted by the caller.
 */
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

/**
 * Complete the resume-side startup by replaying the paused tool execution.
 *
 * Handles, in order: a cancellation that arrived while paused (completing the
 * execution with the cancelled resolution), the actual resumed tool
 * execution, a re-pause outcome (published and left pending), a soft failure
 * (projected as a non-fatal error, letting the loop continue), and a terminal
 * resolution (optionally routed through a terminal agent transition before
 * completing the execution).
 *
 * @returns `true` when the execution reached a terminal outcome (completed,
 *   cancelled, or re-paused) and the caller must not enter the iteration
 *   loop; `false` when the loop should run, including for a fresh
 *   (non-resumed) handle.
 */
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

/**
 * Resolve the current head turn-node hash of the execution's branch via the
 * host.
 */
export async function resolveExecutionBranchHead(
  host: RuntimeCoreStartupHost,
  branchId: string,
  threadId: string
): Promise<HashString> {
  return await host.resolveBranchHeadHash(branchId, threadId);
}
