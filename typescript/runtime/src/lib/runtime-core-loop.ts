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

import { type HashString, TuvrenRuntimeError } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  AgentConfig,
  ContextEngineeringPlan,
  ContextManifest,
  ExecutionBoundKind,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { ToolRegistry } from "@tuvren/core/tools";
import type { TurnNode } from "@tuvren/kernel-protocol";
import {
  type ExtensionStateUpdate,
  runBeforeIterationHooks,
} from "./extension-runtime.js";
import {
  createBoundExceededError,
  type ResolvedExecutionBounds,
} from "./runtime-core-bounds.js";
import type {
  ExecutedIterationResult,
  IterationPhaseResult,
} from "./runtime-core-iteration.js";
import {
  createCancelledLoopOutcome,
  isContextEngineeringPlan,
  type LoopOutcome,
} from "./runtime-core-recovery.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

/**
 * Immutable snapshot of a branch head as loaded from the kernel.
 *
 * A `HeadState` is (re)loaded at iteration boundaries and after any operation
 * that advances the branch head (input incorporation, context engineering,
 * extension-state commits), so the loop always iterates against durable state.
 */
export interface HeadState {
  /** Hash of the branch-head turn node this snapshot was resolved from. */
  branchHeadHash: HashString;
  /** Context manifest resolved from the head turn tree. */
  manifest: ContextManifest;
  /** Ordered hashes of the decoded {@link HeadState.messages}. */
  messageHashes: HashString[];
  /** Decoded conversation messages at the branch head, in order. */
  messages: TuvrenMessage[];
  /** The turn node record at the branch head. */
  turnNode: TurnNode;
}

/**
 * Mutable per-turn execution state threaded through the loop.
 *
 * Unlike {@link HeadState}, which is a durable kernel snapshot, `LoopState`
 * holds the in-memory active-agent configuration and carried side-band data.
 * Agent handoffs replace {@link LoopState.activeConfig},
 * {@link LoopState.activeToolRegistry}, and
 * {@link LoopState.clientEndpointBoundary} in place.
 */
export interface LoopState {
  /** Configuration of the currently active agent. */
  activeConfig: AgentConfig;
  /** Identifier of the runner materialized for the active agent. */
  activeRunnerId: string;
  /** Tool registry the active agent executes against. */
  activeToolRegistry: ToolRegistry;
  /**
   * Extension state updates accumulated since the last durable commit; they
   * are flushed into the context manifest by the state-commit path and the
   * array is reset after each commit.
   */
  carriedStateUpdates: ExtensionStateUpdate[];
  /** Boundary for tuvren-client execution class dispatch. (KRT-AZ001) */
  clientEndpointBoundary?: import("@tuvren/core/capabilities").ClientEndpointBoundary;
  /** True once the turn has entered at least one loop iteration. */
  enteredIterationLoop: boolean;
  /** Cached rate limiter for the active agent's server execution class. (AX003) */
  serverExecutionRateLimiter?: import("./server-rate-limiter.js").ServerRateLimiter;
}

/**
 * Result of preparing an iteration before runner execution.
 *
 * Exactly one of the fields is populated: {@link headState} when the
 * iteration may proceed, or {@link resolution} when a before-iteration hook
 * short-circuited the turn with a terminal resolution.
 */
export interface IterationPreparationResult {
  /** Fresh branch-head snapshot the iteration should execute against. */
  headState?: HeadState;
  /** Terminal resolution produced by a before-iteration hook, if any. */
  resolution?: RuntimeResolution;
}

/**
 * Host seam providing every capability {@link runExecutionLoop} needs.
 *
 * The loop itself is pure control flow; all durable effects (state commits,
 * event publication, iteration execution, bounds accounting) are delegated
 * through this interface so the loop can be composed by the runtime facade
 * and exercised in isolation.
 */
