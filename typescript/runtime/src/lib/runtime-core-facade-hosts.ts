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

import type { EpochMs, HashString, KernelRecord } from "@tuvren/core";
import { assertTuvrenStreamEvent } from "@tuvren/core/events";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
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
  PathValue,
  RunCompletionStatus,
  RuntimeKernel,
} from "@tuvren/kernel-protocol";

import type { ExtensionStateUpdate } from "./extension-runtime.js";
import type { PayloadCodecBinding } from "./payload-codec-seam.js";
import type { RuntimeCoreContextOpsHost } from "./runtime-core-context-ops.js";
import type { HelperBundle } from "./runtime-core-context.js";
import type { RuntimeCoreEventsHost } from "./runtime-core-events.js";
import type { RuntimeCoreExpiredRecoveryHost } from "./runtime-core-expired-recovery.js";
import {
  collectInitialExtensionStateUpdates,
  createActiveToolRegistry,
  createClientEndpointBoundaryFromConfig,
  encodeKernelRecord,
} from "./runtime-core-facade-utils.js";
import type { RuntimeCoreFinalizationHost } from "./runtime-core-finalization.js";
import {
  buildRuntimeCoreRunnerHost,
  buildRuntimeCoreToolResumeHost,
} from "./runtime-core-hosts-execution.js";
import { buildRuntimeCorePersistenceHost } from "./runtime-core-hosts-persistence.js";
import {
  buildRuntimeCoreContextOpsHost,
  buildRuntimeCoreEventsHost,
  buildRuntimeCoreExpiredRecoveryHost,
  buildRuntimeCoreFinalizationHost,
  buildRuntimeCoreLivenessHost,
  buildRuntimeCoreRunnerSupportHost,
  buildRuntimeCoreStartupHost,
  buildRuntimeCoreStateCommitHost,
  buildRuntimeCoreTurnProgressHost,
} from "./runtime-core-hosts.js";
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
import type { RuntimeCoreRunnerHost } from "./runtime-core-runner.js";
import { createFrozenSnapshot, normalizeError } from "./runtime-core-shared.js";
import type { RuntimeCoreStartupHost } from "./runtime-core-startup.js";
import type { RuntimeCoreStateCommitHost } from "./runtime-core-state-commit.js";
import type { RuntimeCoreStatusHost } from "./runtime-core-status.js";
import type { RuntimeCoreToolResumeHost } from "./runtime-core-tool-resume.js";
import type { RuntimeCoreTurnProgressHost } from "./runtime-core-turn-progress.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { PauseContext, ResumeContext } from "./runtime-execution-types.js";

/**
 * The full set of per-concern host slices the runtime-core facade functions
 * operate through.
 *
 * Each slice is a narrow capability surface for one phase or concern of the
 * shared execution core (startup, runner iteration, finalization, recovery,
 * and so on). {@link createRuntimeCoreFacadeHosts} builds all slices from a
 * single flat dependency bag so every slice observes the same kernel, clock,
 * id source, and event publishers.
 */
export interface RuntimeCoreFacadeHosts {
  /** Context-engineering operations: applying plans and agent handoffs. */
  contextOps: RuntimeCoreContextOpsHost;
  /** Stream-event publishing helpers and state-observability emission. */
  events: RuntimeCoreEventsHost;
  /** Recovery of executions whose run lease expired. */
  expiredRecovery: RuntimeCoreExpiredRecoveryHost;
  /** Execution completion, failure handling, and pause/approval publishing. */
  finalization: RuntimeCoreFinalizationHost;
  /** Active-run lease acquisition and renewal. */
  liveness: RuntimeCoreLivenessHost;
  /** Kernel staging of manifests, messages, lineage, and runtime status. */
  persistence: RuntimeCorePersistenceHost;
  /** Runner-iteration orchestration: staging, tool batches, artifacts. */
  runner: RuntimeCoreRunnerHost;
  /** Runner-adjacent support: tool batch environments and handoff plans. */
  runnerSupport: RuntimeCoreRunnerSupportHost;
  /** Execution startup: turn creation, loop-state seeding, preludes. */
  startup: RuntimeCoreStartupHost;
  /** Durable commits of input, steering, and extension-state updates. */
  stateCommit: RuntimeCoreStateCommitHost;
  /** Run status transitions, including failing the active run. */
  status: RuntimeCoreStatusHost;
  /** Resumption of tool executions paused for approval. */
  toolResume: RuntimeCoreToolResumeHost;
  /** Turn/branch head advancement and iteration-run completion. */
  turnProgress: RuntimeCoreTurnProgressHost;
}

