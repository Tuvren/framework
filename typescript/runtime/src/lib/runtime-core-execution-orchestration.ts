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

import { TuvrenRuntimeError } from "@tuvren/core";
import type { EpochMs, HashString } from "@tuvren/core";
import type { ClientEndpointBoundary } from "@tuvren/core/capabilities";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  AgentConfig,
  ContextEngineeringPlan,
  ContextManifest,
  HandoffContextBuilder,
  HandoffContextPlan,
  InputSignal,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type {
  ToolCallPart,
  ToolResultPart,
  TuvrenMessage,
} from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import type {
  RunnerExecutionContext,
  RunnerExecutionResult,
  RuntimeRunner,
} from "@tuvren/core/runner";
import type { ToolRegistry } from "@tuvren/core/tools";

import type { ExtensionStateUpdate } from "./extension-runtime.js";
import type { ResolvedExecutionBounds } from "./runtime-core-bounds.js";
import {
  applyContextEngineeringPlan as applyRuntimeContextEngineeringPlan,
  applyHandoff as applyRuntimeHandoff,
} from "./runtime-core-context-ops.js";
import type { RuntimeCoreContextOpsHost } from "./runtime-core-context-ops.js";
import type { InterruptedToolBatchDescriptor } from "./runtime-core-interrupted-metadata.js";
import type {
  IterationPhaseResult,
  RuntimeCoreIterationHost,
} from "./runtime-core-iteration.js";
import { executeIterationPhase as executeRuntimeIterationPhase } from "./runtime-core-iteration.js";
import { runExecutionLoop as runRuntimeExecutionLoop } from "./runtime-core-loop.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type {
  DurableRuntimeStatus,
  LoopOutcome,
} from "./runtime-core-recovery.js";
import {
  createRunnerHandoffContextPlan as createRuntimeRunnerHandoffContextPlan,
  createToolBatchEnvironment as createRuntimeToolBatchEnvironment,
} from "./runtime-core-runner-support.js";
import type { RuntimeCoreRunnerSupportHost } from "./runtime-core-runner-support.js";
import {
  applyAfterIterationResolution as applyRuntimeAfterIterationResolution,
  applyRequestedToolBatchIfNeeded as applyRuntimeRequestedToolBatchIfNeeded,
  completeIterationArtifacts as completeRuntimeIterationArtifacts,
  createRunnerExecutionContext as createRuntimeRunnerExecutionContext,
  stageRunnerMessages as stageRuntimeRunnerMessages,
} from "./runtime-core-runner.js";
import type { RuntimeCoreRunnerHost } from "./runtime-core-runner.js";
import {
  commitPendingExtensionStateUpdates as commitRuntimePendingExtensionStateUpdates,
  incorporateInput as incorporateRuntimeInput,
  incorporateSteering as incorporateRuntimeSteering,
} from "./runtime-core-state-commit.js";
import type { RuntimeCoreStateCommitHost } from "./runtime-core-state-commit.js";
import { resumePausedToolExecution as resumeRuntimePausedToolExecution } from "./runtime-core-tool-resume.js";
import {
  completeIterationRun as completeRuntimeIterationRun,
  createIterationTree as createRuntimeIterationTree,
} from "./runtime-core-turn-progress.js";
import type { RuntimeCoreTurnProgressHost } from "./runtime-core-turn-progress.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { ResumeContext } from "./runtime-execution-types.js";
import type { ToolExecutionMode } from "./tool-execution.js";

/**
 * Late-bound dependency bag adapted into the execution loop's host seam by
 * {@link runRuntimeExecutionLoopFacade}.
 */
