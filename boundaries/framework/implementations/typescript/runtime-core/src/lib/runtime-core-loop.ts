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

import { type HashString, TuvrenRuntimeError } from "@tuvren/core-types";
import type { TurnNode } from "@tuvren/kernel-protocol";
import type {
  AgentConfig,
  ContextEngineeringPlan,
  ContextManifest,
  RuntimeResolution,
  ToolRegistry,
  TuvrenMessage,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import {
  type ExtensionStateUpdate,
  runBeforeIterationHooks,
} from "./extension-runtime.js";
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

export interface HeadState {
  branchHeadHash: HashString;
  manifest: ContextManifest;
  messageHashes: HashString[];
  messages: TuvrenMessage[];
  turnNode: TurnNode;
}

export interface LoopState {
  activeConfig: AgentConfig;
  activeDriverId: string;
  activeToolRegistry: ToolRegistry;
  carriedStateUpdates: ExtensionStateUpdate[];
  enteredIterationLoop: boolean;
}

export interface IterationPreparationResult {
  headState?: HeadState;
  resolution?: RuntimeResolution;
}

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
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The execution loop is intentionally kept as a single checkpointed control-flow path for cancellation and iteration semantics.
export async function runExecutionLoop(
  host: RuntimeCoreLoopHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  now: () => number
): Promise<LoopOutcome> {
  while (true) {
    if (
      loopState.activeConfig.maxIterations !== undefined &&
      handle.status().iterationCount >= loopState.activeConfig.maxIterations
    ) {
      return {
        resolution: {
          reason: "max_iterations",
          type: "end_turn",
        },
      };
    }

    const nextIteration = handle.status().iterationCount + 1;
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
        activeDriverId: loopState.activeDriverId,
        activeToolRegistry: loopState.activeToolRegistry,
        approval: result.resolution.approval,
        carriedStateUpdates: [...loopState.carriedStateUpdates],
        pauseReason: result.resolution.reason,
        pausedIteration: {
          iterationCount,
          response: result.driverResponse,
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
