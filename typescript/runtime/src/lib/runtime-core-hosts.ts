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

import { assertKernelRecord, TuvrenLineageError } from "@tuvren/core";
import type { EpochMs, HashString, KernelRecord } from "@tuvren/core";
import type { ClientEndpointBoundary } from "@tuvren/core/capabilities";
import type {
  AgentConfig,
  ContextEngineeringHelpers,
  ContextManifest,
  HandoffContextBuilder,
  HandoffContextPlan,
  HandoffSourceContext,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { ToolRegistry } from "@tuvren/core/tools";
import type {
  RunCompletionStatus,
  RuntimeKernel,
} from "@tuvren/kernel-protocol";

import type { ExtensionStateUpdate } from "./extension-runtime.js";
import { encryptMessageRecord } from "./payload-codec-seam.js";
import type { PayloadCodecBinding } from "./payload-codec-seam.js";
import type { RuntimeCoreContextOpsHost } from "./runtime-core-context-ops.js";
import type { HelperBundle } from "./runtime-core-context.js";
import type { RuntimeCoreEventsHost } from "./runtime-core-events.js";
import type { RuntimeCoreExpiredRecoveryHost } from "./runtime-core-expired-recovery.js";
import type { RuntimeCoreFinalizationHost } from "./runtime-core-finalization.js";
import type { InterruptedToolBatchDescriptor } from "./runtime-core-interrupted-metadata.js";
import type {
  ActiveRunLease,
  RuntimeCoreLivenessHost,
} from "./runtime-core-liveness.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type { RuntimeCorePersistenceHost } from "./runtime-core-persistence.js";
import type {
  DurableRuntimeStatus,
  LoopOutcome,
} from "./runtime-core-recovery.js";
import type { RuntimeCoreRunnerSupportHost } from "./runtime-core-runner-support.js";
import type { RuntimeCoreStartupHost } from "./runtime-core-startup.js";
import type { RuntimeCoreStateCommitHost } from "./runtime-core-state-commit.js";
import type { RuntimeCoreTurnProgressHost } from "./runtime-core-turn-progress.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type {
  ExecutionSessionRequest,
  PauseContext,
  ResumeContext,
} from "./runtime-execution-types.js";

// Each builder in this module adapts a flat dependency bag (callbacks bound by
// RuntimeCore plus the kernel) into the narrow host interface one split
// `runtime-core-*` module consumes, closing over kernel syscalls where the
// module needs them. The `*HostDependencies` interfaces below describe those
// bags; they are internal wiring, not a public contract.

/** Dependencies for {@link buildRuntimeCoreContextOpsHost}. */
interface ContextOpsHostDependencies {
  advanceTurnAndBranchHead: (
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ) => Promise<void>;
  cloneAgentConfigForRequest: (config: AgentConfig) => AgentConfig;
  completeTrackedRun: (
    handle: RuntimeExecutionHandle,
    runId: string,
    status: RunCompletionStatus,
    event?: KernelRecord
  ) => Promise<{ turnNodeHash?: HashString }>;
  createActiveToolRegistry: (
    runtimeTools: ExecutionSessionRequest["tools"] | undefined,
    config: AgentConfig,
    clientEndpointBoundary?: ClientEndpointBoundary
  ) => ToolRegistry;
  createClientEndpointBoundaryFromConfig: (
    config: AgentConfig
  ) => ClientEndpointBoundary | undefined;
  createContextEngineeringHelpers: (
    messageHashes: HashString[],
    messages: TuvrenMessage[]
  ) => HelperBundle;
  createId: () => string;
  createTrackedRun: (
    handle: RuntimeExecutionHandle,
    runId: string,
    turnId: string,
    branchId: string,
    schemaId: string,
    startTurnNodeHash: HashString,
    steps: {
      deterministic: boolean;
      id: string;
      sideEffects: boolean;
    }[]
  ) => Promise<void>;
  emitStateObservability: (
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ) => void;
  kernel: RuntimeKernel;
  loadHeadState: (branchId: string) => Promise<HeadState>;
  materializeContextMessages: (
    hashes: HashString[],
    helpers: ContextEngineeringHelpers
  ) => TuvrenMessage[];
  publishCustomEvent: (
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ) => void;
  resolveAgentConfig?: (name: string) => AgentConfig | undefined;
  resolveHandoffSourceContext: (
    plan: HandoffContextPlan,
    headState: HeadState,
    loopState: LoopState,
    targetConfig: AgentConfig,
    helpers: ContextEngineeringHelpers
  ) => HandoffSourceContext;
  stageRuntimeStatus: (
    runId: string,
    runtimeStatus: {
      activeAgent?: string;
      state: "running";
    },
    taskId: string
  ) => Promise<HashString>;
  storeEventRecord: (event: KernelRecord) => Promise<HashString>;
  storeKernelRecord: (value: unknown, label: string) => Promise<HashString>;
  syncRunLeaseStateFromStepResult: (
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
  ) => void;
}

