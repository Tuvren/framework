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

import { randomUUID } from "node:crypto";
import {
  type EpochMs,
  type HashString,
  type KernelRecord,
  TuvrenRuntimeError,
} from "@tuvren/core-types";
import type {
  DriverExecutionContext,
  DriverRegistry,
} from "@tuvren/driver-api";
import type {
  RuntimeKernel as KrakenKernel,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import type {
  AgentConfig,
  ApprovalResponse,
  ExecutionHandle,
  HandoffContextBuilder,
  RuntimeResolution,
  ToolCallPart,
  ToolResultPart,
  TuvrenModelResponse,
  TuvrenRuntime,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import { createDriverRegistry } from "./driver-registry.js";
import {
  executeRuntimeIterationPhaseFacade,
  runRuntimeExecutionLoopFacade,
} from "./runtime-core-execution-orchestration.js";
import {
  createRuntimeExecutionHandle,
  createRuntimeResumedExecutionHandle,
  startRuntimeExecutionSession,
} from "./runtime-core-execution-session.js";
import {
  materializeRuntimeCoreContextMessages,
  materializeRuntimeCoreDriver,
  resolveRuntimeCoreFailureActiveConfig,
  resolveRuntimeCoreHandoffSourceContext,
} from "./runtime-core-facade-adapters.js";
import {
  applyRuntimeCoreAfterIterationResolution,
  applyRuntimeCoreContextEngineeringPlan,
  applyRuntimeCoreRequestedToolBatchIfNeeded,
  commitRuntimeCorePendingExtensionStateUpdates,
  completeRuntimeCoreExecution,
  completeRuntimeCoreIterationArtifacts,
  completeRuntimeCoreIterationRun,
  createRuntimeCoreDriverExecutionContext,
  createRuntimeCoreDriverHandoffContextPlan,
  createRuntimeCoreExecutionLoopState,
  createRuntimeCoreExecutionTurnIfNeeded,
  createRuntimeCoreIterationTree,
  createRuntimeCoreToolBatchEnvironment,
  executeRuntimeCoreDriverCall,
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
  resumeRuntimeCorePausedToolExecution,
  stageRuntimeCoreDriverMessages,
} from "./runtime-core-facade-execution.js";
import {
  createRuntimeCoreFacadeHosts,
  type RuntimeCoreFacadeHosts,
} from "./runtime-core-facade-hosts.js";
import {
  ensureSchemaIdFacade,
  loadHeadStateFacade,
  readRecoveredActiveAgentNameFacade,
  readRecoveredRuntimeStatusFacade,
  resolveExecutionSchemaIdFacade,
  resolveParentTurnIdFacade,
} from "./runtime-core-facade-ops.js";
import {
  cloneAgentConfigForRequest,
  createDriverAgentConfigSnapshot,
  createReadonlyDriverToolRegistry,
  normalizeManifestExtensionStateWarningBudget,
  normalizeMaxParallelToolCalls,
  normalizeRunLivenessOptions,
  resolveActiveMaxParallelToolCalls,
} from "./runtime-core-facade-utils.js";
import { finalizePausedCancellation as finalizeRuntimePausedCancellation } from "./runtime-core-finalization.js";
import type { ActiveRunLease } from "./runtime-core-liveness.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import {
  createRuntimeDriverStreamEvent,
  emitRuntimeCheckpointEvents,
  emitRuntimeWarning,
  ensureRuntimeAssistantEvents,
  flushRuntimeBufferedEventsIfResolutionAllows,
  publishRuntimeCustomNamedEvent,
  publishRuntimeProjectedErrorEvent,
  publishRuntimeStreamEvent,
  stageRuntimeManifestRecord,
  stageRuntimeMessageRecord,
  stageRuntimeStatusRecordValue,
  stageRuntimeTurnLineageRecord,
  storeRuntimeEventKernelRecord,
  storeRuntimeKernelRecordValue,
} from "./runtime-core-observability.js";
import type { LoopOutcome } from "./runtime-core-recovery.js";
import { hasRunLivenessKernel } from "./runtime-core-response.js";
import {
  advanceRuntimeCoreTurnAndBranchHead,
  checkpointRuntimeCoreResumeRunningStatus,
  completeRuntimeCoreRecoveredTerminalExecution,
  completeRuntimeCoreTrackedRun,
  createRuntimeCoreTrackedRun,
  failRuntimeCoreTrackedRunWithoutBranchAdvance,
  reconcileRuntimeCoreCheckpointedPauseResolution,
  recoverRuntimeCoreExpiredExecutionBranchIfNeeded,
  resolveRuntimeCoreCheckpointedPausedRun,
  stopRuntimeCoreRunLeaseLoop,
  syncRuntimeCoreRunLeaseStateFromStepResult,
} from "./runtime-core-runtime-lifecycle.js";
import {
  createFrozenSnapshot,
  detachPromise,
  normalizeInputSignal,
} from "./runtime-core-shared.js";
import { prepareResumedExecutionStartPrelude as prepareRuntimeResumedExecutionStartPrelude } from "./runtime-core-startup.js";
import { finalizeTurnStatus as finalizeRuntimeTurnStatus } from "./runtime-core-status.js";
import { finalizeRejectedPausedToolCancellation as finalizeRejectedRuntimePausedToolCancellation } from "./runtime-core-tool-resume.js";
import {
  applyRuntimeCoreTerminalAgentTransitionIfNeeded,
  createRuntimeCoreContextHelperBundle,
  resolveRuntimeCoreDefaultHandoffContextBuilder,
} from "./runtime-core-transition-support.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type {
  ExecutionSessionRequest,
  PauseContext,
} from "./runtime-execution-types.js";
import type { ToolExecutionMode } from "./tool-execution.js";