interface RuntimeExecutionLoopDependencies {
  applyContextEngineeringPlan: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    plan: ContextEngineeringPlan,
    loopState: LoopState,
    updates: ExtensionStateUpdate[],
    recoveredHistory?: {
      messageHashes: HashString[];
      messages: TuvrenMessage[];
    }
  ) => Promise<void>;
  applyTerminalAgentTransitionIfNeeded: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    resolution: RuntimeResolution,
    loopState: LoopState,
    stableHeadTurnNodeHash?: HashString
  ) => Promise<boolean>;
  /** Absolute wall-clock deadline (epoch ms) for the active turn. (BD006) */
  boundsDeadlineMs: (handle: RuntimeExecutionHandle) => number;
  commitPendingExtensionStateUpdates: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    updates: ExtensionStateUpdate[],
    iterationCount: number
  ) => Promise<void>;
  createId: () => string;
  executeIterationPhase: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState | undefined,
    iterationCount: number
  ) => Promise<IterationPhaseResult>;
  /** Framework-enforced execution bounds for this runtime instance. (BD006) */
  executionBounds: () => ResolvedExecutionBounds;
  incorporateQueuedSteeringIfNeeded: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ) => Promise<void>;
  loadHeadState: (branchId: string) => Promise<HeadState>;
  now: () => EpochMs;
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
  publishProjectedError: (
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ) => void;
  /** Record `count` more tool calls and return the new per-turn cumulative. (BD006) */
  recordBoundsToolCalls: (
    handle: RuntimeExecutionHandle,
    count: number
  ) => number;
}

/**
 * Late-bound dependency bag adapted into the iteration phase's host seam by
 * {@link executeRuntimeIterationPhaseFacade}.
 */
interface RuntimeIterationPhaseDependencies {
  applyAfterIterationResolution: (
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
  ) => Promise<RuntimeResolution>;
  applyRequestedToolBatchIfNeeded: (input: {
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
  }) => Promise<LoopOutcome | RuntimeResolution>;
  beginIterationStep: (runId: string, stepId: string) => Promise<void>;
  completeIterationArtifacts: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState,
    iterationCount: number,
    runId: string,
    resolution: RuntimeResolution,
    manifest: ContextManifest,
    appendedMessageHashes: HashString[],
    interruptedToolBatch?: InterruptedToolBatchDescriptor
  ) => Promise<HashString | undefined>;
  createId: () => string;
  stageManifest: (
    runId: string,
    manifest: ContextManifest,
    taskId?: string
  ) => Promise<HashString>;
  createRunnerExecutionContext: (
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState,
    iterationCount: number,
    emittedRunnerEvents: TuvrenStreamEvent[]
  ) => RunnerExecutionContext;
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
  ensureRunnerAssistantEvents: (
    handle: RuntimeExecutionHandle,
    messages: TuvrenMessage[],
    emittedEvents: TuvrenStreamEvent[],
    loopState: LoopState
  ) => TuvrenStreamEvent[];
  executeRunner: (
    runner: RuntimeRunner,
    context: RunnerExecutionContext
  ) => Promise<RunnerExecutionResult>;
  failInvalidPauseResolutionIfNeeded: (
    handle: RuntimeExecutionHandle,
    iterationRunId: string,
    stableHeadTurnNodeHash: HashString,
    requestedToolCallCount: number,
    resolution: RuntimeResolution
  ) => Promise<IterationPhaseResult | undefined>;
  failTrackedRunWithoutBranchAdvance: (
    handle: RuntimeExecutionHandle,
    runId: string,
    stableHeadTurnNodeHash: HashString
  ) => Promise<void>;
  flushBufferedRunnerEventsIfNeeded: (
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    events: TuvrenStreamEvent[]
  ) => TuvrenStreamEvent[];
  materializeRunner: (runnerId: string) => RuntimeRunner;
  now: () => number;
  /**
   * Publish through the full runtime event + telemetry path (KRT-BA002).
   * The iteration phase uses this for provider-tool attribution events so the
   * telemetry emitter observes the same tool.start/tool.result events as the
   * canonical stream.
   */
  publishEvent: (
    handle: RuntimeExecutionHandle,
    event: TuvrenStreamEvent,
    loopState: LoopState
  ) => void;
  reconcileCheckpointedPauseResolution: (
    checkpointedPause: boolean,
    runId: string,
    turnId: string,
    resolution: RuntimeResolution
  ) => Promise<RuntimeResolution>;
  stageRunnerMessages: (
    runId: string,
    messages: TuvrenMessage[],
    iterationCount: number
  ) => Promise<HashString[]>;
  stageRuntimeStatus: (
    runId: string,
    status: DurableRuntimeStatus,
    taskId: string
  ) => Promise<HashString>;
  stageTurnLineage: (
    runId: string,
    turnId: string,
    taskId: string,
    interruptedToolBatch?: InterruptedToolBatchDescriptor
  ) => Promise<HashString>;
}