/** Dependencies for {@link buildRuntimeCorePersistenceHost}. */
interface PersistenceHostDependencies {
  emitWarning: (warning: {
    activeAgent: string;
    budgetBytes: number;
    code: "manifest_extension_state_budget_exceeded";
    extensionName: string;
    observedBytes: number;
    runId: string;
    threadId: string;
    turnId: string;
  }) => void;
  encodeKernelRecord: (value: unknown, label: string) => Uint8Array;
  getManifestExtensionStateWarningBudgetBytes: () => false | number;
  getOrCreateManifestExtensionStateWarningKeys: (
    handle: RuntimeExecutionHandle
  ) => Set<string>;
  kernel: RuntimeKernel;
  payloadCodecBinding: PayloadCodecBinding;
}

/** Dependencies for {@link buildRuntimeCoreLivenessHost}. */
interface LivenessHostDependencies {
  activeRunLeaseControllers: WeakMap<RuntimeExecutionHandle, ActiveRunLease>;
  kernel: RuntimeKernel;
  now: () => EpochMs;
  runLivenessOptions?:
    | {
        executionOwnerId: string;
        leaseDurationMs: number;
        renewBeforeMs: number;
      }
    | undefined;
  storeEventRecord: (event: KernelRecord) => Promise<HashString>;
}

/** Dependencies for {@link buildRuntimeCoreExpiredRecoveryHost}. */
interface ExpiredRecoveryHostDependencies {
  kernel: RuntimeKernel;
  loadHeadState: (branchId: string) => Promise<HeadState>;
  now: () => EpochMs;
  payloadCodecBinding: PayloadCodecBinding;
  publishEvent: (
    handle: RuntimeExecutionHandle,
    event: {
      status: "completed" | "failed";
      timestamp: EpochMs;
      turnId: string;
      type: "turn.end";
    },
    loopState: LoopState
  ) => void;
  readRecoveredActiveAgentName: (
    turnTreeHash: HashString
  ) => Promise<string | undefined>;
  readRecoveredRuntimeStatus: (
    turnTreeHash: HashString
  ) => Promise<DurableRuntimeStatus | undefined>;
  runLivenessOptions?:
    | {
        executionOwnerId: string;
      }
    | undefined;
}

/** Dependencies for {@link buildRuntimeCoreTurnProgressHost}. */
interface TurnProgressHostDependencies {
  advanceTurnAndBranchHead: (
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ) => Promise<void>;
  completeTrackedRun: (
    handle: RuntimeExecutionHandle,
    runId: string,
    status: RunCompletionStatus,
    event?: KernelRecord
  ) => Promise<{ turnNodeHash?: HashString }>;
  emitStateObservability: (
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ) => void;
  kernel: RuntimeKernel;
  storeEventRecord: (event: KernelRecord) => Promise<HashString>;
  syncRunLeaseStateFromStepResult: (
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
  ) => void;
}

