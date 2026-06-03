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
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type { LoopOutcome } from "./runtime-core-recovery.js";
import { resolutionToPhase } from "./runtime-core-response.js";
import { normalizeError, projectError } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { PauseContext } from "./runtime-execution-types.js";
import { createToolRegistry } from "./tool-registry.js";

export class FinalizationFailure extends Error {
  readonly finalizationError: Error;
  readonly rootCause?: Error;

  constructor(finalizationError: Error, rootCause?: Error) {
    super(finalizationError.message, { cause: finalizationError });
    this.name = "FinalizationFailure";
    this.finalizationError = finalizationError;
    this.rootCause = rootCause;
  }
}

export interface RuntimeCoreFinalizationHost {
  createId(): string;
  defaultDriverId(): string;
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
      activeDriverId: pauseContext.activeDriverId,
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
  const failureActiveConfig = host.resolveFailureActiveConfig(handle);

  handle.rememberError(projectError(rootError ?? runtimeError));
  const loopState: LoopState = {
    activeConfig: failureActiveConfig,
    activeDriverId: handle.request.driverId ?? host.defaultDriverId(),
    activeToolRegistry: createToolRegistry(),
    carriedStateUpdates: [],
    enteredIterationLoop: false,
  };
  const failureResolution: RuntimeResolution = {
    error: rootError ?? runtimeError,
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

  host.publishProjectedError(handle, runtimeError, true, loopState);
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
    activeDriverId: pauseContext.activeDriverId,
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
