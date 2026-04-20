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

import { createHash, randomUUID } from "node:crypto";
import type {
  DriverExecutionContext,
  DriverRegistry,
  DriverResumeContext,
  KrakenDriver,
} from "@kraken/framework-driver-api";
import { assertDriverExecutionResult } from "@kraken/framework-driver-api";
import type {
  AgentConfig,
  ApprovalResponse,
  ContextEngineeringContext,
  ContextEngineeringHelpers,
  ContextEngineeringPlan,
  ContextManifest,
  ExecutionHandle,
  HandoffContextBuilder,
  HandoffContextPlan,
  HandoffSourceContext,
  InputSignal,
  KrakenExtension,
  KrakenMessage,
  KrakenModelResponse,
  KrakenRuntime,
  KrakenStreamEvent,
  KrakenToolDefinition,
  RuntimeResolution,
  ToolCallPart,
  ToolRegistry,
  ToolResultPart,
  TurnEndEvent,
} from "@kraken/framework-runtime-api";
import {
  assertContextManifest,
  assertKrakenMessage,
  assertKrakenStreamEvent,
} from "@kraken/framework-runtime-api";
import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  type KrakenKernel,
  type PathValue,
  type RunCompletionStatus,
  type TurnNode,
  type TurnTreeSchema,
} from "@kraken/kernel-contract-protocol";
import {
  assertKernelRecord,
  type EpochMs,
  type HashString,
  type KernelRecord,
  KrakenLineageError,
  KrakenRuntimeError,
} from "@kraken/shared-core-types";
import {
  createContextManifest,
  createEmptyContextManifest,
  updateContextManifest,
} from "./context-manifest.js";
import { createDriverRegistry, materializeDriver } from "./driver-registry.js";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import {
  runAfterIterationHooks,
  runAfterTurnHooks,
  runBeforeIterationHooks,
  runBeforeTurnHooks,
} from "./extension-runtime.js";
import {
  createLastOutputOnlyHandoffContextBuilder,
  createPreserveTraceHandoffContextBuilder,
} from "./handoff-builders.js";
import {
  cloneValue,
  createFrozenSnapshot,
  detachPromise,
  isRecord,
  normalizeError,
  normalizeInputSignal,
  projectError,
} from "./runtime-core-shared.js";
import { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type {
  ExecutionSessionRequest,
  PauseContext,
  ResumeContext,
} from "./runtime-execution-types.js";
import {
  executeToolBatch,
  resumeToolBatch,
  type ToolBatchEnvironment,
  type ToolBatchOutcome,
} from "./tool-execution.js";
import { createToolRegistry } from "./tool-registry.js";

export const DEFAULT_AGENT_SCHEMA_ID = "kraken.agent.v1";
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
  driverRegistry?: DriverRegistry;
  enableStateObservability?: boolean;
  handoffContextBuilder?: HandoffContextBuilder;
  kernel: KrakenKernel;
  now?: () => EpochMs;
  resolveAgentConfig?: (agentName: string) => AgentConfig | undefined;
  resolveParentTurnId?: (
    threadId: string,
    branchId: string
  ) => Promise<string | null> | string | null;
}

interface ResolvedRuntimeCoreOptions {
  createId: () => string;
  defaultDriverId: string;
  driverRegistry: DriverRegistry;
  enableStateObservability: boolean;
  handoffContextBuilder?: HandoffContextBuilder;
  kernel: KrakenKernel;
  now: () => EpochMs;
  resolveAgentConfig?: (agentName: string) => AgentConfig | undefined;
  resolveParentTurnId?: (
    threadId: string,
    branchId: string
  ) => Promise<string | null> | string | null;
}

interface HeadState {
  branchHeadHash: HashString;
  manifest: ContextManifest;
  messageHashes: HashString[];
  messages: KrakenMessage[];
  turnNode: TurnNode;
}

interface LoopState {
  activeConfig: AgentConfig;
  activeDriverId: string;
  activeToolRegistry: ToolRegistry;
  carriedStateUpdates: ExtensionStateUpdate[];
  enteredIterationLoop: boolean;
}

interface LoopOutcome {
  partial?: boolean;
  pauseContext?: PauseContext;
  resolution: RuntimeResolution;
}

interface IterationPreparationResult {
  headState?: HeadState;
  resolution?: RuntimeResolution;
}

interface ExecutedIterationResult {
  driverResponse: KrakenModelResponse;
  iterationRunId: string;
  partial: boolean;
  requestedToolCalls: ToolCallPart[];
  resolution: RuntimeResolution;
  toolResults: ToolResultPart[];
  turnNodeHash: HashString | undefined;
}

interface DurableRuntimeStatus {
  activeAgent?: string;
  partial?: boolean;
  pauseReason?: string;
  state: "completed" | "failed" | "paused" | "running";
}

interface TurnLineageRecord {
  activeTurnId: string;
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

interface HelperBundle {
  flush(): Promise<void>;
  helpers: ContextEngineeringHelpers;
  resolveHashes(hashes: HashString[]): HashString[];
}

class FinalizationFailure extends Error {
  readonly finalizationError: Error;
  readonly rootCause?: Error;

  constructor(finalizationError: Error, rootCause?: Error) {
    super(finalizationError.message, { cause: finalizationError });
    this.name = "FinalizationFailure";
    this.finalizationError = finalizationError;
    this.rootCause = rootCause;
  }
}

class RuntimeCore implements KrakenRuntime {
  private readonly options: ResolvedRuntimeCoreOptions;

  constructor(options: RuntimeCoreOptions) {
    this.options = {
      createId: options.createId ?? randomUUID,
      defaultDriverId: options.defaultDriverId,
      driverRegistry: options.driverRegistry ?? createDriverRegistry(),
      enableStateObservability: options.enableStateObservability ?? true,
      handoffContextBuilder: options.handoffContextBuilder,
      kernel: options.kernel,
      now: options.now ?? Date.now,
      resolveAgentConfig: options.resolveAgentConfig,
      resolveParentTurnId: options.resolveParentTurnId,
    };
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
    const normalizedSignal = normalizeInputSignal(
      request.signal,
      "request.signal"
    );
    return new RuntimeExecutionHandle(
      this,
      {
        ...request,
        config: cloneAgentConfigForRequest(request.config),
        tools: request.tools === undefined ? undefined : [...request.tools],
        signal: normalizedSignal,
      },
      this.createId(),
      request.schemaId ?? DEFAULT_AGENT_SCHEMA_ID
    );
  }

  createResumedExecutionHandle(
    previousHandle: RuntimeExecutionHandle,
    pauseContext: PauseContext,
    response: ApprovalResponse
  ): RuntimeExecutionHandle {
    const handle = new RuntimeExecutionHandle(
      this,
      {
        ...previousHandle.request,
        config: cloneAgentConfigForRequest(pauseContext.activeConfig),
        driverId: pauseContext.activeDriverId,
      },
      previousHandle.turnId,
      previousHandle.schemaId,
      {
        approval: response,
        pauseContext,
        pausedRunId: pauseContext.pausedRunId,
        pausedTurnNodeHash: pauseContext.pausedTurnNodeHash,
      }
    );
    handle.reuseDriverCache(previousHandle);
    previousHandle.moveSteeringQueueTo(handle);
    handle.primeResumedCancellation(pauseContext);
    handle.replaceStatus({
      activeAgent: pauseContext.activeConfig.name,
      iterationCount: previousHandle.status().iterationCount,
      manifest: previousHandle.status().manifest,
      phase: "running",
    });
    return handle;
  }

  cancelPausedExecution(handle: RuntimeExecutionHandle): void {
    const pauseContext = handle.takePauseContextForCancellation();

    if (pauseContext === undefined) {
      return;
    }

    detachPromise(
      this.finalizePausedCancellation(
        handle,
        pauseContext,
        new Error("execution cancelled")
      )
    );
  }

  async startExecution(handle: RuntimeExecutionHandle): Promise<void> {
    try {
      const schemaId = await this.resolveExecutionSchemaId(handle.request);
      handle.setSchemaId(schemaId);
      const branchHeadHash = await this.resolveExecutionBranchHead(handle);
      await this.createExecutionTurnIfNeeded(handle, branchHeadHash);
      const loopState = this.createExecutionLoopState(handle);
      this.publishTurnStart(handle, loopState);

      if (await this.prepareExecutionStart(handle, schemaId, loopState)) {
        return;
      }

      const outcome = await this.runExecutionLoop(handle, schemaId, loopState);

      if (this.publishPauseOutcome(handle, outcome.pauseContext, loopState)) {
        return;
      }

      await this.completeExecution(
        handle,
        outcome.resolution,
        outcome.partial ?? false,
        loopState,
        loopState.enteredIterationLoop
      );
    } catch (error: unknown) {
      await this.handleExecutionFailure(handle, error);
    } finally {
      handle.finish();
    }
  }

  private async resolveExecutionBranchHead(
    handle: RuntimeExecutionHandle
  ): Promise<HashString> {
    const branch = await this.options.kernel.branch.get(
      handle.request.branchId
    );

    if (branch === null) {
      throw new KrakenLineageError(
        `branch "${handle.request.branchId}" does not exist`,
        {
          code: "missing_branch",
        }
      );
    }

    if (branch.threadId !== handle.request.threadId) {
      throw new KrakenLineageError(
        `branch "${handle.request.branchId}" belongs to thread "${branch.threadId}", not "${handle.request.threadId}"`,
        {
          code: "branch_thread_mismatch",
          details: {
            branchId: handle.request.branchId,
            branchThreadId: branch.threadId,
            requestThreadId: handle.request.threadId,
          },
        }
      );
    }

    return branch.headTurnNodeHash;
  }

  private async createExecutionTurnIfNeeded(
    handle: RuntimeExecutionHandle,
    branchHeadHash: HashString
  ): Promise<void> {
    if (handle.resumedFrom !== undefined) {
      return;
    }

    const parentTurnId = await this.resolveParentTurnId(
      handle.request.threadId,
      handle.request.branchId,
      handle.request.parentTurnId
    );

    await this.options.kernel.turn.create(
      handle.turnId,
      handle.request.threadId,
      handle.request.branchId,
      parentTurnId,
      branchHeadHash
    );
  }

  private createExecutionLoopState(handle: RuntimeExecutionHandle): LoopState {
    const resumedPauseContext = handle.resumedFrom?.pauseContext;

    return {
      activeConfig: resumedPauseContext?.activeConfig ?? handle.request.config,
      activeDriverId:
        resumedPauseContext?.activeDriverId ??
        handle.request.driverId ??
        this.options.defaultDriverId,
      activeToolRegistry:
        resumedPauseContext?.activeToolRegistry ??
        createActiveToolRegistry(handle.request.tools, handle.request.config),
      carriedStateUpdates: [
        ...(resumedPauseContext?.carriedStateUpdates ?? []),
      ],
      enteredIterationLoop: false,
    };
  }

