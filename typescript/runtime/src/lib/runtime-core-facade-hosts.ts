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
  RuntimeKernel as KrakenKernel,
  PathValue,
  RunCompletionStatus,
} from "@tuvren/kernel-protocol";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import type { PayloadCodecBinding } from "./payload-codec-seam.js";
import type { HelperBundle } from "./runtime-core-context.js";
import type { RuntimeCoreContextOpsHost } from "./runtime-core-context-ops.js";
import type { RuntimeCoreDriverHost } from "./runtime-core-driver.js";
import type { RuntimeCoreDriverSupportHost } from "./runtime-core-driver-support.js";
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
  buildRuntimeCoreContextOpsHost,
  buildRuntimeCoreDriverSupportHost,
  buildRuntimeCoreEventsHost,
  buildRuntimeCoreExpiredRecoveryHost,
  buildRuntimeCoreFinalizationHost,
  buildRuntimeCoreLivenessHost,
  buildRuntimeCorePersistenceHost,
  buildRuntimeCoreStartupHost,
  buildRuntimeCoreStateCommitHost,
  buildRuntimeCoreTurnProgressHost,
} from "./runtime-core-hosts.js";
import {
  buildRuntimeCoreDriverHost,
  buildRuntimeCoreStatusHost,
  buildRuntimeCoreToolResumeHost,
} from "./runtime-core-hosts-execution.js";
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
import { createFrozenSnapshot } from "./runtime-core-shared.js";
import type { RuntimeCoreStartupHost } from "./runtime-core-startup.js";
import type { RuntimeCoreStateCommitHost } from "./runtime-core-state-commit.js";
import type { RuntimeCoreStatusHost } from "./runtime-core-status.js";
import type { RuntimeCoreToolResumeHost } from "./runtime-core-tool-resume.js";
import type { RuntimeCoreTurnProgressHost } from "./runtime-core-turn-progress.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { PauseContext, ResumeContext } from "./runtime-execution-types.js";

export interface RuntimeCoreFacadeHosts {
  contextOps: RuntimeCoreContextOpsHost;
  driver: RuntimeCoreDriverHost;
  driverSupport: RuntimeCoreDriverSupportHost;
  events: RuntimeCoreEventsHost;
  expiredRecovery: RuntimeCoreExpiredRecoveryHost;
  finalization: RuntimeCoreFinalizationHost;
  liveness: RuntimeCoreLivenessHost;
  persistence: RuntimeCorePersistenceHost;
  startup: RuntimeCoreStartupHost;
  stateCommit: RuntimeCoreStateCommitHost;
  status: RuntimeCoreStatusHost;
  toolResume: RuntimeCoreToolResumeHost;
  turnProgress: RuntimeCoreTurnProgressHost;
}

