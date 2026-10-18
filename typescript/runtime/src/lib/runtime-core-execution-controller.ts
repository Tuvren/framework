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

import { assertKernelRecord } from "@tuvren/core";
import type { EpochMs, HashString } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  ContextManifest,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { ToolCallPart, ToolResultPart } from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import type { RunnerExecutionContext } from "@tuvren/core/runner";
import type { ApprovalResponse } from "@tuvren/core/tools";

import type { PayloadCodecBinding } from "./payload-codec-seam.js";
import type { ResolvedExecutionBounds } from "./runtime-core-bounds.js";
import {
  executeRuntimeIterationPhaseFacade,
  runRuntimeExecutionLoopFacade,
} from "./runtime-core-execution-orchestration.js";
import {
  createRuntimeExecutionHandle,
  createRuntimeResumedExecutionHandle,
  startRuntimeExecutionSession,
} from "./runtime-core-execution-session.js";
import { materializeRuntimeCoreRunner } from "./runtime-core-facade-adapters.js";
import {
  applyRuntimeCoreAfterIterationResolution,
  applyRuntimeCoreContextEngineeringPlan,
  applyRuntimeCoreRequestedToolBatchIfNeeded,
  commitRuntimeCorePendingExtensionStateUpdates,
  completeRuntimeCoreExecution,
  completeRuntimeCoreIterationArtifacts,
  createRuntimeCoreExecutionLoopState,
  createRuntimeCoreExecutionTurnIfNeeded,
  createRuntimeCoreRunnerExecutionContext,
  executeRuntimeCoreRunnerCall,
  failRuntimeCoreInvalidPauseResolutionIfNeeded,
  finishRuntimeCoreResumedExecutionStart,
  handleRuntimeCoreExecutionFailure,
  incorporateRuntimeCoreInput,
  incorporateRuntimeCoreSteering,
  prepareRuntimeCoreFreshExecutionStart,
  publishRuntimeCoreApprovalResolved,
  publishRuntimeCorePauseOutcome,
  publishRuntimeCoreTurnStart,
  resolveRuntimeCoreExecutionBranchHead,
  stageRuntimeCoreRunnerMessages,
} from "./runtime-core-facade-execution.js";
import type { RuntimeCoreFacadeHosts } from "./runtime-core-facade-hosts.js";
import {
  ensureSchemaIdFacade,
  loadHeadStateFacade,
  resolveExecutionSchemaIdFacade,
} from "./runtime-core-facade-ops.js";
import { finalizePausedCancellation as finalizeRuntimePausedCancellation } from "./runtime-core-finalization.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import {
  ensureRuntimeAssistantEvents,
  flushRuntimeBufferedEventsIfResolutionAllows,
  publishRuntimeCustomNamedEvent,
  storeRuntimeEventKernelRecord,
} from "./runtime-core-observability.js";
import type { ResolvedRuntimeCoreOptions } from "./runtime-core-options.js";
import {
  DEFAULT_AGENT_SCHEMA,
  DEFAULT_AGENT_SCHEMA_ID,
} from "./runtime-core-options.js";
import type { LoopOutcome } from "./runtime-core-recovery.js";
import {
  completeRuntimeCoreRecoveredTerminalExecution,
  createRuntimeCoreTrackedRun,
  failRuntimeCoreTrackedRunWithoutBranchAdvance,
  reconcileRuntimeCoreCheckpointedPauseResolution,
  recoverRuntimeCoreExpiredExecutionBranchIfNeeded,
  stopRuntimeCoreRunLeaseLoop,
} from "./runtime-core-runtime-lifecycle.js";
import {
  createFrozenSnapshot,
  detachPromise,
  normalizeInputSignal,
} from "./runtime-core-shared.js";
import { prepareResumedExecutionStartPrelude as prepareRuntimeResumedExecutionStartPrelude } from "./runtime-core-startup.js";
import type { RuntimeTelemetryEmitter } from "./runtime-core-telemetry.js";
import { applyRuntimeCoreTerminalAgentTransitionIfNeeded } from "./runtime-core-transition-support.js";
import type {
  RuntimeExecutionHandle,
  RuntimeExecutionHandleRuntime,
} from "./runtime-execution-handle.js";
import type {
  ExecutionSessionRequest,
  PauseContext,
} from "./runtime-execution-types.js";
import type { ToolExecutionMode } from "./tool-execution.js";