  private publishTurnStart(
    handle: RuntimeExecutionHandle,
    loopState: LoopState
  ): void {
    this.publishEvent(
      handle,
      {
        resumedFrom: handle.resumedFrom?.pausedTurnNodeHash,
        threadId: handle.request.threadId,
        timestamp: this.now(),
        turnId: handle.turnId,
        type: "turn.start",
      },
      loopState
    );
  }

  private async prepareExecutionStart(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<boolean> {
    if (handle.resumedFrom === undefined) {
      return await this.prepareFreshExecutionStart(handle, schemaId, loopState);
    }

    return await this.prepareResumedExecutionStart(handle, schemaId, loopState);
  }

  private async prepareFreshExecutionStart(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<boolean> {
    await this.incorporateInput(handle, schemaId, loopState);
    const headState = await this.loadHeadState(handle.request.branchId);
    handle.updateStatus({
      activeAgent: loopState.activeConfig.name,
      iterationCount: 0,
      manifest: headState.manifest,
      phase: "running",
    });

    const beforeTurn = await runBeforeTurnHooks({
      emit: (event) => {
        this.publishCustomEvent(handle, event, loopState);
      },
      extensions: loopState.activeConfig.extensions ?? [],
      iterationCount: 0,
      manifest: headState.manifest,
      messages: headState.messages,
      runId: this.createId(),
      turnId: handle.turnId,
    });
    loopState.carriedStateUpdates.push(...beforeTurn.updates);

    if (beforeTurn.resolution === undefined) {
      return false;
    }

    if (
      beforeTurn.resolution.type === "fail" &&
      beforeTurn.resolution.fatality === "soft"
    ) {
      this.publishProjectedError(
        handle,
        beforeTurn.resolution.error,
        false,
        loopState
      );
      return false;
    }

    await this.commitPendingExtensionStateUpdates(
      handle,
      schemaId,
      loopState,
      loopState.carriedStateUpdates,
      0
    );
    loopState.carriedStateUpdates = [];
    await this.completeExecution(
      handle,
      beforeTurn.resolution,
      false,
      loopState,
      false
    );
    return true;
  }

  private async prepareResumedExecutionStart(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<boolean> {
    const resumeContext = handle.resumedFrom;

    if (resumeContext === undefined) {
      return false;
    }

    await this.options.kernel.run.complete(resumeContext.pausedRunId, "failed");
    handle.clearPendingResumeCancellation();
    this.publishEvent(
      handle,
      {
        response: resumeContext.approval,
        timestamp: this.now(),
        type: "approval.resolved",
      },
      loopState
    );
    await this.checkpointResumeRunningStatus(
      handle,
      schemaId,
      loopState,
      resumeContext.pauseContext.pausedIteration?.iterationCount ??
        handle.status().iterationCount
    );

    if (resumeContext.pauseContext.kind !== "tool_approval") {
      return false;
    }

    const resumedOutcome = await this.resumePausedToolExecution(
      handle,
      schemaId,
      loopState,
      resumeContext
    );

    if (
      this.publishPauseOutcome(handle, resumedOutcome.pauseContext, loopState)
    ) {
      return true;
    }

    if (
      resumedOutcome.resolution.type === "fail" &&
      resumedOutcome.resolution.fatality === "soft"
    ) {
      this.publishProjectedError(
        handle,
        resumedOutcome.resolution.error,
        false,
        loopState
      );
      return false;
    }

    if (
      resumedOutcome.resolution.type !== "continue_iteration" &&
      !(await this.applyTerminalAgentTransitionIfNeeded(
        handle,
        schemaId,
        resumedOutcome.resolution,
        loopState
      ))
    ) {
      await this.completeExecution(
        handle,
        resumedOutcome.resolution,
        resumedOutcome.partial ?? false,
        loopState,
        true
      );
      return true;
    }

    return false;
  }

  private publishPauseOutcome(
    handle: RuntimeExecutionHandle,
    pauseContext: PauseContext | undefined,
    loopState: LoopState
  ): boolean {
    if (pauseContext === undefined) {
      return false;
    }

    handle.rememberPauseContext(pauseContext);
    this.publishEvent(
      handle,
      {
        request: pauseContext.approval,
        timestamp: this.now(),
        type: "approval.requested",
      },
      {
        ...loopState,
        activeConfig: pauseContext.activeConfig,
        activeDriverId: pauseContext.activeDriverId,
      }
    );
    this.publishEvent(
      handle,
      {
        status: "paused",
        timestamp: this.now(),
        turnId: handle.turnId,
        type: "turn.end",
      },
      loopState
    );
    return true;
  }

  private async handleExecutionFailure(
    handle: RuntimeExecutionHandle,
    error: unknown
  ): Promise<void> {
    const finalizationFailure =
      error instanceof FinalizationFailure ? error : undefined;
    const runtimeError = normalizeError(error);
    const rootError =
      finalizationFailure?.rootCause ?? finalizationFailure?.finalizationError;

    handle.rememberError(projectError(rootError ?? runtimeError));
    const loopState: LoopState = {
      activeConfig: {
        ...handle.request.config,
        extensions: [],
      },
      activeDriverId: handle.request.driverId ?? this.options.defaultDriverId,
      activeToolRegistry: createToolRegistry(),
      carriedStateUpdates: [],
      enteredIterationLoop: false,
    };
    const failureResolution: RuntimeResolution = {
      error: rootError ?? runtimeError,
      fatality: "hard",
      type: "fail",
    };

    await this.failActiveRunIfNeeded(handle);

    if (finalizationFailure !== undefined) {
      this.projectFinalizationFailure(handle, loopState, finalizationFailure);
      return;
    }

    if ((await this.options.kernel.turn.get(handle.turnId)) !== null) {
      try {
        await this.finalizeTurnStatus(
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
        this.publishProjectedError(
          handle,
          failureResolution.error,
          true,
          loopState
        );
        this.publishProjectedError(
          handle,
          normalizeError(finalizeError),
          false,
          loopState
        );
        return;
      }
    }

    this.publishProjectedError(handle, runtimeError, true, loopState);
    handle.replaceStatus({
      activeAgent: handle.request.config.name,
      iterationCount: handle.status().iterationCount,
      manifest: handle.status().manifest,
      phase: "failed",
    });
    this.publishEvent(
      handle,
      {
        status: "failed",
        timestamp: this.now(),
        turnId: handle.turnId,
        type: "turn.end",
      },
      loopState
    );
  }

  private projectFinalizationFailure(
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
      this.publishProjectedError(
        handle,
        finalizationFailure.finalizationError,
        true,
        loopState
      );
      return;
    }

    this.publishProjectedError(
      handle,
      finalizationFailure.rootCause,
      true,
      loopState
    );
    this.publishProjectedError(
      handle,
      finalizationFailure.finalizationError,
      false,
      loopState
    );
  }

  private async completeExecution(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    partial: boolean,
    loopState: LoopState,
    enteredIterationLoop: boolean
  ): Promise<void> {
    if (enteredIterationLoop) {
      const headState = await this.loadHeadState(handle.request.branchId);
      const afterTurn = await runAfterTurnHooks({
        emit: (event) => {
          this.publishCustomEvent(handle, event, loopState);
        },
        extensions: loopState.activeConfig.extensions ?? [],
        iterationCount: handle.status().iterationCount,
        manifest: headState.manifest,
        messages: headState.messages,
        runId: this.createId(),
        turnId: handle.turnId,
      });

      if (afterTurn.resolution?.type === "fail") {
        this.publishProjectedError(
          handle,
          afterTurn.resolution.error,
          false,
          loopState
        );
      }
    }

    try {
      await this.finalizeTurnStatus(handle, resolution, partial, loopState);
    } catch (error: unknown) {
      throw new FinalizationFailure(
        normalizeError(error),
        resolution.type === "fail" && resolution.fatality === "hard"
          ? resolution.error
          : undefined
      );
    }

    if (resolution.type === "fail" && resolution.fatality === "hard") {
      this.publishProjectedError(handle, resolution.error, true, loopState);
    }

    const finalizedHeadState = await this.loadHeadState(
      handle.request.branchId
    );

    handle.replaceStatus({
      activeAgent: loopState.activeConfig.name,
      iterationCount: handle.status().iterationCount,
      manifest: finalizedHeadState.manifest,
      phase: resolutionToPhase(resolution),
    });
    this.publishEvent(
      handle,
      {
        status: resolutionToPhase(resolution),
        timestamp: this.now(),
        turnId: handle.turnId,
        type: "turn.end",
      },
      loopState
    );
  }

  private async runExecutionLoop(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<LoopOutcome> {
    let pendingResume =
      handle.resumedFrom?.pauseContext.kind === "driver_pause"
        ? handle.resumedFrom
        : undefined;

    while (true) {
      const nextIteration = handle.status().iterationCount + 1;
      loopState.enteredIterationLoop = true;

      const abortedOutcome = createCancelledLoopOutcome(handle);

      if (abortedOutcome !== undefined) {
        return abortedOutcome;
      }

      this.beginIteration(handle, loopState, nextIteration);
      await this.incorporateQueuedSteeringIfNeeded(
        handle,
        schemaId,
        loopState,
        pendingResume
      );

      const preparation = await this.prepareIterationState(
        handle,
        schemaId,
        loopState,
        nextIteration
      );

      if (preparation.resolution !== undefined) {
        this.publishIterationEnd(handle, loopState, nextIteration);
        return {
          resolution: preparation.resolution,
        };
      }

      const phaseResult = await this.executeIterationPhase(
        handle,
        schemaId,
        loopState,
        preparation.headState,
        nextIteration,
        pendingResume
      );
      pendingResume = undefined;

      if (phaseResult.kind === "outcome") {
        return phaseResult.outcome;
      }

      this.publishIterationEnd(handle, loopState, nextIteration);
      const cancelledAfterIteration = createCancelledLoopOutcome(
        handle,
        phaseResult.kind === "executed" ? phaseResult.result.partial : false
      );

      if (cancelledAfterIteration !== undefined) {
        return cancelledAfterIteration;
      }

      const nextOutcome = await this.resolveIterationOutcome(
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

  private beginIteration(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    iterationCount: number
  ): void {
    handle.updateStatus({
      activeAgent: loopState.activeConfig.name,
      approval: undefined,
      iterationCount,
      pauseReason: undefined,
      phase: "running",
    });
    this.publishEvent(
      handle,
      {
        iterationCount,
        timestamp: this.now(),
        type: "iteration.start",
      },
      loopState
    );
  }

  private publishIterationEnd(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    iterationCount: number
  ): void {
    this.publishEvent(
      handle,
      {
        iterationCount,
        timestamp: this.now(),
        type: "iteration.end",
      },
      loopState
    );
  }

  private async incorporateQueuedSteeringIfNeeded(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    pendingResume: ResumeContext | undefined
  ): Promise<void> {
    if (pendingResume !== undefined) {
      return;
    }

    const steeringSignal = handle.consumeSteeringSignal();

    if (steeringSignal !== undefined) {
      await this.incorporateSteering(
        handle,
        schemaId,
        steeringSignal,
        loopState
      );
    }
  }

  private async prepareIterationState(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    iterationCount: number
  ): Promise<IterationPreparationResult> {
    let headState = await this.loadHeadState(handle.request.branchId);
    handle.updateStatus({
      manifest: headState.manifest,
    });

    const beforeIteration = await runBeforeIterationHooks({
      emit: (event) => {
        this.publishCustomEvent(handle, event, loopState);
      },
      extensions: loopState.activeConfig.extensions ?? [],
      iterationCount,
      manifest: headState.manifest,
      messages: headState.messages,
      runId: this.createId(),
      turnId: handle.turnId,
    });
    loopState.carriedStateUpdates.push(...beforeIteration.updates);

    if (beforeIteration.resolution !== undefined) {
      if (
        beforeIteration.resolution.type === "fail" &&
        beforeIteration.resolution.fatality === "soft"
      ) {
        this.publishProjectedError(
          handle,
          beforeIteration.resolution.error,
          false,
          loopState
        );
      } else {
        await this.commitPendingExtensionStateUpdates(
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
      await this.applyContextEngineeringPlan(
        handle,
        schemaId,
        beforeIteration.cePlan,
        loopState,
        loopState.carriedStateUpdates
      );
      loopState.carriedStateUpdates = [];
      headState = await this.loadHeadState(handle.request.branchId);
    }

    const policyPlan = loopState.activeConfig.contextPolicy?.evaluate(
      headState.manifest,
      iterationCount
    );

    if (policyPlan !== undefined && isContextEngineeringPlan(policyPlan)) {
      await this.applyContextEngineeringPlan(
        handle,
        schemaId,
        policyPlan,
        loopState,
        loopState.carriedStateUpdates
      );
      loopState.carriedStateUpdates = [];
      headState = await this.loadHeadState(handle.request.branchId);
    }

    return {
      headState,
    };
  }

  private async executeIterationPhase(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState | undefined,
    iterationCount: number,
    pendingResume: ResumeContext | undefined
  ): Promise<IterationPhaseResult> {
    if (headState === undefined) {
      throw new KrakenRuntimeError("iteration execution requires head state", {
        code: "missing_head_state",
      });
    }

    const driver = handle.getOrCreateDriver(
      loopState.activeDriverId,
      (driverId) => this.materializeDriver(driverId)
    );
    const iterationRunId = this.createId();

    await this.createTrackedRun(
      handle,
      iterationRunId,
      handle.turnId,
      handle.request.branchId,
      schemaId,
      headState.branchHeadHash,
      [
        {
          deterministic: false,
          id: "iterate",
          sideEffects: true,
        },
      ]
    );
    await this.options.kernel.run.beginStep(iterationRunId, "iterate");

    const driverResult = await this.executeDriver(
      driver,
      this.createDriverExecutionContext(
        handle,
        schemaId,
        loopState,
        headState,
        iterationCount
      ),
      pendingResume
    );
    let resolution = driverResult.resolution;
    const driverMessages = [...(driverResult.messages ?? [])];
    const requestedToolCalls = extractToolCallsFromMessages(driverMessages);
    const cancellationResolution = createCancelledResolution(handle);
    const partial =
      driverResult.partial === true ||
      (cancellationResolution !== undefined &&
        hasAssistantOutputMessages(driverMessages));
    const invalidDriverResolutionError =
      cancellationResolution === undefined &&
      requestedToolCalls.length > 0 &&
      resolution.type !== "continue_iteration"
        ? new KrakenRuntimeError(
            "drivers must not return executable tool calls with a terminal resolution",
            {
              code: "invalid_driver_resolution",
              details: {
                resolutionType: resolution.type,
                toolCallCount: requestedToolCalls.length,
              },
            }
          )
        : undefined;

    if (invalidDriverResolutionError !== undefined) {
      await this.completeTrackedRun(handle, iterationRunId, "completed");
      return {
        kind: "outcome",
        outcome: {
          resolution: {
            error: invalidDriverResolutionError,
            fatality: "hard",
            type: "fail",
          },
        },
      };
    }

    const stagedMessages = [...driverMessages];
    const stagedMessageHashes = await this.stageDriverMessages(
      iterationRunId,
      driverMessages,
      iterationCount
    );
    const driverResponse = synthesizeResponse(driverMessages, resolution);
    const toolResults: ToolResultPart[] = [];

    if (cancellationResolution !== undefined) {
      resolution = cancellationResolution;
    }

    if (
      resolution.type === "continue_iteration" &&
      requestedToolCalls.length > 0
    ) {
      const toolBatch = await this.executeRequestedToolBatch(
        handle,
        loopState,
        headState,
        iterationCount,
        iterationRunId,
        requestedToolCalls
      );

      if ("outcome" in toolBatch) {
        return {
          kind: "outcome",
          outcome: toolBatch.outcome,
        };
      }

      toolResults.push(...toolBatch.results);
      stagedMessageHashes.push(...toolBatch.resultHashes);
      loopState.carriedStateUpdates.push(...toolBatch.updates);

      for (const result of toolBatch.results) {
        stagedMessages.push({
          parts: [result],
          role: "tool",
        });
      }

      if (toolBatch.approval !== undefined) {
        resolution = {
          approval: toolBatch.approval,
          reason: "approval_required",
          type: "pause",
        };
      }
    }

    resolution = createCancelledResolution(handle) ?? resolution;

    const manifest = updateContextManifest(
      headState.manifest,
      stagedMessages,
      [...loopState.carriedStateUpdates],
      []
    );
    loopState.carriedStateUpdates = [];
    const turnNodeHash = await this.completeIterationArtifacts(
      handle,
      schemaId,
      loopState,
      headState,
      iterationCount,
      iterationRunId,
      resolution,
      manifest,
      stagedMessageHashes
    );
    handle.updateStatus({
      activeAgent: loopState.activeConfig.name,
      manifest,
    });
    resolution = await this.applyAfterIterationResolution(
      handle,
      loopState,
      iterationCount,
      iterationRunId,
      resolution,
      driverResponse,
      toolResults,
      headState.messages,
      stagedMessages,
      manifest
    );
    resolution = createCancelledResolution(handle) ?? resolution;

    return {
      kind: "executed",
      result: {
        driverResponse,
        iterationRunId,
        partial,
        requestedToolCalls,
        resolution,
        toolResults,
        turnNodeHash,
      },
    };
  }

  private createDriverExecutionContext(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState,
    iterationCount: number
  ): DriverExecutionContext {
    const toolRegistrySnapshot = createReadonlyDriverToolRegistry(
      loopState.activeToolRegistry
    );

    return {
      branchId: handle.request.branchId,
      config: createFrozenSnapshot(loopState.activeConfig),
      handoff: {
        createContextPlan: (input) =>
          this.createDriverHandoffContextPlan(input, headState, loopState),
      },
      iterationCount,
      manifest: createFrozenSnapshot(headState.manifest),
      messages: createFrozenSnapshot(headState.messages),
      runtime: {
        emit: (event) => {
          this.publishEvent(handle, event, loopState);
        },
        now: () => this.now(),
      },
      schemaId,
      signal: handle.abortSignal,
      threadId: handle.request.threadId,
      toolRegistry: toolRegistrySnapshot,
      turnId: handle.turnId,
    };
  }

  private async stageDriverMessages(
    runId: string,
    messages: KrakenMessage[],
    iterationCount: number
  ): Promise<HashString[]> {
    const stagedMessageHashes: HashString[] = [];

    for (const [index, driverMessage] of messages.entries()) {
      assertKrakenMessage(driverMessage, `driverResult.messages[${index}]`);
      stagedMessageHashes.push(
        await this.stageMessage(
          runId,
          driverMessage,
          `message_${iterationCount}_${index}`
        )
      );
    }

    return stagedMessageHashes;
  }

  private async executeRequestedToolBatch(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    headState: HeadState,
    iterationCount: number,
    runId: string,
    requestedToolCalls: ToolCallPart[]
  ): Promise<ToolBatchOutcome | { outcome: LoopOutcome }> {
    try {
      return await executeToolBatch(
        requestedToolCalls,
        this.createToolBatchEnvironment(
          handle,
          loopState,
          headState.manifest,
          iterationCount,
          runId
        )
      );
    } catch (error: unknown) {
      await this.failTrackedRunWithoutBranchAdvance(
        handle,
        runId,
        headState.branchHeadHash
      );
      return {
        outcome: {
          resolution: {
            error: normalizeError(error),
            fatality: "hard",
            type: "fail",
          },
        },
      };
    }
  }

  private async completeIterationArtifacts(
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
    const manifestHash = await this.stageManifest(runId, manifest);
    const runtimeStatusHash =
      resolution.type === "pause"
        ? await this.stageRuntimeStatus(
            runId,
            {
              activeAgent: loopState.activeConfig.name,
              pauseReason: resolution.reason,
              state: "paused",
            },
            "runtime_status"
          )
        : undefined;
    const nextTreeHash =
      resolution.type === "fail" && resolution.fatality === "hard"
        ? undefined
        : await this.createIterationTree(
            schemaId,
            headState.turnNode.turnTreeHash,
            headState.messageHashes,
            appendedMessageHashes,
            manifestHash,
            runtimeStatusHash
          );

    return await this.completeIterationRun(
      handle,
      runId,
      resolution,
      manifest,
      iterationCount,
      loopState,
      nextTreeHash
    );
  }

  private async applyAfterIterationResolution(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    iterationCount: number,
    runId: string,
    resolution: RuntimeResolution,
    response: KrakenModelResponse,
    toolResults: ToolResultPart[],
    headMessages: KrakenMessage[],
    stagedMessages: KrakenMessage[],
    manifest: ContextManifest
  ): Promise<RuntimeResolution> {
    const afterIteration = await runAfterIterationHooks({
      emit: (event) => {
        this.publishCustomEvent(handle, event, loopState);
      },
      extensions: loopState.activeConfig.extensions ?? [],
      iterationCount,
      manifest,
      messages: [...headMessages, ...stagedMessages],
      resolution,
      response,
      runId,
      toolResults,
      turnId: handle.turnId,
    });
    let nextResolution = composeResolutions(
      resolution,
      afterIteration.resolution
    );
    loopState.carriedStateUpdates.push(...afterIteration.updates);

    if (nextResolution.type === "fail" && nextResolution.fatality === "soft") {
      this.publishProjectedError(
        handle,
        nextResolution.error,
        false,
        loopState
      );
    }

    if (
      loopState.activeConfig.maxIterations !== undefined &&
      iterationCount >= loopState.activeConfig.maxIterations &&
      nextResolution.type === "continue_iteration"
    ) {
      nextResolution = {
        reason: "max_iterations",
        type: "end_turn",
      };
    }

    return nextResolution;
  }

  private async resolveIterationOutcome(
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
        throw new KrakenRuntimeError(
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
          kind:
            result.requestedToolCalls.length > 0
              ? "tool_approval"
              : "driver_pause",
          pauseReason: result.resolution.reason,
          pausedIteration:
            result.requestedToolCalls.length > 0
              ? {
                  iterationCount,
                  response: result.driverResponse,
                  toolResults: result.toolResults,
                }
              : undefined,
          pausedRunId: result.iterationRunId,
          pausedTurnNodeHash: result.turnNodeHash,
        },
        resolution: result.resolution,
      };
    }

    if (
      await this.applyTerminalAgentTransitionIfNeeded(
        handle,
        schemaId,
        result.resolution,
        loopState
      )
    ) {
      return "continue";
    }

    return {
      partial: result.partial,
      resolution: result.resolution,
    };
  }

  private async resumePausedToolExecution(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    resumeContext: ResumeContext
  ): Promise<LoopOutcome> {
    const pausedIteration = resumeContext.pauseContext.pausedIteration;

    if (pausedIteration === undefined) {
      throw new KrakenRuntimeError(
        "tool approval resumes require paused iteration state",
        {
          code: "missing_paused_iteration_state",
        }
      );
    }

    loopState.enteredIterationLoop = true;
    const headState = await this.loadHeadState(handle.request.branchId);
    const runId = this.createId();

    await this.createTrackedRun(
      handle,
      runId,
      handle.turnId,
      handle.request.branchId,
      schemaId,
      headState.branchHeadHash,
      [
        {
          deterministic: false,
          id: "iterate",
          sideEffects: true,
        },
      ]
    );
    await this.options.kernel.run.beginStep(runId, "iterate");

    let toolBatch: ToolBatchOutcome;

    try {
      toolBatch = await resumeToolBatch(
        resumeContext.pauseContext.approval,
        resumeContext.approval,
        this.createToolBatchEnvironment(
          handle,
          loopState,
          headState.manifest,
          pausedIteration.iterationCount,
          runId
        )
      );
    } catch (error: unknown) {
      await this.failTrackedRunWithoutBranchAdvance(
        handle,
        runId,
        headState.branchHeadHash
      );
      return {
        resolution: {
          error: normalizeError(error),
          fatality: "hard",
          type: "fail",
        },
      };
    }
    const resumedMessages = toolBatch.results.map((result) => ({
      parts: [result],
      role: "tool",
    })) satisfies KrakenMessage[];
    const manifest = updateContextManifest(
      headState.manifest,
      resumedMessages,
      toolBatch.updates,
      []
    );
    const manifestHash = await this.stageManifest(runId, manifest);

    let resolution: RuntimeResolution =
      toolBatch.approval === undefined
        ? { type: "continue_iteration" }
        : {
            approval: toolBatch.approval,
            reason: "approval_required",
            type: "pause",
          };

    const runtimeStatusHash =
      resolution.type === "pause"
        ? await this.stageRuntimeStatus(
            runId,
            {
              activeAgent: loopState.activeConfig.name,
              pauseReason: resolution.reason,
              state: "paused",
            },
            "runtime_status_paused"
          )
        : undefined;
    const nextTreeHash = await this.createIterationTree(
      schemaId,
      headState.turnNode.turnTreeHash,
      headState.messageHashes,
      toolBatch.resultHashes,
      manifestHash,
      runtimeStatusHash
    );

    const turnNodeHash = await this.completeIterationRun(
      handle,
      runId,
      resolution,
      manifest,
      pausedIteration.iterationCount,
      loopState,
      nextTreeHash
    );

    handle.updateStatus({
      activeAgent: loopState.activeConfig.name,
      iterationCount: pausedIteration.iterationCount,
      manifest,
    });

    if (resolution.type === "pause") {
      const latestHeadState = await this.loadHeadState(handle.request.branchId);
      const afterIteration = await runAfterIterationHooks({
        emit: (event) => {
          this.publishCustomEvent(handle, event, loopState);
        },
        extensions: loopState.activeConfig.extensions ?? [],
        iterationCount: pausedIteration.iterationCount,
        manifest: latestHeadState.manifest,
        messages: latestHeadState.messages,
        resolution,
        response: pausedIteration.response,
        runId,
        toolResults: [...pausedIteration.toolResults, ...toolBatch.results],
        turnId: handle.turnId,
      });
      resolution = composeResolutions(resolution, afterIteration.resolution);
      loopState.carriedStateUpdates.push(...afterIteration.updates);
      handle.updateStatus({
        manifest: latestHeadState.manifest,
      });

      if (resolution.type !== "pause") {
        if (resolution.type === "fail" && resolution.fatality === "soft") {
          this.publishProjectedError(
            handle,
            resolution.error,
            false,
            loopState
          );
        }

        return {
          resolution,
        };
      }

      if (turnNodeHash === undefined) {
        throw new KrakenRuntimeError(
          "paused approval resumes must commit a durable pause checkpoint",
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
          approval: resolution.approval,
          carriedStateUpdates: [...loopState.carriedStateUpdates],
          kind: "tool_approval",
          pauseReason: resolution.reason,
          pausedIteration: {
            iterationCount: pausedIteration.iterationCount,
            response: pausedIteration.response,
            toolResults: [...pausedIteration.toolResults, ...toolBatch.results],
          },
          pausedRunId: runId,
          pausedTurnNodeHash: turnNodeHash,
        },
        resolution,
      };
    }

    const latestHeadState = await this.loadHeadState(handle.request.branchId);
    const afterIteration = await runAfterIterationHooks({
      emit: (event) => {
        this.publishCustomEvent(handle, event, loopState);
      },
      extensions: loopState.activeConfig.extensions ?? [],
      iterationCount: pausedIteration.iterationCount,
      manifest: latestHeadState.manifest,
      messages: latestHeadState.messages,
      resolution,
      response: pausedIteration.response,
      runId,
      toolResults: [...pausedIteration.toolResults, ...toolBatch.results],
      turnId: handle.turnId,
    });
    resolution = composeResolutions(resolution, afterIteration.resolution);
    loopState.carriedStateUpdates.push(...afterIteration.updates);
    handle.updateStatus({
      manifest: latestHeadState.manifest,
    });

    return {
      resolution,
    };
  }

  private createToolBatchEnvironment(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    manifest: ContextManifest,
    iterationCount: number,
    runId: string
  ): ToolBatchEnvironment {
    return {
      activeAgent: loopState.activeConfig.name,
      branchId: handle.request.branchId,
      extensions: loopState.activeConfig.extensions ?? [],
      iterationCount,
      manifest,
      now: () => this.now(),
      publishCustom: (event) => {
        this.publishCustomEvent(handle, event, loopState);
      },
      publishEvent: (event) => {
        this.publishEvent(handle, event, loopState);
      },
      reportSoftError: (error) => {
        this.publishProjectedError(handle, error, false, loopState);
      },
      runId,
      signal: handle.abortSignal,
      stageResult: async (result, orderIndex) => {
        return await this.stageMessage(
          runId,
          {
            parts: [result],
            role: "tool",
          },
          formatToolResultTaskId(orderIndex, result.callId)
        );
      },
      threadId: handle.request.threadId,
      toolRegistry: loopState.activeToolRegistry,
      turnId: handle.turnId,
    };
  }

  private createDriverHandoffContextPlan(
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
    const mode = input.mode ?? "preserve_trace";
    const builder =
      input.builder ?? this.resolveDefaultHandoffContextBuilder(mode);
    const helperBundle = this.createContextEngineeringHelpers(
      headState.messageHashes,
      headState.messages
    );
    const resolvedTargetAgent = this.options.resolveAgentConfig?.(
      input.targetAgent
    ) ?? {
      name: input.targetAgent,
    };

    return {
      builder,
      mode,
      reason: input.reason,
      sourceContext: {
        handoffIntent: {
          payload: cloneValue(input.payload),
          reason: input.reason,
          targetAgent: input.targetAgent,
        },
        helpers: helperBundle.helpers,
        manifest: cloneValue(headState.manifest),
        messages: cloneValue(headState.messages),
        sourceAgent: {
          name: loopState.activeConfig.name,
        },
        targetAgent: {
          name: resolvedTargetAgent.name,
        },
      },
      targetAgent: input.targetAgent,
    };
  }

  private async executeDriver(
    driver: KrakenDriver,
    context: DriverExecutionContext,
    resumeContext: ResumeContext | undefined
  ) {
    try {
      const result =
        resumeContext === undefined
          ? await driver.execute(context)
          : await driver.resume({
              ...context,
              approval: resumeContext.approval,
              resumedFrom: resumeContext.pausedTurnNodeHash,
            } satisfies DriverResumeContext);
      assertDriverExecutionResult(result, "driverResult");
      return result;
    } catch (error: unknown) {
      return {
        resolution: {
          error: normalizeError(error),
          fatality: "hard",
          type: "fail",
        } satisfies RuntimeResolution,
      };
    }
  }

  private async completeIterationRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    resolution: RuntimeResolution,
    manifest: ContextManifest,
    iterationCount: number,
    loopState: LoopState,
    treeHash?: HashString
  ): Promise<HashString | undefined> {
    let turnNodeHash: HashString | undefined;

    if (resolution.type === "fail" && resolution.fatality === "hard") {
      const completion = await this.completeTrackedRun(
        handle,
        runId,
        "failed",
        {
          fatality: resolution.fatality,
          message: resolution.error.message,
          turnId: handle.turnId,
          type: "iteration_failed",
        }
      );
      turnNodeHash = completion.turnNodeHash;
    } else {
      const stepEventHash = await this.storeEventRecord({
        iteration: iterationCount,
        turnId: handle.turnId,
        type: "iteration_step_completed",
      });
      const stepResult = await this.options.kernel.run.completeStep(
        runId,
        "iterate",
        stepEventHash,
        undefined,
        treeHash
      );
      const completion = await this.completeTrackedRun(
        handle,
        runId,
        resolution.type === "pause" ? "paused" : "completed",
        resolution.type === "pause"
          ? {
              reason: resolution.reason,
              turnId: handle.turnId,
              type: "paused",
            }
          : {
              iteration: iterationCount,
              turnId: handle.turnId,
              type: "iteration_completed",
            }
      );
      turnNodeHash = stepResult.turnNodeHash ?? completion.turnNodeHash;
    }

    if (turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(handle.turnId, turnNodeHash);
      await this.emitStateObservability(
        handle,
        loopState,
        turnNodeHash,
        iterationCount,
        manifest
      );
    }

    return turnNodeHash;
  }

  private async createIterationTree(
    schemaId: string,
    baseTurnTreeHash: HashString,
    baseMessageHashes: HashString[],
    appendedMessageHashes: HashString[],
    manifestHash: HashString,
    runtimeStatusHash?: HashString
  ): Promise<HashString> {
    const changes: Record<string, PathValue> = {
      "context.manifest": manifestHash,
      messages: [...baseMessageHashes, ...appendedMessageHashes],
    };

    if (runtimeStatusHash !== undefined) {
      changes["runtime.status"] = runtimeStatusHash;
    }

    return await this.options.kernel.tree.create(
      schemaId,
      changes,
      baseTurnTreeHash
    );
  }

  private resolveDefaultHandoffContextBuilder(
    mode: string
  ): HandoffContextBuilder {
    if (this.options.handoffContextBuilder !== undefined) {
      return this.options.handoffContextBuilder;
    }

    switch (mode) {
      case "last_output_only":
        return createLastOutputOnlyHandoffContextBuilder();
      case "preserve_trace":
        return createPreserveTraceHandoffContextBuilder();
      default:
        throw new KrakenRuntimeError(
          `handoff mode "${mode}" requires an explicit builder`,
          {
            code: "invalid_handoff_mode",
            details: {
              mode,
            },
          }
        );
    }
  }

  private async incorporateInput(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<void> {
    const runId = this.createId();
    const headState = await this.loadHeadState(handle.request.branchId);
    const userMessage: KrakenMessage = {
      parts: handle.request.signal.parts,
      role: "user",
    };
    const manifest = updateContextManifest(
      headState.manifest,
      [userMessage],
      collectInitialExtensionStateUpdates(
        loopState.activeConfig.extensions ?? [],
        headState.manifest
      ),
      [0]
    );

    await this.createTrackedRun(
      handle,
      runId,
      handle.turnId,
      handle.request.branchId,
      schemaId,
      headState.branchHeadHash,
      [
        {
          deterministic: false,
          id: "incorporate_input",
          sideEffects: false,
        },
      ]
    );
    await this.options.kernel.run.beginStep(runId, "incorporate_input");
    await this.stageMessage(runId, userMessage, "input_message");
    await this.stageManifest(runId, manifest);
    await this.stageTurnLineage(runId, handle.turnId, "turn_lineage");
    await this.stageRuntimeStatus(
      runId,
      {
        activeAgent: loopState.activeConfig.name,
        state: "running",
      },
      "runtime_status"
    );
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "incorporate_input",
      await this.storeEventRecord({
        turnId: handle.turnId,
        type: "input_received",
      })
    );
    await this.completeTrackedRun(handle, runId, "completed");

    if (stepResult.turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(
        handle.turnId,
        stepResult.turnNodeHash
      );
      await this.emitStateObservability(
        handle,
        loopState,
        stepResult.turnNodeHash,
        0,
        manifest
      );
    }
  }

  private async incorporateSteering(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    signal: InputSignal,
    loopState: LoopState
  ): Promise<void> {
    const runId = this.createId();
    const headState = await this.loadHeadState(handle.request.branchId);
    const steeringMessage: KrakenMessage = {
      parts: signal.parts,
      role: "user",
    };
    // Steering appends user-role content inside the current semantic turn, so it
    // must not mint a new turn boundary in the manifest.
    const manifest = updateContextManifest(
      headState.manifest,
      [steeringMessage],
      [],
      []
    );

    await this.createTrackedRun(
      handle,
      runId,
      handle.turnId,
      handle.request.branchId,
      schemaId,
      headState.branchHeadHash,
      [
        {
          deterministic: false,
          id: "incorporate_steering",
          sideEffects: false,
        },
      ]
    );
    await this.options.kernel.run.beginStep(runId, "incorporate_steering");
    const steeringMessageHash = await this.stageMessage(
      runId,
      steeringMessage,
      "steering_message"
    );
    await this.stageManifest(runId, manifest);
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "incorporate_steering",
      await this.storeEventRecord({
        messageId: steeringMessageHash,
        turnId: handle.turnId,
        type: "steering_incorporated",
      })
    );
    await this.completeTrackedRun(handle, runId, "completed");

    if (stepResult.turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(
        handle.turnId,
        stepResult.turnNodeHash
      );
      await this.emitStateObservability(
        handle,
        loopState,
        stepResult.turnNodeHash,
        handle.status().iterationCount,
        manifest
      );
    }

    handle.updateStatus({
      manifest,
    });
    this.publishEvent(
      handle,
      {
        messageId: steeringMessageHash,
        timestamp: this.now(),
        type: "steering.incorporated",
      },
      loopState
    );
  }

  private async commitPendingExtensionStateUpdates(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    updates: ExtensionStateUpdate[],
    iterationCount: number
  ): Promise<void> {
    if (updates.length === 0) {
      return;
    }

    const headState = await this.loadHeadState(handle.request.branchId);
    const manifest = updateContextManifest(headState.manifest, [], updates);
    const runId = this.createId();

    await this.createTrackedRun(
      handle,
      runId,
      handle.turnId,
      handle.request.branchId,
      schemaId,
      headState.branchHeadHash,
      [
        {
          deterministic: false,
          id: "commit_extension_state",
          sideEffects: false,
        },
      ]
    );
    await this.options.kernel.run.beginStep(runId, "commit_extension_state");
    await this.stageManifest(runId, manifest);
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "commit_extension_state",
      await this.storeEventRecord({
        turnId: handle.turnId,
        type: "extension_state_committed",
      })
    );
    await this.completeTrackedRun(handle, runId, "completed");

    if (stepResult.turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(
        handle.turnId,
        stepResult.turnNodeHash
      );
      await this.emitStateObservability(
        handle,
        loopState,
        stepResult.turnNodeHash,
        iterationCount,
        manifest
      );
    }

    handle.updateStatus({
      manifest,
    });
  }

  private async applyContextEngineeringPlan(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    plan: ContextEngineeringPlan,
    loopState: LoopState,
    updates: ExtensionStateUpdate[]
  ): Promise<void> {
    const runId = this.createId();
    const headState = await this.loadHeadState(handle.request.branchId);
    const helperBundle = this.createContextEngineeringHelpers(
      headState.messageHashes,
      headState.messages
    );
    const context: ContextEngineeringContext = {
      helpers: helperBundle.helpers,
      manifest: headState.manifest,
      messageHashes: headState.messageHashes,
      messages: headState.messages,
    };
    const nextMessageHashes = plan.execute(context);
    await helperBundle.flush();
    const resolvedMessageHashes = helperBundle.resolveHashes(nextMessageHashes);
    const nextMessages = this.materializeContextMessages(
      resolvedMessageHashes,
      helperBundle.helpers
    );
    // Full CE rewrites rebuild a fresh visible history. Keep normal boundary
    // inference here; forcing preserved-boundary-only remaps can make rewritten
    // manifests structurally invalid when the plan materializes new user messages.
    const nextManifest = updateContextManifest(
      createContextManifest(nextMessages, headState.manifest.extensions),
      [],
      updates
    );
    const nextManifestHash = await this.storeKernelRecord(
      nextManifest,
      "manifest"
    );
    const nextTreeHash = await this.options.kernel.tree.create(
      schemaId,
      {
        "context.manifest": nextManifestHash,
        messages: resolvedMessageHashes,
      },
      headState.turnNode.turnTreeHash
    );

    await this.createTrackedRun(
      handle,
      runId,
      handle.turnId,
      handle.request.branchId,
      schemaId,
      headState.branchHeadHash,
      [
        {
          deterministic: false,
          id: "context_engineering",
          sideEffects: false,
        },
      ]
    );
    await this.options.kernel.run.beginStep(runId, "context_engineering");
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "context_engineering",
      await this.storeEventRecord({
        action: plan.action,
        turnId: handle.turnId,
        type: "context_engineering_applied",
      }),
      undefined,
      nextTreeHash
    );
    await this.completeTrackedRun(handle, runId, "completed");
    if (stepResult.turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(
        handle.turnId,
        stepResult.turnNodeHash
      );
      await this.emitStateObservability(
        handle,
        loopState,
        stepResult.turnNodeHash,
        handle.status().iterationCount,
        nextManifest
      );
    }
    handle.updateStatus({
      manifest: nextManifest,
    });
  }

  private async applyHandoff(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    plan: HandoffContextPlan,
    loopState: LoopState,
    updates: ExtensionStateUpdate[]
  ): Promise<{
    activeConfig: AgentConfig;
    activeToolRegistry: ToolRegistry;
  }> {
    const targetConfig = this.options.resolveAgentConfig?.(plan.targetAgent);

    if (targetConfig === undefined) {
      throw new KrakenRuntimeError(
        `handoff target "${plan.targetAgent}" could not be resolved`,
        {
          code: "unknown_handoff_target",
          details: {
            targetAgent: plan.targetAgent,
          },
        }
      );
    }

    const headState = await this.loadHeadState(handle.request.branchId);
    const helperBundle = this.createContextEngineeringHelpers(
      headState.messageHashes,
      headState.messages
    );
    const normalizedPlan = {
      ...plan,
      sourceContext: {
        ...plan.sourceContext,
        helpers: helperBundle.helpers,
        manifest: headState.manifest,
        messages: headState.messages,
        sourceAgent: loopState.activeConfig,
        targetAgent: targetConfig,
      } satisfies HandoffSourceContext,
      targetAgent: targetConfig.name,
    } satisfies HandoffContextPlan;

    this.publishCustomEvent(
      handle,
      {
        data: {
          from: loopState.activeConfig.name,
          reason: normalizedPlan.reason,
          to: targetConfig.name,
        },
        name: "handoff.start",
      },
      loopState
    );

    const nextMessageHashes = normalizedPlan.builder(
      normalizedPlan.sourceContext
    );
    await helperBundle.flush();
    const resolvedMessageHashes = helperBundle.resolveHashes(nextMessageHashes);
    const nextMessages = this.materializeContextMessages(
      resolvedMessageHashes,
      helperBundle.helpers
    );
    // Handoff rewrites also rebuild a fresh visible history for the receiving
    // agent. Preserve the standard manifest boundary rules instead of carrying
    // over only source-hash turn starts, which can invalidate single-message
    // handoff contexts.
    const baseManifest = createContextManifest(
      nextMessages,
      headState.manifest.extensions
    );
    const initialTargetUpdates = collectInitialExtensionStateUpdates(
      targetConfig.extensions ?? [],
      baseManifest
    );
    const nextManifest = updateContextManifest(
      baseManifest,
      [],
      [...initialTargetUpdates, ...updates]
    );
    const manifestHash = await this.storeKernelRecord(
      nextManifest,
      "handoff_manifest"
    );
    const statusHash = await this.storeKernelRecord(
      {
        activeAgent: targetConfig.name,
        state: "running",
      },
      "handoff_runtime_status"
    );
    const nextTreeHash = await this.options.kernel.tree.create(
      schemaId,
      {
        "context.manifest": manifestHash,
        "runtime.status": statusHash,
        messages: resolvedMessageHashes,
      },
      headState.turnNode.turnTreeHash
    );
    const runId = this.createId();
    await this.createTrackedRun(
      handle,
      runId,
      handle.turnId,
      handle.request.branchId,
      schemaId,
      headState.branchHeadHash,
      [
        {
          deterministic: false,
          id: "handoff_context",
          sideEffects: false,
        },
      ]
    );
    await this.options.kernel.run.beginStep(runId, "handoff_context");
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "handoff_context",
      await this.storeEventRecord({
        targetAgent: targetConfig.name,
        turnId: handle.turnId,
        type: "handoff_applied",
      }),
      undefined,
      nextTreeHash
    );
    await this.completeTrackedRun(handle, runId, "completed");

    if (stepResult.turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(
        handle.turnId,
        stepResult.turnNodeHash
      );
      await this.emitStateObservability(
        handle,
        {
          ...loopState,
          activeConfig: targetConfig,
        },
        stepResult.turnNodeHash,
        handle.status().iterationCount,
        nextManifest
      );
    }

    handle.updateStatus({
      activeAgent: targetConfig.name,
      manifest: nextManifest,
    });
    this.publishCustomEvent(
      handle,
      {
        data: {
          agent: targetConfig.name,
        },
        name: "agent.start",
      },
      {
        ...loopState,
        activeConfig: targetConfig,
      }
    );

    return {
      activeConfig: targetConfig,
      activeToolRegistry: createActiveToolRegistry(undefined, targetConfig),
    };
  }

  private createContextEngineeringHelpers(
    messageHashes: HashString[],
    messages: KrakenMessage[]
  ): HelperBundle {
    const kernel = this.options.kernel;
    const existingMessages = new Map<HashString, KrakenMessage>();
    const pendingMessages = new Map<HashString, KrakenMessage>();
    const pendingRecords = new Map<
      HashString,
      { message: KrakenMessage; record: Uint8Array }
    >();
    const resolvedHashes = new Map<HashString, HashString>();

    for (let index = 0; index < messageHashes.length; index += 1) {
      existingMessages.set(messageHashes[index], cloneValue(messages[index]));
    }

    return {
      async flush() {
        for (const [provisionalHash, pendingRecord] of pendingRecords) {
          const canonicalHash = await kernel.store.put(pendingRecord.record);
          resolvedHashes.set(provisionalHash, canonicalHash);
          pendingMessages.set(canonicalHash, cloneValue(pendingRecord.message));
        }
      },
      helpers: {
        loadMessage(hash) {
          const resolvedHash = resolvedHashes.get(hash) ?? hash;
          const message =
            pendingMessages.get(resolvedHash) ??
            pendingMessages.get(hash) ??
            existingMessages.get(resolvedHash) ??
            existingMessages.get(hash) ??
            null;

          if (message === null) {
            return null;
          }

          assertKrakenMessage(message, `message "${hash}"`);
          return cloneValue(message);
        },
        storeMessage(message) {
          assertKrakenMessage(message, "context engineering helper message");
          const encoded = encodeKernelRecord(message, "message");
          const storedMessage = cloneValue(message);
          const provisionalHash = createPendingKernelHash(encoded);
          pendingMessages.set(provisionalHash, storedMessage);
          pendingRecords.set(provisionalHash, {
            message: storedMessage,
            record: encoded,
          });
          return provisionalHash;
        },
        storeMessages(messagesToStore) {
          return messagesToStore.map((message) => {
            assertKrakenMessage(message, "context engineering helper message");
            const encoded = encodeKernelRecord(message, "message");
            const storedMessage = cloneValue(message);
            const provisionalHash = createPendingKernelHash(encoded);
            pendingMessages.set(provisionalHash, storedMessage);
            pendingRecords.set(provisionalHash, {
              message: storedMessage,
              record: encoded,
            });
            return provisionalHash;
          });
        },
      },
      resolveHashes(hashes) {
        return hashes.map((hash) => resolvedHashes.get(hash) ?? hash);
      },
    };
  }

  private materializeContextMessages(
    hashes: HashString[],
    helpers: ContextEngineeringHelpers
  ): KrakenMessage[] {
    const messages: KrakenMessage[] = [];

    for (const hash of hashes) {
      const message = helpers.loadMessage(hash);

      if (message === null) {
        throw new KrakenLineageError(`message "${hash}" does not exist`, {
          code: "missing_message",
          details: {
            hash,
          },
        });
      }

      messages.push(message);
    }

    return messages;
  }

  private async finalizeTurnStatus(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    partial: boolean,
    loopState: LoopState
  ): Promise<void> {
    const phase = resolutionToPhase(resolution);
    const headState = await this.loadHeadState(handle.request.branchId);
    const runId = this.createId();
    await this.createTrackedRun(
      handle,
      runId,
      handle.turnId,
      handle.request.branchId,
      handle.schemaId,
      headState.branchHeadHash,
      [
        {
          deterministic: false,
          id: "finalize_turn_status",
          sideEffects: false,
        },
      ]
    );
    await this.options.kernel.run.beginStep(runId, "finalize_turn_status");
    await this.stageRuntimeStatus(
      runId,
      {
        activeAgent: loopState.activeConfig.name,
        partial: phase === "failed" && partial ? true : undefined,
        state: phase,
      },
      "runtime_status_final"
    );
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "finalize_turn_status",
      await this.storeEventRecord({
        status: phase,
        turnId: handle.turnId,
        type: "turn_status_finalized",
      })
    );
    await this.completeTrackedRun(handle, runId, "completed");

    if (stepResult.turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(
        handle.turnId,
        stepResult.turnNodeHash
      );
      await this.emitStateObservability(
        handle,
        loopState,
        stepResult.turnNodeHash,
        handle.status().iterationCount
      );
    }
  }

  private async finalizePausedCancellation(
    handle: RuntimeExecutionHandle,
    pauseContext: PauseContext,
    error: Error
  ): Promise<void> {
    const loopState: LoopState = {
      activeConfig: pauseContext.activeConfig,
      activeDriverId: pauseContext.activeDriverId,
      activeToolRegistry: pauseContext.activeToolRegistry,
      carriedStateUpdates: [...pauseContext.carriedStateUpdates],
      enteredIterationLoop: true,
    };
    const failureResolution: RuntimeResolution = {
      error,
      fatality: "hard",
      type: "fail",
    };

    handle.rememberError(projectError(error));
    await this.options.kernel.run.complete(pauseContext.pausedRunId, "failed");

    if (loopState.carriedStateUpdates.length > 0) {
      await this.commitPendingExtensionStateUpdates(
        handle,
        handle.schemaId,
        loopState,
        loopState.carriedStateUpdates,
        handle.status().iterationCount
      );
      loopState.carriedStateUpdates = [];
    }

    await this.finalizeTurnStatus(handle, failureResolution, false, loopState);
    handle.replaceStatus({
      activeAgent: pauseContext.activeConfig.name,
      iterationCount: handle.status().iterationCount,
      manifest: handle.status().manifest,
      phase: "failed",
    });
  }

  private async loadHeadState(branchId: string): Promise<HeadState> {
    const branch = await this.options.kernel.branch.get(branchId);

    if (branch === null) {
      throw new KrakenLineageError(`branch "${branchId}" does not exist`, {
        code: "missing_branch",
      });
    }

    const turnNode = await this.options.kernel.node.get(
      branch.headTurnNodeHash
    );

    if (turnNode === null) {
      throw new KrakenLineageError(
        `turn node "${branch.headTurnNodeHash}" does not exist`,
        {
          code: "missing_turn_node",
        }
      );
    }

    const messageHashes = toOrderedHashArray(
      await this.options.kernel.tree.resolve(turnNode.turnTreeHash, "messages")
    );
    const manifestHash = toOptionalHash(
      await this.options.kernel.tree.resolve(
        turnNode.turnTreeHash,
        "context.manifest"
      )
    );
    const manifest =
      manifestHash === null
        ? createEmptyContextManifest()
        : await this.readManifest(manifestHash);

    return {
      branchHeadHash: branch.headTurnNodeHash,
      manifest,
      messageHashes,
      messages: await this.readMessages(messageHashes),
      turnNode,
    };
  }

  private async readManifest(hash: HashString): Promise<ContextManifest> {
    const payload = await this.options.kernel.store.get(hash);

    if (payload === null) {
      throw new KrakenLineageError(`manifest "${hash}" does not exist`, {
        code: "missing_manifest",
        details: {
          hash,
        },
      });
    }

    const manifest = decodeDeterministicKernelRecord(payload);
    assertContextManifest(manifest, `manifest "${hash}"`);
    return manifest;
  }

  private async readMessages(hashes: HashString[]): Promise<KrakenMessage[]> {
    const messages: KrakenMessage[] = [];

    for (const hash of hashes) {
      messages.push(await this.readMessage(hash));
    }

    return messages;
  }

  private async readMessage(hash: HashString): Promise<KrakenMessage> {
    const payload = await this.options.kernel.store.get(hash);

    if (payload === null) {
      throw new KrakenLineageError(`message "${hash}" does not exist`, {
        code: "missing_message",
        details: {
          hash,
        },
      });
    }

    return decodeKrakenMessageRecord(payload, `message "${hash}"`);
  }

  private async resolveExecutionSchemaId(
    request: ExecutionSessionRequest
  ): Promise<string> {
    if (request.schemaId !== undefined) {
      return await this.ensureSchemaId(request.schemaId);
    }

    const thread = await this.options.kernel.thread.get(request.threadId);
    return await this.ensureSchemaId(thread?.schemaId);
  }

  private async resolveParentTurnId(
    threadId: string,
    branchId: string,
    explicitParentTurnId?: string | null
  ): Promise<string | null> {
    const resolvedParentTurnId =
      explicitParentTurnId === undefined
        ? await this.options.resolveParentTurnId?.(threadId, branchId)
        : explicitParentTurnId;

    const parentTurnId =
      resolvedParentTurnId === undefined
        ? await readBranchActiveTurnId(this.options.kernel, branchId)
        : resolvedParentTurnId;
    await this.assertValidParentTurnId(threadId, branchId, parentTurnId);
    return parentTurnId;
  }

  private async assertValidParentTurnId(
    threadId: string,
    branchId: string,
    parentTurnId: string | null
  ): Promise<void> {
    const expectedParentTurnId = await readBranchActiveTurnId(
      this.options.kernel,
      branchId
    );

    if (parentTurnId !== expectedParentTurnId) {
      throw new KrakenLineageError(
        `parent turn "${parentTurnId}" is not the active branch parent for branch "${branchId}"`,
        {
          code: "invalid_parent_turn",
          details: {
            branchId,
            expectedParentTurnId,
            parentTurnId,
            threadId,
          },
        }
      );
    }

    if (parentTurnId === null) {
      return;
    }

    const parentTurn = await this.options.kernel.turn.get(parentTurnId);

    if (parentTurn === null) {
      throw new KrakenLineageError(
        `parent turn "${parentTurnId}" does not exist`,
        {
          code: "invalid_parent_turn",
          details: {
            branchId,
            parentTurnId,
            threadId,
          },
        }
      );
    }

    if (parentTurn.threadId !== threadId) {
      throw new KrakenLineageError(
        `parent turn "${parentTurnId}" must stay on thread "${threadId}"`,
        {
          code: "invalid_parent_turn",
          details: {
            branchId,
            parentThreadId: parentTurn.threadId,
            parentTurnId,
            threadId,
          },
        }
      );
    }
  }

  private async applyTerminalAgentTransitionIfNeeded(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    resolution: RuntimeResolution,
    loopState: LoopState
  ): Promise<boolean> {
    if (resolution.type !== "handoff") {
      return false;
    }
    const handoff = await this.applyHandoff(
      handle,
      schemaId,
      resolution.contextPlan,
      loopState,
      loopState.carriedStateUpdates
    );
    loopState.activeConfig = handoff.activeConfig;
    loopState.activeToolRegistry = handoff.activeToolRegistry;
    loopState.carriedStateUpdates = [];
    return true;
  }

  private async failActiveRunIfNeeded(
    handle: RuntimeExecutionHandle
  ): Promise<void> {
    const activeRunId = handle.takeActiveRunId();

    if (activeRunId === undefined) {
      return;
    }

    await this.options.kernel.run.complete(activeRunId, "failed");
  }

  private async checkpointResumeRunningStatus(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    iterationCount: number
  ): Promise<void> {
    const headState = await this.loadHeadState(handle.request.branchId);
    const nextManifest =
      loopState.carriedStateUpdates.length === 0
        ? headState.manifest
        : updateContextManifest(
            headState.manifest,
            [],
            loopState.carriedStateUpdates
          );
    const runId = this.createId();
    await this.createTrackedRun(
      handle,
      runId,
      handle.turnId,
      handle.request.branchId,
      schemaId,
      headState.branchHeadHash,
      [
        {
          deterministic: false,
          id: "resume_running_status",
          sideEffects: false,
        },
      ]
    );
    await this.options.kernel.run.beginStep(runId, "resume_running_status");
    const runtimeStatusHash = await this.stageRuntimeStatus(
      runId,
      {
        activeAgent: loopState.activeConfig.name,
        state: "running",
      },
      "runtime_status_running"
    );
    const changes: Record<string, PathValue> = {
      "runtime.status": runtimeStatusHash,
    };

    if (loopState.carriedStateUpdates.length > 0) {
      changes["context.manifest"] = await this.stageManifest(
        runId,
        nextManifest
      );
    }

    const nextTreeHash = await this.options.kernel.tree.create(
      schemaId,
      changes,
      headState.turnNode.turnTreeHash
    );
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "resume_running_status",
      await this.storeEventRecord({
        iteration: iterationCount,
        turnId: handle.turnId,
        type: "runtime_status_resumed",
      }),
      undefined,
      nextTreeHash
    );
    await this.completeTrackedRun(handle, runId, "completed");

    if (stepResult.turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(
        handle.turnId,
        stepResult.turnNodeHash
      );
      await this.emitStateObservability(
        handle,
        loopState,
        stepResult.turnNodeHash,
        iterationCount,
        loopState.carriedStateUpdates.length === 0 ? undefined : nextManifest
      );
    }

    handle.updateStatus({
      activeAgent: loopState.activeConfig.name,
      iterationCount,
      manifest: nextManifest,
      phase: "running",
    });
    loopState.carriedStateUpdates = [];
  }