export interface RuntimeCoreLoopHost {
  applyContextEngineeringPlan(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    plan: ContextEngineeringPlan,
    loopState: LoopState,
    stateUpdates: ExtensionStateUpdate[]
  ): Promise<void>;
  applyTerminalAgentTransitionIfNeeded(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    resolution: RuntimeResolution,
    loopState: LoopState,
    stableHeadTurnNodeHash: HashString
  ): Promise<boolean>;
  /** Absolute wall-clock deadline (epoch ms) for the active turn. (BD006) */
  boundsDeadlineMs(handle: RuntimeExecutionHandle): number;
  commitPendingExtensionStateUpdates(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    updates: ExtensionStateUpdate[],
    iterationCount: number
  ): Promise<void>;
  createId(): string;
  executeIterationPhase(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState | undefined,
    iterationCount: number
  ): Promise<IterationPhaseResult>;
  /** The framework-enforced execution bounds for this runtime instance. (BD006) */
  executionBounds(): ResolvedExecutionBounds;
  incorporateQueuedSteeringIfNeeded(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<void>;
  loadHeadState(branchId: string): Promise<HeadState>;
  publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void;
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: TuvrenStreamEvent,
    loopState: LoopState
  ): void;
  publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ): void;
  /** Record `count` more tool calls and return the new per-turn cumulative. (BD006) */
  recordBoundsToolCalls(handle: RuntimeExecutionHandle, count: number): number;
}

/**
 * Run the turn's iteration loop until a terminal {@link LoopOutcome} is
 * produced.
 *
 * Each pass through the loop enforces the framework execution bounds before
 * anything else (ADR-043, BD006), in this order:
 *
 * 1. Wall-clock deadline (`maxWallClockMs`) — a deterministic backstop for
 *    the out-of-band abort timer; exceeding it fails the turn hard.
 * 2. Framework `maxIterations` hard stop — clamps
 *    `AgentConfig.maxIterations` from above and fails the turn hard.
 * 3. The agent's own `maxIterations` — a graceful cap that ends the turn
 *    with an `end_turn` resolution instead of failing it.
 * 4. Cumulative `maxToolCalls`, evaluated AFTER each tool batch completes
 *    (ADR-043/§4.12): a single over-cap batch runs to completion and the cap
 *    stops the next batch.
 *
 * Cancellation is checkpointed at iteration entry, after the iteration
 * phase, before continuing, and before returning a terminal outcome, so an
 * abort observed at any checkpoint converts into a hard-fail outcome.
 *
 * Per iteration the loop incorporates queued steering, runs before-iteration
 * extension hooks and context policy via {@link prepareIterationState}, then
 * delegates the model/tool work to `host.executeIterationPhase`. Pause
 * resolutions must carry a durable pause checkpoint; terminal `handoff`
 * resolutions may swap the active agent and continue the loop.
 *
 * @param host - Capability seam for durable effects and iteration execution.
 * @param handle - Execution handle carrying status, abort signal, and request.
 * @param schemaId - Kernel tree schema identifier for staged state.
 * @param loopState - Mutable per-turn state; updated in place.
 * @param now - Clock used for bounds checks and event timestamps.
 * @returns The terminal outcome of the turn (resolution, optional pause
 *   context, and partial-output flag).
 * @throws TuvrenRuntimeError with code `missing_pause_checkpoint` when a
 *   pause resolution arrives without a committed pause checkpoint.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The execution loop is intentionally kept as a single checkpointed control-flow path for cancellation and iteration semantics.
export async function runExecutionLoop(
  host: RuntimeCoreLoopHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  now: () => number
): Promise<LoopOutcome> {
  const bounds = host.executionBounds();

  while (true) {
    const currentIterationCount = handle.status().iterationCount;

    // Framework execution-bounds guard (ADR-043, BD006), enforced above the
    // runner's loop policy. The wall-clock deadline is also enforced by an
    // out-of-band abort timer; this boundary check is the deterministic backstop.
    if (now() >= host.boundsDeadlineMs(handle)) {
      return boundsFailLoopOutcome(
        "maxWallClockMs",
        bounds.maxWallClockMs,
        bounds.maxWallClockMs
      );
    }

    // The iteration hard-stop clamps AgentConfig.maxIterations from above: a
    // runner cannot bypass it, and reaching it fails the turn (distinct from the
    // graceful lower agent cap below).
    if (currentIterationCount >= bounds.maxIterations) {
      return boundsFailLoopOutcome(
        "maxIterations",
        bounds.maxIterations,
        currentIterationCount
      );
    }

    if (
      loopState.activeConfig.maxIterations !== undefined &&
      currentIterationCount >= loopState.activeConfig.maxIterations
    ) {
      return {
        resolution: {
          reason: "max_iterations",
          type: "end_turn",
        },
      };
    }

    const nextIteration = currentIterationCount + 1;
    loopState.enteredIterationLoop = true;

    const abortedOutcome = createCancelledLoopOutcome(handle);

    if (abortedOutcome !== undefined) {
      return abortedOutcome;
    }

    beginIteration(host, handle, loopState, nextIteration, now);
    await host.incorporateQueuedSteeringIfNeeded(handle, schemaId, loopState);

    const preparation = await prepareIterationState(
      host,
      handle,
      schemaId,
      loopState,
      nextIteration
    );

    if (preparation.resolution !== undefined) {
      publishIterationEnd(host, handle, loopState, nextIteration, now);
      return {
        resolution: preparation.resolution,
      };
    }

    const phaseResult = await host.executeIterationPhase(
      handle,
      schemaId,
      loopState,
      preparation.headState,
      nextIteration
    );

    if (phaseResult.kind === "outcome") {
      publishIterationEnd(host, handle, loopState, nextIteration, now);
      return phaseResult.outcome;
    }

    publishIterationEnd(host, handle, loopState, nextIteration, now);
    const cancelledAfterIteration = createCancelledLoopOutcome(
      handle,
      phaseResult.kind === "executed" ? phaseResult.result.partial : false
    );

    if (cancelledAfterIteration !== undefined) {
      return cancelledAfterIteration;
    }

    // Cumulative tool-call hard-stop bound, checked at the tool-batch boundary
    // above runner discretion. Per ADR-043/§4.12 this caps the cumulative calls
    // *executed* across the Turn and is evaluated AFTER each batch completes: a
    // single over-cap batch runs to completion (parallelism-bounded by
    // maxConcurrentToolCalls) and the cap then stops the next batch. The
    // per-instant resource ceiling is maxConcurrentToolCalls, not this. (ADR-043, BD006)
    const cumulativeToolCalls = host.recordBoundsToolCalls(
      handle,
      phaseResult.result.requestedToolCalls.length
    );
    if (cumulativeToolCalls > bounds.maxToolCalls) {
      return boundsFailLoopOutcome(
        "maxToolCalls",
        bounds.maxToolCalls,
        cumulativeToolCalls
      );
    }

    const nextOutcome = await resolveIterationOutcome(
      host,
      handle,
      schemaId,
      loopState,
      nextIteration,
      phaseResult.result
    );

    if (nextOutcome === "continue") {
      const cancelledBeforeContinue = createCancelledLoopOutcome(handle);

      if (cancelledBeforeContinue !== undefined) {
        return cancelledBeforeContinue;
      }

      continue;
    }

    return (
      createCancelledLoopOutcome(handle, nextOutcome.partial ?? false) ??
      nextOutcome
    );
  }
}

/** Build the hard-fail outcome for an exceeded execution bound. (BD006) */
function boundsFailLoopOutcome(
  bound: ExecutionBoundKind,
  limit: number,
  observed: number
): LoopOutcome {
  return {
    resolution: {
      error: createBoundExceededError(bound, limit, observed),
      fatality: "hard",
      type: "fail",
    },
  };
}