export const DEFAULT_AGENT_SCHEMA_ID = "tuvren.agent.v1";
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;
export const DEFAULT_MANIFEST_EXTENSION_STATE_WARNING_BUDGET_BYTES = 256 * 1024;

export interface RuntimeRunLivenessOptions {
  executionOwnerId: string;
  leaseDurationMs: number;
  renewBeforeMs?: number;
}
export const DEFAULT_AGENT_SCHEMA: TurnTreeSchema = {
  incorporationRules: [
    { objectType: "message", targetPath: "messages" },
    { objectType: "context_manifest", targetPath: "context.manifest" },
    { objectType: "turn_lineage", targetPath: "turn.lineage" },
    { objectType: "runtime_status", targetPath: "runtime.status" },
  ],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
    { collection: "single", path: "turn.lineage" },
    { collection: "single", path: "runtime.status" },
  ],
  schemaId: DEFAULT_AGENT_SCHEMA_ID,
};

export interface RuntimeCoreOptions {
  createId?: () => string;
  defaultDriverId: string;
  defaultMaxParallelToolCalls?: number;
  driverRegistry?: DriverRegistry;
  enableStateObservability?: boolean;
  handoffContextBuilder?: HandoffContextBuilder;
  kernel: KrakenKernel;
  manifestExtensionStateWarningBudgetBytes?: false | number;
  now?: () => EpochMs;
  onWarning?: (warning: RuntimeWarning) => void;
  resolveAgentConfig?: (agentName: string) => AgentConfig | undefined;
  resolveParentTurnId?: (
    threadId: string,
    branchId: string
  ) => Promise<string | null> | string | null;
  runLiveness?: RuntimeRunLivenessOptions;
}

interface ResolvedRuntimeCoreOptions {
  createId: () => string;
  defaultDriverId: string;
  defaultMaxParallelToolCalls: number;
  driverRegistry: DriverRegistry;
  enableStateObservability: boolean;
  handoffContextBuilder?: HandoffContextBuilder;
  kernel: KrakenKernel;
  manifestExtensionStateWarningBudgetBytes: false | number;
  now: () => EpochMs;
  onWarning?: (warning: RuntimeWarning) => void;
  resolveAgentConfig?: (agentName: string) => AgentConfig | undefined;
  resolveParentTurnId?: (
    threadId: string,
    branchId: string
  ) => Promise<string | null> | string | null;
  runLiveness?: ResolvedRuntimeRunLivenessOptions;
}

interface ResolvedRuntimeRunLivenessOptions {
  executionOwnerId: string;
  leaseDurationMs: number;
  renewBeforeMs: number;
}

export interface RuntimeWarning {
  activeAgent: string;
  budgetBytes: number;
  code: "manifest_extension_state_budget_exceeded";
  extensionName: string;
  observedBytes: number;
  runId: string;
  threadId: string;
  turnId: string;
}