  private async createTrackedRun(
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
  ): Promise<void> {
    await this.options.kernel.run.create(
      runId,
      turnId,
      branchId,
      schemaId,
      startTurnNodeHash,
      steps
    );
    handle.setActiveRunId(runId);
  }

  private async completeTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    status: RunCompletionStatus,
    event?: KernelRecord
  ): Promise<{ turnNodeHash?: HashString }> {
    const eventHash =
      event === undefined ? undefined : await this.storeEventRecord(event);
    const completion = await this.options.kernel.run.complete(
      runId,
      status,
      eventHash
    );

    if (handle.getActiveRunId() === runId) {
      handle.takeActiveRunId();
    }

    return completion;
  }

  private async failTrackedRunWithoutBranchAdvance(
    handle: RuntimeExecutionHandle,
    runId: string,
    stableHeadTurnNodeHash: HashString
  ): Promise<void> {
    const completion = await this.completeTrackedRun(handle, runId, "failed");

    if (completion.turnNodeHash === undefined) {
      return;
    }

    await this.options.kernel.branch.setHead(
      handle.request.branchId,
      stableHeadTurnNodeHash
    );
  }

  private materializeDriver(driverId: string): KrakenDriver {
    const driverEntry = this.options.driverRegistry.resolve(driverId);

    if (driverEntry === undefined) {
      throw new KrakenRuntimeError(`driver "${driverId}" is not registered`, {
        code: "unknown_driver",
        details: {
          driverId,
        },
      });
    }

    return materializeDriver(driverEntry);
  }