/**
 * Mark the handle as running for the next iteration and publish the
 * `iteration.start` stream event.
 */
function beginIteration(
  host: RuntimeCoreLoopHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  iterationCount: number,
  now: () => number
): void {
  handle.updateStatus({
    activeAgent: loopState.activeConfig.name,
    approval: undefined,
    iterationCount,
    pauseReason: undefined,
    phase: "running",
  });
  host.publishEvent(
    handle,
    {
      iterationCount,
      timestamp: now(),
      type: "iteration.start",
    },
    loopState
  );
}

/** Publish the `iteration.end` stream event for the finished iteration. */
function publishIterationEnd(
  host: RuntimeCoreLoopHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  iterationCount: number,
  now: () => number
): void {
  host.publishEvent(
    handle,
    {
      iterationCount,
      timestamp: now(),
      type: "iteration.end",
    },
    loopState
  );
}

/**
 * Prepare durable state for one iteration before runner execution.
 *
 * Loads the branch head, runs before-iteration extension hooks, and applies
 * any context-engineering plan the hooks or the agent's context policy
 * produced (reloading head state after each application). Soft-fail hook
 * resolutions are downgraded to projected errors; any other hook resolution
 * commits carried extension state and short-circuits the iteration.
 */
async function prepareIterationState(
  host: RuntimeCoreLoopHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  iterationCount: number
): Promise<IterationPreparationResult> {
  let headState = await host.loadHeadState(handle.request.branchId);
  handle.updateStatus({
    manifest: headState.manifest,
  });

  const beforeIteration = await runBeforeIterationHooks({
    emit: (event) => {
      host.publishCustomEvent(handle, event, loopState);
    },
    extensions: loopState.activeConfig.extensions ?? [],
    iterationCount,
    manifest: headState.manifest,
    messages: headState.messages,
    runId: host.createId(),
    turnId: handle.turnId,
  });
  loopState.carriedStateUpdates.push(...beforeIteration.updates);

  if (beforeIteration.resolution !== undefined) {
    if (
      beforeIteration.resolution.type === "fail" &&
      beforeIteration.resolution.fatality === "soft"
    ) {
      host.publishProjectedError(
        handle,
        beforeIteration.resolution.error,
        false,
        loopState
      );
    } else {
      await host.commitPendingExtensionStateUpdates(
        handle,
        schemaId,
        loopState,
        loopState.carriedStateUpdates,
        iterationCount
      );
      loopState.carriedStateUpdates = [];
      return {
        resolution: beforeIteration.resolution,
      };
    }
  }

  if (beforeIteration.cePlan !== undefined) {
    await host.applyContextEngineeringPlan(
      handle,
      schemaId,
      beforeIteration.cePlan,
      loopState,
      loopState.carriedStateUpdates
    );
    loopState.carriedStateUpdates = [];
    headState = await host.loadHeadState(handle.request.branchId);
  }

  const policyPlan = loopState.activeConfig.contextPolicy?.evaluate(
    headState.manifest,
    iterationCount
  );

  if (policyPlan !== undefined && isContextEngineeringPlan(policyPlan)) {
    await host.applyContextEngineeringPlan(
      handle,
      schemaId,
      policyPlan,
      loopState,
      loopState.carriedStateUpdates
    );
    loopState.carriedStateUpdates = [];
    headState = await host.loadHeadState(handle.request.branchId);
  }

  return {
    headState,
  };
}