/** Artifacts of one fully executed iteration (runner call + tool batch). */
interface ExecutedIterationResult {
  iterationRunId: string;
  partial: boolean;
  requestedToolCalls: ToolCallPart[];
  resolution: RuntimeResolution;
  runnerResponse: TuvrenModelResponse;
  stableHeadTurnNodeHash: HashString;
  toolExecutionMode: ToolExecutionMode;
  toolResults: ToolResultPart[];
  turnNodeHash: HashString | undefined;
}

/**
 * Result of one iteration phase: either an executed iteration whose
 * resolution the loop applies next, or a short-circuit terminal
 * {@link LoopOutcome} (for example an invalid pause resolution).
 */
type IterationPhaseResult =
  | {
      kind: "executed";
      result: ExecutedIterationResult;
    }
  | {
      kind: "outcome";
      outcome: LoopOutcome;
    };

interface RuntimeCoreExecutionControllerDependencies {
  armWallClockBound: (handle: RuntimeExecutionHandle) => void;
  boundsDeadlineMs: (handle: RuntimeExecutionHandle) => number;
  carryBoundsTurnState: (
    previousHandle: RuntimeExecutionHandle,
    resumedHandle: RuntimeExecutionHandle
  ) => void;
  disarmWallClockBound: (handle: RuntimeExecutionHandle) => void;
  emitRuntimeStateObservability: (
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ) => void;
  executionBounds: () => ResolvedExecutionBounds;
  hosts: RuntimeCoreFacadeHosts;
  options: ResolvedRuntimeCoreOptions;
  publishRuntimeEvent: (
    handle: RuntimeExecutionHandle,
    event: TuvrenStreamEvent,
    loopState: LoopState
  ) => void;
  publishRuntimeProjectedError: (
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ) => void;
  recordBoundsToolCalls: (
    handle: RuntimeExecutionHandle,
    count: number
  ) => number;
  telemetry: RuntimeTelemetryEmitter;
}

/** Private execution-session owner used by the public runtime shell. */
export interface RuntimeCoreExecutionController extends RuntimeExecutionHandleRuntime {
  createExecutionHandle: (
    request: ExecutionSessionRequest
  ) => RuntimeExecutionHandle;
}

class DefaultRuntimeCoreExecutionController implements RuntimeCoreExecutionController {
  private readonly dependencies: RuntimeCoreExecutionControllerDependencies;