  private async ensureSchemaId(schemaId?: string): Promise<string> {
    const resolvedSchemaId = schemaId ?? DEFAULT_AGENT_SCHEMA_ID;
    const existing = await this.options.kernel.schema.get(resolvedSchemaId);

    if (existing !== null) {
      assertFrameworkSchemaCompatibility(existing);
      return existing.schemaId;
    }

    if (resolvedSchemaId !== DEFAULT_AGENT_SCHEMA_ID) {
      throw new KrakenRuntimeError(
        `schema "${resolvedSchemaId}" is not registered`,
        {
          code: "unknown_schema",
          details: {
            schemaId: resolvedSchemaId,
          },
        }
      );
    }

    return await this.options.kernel.schema.register(DEFAULT_AGENT_SCHEMA);
  }

  private async stageManifest(
    runId: string,
    manifest: ContextManifest
  ): Promise<HashString> {
    const staged = await this.options.kernel.staging.stage(
      runId,
      encodeKernelRecord(manifest, "manifest"),
      "manifest",
      "context_manifest",
      "completed"
    );

    return staged.objectHash;
  }

  private async stageMessage(
    runId: string,
    message: KrakenMessage,
    taskId: string
  ): Promise<HashString> {
    const staged = await this.options.kernel.staging.stage(
      runId,
      encodeKernelRecord(message, "message"),
      taskId,
      "message",
      "completed"
    );

    return staged.objectHash;
  }