/**
 * Convert an executed iteration's resolution into the loop's next action.
 *
 * `continue_iteration` and soft failures continue the loop; a pause builds a
 * resumable {@link LoopOutcome} with pause context (and requires a durable
 * pause checkpoint); a terminal `handoff` that swaps the active agent also
 * continues; anything else terminates the turn.
 */
async function resolveIterationOutcome(
  host: RuntimeCoreLoopHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  iterationCount: number,
  result: ExecutedIterationResult
): Promise<LoopOutcome | "continue"> {
  if (result.resolution.type === "continue_iteration") {
    return "continue";
  }

  if (
    result.resolution.type === "fail" &&
    result.resolution.fatality === "soft"
  ) {
    return "continue";
  }

  if (result.resolution.type === "pause") {
    if (result.turnNodeHash === undefined) {
      throw new TuvrenRuntimeError(
        "paused iterations must commit a durable pause checkpoint",
        {
          code: "missing_pause_checkpoint",
        }
      );
    }

    return {
      pauseContext: {
        activeConfig: loopState.activeConfig,
        activeRunnerId: loopState.activeRunnerId,
        activeToolRegistry: loopState.activeToolRegistry,
        approval: result.resolution.approval,
        carriedStateUpdates: [...loopState.carriedStateUpdates],
        clientEndpointBoundary: loopState.clientEndpointBoundary,
        pauseReason: result.resolution.reason,
        pausedIteration: {
          iterationCount,
          response: result.runnerResponse,
          toolExecutionMode: result.toolExecutionMode,
          toolResults: result.toolResults,
        },
        pausedRunId: result.iterationRunId,
        pausedTurnNodeHash: result.turnNodeHash,
      },
      resolution: result.resolution,
    };
  }

  if (
    await host.applyTerminalAgentTransitionIfNeeded(
      handle,
      schemaId,
      result.resolution,
      loopState,
      result.stableHeadTurnNodeHash
    )
  ) {
    return "continue";
  }

  return {
    partial: result.partial,
    resolution: result.resolution,
  };
}