/** Dependencies for {@link buildRuntimeCoreFinalizationHost}. */
interface FinalizationHostDependencies {
  createId: () => string;
  defaultRunnerId: string;
  finalizeRejectedPausedToolCancellation: (
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    pauseContext: PauseContext
  ) => Promise<{
    pauseContext?: PauseContext;
    partial?: boolean;
    resolution: RuntimeResolution;
  }>;
  finalizeTurnStatus: (
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    partial: boolean,
    loopState: LoopState
  ) => Promise<void>;
  kernel: RuntimeKernel;
  loadHeadState: (branchId: string) => Promise<HeadState>;
  now: () => EpochMs;
  publishCustomEvent: (
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ) => void;
  publishEvent: (
    handle: RuntimeExecutionHandle,
    event: Parameters<RuntimeExecutionHandle["publish"]>[0],
    loopState: LoopState
  ) => void;
  publishProjectedError: (
    handle: RuntimeExecutionHandle,
    error: unknown,
    fatal: boolean,
    loopState: LoopState
  ) => void;
  resolveFailureActiveConfig: (handle: RuntimeExecutionHandle) => AgentConfig;
  storeEventRecord: (event: KernelRecord) => Promise<HashString>;
}

/** Dependencies for {@link buildRuntimeCoreStartupHost}. */
interface StartupHostDependencies {
  applyTerminalAgentTransitionIfNeeded: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    resolution: RuntimeResolution,
    loopState: LoopState,
    stableHeadTurnNodeHash?: HashString
  ) => Promise<boolean>;
  checkpointResumeRunningStatus: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    iterationCount: number,
    emitObservability?: boolean
  ) => Promise<
    | {
        iterationCount: number;
        manifest?: ContextManifest;
        turnNodeHash: HashString;
      }
    | undefined
  >;
  commitPendingExtensionStateUpdates: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    updates: ExtensionStateUpdate[],
    iterationCount: number
  ) => Promise<void>;
  completeExecution: (
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    partial: boolean,
    loopState: LoopState,
    enteredIterationLoop: boolean
  ) => Promise<void>;
  createActiveToolRegistry: (
    runtimeTools: ExecutionSessionRequest["tools"] | undefined,
    config: LoopState["activeConfig"],
    clientEndpointBoundary?: ClientEndpointBoundary
  ) => ToolRegistry;
  createClientEndpointBoundaryFromConfig: (
    config: LoopState["activeConfig"]
  ) => ClientEndpointBoundary | undefined;
  createId: () => string;
  defaultRunnerId: string;
  emitStateObservability: (
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ) => void;
  kernel: RuntimeKernel;
  loadHeadState: (branchId: string) => Promise<HeadState>;
  now: () => EpochMs;
  publishCustomEvent: (
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ) => void;
  publishEvent: (
    handle: RuntimeExecutionHandle,
    event: Record<string, unknown>,
    loopState: LoopState
  ) => void;
  publishPauseOutcome: (
    handle: RuntimeExecutionHandle,
    pauseContext: PauseContext | undefined,
    loopState: LoopState
  ) => boolean;
  publishProjectedError: (
    handle: RuntimeExecutionHandle,
    error: unknown,
    fatal: boolean,
    loopState: LoopState
  ) => void;
  resolveAgentConfig?: (agentName: string) => AgentConfig | undefined;
  resolveParentTurnId: (
    threadId: string,
    branchId: string,
    explicitParentTurnId?: string | null
  ) => Promise<string | null>;
  resumePausedToolExecution: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    resumeContext: ResumeContext
  ) => Promise<LoopOutcome>;
}