  private async stageTurnLineage(
    runId: string,
    turnId: string,
    taskId: string
  ): Promise<HashString> {
    const staged = await this.options.kernel.staging.stage(
      runId,
      encodeKernelRecord(
        {
          activeTurnId: turnId,
        } satisfies TurnLineageRecord,
        "turn lineage"
      ),
      taskId,
      "turn_lineage",
      "completed"
    );

    return staged.objectHash;
  }

  private async stageRuntimeStatus(
    runId: string,
    status: DurableRuntimeStatus,
    taskId: string
  ): Promise<HashString> {
    const serializedStatus = Object.fromEntries(
      Object.entries(status).filter(([, value]) => value !== undefined)
    );
    const staged = await this.options.kernel.staging.stage(
      runId,
      encodeKernelRecord(serializedStatus, "runtime status"),
      taskId,
      "runtime_status",
      "completed"
    );

    return staged.objectHash;
  }

  private async storeKernelRecord(
    value: unknown,
    label: string
  ): Promise<HashString> {
    return await this.options.kernel.store.put(
      encodeKernelRecord(value, label)
    );
  }

  private async storeEventRecord(event: KernelRecord): Promise<HashString> {
    return await this.storeKernelRecord(event, "event");
  }

  private publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void {
    this.publishEvent(
      handle,
      {
        data: event.data,
        name: event.name,
        timestamp: this.now(),
        type: "custom",
      },
      loopState
    );
  }

