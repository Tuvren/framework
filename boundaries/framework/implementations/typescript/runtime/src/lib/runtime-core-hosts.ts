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

import {
  type EpochMs,
  type HashString,
  type KernelRecord,
  TuvrenLineageError,
} from "@tuvren/core";
import type {
  AgentConfig,
  ContextEngineeringHelpers,
  ContextManifest,
  HandoffContextPlan,
  HandoffSourceContext,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { ToolRegistry } from "@tuvren/core/tools";
import type {
  RuntimeKernel as KrakenKernel,
  RunCompletionStatus,
} from "@tuvren/kernel-protocol";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import {
  encryptMessageRecord,
  type PayloadCodecBinding,
} from "./payload-codec-seam.js";
import type { HelperBundle } from "./runtime-core-context.js";
import type { RuntimeCoreContextOpsHost } from "./runtime-core-context-ops.js";
import type { RuntimeCoreDriverSupportHost } from "./runtime-core-driver-support.js";
import type { RuntimeCoreEventsHost } from "./runtime-core-events.js";
import type { RuntimeCoreExpiredRecoveryHost } from "./runtime-core-expired-recovery.js";
import type { RuntimeCoreFinalizationHost } from "./runtime-core-finalization.js";
import type {
  ActiveRunLease,
  RuntimeCoreLivenessHost,
} from "./runtime-core-liveness.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type { RuntimeCorePersistenceHost } from "./runtime-core-persistence.js";
import type { DurableRuntimeStatus } from "./runtime-core-recovery.js";
import type { RuntimeCoreStartupHost } from "./runtime-core-startup.js";
import type { RuntimeCoreStateCommitHost } from "./runtime-core-state-commit.js";
import type { RuntimeCoreTurnProgressHost } from "./runtime-core-turn-progress.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type {
  ExecutionSessionRequest,
  PauseContext,
} from "./runtime-execution-types.js";

interface ContextOpsHostDependencies {
  advanceTurnAndBranchHead(
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ): Promise<void>;
  cloneAgentConfigForRequest(config: AgentConfig): AgentConfig;
  completeTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    status: RunCompletionStatus,
    event?: KernelRecord
  ): Promise<{ turnNodeHash?: HashString }>;
  createActiveToolRegistry(
    runtimeTools: ExecutionSessionRequest["tools"] | undefined,
    config: AgentConfig,
    clientEndpointBoundary?: import("@tuvren/core/capabilities").ClientEndpointBoundary
  ): ToolRegistry;
  createClientEndpointBoundaryFromConfig(
    config: AgentConfig
  ): import("@tuvren/core/capabilities").ClientEndpointBoundary | undefined;
  createContextEngineeringHelpers(
    messageHashes: HashString[],
    messages: TuvrenMessage[]
  ): HelperBundle;
  createId(): string;
  createTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    turnId: string,
    branchId: string,
    schemaId: string,
    startTurnNodeHash: HashString,
    steps: Array<{
      deterministic: boolean;
      id: string;
      sideEffects: boolean;
    }>
  ): Promise<void>;
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): void;
  kernel: KrakenKernel;
  loadHeadState(branchId: string): Promise<HeadState>;
  materializeContextMessages(
    hashes: HashString[],
    helpers: ContextEngineeringHelpers
  ): TuvrenMessage[];
  publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void;
  resolveAgentConfig?(name: string): AgentConfig | undefined;
  resolveHandoffSourceContext(
    plan: HandoffContextPlan,
    headState: HeadState,
    loopState: LoopState,
    targetConfig: AgentConfig,
    helpers: ContextEngineeringHelpers
  ): HandoffSourceContext;
  stageRuntimeStatus(
    runId: string,
    runtimeStatus: {
      activeAgent?: string;
      state: "running";
    },
    taskId: string
  ): Promise<HashString>;
  storeEventRecord(event: KernelRecord): Promise<HashString>;
  storeKernelRecord(value: unknown, label: string): Promise<HashString>;
  syncRunLeaseStateFromStepResult(
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
  ): void;
}

interface PersistenceHostDependencies {
  emitWarning(warning: {
    activeAgent: string;
    budgetBytes: number;
    code: "manifest_extension_state_budget_exceeded";
    extensionName: string;
    observedBytes: number;
    runId: string;
    threadId: string;
    turnId: string;
  }): void;
  encodeKernelRecord(value: unknown, label: string): Uint8Array;
  getManifestExtensionStateWarningBudgetBytes(): false | number;
  getOrCreateManifestExtensionStateWarningKeys(
    handle: RuntimeExecutionHandle
  ): Set<string>;
  kernel: KrakenKernel;
  payloadCodecBinding: PayloadCodecBinding;
}