/** Dependencies for {@link buildRuntimeCoreStateCommitHost}. */
interface StateCommitHostDependencies {
  advanceTurnAndBranchHead: (
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ) => Promise<void>;
  collectInitialExtensionStateUpdates: (
    extensions: LoopState["activeConfig"]["extensions"] | undefined,
    manifest: HeadState["manifest"]
  ) => ExtensionStateUpdate[];
  completeTrackedRun: (
    handle: RuntimeExecutionHandle,
    runId: string,
    status: RunCompletionStatus,
    event?: KernelRecord
  ) => Promise<{ turnNodeHash?: HashString }>;
  createId: () => string;
  createTrackedRun: (
    handle: RuntimeExecutionHandle,
    runId: string,
    turnId: string,
    branchId: string,
    schemaId: string,
    startTurnNodeHash: HashString,
    steps: {
      deterministic: boolean;
      id: string;
      sideEffects: boolean;
    }[]
  ) => Promise<void>;
  emitStateObservability: (
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ) => void;
  kernel: RuntimeKernel;
  loadHeadState: (branchId: string) => Promise<HeadState>;
  now: () => EpochMs;
  publishEvent: (
    handle: RuntimeExecutionHandle,
    event: Record<string, unknown>,
    loopState: LoopState
  ) => void;
  stageManifest: (
    runId: string,
    manifest: ContextManifest,
    warningContext?: { handle: RuntimeExecutionHandle; loopState: LoopState },
    taskId?: string
  ) => Promise<HashString>;
  stageMessage: (
    runId: string,
    message: TuvrenMessage,
    taskId: string
  ) => Promise<HashString>;
  stageRuntimeStatus: (
    runId: string,
    runtimeStatus: {
      activeAgent?: string;
      state: "running";
    },
    taskId: string
  ) => Promise<HashString>;
  stageTurnLineage: (
    runId: string,
    turnId: string,
    taskId: string,
    interruptedToolBatch?: InterruptedToolBatchDescriptor
  ) => Promise<HashString>;
  storeEventRecord: (event: KernelRecord) => Promise<HashString>;
  syncRunLeaseStateFromStepResult: (
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
  ) => void;
}

/** Dependencies for {@link buildRuntimeCoreRunnerSupportHost}. */
interface RunnerSupportHostDependencies {
  cloneAgentConfigForRequest: (
    config: LoopState["activeConfig"]
  ) => AgentConfig;
  createContextEngineeringHelpers: (
    messageHashes: HeadState["messageHashes"],
    messages: HeadState["messages"]
  ) => { helpers: ContextEngineeringHelpers };
  createFrozenSnapshot: <T>(value: T) => T;
  defaultMaxParallelToolCalls: number;
  now: () => EpochMs;
  publishCustomEvent: (
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ) => void;
  publishEvent: (
    handle: RuntimeExecutionHandle,
    event: Parameters<RuntimeExecutionHandle["publish"]>[0],
    loopState: LoopState
  ) => void;
  publishProjectedError: (
    handle: RuntimeExecutionHandle,
    error: unknown,
    fatal: boolean,
    loopState: LoopState
  ) => void;
  resolveActiveMaxParallelToolCalls: (
    loopState: LoopState,
    defaultMaxParallelToolCalls: number
  ) => number;
  resolveDefaultHandoffContextBuilder: (mode: string) => HandoffContextBuilder;
  resolveTargetAgent: (targetAgent: string) => AgentConfig;
  stageManifest: (
    runId: string,
    manifest: ContextManifest,
    taskId: string
  ) => Promise<HashString>;
  stageMessage: (
    runId: string,
    message: TuvrenMessage,
    taskId?: string
  ) => Promise<HashString>;
}

/**
 * Builds the host seam for the context-operations module
 * (`runtime-core-context-ops.ts`): head-state loading, context-message
 * materialization, tool-registry/client-endpoint construction, handoff source
 * resolution, and the kernel run-step + tree-create calls that commit context
 * changes.
 */