  private publishEvent(
    handle: RuntimeExecutionHandle,
    event: KrakenStreamEvent,
    loopState: LoopState
  ): void {
    const publishedEvent = {
      ...event,
      source: event.source ?? {
        agent: loopState.activeConfig.name,
        driver: loopState.activeDriverId,
        threadId: handle.request.threadId,
      },
    };
    assertKrakenStreamEvent(publishedEvent, "stream event");
    handle.publish(publishedEvent);
  }

  private publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ): void {
    const projection = projectError(error);
    handle.rememberError(projection);
    this.publishEvent(
      handle,
      {
        error: projection,
        fatal,
        timestamp: this.now(),
        type: "error",
      },
      loopState
    );
  }

  private emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): void {
    if (!this.options.enableStateObservability) {
      return;
    }

    this.publishEvent(
      handle,
      {
        iterationCount,
        timestamp: this.now(),
        turnNodeHash,
        type: "state.checkpoint",
      },
      loopState
    );
    if (manifest !== undefined) {
      this.publishEvent(
        handle,
        {
          manifest,
          timestamp: this.now(),
          type: "state.snapshot",
        },
        loopState
      );
    }
  }

  private createId(): string {
    return this.options.createId();
  }

  private now(): EpochMs {
    return this.options.now();
  }
}