/**
 * Facade over the loop module's `runExecutionLoop`: adapt the dependency
 * bag into the loop host seam and run the turn's iteration loop to a
 * terminal {@link LoopOutcome} using `dependencies.now()` as the clock.
 */
export const runRuntimeExecutionLoopFacade = async (
  dependencies: RuntimeExecutionLoopDependencies,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState
): Promise<LoopOutcome> =>
  await runRuntimeExecutionLoop(
    {
      applyContextEngineeringPlan: async (
        activeHandle,
        activeSchemaId,
        plan,
        activeLoopState,
        updates,
        recoveredHistory
      ) => {
        await dependencies.applyContextEngineeringPlan(
          activeHandle,
          activeSchemaId,
          plan,
          activeLoopState,
          updates,
          recoveredHistory
        );
      },
      applyTerminalAgentTransitionIfNeeded: async (...args) =>
        await dependencies.applyTerminalAgentTransitionIfNeeded(...args),
      boundsDeadlineMs: (boundsHandle) =>
        dependencies.boundsDeadlineMs(boundsHandle),
      commitPendingExtensionStateUpdates: async (...args) => {
        await dependencies.commitPendingExtensionStateUpdates(...args);
      },
      createId: () => dependencies.createId(),
      executeIterationPhase: async (...args) =>
        await dependencies.executeIterationPhase(...args),
      executionBounds: () => dependencies.executionBounds(),
      incorporateQueuedSteeringIfNeeded: async (...args) => {
        await dependencies.incorporateQueuedSteeringIfNeeded(...args);
      },
      loadHeadState: async (branchId) =>
        await dependencies.loadHeadState(branchId),
      publishCustomEvent: (...args) => {
        dependencies.publishCustomEvent(...args);
      },
      publishEvent: (...args) => {
        dependencies.publishEvent(...args);
      },
      publishProjectedError: (...args) => {
        dependencies.publishProjectedError(...args);
      },
      recordBoundsToolCalls: (boundsHandle, count) =>
        dependencies.recordBoundsToolCalls(boundsHandle, count),
    },
    handle,
    schemaId,
    loopState,
    () => dependencies.now()
  );

/**
 * Facade over the iteration module's `executeIterationPhase`: adapt the
 * dependency bag into the iteration host seam and execute one iteration
 * (runner invocation, tool batch, artifact completion) against the given
 * head state.
 *
 * @throws {TuvrenRuntimeError} With code `missing_head_state` when called
 *   without a head state — iteration execution always requires one.
 */