export const buildRuntimeCoreContextOpsHost = (
  dependencies: ContextOpsHostDependencies
): RuntimeCoreContextOpsHost => ({
  advanceTurnAndBranchHead: async (...args) => {
    await dependencies.advanceTurnAndBranchHead(...args);
  },
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
  completeTrackedRun: async (...args) =>
    await dependencies.completeTrackedRun(...args),
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
  createTrackedRun: async (...args) => {
    await dependencies.createTrackedRun(...args);
  },
  emitStateObservability: (...args) => {
    dependencies.emitStateObservability(...args);
  },
  loadHeadState: async (branchId) => await dependencies.loadHeadState(branchId),
  materializeContextMessages: (hashes, helpers) =>
    dependencies.materializeContextMessages(hashes, helpers),
  publishCustomEvent: (...args) => {
    dependencies.publishCustomEvent(...args);
  },
  resolveAgentConfig: (name) => dependencies.resolveAgentConfig?.(name),
  resolveHandoffSourceContext: (...args) =>
    dependencies.resolveHandoffSourceContext(...args),
  stageRuntimeStatus: async (...args) =>
    await dependencies.stageRuntimeStatus(...args),
  storeEventRecord: async (event) => {
    assertKernelRecord(event, "event");
    return await dependencies.storeEventRecord(event);
  },
  storeKernelRecord: async (value, label) =>
    await dependencies.storeKernelRecord(value, label),
  syncRunLeaseStateFromStepResult: (...args) => {
    dependencies.syncRunLeaseStateFromStepResult(...args);
  },
  treeCreate: async (schemaId, changes, baseTurnTreeHash) =>
    await dependencies.kernel.tree.create(schemaId, changes, baseTurnTreeHash),
});

/**
 * Builds the host seam for the events module (`runtime-core-events.ts`): id
 * generation, the state-observability toggle, and the clock.
 */
export const buildRuntimeCoreEventsHost = (
  createId: () => string,
  enableStateObservability: () => boolean,
  now: () => EpochMs
): RuntimeCoreEventsHost => ({
  createId,
  enableStateObservability,
  now,
});

/**
 * Builds the host seam for the persistence module
 * (`runtime-core-persistence.ts`): kernel record encoding, the
 * crypto-shredding message-encryption seam, manifest extension-state budget
 * warnings, and the kernel `staging.stage` / `store.put` writes.
 */
export const buildRuntimeCorePersistenceHost = (
  dependencies: PersistenceHostDependencies
): RuntimeCorePersistenceHost => ({
  emitWarning: (warning) => {
    dependencies.emitWarning(warning);
  },
  encodeKernelRecord: (value, label) =>
    dependencies.encodeKernelRecord(value, label),
  encryptMessageRecord: async (record) =>
    await encryptMessageRecord(dependencies.payloadCodecBinding, record),
  getManifestExtensionStateWarningBudgetBytes: () =>
    dependencies.getManifestExtensionStateWarningBudgetBytes(),
  getOrCreateManifestExtensionStateWarningKeys: (handle) =>
    dependencies.getOrCreateManifestExtensionStateWarningKeys(handle),
  stageRecord: async (runId, record, taskId, objectType) => {
    const stageResult = await dependencies.kernel.staging.stage(
      runId,
      record,
      taskId,
      objectType,
      "completed"
    );
    return stageResult.objectHash;
  },
  storeRecord: async (record) => await dependencies.kernel.store.put(record),
});

/**
 * Builds the host seam for the run-liveness module
 * (`runtime-core-liveness.ts`): kernel run create/complete, the per-handle
 * active-lease bookkeeping (backed by the runtime's `WeakMap`), the active
 * run id stored on the handle, and the liveness configuration.
 */
export const buildRuntimeCoreLivenessHost = (
  dependencies: LivenessHostDependencies
): RuntimeCoreLivenessHost => ({
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
  storeEventRecord: async (event) => await dependencies.storeEventRecord(event),
});

/**
 * Builds the host seam for the expired-run recovery module
 * (`runtime-core-expired-recovery.ts`): reading the recovered runtime status
 * and active agent from a durable turn tree, head-state loading, and the
 * recovered `turn.end` event publication.
 */