export function createKrakenRuntimeCore(
  options: RuntimeCoreOptions
): KrakenRuntime {
  return new RuntimeCore(options);
}

function composeResolutions(
  baseResolution: RuntimeResolution,
  overrideResolution: RuntimeResolution | undefined
): RuntimeResolution {
  if (overrideResolution === undefined) {
    return baseResolution;
  }

  return resolutionPriority(baseResolution) >=
    resolutionPriority(overrideResolution)
    ? baseResolution
    : overrideResolution;
}

function createActiveToolRegistry(
  requestTools: KrakenToolDefinition[] | undefined,
  config: AgentConfig
): ToolRegistry {
  const activeTools = requestTools ?? config.tools ?? [];

  return createToolRegistry(activeTools, config.extensions ?? []);
}

function createReadonlyDriverToolRegistry(
  registry: ToolRegistry
): ToolRegistry {
  // Drivers only inspect a frozen tool snapshot here. Framework-owned execution
  // always goes through the live registry used by the shared tool executor.
  const toolSnapshots = registry
    .list()
    .map((tool) =>
      createFrozenSnapshot(createDriverToolDefinitionSnapshot(tool))
    );
  const toolsByName = new Map(toolSnapshots.map((tool) => [tool.name, tool]));
  const renderedDefinitions = registry
    .toDefinitions()
    .map((tool) => cloneValue(tool));

  return Object.freeze({
    get(name) {
      return toolsByName.get(name);
    },
    has(name) {
      return toolsByName.has(name);
    },
    list() {
      return [...toolSnapshots];
    },
    register(tool) {
      throw new KrakenRuntimeError(
        `drivers must not mutate the execution tool registry with "${tool.name}"`,
        {
          code: "invalid_driver_result",
          details: {
            toolName: tool.name,
          },
        }
      );
    },
    toDefinitions() {
      return renderedDefinitions.map((tool) => cloneValue(tool));
    },
  } satisfies ToolRegistry);
}

