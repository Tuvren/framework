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
  TuvrenRuntimeError,
} from "@tuvren/core-types";
import type {
  DriverExecutionContext,
  DriverExecutionResult,
  RuntimeDriver as KrakenDriver,
} from "@tuvren/driver-api";
import type {
  AgentConfig,
  ContextEngineeringPlan,
  ContextManifest,
  HandoffContextBuilder,
  HandoffContextPlan,
  InputSignal,
  RuntimeResolution,
  ToolCallPart,
  ToolRegistry,
  ToolResultPart,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import {
  applyContextEngineeringPlan as applyRuntimeContextEngineeringPlan,
  applyHandoff as applyRuntimeHandoff,
  type RuntimeCoreContextOpsHost,
} from "./runtime-core-context-ops.js";
import {
  applyAfterIterationResolution as applyRuntimeAfterIterationResolution,
  applyRequestedToolBatchIfNeeded as applyRuntimeRequestedToolBatchIfNeeded,
  completeIterationArtifacts as completeRuntimeIterationArtifacts,
  createDriverExecutionContext as createRuntimeDriverExecutionContext,
  type RuntimeCoreDriverHost,
  stageDriverMessages as stageRuntimeDriverMessages,
} from "./runtime-core-driver.js";
import {
  createDriverHandoffContextPlan as createRuntimeDriverHandoffContextPlan,
  createToolBatchEnvironment as createRuntimeToolBatchEnvironment,
  type RuntimeCoreDriverSupportHost,
} from "./runtime-core-driver-support.js";
import type { IterationPhaseResult } from "./runtime-core-iteration.js";
import { executeIterationPhase as executeRuntimeIterationPhase } from "./runtime-core-iteration.js";
import {
  type HeadState,
  type LoopState,
  runExecutionLoop as runRuntimeExecutionLoop,
} from "./runtime-core-loop.js";
import type { LoopOutcome } from "./runtime-core-recovery.js";
import {
  commitPendingExtensionStateUpdates as commitRuntimePendingExtensionStateUpdates,
  incorporateInput as incorporateRuntimeInput,
  incorporateSteering as incorporateRuntimeSteering,
  type RuntimeCoreStateCommitHost,
} from "./runtime-core-state-commit.js";
import { resumePausedToolExecution as resumeRuntimePausedToolExecution } from "./runtime-core-tool-resume.js";
import {
  completeIterationRun as completeRuntimeIterationRun,
  createIterationTree as createRuntimeIterationTree,
  type RuntimeCoreTurnProgressHost,
} from "./runtime-core-turn-progress.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { ResumeContext } from "./runtime-execution-types.js";
import type { ToolExecutionMode } from "./tool-execution.js";

interface RuntimeExecutionLoopDependencies {
  applyContextEngineeringPlan(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    plan: ContextEngineeringPlan,
    loopState: LoopState,
    updates: ExtensionStateUpdate[]
  ): Promise<void>;
  applyTerminalAgentTransitionIfNeeded(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    resolution: RuntimeResolution,
    loopState: LoopState,
    stableHeadTurnNodeHash?: HashString
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
  now(): EpochMs;
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

interface RuntimeIterationPhaseDependencies {
  applyAfterIterationResolution(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    iterationCount: number,
    runId: string,
    resolution: RuntimeResolution,
    response: TuvrenModelResponse,
    toolResults: ToolResultPart[],
    headMessages: TuvrenMessage[],
    stagedMessages: TuvrenMessage[],
    manifest: ContextManifest
  ): Promise<RuntimeResolution>;
  applyRequestedToolBatchIfNeeded(input: {
    handle: RuntimeExecutionHandle;
    headState: HeadState;
    iterationCount: number;
    loopState: LoopState;
    requestedToolCalls: ToolCallPart[];
    resolution: RuntimeResolution;
    runId: string;
    stagedMessageHashes: HashString[];
    stagedMessages: TuvrenMessage[];
    toolExecutionMode: ToolExecutionMode;
    toolResults: ToolResultPart[];
  }): Promise<LoopOutcome | RuntimeResolution>;
  beginIterationStep(runId: string, stepId: string): Promise<void>;
  completeIterationArtifacts(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState,
    iterationCount: number,
    runId: string,
    resolution: RuntimeResolution,
    manifest: ContextManifest,
    appendedMessageHashes: HashString[]
  ): Promise<HashString | undefined>;
  createDriverExecutionContext(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState,
    iterationCount: number,
    emittedDriverEvents: TuvrenStreamEvent[]
  ): DriverExecutionContext;
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
  ensureDriverAssistantEvents(
    handle: RuntimeExecutionHandle,
    messages: TuvrenMessage[],
    emittedEvents: TuvrenStreamEvent[],
    loopState: LoopState
  ): TuvrenStreamEvent[];
  executeDriver(
    driver: KrakenDriver,
    context: DriverExecutionContext
  ): Promise<DriverExecutionResult>;
  failInvalidPauseResolutionIfNeeded(
    handle: RuntimeExecutionHandle,
    iterationRunId: string,
    stableHeadTurnNodeHash: HashString,
    requestedToolCallCount: number,
    resolution: RuntimeResolution
  ): Promise<IterationPhaseResult | undefined>;
  failTrackedRunWithoutBranchAdvance(
    handle: RuntimeExecutionHandle,
    runId: string,
    stableHeadTurnNodeHash: HashString
  ): Promise<void>;
  flushBufferedDriverEventsIfNeeded(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    events: TuvrenStreamEvent[]
  ): TuvrenStreamEvent[];
  materializeDriver(driverId: string): KrakenDriver;
  reconcileCheckpointedPauseResolution(
    checkpointedPause: boolean,
    runId: string,
    turnId: string,
    resolution: RuntimeResolution
  ): Promise<RuntimeResolution>;
  stageDriverMessages(
    runId: string,
    messages: TuvrenMessage[],
    iterationCount: number
  ): Promise<HashString[]>;
}

export async function runRuntimeExecutionLoopFacade(
  dependencies: RuntimeExecutionLoopDependencies,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState
): Promise<LoopOutcome> {
  return await runRuntimeExecutionLoop(
    {
      applyContextEngineeringPlan: (
        activeHandle,
        activeSchemaId,
        plan,
        activeLoopState,
        updates
      ) =>
        dependencies.applyContextEngineeringPlan(
          activeHandle,
          activeSchemaId,
          plan as ContextEngineeringPlan,
          activeLoopState,
          updates
        ),
      applyTerminalAgentTransitionIfNeeded: (...args) =>
        dependencies.applyTerminalAgentTransitionIfNeeded(...args),
      commitPendingExtensionStateUpdates: (...args) =>
        dependencies.commitPendingExtensionStateUpdates(...args),
      createId: () => dependencies.createId(),
      executeIterationPhase: (...args) =>
        dependencies.executeIterationPhase(...args),
      incorporateQueuedSteeringIfNeeded: (...args) =>
        dependencies.incorporateQueuedSteeringIfNeeded(...args),
      loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
      publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
      publishEvent: (...args) => dependencies.publishEvent(...args),
      publishProjectedError: (...args) =>
        dependencies.publishProjectedError(...args),
    },
    handle,
    schemaId,
    loopState,
    () => dependencies.now()
  );
}

export async function executeRuntimeIterationPhaseFacade(
  dependencies: RuntimeIterationPhaseDependencies,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  headState: HeadState | undefined,
  iterationCount: number
): Promise<IterationPhaseResult> {
  if (headState === undefined) {
    throw new TuvrenRuntimeError("iteration execution requires head state", {
      code: "missing_head_state",
    });
  }

  return await executeRuntimeIterationPhase(
    {
      applyAfterIterationResolution: (
        activeHandle,
        activeLoopState,
        activeIterationCount,
        runId,
        resolution,
        response,
        toolResults,
        headMessages,
        stagedMessages,
        manifest
      ) =>
        dependencies.applyAfterIterationResolution(
          activeHandle,
          activeLoopState as LoopState,
          activeIterationCount,
          runId,
          resolution,
          response,
          toolResults,
          headMessages,
          stagedMessages,
          manifest
        ),
      applyRequestedToolBatchIfNeeded: (input) =>
        dependencies.applyRequestedToolBatchIfNeeded({
          ...input,
          headState: input.headState as HeadState,
          loopState: input.loopState as LoopState,
        }),
      beginIterationStep: async (runId, stepId) => {
        await dependencies.beginIterationStep(runId, stepId);
      },
      completeIterationArtifacts: (
        activeHandle,
        activeSchemaId,
        activeLoopState,
        activeHeadState,
        activeIterationCount,
        runId,
        resolution,
        manifest,
        appendedMessageHashes
      ) =>
        dependencies.completeIterationArtifacts(
          activeHandle,
          activeSchemaId,
          activeLoopState as LoopState,
          activeHeadState as HeadState,
          activeIterationCount,
          runId,
          resolution,
          manifest,
          appendedMessageHashes
        ),
      createDriverExecutionContext: (
        activeHandle,
        activeSchemaId,
        activeLoopState,
        activeHeadState,
        activeIterationCount,
        emittedDriverEvents
      ) =>
        dependencies.createDriverExecutionContext(
          activeHandle,
          activeSchemaId,
          activeLoopState as LoopState,
          activeHeadState as HeadState,
          activeIterationCount,
          emittedDriverEvents
        ),
      createId: () => dependencies.createId(),
      createTrackedRun: (...args) => dependencies.createTrackedRun(...args),
      executeDriver: (...args) => dependencies.executeDriver(...args),
      failInvalidPauseResolutionIfNeeded: (...args) =>
        dependencies.failInvalidPauseResolutionIfNeeded(...args),
      failTrackedRunWithoutBranchAdvance: (...args) =>
        dependencies.failTrackedRunWithoutBranchAdvance(...args),
      flushBufferedDriverEventsIfNeeded: (...args) =>
        dependencies.flushBufferedDriverEventsIfNeeded(...args),
      ensureDriverAssistantEvents: (...args) =>
        dependencies.ensureDriverAssistantEvents(...args),
      materializeDriver: (driverId) => dependencies.materializeDriver(driverId),
      reconcileCheckpointedPauseResolution: (...args) =>
        dependencies.reconcileCheckpointedPauseResolution(...args),
      stageDriverMessages: (...args) =>
        dependencies.stageDriverMessages(...args),
    },
    {
      handle,
      headState,
      iterationCount,
      loopState,
      schemaId,
    }
  );
}

export function createRuntimeDriverExecutionContextFacade(
  host: RuntimeCoreDriverHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  headState: HeadState,
  iterationCount: number,
  emittedDriverEvents: TuvrenStreamEvent[]
): DriverExecutionContext {
  return createRuntimeDriverExecutionContext(
    host,
    handle,
    schemaId,
    loopState,
    headState,
    iterationCount,
    emittedDriverEvents
  );
}

export async function stageRuntimeDriverMessagesFacade(
  host: RuntimeCoreDriverHost,
  runId: string,
  messages: TuvrenMessage[],
  iterationCount: number
): Promise<HashString[]> {
  return await stageRuntimeDriverMessages(
    host,
    runId,
    messages,
    iterationCount
  );
}

export async function applyRuntimeRequestedToolBatchIfNeededFacade(
  host: RuntimeCoreDriverHost,
  input: {
    handle: RuntimeExecutionHandle;
    headState: HeadState;
    iterationCount: number;
    loopState: LoopState;
    requestedToolCalls: ToolCallPart[];
    resolution: RuntimeResolution;
    runId: string;
    stagedMessageHashes: HashString[];
    stagedMessages: TuvrenMessage[];
    toolExecutionMode: ToolExecutionMode;
    toolResults: ToolResultPart[];
  }
): Promise<LoopOutcome | RuntimeResolution> {
  return await applyRuntimeRequestedToolBatchIfNeeded(host, input);
}

export async function completeRuntimeIterationArtifactsFacade(
  host: RuntimeCoreDriverHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  headState: HeadState,
  iterationCount: number,
  runId: string,
  resolution: RuntimeResolution,
  manifest: ContextManifest,
  appendedMessageHashes: HashString[]
): Promise<HashString | undefined> {
  return await completeRuntimeIterationArtifacts(
    host,
    handle,
    schemaId,
    loopState,
    headState,
    iterationCount,
    runId,
    resolution,
    manifest,
    appendedMessageHashes
  );
}

export async function applyRuntimeAfterIterationResolutionFacade(
  host: RuntimeCoreDriverHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  iterationCount: number,
  runId: string,
  resolution: RuntimeResolution,
  response: TuvrenModelResponse,
  toolResults: ToolResultPart[],
  headMessages: TuvrenMessage[],
  stagedMessages: TuvrenMessage[],
  manifest: ContextManifest
): Promise<RuntimeResolution> {
  return await applyRuntimeAfterIterationResolution(
    host,
    handle,
    loopState,
    iterationCount,
    runId,
    resolution,
    response,
    toolResults,
    headMessages,
    stagedMessages,
    manifest
  );
}

export async function resumeRuntimePausedToolExecutionFacade(
  host: Parameters<typeof resumeRuntimePausedToolExecution>[0],
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  resumeContext: ResumeContext
): Promise<LoopOutcome> {
  return await resumeRuntimePausedToolExecution(
    host,
    handle,
    schemaId,
    loopState,
    resumeContext
  );
}

export function createRuntimeToolBatchEnvironmentFacade(
  host: RuntimeCoreDriverSupportHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  manifest: ContextManifest,
  iterationCount: number,
  runId: string
) {
  return createRuntimeToolBatchEnvironment(
    host,
    handle,
    loopState,
    manifest,
    iterationCount,
    runId
  );
}

export function createRuntimeDriverHandoffContextPlanFacade(
  host: RuntimeCoreDriverSupportHost,
  input: {
    builder?: HandoffContextBuilder;
    mode?: string;
    payload?: unknown;
    reason: string;
    targetAgent: string;
  },
  headState: HeadState,
  loopState: LoopState
): HandoffContextPlan {
  return createRuntimeDriverHandoffContextPlan(
    host,
    input,
    headState,
    loopState
  );
}

export async function completeRuntimeIterationRunFacade(
  host: RuntimeCoreTurnProgressHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  resolution: RuntimeResolution,
  manifest: ContextManifest,
  iterationCount: number,
  loopState: LoopState,
  treeHash?: HashString
): Promise<HashString | undefined> {
  return await completeRuntimeIterationRun(
    host,
    handle,
    runId,
    resolution,
    manifest,
    iterationCount,
    loopState,
    treeHash
  );
}

export async function createRuntimeIterationTreeFacade(
  host: RuntimeCoreTurnProgressHost,
  schemaId: string,
  baseTurnTreeHash: HashString,
  baseMessageHashes: HashString[],
  appendedMessageHashes: HashString[],
  manifestHash: HashString,
  runtimeStatusHash?: HashString
): Promise<HashString> {
  return await createRuntimeIterationTree(
    host,
    schemaId,
    baseTurnTreeHash,
    baseMessageHashes,
    appendedMessageHashes,
    manifestHash,
    runtimeStatusHash
  );
}

export async function incorporateRuntimeInputFacade(
  host: RuntimeCoreStateCommitHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState
): Promise<void> {
  await incorporateRuntimeInput(host, handle, schemaId, loopState);
}

export async function incorporateRuntimeSteeringFacade(
  host: RuntimeCoreStateCommitHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  signal: InputSignal,
  loopState: LoopState
): Promise<void> {
  await incorporateRuntimeSteering(host, handle, schemaId, signal, loopState);
}

export async function commitRuntimePendingExtensionStateUpdatesFacade(
  host: RuntimeCoreStateCommitHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  updates: ExtensionStateUpdate[],
  iterationCount: number
): Promise<void> {
  await commitRuntimePendingExtensionStateUpdates(
    host,
    handle,
    schemaId,
    loopState,
    updates,
    iterationCount
  );
}

export async function applyRuntimeContextEngineeringPlanFacade(
  host: RuntimeCoreContextOpsHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  plan: ContextEngineeringPlan,
  loopState: LoopState,
  updates: ExtensionStateUpdate[]
): Promise<void> {
  await applyRuntimeContextEngineeringPlan(
    host,
    handle,
    schemaId,
    plan,
    loopState,
    updates
  );
}

export async function applyRuntimeHandoffFacade(
  host: RuntimeCoreContextOpsHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  plan: HandoffContextPlan,
  loopState: LoopState,
  updates: ExtensionStateUpdate[]
): Promise<{
  activeConfig: AgentConfig;
  activeToolRegistry: ToolRegistry;
}> {
  return await applyRuntimeHandoff(
    host,
    handle,
    schemaId,
    plan,
    loopState,
    updates
  );
}
