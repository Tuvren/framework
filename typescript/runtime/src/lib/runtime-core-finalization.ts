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

import type { RuntimeResolution } from "@tuvren/core/execution";
import type { ApprovalResponse } from "@tuvren/core/tools";
import { runAfterTurnHooks } from "./extension-runtime.js";
import { isBoundExceededError } from "./runtime-core-bounds.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type { LoopOutcome } from "./runtime-core-recovery.js";
import { resolutionToPhase } from "./runtime-core-response.js";
import { normalizeError, projectError } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { PauseContext } from "./runtime-execution-types.js";
import { createToolRegistry } from "./tool-registry.js";

/**
 * Error wrapper signalling that turn finalization itself failed.
 *
 * Thrown by {@link completeExecution} when `finalizeTurnStatus` rejects, so
 * that {@link handleExecutionFailure} can distinguish "the execution failed"
 * from "the execution's outcome could not be persisted" and project both the
 * original root cause (when the resolution was already a hard failure) and
 * the finalization error itself.
 */
export class FinalizationFailure extends Error {
  /** The error raised while finalizing the turn status. */
  readonly finalizationError: Error;
  /**
   * The hard-failure error the turn was being finalized with, when
   * finalization was persisting a failed resolution; `undefined` otherwise.
   */
  readonly rootCause?: Error;

  constructor(finalizationError: Error, rootCause?: Error) {
    super(finalizationError.message, { cause: finalizationError });
    this.name = "FinalizationFailure";
    this.finalizationError = finalizationError;
    this.rootCause = rootCause;
  }
}

/**
 * Capability surface the finalization helpers require from the runtime core:
 * turn-status persistence, head-state loading, run completion, event
 * publication, and failure-time config resolution.
 */
export interface RuntimeCoreFinalizationHost {
  createId(): string;
  defaultRunnerId(): string;
  finalizeRejectedPausedToolCancellation(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    pauseContext: PauseContext
  ): Promise<LoopOutcome>;
  finalizeTurnStatus(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    partial: boolean,
    loopState: LoopState
  ): Promise<void>;
  kernelTurnExists(turnId: string): Promise<boolean>;
  loadHeadState(branchId: string): Promise<HeadState>;
  now(): number;
  publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void;
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: Parameters<RuntimeExecutionHandle["publish"]>[0],
    loopState: LoopState
  ): void;
  publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ): void;
  resolveFailureActiveConfig(
    handle: RuntimeExecutionHandle
  ): LoopState["activeConfig"];
  runComplete(
    runId: string,
    status: "failed",
    eventHash: string
  ): Promise<unknown>;
  storeEventRecord(event: Record<string, unknown>): Promise<string>;
}

/**
 * Publish the events for an execution that paused awaiting tool approval.
 *
 * When a pause context is present it is remembered on the handle for a later
 * resume, an `approval.requested` event is published under the paused
 * agent/runner identity, and the turn is closed with a `paused` `turn.end`
 * event.
 *
 * @returns `true` when a pause was published (the caller must stop the
 *   execution flow); `false` when `pauseContext` is `undefined`.
 */
export function publishPauseOutcome(
  host: RuntimeCoreFinalizationHost,
  handle: RuntimeExecutionHandle,
  pauseContext: PauseContext | undefined,
  loopState: LoopState
): boolean {
  if (pauseContext === undefined) {
    return false;
  }

  handle.rememberPauseContext(pauseContext);
  host.publishEvent(
    handle,
    {
      request: pauseContext.approval,
      timestamp: host.now(),
      type: "approval.requested",
    },
    {
      ...loopState,
      activeConfig: pauseContext.activeConfig,
      activeRunnerId: pauseContext.activeRunnerId,
    }
  );
  host.publishEvent(
    handle,
    {
      status: "paused",
      timestamp: host.now(),
      turnId: handle.turnId,
      type: "turn.end",
    },
    loopState
  );
  return true;
}

/**
 * Publish an `approval.resolved` event for a resumed execution, or do nothing
 * when no approval response is present.
 */
export function publishApprovalResolved(
  host: RuntimeCoreFinalizationHost,
  handle: RuntimeExecutionHandle,
  response: ApprovalResponse | undefined,
  loopState: LoopState
): void {
  if (response === undefined) {
    return;
  }

  host.publishEvent(
    handle,
    {
      response,
      timestamp: host.now(),
      type: "approval.resolved",
    },
    loopState
  );
}