interface LivenessHostDependencies {
  activeRunLeaseControllers: WeakMap<RuntimeExecutionHandle, ActiveRunLease>;
  kernel: KrakenKernel;
  now(): EpochMs;
  runLivenessOptions?:
    | {
        executionOwnerId: string;
        leaseDurationMs: number;
        renewBeforeMs: number;
      }
    | undefined;
  storeEventRecord(event: KernelRecord): Promise<HashString>;
}

interface ExpiredRecoveryHostDependencies {
  kernel: KrakenKernel;
  loadHeadState(branchId: string): Promise<HeadState>;
  now(): EpochMs;
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: {
      status: "completed" | "failed";
      timestamp: EpochMs;
      turnId: string;
      type: "turn.end";
    },
    loopState: LoopState
  ): void;
  readRecoveredActiveAgentName(
    turnTreeHash: HashString
  ): Promise<string | undefined>;
  readRecoveredRuntimeStatus(
    turnTreeHash: HashString
  ): Promise<DurableRuntimeStatus | undefined>;
  runLivenessOptions?:
    | {
        executionOwnerId: string;
      }
    | undefined;
}

interface TurnProgressHostDependencies {
  advanceTurnAndBranchHead(
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ): Promise<void>;
  completeTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    status: RunCompletionStatus,
    event?: KernelRecord
  ): Promise<{ turnNodeHash?: HashString }>;
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): void;
  kernel: KrakenKernel;
  storeEventRecord(event: KernelRecord): Promise<HashString>;
  syncRunLeaseStateFromStepResult(
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
  ): void;
}

interface FinalizationHostDependencies {
  createId(): string;
  defaultDriverId: string;
  finalizeRejectedPausedToolCancellation(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    pauseContext: PauseContext
  ): Promise<{
    pauseContext?: PauseContext;
    partial?: boolean;
    resolution: RuntimeResolution;
  }>;
  finalizeTurnStatus(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    partial: boolean,
    loopState: LoopState
  ): Promise<void>;
  kernel: KrakenKernel;
  loadHeadState(branchId: string): Promise<HeadState>;
  now(): EpochMs;
  publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void;
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: Record<string, unknown>,
    loopState: LoopState
  ): void;
  publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: unknown,
    fatal: boolean,
    loopState: LoopState
  ): void;
  resolveFailureActiveConfig(handle: RuntimeExecutionHandle): AgentConfig;
  storeEventRecord(event: KernelRecord): Promise<HashString>;
}

interface StartupHostDependencies {
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
  defaultDriverId: string;
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): void;
  kernel: KrakenKernel;
  loadHeadState(branchId: string): Promise<HeadState>;
  now(): EpochMs;
  publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void;
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: Record<string, unknown>,
    loopState: LoopState
  ): void;
  publishPauseOutcome(
    handle: RuntimeExecutionHandle,
    pauseContext: PauseContext | undefined,
    loopState: LoopState
  ): boolean;
  publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: unknown,
    fatal: boolean,
    loopState: LoopState
  ): void;
  resolveAgentConfig?(agentName: string): AgentConfig | undefined;
  resolveParentTurnId(
    threadId: string,
    branchId: string,
    explicitParentTurnId?: string | null
  ): Promise<string | null>;
  resumePausedToolExecution(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    resumeContext: import("./runtime-execution-types.js").ResumeContext
  ): Promise<import("./runtime-core-recovery.js").LoopOutcome>;
}