interface RuntimeCoreFacadeHostDependencies {
  activeRunLeaseControllers: WeakMap<RuntimeExecutionHandle, ActiveRunLease>;
  advanceTurnAndBranchHead(
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ): Promise<void>;
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
  cloneAgentConfigForRequest(config: AgentConfig): AgentConfig;
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
  completeIterationRun: RuntimeCoreDriverHost["completeIterationRun"];
  completeTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    status: RunCompletionStatus,
    event?: KernelRecord
  ): Promise<{ turnNodeHash?: HashString }>;
  createContextEngineeringHelpers(
    messageHashes: HashString[],
    messages: TuvrenMessage[]
  ): HelperBundle;
  createDriverAgentConfigSnapshot(
    config: LoopState["activeConfig"]
  ): LoopState["activeConfig"];
  createDriverHandoffContextPlan: RuntimeCoreDriverHost["createDriverHandoffContextPlan"];
  createDriverPublishedEvent: RuntimeCoreDriverHost["createDriverPublishedEvent"];
  createId(): string;
  createIterationTree: RuntimeCoreDriverHost["createIterationTree"];
  createReadonlyDriverToolRegistry(registry: ToolRegistry): ToolRegistry;
  createToolBatchEnvironment: RuntimeCoreDriverHost["createToolBatchEnvironment"];
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
  defaultDriverId: string;
  defaultMaxParallelToolCalls: number;
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): void;
  enableStateObservability(): boolean;
  failTrackedRunWithoutBranchAdvance(
    handle: RuntimeExecutionHandle,
    runId: string,
    stableHeadTurnNodeHash: HashString
  ): Promise<void>;
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
  getManifestExtensionStateWarningBudgetBytes(): false | number;
  getOrCreateManifestExtensionStateWarningKeys(
    handle: RuntimeExecutionHandle
  ): Set<string>;
  kernel: KrakenKernel;
  loadHeadState(branchId: string): Promise<HeadState>;
  manifestExtensionStateWarning(warning: {
    activeAgent: string;
    budgetBytes: number;
    code: "manifest_extension_state_budget_exceeded";
    extensionName: string;
    observedBytes: number;
    runId: string;
    threadId: string;
    turnId: string;
  }): void;
  materializeContextMessages(
    hashes: HashString[],
    helpers: ContextEngineeringHelpers
  ): TuvrenMessage[];
  now(): EpochMs;
  payloadCodecBinding: PayloadCodecBinding;
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
  publishPauseOutcome(
    handle: RuntimeExecutionHandle,
    pauseContext: PauseContext | undefined,
    loopState: LoopState
  ): boolean;
  publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ): void;
  readRecoveredActiveAgentName(
    turnTreeHash: HashString
  ): Promise<string | undefined>;
  readRecoveredRuntimeStatus(
    turnTreeHash: HashString
  ): Promise<DurableRuntimeStatus | undefined>;
  resolveActiveMaxParallelToolCalls(
    loopState: LoopState,
    defaultMaxParallelToolCalls: number
  ): number;
  resolveAgentConfig?(agentName: string): AgentConfig | undefined;
  resolveCheckpointedPausedRun(
    runId: string,
    turnId: string,
    resolution: RuntimeResolution
  ): Promise<void>;
  resolveDefaultHandoffContextBuilder(mode: string): HandoffContextBuilder;
  resolveFailureActiveConfig(handle: RuntimeExecutionHandle): AgentConfig;
  resolveHandoffSourceContext(
    plan: HandoffContextPlan,
    headState: HeadState,
    loopState: LoopState,
    targetConfig: AgentConfig,
    helpers: ContextEngineeringHelpers
  ): HandoffSourceContext;
  resolveParentTurnId(
    threadId: string,
    branchId: string,
    explicitParentTurnId?: string | null
  ): Promise<string | null>;
  resolveTargetAgent(targetAgent: string): AgentConfig;
  resumePausedToolExecution(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    resumeContext: ResumeContext
  ): Promise<LoopOutcome>;
  runLivenessOptions?:
    | {
        executionOwnerId: string;
        leaseDurationMs: number;
        renewBeforeMs: number;
      }
    | undefined;
  stageManifest: RuntimeCoreDriverHost["stageManifest"];
  stageMessage(
    runId: string,
    message: TuvrenMessage,
    taskId?: string
  ): Promise<HashString>;
  stageRuntimeStatus: RuntimeCoreDriverHost["stageRuntimeStatus"];
  stageTurnLineage(
    runId: string,
    turnId: string,
    taskId: string
  ): Promise<HashString>;
  storeEventRecord(event: KernelRecord): Promise<HashString>;
  storeKernelRecord(value: unknown, label: string): Promise<HashString>;
  syncRunLeaseStateFromStepResult(
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
  ): void;
  treeCreate(
    schemaId: string,
    changes: Record<string, PathValue>,
    baseTurnTreeHash: HashString
  ): Promise<HashString>;
}