/**
 * Flat dependency bag from which every host slice in
 * {@link RuntimeCoreFacadeHosts} is derived.
 *
 * The runtime core supplies one implementation of each capability here
 * (kernel access, clock, id generation, event publishing, staging, tracked
 * runs, lease bookkeeping, ...); {@link createRuntimeCoreFacadeHosts} then
 * re-exposes the relevant subset to each slice.
 */
interface RuntimeCoreFacadeHostDependencies {
  activeRunLeaseControllers: WeakMap<RuntimeExecutionHandle, ActiveRunLease>;
  advanceTurnAndBranchHead: (
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ) => Promise<void>;
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
  cloneAgentConfigForRequest: (config: AgentConfig) => AgentConfig;
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
  completeIterationRun: RuntimeCoreRunnerHost["completeIterationRun"];
  completeTrackedRun: (
    handle: RuntimeExecutionHandle,
    runId: string,
    status: RunCompletionStatus,
    event?: KernelRecord
  ) => Promise<{ turnNodeHash?: HashString }>;
  createContextEngineeringHelpers: (
    messageHashes: HashString[],
    messages: TuvrenMessage[]
  ) => HelperBundle;
  createId: () => string;
  createIterationTree: RuntimeCoreRunnerHost["createIterationTree"];
  createReadonlyRunnerToolRegistry: (registry: ToolRegistry) => ToolRegistry;
  createRunnerAgentConfigSnapshot: (
    config: LoopState["activeConfig"]
  ) => LoopState["activeConfig"];
  createRunnerHandoffContextPlan: RuntimeCoreRunnerHost["createRunnerHandoffContextPlan"];
  createRunnerPublishedEvent: RuntimeCoreRunnerHost["createRunnerPublishedEvent"];
  createToolBatchEnvironment: RuntimeCoreRunnerHost["createToolBatchEnvironment"];
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
  defaultMaxParallelToolCalls: number;
  defaultRunnerId: string;
  emitStateObservability: (
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ) => void;
  enableStateObservability: () => boolean;
  failTrackedRunWithoutBranchAdvance: (
    handle: RuntimeExecutionHandle,
    runId: string,
    stableHeadTurnNodeHash: HashString
  ) => Promise<void>;
  finalizeRejectedPausedToolCancellation: (
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    pauseContext: PauseContext
  ) => Promise<LoopOutcome>;
  finalizeTurnStatus: (
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    partial: boolean,
    loopState: LoopState
  ) => Promise<void>;
  getManifestExtensionStateWarningBudgetBytes: () => false | number;
  getOrCreateManifestExtensionStateWarningKeys: (
    handle: RuntimeExecutionHandle
  ) => Set<string>;
  kernel: RuntimeKernel;
  loadHeadState: (branchId: string) => Promise<HeadState>;
  manifestExtensionStateWarning: (warning: {
    activeAgent: string;
    budgetBytes: number;
    code: "manifest_extension_state_budget_exceeded";
    extensionName: string;
    observedBytes: number;
    runId: string;
    threadId: string;
    turnId: string;
  }) => void;
  materializeContextMessages: (
    hashes: HashString[],
    helpers: ContextEngineeringHelpers
  ) => TuvrenMessage[];
  now: () => EpochMs;
  payloadCodecBinding: PayloadCodecBinding;
  publishCustomEvent: (
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ) => void;
  publishEvent: (
    handle: RuntimeExecutionHandle,
    event: TuvrenStreamEvent,
    loopState: LoopState
  ) => void;
  publishPauseOutcome: (
    handle: RuntimeExecutionHandle,
    pauseContext: PauseContext | undefined,
    loopState: LoopState
  ) => boolean;
  publishProjectedError: (
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ) => void;
  readRecoveredActiveAgentName: (
    turnTreeHash: HashString
  ) => Promise<string | undefined>;
  readRecoveredRuntimeStatus: (
    turnTreeHash: HashString
  ) => Promise<DurableRuntimeStatus | undefined>;
  resolveActiveMaxParallelToolCalls: (
    loopState: LoopState,
    defaultMaxParallelToolCalls: number
  ) => number;
  resolveAgentConfig?: (agentName: string) => AgentConfig | undefined;
  resolveCheckpointedPausedRun: (
    runId: string,
    turnId: string,
    resolution: RuntimeResolution
  ) => Promise<void>;
  resolveDefaultHandoffContextBuilder: (mode: string) => HandoffContextBuilder;
  resolveFailureActiveConfig: (handle: RuntimeExecutionHandle) => AgentConfig;
  resolveHandoffSourceContext: (
    plan: HandoffContextPlan,
    headState: HeadState,
    loopState: LoopState,
    targetConfig: AgentConfig,
    helpers: ContextEngineeringHelpers
  ) => HandoffSourceContext;
  resolveParentTurnId: (
    threadId: string,
    branchId: string,
    explicitParentTurnId?: string | null
  ) => Promise<string | null>;
  resolveTargetAgent: (targetAgent: string) => AgentConfig;
  resumePausedToolExecution: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    resumeContext: ResumeContext
  ) => Promise<LoopOutcome>;
  runLivenessOptions?:
    | {
        executionOwnerId: string;
        leaseDurationMs: number;
        renewBeforeMs: number;
      }
    | undefined;
  stageManifest: RuntimeCoreRunnerHost["stageManifest"];
  stageMessage: (
    runId: string,
    message: TuvrenMessage,
    taskId?: string
  ) => Promise<HashString>;
  stageRuntimeStatus: RuntimeCoreRunnerHost["stageRuntimeStatus"];
  stageTurnLineage: (
    runId: string,
    turnId: string,
    taskId: string,
    interruptedToolBatch?: InterruptedToolBatchDescriptor
  ) => Promise<HashString>;
  storeEventRecord: (event: KernelRecord) => Promise<HashString>;
  storeKernelRecord: (value: unknown, label: string) => Promise<HashString>;
  syncRunLeaseStateFromStepResult: (
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
  ) => void;
  treeCreate: (
    schemaId: string,
    changes: Record<string, PathValue>,
    baseTurnTreeHash: HashString
  ) => Promise<HashString>;
}