interface StateCommitHostDependencies {
  advanceTurnAndBranchHead(
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ): Promise<void>;
  collectInitialExtensionStateUpdates(
    extensions: LoopState["activeConfig"]["extensions"] | undefined,
    manifest: HeadState["manifest"]
  ): ExtensionStateUpdate[];
  completeTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    status: RunCompletionStatus,
    event?: KernelRecord
  ): Promise<{ turnNodeHash?: HashString }>;
  createId(): string;
  createTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    turnId: string,
    branchId: string,
    schemaId: string,
    startTurnNodeHash: HashString,
    steps: Array<{
      deterministic: boolean;
      id: string;
      sideEffects: boolean;
    }>
  ): Promise<void>;
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): void;
  kernel: KrakenKernel;
  loadHeadState(branchId: string): Promise<HeadState>;
  now(): EpochMs;
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: Record<string, unknown>,
    loopState: LoopState
  ): void;
  stageManifest(
    runId: string,
    manifest: ContextManifest,
    warningContext?: { handle: RuntimeExecutionHandle; loopState: LoopState }
  ): Promise<HashString>;
  stageMessage(
    runId: string,
    message: TuvrenMessage,
    taskId: string
  ): Promise<HashString>;
  stageRuntimeStatus(
    runId: string,
    runtimeStatus: {
      activeAgent?: string;
      state: "running";
    },
    taskId: string
  ): Promise<HashString>;
  stageTurnLineage(
    runId: string,
    turnId: string,
    taskId: string
  ): Promise<HashString>;
  storeEventRecord(event: KernelRecord): Promise<HashString>;
  syncRunLeaseStateFromStepResult(
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
  ): void;
}

interface DriverSupportHostDependencies {
  cloneAgentConfigForRequest(config: LoopState["activeConfig"]): AgentConfig;
  createContextEngineeringHelpers(
    messageHashes: HeadState["messageHashes"],
    messages: HeadState["messages"]
  ): { helpers: ContextEngineeringHelpers };
  createFrozenSnapshot<T>(value: T): T;
  defaultMaxParallelToolCalls: number;
  now(): EpochMs;
  publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void;
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: Record<string, unknown>,
    loopState: LoopState
  ): void;
  publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: unknown,
    fatal: boolean,
    loopState: LoopState
  ): void;
  resolveActiveMaxParallelToolCalls(
    loopState: LoopState,
    defaultMaxParallelToolCalls: number
  ): number;
  resolveDefaultHandoffContextBuilder(
    mode: string
  ): import("@tuvren/runtime-api").HandoffContextBuilder;
  resolveTargetAgent(targetAgent: string): AgentConfig;
  stageMessage(
    runId: string,
    message: TuvrenMessage,
    taskId?: string
  ): Promise<HashString>;
}

export function buildRuntimeCoreContextOpsHost(
  dependencies: ContextOpsHostDependencies
): RuntimeCoreContextOpsHost {
  return {
    advanceTurnAndBranchHead: (...args) =>
      dependencies.advanceTurnAndBranchHead(...args),
    beginRunStep: async (runId, stepId) => {
      await dependencies.kernel.run.beginStep(runId, stepId);
    },
    completeRunStep: async (runId, stepId, eventHash, treeHash) =>
      await dependencies.kernel.run.completeStep(
        runId,
        stepId,
        eventHash,
        undefined,
        treeHash
      ),
    completeTrackedRun: (...args) => dependencies.completeTrackedRun(...args),
    createActiveToolRegistry: (runtimeTools, config, clientEndpointBoundary) =>
      dependencies.createActiveToolRegistry(
        runtimeTools,
        config,
        clientEndpointBoundary
      ),
    createClientEndpointBoundaryFromConfig: (config) =>
      dependencies.createClientEndpointBoundaryFromConfig(config),
    createContextEngineeringHelpers: (messageHashes, messages) =>
      dependencies.createContextEngineeringHelpers(messageHashes, messages),
    createId: () => dependencies.createId(),
    createTrackedRun: (...args) => dependencies.createTrackedRun(...args),
    emitStateObservability: (...args) =>
      Promise.resolve(dependencies.emitStateObservability(...args)),
    loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
    materializeContextMessages: (hashes, helpers) =>
      dependencies.materializeContextMessages(hashes, helpers),
    publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
    resolveAgentConfig: (name) => dependencies.resolveAgentConfig?.(name),
    resolveHandoffSourceContext: (...args) =>
      dependencies.resolveHandoffSourceContext(...args),
    stageRuntimeStatus: (...args) => dependencies.stageRuntimeStatus(...args),
    storeEventRecord: (event) =>
      dependencies.storeEventRecord(event as KernelRecord),
    storeKernelRecord: (value, label) =>
      dependencies.storeKernelRecord(value, label),
    syncRunLeaseStateFromStepResult: (...args) =>
      dependencies.syncRunLeaseStateFromStepResult(...args),
    treeCreate: async (schemaId, changes, baseTurnTreeHash) =>
      await dependencies.kernel.tree.create(
        schemaId,
        changes,
        baseTurnTreeHash
      ),
  };
}