export function createRuntimeCoreFacadeHosts(
  dependencies: RuntimeCoreFacadeHostDependencies
): RuntimeCoreFacadeHosts {
  return {
    contextOps: buildRuntimeCoreContextOpsHost({
      advanceTurnAndBranchHead: (...args) =>
        dependencies.advanceTurnAndBranchHead(...args),
      cloneAgentConfigForRequest: (config) =>
        dependencies.cloneAgentConfigForRequest(config),
      completeTrackedRun: (...args) => dependencies.completeTrackedRun(...args),
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
      createTrackedRun: (...args) => dependencies.createTrackedRun(...args),
      emitStateObservability: (...args) =>
        dependencies.emitStateObservability(...args),
      kernel: dependencies.kernel,
      loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
      materializeContextMessages: (hashes, helpers) =>
        dependencies.materializeContextMessages(hashes, helpers),
      publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
      resolveAgentConfig: dependencies.resolveAgentConfig,
      resolveHandoffSourceContext: (...args) =>
        dependencies.resolveHandoffSourceContext(...args),
      stageRuntimeStatus: (...args) => dependencies.stageRuntimeStatus(...args),
      storeEventRecord: (event) => dependencies.storeEventRecord(event),
      storeKernelRecord: (value, label) =>
        dependencies.storeKernelRecord(value, label),
      syncRunLeaseStateFromStepResult: (...args) =>
        dependencies.syncRunLeaseStateFromStepResult(...args),
    }),
    driver: buildRuntimeCoreDriverHost({
      completeIterationRun: (...args) =>
        dependencies.completeIterationRun(...args),
      createDriverAgentConfigSnapshot: (config) =>
        dependencies.createDriverAgentConfigSnapshot(config),
      createDriverHandoffContextPlan: (...args) =>
        dependencies.createDriverHandoffContextPlan(...args),
      createDriverPublishedEvent: (...args) =>
        dependencies.createDriverPublishedEvent(...args),
      createIterationTree: (...args) =>
        dependencies.createIterationTree(...args),
      createReadonlyDriverToolRegistry: (registry) =>
        dependencies.createReadonlyDriverToolRegistry(registry),
      createToolBatchEnvironment: (...args) =>
        dependencies.createToolBatchEnvironment(...args),
      failTrackedRunWithoutBranchAdvance: (...args) =>
        dependencies.failTrackedRunWithoutBranchAdvance(...args),
      now: () => dependencies.now(),
      publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
      publishProjectedError: (...args) =>
        dependencies.publishProjectedError(...args),
      stageManifest: (...args) => dependencies.stageManifest(...args),
      stageMessage: (...args) => dependencies.stageMessage(...args),
      stageRuntimeStatus: (...args) => dependencies.stageRuntimeStatus(...args),
    }),
    driverSupport: buildRuntimeCoreDriverSupportHost({
      cloneAgentConfigForRequest: (config) =>
        dependencies.cloneAgentConfigForRequest(config),
      createContextEngineeringHelpers: (messageHashes, messages) =>
        dependencies.createContextEngineeringHelpers(messageHashes, messages),
      createFrozenSnapshot,
      defaultMaxParallelToolCalls: dependencies.defaultMaxParallelToolCalls,
      getActiveFencingToken: (handle) =>
        dependencies.activeRunLeaseControllers.get(handle)?.fencingToken,
      now: () => dependencies.now(),
      publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
      publishEvent: (handle, event, loopState) =>
        dependencies.publishEvent(
          handle,
          event as unknown as TuvrenStreamEvent,
          loopState
        ),
      publishProjectedError: (handle, error, fatal, loopState) =>
        dependencies.publishProjectedError(
          handle,
          error as Error,
          fatal,
          loopState
        ),
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
      stageMessage: (runId, message, taskId) =>
        dependencies.stageMessage(runId, message, taskId as string),
    }),
    events: buildRuntimeCoreEventsHost(
      () => dependencies.createId(),
      () => dependencies.enableStateObservability(),
      () => dependencies.now()
    ),
    expiredRecovery: buildRuntimeCoreExpiredRecoveryHost({
      kernel: dependencies.kernel,
      loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
      now: () => dependencies.now(),
      publishEvent: (handle, event, loopState) =>
        dependencies.publishEvent(
          handle,
          event as unknown as TuvrenStreamEvent,
          loopState
        ),
      readRecoveredActiveAgentName: (turnTreeHash) =>
        dependencies.readRecoveredActiveAgentName(turnTreeHash),
      readRecoveredRuntimeStatus: (turnTreeHash) =>
        dependencies.readRecoveredRuntimeStatus(turnTreeHash),
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
      defaultDriverId: dependencies.defaultDriverId,
      finalizeRejectedPausedToolCancellation: (...args) =>
        dependencies.finalizeRejectedPausedToolCancellation(...args),
      finalizeTurnStatus: (...args) => dependencies.finalizeTurnStatus(...args),
      kernel: dependencies.kernel,
      loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
      now: () => dependencies.now(),
      publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
      publishEvent: (handle, event, loopState) =>
        dependencies.publishEvent(
          handle,
          event as unknown as TuvrenStreamEvent,
          loopState
        ),
      publishProjectedError: (handle, error, fatal, loopState) =>
        dependencies.publishProjectedError(
          handle,
          error as Error,
          fatal,
          loopState
        ),
      resolveFailureActiveConfig: (handle) =>
        dependencies.resolveFailureActiveConfig(handle),
      storeEventRecord: (event) => dependencies.storeEventRecord(event),
    }),
    liveness: buildRuntimeCoreLivenessHost({
      activeRunLeaseControllers: dependencies.activeRunLeaseControllers,
      kernel: dependencies.kernel,
      now: () => dependencies.now(),
      runLivenessOptions: dependencies.runLivenessOptions,
      storeEventRecord: (event) => dependencies.storeEventRecord(event),
    }),
    persistence: buildRuntimeCorePersistenceHost({
      emitWarning: (warning) =>
        dependencies.manifestExtensionStateWarning(warning),
      encodeKernelRecord,
      getManifestExtensionStateWarningBudgetBytes: () =>
        dependencies.getManifestExtensionStateWarningBudgetBytes(),
      getOrCreateManifestExtensionStateWarningKeys: (handle) =>
        dependencies.getOrCreateManifestExtensionStateWarningKeys(handle),
      kernel: dependencies.kernel,
      payloadCodecBinding: dependencies.payloadCodecBinding,
    }),
    startup: buildRuntimeCoreStartupHost({
      applyTerminalAgentTransitionIfNeeded: (...args) =>
        dependencies.applyTerminalAgentTransitionIfNeeded(...args),
      checkpointResumeRunningStatus: (...args) =>
        dependencies.checkpointResumeRunningStatus(...args),
      commitPendingExtensionStateUpdates: (...args) =>
        dependencies.commitPendingExtensionStateUpdates(...args),
      completeExecution: (...args) => dependencies.completeExecution(...args),
      createActiveToolRegistry,
      createClientEndpointBoundaryFromConfig,
      createId: () => dependencies.createId(),
      defaultDriverId: dependencies.defaultDriverId,
      emitStateObservability: (...args) =>
        dependencies.emitStateObservability(...args),
      kernel: dependencies.kernel,
      loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
      now: () => dependencies.now(),
      publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
      publishEvent: (handle, event, loopState) =>
        dependencies.publishEvent(
          handle,
          event as unknown as TuvrenStreamEvent,
          loopState
        ),
      publishPauseOutcome: (handle, pauseContext, loopState) =>
        dependencies.publishPauseOutcome(handle, pauseContext, loopState),
      publishProjectedError: (handle, error, fatal, loopState) =>
        dependencies.publishProjectedError(
          handle,
          error as Error,
          fatal,
          loopState
        ),
      resolveAgentConfig: dependencies.resolveAgentConfig,
      resolveParentTurnId: (...args) =>
        dependencies.resolveParentTurnId(...args),
      resumePausedToolExecution: (...args) =>
        dependencies.resumePausedToolExecution(...args),
    }),
    stateCommit: buildRuntimeCoreStateCommitHost({
      advanceTurnAndBranchHead: (...args) =>
        dependencies.advanceTurnAndBranchHead(...args),
      collectInitialExtensionStateUpdates: (extensions, manifest) =>
        collectInitialExtensionStateUpdates(extensions ?? [], manifest),
      completeTrackedRun: (...args) => dependencies.completeTrackedRun(...args),
      createId: () => dependencies.createId(),
      createTrackedRun: (...args) => dependencies.createTrackedRun(...args),
      emitStateObservability: (...args) =>
        dependencies.emitStateObservability(...args),
      kernel: dependencies.kernel,
      loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
      now: () => dependencies.now(),
      publishEvent: (handle, event, loopState) =>
        dependencies.publishEvent(
          handle,
          event as unknown as TuvrenStreamEvent,
          loopState
        ),
      stageManifest: (...args) => dependencies.stageManifest(...args),
      stageMessage: (runId, message, taskId) =>
        dependencies.stageMessage(runId, message, taskId as string),
      stageRuntimeStatus: (...args) => dependencies.stageRuntimeStatus(...args),
      stageTurnLineage: (...args) => dependencies.stageTurnLineage(...args),
      storeEventRecord: (event) => dependencies.storeEventRecord(event),
      syncRunLeaseStateFromStepResult: (...args) =>
        dependencies.syncRunLeaseStateFromStepResult(...args),
    }),
    status: buildRuntimeCoreStatusHost({
      advanceTurnAndBranchHead: (...args) =>
        dependencies.advanceTurnAndBranchHead(...args),
      beginRunStep: async (runId, stepId) => {
        await dependencies.kernel.run.beginStep(runId, stepId);
      },
      completeRunStep: (runId, stepId, eventHash, treeHash) =>
        dependencies.kernel.run.completeStep(
          runId,
          stepId,
          eventHash,
          undefined,
          treeHash
        ),
      completeTrackedRun: (...args) => dependencies.completeTrackedRun(...args),
      createId: () => dependencies.createId(),
      createTrackedRun: (...args) => dependencies.createTrackedRun(...args),
      emitStateObservability: (...args) =>
        Promise.resolve(dependencies.emitStateObservability(...args)),
      loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
      stageManifest: (...args) => dependencies.stageManifest(...args),
      stageRuntimeStatus: (...args) => dependencies.stageRuntimeStatus(...args),
      storeEventRecord: (event) => dependencies.storeEventRecord(event),
      syncRunLeaseStateFromStepResult: (...args) =>
        dependencies.syncRunLeaseStateFromStepResult(...args),
      treeCreate: (schemaId, changes, baseTurnTreeHash) =>
        dependencies.treeCreate(schemaId, changes, baseTurnTreeHash),
    }),
    toolResume: buildRuntimeCoreToolResumeHost({
      beginIterationStep: async (runId, stepId) => {
        await dependencies.kernel.run.beginStep(runId, stepId);
      },
      completeIterationRun: (...args) =>
        dependencies.completeIterationRun(...args),
      createId: () => dependencies.createId(),
      createIterationTree: (...args) =>
        dependencies.createIterationTree(...args),
      createTrackedRun: (...args) => dependencies.createTrackedRun(...args),
      failTrackedRunWithoutBranchAdvance: (...args) =>
        dependencies.failTrackedRunWithoutBranchAdvance(...args),
      getActiveFencingToken: (handle) =>
        dependencies.activeRunLeaseControllers.get(handle)?.fencingToken,
      loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
      now: () => dependencies.now(),
      publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
      publishEvent: (handle, event, loopState) =>
        dependencies.publishEvent(
          handle,
          event as unknown as TuvrenStreamEvent,
          loopState
        ),
      publishProjectedError: (handle, error, fatal, loopState) =>
        dependencies.publishProjectedError(
          handle,
          error as Error,
          fatal,
          loopState
        ),
      resolveActiveMaxParallelToolCalls: (loopState) =>
        dependencies.resolveActiveMaxParallelToolCalls(
          loopState,
          dependencies.defaultMaxParallelToolCalls
        ),
      resolveCheckpointedPausedRun: (...args) =>
        dependencies.resolveCheckpointedPausedRun(...args),
      stageManifest: (...args) => dependencies.stageManifest(...args),
      stageMessage: (runId, message, taskId) =>
        dependencies.stageMessage(runId, message, taskId),
      stageRuntimeStatus: (...args) => dependencies.stageRuntimeStatus(...args),
    }),
    turnProgress: buildRuntimeCoreTurnProgressHost({
      advanceTurnAndBranchHead: (...args) =>
        dependencies.advanceTurnAndBranchHead(...args),
      completeTrackedRun: (...args) => dependencies.completeTrackedRun(...args),
      emitStateObservability: (...args) =>
        dependencies.emitStateObservability(...args),
      kernel: dependencies.kernel,
      storeEventRecord: (event) => dependencies.storeEventRecord(event),
      syncRunLeaseStateFromStepResult: (...args) =>
        dependencies.syncRunLeaseStateFromStepResult(...args),
    }),
  };
}