/**
 * Terminal failure path for an execution session: pick the authoritative
 * error, persist a failed turn status when possible, and project the failure.
 *
 * Error precedence: a wall-clock execution-bound abort wins over whatever the
 * interrupted work threw (BD006, see inline comment), then a
 * {@link FinalizationFailure}'s root cause, then the normalized thrown error.
 * The effective error is remembered on the handle, the active run is failed
 * via `failActiveRunIfNeeded`, and — when the kernel turn exists — the turn
 * status is finalized as a hard failure. Every path ends with the handle in
 * the `failed` phase and a fatal error event; a secondary finalization error
 * is additionally projected as non-fatal. This function itself never throws
 * for finalization problems.
 *
 * @param error - The value thrown out of the execution flow; may be a
 *   {@link FinalizationFailure} produced by {@link completeExecution}.
 * @param failActiveRunIfNeeded - Callback that marks the handle's active
 *   kernel run (if any) as failed before status finalization.
 */
export async function handleExecutionFailure(
  host: RuntimeCoreFinalizationHost,
  handle: RuntimeExecutionHandle,
  error: unknown,
  failActiveRunIfNeeded: (handle: RuntimeExecutionHandle) => Promise<void>
): Promise<void> {
  const finalizationFailure =
    error instanceof FinalizationFailure ? error : undefined;
  const runtimeError = normalizeError(error);
  const rootError =
    finalizationFailure?.rootCause ?? finalizationFailure?.finalizationError;
  // A wall-clock bound abort is authoritative over whatever the interrupted
  // in-flight model/tool work threw, so the fatal error event, telemetry, and
  // result all carry execution_bound_exceeded with its details. (BD006)
  const abortReason = handle.abortSignal.reason;
  const boundsError = isBoundExceededError(abortReason)
    ? abortReason
    : undefined;
  const effectiveError = boundsError ?? rootError ?? runtimeError;
  const failureActiveConfig = host.resolveFailureActiveConfig(handle);

  handle.rememberError(projectError(effectiveError));
  const loopState: LoopState = {
    activeConfig: failureActiveConfig,
    activeRunnerId: handle.request.runnerId ?? host.defaultRunnerId(),
    activeToolRegistry: createToolRegistry(),
    carriedStateUpdates: [],
    enteredIterationLoop: false,
  };
  const failureResolution: RuntimeResolution = {
    error: effectiveError,
    fatality: "hard",
    type: "fail",
  };

  await failActiveRunIfNeeded(handle);

  if (finalizationFailure !== undefined) {
    projectFinalizationFailure(host, handle, loopState, finalizationFailure);
    return;
  }

  if (await host.kernelTurnExists(handle.turnId)) {
    try {
      await host.finalizeTurnStatus(
        handle,
        failureResolution,
        false,
        loopState
      );
    } catch (finalizeError: unknown) {
      handle.replaceStatus({
        activeAgent: loopState.activeConfig.name,
        iterationCount: handle.status().iterationCount,
        manifest: handle.status().manifest,
        phase: "failed",
      });
      host.publishProjectedError(
        handle,
        failureResolution.error,
        true,
        loopState
      );
      host.publishProjectedError(
        handle,
        normalizeError(finalizeError),
        false,
        loopState
      );
      return;
    }
  }

  host.publishProjectedError(handle, effectiveError, true, loopState);
  handle.replaceStatus({
    activeAgent: loopState.activeConfig.name,
    iterationCount: handle.status().iterationCount,
    manifest: handle.status().manifest,
    phase: "failed",
  });
  host.publishEvent(
    handle,
    {
      status: "failed",
      timestamp: host.now(),
      turnId: handle.turnId,
      type: "turn.end",
    },
    loopState
  );
}

/**
 * Complete an execution with its final resolution and close the turn.
 *
 * When the iteration loop was entered, the extensions' after-turn hooks run
 * first against the finalized head state; a failing hook resolution is
 * projected as a non-fatal error but does not change the outcome. The turn
 * status is then finalized, a hard-failure resolution is projected as a
 * fatal error event, and the handle status plus a `turn.end` event are
 * emitted with the phase derived via {@link resolutionToPhase}.
 *
 * @param partial - Whether the resolution represents a partial result (for
 *   example a cancellation after some progress).
 * @param enteredIterationLoop - Gates the after-turn hooks; pass `false` for
 *   preludes that never reached the loop.
 * @throws FinalizationFailure when persisting the turn status fails, wrapping
 *   the finalization error and — for a hard-failure resolution — the original
 *   root cause.
 */