export function buildRuntimeCoreEventsHost(
  createId: () => string,
  enableStateObservability: () => boolean,
  now: () => EpochMs
): RuntimeCoreEventsHost {
  return {
    createId,
    enableStateObservability,
    now,
  };
}

export function buildRuntimeCorePersistenceHost(
  dependencies: PersistenceHostDependencies
): RuntimeCorePersistenceHost {
  return {
    emitWarning: (warning) => dependencies.emitWarning(warning),
    encodeKernelRecord: (value, label) =>
      dependencies.encodeKernelRecord(value, label),
    encryptMessageRecord: (record) =>
      encryptMessageRecord(dependencies.payloadCodecBinding, record),
    getManifestExtensionStateWarningBudgetBytes: () =>
      dependencies.getManifestExtensionStateWarningBudgetBytes(),
    getOrCreateManifestExtensionStateWarningKeys: (handle) =>
      dependencies.getOrCreateManifestExtensionStateWarningKeys(handle),
    stageRecord: async (runId, record, taskId, objectType) =>
      (
        await dependencies.kernel.staging.stage(
          runId,
          record,
          taskId,
          objectType,
          "completed"
        )
      ).objectHash,
    storeRecord: async (record) => await dependencies.kernel.store.put(record),
  };
}

export function buildRuntimeCoreLivenessHost(
  dependencies: LivenessHostDependencies
): RuntimeCoreLivenessHost {
  return {
    clearActiveLease: (handle) => {
      dependencies.activeRunLeaseControllers.delete(handle);
    },
    completeKernelRun: async (runId, status, eventHash) =>
      await dependencies.kernel.run.complete(runId, status, eventHash),
    createKernelRun: async (
      runId,
      turnId,
      branchId,
      schemaId,
      startTurnNodeHash,
      steps
    ) => {
      await dependencies.kernel.run.create(
        runId,
        turnId,
        branchId,
        schemaId,
        startTurnNodeHash,
        steps
      );
    },
    getActiveLease: (handle) =>
      dependencies.activeRunLeaseControllers.get(handle),
    getActiveRunId: (handle) => handle.getActiveRunId(),
    getNow: () => dependencies.now(),
    getRunLivenessOptions: () => dependencies.runLivenessOptions,
    getRuntimeKernel: () => dependencies.kernel,
    rememberActiveLease: (handle, lease) => {
      dependencies.activeRunLeaseControllers.set(handle, lease);
    },
    rememberActiveRunId: (handle, runId) => {
      handle.setActiveRunId(runId);
    },
    runPhase: (handle) => handle.status().phase,
    setNoActiveRunId: (handle) => {
      handle.takeActiveRunId();
    },
    storeEventRecord: async (event) =>
      await dependencies.storeEventRecord(event),
  };
}

export function buildRuntimeCoreExpiredRecoveryHost(
  dependencies: ExpiredRecoveryHostDependencies
): RuntimeCoreExpiredRecoveryHost {
  return {
    getNow: () => dependencies.now(),
    getRunLivenessOptions: () => dependencies.runLivenessOptions,
    getRuntimeKernel: () => dependencies.kernel,
    loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
    publishTurnEnd: (handle, status, loopState) => {
      dependencies.publishEvent(
        handle,
        {
          status,
          timestamp: dependencies.now(),
          turnId: handle.turnId,
          type: "turn.end",
        },
        loopState
      );
    },
    readRecoveredActiveAgentName: (turnTreeHash) =>
      dependencies.readRecoveredActiveAgentName(turnTreeHash as HashString),
    readRecoveredRuntimeStatus: (turnTreeHash) =>
      dependencies.readRecoveredRuntimeStatus(turnTreeHash as HashString),
  };
}