export const buildRuntimeCoreExpiredRecoveryHost = (
  dependencies: ExpiredRecoveryHostDependencies
): RuntimeCoreExpiredRecoveryHost => ({
  getNow: () => dependencies.now(),
  getPayloadCodecBinding: () => dependencies.payloadCodecBinding,
  getRunLivenessOptions: () => dependencies.runLivenessOptions,
  getRuntimeKernel: () => dependencies.kernel,
  loadHeadState: async (branchId) => await dependencies.loadHeadState(branchId),
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
  readRecoveredActiveAgentName: async (turnTreeHash) =>
    await dependencies.readRecoveredActiveAgentName(turnTreeHash),
  readRecoveredRuntimeStatus: async (turnTreeHash) =>
    await dependencies.readRecoveredRuntimeStatus(turnTreeHash),
});

/**
 * Builds the host seam for the turn-progress module
 * (`runtime-core-turn-progress.ts`): branch-head advancement, kernel
 * run/step completion, tree creation, and lease synchronization from step
 * results.
 */
export const buildRuntimeCoreTurnProgressHost = (
  dependencies: TurnProgressHostDependencies
): RuntimeCoreTurnProgressHost => ({
  advanceTurnAndBranchHead: async (...args) => {
    await dependencies.advanceTurnAndBranchHead(...args);
  },
  branchSetHead: async (branchId, turnNodeHash) => {
    await dependencies.kernel.branch.setHead(branchId, turnNodeHash);
  },
  completeKernelRun: async (runId, status, eventHash) =>
    await dependencies.kernel.run.complete(runId, status, eventHash),
  completeRunStep: async (runId, stepId, eventHash, treeHash) =>
    await dependencies.kernel.run.completeStep(
      runId,
      stepId,
      eventHash,
      undefined,
      treeHash
    ),
  completeTrackedRun: async (...args) =>
    await dependencies.completeTrackedRun(...args),
  emitStateObservability: (...args) => {
    dependencies.emitStateObservability(...args);
  },
  storeEventRecord: async (event) => await dependencies.storeEventRecord(event),
  syncRunLeaseStateFromStepResult: (...args) => {
    dependencies.syncRunLeaseStateFromStepResult(...args);
  },
  treeCreate: async (schemaId, changes, baseTurnTreeHash) =>
    await dependencies.kernel.tree.create(schemaId, changes, baseTurnTreeHash),
});

/**
 * Builds the host seam for the finalization module
 * (`runtime-core-finalization.ts`): turn-status finalization, rejected
 * paused-tool cancellation, kernel turn existence/run completion checks, and
 * the event publication paths used while a turn is being closed out.
 */
export const buildRuntimeCoreFinalizationHost = (
  dependencies: FinalizationHostDependencies
): RuntimeCoreFinalizationHost => ({
  createId: () => dependencies.createId(),
  defaultRunnerId: () => dependencies.defaultRunnerId,
  finalizeRejectedPausedToolCancellation: async (...args) =>
    await dependencies.finalizeRejectedPausedToolCancellation(...args),
  finalizeTurnStatus: async (...args) => {
    await dependencies.finalizeTurnStatus(...args);
  },
  kernelTurnExists: async (turnId) =>
    (await dependencies.kernel.turn.get(turnId)) !== null,
  loadHeadState: async (branchId) => await dependencies.loadHeadState(branchId),
  now: () => dependencies.now(),
  publishCustomEvent: (...args) => {
    dependencies.publishCustomEvent(...args);
  },
  publishEvent: (handle, event, loopState) => {
    dependencies.publishEvent(handle, event, loopState);
  },
  publishProjectedError: (handle, error, fatal, loopState) => {
    dependencies.publishProjectedError(handle, error, fatal, loopState);
  },
  resolveFailureActiveConfig: (handle) =>
    dependencies.resolveFailureActiveConfig(handle),
  runComplete: async (runId, status, eventHash) =>
    await dependencies.kernel.run.complete(runId, status, eventHash),
  storeEventRecord: async (event) => {
    assertKernelRecord(event, "event");
    return await dependencies.storeEventRecord(event);
  },
});