interface ExecutedIterationResult {
  driverResponse: TuvrenModelResponse;
  iterationRunId: string;
  partial: boolean;
  requestedToolCalls: ToolCallPart[];
  resolution: RuntimeResolution;
  stableHeadTurnNodeHash: HashString;
  toolExecutionMode: ToolExecutionMode;
  toolResults: ToolResultPart[];
  turnNodeHash: HashString | undefined;
}

type IterationPhaseResult =
  | {
      kind: "executed";
      result: ExecutedIterationResult;
    }
  | {
      kind: "outcome";
      outcome: LoopOutcome;
    };

class RuntimeCore implements TuvrenRuntime {
  private readonly activeRunLeaseControllers = new WeakMap<
    RuntimeExecutionHandle,
    ActiveRunLease
  >();
  private readonly manifestExtensionStateWarningKeys = new WeakMap<
    RuntimeExecutionHandle,
    Set<string>
  >();
  private readonly hosts: RuntimeCoreFacadeHosts;
  private readonly options: ResolvedRuntimeCoreOptions;

  constructor(options: RuntimeCoreOptions) {
    this.options = {
      createId: options.createId ?? randomUUID,
      defaultDriverId: options.defaultDriverId,
      defaultMaxParallelToolCalls: normalizeMaxParallelToolCalls(
        options.defaultMaxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS,
        "defaultMaxParallelToolCalls"
      ),
      driverRegistry: options.driverRegistry ?? createDriverRegistry(),
      enableStateObservability: options.enableStateObservability ?? true,
      handoffContextBuilder: options.handoffContextBuilder,
      kernel: options.kernel,
      manifestExtensionStateWarningBudgetBytes:
        options.manifestExtensionStateWarningBudgetBytes === undefined
          ? DEFAULT_MANIFEST_EXTENSION_STATE_WARNING_BUDGET_BYTES
          : normalizeManifestExtensionStateWarningBudget(
              options.manifestExtensionStateWarningBudgetBytes
            ),
      now: options.now ?? Date.now,
      onWarning: options.onWarning,
      resolveAgentConfig: options.resolveAgentConfig,
      resolveParentTurnId: options.resolveParentTurnId,
      runLiveness:
        options.runLiveness === undefined
          ? undefined
          : normalizeRunLivenessOptions(options.runLiveness),
    };

    if (
      this.options.runLiveness !== undefined &&
      !hasRunLivenessKernel(this.options.kernel)
    ) {
      throw new TuvrenRuntimeError(
        "runLiveness requires a kernel that implements the kernel.run-liveness extension",
        {
          code: "missing_run_liveness_extension",
        }
      );
    }

    this.hosts = createRuntimeCoreFacadeHosts({
      activeRunLeaseControllers: this.activeRunLeaseControllers,
      advanceTurnAndBranchHead: (handle, turnNodeHash) =>
        advanceRuntimeCoreTurnAndBranchHead(
          this.options.kernel,
          handle,
          turnNodeHash
        ),
      applyTerminalAgentTransitionIfNeeded: (...args) =>
        applyRuntimeCoreTerminalAgentTransitionIfNeeded(
          {
            contextOps: this.hosts.contextOps,
            kernel: this.options.kernel,
          },
          ...args
        ),
      checkpointResumeRunningStatus: (...args) =>
        checkpointRuntimeCoreResumeRunningStatus(this.hosts.status, ...args),
      cloneAgentConfigForRequest,
      commitPendingExtensionStateUpdates: (...args) =>
        commitRuntimeCorePendingExtensionStateUpdates(this.hosts, ...args),
      completeExecution: (...args) =>
        completeRuntimeCoreExecution(this.hosts, ...args),
      completeIterationRun: (...args) =>
        completeRuntimeCoreIterationRun(this.hosts, ...args),
      completeTrackedRun: (...args) =>
        completeRuntimeCoreTrackedRun(this.hosts.liveness, ...args),
      createContextEngineeringHelpers: (messageHashes, messages) =>
        createRuntimeCoreContextHelperBundle(
          this.options.kernel,
          messageHashes,
          messages
        ),
      createDriverAgentConfigSnapshot,
      createDriverHandoffContextPlan: (...args) =>
        createRuntimeCoreDriverHandoffContextPlan(this.hosts, ...args),
      createDriverPublishedEvent: (handle, event, loopState) =>
        createRuntimeDriverStreamEvent(
          this.hosts.events,
          handle,
          event,
          loopState
        ),
      createId: () => this.createId(),
      createIterationTree: (...args) =>
        createRuntimeCoreIterationTree(this.hosts, ...args),
      createReadonlyDriverToolRegistry,
      createToolBatchEnvironment: (...args) =>
        createRuntimeCoreToolBatchEnvironment(this.hosts, ...args),
      createTrackedRun: (...args) =>
        createRuntimeCoreTrackedRun(this.hosts.liveness, ...args),
      defaultDriverId: this.options.defaultDriverId,
      defaultMaxParallelToolCalls: this.options.defaultMaxParallelToolCalls,
      emitStateObservability: (
        handle,
        loopState,
        turnNodeHash,
        iterationCount,
        manifest
      ) =>
        emitRuntimeCheckpointEvents(
          this.hosts.events,
          handle,
          loopState,
          turnNodeHash,
          iterationCount,
          manifest
        ),
      enableStateObservability: () => this.options.enableStateObservability,
      failTrackedRunWithoutBranchAdvance: (...args) =>
        failRuntimeCoreTrackedRunWithoutBranchAdvance(
          this.hosts.turnProgress,
          ...args
        ),
      finalizeRejectedPausedToolCancellation: (...args) =>
        finalizeRejectedRuntimePausedToolCancellation(
          this.hosts.toolResume,
          ...args
        ),
      finalizeTurnStatus: (...args) =>
        finalizeRuntimeTurnStatus(this.hosts.status, ...args),
      getManifestExtensionStateWarningBudgetBytes: () =>
        this.options.onWarning === undefined
          ? false
          : this.options.manifestExtensionStateWarningBudgetBytes,
      getOrCreateManifestExtensionStateWarningKeys: (handle) => {
        let warningKeys = this.manifestExtensionStateWarningKeys.get(handle);
        if (warningKeys === undefined) {
          warningKeys = new Set<string>();
          this.manifestExtensionStateWarningKeys.set(handle, warningKeys);
        }
        return warningKeys;
      },
      kernel: this.options.kernel,
      loadHeadState: (branchId) =>
        loadHeadStateFacade(this.options.kernel, branchId),
      manifestExtensionStateWarning: (warning) =>
        emitRuntimeWarning(this.options.onWarning, warning),
      materializeContextMessages: (hashes, helpers) =>
        materializeRuntimeCoreContextMessages(hashes, helpers),
      now: () => this.now(),
      publishCustomEvent: (handle, event, loopState) =>
        publishRuntimeCustomNamedEvent(
          this.hosts.events,
          handle,
          event,
          loopState
        ),
      publishEvent: (handle, event, loopState) =>
        publishRuntimeStreamEvent(this.hosts.events, handle, event, loopState),
      publishPauseOutcome: (...args) =>
        publishRuntimeCorePauseOutcome(this.hosts, ...args),
      publishProjectedError: (handle, error, fatal, loopState) =>
        publishRuntimeProjectedErrorEvent(
          this.hosts.events,
          handle,
          error,
          fatal,
          loopState
        ),
      readRecoveredActiveAgentName: (turnTreeHash) =>
        readRecoveredActiveAgentNameFacade(this.options.kernel, turnTreeHash),
      readRecoveredRuntimeStatus: (turnTreeHash) =>
        readRecoveredRuntimeStatusFacade(this.options.kernel, turnTreeHash),
      resolveActiveMaxParallelToolCalls: (
        loopState,
        defaultMaxParallelToolCalls
      ) =>
        resolveActiveMaxParallelToolCalls(
          loopState.activeConfig,
          defaultMaxParallelToolCalls
        ),
      resolveAgentConfig: this.options.resolveAgentConfig,
      resolveCheckpointedPausedRun: (...args) =>
        resolveRuntimeCoreCheckpointedPausedRun(
          this.hosts.turnProgress,
          ...args
        ),
      resolveDefaultHandoffContextBuilder: (mode) =>
        resolveRuntimeCoreDefaultHandoffContextBuilder(
          this.options.handoffContextBuilder,
          mode
        ),
      resolveFailureActiveConfig: (handle) =>
        resolveRuntimeCoreFailureActiveConfig(
          handle.request.config,
          handle.status().activeAgent ?? handle.request.config.name,
          this.options.resolveAgentConfig
        ),
      resolveHandoffSourceContext: (
        plan,
        headState,
        loopState,
        targetConfig,
        helpers
      ) =>
        resolveRuntimeCoreHandoffSourceContext(
          {
            cloneAgentConfigForRequest,
            kernel: this.options.kernel,
          },
          plan,
          headState,
          loopState,
          targetConfig,
          helpers
        ),
      resolveParentTurnId: (threadId, branchId, explicitParentTurnId) =>
        resolveParentTurnIdFacade(
          this.options.kernel,
          this.options.resolveParentTurnId,
          threadId,
          branchId,
          explicitParentTurnId
        ),
      resolveTargetAgent: (targetAgent) =>
        this.options.resolveAgentConfig?.(targetAgent) ?? {
          name: targetAgent,
        },
      resumePausedToolExecution: (...args) =>
        resumeRuntimeCorePausedToolExecution(this.hosts, ...args),
      runLivenessOptions: this.options.runLiveness,
      stageManifest: (runId, manifest, warningContext) =>
        stageRuntimeManifestRecord(
          this.hosts.persistence,
          runId,
          manifest,
          warningContext
        ),
      stageMessage: (runId, message, taskId) =>
        stageRuntimeMessageRecord(
          this.hosts.persistence,
          runId,
          message,
          taskId as string
        ),
      stageRuntimeStatus: (runId, status, taskId) =>
        stageRuntimeStatusRecordValue(
          this.hosts.persistence,
          runId,
          status,
          taskId
        ),
      stageTurnLineage: (runId, turnId, taskId) =>
        stageRuntimeTurnLineageRecord(
          this.hosts.persistence,
          runId,
          turnId,
          taskId
        ),
      storeEventRecord: (event) =>
        storeRuntimeEventKernelRecord(this.hosts.persistence, event),
      storeKernelRecord: (value, label) =>
        storeRuntimeKernelRecordValue(this.hosts.persistence, value, label),
      syncRunLeaseStateFromStepResult: (...args) =>
        syncRuntimeCoreRunLeaseStateFromStepResult(
          this.hosts.liveness,
          ...args
        ),
      treeCreate: (schemaId, changes, baseTurnTreeHash) =>
        this.options.kernel.tree.create(schemaId, changes, baseTurnTreeHash),
    });
  }