export function buildRuntimeCoreTurnProgressHost(
  dependencies: TurnProgressHostDependencies
): RuntimeCoreTurnProgressHost {
  return {
    advanceTurnAndBranchHead: (...args) =>
      dependencies.advanceTurnAndBranchHead(...args),
    branchSetHead: async (branchId, turnNodeHash) => {
      await dependencies.kernel.branch.setHead(branchId, turnNodeHash);
    },
    completeKernelRun: async (runId, status, eventHash) =>
      await dependencies.kernel.run.complete(runId, status, eventHash),
    completeTrackedRun: (...args) => dependencies.completeTrackedRun(...args),
    completeRunStep: async (runId, stepId, eventHash, treeHash) =>
      await dependencies.kernel.run.completeStep(
        runId,
        stepId,
        eventHash,
        undefined,
        treeHash
      ),
    emitStateObservability: (...args) =>
      Promise.resolve(dependencies.emitStateObservability(...args)),
    storeEventRecord: async (event) =>
      await dependencies.storeEventRecord(event),
    syncRunLeaseStateFromStepResult: (...args) =>
      dependencies.syncRunLeaseStateFromStepResult(...args),
    treeCreate: async (schemaId, changes, baseTurnTreeHash) =>
      await dependencies.kernel.tree.create(
        schemaId,
        changes,
        baseTurnTreeHash
      ),
  };
}

export function buildRuntimeCoreFinalizationHost(
  dependencies: FinalizationHostDependencies
): RuntimeCoreFinalizationHost {
  return {
    createId: () => dependencies.createId(),
    defaultDriverId: () => dependencies.defaultDriverId,
    finalizeRejectedPausedToolCancellation: (...args) =>
      dependencies.finalizeRejectedPausedToolCancellation(...args),
    finalizeTurnStatus: (...args) => dependencies.finalizeTurnStatus(...args),
    kernelTurnExists: async (turnId) =>
      (await dependencies.kernel.turn.get(turnId)) !== null,
    loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
    now: () => dependencies.now(),
    publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
    publishEvent: (handle, event, loopState) =>
      dependencies.publishEvent(handle, event as never, loopState),
    publishProjectedError: (handle, error, fatal, loopState) =>
      dependencies.publishProjectedError(handle, error, fatal, loopState),
    resolveFailureActiveConfig: (handle) =>
      dependencies.resolveFailureActiveConfig(handle),
    runComplete: async (runId, status, eventHash) =>
      await dependencies.kernel.run.complete(runId, status, eventHash),
    storeEventRecord: async (event) =>
      await dependencies.storeEventRecord(event as KernelRecord),
  };
}

export function buildRuntimeCoreStartupHost(
  dependencies: StartupHostDependencies
): RuntimeCoreStartupHost {
  return {
    applyTerminalAgentTransitionIfNeeded: (...args) =>
      dependencies.applyTerminalAgentTransitionIfNeeded(...args),
    checkpointResumeRunningStatus: (...args) =>
      dependencies.checkpointResumeRunningStatus(...args),
    commitPendingExtensionStateUpdates: (...args) =>
      dependencies.commitPendingExtensionStateUpdates(...args),
    completeExecution: (...args) => dependencies.completeExecution(...args),
    createActiveToolRegistry: (runtimeTools, config, clientEndpointBoundary) =>
      dependencies.createActiveToolRegistry(
        runtimeTools,
        config,
        clientEndpointBoundary
      ),
    createClientEndpointBoundaryFromConfig: (config) =>
      dependencies.createClientEndpointBoundaryFromConfig(config),
    createId: () => dependencies.createId(),
    defaultDriverId: () => dependencies.defaultDriverId,
    emitStateObservability: (...args) =>
      Promise.resolve(dependencies.emitStateObservability(...args)),
    loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
    now: () => dependencies.now(),
    publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
    publishEvent: (...args) => dependencies.publishEvent(...args),
    publishPauseOutcome: (handle, pauseContext, loopState) =>
      dependencies.publishPauseOutcome(
        handle,
        pauseContext as PauseContext | undefined,
        loopState
      ),
    publishProjectedError: (handle, error, fatal, loopState) =>
      dependencies.publishProjectedError(handle, error, fatal, loopState),
    resolveActiveConfig: (handle, recoveredExecution) => {
      const resumedPauseContext = handle.resumedFrom?.pauseContext;
      const recoveredActiveConfig =
        recoveredExecution?.activeAgentName === undefined
          ? undefined
          : (dependencies.resolveAgentConfig?.(
              recoveredExecution.activeAgentName
            ) ??
            (recoveredExecution.activeAgentName === handle.request.config.name
              ? handle.request.config
              : {
                  name: recoveredExecution.activeAgentName,
                }));

      return (
        resumedPauseContext?.activeConfig ??
        recoveredActiveConfig ??
        handle.request.config
      );
    },
    resolveBranchHeadHash: async (branchId, threadId) => {
      const branch = await dependencies.kernel.branch.get(branchId);

      if (branch === null) {
        throw new TuvrenLineageError(`branch "${branchId}" does not exist`, {
          code: "missing_branch",
        });
      }

      if (branch.threadId !== threadId) {
        throw new TuvrenLineageError(
          `branch "${branchId}" belongs to thread "${branch.threadId}", not "${threadId}"`,
          {
            code: "branch_thread_mismatch",
            details: {
              branchId,
              branchThreadId: branch.threadId,
              requestThreadId: threadId,
            },
          }
        );
      }

      return branch.headTurnNodeHash;
    },
    resolveParentTurnId: (...args) => dependencies.resolveParentTurnId(...args),
    resumePausedToolExecution: (...args) =>
      dependencies.resumePausedToolExecution(...args),
    turnCreate: async (
      turnId,
      threadId,
      branchId,
      parentTurnId,
      branchHeadHash
    ) => {
      await dependencies.kernel.turn.create(
        turnId,
        threadId,
        branchId,
        parentTurnId,
        branchHeadHash
      );
    },
  };
}