/**
 * Builds the host seam for the startup module (`runtime-core-startup.ts`),
 * which prepares fresh and resumed execution starts.
 *
 * Besides forwarding the dependency bag, this builder owns two decisions:
 * `resolveActiveConfig` picks the active agent config with precedence
 * resumed-pause context → recovered execution's agent (via
 * `resolveAgentConfig`, falling back to the request config when the names
 * match) → the request config; and `resolveBranchHeadHash` validates that the
 * branch exists and belongs to the requested thread before returning its
 * head, throwing `missing_branch` / `branch_thread_mismatch` lineage errors
 * otherwise.
 */
export const buildRuntimeCoreStartupHost = (
  dependencies: StartupHostDependencies
): RuntimeCoreStartupHost => {
  const resumedPauseContexts = new WeakMap<
    RuntimeExecutionHandle,
    PauseContext | undefined
  >();

  return {
    applyTerminalAgentTransitionIfNeeded: async (...args) =>
      await dependencies.applyTerminalAgentTransitionIfNeeded(...args),
    checkpointResumeRunningStatus: async (...args) =>
      await dependencies.checkpointResumeRunningStatus(...args),
    commitPendingExtensionStateUpdates: async (...args) => {
      await dependencies.commitPendingExtensionStateUpdates(...args);
    },
    completeExecution: async (...args) => {
      await dependencies.completeExecution(...args);
    },
    createActiveToolRegistry: (runtimeTools, config, clientEndpointBoundary) =>
      dependencies.createActiveToolRegistry(
        runtimeTools,
        config,
        clientEndpointBoundary
      ),
    createClientEndpointBoundaryFromConfig: (config) =>
      dependencies.createClientEndpointBoundaryFromConfig(config),
    createId: () => dependencies.createId(),
    defaultRunnerId: () => dependencies.defaultRunnerId,
    emitStateObservability: (...args) => {
      dependencies.emitStateObservability(...args);
    },
    loadHeadState: async (branchId) =>
      await dependencies.loadHeadState(branchId),
    now: () => dependencies.now(),
    publishCustomEvent: (...args) => {
      dependencies.publishCustomEvent(...args);
    },
    publishEvent: (...args) => {
      dependencies.publishEvent(...args);
    },
    publishPauseOutcome: (handle, pauseContext, loopState) => {
      const resumedPauseContext = resumedPauseContexts.get(handle);
      if (pauseContext !== resumedPauseContext) {
        throw new TypeError(
          "pause outcome context must match the resumed tool execution result"
        );
      }
      resumedPauseContexts.delete(handle);
      return dependencies.publishPauseOutcome(
        handle,
        resumedPauseContext,
        loopState
      );
    },
    publishProjectedError: (handle, error, fatal, loopState) => {
      dependencies.publishProjectedError(handle, error, fatal, loopState);
    },
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
    resolveParentTurnId: async (...args) =>
      await dependencies.resolveParentTurnId(...args),
    resumePausedToolExecution: async (handle, ...args) => {
      const outcome = await dependencies.resumePausedToolExecution(
        handle,
        ...args
      );
      resumedPauseContexts.set(handle, outcome.pauseContext);
      return outcome;
    },
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
};

/**
 * Builds the host seam for the state-commit module
 * (`runtime-core-state-commit.ts`): staging of messages, manifests, runtime
 * status, and turn lineage; kernel run-step begin/complete; tracked-run
 * lifecycle; and branch-head advancement after a commit.
 */
export const buildRuntimeCoreStateCommitHost = (
  dependencies: StateCommitHostDependencies
): RuntimeCoreStateCommitHost => ({
  advanceTurnAndBranchHead: async (...args) => {
    await dependencies.advanceTurnAndBranchHead(...args);
  },
  collectInitialExtensionStateUpdates: (extensions, manifest) =>
    dependencies.collectInitialExtensionStateUpdates(extensions, manifest),
  completeTrackedRun: async (...args) =>
    await dependencies.completeTrackedRun(...args),
  createId: () => dependencies.createId(),
  createTrackedRun: async (...args) => {
    await dependencies.createTrackedRun(...args);
  },
  emitStateObservability: (...args) => {
    dependencies.emitStateObservability(...args);
  },
  kernelRunBeginStep: async (runId, stepId) => {
    await dependencies.kernel.run.beginStep(runId, stepId);
  },
  kernelRunCompleteStep: async (runId, stepId, eventHash) =>
    await dependencies.kernel.run.completeStep(runId, stepId, eventHash),
  loadHeadState: async (branchId) => await dependencies.loadHeadState(branchId),
  now: () => dependencies.now(),
  publishEvent: (...args) => {
    dependencies.publishEvent(...args);
  },
  stageManifest: async (...args) => await dependencies.stageManifest(...args),
  stageMessage: async (...args) => await dependencies.stageMessage(...args),
  stageRuntimeStatus: async (...args) =>
    await dependencies.stageRuntimeStatus(...args),
  stageTurnLineage: async (...args) =>
    await dependencies.stageTurnLineage(...args),
  storeEventRecord: async (event) => {
    assertKernelRecord(event, "event");
    return await dependencies.storeEventRecord(event);
  },
  syncRunLeaseStateFromStepResult: (...args) => {
    dependencies.syncRunLeaseStateFromStepResult(...args);
  },
});

/**
 * Builds the host seam for the runner-support module
 * (`runtime-core-runner-support.ts`): agent-config cloning/snapshots,
 * context-engineering helpers, parallel-tool-call resolution, handoff target
 * resolution, and staging of tool-result messages (each wrapped as a
 * single-part `tool` role message keyed by order index and call id).
 */
export const buildRuntimeCoreRunnerSupportHost = (
  dependencies: RunnerSupportHostDependencies
): RuntimeCoreRunnerSupportHost => ({
  cloneAgentConfigForRequest: (config) =>
    dependencies.cloneAgentConfigForRequest(config),
  createContextEngineeringHelpers: (messageHashes, messages) =>
    dependencies.createContextEngineeringHelpers(messageHashes, messages),
  createFrozenSnapshot: <T>(value: T) =>
    dependencies.createFrozenSnapshot(value),
  defaultMaxParallelToolCalls: () => dependencies.defaultMaxParallelToolCalls,
  now: () => dependencies.now(),
  publishCustomEvent: (...args) => {
    dependencies.publishCustomEvent(...args);
  },
  publishEvent: (handle, event, loopState) => {
    dependencies.publishEvent(handle, event, loopState);
  },
  publishProjectedError: (handle, error, fatal, loopState) => {
    dependencies.publishProjectedError(handle, error, fatal, loopState);
  },
  resolveActiveMaxParallelToolCalls: (loopState, defaultMaxParallelToolCalls) =>
    dependencies.resolveActiveMaxParallelToolCalls(
      loopState,
      defaultMaxParallelToolCalls
    ),
  resolveDefaultHandoffContextBuilder: (mode) =>
    dependencies.resolveDefaultHandoffContextBuilder(mode),
  resolveTargetAgent: (targetAgent) =>
    dependencies.resolveTargetAgent(targetAgent),
  stageToolResultManifest: async (runId, manifest, taskId) => {
    await dependencies.stageManifest(runId, manifest, taskId);
  },
  stageToolResultMessage: async (runId, result, orderIndex) =>
    await dependencies.stageMessage(
      runId,
      {
        parts: [result],
        role: "tool",
      },
      `tool_result_${orderIndex}_${result.callId}`
    ),
});