  async createBranch(input: {
    branchId?: string;
    fromTurnNodeHash: HashString;
    threadId: string;
  }): Promise<{
    branchId: string;
    headTurnNodeHash: HashString;
    threadId: string;
  }> {
    return await this.options.kernel.branch.create(
      input.branchId ?? this.createId(),
      input.threadId,
      input.fromTurnNodeHash
    );
  }

  async createThread(input: {
    initialBranchId?: string;
    schemaId?: string;
    threadId?: string;
  }): Promise<{
    branchId: string;
    rootTurnNodeHash: HashString;
    rootTurnTreeHash: HashString;
    threadId: string;
  }> {
    const schemaId = await this.ensureSchemaId(input.schemaId);
    return await this.options.kernel.thread.create(
      input.threadId ?? this.createId(),
      schemaId,
      input.initialBranchId ?? this.createId()
    );
  }

  executeTurn(input: ExecutionSessionRequest): ExecutionHandle {
    return this.createExecutionHandle(input);
  }

  async getThread(threadId: string): Promise<{
    rootTurnNodeHash: HashString;
    schemaId: string;
    threadId: string;
  } | null> {
    return await this.options.kernel.thread.get(threadId);
  }

  async setBranchHead(input: {
    branchId: string;
    turnNodeHash: HashString;
  }): Promise<{
    archiveBranchId?: string;
    branchId: string;
    headTurnNodeHash: HashString;
  }> {
    const result = await this.options.kernel.branch.setHead(
      input.branchId,
      input.turnNodeHash
    );

    return {
      archiveBranchId: result.archiveBranch?.branchId,
      branchId: result.branch.branchId,
      headTurnNodeHash: result.branch.headTurnNodeHash,
    };
  }

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