export const executeRuntimeIterationPhaseFacade = async (
  dependencies: RuntimeIterationPhaseDependencies,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  headState: HeadState | undefined,
  iterationCount: number
): Promise<IterationPhaseResult> => {
  if (headState === undefined) {
    throw new TuvrenRuntimeError("iteration execution requires head state", {
      code: "missing_head_state",
    });
  }
  const restoreHeadState = (
    activeHeadState: Parameters<
      RuntimeCoreIterationHost["createRunnerExecutionContext"]
    >[3]
  ): HeadState => ({
    ...headState,
    ...activeHeadState,
    turnNode: {
      ...headState.turnNode,
      ...activeHeadState.turnNode,
    },
  });

  return await executeRuntimeIterationPhase(
    {
      applyAfterIterationResolution: async (
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
        await dependencies.applyAfterIterationResolution(
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
        ),
      applyRequestedToolBatchIfNeeded: async (input) =>
        await dependencies.applyRequestedToolBatchIfNeeded({
          ...input,
          headState: restoreHeadState(input.headState),
          loopState: input.loopState,
        }),
      beginIterationStep: async (runId, stepId) => {
        await dependencies.beginIterationStep(runId, stepId);
      },
      completeIterationArtifacts: async (
        activeHandle,
        activeSchemaId,
        activeLoopState,
        activeHeadState,
        activeIterationCount,
        runId,
        resolution,
        manifest,
        appendedMessageHashes,
        interruptedToolBatch
      ) =>
        await dependencies.completeIterationArtifacts(
          activeHandle,
          activeSchemaId,
          activeLoopState,
          restoreHeadState(activeHeadState),
          activeIterationCount,
          runId,
          resolution,
          manifest,
          appendedMessageHashes,
          interruptedToolBatch
        ),
      createId: () => dependencies.createId(),
      createRunnerExecutionContext: (
        activeHandle,
        activeSchemaId,
        activeLoopState,
        activeHeadState,
        activeIterationCount,
        emittedRunnerEvents
      ) =>
        dependencies.createRunnerExecutionContext(
          activeHandle,
          activeSchemaId,
          activeLoopState,
          restoreHeadState(activeHeadState),
          activeIterationCount,
          emittedRunnerEvents
        ),
      createTrackedRun: async (...args) => {
        await dependencies.createTrackedRun(...args);
      },
      ensureRunnerAssistantEvents: (...args) =>
        dependencies.ensureRunnerAssistantEvents(...args),
      executeRunner: async (...args) =>
        await dependencies.executeRunner(...args),
      failInvalidPauseResolutionIfNeeded: async (...args) =>
        await dependencies.failInvalidPauseResolutionIfNeeded(...args),
      failTrackedRunWithoutBranchAdvance: async (...args) => {
        await dependencies.failTrackedRunWithoutBranchAdvance(...args);
      },
      flushBufferedRunnerEventsIfNeeded: (...args) =>
        dependencies.flushBufferedRunnerEventsIfNeeded(...args),
      materializeRunner: (runnerId) => dependencies.materializeRunner(runnerId),
      now: () => dependencies.now(),
      publishEvent: (...args) => {
        dependencies.publishEvent(...args);
      },
      reconcileCheckpointedPauseResolution: async (...args) =>
        await dependencies.reconcileCheckpointedPauseResolution(...args),
      stageManifest: async (...args) =>
        await dependencies.stageManifest(...args),
      stageRunnerMessages: async (...args) =>
        await dependencies.stageRunnerMessages(...args),
      stageTurnLineage: async (...args) =>
        await dependencies.stageTurnLineage(...args),
    },
    {
      handle,
      headState,
      iterationCount,
      loopState,
      schemaId,
    }
  );
};

/**
 * Pass-through facade over `createRunnerExecutionContext`
 * (`runtime-core-runner.ts`): builds the context object handed to a runner's
 * `execute` for one iteration.
 */
export const createRuntimeRunnerExecutionContextFacade = (
  host: RuntimeCoreRunnerHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  headState: HeadState,
  iterationCount: number,
  emittedRunnerEvents: TuvrenStreamEvent[]
): RunnerExecutionContext =>
  createRuntimeRunnerExecutionContext(
    host,
    handle,
    schemaId,
    loopState,
    headState,
    iterationCount,
    emittedRunnerEvents
  );

/**
 * Pass-through facade over `stageRunnerMessages`
 * (`runtime-core-runner.ts`): stages the runner-produced messages for a run
 * and returns their object hashes.
 */
export const stageRuntimeRunnerMessagesFacade = async (
  host: RuntimeCoreRunnerHost,
  runId: string,
  messages: TuvrenMessage[],
  iterationCount: number
): Promise<HashString[]> =>
  await stageRuntimeRunnerMessages(host, runId, messages, iterationCount);

/**
 * Pass-through facade over `applyRequestedToolBatchIfNeeded`
 * (`runtime-core-runner.ts`): executes the iteration's requested tool batch
 * when the resolution calls for it, yielding either an updated resolution or
 * a short-circuit loop outcome.
 */
export const applyRuntimeRequestedToolBatchIfNeededFacade = async (
  host: RuntimeCoreRunnerHost,
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
): Promise<LoopOutcome | RuntimeResolution> =>
  await applyRuntimeRequestedToolBatchIfNeeded(host, input);

/**
 * Pass-through facade over `completeIterationArtifacts`
 * (`runtime-core-runner.ts`): commits the iteration's durable artifacts and
 * returns the new turn-node hash, if the iteration advanced one.
 */
export const completeRuntimeIterationArtifactsFacade = async (
  host: RuntimeCoreRunnerHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  headState: HeadState,
  iterationCount: number,
  runId: string,
  resolution: RuntimeResolution,
  manifest: ContextManifest,
  appendedMessageHashes: HashString[],
  interruptedToolBatch?: InterruptedToolBatchDescriptor
): Promise<HashString | undefined> =>
  await completeRuntimeIterationArtifacts(
    host,
    handle,
    schemaId,
    loopState,
    headState,
    iterationCount,
    runId,
    resolution,
    manifest,
    appendedMessageHashes,
    interruptedToolBatch
  );

/**
 * Pass-through facade over `applyAfterIterationResolution`
 * (`runtime-core-runner.ts`): runs after-iteration extension hooks and
 * returns the (possibly overridden) resolution.
 */
export const applyRuntimeAfterIterationResolutionFacade = async (
  host: RuntimeCoreRunnerHost,
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
): Promise<RuntimeResolution> =>
  await applyRuntimeAfterIterationResolution(
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

/**
 * Pass-through facade over `resumePausedToolExecution`
 * (`runtime-core-tool-resume.ts`): resumes a turn paused on tool approval and
 * drives it to a loop outcome.
 */
export const resumeRuntimePausedToolExecutionFacade = async (
  host: Parameters<typeof resumeRuntimePausedToolExecution>[0],
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  resumeContext: ResumeContext
): Promise<LoopOutcome> =>
  await resumeRuntimePausedToolExecution(
    host,
    handle,
    schemaId,
    loopState,
    resumeContext
  );

/**
 * Pass-through facade over `createToolBatchEnvironment`
 * (`runtime-core-runner-support.ts`): assembles the environment a requested
 * tool batch executes in.
 */
export const createRuntimeToolBatchEnvironmentFacade = (
  host: RuntimeCoreRunnerSupportHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  manifest: ContextManifest,
  iterationCount: number,
  runId: string
) =>
  createRuntimeToolBatchEnvironment(
    host,
    handle,
    loopState,
    manifest,
    iterationCount,
    runId
  );

/**
 * Pass-through facade over `createRunnerHandoffContextPlan`
 * (`runtime-core-runner-support.ts`): builds the context plan for a
 * runner-requested agent handoff.
 */
export const createRuntimeRunnerHandoffContextPlanFacade = (
  host: RuntimeCoreRunnerSupportHost,
  input: {
    builder?: HandoffContextBuilder;
    mode?: string;
    payload?: unknown;
    reason: string;
    targetAgent: string;
  },
  headState: HeadState,
  loopState: LoopState
): HandoffContextPlan =>
  createRuntimeRunnerHandoffContextPlan(host, input, headState, loopState);

/**
 * Pass-through facade over `completeIterationRun`
 * (`runtime-core-turn-progress.ts`): closes the iteration's kernel run and
 * returns the advanced turn-node hash, when one was produced.
 */
export const completeRuntimeIterationRunFacade = async (
  host: RuntimeCoreTurnProgressHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  resolution: RuntimeResolution,
  manifest: ContextManifest,
  iterationCount: number,
  loopState: LoopState,
  treeHash?: HashString
): Promise<HashString | undefined> =>
  await completeRuntimeIterationRun(
    host,
    handle,
    runId,
    resolution,
    manifest,
    iterationCount,
    loopState,
    treeHash
  );

/**
 * Pass-through facade over `createIterationTree`
 * (`runtime-core-turn-progress.ts`): creates the turn tree that appends the
 * iteration's messages, manifest, and runtime status onto the base tree.
 */
export const createRuntimeIterationTreeFacade = async (
  host: RuntimeCoreTurnProgressHost,
  schemaId: string,
  baseTurnTreeHash: HashString,
  baseMessageHashes: HashString[],
  appendedMessageHashes: HashString[],
  manifestHash: HashString,
  runtimeStatusHash?: HashString,
  turnLineageHash?: HashString
): Promise<HashString> =>
  await createRuntimeIterationTree(
    host,
    schemaId,
    baseTurnTreeHash,
    baseMessageHashes,
    appendedMessageHashes,
    manifestHash,
    runtimeStatusHash,
    turnLineageHash
  );

/**
 * Pass-through facade over `incorporateInput`
 * (`runtime-core-state-commit.ts`): durably incorporates the request's input
 * signal into the turn before the first iteration.
 */
export const incorporateRuntimeInputFacade = async (
  host: RuntimeCoreStateCommitHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState
): Promise<void> => {
  await incorporateRuntimeInput(host, handle, schemaId, loopState);
};

/**
 * Pass-through facade over `incorporateSteering`
 * (`runtime-core-state-commit.ts`): durably incorporates a queued steering
 * signal between iterations.
 */
export const incorporateRuntimeSteeringFacade = async (
  host: RuntimeCoreStateCommitHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  signal: InputSignal,
  loopState: LoopState
): Promise<void> => {
  await incorporateRuntimeSteering(host, handle, schemaId, signal, loopState);
};

/**
 * Pass-through facade over `commitPendingExtensionStateUpdates`
 * (`runtime-core-state-commit.ts`): persists extension manifest-state
 * updates gathered during an iteration.
 */
export const commitRuntimePendingExtensionStateUpdatesFacade = async (
  host: RuntimeCoreStateCommitHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  updates: ExtensionStateUpdate[],
  iterationCount: number
): Promise<void> => {
  await commitRuntimePendingExtensionStateUpdates(
    host,
    handle,
    schemaId,
    loopState,
    updates,
    iterationCount
  );
};

/**
 * Pass-through facade over `applyContextEngineeringPlan`
 * (`runtime-core-context-ops.ts`): executes a context-engineering plan's
 * message-set rewrite and commits it as a durable turn-state change.
 */
export const applyRuntimeContextEngineeringPlanFacade = async (
  host: RuntimeCoreContextOpsHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  plan: ContextEngineeringPlan,
  loopState: LoopState,
  updates: ExtensionStateUpdate[],
  recoveredHistory?: {
    messageHashes: HashString[];
    messages: TuvrenMessage[];
  }
): Promise<void> => {
  await applyRuntimeContextEngineeringPlan(
    host,
    handle,
    schemaId,
    plan,
    loopState,
    updates,
    recoveredHistory
  );
};

/**
 * Pass-through facade over `applyHandoff`
 * (`runtime-core-context-ops.ts`): applies an agent handoff plan and returns
 * the new active config, tool registry, and client-endpoint boundary.
 */
export const applyRuntimeHandoffFacade = async (
  host: RuntimeCoreContextOpsHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  plan: HandoffContextPlan,
  loopState: LoopState,
  updates: ExtensionStateUpdate[]
): Promise<{
  activeConfig: AgentConfig;
  activeToolRegistry: ToolRegistry;
  clientEndpointBoundary: ClientEndpointBoundary | undefined;
}> =>
  await applyRuntimeHandoff(host, handle, schemaId, plan, loopState, updates);