const publishValidatedEvent = (
  dependencies: Pick<RuntimeCoreFacadeHostDependencies, "publishEvent">,
  handle: RuntimeExecutionHandle,
  event: unknown,
  loopState: LoopState
): void => {
  assertTuvrenStreamEvent(event, "runtime facade event");
  dependencies.publishEvent(handle, event, loopState);
};

const publishNormalizedError = (
  dependencies: Pick<
    RuntimeCoreFacadeHostDependencies,
    "publishProjectedError"
  >,
  handle: RuntimeExecutionHandle,
  error: unknown,
  fatal: boolean,
  loopState: LoopState
): void => {
  dependencies.publishProjectedError(
    handle,
    normalizeError(error),
    fatal,
    loopState
  );
};

/**
 * Builds every runtime-core host slice from a single dependency bag.
 *
 * Each `buildRuntimeCore*Host` call receives only the capabilities its slice
 * needs, with late-bound wrappers (`(...args) => dependencies.fn(...args)`)
 * so the slices always observe the current dependency implementations. All
 * slices share the same kernel, clock, and id source, which keeps event
 * timestamps and identifiers consistent across execution phases.
 */
export const createRuntimeCoreFacadeHosts = (
  dependencies: RuntimeCoreFacadeHostDependencies
): RuntimeCoreFacadeHosts => {
  const statusHost: RuntimeCoreStatusHost = {
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
    createId: () => dependencies.createId(),
    createTrackedRun: async (...args) => {
      await dependencies.createTrackedRun(...args);
    },
    emitStateObservability: (...args) => {
      dependencies.emitStateObservability(...args);
    },
    loadHeadState: async (branchId) =>
      await dependencies.loadHeadState(branchId),
    stageManifest: async (...args) => await dependencies.stageManifest(...args),
    stageRuntimeStatus: async (...args) =>
      await dependencies.stageRuntimeStatus(...args),
    storeEventRecord: async (event) =>
      await dependencies.storeEventRecord(event),
    syncRunLeaseStateFromStepResult: (...args) => {
      dependencies.syncRunLeaseStateFromStepResult(...args);
    },
    treeCreate: async (schemaId, changes, baseTurnTreeHash) =>
      await dependencies.treeCreate(schemaId, changes, baseTurnTreeHash),
  };
  const hosts: RuntimeCoreFacadeHosts = {
    contextOps: buildRuntimeCoreContextOpsHost({
      advanceTurnAndBranchHead: async (...args) => {
        await dependencies.advanceTurnAndBranchHead(...args);
      },
      cloneAgentConfigForRequest: (config) =>
        dependencies.cloneAgentConfigForRequest(config),
      completeTrackedRun: async (...args) =>
        await dependencies.completeTrackedRun(...args),
      createActiveToolRegistry: (
        runtimeTools,
        config,
        clientEndpointBoundary
      ) =>
        createActiveToolRegistry(runtimeTools, config, clientEndpointBoundary),
      createClientEndpointBoundaryFromConfig,
      createContextEngineeringHelpers: (messageHashes, messages) =>
        dependencies.createContextEngineeringHelpers(messageHashes, messages),
      createId: () => dependencies.createId(),
      createTrackedRun: async (...args) => {
        await dependencies.createTrackedRun(...args);
      },
      emitStateObservability: (...args) => {
        dependencies.emitStateObservability(...args);
      },
      kernel: dependencies.kernel,
      loadHeadState: async (branchId) =>
        await dependencies.loadHeadState(branchId),
      materializeContextMessages: (hashes, helpers) =>
        dependencies.materializeContextMessages(hashes, helpers),
      publishCustomEvent: (...args) => {
        dependencies.publishCustomEvent(...args);
      },
      resolveAgentConfig: dependencies.resolveAgentConfig,
      resolveHandoffSourceContext: (...args) =>
        dependencies.resolveHandoffSourceContext(...args),
      stageRuntimeStatus: async (...args) =>
        await dependencies.stageRuntimeStatus(...args),
      storeEventRecord: async (event) =>
        await dependencies.storeEventRecord(event),
      storeKernelRecord: async (value, label) =>
        await dependencies.storeKernelRecord(value, label),
      syncRunLeaseStateFromStepResult: (...args) => {
        dependencies.syncRunLeaseStateFromStepResult(...args);
      },
    }),
    events: buildRuntimeCoreEventsHost(
      () => dependencies.createId(),
      () => dependencies.enableStateObservability(),
      () => dependencies.now()
    ),
    expiredRecovery: buildRuntimeCoreExpiredRecoveryHost({
      kernel: dependencies.kernel,
      loadHeadState: async (branchId) =>
        await dependencies.loadHeadState(branchId),
      now: () => dependencies.now(),
      payloadCodecBinding: dependencies.payloadCodecBinding,
      publishEvent: (handle, event, loopState) => {
        dependencies.publishEvent(handle, event, loopState);
      },
      readRecoveredActiveAgentName: async (turnTreeHash) =>
        await dependencies.readRecoveredActiveAgentName(turnTreeHash),
      readRecoveredRuntimeStatus: async (turnTreeHash) =>
        await dependencies.readRecoveredRuntimeStatus(turnTreeHash),
      runLivenessOptions:
        dependencies.runLivenessOptions === undefined
          ? undefined
          : {
              executionOwnerId:
                dependencies.runLivenessOptions.executionOwnerId,
            },
    }),
    finalization: buildRuntimeCoreFinalizationHost({
      createId: () => dependencies.createId(),
      defaultRunnerId: dependencies.defaultRunnerId,
      finalizeRejectedPausedToolCancellation: async (...args) =>
        await dependencies.finalizeRejectedPausedToolCancellation(...args),
      finalizeTurnStatus: async (...args) => {
        await dependencies.finalizeTurnStatus(...args);
      },
      kernel: dependencies.kernel,
      loadHeadState: async (branchId) =>
        await dependencies.loadHeadState(branchId),
      now: () => dependencies.now(),
      publishCustomEvent: (...args) => {
        dependencies.publishCustomEvent(...args);
      },
      publishEvent: (handle, event, loopState) => {
        publishValidatedEvent(dependencies, handle, event, loopState);
      },
      publishProjectedError: (handle, error, fatal, loopState) => {
        publishNormalizedError(dependencies, handle, error, fatal, loopState);
      },
      resolveFailureActiveConfig: (handle) =>
        dependencies.resolveFailureActiveConfig(handle),
      storeEventRecord: async (event) =>
        await dependencies.storeEventRecord(event),
    }),
    liveness: buildRuntimeCoreLivenessHost({
      activeRunLeaseControllers: dependencies.activeRunLeaseControllers,
      kernel: dependencies.kernel,
      now: () => dependencies.now(),
      runLivenessOptions: dependencies.runLivenessOptions,
      storeEventRecord: async (event) =>
        await dependencies.storeEventRecord(event),
    }),
    persistence: buildRuntimeCorePersistenceHost({
      emitWarning: (warning) => {
        dependencies.manifestExtensionStateWarning(warning);
      },
      encodeKernelRecord,
      getManifestExtensionStateWarningBudgetBytes: () =>
        dependencies.getManifestExtensionStateWarningBudgetBytes(),
      getOrCreateManifestExtensionStateWarningKeys: (handle) =>
        dependencies.getOrCreateManifestExtensionStateWarningKeys(handle),
      kernel: dependencies.kernel,
      payloadCodecBinding: dependencies.payloadCodecBinding,
    }),
    runner: buildRuntimeCoreRunnerHost({
      completeIterationRun: async (...args) =>
        await dependencies.completeIterationRun(...args),
      createIterationTree: async (...args) =>
        await dependencies.createIterationTree(...args),
      createReadonlyRunnerToolRegistry: (registry) =>
        dependencies.createReadonlyRunnerToolRegistry(registry),
      createRunnerAgentConfigSnapshot: (config) =>
        dependencies.createRunnerAgentConfigSnapshot(config),
      createRunnerHandoffContextPlan: (...args) =>
        dependencies.createRunnerHandoffContextPlan(...args),
      createRunnerPublishedEvent: (...args) =>
        dependencies.createRunnerPublishedEvent(...args),
      createToolBatchEnvironment: (...args) =>
        dependencies.createToolBatchEnvironment(...args),
      failTrackedRunWithoutBranchAdvance: async (...args) => {
        await dependencies.failTrackedRunWithoutBranchAdvance(...args);
      },
      now: () => dependencies.now(),
      publishCustomEvent: (...args) => {
        dependencies.publishCustomEvent(...args);
      },
      publishProjectedError: (...args) => {
        dependencies.publishProjectedError(...args);
      },
      stageManifest: async (...args) =>
        await dependencies.stageManifest(...args),
      stageMessage: async (...args) => await dependencies.stageMessage(...args),
      stageRuntimeStatus: async (...args) =>
        await dependencies.stageRuntimeStatus(...args),
      stageTurnLineage: async (...args) =>
        await dependencies.stageTurnLineage(...args),
    }),
    runnerSupport: buildRuntimeCoreRunnerSupportHost({
      cloneAgentConfigForRequest: (config) =>
        dependencies.cloneAgentConfigForRequest(config),
      createContextEngineeringHelpers: (messageHashes, messages) =>
        dependencies.createContextEngineeringHelpers(messageHashes, messages),
      createFrozenSnapshot,
      defaultMaxParallelToolCalls: dependencies.defaultMaxParallelToolCalls,
      now: () => dependencies.now(),
      publishCustomEvent: (...args) => {
        dependencies.publishCustomEvent(...args);
      },
      publishEvent: (handle, event, loopState) => {
        publishValidatedEvent(dependencies, handle, event, loopState);
      },
      publishProjectedError: (handle, error, fatal, loopState) => {
        publishNormalizedError(dependencies, handle, error, fatal, loopState);
      },
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
      stageManifest: async (runId, manifest, taskId) =>
        await dependencies.stageManifest(runId, manifest, undefined, taskId),
      stageMessage: async (runId, message, taskId) =>
        await dependencies.stageMessage(runId, message, taskId),
    }),
    startup: buildRuntimeCoreStartupHost({
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
      createActiveToolRegistry,
      createClientEndpointBoundaryFromConfig,
      createId: () => dependencies.createId(),
      defaultRunnerId: dependencies.defaultRunnerId,
      emitStateObservability: (...args) => {
        dependencies.emitStateObservability(...args);
      },
      kernel: dependencies.kernel,
      loadHeadState: async (branchId) =>
        await dependencies.loadHeadState(branchId),
      now: () => dependencies.now(),
      publishCustomEvent: (...args) => {
        dependencies.publishCustomEvent(...args);
      },
      publishEvent: (handle, event, loopState) => {
        publishValidatedEvent(dependencies, handle, event, loopState);
      },
      publishPauseOutcome: (handle, pauseContext, loopState) =>
        dependencies.publishPauseOutcome(handle, pauseContext, loopState),
      publishProjectedError: (handle, error, fatal, loopState) => {
        publishNormalizedError(dependencies, handle, error, fatal, loopState);
      },
      resolveAgentConfig: dependencies.resolveAgentConfig,
      resolveParentTurnId: async (...args) =>
        await dependencies.resolveParentTurnId(...args),
      resumePausedToolExecution: async (...args) =>
        await dependencies.resumePausedToolExecution(...args),
    }),
    stateCommit: buildRuntimeCoreStateCommitHost({
      advanceTurnAndBranchHead: async (...args) => {
        await dependencies.advanceTurnAndBranchHead(...args);
      },
      collectInitialExtensionStateUpdates: (extensions, manifest) =>
        collectInitialExtensionStateUpdates(extensions ?? [], manifest),
      completeTrackedRun: async (...args) =>
        await dependencies.completeTrackedRun(...args),
      createId: () => dependencies.createId(),
      createTrackedRun: async (...args) => {
        await dependencies.createTrackedRun(...args);
      },
      emitStateObservability: (...args) => {
        dependencies.emitStateObservability(...args);
      },
      kernel: dependencies.kernel,
      loadHeadState: async (branchId) =>
        await dependencies.loadHeadState(branchId),
      now: () => dependencies.now(),
      publishEvent: (handle, event, loopState) => {
        publishValidatedEvent(dependencies, handle, event, loopState);
      },
      stageManifest: async (...args) =>
        await dependencies.stageManifest(...args),
      stageMessage: async (runId, message, taskId) =>
        await dependencies.stageMessage(runId, message, taskId),
      stageRuntimeStatus: async (...args) =>
        await dependencies.stageRuntimeStatus(...args),
      stageTurnLineage: async (...args) =>
        await dependencies.stageTurnLineage(...args),
      storeEventRecord: async (event) =>
        await dependencies.storeEventRecord(event),
      syncRunLeaseStateFromStepResult: (...args) => {
        dependencies.syncRunLeaseStateFromStepResult(...args);
      },
    }),
    status: statusHost,
    toolResume: buildRuntimeCoreToolResumeHost({
      beginIterationStep: async (runId, stepId) => {
        await dependencies.kernel.run.beginStep(runId, stepId);
      },
      completeIterationRun: async (...args) =>
        await dependencies.completeIterationRun(...args),
      createId: () => dependencies.createId(),
      createIterationTree: async (...args) =>
        await dependencies.createIterationTree(...args),
      createTrackedRun: async (...args) => {
        await dependencies.createTrackedRun(...args);
      },
      failTrackedRunWithoutBranchAdvance: async (...args) => {
        await dependencies.failTrackedRunWithoutBranchAdvance(...args);
      },
      loadHeadState: async (branchId) =>
        await dependencies.loadHeadState(branchId),
      now: () => dependencies.now(),
      publishCustomEvent: (...args) => {
        dependencies.publishCustomEvent(...args);
      },
      publishEvent: (handle, event, loopState) => {
        publishValidatedEvent(dependencies, handle, event, loopState);
      },
      publishProjectedError: (handle, error, fatal, loopState) => {
        dependencies.publishProjectedError(handle, error, fatal, loopState);
      },
      resolveActiveMaxParallelToolCalls: (loopState) =>
        dependencies.resolveActiveMaxParallelToolCalls(
          loopState,
          dependencies.defaultMaxParallelToolCalls
        ),
      resolveCheckpointedPausedRun: async (...args) => {
        await dependencies.resolveCheckpointedPausedRun(...args);
      },
      stageManifest: async (...args) =>
        await dependencies.stageManifest(...args),
      stageMessage: async (runId, message, taskId) =>
        await dependencies.stageMessage(runId, message, taskId),
      stageRuntimeStatus: async (...args) =>
        await dependencies.stageRuntimeStatus(...args),
      stageTurnLineage: async (...args) =>
        await dependencies.stageTurnLineage(...args),
    }),
    turnProgress: buildRuntimeCoreTurnProgressHost({
      advanceTurnAndBranchHead: async (...args) => {
        await dependencies.advanceTurnAndBranchHead(...args);
      },
      completeTrackedRun: async (...args) =>
        await dependencies.completeTrackedRun(...args),
      emitStateObservability: (...args) => {
        dependencies.emitStateObservability(...args);
      },
      kernel: dependencies.kernel,
      storeEventRecord: async (event) =>
        await dependencies.storeEventRecord(event),
      syncRunLeaseStateFromStepResult: (...args) => {
        dependencies.syncRunLeaseStateFromStepResult(...args);
      },
    }),
  };
  return hosts;
};