function createDriverToolDefinitionSnapshot(
  tool: KrakenToolDefinition
): KrakenToolDefinition {
  return {
    approval: tool.approval,
    description: tool.description,
    execute() {
      throw new KrakenRuntimeError(
        `drivers must not execute tool "${tool.name}" from the read-only tool snapshot`,
        {
          code: "invalid_driver_result",
          details: {
            toolName: tool.name,
          },
        }
      );
    },
    inputSchema: createFrozenSnapshot(tool.inputSchema),
    metadata:
      tool.metadata === undefined
        ? undefined
        : createFrozenSnapshot(tool.metadata),
    name: tool.name,
  };
}

function cloneAgentConfigForRequest(config: AgentConfig): AgentConfig {
  return {
    ...config,
    extensions:
      config.extensions?.map((extension) => ({
        ...extension,
        state:
          extension.state === undefined
            ? undefined
            : cloneValue(extension.state),
        tools: extension.tools?.map((tool) => tool),
      })) ?? undefined,
    tools: config.tools?.map((tool) => tool) ?? undefined,
  };
}

function encodeKernelRecord(value: unknown, label: string): Uint8Array {
  assertKernelRecord(value, label);
  return encodeDeterministicKernelRecord(value);
}

function collectInitialExtensionStateUpdates(
  extensions: KrakenExtension[],
  manifest: ContextManifest
): ExtensionStateUpdate[] {
  const updates: ExtensionStateUpdate[] = [];

  for (const extension of extensions) {
    if (
      extension.state === undefined ||
      Object.hasOwn(manifest.extensions, extension.name)
    ) {
      continue;
    }

    updates.push({
      extensionName: extension.name,
      state: cloneValue(extension.state),
    });
  }

  return updates;
}

function extractToolCallsFromMessages(
  messages: KrakenMessage[]
): ToolCallPart[] {
  const calls: ToolCallPart[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const part of message.parts) {
      if (part.type === "tool_call") {
        calls.push(part);
      }
    }
  }

  return calls;
}

function createPendingKernelHash(value: Uint8Array): HashString {
  // Use `node:crypto` intentionally here: current Node, Bun, and Deno all support
  // `createHash`, so the standard implementation is preferable to maintaining a
  // custom fallback for this provisional helper.
  // These hashes are provisional helper ids only; the kernel's store hash remains
  // authoritative once the record is flushed through `store.put()`.
  return createHash("sha256")
    .update("kraken-runtime-pending:")
    .update(value)
    .digest("hex");
}

async function readBranchHeadState(
  kernel: KrakenKernel,
  branchId: string
): Promise<{
  branchHeadHash: HashString;
  turnNode: TurnNode;
}> {
  const branch = await kernel.branch.get(branchId);

  if (branch === null) {
    throw new KrakenLineageError(`branch "${branchId}" does not exist`, {
      code: "missing_branch",
    });
  }

  const turnNode = await kernel.node.get(branch.headTurnNodeHash);

  if (turnNode === null) {
    throw new KrakenLineageError(
      `turn node "${branch.headTurnNodeHash}" does not exist`,
      {
        code: "missing_turn_node",
      }
    );
  }

  return {
    branchHeadHash: branch.headTurnNodeHash,
    turnNode,
  };
}

async function readBranchActiveTurnId(
  kernel: KrakenKernel,
  branchId: string
): Promise<string | null> {
  const { turnNode } = await readBranchHeadState(kernel, branchId);
  const lineageHash = toOptionalHash(
    await kernel.tree.resolve(turnNode.turnTreeHash, "turn.lineage")
  );

  if (lineageHash === null) {
    return null;
  }

  const payload = await kernel.store.get(lineageHash);

  if (payload === null) {
    throw new KrakenLineageError(
      `turn lineage "${lineageHash}" does not exist`,
      {
        code: "missing_turn_lineage",
        details: {
          branchId,
          hash: lineageHash,
        },
      }
    );
  }

  const decoded = decodeDeterministicKernelRecord(payload);

  if (isTurnLineageRecord(decoded)) {
    return decoded.activeTurnId;
  }

  throw new KrakenLineageError(
    `branch "${branchId}" turn lineage must carry an activeTurnId`,
    {
      code: "invalid_turn_lineage",
      details: {
        branchId,
        lineageHash,
        turnLineage: decoded,
      },
    }
  );
}

function inferFinishReason(
  message: Extract<KrakenMessage, { role: "assistant" }>
): "content_filter" | "error" | "length" | "stop" | "tool_call" {
  return message.parts.some((part) => part.type === "tool_call")
    ? "tool_call"
    : "stop";
}

function isContextEngineeringPlan(
  value: ContextEngineeringPlan | { action: "none" }
): value is ContextEngineeringPlan {
  return value.action !== "none";
}

function decodeKrakenMessageRecord(
  payload: Uint8Array,
  label: string
): KrakenMessage {
  const decoded = decodeDeterministicKernelRecord(payload);
  assertKrakenMessage(decoded, label);
  return decoded;
}

function createCancelledLoopOutcome(
  handle: RuntimeExecutionHandle,
  partial = false
): LoopOutcome | undefined {
  const cancelledResolution = createCancelledResolution(handle);

  if (cancelledResolution === undefined) {
    return undefined;
  }

  return {
    partial,
    resolution: cancelledResolution,
  };
}

function createCancelledResolution(
  handle: RuntimeExecutionHandle
): RuntimeResolution | undefined {
  if (!handle.abortSignal.aborted) {
    return undefined;
  }

  return {
    error: new Error("execution cancelled"),
    fatality: "hard",
    type: "fail",
  };
}

function formatToolResultTaskId(orderIndex: number, callId: string): string {
  return `tool_message_${orderIndex.toString().padStart(6, "0")}_${callId}`;
}

function resolutionPriority(resolution: RuntimeResolution): number {
  switch (resolution.type) {
    case "fail":
      return resolution.fatality === "hard" ? 6 : 2;
    case "pause":
      return 5;
    case "handoff":
      return 4;
    case "end_turn":
      return 3;
    case "continue_iteration":
      return 1;
    default:
      return 0;
  }
}

function resolutionToPhase(
  resolution: RuntimeResolution
): TurnEndEvent["status"] {
  switch (resolution.type) {
    case "pause":
      return "paused";
    case "fail":
      return "failed";
    case "continue_iteration":
    case "end_turn":
    case "handoff":
      return "completed";
    default:
      return "failed";
  }
}

function synthesizeResponse(
  messages: KrakenMessage[],
  resolution: RuntimeResolution
): KrakenModelResponse {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role === "assistant") {
      return {
        finishReason: inferFinishReason(message),
        parts: message.parts,
      };
    }
  }

  return {
    finishReason: resolution.type === "fail" ? "error" : "stop",
    parts: [],
  };
}

function toOptionalHash(value: PathValue): HashString | null {
  if (typeof value === "string") {
    return value;
  }

  if (value === null) {
    return null;
  }

  throw new KrakenRuntimeError("expected a single-hash path value", {
    code: "invalid_path_value_shape",
    details: {
      value,
    },
  });
}

function toOrderedHashArray(value: PathValue): HashString[] {
  if (Array.isArray(value)) {
    return value;
  }

  throw new KrakenRuntimeError("expected an ordered hash array path value", {
    code: "invalid_path_value_shape",
    details: {
      value,
    },
  });
}

function isTurnLineageRecord(value: unknown): value is TurnLineageRecord {
  return isRecord(value) && typeof value.activeTurnId === "string";
}

function hasAssistantOutputMessages(messages: KrakenMessage[]): boolean {
  return messages.some((message) => message.role === "assistant");
}

function assertFrameworkSchemaCompatibility(schema: TurnTreeSchema): void {
  const requiredPathKinds = new Map<string, "ordered" | "single">([
    ["messages", "ordered"],
    ["context.manifest", "single"],
    ["turn.lineage", "single"],
    ["runtime.status", "single"],
  ]);
  const requiredIncorporationRules = new Map<string, string>([
    ["message", "messages"],
    ["context_manifest", "context.manifest"],
    ["turn_lineage", "turn.lineage"],
    ["runtime_status", "runtime.status"],
  ]);

  for (const [path, collection] of requiredPathKinds) {
    const definition = schema.paths.find(
      (candidate) => candidate.path === path
    );

    if (definition?.collection !== collection) {
      throw new KrakenRuntimeError(
        `schema "${schema.schemaId}" must define ${collection} path "${path}"`,
        {
          code: "invalid_framework_schema",
          details: {
            path,
            schemaId: schema.schemaId,
          },
        }
      );
    }
  }

  for (const [objectType, targetPath] of requiredIncorporationRules) {
    const rule = schema.incorporationRules.find(
      (candidate) => candidate.objectType === objectType
    );

    if (rule?.targetPath !== targetPath) {
      throw new KrakenRuntimeError(
        `schema "${schema.schemaId}" must incorporate "${objectType}" into "${targetPath}"`,
        {
          code: "invalid_framework_schema",
          details: {
            objectType,
            schemaId: schema.schemaId,
            targetPath,
          },
        }
      );
    }
  }
}