export function buildRuntimeCoreStateCommitHost(
  dependencies: StateCommitHostDependencies
): RuntimeCoreStateCommitHost {
  return {
    advanceTurnAndBranchHead: (...args) =>
      dependencies.advanceTurnAndBranchHead(...args),
    collectInitialExtensionStateUpdates: (extensions, manifest) =>
      dependencies.collectInitialExtensionStateUpdates(extensions, manifest),
    completeTrackedRun: (...args) => dependencies.completeTrackedRun(...args),
    createId: () => dependencies.createId(),
    createTrackedRun: (...args) => dependencies.createTrackedRun(...args),
    emitStateObservability: (...args) =>
      Promise.resolve(dependencies.emitStateObservability(...args)),
    kernelRunBeginStep: async (runId, stepId) => {
      await dependencies.kernel.run.beginStep(runId, stepId);
    },
    kernelRunCompleteStep: async (runId, stepId, eventHash) =>
      await dependencies.kernel.run.completeStep(runId, stepId, eventHash),
    loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
    now: () => dependencies.now(),
    publishEvent: (...args) => dependencies.publishEvent(...args),
    stageManifest: (...args) => dependencies.stageManifest(...args),
    stageMessage: (...args) => dependencies.stageMessage(...args),
    stageRuntimeStatus: (...args) => dependencies.stageRuntimeStatus(...args),
    stageTurnLineage: (...args) => dependencies.stageTurnLineage(...args),
    storeEventRecord: async (event) =>
      await dependencies.storeEventRecord(event as KernelRecord),
    syncRunLeaseStateFromStepResult: (...args) =>
      dependencies.syncRunLeaseStateFromStepResult(...args),
  };
}

export function buildRuntimeCoreDriverSupportHost(
  dependencies: DriverSupportHostDependencies
): RuntimeCoreDriverSupportHost {
  return {
    cloneAgentConfigForRequest: (config) =>
      dependencies.cloneAgentConfigForRequest(config),
    createContextEngineeringHelpers: (messageHashes, messages) =>
      dependencies.createContextEngineeringHelpers(messageHashes, messages),
    createFrozenSnapshot: <T>(value: T) =>
      dependencies.createFrozenSnapshot(value),
    defaultMaxParallelToolCalls: () => dependencies.defaultMaxParallelToolCalls,
    now: () => dependencies.now(),
    publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
    publishEvent: (handle, event, loopState) =>
      dependencies.publishEvent(handle, event as never, loopState),
    publishProjectedError: (handle, error, fatal, loopState) =>
      dependencies.publishProjectedError(handle, error, fatal, loopState),
    resolveActiveMaxParallelToolCalls: (
      loopState,
      defaultMaxParallelToolCalls
    ) =>
      dependencies.resolveActiveMaxParallelToolCalls(
        loopState,
        defaultMaxParallelToolCalls
      ),
    resolveDefaultHandoffContextBuilder: (mode) =>
      dependencies.resolveDefaultHandoffContextBuilder(mode),
    resolveTargetAgent: (targetAgent) =>
      dependencies.resolveTargetAgent(targetAgent),
    stageToolResultMessage: async (runId, result, orderIndex) =>
      await dependencies.stageMessage(
        runId,
        {
          parts: [result],
          role: "tool",
        },
        `tool_result_${orderIndex}_${result.callId}`
      ),
  };
}