  constructor(dependencies: RuntimeCoreExecutionControllerDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * Builds a fresh execution handle for a turn request. The request's config
   * and tools are defensively cloned/frozen so post-hoc host mutation cannot
   * leak into the running turn; the loop starts on first consumption of the
   * handle (event stream or `awaitResult`).
   */
  createExecutionHandle(
    request: ExecutionSessionRequest
  ): RuntimeExecutionHandle {
    return createRuntimeExecutionHandle(
      this,
      request,
      () => this.createId(),
      DEFAULT_AGENT_SCHEMA_ID,
      createFrozenSnapshot,
      normalizeInputSignal
    );
  }

  /**
   * Builds the handle that continues a paused execution after an approval
   * response, carrying the previous handle's per-turn bounds state forward
   * (cumulative tool-call count and wall-clock deadline) so a pause/resume
   * cycle can never reset the hard-stop budgets.
   */
  createResumedExecutionHandle(
    previousHandle: RuntimeExecutionHandle,
    pauseContext: PauseContext,
    response: ApprovalResponse
  ): RuntimeExecutionHandle {
    const resumedHandle = createRuntimeResumedExecutionHandle(
      this,
      previousHandle,
      pauseContext,
      response
    );
    // Execution bounds are per logical turn. A resumed handle continues the same
    // turn, so carry the cumulative tool-call count and the end-to-end wall-clock
    // deadline forward; otherwise a runner could reset two hard-stop budgets on
    // every approval pause. The per-loop-run abort timer is re-armed against the
    // carried deadline when the resumed loop enters. (ADR-0043, BD006)
    this.dependencies.carryBoundsTurnState(previousHandle, resumedHandle);
    return resumedHandle;
  }

  /**
   * Finalizes a handle that is paused on tool approval as cancelled. A no-op
   * when the handle holds no pause context (nothing is paused, or the pause
   * was already consumed by a resume). The finalization runs detached; the
   * handle records it so later observers can await the same task.
   */
  cancelPausedExecution(handle: RuntimeExecutionHandle): void {
    const pauseContext = handle.takePauseContextForCancellation();

    if (pauseContext === undefined) {
      return;
    }

    const cancellationTask = finalizeRuntimePausedCancellation(
      this.hosts.finalization,
      handle,
      pauseContext,
      async (
        activeHandle,
        resolution,
        partial,
        loopState,
        enteredIterationLoop
      ) => {
        await completeRuntimeCoreExecution(
          this.hosts,
          activeHandle,
          resolution,
          partial,
          loopState,
          enteredIterationLoop
        );
      }
    );
    handle.rememberPausedCancellation(cancellationTask);
    detachPromise(cancellationTask);
  }

  /**
   * Drives an execution session end to end: wires the session-facade
   * callbacks over this runtime's hosts, then delegates to
   * `startRuntimeExecutionSession`, which prepares a fresh or resumed start,
   * recovers expired runs when needed, and runs the iteration loop to a
   * terminal outcome. Invoked once per handle by the handle's lazy-start
   * paths; not called directly by hosts.
   */
  async startExecution(handle: RuntimeExecutionHandle): Promise<void> {
    await startRuntimeExecutionSession(
      {
        completeExecution: async (...args) => {
          await completeRuntimeCoreExecution(this.hosts, ...args);
        },
        completeRecoveredTerminalExecution: async (...args) => {
          await completeRuntimeCoreRecoveredTerminalExecution(
            this.hosts.expiredRecovery,
            ...args
          );
        },
        createExecutionLoopState: (...args) =>
          createRuntimeCoreExecutionLoopState(this.hosts, ...args),
        createExecutionTurnIfNeeded: async (...args) => {
          await createRuntimeCoreExecutionTurnIfNeeded(this.hosts, ...args);
        },
        emitRecoveryFailed: (activeHandle, activeLoopState, error) => {
          this.dependencies.telemetry.recovery({
            error,
            handle: activeHandle,
            loopState: activeLoopState,
            status: "error",
          });
        },
        emitRecoveryResumed: (activeHandle, activeLoopState) => {
          this.dependencies.telemetry.recovery({
            handle: activeHandle,
            loopState: activeLoopState,
            status: "ok",
          });
        },
        emitStateObservability: (
          activeHandle,
          activeLoopState,
          turnNodeHash,
          iterationCount,
          manifest
        ) => {
          this.dependencies.emitRuntimeStateObservability(
            activeHandle,
            activeLoopState,
            turnNodeHash,
            iterationCount,
            manifest
          );
        },
        finishResumedExecutionStart: async (...args) =>
          await finishRuntimeCoreResumedExecutionStart(this.hosts, ...args),
        handleExecutionFailure: async (...args) => {
          await handleRuntimeCoreExecutionFailure(this.hosts, ...args);
        },
        prepareFreshExecutionStart: async (...args) =>
          await prepareRuntimeCoreFreshExecutionStart(
            this.hosts,
            ...args,
            async (activeHandle, activeSchemaId, activeLoopState) => {
              await incorporateRuntimeCoreInput(
                this.hosts,
                activeHandle,
                activeSchemaId,
                activeLoopState
              );
            }
          ),
        prepareResumedExecutionStartPrelude: async (...args) =>
          await prepareRuntimeResumedExecutionStartPrelude(
            this.hosts.startup,
            ...args,
            async (event) => {
              assertKernelRecord(event, "resumed execution event");
              return await storeRuntimeEventKernelRecord(
                this.hosts.persistence,
                event
              );
            },
            async (runId, status, eventHash) =>
              await this.options.kernel.run.complete(runId, status, eventHash)
          ),
        publishApprovalResolved: (...args) => {
          publishRuntimeCoreApprovalResolved(this.hosts, ...args);
        },
        publishPauseOutcome: (...args) =>
          publishRuntimeCorePauseOutcome(this.hosts, ...args),
        publishTurnStart: (...args) => {
          publishRuntimeCoreTurnStart(this.hosts, ...args);
        },
        recoverExpiredExecutionBranchIfNeeded: async (...args) =>
          await recoverRuntimeCoreExpiredExecutionBranchIfNeeded(
            this.hosts.expiredRecovery,
            ...args
          ),
        resolveExecutionBranchHead: async (...args) =>
          await resolveRuntimeCoreExecutionBranchHead(this.hosts, ...args),
        resolveExecutionSchemaId: async (request) =>
          await resolveExecutionSchemaIdFacade(
            this.options.kernel,
            async (schemaId) =>
              await ensureSchemaIdFacade(
                this.options.kernel,
                DEFAULT_AGENT_SCHEMA,
                schemaId
              ),
            request
          ),
        runExecutionLoop: async (...args) =>
          await this.runExecutionLoop(...args),
        stopRunLeaseLoop: (activeHandle) => {
          stopRuntimeCoreRunLeaseLoop(this.hosts.liveness, activeHandle);
        },
      },
      handle
    );
  }

  /**
   * Runs one loop entry (fresh start or resume) with the wall-clock bound
   * armed for its duration; a resume re-enters against the same carried
   * deadline rather than a fresh budget.
   */
  private async runExecutionLoop(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<LoopOutcome> {
    // Arm the end-to-end wall-clock deadline for the duration of this loop run
    // (resume re-enters with the remaining budget against the same deadline).
    this.dependencies.armWallClockBound(handle);
    try {
      return await this.runExecutionLoopFacade(handle, schemaId, loopState);
    } finally {
      this.dependencies.disarmWallClockBound(handle);
    }
  }

  private async runExecutionLoopFacade(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<LoopOutcome> {
    return await runRuntimeExecutionLoopFacade(
      {
        applyContextEngineeringPlan: async (...args) => {
          await applyRuntimeCoreContextEngineeringPlan(this.hosts, ...args);
        },
        applyTerminalAgentTransitionIfNeeded: async (...args) =>
          await applyRuntimeCoreTerminalAgentTransitionIfNeeded(
            {
              contextOps: this.hosts.contextOps,
              kernel: this.options.kernel,
              payloadCodecBinding: this.payloadBinding(),
            },
            ...args
          ),
        boundsDeadlineMs: (boundsHandle) =>
          this.dependencies.boundsDeadlineMs(boundsHandle),
        commitPendingExtensionStateUpdates: async (...args) => {
          await commitRuntimeCorePendingExtensionStateUpdates(
            this.hosts,
            ...args
          );
        },
        createId: () => this.createId(),
        executeIterationPhase: async (...args) =>
          await this.executeIterationPhase(...args),
        executionBounds: this.dependencies.executionBounds,
        incorporateQueuedSteeringIfNeeded: async (...args) => {
          await this.incorporateQueuedSteeringIfNeeded(...args);
        },
        loadHeadState: async (branchId) =>
          await loadHeadStateFacade(
            this.options.kernel,
            this.payloadBinding(),
            branchId
          ),
        now: () => this.now(),
        publishCustomEvent: (activeHandle, event, activeLoopState) => {
          publishRuntimeCustomNamedEvent(
            this.hosts.events,
            activeHandle,
            event,
            activeLoopState
          );
        },
        publishEvent: (activeHandle, event, activeLoopState) => {
          this.dependencies.publishRuntimeEvent(
            activeHandle,
            event,
            activeLoopState
          );
        },
        publishProjectedError: (
          activeHandle,
          error,
          fatal,
          activeLoopState
        ) => {
          this.dependencies.publishRuntimeProjectedError(
            activeHandle,
            error,
            fatal,
            activeLoopState
          );
        },
        recordBoundsToolCalls: this.dependencies.recordBoundsToolCalls,
      },
      handle,
      schemaId,
      loopState
    );
  }

  /**
   * Consumes one queued steering signal from the handle, if any, and
   * incorporates it into the turn before the next iteration.
   */
  private async incorporateQueuedSteeringIfNeeded(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<void> {
    const steeringSignal = handle.consumeSteeringSignal();

    if (steeringSignal !== undefined) {
      await incorporateRuntimeCoreSteering(
        this.hosts,
        handle,
        schemaId,
        steeringSignal,
        loopState
      );
    }
  }

  /**
   * Executes one iteration phase — runner call, tool batch, artifact commit —
   * through the iteration-phase facade, wrapping the runner call in a
   * `tuvren.runtime.model_call` telemetry span.
   */
  private async executeIterationPhase(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState | undefined,
    iterationCount: number
  ): Promise<IterationPhaseResult> {
    return await executeRuntimeIterationPhaseFacade(
      {
        applyAfterIterationResolution: async (...args) =>
          await applyRuntimeCoreAfterIterationResolution(this.hosts, ...args),
        applyRequestedToolBatchIfNeeded: async (input) =>
          await applyRuntimeCoreRequestedToolBatchIfNeeded(this.hosts, input),
        beginIterationStep: async (runId, stepId) => {
          await this.options.kernel.run.beginStep(runId, stepId);
        },
        completeIterationArtifacts: async (...args) =>
          await completeRuntimeCoreIterationArtifacts(this.hosts, ...args),
        createId: () => this.createId(),
        createRunnerExecutionContext: (...args) =>
          this.createRunnerExecutionContext(...args),
        createTrackedRun: async (...args) => {
          await createRuntimeCoreTrackedRun(this.hosts.liveness, ...args);
        },
        ensureRunnerAssistantEvents: (
          activeHandle,
          messages,
          emittedEvents,
          activeLoopState
        ) =>
          ensureRuntimeAssistantEvents(
            this.hosts.events,
            activeHandle,
            messages,
            emittedEvents,
            activeLoopState
          ),
        executeRunner: async (...args) => {
          const startMs = this.now();

          try {
            const result = await executeRuntimeCoreRunnerCall(...args);
            this.dependencies.telemetry.span({
              handle,
              kind: "model_call",
              loopState,
              name: "tuvren.runtime.model_call",
              startMs,
              status: "ok",
            });
            return result;
          } catch (error: unknown) {
            this.dependencies.telemetry.span({
              error,
              handle,
              kind: "model_call",
              loopState,
              name: "tuvren.runtime.model_call",
              startMs,
              status: "error",
            });
            throw error;
          }
        },
        failInvalidPauseResolutionIfNeeded: async (...args) =>
          await failRuntimeCoreInvalidPauseResolutionIfNeeded(
            this.hosts,
            ...args
          ),
        failTrackedRunWithoutBranchAdvance: async (...args) => {
          await failRuntimeCoreTrackedRunWithoutBranchAdvance(
            this.hosts.turnProgress,
            ...args
          );
        },
        flushBufferedRunnerEventsIfNeeded: (activeHandle, resolution, events) =>
          flushRuntimeBufferedEventsIfResolutionAllows(
            activeHandle,
            resolution,
            events
          ),
        materializeRunner: (runnerId) =>
          materializeRuntimeCoreRunner(this.options.runnerRegistry, runnerId),
        now: () => this.now(),
        publishEvent: (activeHandle, event, activeLoopState) => {
          this.dependencies.publishRuntimeEvent(
            activeHandle,
            event,
            activeLoopState
          );
        },
        reconcileCheckpointedPauseResolution: async (...args) =>
          await reconcileRuntimeCoreCheckpointedPauseResolution(
            this.hosts.turnProgress,
            ...args
          ),
        stageManifest: async (runId, manifest, taskId) =>
          await this.hosts.runner.stageManifest(
            runId,
            manifest,
            undefined,
            taskId
          ),
        stageRunnerMessages: async (...args) =>
          await stageRuntimeCoreRunnerMessages(this.hosts, ...args),
        stageRuntimeStatus: async (...args) =>
          await this.hosts.runner.stageRuntimeStatus(...args),
        stageTurnLineage: async (...args) =>
          await this.hosts.runner.stageTurnLineage(...args),
      },
      handle,
      schemaId,
      loopState,
      headState,
      iterationCount
    );
  }

  private createRunnerExecutionContext(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState,
    iterationCount: number,
    emittedRunnerEvents: TuvrenStreamEvent[]
  ): RunnerExecutionContext {
    return createRuntimeCoreRunnerExecutionContext(
      this.hosts,
      handle,
      schemaId,
      loopState,
      headState,
      iterationCount,
      emittedRunnerEvents
    );
  }

  private createId(): string {
    return this.options.createId();
  }

  private now(): EpochMs {
    return this.options.now();
  }

  // The crypto-shredding binding (codec + Scope) threaded to every message
  // write/read seam (KRT-BF005).
  private payloadBinding(): PayloadCodecBinding {
    return { codec: this.options.payloadCodec, scope: this.options.scope };
  }

  private get hosts(): RuntimeCoreFacadeHosts {
    return this.dependencies.hosts;
  }

  private get options(): ResolvedRuntimeCoreOptions {
    return this.dependencies.options;
  }
}

/**
 * Creates the private execution controller. Construction only captures the
 * already-resolved runtime collaborators; execution remains lazy per handle.
 */
export const createRuntimeCoreExecutionController = (
  dependencies: RuntimeCoreExecutionControllerDependencies
): RuntimeCoreExecutionController =>
  new DefaultRuntimeCoreExecutionController(dependencies);