export async function completeExecution(
  host: RuntimeCoreFinalizationHost,
  handle: RuntimeExecutionHandle,
  resolution: RuntimeResolution,
  partial: boolean,
  loopState: LoopState,
  enteredIterationLoop: boolean
): Promise<void> {
  if (enteredIterationLoop) {
    const headState = await host.loadHeadState(handle.request.branchId);
    const afterTurn = await runAfterTurnHooks({
      emit: (event) => {
        host.publishCustomEvent(handle, event, loopState);
      },
      extensions: loopState.activeConfig.extensions ?? [],
      iterationCount: handle.status().iterationCount,
      manifest: headState.manifest,
      messages: headState.messages,
      runId: host.createId(),
      turnId: handle.turnId,
    });

    if (afterTurn.resolution?.type === "fail") {
      host.publishProjectedError(
        handle,
        afterTurn.resolution.error,
        false,
        loopState
      );
    }
  }

  try {
    await host.finalizeTurnStatus(handle, resolution, partial, loopState);
  } catch (error: unknown) {
    throw new FinalizationFailure(
      normalizeError(error),
      resolution.type === "fail" && resolution.fatality === "hard"
        ? resolution.error
        : undefined
    );
  }

  if (resolution.type === "fail" && resolution.fatality === "hard") {
    host.publishProjectedError(handle, resolution.error, true, loopState);
  }

  const finalizedHeadState = await host.loadHeadState(handle.request.branchId);

  handle.replaceStatus({
    activeAgent: loopState.activeConfig.name,
    iterationCount: handle.status().iterationCount,
    manifest: finalizedHeadState.manifest,
    phase: resolutionToPhase(resolution),
  });
  host.publishEvent(
    handle,
    {
      status: resolutionToPhase(resolution),
      timestamp: host.now(),
      turnId: handle.turnId,
      type: "turn.end",
    },
    loopState
  );
}

/**
 * Finalize an execution that was cancelled while paused for tool approval.
 *
 * Rebuilds the loop state from the pause context, marks the paused run as
 * `failed` (recording a `paused_run_cancelled` event), lets the host
 * finalize the rejected paused tool calls into a cancellation outcome, and
 * completes the execution with that outcome via `completeExecutionFn`.
 */
export async function finalizePausedCancellation(
  host: RuntimeCoreFinalizationHost,
  handle: RuntimeExecutionHandle,
  pauseContext: PauseContext,
  completeExecutionFn: (
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    partial: boolean,
    loopState: LoopState,
    enteredIterationLoop: boolean
  ) => Promise<void>
): Promise<void> {
  const loopState: LoopState = {
    activeConfig: pauseContext.activeConfig,
    activeRunnerId: pauseContext.activeRunnerId,
    activeToolRegistry: pauseContext.activeToolRegistry,
    carriedStateUpdates: [...pauseContext.carriedStateUpdates],
    clientEndpointBoundary: pauseContext.clientEndpointBoundary,
    enteredIterationLoop: true,
  };
  await host.runComplete(
    pauseContext.pausedRunId,
    "failed",
    await host.storeEventRecord({
      turnId: handle.turnId,
      type: "paused_run_cancelled",
    })
  );

  const cancelledOutcome = await host.finalizeRejectedPausedToolCancellation(
    handle,
    loopState,
    pauseContext
  );

  await completeExecutionFn(
    handle,
    cancelledOutcome.resolution,
    cancelledOutcome.partial ?? false,
    loopState,
    true
  );
}

/**
 * Move the handle to the `failed` phase and project a finalization failure:
 * the root cause (when present) as the fatal error and the finalization
 * error as a secondary non-fatal error, or the finalization error alone as
 * fatal.
 */
function projectFinalizationFailure(
  host: RuntimeCoreFinalizationHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  finalizationFailure: FinalizationFailure
): void {
  handle.replaceStatus({
    activeAgent: loopState.activeConfig.name,
    iterationCount: handle.status().iterationCount,
    manifest: handle.status().manifest,
    phase: "failed",
  });

  if (finalizationFailure.rootCause === undefined) {
    host.publishProjectedError(
      handle,
      finalizationFailure.finalizationError,
      true,
      loopState
    );
    return;
  }

  host.publishProjectedError(
    handle,
    finalizationFailure.rootCause,
    true,
    loopState
  );
  host.publishProjectedError(
    handle,
    finalizationFailure.finalizationError,
    false,
    loopState
  );
}