  createResumedExecutionHandle(
    previousHandle: RuntimeExecutionHandle,
    pauseContext: PauseContext,
    response: ApprovalResponse
  ): RuntimeExecutionHandle {
    return createRuntimeResumedExecutionHandle(
      this,
      previousHandle,
      pauseContext,
      response
    );
  }

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
      ) =>
        await completeRuntimeCoreExecution(
          this.hosts,
          activeHandle,
          resolution,
          partial,
          loopState,
          enteredIterationLoop
        )
    );
    handle.rememberPausedCancellation(cancellationTask);
    detachPromise(cancellationTask);
  }

  async startExecution(handle: RuntimeExecutionHandle): Promise<void> {
    await startRuntimeExecutionSession(
      {
        completeExecution: (...args) =>
          completeRuntimeCoreExecution(this.hosts, ...args),
        completeRecoveredTerminalExecution: (...args) =>
          completeRuntimeCoreRecoveredTerminalExecution(
            this.hosts.expiredRecovery,
            ...args
          ),
        createExecutionLoopState: (...args) =>
          createRuntimeCoreExecutionLoopState(this.hosts, ...args),
        createExecutionTurnIfNeeded: (...args) =>
          createRuntimeCoreExecutionTurnIfNeeded(this.hosts, ...args),
        emitStateObservability: (
          handle,
          loopState,
          turnNodeHash,
          iterationCount,
          manifest
        ) =>
          emitRuntimeCheckpointEvents(
            this.hosts.events,
            handle,
            loopState,
            turnNodeHash,
            iterationCount,
            manifest
          ),
        finishResumedExecutionStart: (...args) =>
          finishRuntimeCoreResumedExecutionStart(this.hosts, ...args),
        handleExecutionFailure: (...args) =>
          handleRuntimeCoreExecutionFailure(this.hosts, ...args),
        prepareFreshExecutionStart: (...args) =>
          prepareRuntimeCoreFreshExecutionStart(
            this.hosts,
            ...args,
            async (activeHandle, activeSchemaId, activeLoopState) =>
              await incorporateRuntimeCoreInput(
                this.hosts,
                activeHandle,
                activeSchemaId,
                activeLoopState
              )
          ),
        prepareResumedExecutionStartPrelude: (...args) =>
          prepareRuntimeResumedExecutionStartPrelude(
            this.hosts.startup,
            ...args,
            async (event) =>
              await storeRuntimeEventKernelRecord(
                this.hosts.persistence,
                event as KernelRecord
              ),
            async (runId, status, eventHash) =>
              await this.options.kernel.run.complete(runId, status, eventHash)
          ),
        publishApprovalResolved: (...args) =>
          publishRuntimeCoreApprovalResolved(this.hosts, ...args),
        publishPauseOutcome: (...args) =>
          publishRuntimeCorePauseOutcome(this.hosts, ...args),
        publishTurnStart: (...args) =>
          publishRuntimeCoreTurnStart(this.hosts, ...args),
        recoverExpiredExecutionBranchIfNeeded: (...args) =>
          recoverRuntimeCoreExpiredExecutionBranchIfNeeded(
            this.hosts.expiredRecovery,
            ...args
          ),
        resolveExecutionBranchHead: (...args) =>
          resolveRuntimeCoreExecutionBranchHead(this.hosts, ...args),
        resolveExecutionSchemaId: (request) =>
          resolveExecutionSchemaIdFacade(
            this.options.kernel,
            async (schemaId) =>
              await ensureSchemaIdFacade(this.options.kernel, schemaId),
            request
          ),
        runExecutionLoop: (...args) => this.runExecutionLoop(...args),
        stopRunLeaseLoop: (activeHandle) =>
          stopRuntimeCoreRunLeaseLoop(this.hosts.liveness, activeHandle),
      },
      handle
    );
  }

  private async runExecutionLoop(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<LoopOutcome> {
    return await runRuntimeExecutionLoopFacade(
      {
        applyContextEngineeringPlan: (...args) =>
          applyRuntimeCoreContextEngineeringPlan(this.hosts, ...args),
        applyTerminalAgentTransitionIfNeeded: (...args) =>
          applyRuntimeCoreTerminalAgentTransitionIfNeeded(
            {
              contextOps: this.hosts.contextOps,
              kernel: this.options.kernel,
            },
            ...args
          ),
        commitPendingExtensionStateUpdates: (...args) =>
          commitRuntimeCorePendingExtensionStateUpdates(this.hosts, ...args),
        createId: () => this.createId(),
        executeIterationPhase: (...args) => this.executeIterationPhase(...args),
        incorporateQueuedSteeringIfNeeded: (...args) =>
          this.incorporateQueuedSteeringIfNeeded(...args),
        loadHeadState: (branchId) =>
          loadHeadStateFacade(this.options.kernel, branchId),
        now: () => this.now(),
        publishCustomEvent: (handle, event, loopState) =>
          publishRuntimeCustomNamedEvent(
            this.hosts.events,
            handle,
            event,
            loopState
          ),
        publishEvent: (handle, event, loopState) =>
          publishRuntimeStreamEvent(
            this.hosts.events,
            handle,
            event,
            loopState
          ),
        publishProjectedError: (handle, error, fatal, loopState) =>
          publishRuntimeProjectedErrorEvent(
            this.hosts.events,
            handle,
            error,
            fatal,
            loopState
          ),
      },
      handle,
      schemaId,
      loopState
    );
  }

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

  private async executeIterationPhase(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState | undefined,
    iterationCount: number
  ): Promise<IterationPhaseResult> {
    return await executeRuntimeIterationPhaseFacade(
      {
        applyAfterIterationResolution: (...args) =>
          applyRuntimeCoreAfterIterationResolution(this.hosts, ...args),
        applyRequestedToolBatchIfNeeded: (input) =>
          applyRuntimeCoreRequestedToolBatchIfNeeded(this.hosts, input),
        beginIterationStep: async (runId, stepId) => {
          await this.options.kernel.run.beginStep(runId, stepId);
        },
        completeIterationArtifacts: (...args) =>
          completeRuntimeCoreIterationArtifacts(this.hosts, ...args),
        createDriverExecutionContext: (...args) =>
          this.createDriverExecutionContext(...args),
        createId: () => this.createId(),
        createTrackedRun: (...args) =>
          createRuntimeCoreTrackedRun(this.hosts.liveness, ...args),
        ensureDriverAssistantEvents: (
          handle,
          messages,
          emittedEvents,
          loopState
        ) =>
          ensureRuntimeAssistantEvents(
            this.hosts.events,
            handle,
            messages,
            emittedEvents,
            loopState
          ),
        executeDriver: (...args) => executeRuntimeCoreDriverCall(...args),
        failInvalidPauseResolutionIfNeeded: (...args) =>
          failRuntimeCoreInvalidPauseResolutionIfNeeded(this.hosts, ...args),
        failTrackedRunWithoutBranchAdvance: (...args) =>
          failRuntimeCoreTrackedRunWithoutBranchAdvance(
            this.hosts.turnProgress,
            ...args
          ),
        flushBufferedDriverEventsIfNeeded: (handle, resolution, events) =>
          flushRuntimeBufferedEventsIfResolutionAllows(
            handle,
            resolution,
            events
          ),
        materializeDriver: (driverId) =>
          materializeRuntimeCoreDriver(this.options.driverRegistry, driverId),
        reconcileCheckpointedPauseResolution: (...args) =>
          reconcileRuntimeCoreCheckpointedPauseResolution(
            this.hosts.turnProgress,
            ...args
          ),
        stageDriverMessages: (...args) =>
          stageRuntimeCoreDriverMessages(this.hosts, ...args),
      },
      handle,
      schemaId,
      loopState,
      headState,
      iterationCount
    );
  }

  private createDriverExecutionContext(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState,
    iterationCount: number,
    emittedDriverEvents: TuvrenStreamEvent[]
  ): DriverExecutionContext {
    return createRuntimeCoreDriverExecutionContext(
      this.hosts,
      handle,
      schemaId,
      loopState,
      headState,
      iterationCount,
      emittedDriverEvents
    );
  }

  private async ensureSchemaId(schemaId?: string): Promise<string> {
    return await ensureSchemaIdFacade(this.options.kernel, schemaId);
  }

  private createId(): string {
    return this.options.createId();
  }

  private now(): EpochMs {
    return this.options.now();
  }
}

export function createTuvrenRuntimeCore(
  options: RuntimeCoreOptions
): TuvrenRuntime {
  return new RuntimeCore(options);
}
