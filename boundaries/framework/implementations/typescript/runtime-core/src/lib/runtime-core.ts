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
import { isDeepStrictEqual } from "node:util";
import {
  assertKernelRecord,
  type EpochMs,
  type HashString,
  type KernelRecord,
  TuvrenLineageError,
  TuvrenRuntimeError,
} from "@tuvren/core-types";
import type {
  DriverAssistantEventReconciliation,
  DriverExecutionContext,
  DriverExecutionResult,
  DriverRegistry,
  RuntimeDriver as KrakenDriver,
} from "@tuvren/driver-api";
import { assertDriverExecutionResult } from "@tuvren/driver-api";
import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  type RuntimeKernel as KrakenKernel,
  type PathValue,
  type RunCompletionStatus,
  type TurnNode,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import type {
  AgentConfig,
  ApprovalRequest,
  ApprovalResponse,
  ContentPart,
  ContextEngineeringContext,
  ContextEngineeringHelpers,
  ContextEngineeringPlan,
  ContextManifest,
  ExecutionHandle,
  HandoffContextBuilder,
  HandoffContextPlan,
  HandoffSourceContext,
  InputSignal,
  RuntimeResolution,
  ToolCallPart,
  ToolRegistry,
  ToolResultPart,
  TurnEndEvent,
  TuvrenExtension,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenRuntime,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
} from "@tuvren/runtime-api";
import {
  assertContextManifest,
  assertTuvrenMessage,
  assertTuvrenStreamEvent,
} from "@tuvren/runtime-api";
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
  cloneSnapshotPreservingFunctions,
  cloneValue,
  createExecutionCancelledError,
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
  type ToolExecutionMode,
} from "./tool-execution.js";
import { createToolRegistry } from "./tool-registry.js";

export const DEFAULT_AGENT_SCHEMA_ID = "tuvren.agent.v1";
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;
export const DEFAULT_MANIFEST_EXTENSION_STATE_WARNING_BUDGET_BYTES = 256 * 1024;
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

const readonlyDriverToolRegistryCache = new WeakMap<
  ToolRegistry,
  ToolRegistry
>();
const serializedByteLengthEncoder = new TextEncoder();

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

interface HeadState {
  branchHeadHash: HashString;
  manifest: ContextManifest;
  messageHashes: HashString[];
  messages: TuvrenMessage[];
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

class RuntimeCore implements TuvrenRuntime {
  private readonly manifestExtensionStateWarningKeys = new WeakMap<
    RuntimeExecutionHandle,
    Set<string>
  >();
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
        tools:
          request.tools === undefined
            ? undefined
            : createFrozenSnapshot(request.tools),
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

    const cancellationTask = this.finalizePausedCancellation(
      handle,
      pauseContext,
      createExecutionCancelledError()
    );
    handle.rememberPausedCancellation(cancellationTask);
    detachPromise(cancellationTask);
  }

  async startExecution(handle: RuntimeExecutionHandle): Promise<void> {
    try {
      const pendingPausedCancellation = handle.getPendingPausedCancellation();

      if (pendingPausedCancellation !== undefined) {
        await pendingPausedCancellation;
        return;
      }

      if (handle.status().phase !== "running") {
        return;
      }

      if (handle.resumedFrom === undefined && handle.abortSignal.aborted) {
        return;
      }

      const schemaId = await this.resolveExecutionSchemaId(handle.request);
      handle.setSchemaId(schemaId);
      const branchHeadHash = await this.resolveExecutionBranchHead(handle);
      await this.createExecutionTurnIfNeeded(handle, branchHeadHash);
      const loopState = this.createExecutionLoopState(handle);

      const resumedStart = await this.prepareResumedExecutionStartPrelude(
        handle,
        schemaId,
        loopState
      );

      if (resumedStart?.completed === true) {
        return;
      }

      this.publishTurnStart(handle, loopState);

      if (resumedStart !== undefined) {
        this.publishApprovalResolved(
          handle,
          handle.resumedFrom?.approval,
          loopState
        );

        if (resumedStart.pendingStateObservability !== undefined) {
          // Resume prelude may need to durably checkpoint running status before
          // the replacement handle becomes observable, but the resumed stream
          // still begins with turn.start -> approval.resolved by contract.
          this.emitStateObservability(
            handle,
            loopState,
            resumedStart.pendingStateObservability.turnNodeHash,
            resumedStart.pendingStateObservability.iterationCount,
            resumedStart.pendingStateObservability.manifest
          );
        }
      }

      if (
        resumedStart !== undefined &&
        (await this.finishResumedExecutionStart(handle, schemaId, loopState))
      ) {
        return;
      }

      if (
        resumedStart === undefined &&
        (await this.prepareFreshExecutionStart(handle, schemaId, loopState))
      ) {
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
      throw new TuvrenLineageError(
        `branch "${handle.request.branchId}" does not exist`,
        {
          code: "missing_branch",
        }
      );
    }

    if (branch.threadId !== handle.request.threadId) {
      throw new TuvrenLineageError(
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

  private async prepareResumedExecutionStartPrelude(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<
    | {
        completed: boolean;
        pendingStateObservability?: {
          iterationCount: number;
          manifest?: ContextManifest;
          turnNodeHash: HashString;
        };
      }
    | undefined
  > {
    const resumeContext = handle.resumedFrom;

    if (resumeContext === undefined) {
      return undefined;
    }

    await this.options.kernel.run.complete(
      resumeContext.pausedRunId,
      "failed",
      await this.storeEventRecord({
        turnId: handle.turnId,
        type: "paused_run_resolved",
      })
    );
    const pendingStateObservability = await this.checkpointResumeRunningStatus(
      handle,
      schemaId,
      loopState,
      resumeContext.pauseContext.pausedIteration.iterationCount,
      false
    );
    return {
      completed: false,
      pendingStateObservability,
    };
  }

  private async finishResumedExecutionStart(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState
  ): Promise<boolean> {
    const resumeContext = handle.resumedFrom;

    if (resumeContext === undefined) {
      return false;
    }

    handle.clearPendingResumeCancellation();
    const cancelledOutcome = createCancelledLoopOutcome(handle);

    if (cancelledOutcome !== undefined) {
      await this.completeExecution(
        handle,
        cancelledOutcome.resolution,
        cancelledOutcome.partial ?? false,
        loopState,
        false
      );
      return true;
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

  private publishApprovalResolved(
    handle: RuntimeExecutionHandle,
    response: ApprovalResponse | undefined,
    loopState: LoopState
  ): void {
    if (response === undefined) {
      return;
    }

    this.publishEvent(
      handle,
      {
        response,
        timestamp: this.now(),
        type: "approval.resolved",
      },
      loopState
    );
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
    const failureActiveConfig = this.resolveFailureActiveConfig(handle);

    handle.rememberError(projectError(rootError ?? runtimeError));
    const loopState: LoopState = {
      activeConfig: failureActiveConfig,
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
      activeAgent: loopState.activeConfig.name,
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
    while (true) {
      const nextIteration = handle.status().iterationCount + 1;
      loopState.enteredIterationLoop = true;

      const abortedOutcome = createCancelledLoopOutcome(handle);

      if (abortedOutcome !== undefined) {
        return abortedOutcome;
      }

      this.beginIteration(handle, loopState, nextIteration);
      await this.incorporateQueuedSteeringIfNeeded(handle, schemaId, loopState);

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
        nextIteration
      );

      if (phaseResult.kind === "outcome") {
        this.publishIterationEnd(handle, loopState, nextIteration);
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
    loopState: LoopState
  ): Promise<void> {
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
    iterationCount: number
  ): Promise<IterationPhaseResult> {
    if (headState === undefined) {
      throw new TuvrenRuntimeError("iteration execution requires head state", {
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

    const emittedDriverEvents: TuvrenStreamEvent[] = [];
    const driverResult = await this.executeDriver(
      driver,
      this.createDriverExecutionContext(
        handle,
        schemaId,
        loopState,
        headState,
        iterationCount,
        emittedDriverEvents
      )
    );
    let resolution = driverResult.resolution;
    const driverMessages = [...(driverResult.messages ?? [])];
    const cancellationResolution = createCancelledResolution(handle);
    const assistantEventValidationError = validateDriverAssistantEvents(
      driverMessages,
      emittedDriverEvents,
      cancellationResolution ?? resolution,
      driverResult.assistantEventReconciliation,
      loopState.activeConfig.extensions ?? []
    );
    const synthesizedAssistantEvents = this.ensureDriverAssistantEvents(
      handle,
      driverMessages,
      emittedDriverEvents,
      loopState
    );
    const requestedToolCalls = extractToolCallsFromMessages(driverMessages);
    const toolExecutionMode = driverResult.toolExecutionMode ?? "parallel";
    const partial =
      driverResult.partial === true ||
      (cancellationResolution !== undefined &&
        hasAssistantOutputMessages(driverMessages));
    const invalidDriverError = this.findInvalidDriverExecutionError(
      loopState.activeConfig.extensions ?? [],
      requestedToolCalls.length,
      resolution,
      cancellationResolution,
      partial,
      assistantEventValidationError,
      driverResult.stateUpdates
    );

    if (invalidDriverError !== undefined) {
      await this.failTrackedRunWithoutBranchAdvance(
        handle,
        iterationRunId,
        headState.branchHeadHash
      );
      return {
        kind: "outcome",
        outcome: {
          resolution: {
            error: invalidDriverError,
            fatality: "hard",
            type: "fail",
          },
        },
      };
    }

    this.applyDriverStateUpdates(loopState, driverResult.stateUpdates);

    this.flushBufferedDriverEventsIfNeeded(
      handle,
      resolution,
      synthesizedAssistantEvents
    );

    const stagedMessages = [...driverMessages];
    const stagedMessageHashes = await this.stageDriverMessages(
      iterationRunId,
      driverMessages,
      iterationCount
    );
    const driverResponse = synthesizeResponse(
      driverMessages,
      resolution,
      emittedDriverEvents,
      driverResult.assistantEventReconciliation
    );
    const toolResults: ToolResultPart[] = [];

    resolution = cancellationResolution ?? resolution;
    const toolBatchResult = await this.applyRequestedToolBatchIfNeeded({
      handle,
      headState,
      iterationCount,
      loopState,
      requestedToolCalls,
      resolution,
      runId: iterationRunId,
      stagedMessageHashes,
      stagedMessages,
      toolExecutionMode,
      toolResults,
    });

    if ("type" in toolBatchResult) {
      resolution = toolBatchResult;
    } else {
      return {
        kind: "outcome",
        outcome: toolBatchResult,
      };
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
    const checkpointedPause = resolution.type === "pause";
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
    resolution = await this.reconcileCheckpointedPauseResolution(
      checkpointedPause,
      iterationRunId,
      handle.turnId,
      resolution
    );
    resolution = createCancelledResolution(handle) ?? resolution;

    const invalidPauseOutcome = await this.failInvalidPauseResolutionIfNeeded(
      handle,
      iterationRunId,
      headState.branchHeadHash,
      requestedToolCalls.length,
      resolution
    );

    if (invalidPauseOutcome !== undefined) {
      return invalidPauseOutcome;
    }

    return {
      kind: "executed",
      result: {
        driverResponse,
        iterationRunId,
        partial,
        requestedToolCalls,
        resolution,
        stableHeadTurnNodeHash: headState.branchHeadHash,
        toolExecutionMode,
        toolResults,
        turnNodeHash,
      },
    };
  }

  private findInvalidDriverResolution(
    requestedToolCallCount: number,
    resolution: RuntimeResolution,
    partial: boolean
  ): TuvrenRuntimeError | undefined {
    if (
      requestedToolCallCount > 0 &&
      resolution.type !== "continue_iteration" &&
      !(partial && resolution.type === "fail")
    ) {
      return new TuvrenRuntimeError(
        "drivers must not return executable tool calls with a terminal resolution",
        {
          code: "invalid_driver_resolution",
          details: {
            pauseRequiresToolCalls: resolution.type === "pause",
            resolutionType: resolution.type,
            toolCallCount: requestedToolCallCount,
          },
        }
      );
    }

    if (requestedToolCallCount === 0 && resolution.type === "pause") {
      return new TuvrenRuntimeError(
        "shared core only permits approval pauses that originate from requested tool calls",
        {
          code: "invalid_driver_resolution",
          details: {
            pauseRequiresToolCalls: true,
            resolutionType: resolution.type,
            toolCallCount: requestedToolCallCount,
          },
        }
      );
    }

    return undefined;
  }

  private findInvalidDriverExecutionError(
    activeExtensions: TuvrenExtension[],
    requestedToolCallCount: number,
    resolution: RuntimeResolution,
    cancellationResolution: RuntimeResolution | undefined,
    partial: boolean,
    assistantEventValidationError: TuvrenRuntimeError | undefined,
    stateUpdates: DriverExecutionResult["stateUpdates"]
  ): TuvrenRuntimeError | undefined {
    if (cancellationResolution === undefined) {
      const invalidDriverResolutionError = this.findInvalidDriverResolution(
        requestedToolCallCount,
        resolution,
        partial
      );

      if (invalidDriverResolutionError !== undefined) {
        return invalidDriverResolutionError;
      }
    }

    if (assistantEventValidationError !== undefined) {
      return assistantEventValidationError;
    }

    return this.findInvalidDriverStateUpdateError(
      activeExtensions,
      stateUpdates
    );
  }

  private applyDriverStateUpdates(
    loopState: LoopState,
    stateUpdates: DriverExecutionResult["stateUpdates"]
  ): void {
    if (stateUpdates === undefined) {
      return;
    }

    loopState.carriedStateUpdates.push(
      ...stateUpdates.map((update) => ({
        extensionName: update.extensionName,
        state: cloneValue(update.state),
      }))
    );
  }

  private findInvalidDriverStateUpdateError(
    activeExtensions: TuvrenExtension[],
    stateUpdates: DriverExecutionResult["stateUpdates"]
  ): TuvrenRuntimeError | undefined {
    if (stateUpdates === undefined || stateUpdates.length === 0) {
      return undefined;
    }

    const activeExtensionNames = new Set(
      activeExtensions.map((extension) => extension.name)
    );

    for (const update of stateUpdates) {
      if (activeExtensionNames.has(update.extensionName)) {
        continue;
      }

      return new TuvrenRuntimeError(
        "driver state updates must target extensions active in the current agent config",
        {
          code: "invalid_driver_result",
          details: {
            extensionName: update.extensionName,
          },
        }
      );
    }

    return undefined;
  }

  private async failInvalidPauseResolutionIfNeeded(
    handle: RuntimeExecutionHandle,
    iterationRunId: string,
    stableHeadTurnNodeHash: HashString,
    requestedToolCallCount: number,
    resolution: RuntimeResolution
  ): Promise<IterationPhaseResult | undefined> {
    if (resolution.type !== "pause" || requestedToolCallCount > 0) {
      return undefined;
    }

    const invalidPauseResolution = new TuvrenRuntimeError(
      "shared core only permits approval pauses that originate from requested tool calls",
      {
        code: "invalid_driver_resolution",
        details: {
          resolutionType: resolution.type,
          toolCallCount: requestedToolCallCount,
        },
      }
    );
    await this.failTrackedRunWithoutBranchAdvance(
      handle,
      iterationRunId,
      stableHeadTurnNodeHash
    );
    return {
      kind: "outcome",
      outcome: {
        resolution: {
          error: invalidPauseResolution,
          fatality: "hard",
          type: "fail",
        },
      },
    };
  }

  private createDriverExecutionContext(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: LoopState,
    headState: HeadState,
    iterationCount: number,
    emittedDriverEvents: TuvrenStreamEvent[]
  ): DriverExecutionContext {
    const toolRegistrySnapshot = createReadonlyDriverToolRegistry(
      loopState.activeToolRegistry
    );

    // Drivers get snapshots plus explicit capability ports here on purpose.
    // Widening this bag with more live framework-owned objects would reopen the
    // exact boundary drift Epic H just paid to close.
    return {
      branchId: handle.request.branchId,
      config: createDriverAgentConfigSnapshot(loopState.activeConfig),
      handoff: {
        createContextPlan: (input) =>
          this.createDriverHandoffContextPlan(input, headState, loopState),
      },
      iterationCount,
      manifest: createFrozenSnapshot(headState.manifest),
      messages: createFrozenSnapshot(headState.messages),
      runtime: {
        emit: (event) => {
          let clonedEvent: TuvrenStreamEvent;

          try {
            clonedEvent = cloneValue(event);
          } catch (error: unknown) {
            throw new TuvrenRuntimeError(
              "driver-emitted stream events must be cloneable",
              {
                code: "invalid_stream_event",
                details: {
                  error: normalizeError(error).message,
                },
              }
            );
          }

          const publishedEvent = this.createDriverPublishedEvent(
            handle,
            clonedEvent,
            loopState
          );
          emittedDriverEvents.push(publishedEvent);
          handle.publish(publishedEvent);
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
    messages: TuvrenMessage[],
    iterationCount: number
  ): Promise<HashString[]> {
    const stagedMessageHashes: HashString[] = [];

    for (const [index, driverMessage] of messages.entries()) {
      assertTuvrenMessage(driverMessage, `driverResult.messages[${index}]`);
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
    requestedToolCalls: ToolCallPart[],
    toolExecutionMode: ToolExecutionMode
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
        ),
        toolExecutionMode
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

  private async applyRequestedToolBatchIfNeeded(input: {
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
  }): Promise<LoopOutcome | RuntimeResolution> {
    if (
      input.resolution.type !== "continue_iteration" ||
      input.requestedToolCalls.length === 0
    ) {
      return input.resolution;
    }

    const toolBatch = await this.executeRequestedToolBatch(
      input.handle,
      input.loopState,
      input.headState,
      input.iterationCount,
      input.runId,
      input.requestedToolCalls,
      input.toolExecutionMode
    );

    if ("outcome" in toolBatch) {
      return toolBatch.outcome;
    }

    input.toolResults.push(...toolBatch.results);
    input.stagedMessageHashes.push(...toolBatch.resultHashes);
    input.loopState.carriedStateUpdates.push(...toolBatch.updates);

    for (const result of toolBatch.results) {
      input.stagedMessages.push({
        parts: [result],
        role: "tool",
      });
    }

    if (toolBatch.approval === undefined) {
      return input.resolution;
    }

    return {
      approval: toolBatch.approval,
      reason: "approval_required",
      type: "pause",
    };
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
    const manifestHash = await this.stageManifest(runId, manifest, {
      handle,
      loopState,
    });
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
    response: TuvrenModelResponse,
    toolResults: ToolResultPart[],
    headMessages: TuvrenMessage[],
    stagedMessages: TuvrenMessage[],
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
        throw new TuvrenRuntimeError(
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
          pauseReason: result.resolution.reason,
          pausedIteration: {
            iterationCount,
            response: result.driverResponse,
            toolExecutionMode: result.toolExecutionMode,
            toolResults: result.toolResults,
          },
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
        loopState,
        result.stableHeadTurnNodeHash
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
        ),
        pausedIteration.toolExecutionMode
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
    })) satisfies TuvrenMessage[];
    const manifest = updateContextManifest(
      headState.manifest,
      resumedMessages,
      toolBatch.updates,
      []
    );
    const manifestHash = await this.stageManifest(runId, manifest, {
      handle,
      loopState,
    });

    let resolution: RuntimeResolution;

    if (toolBatch.approval === undefined) {
      resolution = { type: "continue_iteration" };
    } else {
      resolution = {
        approval: toolBatch.approval,
        reason: "approval_required",
        type: "pause",
      };
    }

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
        await this.resolveCheckpointedPausedRun(
          runId,
          handle.turnId,
          resolution
        );

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
        throw new TuvrenRuntimeError(
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
          pauseReason: resolution.reason,
          pausedIteration: {
            iterationCount: pausedIteration.iterationCount,
            response: pausedIteration.response,
            toolExecutionMode: pausedIteration.toolExecutionMode,
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
      maxParallelToolCalls: resolveActiveMaxParallelToolCalls(
        loopState.activeConfig,
        this.options.defaultMaxParallelToolCalls
      ),
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

    // Helper-built plans always start from framework-owned source snapshots.
    // If a concrete driver needs a different handoff policy, that belongs in
    // its builder output, not in a widened helper seam.
    const plan = {
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
        sourceAgent: createFrozenSnapshot(
          cloneAgentConfigForRequest(loopState.activeConfig)
        ),
        targetAgent: createFrozenSnapshot(
          cloneAgentConfigForRequest(resolvedTargetAgent)
        ),
      },
      targetAgent: input.targetAgent,
    } satisfies HandoffContextPlan;
    return plan;
  }

  private async executeDriver(
    driver: KrakenDriver,
    context: DriverExecutionContext
  ) {
    try {
      const result = await driver.execute(context);
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
    switch (mode) {
      case "last_output_only":
        return createLastOutputOnlyHandoffContextBuilder();
      case "preserve_trace":
        return (
          this.options.handoffContextBuilder ??
          createPreserveTraceHandoffContextBuilder()
        );
      default:
        throw new TuvrenRuntimeError(
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
    const userMessage: TuvrenMessage = {
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
    await this.stageManifest(runId, manifest, {
      handle,
      loopState,
    });
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
    const steeringMessage: TuvrenMessage = {
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
    await this.stageManifest(runId, manifest, {
      handle,
      loopState,
    });
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
    await this.stageManifest(runId, manifest, {
      handle,
      loopState,
    });
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
      throw new TuvrenRuntimeError(
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
    const sourceContext = this.resolveHandoffSourceContext(
      plan,
      headState,
      loopState,
      targetConfig,
      helperBundle.helpers
    );
    const normalizedPlan = {
      ...plan,
      sourceContext,
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
    messages: TuvrenMessage[]
  ): HelperBundle {
    const kernel = this.options.kernel;
    const existingMessages = new Map<HashString, TuvrenMessage>();
    const pendingMessages = new Map<HashString, TuvrenMessage>();
    const pendingRecords = new Map<
      HashString,
      { message: TuvrenMessage; record: Uint8Array }
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

          assertTuvrenMessage(message, `message "${hash}"`);
          return cloneValue(message);
        },
        storeMessage(message) {
          assertTuvrenMessage(message, "context engineering helper message");
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
            assertTuvrenMessage(message, "context engineering helper message");
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

  private resolveHandoffSourceContext(
    plan: HandoffContextPlan,
    headState: HeadState,
    loopState: LoopState,
    targetConfig: AgentConfig,
    helpers: ContextEngineeringHelpers
  ): HandoffSourceContext {
    // The shared framework owns the source snapshot handed to every builder.
    // Raw plans may customize formatting through their builder, but they must
    // still operate on the latest branch head so the framework-owned handoff
    // mode semantics cannot be bypassed by caller-supplied stale context.
    return {
      handoffIntent: cloneValue(plan.sourceContext.handoffIntent),
      helpers,
      manifest: cloneValue(headState.manifest),
      messages: cloneValue(headState.messages),
      sourceAgent: createFrozenSnapshot(
        cloneAgentConfigForRequest(loopState.activeConfig)
      ),
      targetAgent: createFrozenSnapshot(
        cloneAgentConfigForRequest(targetConfig)
      ),
    };
  }

  private materializeContextMessages(
    hashes: HashString[],
    helpers: ContextEngineeringHelpers
  ): TuvrenMessage[] {
    const messages: TuvrenMessage[] = [];

    for (const hash of hashes) {
      const message = helpers.loadMessage(hash);

      if (message === null) {
        throw new TuvrenLineageError(`message "${hash}" does not exist`, {
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
    _error: Error
  ): Promise<void> {
    const loopState: LoopState = {
      activeConfig: pauseContext.activeConfig,
      activeDriverId: pauseContext.activeDriverId,
      activeToolRegistry: pauseContext.activeToolRegistry,
      carriedStateUpdates: [...pauseContext.carriedStateUpdates],
      enteredIterationLoop: true,
    };
    await this.options.kernel.run.complete(
      pauseContext.pausedRunId,
      "failed",
      await this.storeEventRecord({
        turnId: handle.turnId,
        type: "paused_run_cancelled",
      })
    );

    const cancelledOutcome = await this.finalizeRejectedPausedToolCancellation(
      handle,
      loopState,
      pauseContext
    );

    await this.completeExecution(
      handle,
      cancelledOutcome.resolution,
      cancelledOutcome.partial ?? false,
      loopState,
      true
    );
    return;
  }

  private async finalizeRejectedPausedToolCancellation(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    pauseContext: PauseContext
  ): Promise<LoopOutcome> {
    const pausedIteration = pauseContext.pausedIteration;

    loopState.enteredIterationLoop = true;
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
          id: "iterate",
          sideEffects: true,
        },
      ]
    );
    await this.options.kernel.run.beginStep(runId, "iterate");

    let toolBatch: ToolBatchOutcome;

    try {
      toolBatch = await resumeToolBatch(
        pauseContext.approval,
        createRejectedApprovalResponse(pauseContext.approval),
        this.createToolBatchEnvironment(
          handle,
          loopState,
          headState.manifest,
          pausedIteration.iterationCount,
          runId
        ),
        pausedIteration.toolExecutionMode
      );
    } catch (resumeError: unknown) {
      await this.failTrackedRunWithoutBranchAdvance(
        handle,
        runId,
        headState.branchHeadHash
      );
      return {
        resolution: {
          error: normalizeError(resumeError),
          fatality: "hard",
          type: "fail",
        },
      };
    }

    const resumedMessages = toolBatch.results.map((result) => ({
      parts: [result],
      role: "tool",
    })) satisfies TuvrenMessage[];
    const rejectionUpdates = [
      ...loopState.carriedStateUpdates,
      ...toolBatch.updates,
    ];
    const manifest = updateContextManifest(
      headState.manifest,
      resumedMessages,
      rejectionUpdates,
      []
    );
    const manifestHash = await this.stageManifest(runId, manifest, {
      handle,
      loopState,
    });
    const nextTreeHash = await this.createIterationTree(
      handle.schemaId,
      headState.turnNode.turnTreeHash,
      headState.messageHashes,
      toolBatch.resultHashes,
      manifestHash
    );

    await this.completeIterationRun(
      handle,
      runId,
      createApprovalRejectionResolution(),
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

    return {
      resolution: createApprovalRejectionResolution(),
    };
  }

  private async loadHeadState(branchId: string): Promise<HeadState> {
    const branch = await this.options.kernel.branch.get(branchId);

    if (branch === null) {
      throw new TuvrenLineageError(`branch "${branchId}" does not exist`, {
        code: "missing_branch",
      });
    }

    const turnNode = await this.options.kernel.node.get(
      branch.headTurnNodeHash
    );

    if (turnNode === null) {
      throw new TuvrenLineageError(
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
      throw new TuvrenLineageError(`manifest "${hash}" does not exist`, {
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

  private async readMessages(hashes: HashString[]): Promise<TuvrenMessage[]> {
    const messages: TuvrenMessage[] = [];

    for (const hash of hashes) {
      messages.push(await this.readMessage(hash));
    }

    return messages;
  }

  private async readMessage(hash: HashString): Promise<TuvrenMessage> {
    const payload = await this.options.kernel.store.get(hash);

    if (payload === null) {
      throw new TuvrenLineageError(`message "${hash}" does not exist`, {
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
      throw new TuvrenLineageError(
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
      throw new TuvrenLineageError(
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
      throw new TuvrenLineageError(
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
    loopState: LoopState,
    stableHeadTurnNodeHash?: HashString
  ): Promise<boolean> {
    if (resolution.type !== "handoff") {
      return false;
    }
    let handoff:
      | {
          activeConfig: AgentConfig;
          activeToolRegistry: ToolRegistry;
        }
      | undefined;

    try {
      handoff = await this.applyHandoff(
        handle,
        schemaId,
        resolution.contextPlan,
        loopState,
        loopState.carriedStateUpdates
      );
    } catch (error: unknown) {
      if (stableHeadTurnNodeHash !== undefined) {
        await this.options.kernel.branch.setHead(
          handle.request.branchId,
          stableHeadTurnNodeHash
        );
        const restoredHeadState = await this.loadHeadState(
          handle.request.branchId
        );
        handle.updateStatus({
          activeAgent: loopState.activeConfig.name,
          manifest: restoredHeadState.manifest,
        });
      }

      throw error;
    }

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
    iterationCount: number,
    emitObservability = true
  ): Promise<
    | {
        iterationCount: number;
        manifest?: ContextManifest;
        turnNodeHash: HashString;
      }
    | undefined
  > {
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
        nextManifest,
        {
          handle,
          loopState,
        }
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

      const pendingStateObservability = {
        iterationCount,
        manifest:
          loopState.carriedStateUpdates.length === 0 ? undefined : nextManifest,
        turnNodeHash: stepResult.turnNodeHash,
      };

      if (emitObservability) {
        this.emitStateObservability(
          handle,
          loopState,
          pendingStateObservability.turnNodeHash,
          pendingStateObservability.iterationCount,
          pendingStateObservability.manifest
        );
      }

      handle.updateStatus({
        activeAgent: loopState.activeConfig.name,
        iterationCount,
        manifest: nextManifest,
        phase: "running",
      });
      loopState.carriedStateUpdates = [];
      return pendingStateObservability;
    }

    handle.updateStatus({
      activeAgent: loopState.activeConfig.name,
      iterationCount,
      manifest: nextManifest,
      phase: "running",
    });
    loopState.carriedStateUpdates = [];
    return undefined;
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

  private async reconcileCheckpointedPauseResolution(
    checkpointedPause: boolean,
    runId: string,
    turnId: string,
    resolution: RuntimeResolution
  ): Promise<RuntimeResolution> {
    if (!checkpointedPause || resolution.type === "pause") {
      return resolution;
    }

    await this.resolveCheckpointedPausedRun(runId, turnId, resolution);
    return resolution;
  }

  private async resolveCheckpointedPausedRun(
    runId: string,
    turnId: string,
    resolution: RuntimeResolution
  ): Promise<void> {
    if (resolution.type === "fail") {
      await this.options.kernel.run.complete(
        runId,
        "failed",
        await this.storeEventRecord({
          fatality: resolution.fatality,
          message: resolution.error.message,
          resolutionType: resolution.type,
          turnId,
          type: "paused_run_overridden",
        })
      );
      return;
    }

    await this.options.kernel.run.complete(
      runId,
      "failed",
      await this.storeEventRecord({
        resolutionType: resolution.type,
        turnId,
        type: "paused_run_overridden",
      })
    );
  }

  private materializeDriver(driverId: string): KrakenDriver {
    const driverEntry = this.options.driverRegistry.resolve(driverId);

    if (driverEntry === undefined) {
      throw new TuvrenRuntimeError(`driver "${driverId}" is not registered`, {
        code: "unknown_driver",
        details: {
          driverId,
        },
      });
    }

    return materializeDriver(driverEntry);
  }

  private resolveFailureActiveConfig(
    handle: RuntimeExecutionHandle
  ): AgentConfig {
    const activeAgentName =
      handle.status().activeAgent ?? handle.request.config.name;
    const resolvedActiveConfig =
      this.options.resolveAgentConfig?.(activeAgentName);

    if (resolvedActiveConfig !== undefined) {
      return resolvedActiveConfig;
    }

    if (activeAgentName === handle.request.config.name) {
      return handle.request.config;
    }

    return {
      name: activeAgentName,
    };
  }

  private async ensureSchemaId(schemaId?: string): Promise<string> {
    const resolvedSchemaId = schemaId ?? DEFAULT_AGENT_SCHEMA_ID;
    const existing = await this.options.kernel.schema.get(resolvedSchemaId);

    if (existing !== null) {
      assertFrameworkSchemaCompatibility(existing);
      return existing.schemaId;
    }

    if (resolvedSchemaId !== DEFAULT_AGENT_SCHEMA_ID) {
      throw new TuvrenRuntimeError(
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
    manifest: ContextManifest,
    warningContext?: {
      handle: RuntimeExecutionHandle;
      loopState: LoopState;
    }
  ): Promise<HashString> {
    if (warningContext !== undefined) {
      this.warnManifestExtensionStateBudgetIfNeeded(
        warningContext.handle,
        warningContext.loopState,
        runId,
        manifest
      );
    }

    const staged = await this.options.kernel.staging.stage(
      runId,
      encodeKernelRecord(manifest, "manifest"),
      "manifest",
      "context_manifest",
      "completed"
    );

    return staged.objectHash;
  }

  private warnManifestExtensionStateBudgetIfNeeded(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    runId: string,
    manifest: ContextManifest
  ): void {
    const budget = this.options.manifestExtensionStateWarningBudgetBytes;

    if (budget === false || this.options.onWarning === undefined) {
      return;
    }

    const extensionEntries = Object.entries(manifest.extensions);

    if (extensionEntries.length === 0) {
      return;
    }

    let warningKeys = this.manifestExtensionStateWarningKeys.get(handle);

    if (warningKeys === undefined) {
      warningKeys = new Set<string>();
      this.manifestExtensionStateWarningKeys.set(handle, warningKeys);
    }

    for (const [extensionName, extensionState] of extensionEntries) {
      if (warningKeys.has(extensionName)) {
        continue;
      }

      const observedBytes = approximateSerializedByteLength(extensionState);

      if (observedBytes === undefined || observedBytes <= budget) {
        continue;
      }

      warningKeys.add(extensionName);
      this.emitWarning({
        activeAgent: loopState.activeConfig.name,
        budgetBytes: budget,
        code: "manifest_extension_state_budget_exceeded",
        extensionName,
        observedBytes,
        runId,
        threadId: handle.request.threadId,
        turnId: handle.turnId,
      });
    }
  }

  private emitWarning(warning: RuntimeWarning): void {
    try {
      this.options.onWarning?.(warning);
    } catch {
      return;
    }
  }

  private async stageMessage(
    runId: string,
    message: TuvrenMessage,
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
    event: TuvrenStreamEvent,
    loopState: LoopState
  ): void {
    handle.publish(this.createPublishedEvent(handle, event, loopState));
  }

  private createPublishedEvent(
    handle: RuntimeExecutionHandle,
    event: TuvrenStreamEvent,
    loopState: LoopState
  ): TuvrenStreamEvent {
    const publishedEvent = {
      ...event,
      source: event.source ?? {
        agent: loopState.activeConfig.name,
        driver: loopState.activeDriverId,
        threadId: handle.request.threadId,
      },
    };
    assertTuvrenStreamEvent(publishedEvent, "stream event");
    return publishedEvent;
  }

  private createDriverPublishedEvent(
    handle: RuntimeExecutionHandle,
    event: TuvrenStreamEvent,
    loopState: LoopState
  ): TuvrenStreamEvent {
    assertDriverRuntimeEvent(event);
    return this.createPublishedEvent(
      handle,
      {
        ...event,
        source: {
          agent: loopState.activeConfig.name,
          driver: loopState.activeDriverId,
          threadId: handle.request.threadId,
        },
      },
      loopState
    );
  }

  private flushBufferedDriverEvents(
    handle: RuntimeExecutionHandle,
    events: TuvrenStreamEvent[]
  ): void {
    for (const event of events) {
      handle.publish(event);
    }
  }

  private flushBufferedDriverEventsIfNeeded(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    events: TuvrenStreamEvent[]
  ): TuvrenStreamEvent[] {
    if (shouldSuppressBufferedDriverEvents(resolution)) {
      return [];
    }

    this.flushBufferedDriverEvents(handle, events);
    return events;
  }

  private ensureDriverAssistantEvents(
    handle: RuntimeExecutionHandle,
    messages: TuvrenMessage[],
    emittedEvents: TuvrenStreamEvent[],
    loopState: LoopState
  ): TuvrenStreamEvent[] {
    const assistantMessage = messages.find(
      (message): message is Extract<TuvrenMessage, { role: "assistant" }> =>
        message.role === "assistant"
    );

    if (
      assistantMessage === undefined ||
      emittedEvents.some((event) => isAssistantContentStreamEvent(event.type))
    ) {
      return [];
    }

    return this.synthesizeAssistantMessageEvents(assistantMessage).map(
      (event) => this.createPublishedEvent(handle, event, loopState)
    );
  }

  private synthesizeAssistantMessageEvents(
    message: Extract<TuvrenMessage, { role: "assistant" }>
  ): TuvrenStreamEvent[] {
    const messageId = this.createId();
    const events: TuvrenStreamEvent[] = [
      {
        messageId,
        role: "assistant",
        timestamp: this.now(),
        type: "message.start",
      },
    ];

    for (const part of message.parts) {
      switch (part.type) {
        case "file":
          events.push({
            data:
              typeof part.data === "string"
                ? part.data
                : new Uint8Array(part.data),
            filename: part.filename,
            mediaType: part.mediaType,
            messageId,
            timestamp: this.now(),
            type: "file.done",
          });
          break;
        case "reasoning":
          if (!part.redacted) {
            events.push({
              delta: part.text,
              messageId,
              timestamp: this.now(),
              type: "reasoning.delta",
            });
          }

          events.push({
            messageId,
            timestamp: this.now(),
            type: "reasoning.done",
          });
          break;
        case "structured":
          events.push({
            delta: serializeAssistantDeltaValue(part.data),
            messageId,
            timestamp: this.now(),
            type: "structured.delta",
          });
          events.push({
            data: cloneValue(part.data),
            messageId,
            name: part.name,
            timestamp: this.now(),
            type: "structured.done",
          });
          break;
        case "text":
          events.push({
            delta: part.text,
            messageId,
            timestamp: this.now(),
            type: "text.delta",
          });
          events.push({
            messageId,
            text: part.text,
            timestamp: this.now(),
            type: "text.done",
          });
          break;
        case "tool_call":
          events.push({
            callId: part.callId,
            messageId,
            name: part.name,
            timestamp: this.now(),
            type: "tool_call.start",
          });
          events.push({
            callId: part.callId,
            delta: serializeAssistantDeltaValue(part.input),
            timestamp: this.now(),
            type: "tool_call.args_delta",
          });
          events.push({
            callId: part.callId,
            input: cloneValue(part.input),
            name: part.name,
            timestamp: this.now(),
            type: "tool_call.done",
          });
          break;
        default:
          break;
      }
    }

    events.push({
      finishReason: inferFinishReason(message),
      messageId,
      timestamp: this.now(),
      type: "message.done",
    });
    return events;
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

export function createTuvrenRuntimeCore(
  options: RuntimeCoreOptions
): TuvrenRuntime {
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
  requestTools: TuvrenToolDefinition[] | undefined,
  config: AgentConfig
): ToolRegistry {
  const activeTools = requestTools ?? config.tools ?? [];

  return createToolRegistry(activeTools, config.extensions ?? []);
}

function resolveActiveMaxParallelToolCalls(
  config: AgentConfig,
  defaultMaxParallelToolCalls: number
): number {
  return normalizeMaxParallelToolCalls(
    config.maxParallelToolCalls ?? defaultMaxParallelToolCalls,
    "AgentConfig.maxParallelToolCalls"
  );
}

function normalizeMaxParallelToolCalls(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TuvrenRuntimeError(`${label} must be a positive safe integer`, {
      code: "invalid_runtime_options",
      details: {
        [label]: value,
      },
    });
  }

  return value;
}

function normalizeManifestExtensionStateWarningBudget(
  value: false | number
): false | number {
  if (value === false) {
    return false;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TuvrenRuntimeError(
      "manifestExtensionStateWarningBudgetBytes must be false or a positive safe integer",
      {
        code: "invalid_runtime_options",
        details: {
          manifestExtensionStateWarningBudgetBytes: value,
        },
      }
    );
  }

  return value;
}

function approximateSerializedByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);

    if (serialized === undefined) {
      return undefined;
    }

    return serializedByteLengthEncoder.encode(serialized).byteLength;
  } catch {
    return undefined;
  }
}

function createReadonlyDriverToolRegistry(
  registry: ToolRegistry
): ToolRegistry {
  const cachedRegistry = readonlyDriverToolRegistryCache.get(registry);

  if (cachedRegistry !== undefined) {
    return cachedRegistry;
  }

  // Drivers only inspect a frozen tool snapshot here. Framework-owned execution
  // always goes through the live registry used by the shared tool executor.
  // The WeakMap cache relies on the active tool registry being immutable for
  // the execution segment after runtime-core builds it.
  const toolSnapshots = registry
    .list()
    .map((tool) =>
      createFrozenSnapshot(createDriverToolDefinitionSnapshot(tool))
    );
  const toolsByName = new Map(toolSnapshots.map((tool) => [tool.name, tool]));
  const renderedDefinitions = registry
    .toDefinitions()
    .map((tool) => cloneValue(tool));

  const readonlyRegistry = Object.freeze({
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
      throw new TuvrenRuntimeError(
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
  readonlyDriverToolRegistryCache.set(registry, readonlyRegistry);
  return readonlyRegistry;
}

function createDriverAgentConfigSnapshot(config: AgentConfig): AgentConfig {
  return createFrozenSnapshot({
    ...config,
    extensions: config.extensions?.map((extension) => ({
      ...extension,
      tools: extension.tools?.map((tool) =>
        createDriverToolDefinitionSnapshot(tool)
      ),
    })),
    tools: config.tools?.map((tool) =>
      createDriverToolDefinitionSnapshot(tool)
    ),
  });
}

function createDriverToolDefinitionSnapshot(
  tool: TuvrenToolDefinition
): TuvrenToolDefinition {
  return {
    approval: tool.approval,
    description: tool.description,
    execute() {
      throw new TuvrenRuntimeError(
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
    timeout: tool.timeout,
  };
}

function cloneAgentConfigForRequest(config: AgentConfig): AgentConfig {
  return cloneSnapshotPreservingFunctions(config);
}

function encodeKernelRecord(value: unknown, label: string): Uint8Array {
  assertKernelRecord(value, label);
  return encodeDeterministicKernelRecord(value);
}

function collectInitialExtensionStateUpdates(
  extensions: TuvrenExtension[],
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
  messages: TuvrenMessage[]
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
    .update("tuvren-runtime-pending:")
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
    throw new TuvrenLineageError(`branch "${branchId}" does not exist`, {
      code: "missing_branch",
    });
  }

  const turnNode = await kernel.node.get(branch.headTurnNodeHash);

  if (turnNode === null) {
    throw new TuvrenLineageError(
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
    throw new TuvrenLineageError(
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

  throw new TuvrenLineageError(
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
  message: Extract<TuvrenMessage, { role: "assistant" }>
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
): TuvrenMessage {
  const decoded = decodeDeterministicKernelRecord(payload);
  assertTuvrenMessage(decoded, label);
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
    error:
      handle.abortSignal.reason instanceof Error
        ? handle.abortSignal.reason
        : createExecutionCancelledError(),
    fatality: "hard",
    type: "fail",
  };
}

function shouldSuppressBufferedDriverEvents(
  resolution: RuntimeResolution
): boolean {
  if (resolution.type !== "fail" || resolution.fatality !== "hard") {
    return false;
  }

  if (!isRecord(resolution.error)) {
    return false;
  }

  const code = resolution.error.code;

  return (
    typeof code === "string" &&
    (code === "invalid_driver_result" ||
      code === "invalid_driver_resolution" ||
      code === "invalid_stream_event")
  );
}

function isAssistantContentStreamEvent(
  type: TuvrenStreamEvent["type"]
): boolean {
  switch (type) {
    case "message.start":
    case "text.delta":
    case "text.done":
    case "reasoning.delta":
    case "reasoning.done":
    case "file.done":
    case "structured.delta":
    case "structured.done":
    case "tool_call.start":
    case "tool_call.args_delta":
    case "tool_call.done":
    case "message.done":
      return true;
    default:
      return false;
  }
}

function isAssistantValidationEvent(type: TuvrenStreamEvent["type"]): boolean {
  switch (type) {
    case "message.start":
    case "text.done":
    case "reasoning.done":
    case "file.done":
    case "structured.done":
    case "tool_call.start":
    case "tool_call.done":
    case "message.done":
      return true;
    default:
      return false;
  }
}

function assertDriverRuntimeEvent(event: TuvrenStreamEvent): void {
  switch (event.type) {
    case "custom":
    case "message.start":
    case "text.delta":
    case "text.done":
    case "reasoning.delta":
    case "reasoning.done":
    case "file.done":
    case "structured.delta":
    case "structured.done":
    case "tool_call.start":
    case "tool_call.args_delta":
    case "tool_call.done":
    case "message.done":
      return;
    default:
      throw new TuvrenRuntimeError(
        `drivers must not emit shared-core event type "${event.type}" directly`,
        {
          code: "invalid_stream_event",
          details: {
            eventType: event.type,
          },
        }
      );
  }
}

function validateDriverAssistantEvents(
  messages: TuvrenMessage[],
  emittedEvents: TuvrenStreamEvent[],
  resolution: RuntimeResolution,
  assistantEventReconciliation: DriverAssistantEventReconciliation | undefined,
  activeExtensions: TuvrenExtension[]
): TuvrenRuntimeError | undefined {
  const assistantEvents = emittedEvents.filter((event) =>
    isAssistantContentStreamEvent(event.type)
  );

  if (assistantEvents.length === 0) {
    if (assistantEventReconciliation !== undefined) {
      return new TuvrenRuntimeError(
        "assistantEventReconciliation requires emitted assistant content events",
        {
          code: "invalid_stream_event",
        }
      );
    }

    return undefined;
  }

  const assistantMessage = messages.find(
    (message): message is Extract<TuvrenMessage, { role: "assistant" }> =>
      message.role === "assistant"
  );

  if (assistantMessage === undefined) {
    return resolution.type === "fail" && resolution.fatality === "hard"
      ? validateFailedDriverAssistantEvents(assistantEvents)
      : new TuvrenRuntimeError(
          "drivers must not emit assistant content events without returning a durable assistant message",
          {
            code: "invalid_stream_event",
          }
        );
  }

  const assistantSequencesOrError =
    splitAssistantEventSequences(assistantEvents);

  if (assistantSequencesOrError instanceof TuvrenRuntimeError) {
    return assistantSequencesOrError;
  }

  const finalAssistantSequence = assistantSequencesOrError.at(-1);

  if (finalAssistantSequence === undefined) {
    return createAssistantDeltaValidationError();
  }

  for (const sequence of assistantSequencesOrError.slice(0, -1)) {
    const sequenceValidationError =
      validateStandaloneAssistantSequence(sequence);

    if (sequenceValidationError !== undefined) {
      return sequenceValidationError;
    }
  }

  const finalSequenceMatchError = validateAssistantSequenceAgainstMessage(
    assistantMessage,
    finalAssistantSequence
  );

  if (assistantEventReconciliation === "allow_final_sequence_divergence") {
    if (
      !activeExtensions.some((extension) => extension.aroundModel !== undefined)
    ) {
      return new TuvrenRuntimeError(
        'assistantEventReconciliation "allow_final_sequence_divergence" requires an active aroundModel extension',
        {
          code: "invalid_stream_event",
        }
      );
    }

    if (finalSequenceMatchError === undefined) {
      return new TuvrenRuntimeError(
        'assistantEventReconciliation "allow_final_sequence_divergence" is only valid when the final emitted assistant sequence differs from the durable assistant message',
        {
          code: "invalid_stream_event",
        }
      );
    }

    if (
      assistantMessage.parts.some((part) => part.type === "tool_call") ||
      assistantSequenceRequestsTools(finalAssistantSequence)
    ) {
      return new TuvrenRuntimeError(
        'assistantEventReconciliation "allow_final_sequence_divergence" is not valid for tool-call assistant output',
        {
          code: "invalid_stream_event",
        }
      );
    }

    return validateStandaloneAssistantSequence(finalAssistantSequence);
  }

  return finalSequenceMatchError;
}

function validateAssistantSequenceAgainstMessage(
  assistantMessage: Extract<TuvrenMessage, { role: "assistant" }>,
  finalAssistantSequence: TuvrenStreamEvent[]
): TuvrenRuntimeError | undefined {
  const actualEvents = finalAssistantSequence.filter((event) =>
    isAssistantValidationEvent(event.type)
  );
  const messageId =
    actualEvents[0]?.type === "message.start"
      ? actualEvents[0].messageId
      : "assistant-validation";
  const expectedEvents = synthesizeAssistantValidationEvents(
    assistantMessage,
    messageId
  );

  if (actualEvents.length !== expectedEvents.length) {
    return new TuvrenRuntimeError(
      "driver-emitted assistant event sequences must be complete and match the durable assistant message",
      {
        code: "invalid_stream_event",
      }
    );
  }

  for (const [index, actualEvent] of actualEvents.entries()) {
    const expectedEvent = expectedEvents[index];

    if (
      expectedEvent === undefined ||
      !assistantValidationEventsMatch(actualEvent, expectedEvent)
    ) {
      return new TuvrenRuntimeError(
        "driver-emitted assistant events must match the durable assistant message",
        {
          code: "invalid_stream_event",
        }
      );
    }
  }

  const deltaValidationError = validateDriverAssistantDeltas(
    assistantMessage,
    finalAssistantSequence
  );

  if (deltaValidationError !== undefined) {
    return deltaValidationError;
  }

  return undefined;
}

function validateDriverAssistantDeltas(
  message: Extract<TuvrenMessage, { role: "assistant" }>,
  assistantEvents: TuvrenStreamEvent[]
): TuvrenRuntimeError | undefined {
  const state: AssistantDeltaValidationState = {
    completed: false,
    currentMessageId: undefined,
    deltaBuffer: "",
    partIndex: 0,
    sawDelta: false,
    started: false,
    toolCallStarted: false,
  };
  const expectedFinishReason = inferFinishReason(message);

  for (const event of assistantEvents) {
    const boundaryValidation = validateAssistantMessageBoundary(
      event,
      expectedFinishReason,
      state
    );

    if (boundaryValidation.handled) {
      continue;
    }

    if (boundaryValidation.error !== undefined) {
      return boundaryValidation.error;
    }

    const validationError = validateDriverAssistantDeltaEvent(
      message.parts,
      event,
      state
    );

    if (validationError !== undefined) {
      return validationError;
    }
  }

  if (
    !(state.started && state.completed) ||
    state.deltaBuffer !== "" ||
    state.sawDelta ||
    state.toolCallStarted
  ) {
    return createAssistantDeltaValidationError();
  }

  return undefined;
}

interface AssistantDeltaValidationState {
  completed: boolean;
  currentMessageId: string | undefined;
  deltaBuffer: string;
  partIndex: number;
  sawDelta: boolean;
  started: boolean;
  toolCallStarted: boolean;
}

interface AssistantBoundaryValidation {
  error?: TuvrenRuntimeError;
  handled: boolean;
}

function validateAssistantMessageBoundary(
  event: TuvrenStreamEvent,
  expectedFinishReason: TuvrenModelResponse["finishReason"],
  state: AssistantDeltaValidationState
): AssistantBoundaryValidation {
  if (!state.started) {
    if (event.type !== "message.start") {
      return {
        error: createAssistantDeltaValidationError(),
        handled: false,
      };
    }

    state.currentMessageId = event.messageId;
    state.started = true;
    return {
      handled: true,
    };
  }

  if (state.completed) {
    return {
      error: createAssistantDeltaValidationError(),
      handled: false,
    };
  }

  if (!assistantEventBelongsToCurrentMessage(event, state.currentMessageId)) {
    return {
      error: createAssistantDeltaValidationError(),
      handled: false,
    };
  }

  if (event.type === "message.start") {
    return {
      error: createAssistantDeltaValidationError(),
      handled: false,
    };
  }

  if (event.type !== "message.done") {
    return {
      handled: false,
    };
  }

  if (
    !doesFinishReasonMatchAssistantContent(
      event.finishReason,
      expectedFinishReason
    )
  ) {
    return {
      error: createAssistantDeltaValidationError(),
      handled: false,
    };
  }

  state.completed = true;
  return {
    handled: true,
  };
}

function assistantEventBelongsToCurrentMessage(
  event: TuvrenStreamEvent,
  currentMessageId: string | undefined
): boolean {
  const eventMessageId = getAssistantEventMessageId(event);

  return eventMessageId === undefined || eventMessageId === currentMessageId;
}

function getAssistantEventMessageId(
  event: TuvrenStreamEvent
): string | undefined {
  switch (event.type) {
    case "file.done":
    case "message.done":
    case "message.start":
    case "reasoning.delta":
    case "reasoning.done":
    case "structured.delta":
    case "structured.done":
    case "text.delta":
    case "text.done":
    case "tool_call.start":
      return event.messageId;
    default:
      return undefined;
  }
}

function validateDriverAssistantDeltaEvent(
  parts: Extract<TuvrenMessage, { role: "assistant" }>["parts"],
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  const currentPart = parts[state.partIndex];

  if (currentPart === undefined) {
    return createAssistantDeltaValidationError();
  }

  switch (currentPart.type) {
    case "file":
      return validateFileAssistantDeltaEvent(event, state);
    case "reasoning":
      return validateReasoningAssistantDeltaEvent(currentPart, event, state);
    case "structured":
      return validateStructuredAssistantDeltaEvent(currentPart, event, state);
    case "text":
      return validateTextAssistantDeltaEvent(currentPart, event, state);
    case "tool_call":
      return validateToolCallAssistantDeltaEvent(currentPart, event, state);
    default:
      return createAssistantDeltaValidationError();
  }
}

function validateFileAssistantDeltaEvent(
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  if (event.type !== "file.done") {
    return createAssistantDeltaValidationError();
  }

  state.partIndex += 1;
  return undefined;
}

function validateReasoningAssistantDeltaEvent(
  part: Extract<ContentPart, { type: "reasoning" }>,
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  if (event.type === "reasoning.delta") {
    state.deltaBuffer += event.delta;
    state.sawDelta = true;
    return undefined;
  }

  if (event.type !== "reasoning.done") {
    return createAssistantDeltaValidationError();
  }

  if (!part.redacted && part.text !== "" && state.deltaBuffer === "") {
    return createAssistantDeltaValidationError();
  }

  if (
    state.deltaBuffer !== "" &&
    (part.redacted || state.deltaBuffer !== part.text)
  ) {
    return createAssistantDeltaValidationError();
  }

  state.deltaBuffer = "";
  state.sawDelta = false;
  state.partIndex += 1;
  return undefined;
}

function validateStructuredAssistantDeltaEvent(
  part: Extract<ContentPart, { type: "structured" }>,
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  if (event.type === "structured.delta") {
    state.deltaBuffer += event.delta;
    state.sawDelta = true;
    return undefined;
  }

  if (event.type !== "structured.done") {
    return createAssistantDeltaValidationError();
  }

  if (
    !(
      state.sawDelta &&
      doesSerializedDeltaMatchValue(state.deltaBuffer, part.data)
    )
  ) {
    return createAssistantDeltaValidationError();
  }

  state.deltaBuffer = "";
  state.sawDelta = false;
  state.partIndex += 1;
  return undefined;
}

function validateTextAssistantDeltaEvent(
  part: Extract<ContentPart, { type: "text" }>,
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  if (event.type === "text.delta") {
    state.deltaBuffer += event.delta;
    state.sawDelta = true;
    return undefined;
  }

  if (event.type !== "text.done") {
    return createAssistantDeltaValidationError();
  }

  if (!state.sawDelta || state.deltaBuffer !== part.text) {
    return createAssistantDeltaValidationError();
  }

  state.deltaBuffer = "";
  state.sawDelta = false;
  state.partIndex += 1;
  return undefined;
}

function validateToolCallAssistantDeltaEvent(
  part: Extract<ContentPart, { type: "tool_call" }>,
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  if (!state.toolCallStarted) {
    if (event.type !== "tool_call.start") {
      return createAssistantDeltaValidationError();
    }

    if (event.callId !== part.callId || event.name !== part.name) {
      return createAssistantDeltaValidationError();
    }

    state.toolCallStarted = true;
    return undefined;
  }

  if (event.type === "tool_call.args_delta") {
    if (event.callId !== part.callId) {
      return createAssistantDeltaValidationError();
    }

    state.deltaBuffer += event.delta;
    state.sawDelta = true;
    return undefined;
  }

  if (event.type !== "tool_call.done") {
    return createAssistantDeltaValidationError();
  }

  if (
    event.callId !== part.callId ||
    event.name !== part.name ||
    !state.sawDelta ||
    !doesSerializedDeltaMatchValue(state.deltaBuffer, part.input)
  ) {
    return createAssistantDeltaValidationError();
  }

  state.deltaBuffer = "";
  state.sawDelta = false;
  state.partIndex += 1;
  state.toolCallStarted = false;
  return undefined;
}

function splitAssistantEventSequences(
  assistantEvents: TuvrenStreamEvent[]
): TuvrenRuntimeError | TuvrenStreamEvent[][] {
  const sequences: TuvrenStreamEvent[][] = [];
  let currentSequence: TuvrenStreamEvent[] | undefined;

  for (const event of assistantEvents) {
    if (event.type === "message.start") {
      if (currentSequence !== undefined) {
        return createAssistantDeltaValidationError();
      }

      currentSequence = [event];
      continue;
    }

    if (currentSequence === undefined) {
      return createAssistantDeltaValidationError();
    }

    currentSequence.push(event);

    if (event.type === "message.done") {
      sequences.push(currentSequence);
      currentSequence = undefined;
    }
  }

  if (currentSequence !== undefined || sequences.length === 0) {
    return createAssistantDeltaValidationError();
  }

  return sequences;
}

interface StandaloneAssistantActivePartState {
  deltaBuffer: string;
  kind: "reasoning" | "structured" | "text";
  sawDelta: boolean;
}

interface StandaloneAssistantToolCallState {
  callId: string;
  deltaBuffer: string;
  kind: "tool_call";
  name: string;
  sawDelta: boolean;
}

type StandaloneAssistantPartState =
  | { kind: "idle" }
  | StandaloneAssistantActivePartState
  | StandaloneAssistantToolCallState;

interface StandaloneAssistantValidationState {
  currentMessageId: string;
  partState: StandaloneAssistantPartState;
  sawToolCallPart: boolean;
}

function validateStandaloneAssistantSequence(
  assistantEvents: TuvrenStreamEvent[]
): TuvrenRuntimeError | undefined {
  const firstEvent = assistantEvents[0];
  const lastEvent = assistantEvents.at(-1);

  if (
    firstEvent?.type !== "message.start" ||
    lastEvent?.type !== "message.done"
  ) {
    return createAssistantDeltaValidationError();
  }

  const state: StandaloneAssistantValidationState = {
    currentMessageId: firstEvent.messageId,
    partState: { kind: "idle" },
    sawToolCallPart: false,
  };

  for (const event of assistantEvents.slice(1, -1)) {
    if (!assistantEventBelongsToCurrentMessage(event, state.currentMessageId)) {
      return createAssistantDeltaValidationError();
    }

    const validationError = validateStandaloneAssistantPartEvent(event, state);

    if (validationError !== undefined) {
      return validationError;
    }
  }

  if (state.partState.kind !== "idle") {
    return createAssistantDeltaValidationError();
  }

  if (
    !doesFinishReasonMatchToolCallPresence(
      lastEvent.finishReason,
      state.sawToolCallPart
    )
  ) {
    return createAssistantDeltaValidationError();
  }

  return undefined;
}

function validateFailedDriverAssistantEvents(
  assistantEvents: TuvrenStreamEvent[]
): TuvrenRuntimeError | undefined {
  let state: StandaloneAssistantValidationState | undefined;

  for (const event of assistantEvents) {
    if (state === undefined) {
      if (event.type !== "message.start") {
        return createAssistantDeltaValidationError();
      }

      state = {
        currentMessageId: event.messageId,
        partState: { kind: "idle" },
        sawToolCallPart: false,
      };
      continue;
    }

    if (!assistantEventBelongsToCurrentMessage(event, state.currentMessageId)) {
      return createAssistantDeltaValidationError();
    }

    if (event.type === "message.start") {
      return createAssistantDeltaValidationError();
    }

    if (event.type === "message.done") {
      if (
        state.partState.kind !== "idle" ||
        !doesFinishReasonMatchToolCallPresence(
          event.finishReason,
          state.sawToolCallPart
        )
      ) {
        return createAssistantDeltaValidationError();
      }

      state = undefined;
      continue;
    }

    const validationError = validateStandaloneAssistantPartEvent(event, state);

    if (validationError !== undefined) {
      return validationError;
    }
  }

  return undefined;
}

function validateStandaloneAssistantPartEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  if (event.type === "message.start" || event.type === "message.done") {
    return createAssistantDeltaValidationError();
  }

  switch (state.partState.kind) {
    case "idle":
      return validateStandaloneIdleAssistantEvent(event, state);
    case "reasoning":
      return validateStandaloneReasoningAssistantEvent(event, state);
    case "structured":
      return validateStandaloneStructuredAssistantEvent(event, state);
    case "text":
      return validateStandaloneTextAssistantEvent(event, state);
    case "tool_call":
      return validateStandaloneToolCallAssistantEvent(event, state);
    default:
      return createAssistantDeltaValidationError();
  }
}

function validateStandaloneIdleAssistantEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  switch (event.type) {
    case "file.done":
      return undefined;
    case "reasoning.delta":
      state.partState = {
        deltaBuffer: event.delta,
        kind: "reasoning",
        sawDelta: true,
      };
      return undefined;
    case "reasoning.done":
      return undefined;
    case "structured.delta":
      state.partState = {
        deltaBuffer: event.delta,
        kind: "structured",
        sawDelta: true,
      };
      return undefined;
    case "text.delta":
      state.partState = {
        deltaBuffer: event.delta,
        kind: "text",
        sawDelta: true,
      };
      return undefined;
    case "tool_call.start":
      state.partState = {
        callId: event.callId,
        deltaBuffer: "",
        kind: "tool_call",
        name: event.name,
        sawDelta: false,
      };
      state.sawToolCallPart = true;
      return undefined;
    default:
      return createAssistantDeltaValidationError();
  }
}

function validateStandaloneReasoningAssistantEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  if (state.partState.kind !== "reasoning") {
    return createAssistantDeltaValidationError();
  }

  if (event.type === "reasoning.delta") {
    state.partState.deltaBuffer += event.delta;
    state.partState.sawDelta = true;
    return undefined;
  }

  if (event.type !== "reasoning.done") {
    return createAssistantDeltaValidationError();
  }

  state.partState = { kind: "idle" };
  return undefined;
}

function validateStandaloneStructuredAssistantEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  if (state.partState.kind !== "structured") {
    return createAssistantDeltaValidationError();
  }

  if (event.type === "structured.delta") {
    state.partState.deltaBuffer += event.delta;
    state.partState.sawDelta = true;
    return undefined;
  }

  if (
    event.type !== "structured.done" ||
    !state.partState.sawDelta ||
    !doesSerializedDeltaMatchValue(state.partState.deltaBuffer, event.data)
  ) {
    return createAssistantDeltaValidationError();
  }

  state.partState = { kind: "idle" };
  return undefined;
}

function validateStandaloneTextAssistantEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  if (state.partState.kind !== "text") {
    return createAssistantDeltaValidationError();
  }

  if (event.type === "text.delta") {
    state.partState.deltaBuffer += event.delta;
    state.partState.sawDelta = true;
    return undefined;
  }

  if (
    event.type !== "text.done" ||
    !state.partState.sawDelta ||
    state.partState.deltaBuffer !== event.text
  ) {
    return createAssistantDeltaValidationError();
  }

  state.partState = { kind: "idle" };
  return undefined;
}

function validateStandaloneToolCallAssistantEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  if (state.partState.kind !== "tool_call") {
    return createAssistantDeltaValidationError();
  }

  if (event.type === "tool_call.args_delta") {
    if (event.callId !== state.partState.callId) {
      return createAssistantDeltaValidationError();
    }

    state.partState.deltaBuffer += event.delta;
    state.partState.sawDelta = true;
    return undefined;
  }

  if (
    event.type !== "tool_call.done" ||
    event.callId !== state.partState.callId ||
    event.name !== state.partState.name ||
    !state.partState.sawDelta ||
    !doesSerializedDeltaMatchValue(state.partState.deltaBuffer, event.input)
  ) {
    return createAssistantDeltaValidationError();
  }

  state.partState = { kind: "idle" };
  return undefined;
}

function synthesizeAssistantValidationEvents(
  message: Extract<TuvrenMessage, { role: "assistant" }>,
  messageId: string
): TuvrenStreamEvent[] {
  const events: TuvrenStreamEvent[] = [
    {
      messageId,
      role: "assistant",
      timestamp: 0,
      type: "message.start",
    },
  ];

  for (const part of message.parts) {
    switch (part.type) {
      case "file":
        events.push({
          data:
            typeof part.data === "string"
              ? part.data
              : new Uint8Array(part.data),
          filename: part.filename,
          mediaType: part.mediaType,
          messageId,
          timestamp: 0,
          type: "file.done",
        });
        break;
      case "reasoning":
        events.push({
          messageId,
          timestamp: 0,
          type: "reasoning.done",
        });
        break;
      case "structured":
        events.push({
          data: cloneValue(part.data),
          messageId,
          name: part.name,
          timestamp: 0,
          type: "structured.done",
        });
        break;
      case "text":
        events.push({
          messageId,
          text: part.text,
          timestamp: 0,
          type: "text.done",
        });
        break;
      case "tool_call":
        events.push({
          callId: part.callId,
          messageId,
          name: part.name,
          timestamp: 0,
          type: "tool_call.start",
        });
        events.push({
          callId: part.callId,
          input: cloneValue(part.input),
          name: part.name,
          timestamp: 0,
          type: "tool_call.done",
        });
        break;
      default:
        break;
    }
  }

  events.push({
    finishReason: inferFinishReason(message),
    messageId,
    timestamp: 0,
    type: "message.done",
  });

  return events;
}

function assistantValidationEventsMatch(
  actualEvent: TuvrenStreamEvent,
  expectedEvent: TuvrenStreamEvent
): boolean {
  if (actualEvent.type !== expectedEvent.type) {
    return false;
  }

  switch (actualEvent.type) {
    case "message.start":
      return (
        expectedEvent.type === "message.start" &&
        actualEvent.messageId === expectedEvent.messageId
      );
    case "text.done":
      return (
        expectedEvent.type === "text.done" &&
        actualEvent.messageId === expectedEvent.messageId &&
        actualEvent.text === expectedEvent.text
      );
    case "reasoning.done":
      return (
        expectedEvent.type === "reasoning.done" &&
        actualEvent.messageId === expectedEvent.messageId
      );
    case "file.done":
      return (
        expectedEvent.type === "file.done" &&
        actualEvent.messageId === expectedEvent.messageId &&
        actualEvent.filename === expectedEvent.filename &&
        actualEvent.mediaType === expectedEvent.mediaType &&
        areStreamEventValuesEqual(actualEvent.data, expectedEvent.data)
      );
    case "structured.done":
      return (
        expectedEvent.type === "structured.done" &&
        actualEvent.messageId === expectedEvent.messageId &&
        actualEvent.name === expectedEvent.name &&
        isDeepStrictEqual(actualEvent.data, expectedEvent.data)
      );
    case "tool_call.start":
      return (
        expectedEvent.type === "tool_call.start" &&
        actualEvent.messageId === expectedEvent.messageId &&
        actualEvent.callId === expectedEvent.callId &&
        actualEvent.name === expectedEvent.name
      );
    case "tool_call.done":
      return (
        expectedEvent.type === "tool_call.done" &&
        actualEvent.callId === expectedEvent.callId &&
        actualEvent.name === expectedEvent.name &&
        isDeepStrictEqual(actualEvent.input, expectedEvent.input)
      );
    case "message.done":
      return (
        expectedEvent.type === "message.done" &&
        actualEvent.messageId === expectedEvent.messageId &&
        doesFinishReasonMatchAssistantContent(
          actualEvent.finishReason,
          expectedEvent.finishReason
        )
      );
    default:
      return false;
  }
}

function doesFinishReasonMatchAssistantContent(
  actualFinishReason: TuvrenModelResponse["finishReason"],
  expectedFinishReason: TuvrenModelResponse["finishReason"]
): boolean {
  if (expectedFinishReason === "tool_call") {
    return actualFinishReason === "tool_call";
  }

  return actualFinishReason !== "tool_call";
}

function doesFinishReasonMatchToolCallPresence(
  finishReason: TuvrenModelResponse["finishReason"],
  hasToolCallPart: boolean
): boolean {
  if (hasToolCallPart) {
    return finishReason === "tool_call";
  }

  return finishReason !== "tool_call";
}

function assistantSequenceRequestsTools(events: TuvrenStreamEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === "tool_call.start" ||
      event.type === "tool_call.args_delta" ||
      event.type === "tool_call.done" ||
      (event.type === "message.done" && event.finishReason === "tool_call")
  );
}

function areStreamEventValuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        return false;
      }
    }

    return true;
  }

  return isDeepStrictEqual(left, right);
}

function doesSerializedDeltaMatchValue(
  serializedDelta: string,
  expectedValue: unknown
): boolean {
  if (typeof expectedValue === "string" && serializedDelta === expectedValue) {
    return true;
  }

  try {
    return isDeepStrictEqual(JSON.parse(serializedDelta), expectedValue);
  } catch {
    return false;
  }
}

function serializeAssistantDeltaValue(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function createAssistantDeltaValidationError(): TuvrenRuntimeError {
  return new TuvrenRuntimeError(
    "driver-emitted assistant deltas must match the durable assistant message",
    {
      code: "invalid_stream_event",
    }
  );
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
  messages: TuvrenMessage[],
  resolution: RuntimeResolution,
  emittedEvents: TuvrenStreamEvent[],
  assistantEventReconciliation: DriverAssistantEventReconciliation | undefined
): TuvrenModelResponse {
  const assistantMessage = messages.find(
    (message): message is Extract<TuvrenMessage, { role: "assistant" }> =>
      message.role === "assistant"
  );
  const lastMessageDoneEvent = findLastMessageDoneEvent(emittedEvents);

  if (assistantMessage !== undefined) {
    const durableFinishReason =
      resolution.type === "fail"
        ? "error"
        : inferFinishReason(assistantMessage);
    const finishReason =
      assistantEventReconciliation === "allow_final_sequence_divergence"
        ? durableFinishReason
        : (lastMessageDoneEvent?.finishReason ?? durableFinishReason);

    return {
      finishReason,
      parts: assistantMessage.parts,
      providerMetadata: assistantMessage.providerMetadata,
      usage: lastMessageDoneEvent?.usage,
    };
  }

  return {
    finishReason: resolution.type === "fail" ? "error" : "stop",
    parts: [],
  };
}

function findLastMessageDoneEvent(
  events: TuvrenStreamEvent[]
): Extract<TuvrenStreamEvent, { type: "message.done" }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event?.type === "message.done") {
      return event;
    }
  }

  return undefined;
}

function createRejectedApprovalResponse(
  request: ApprovalRequest
): ApprovalResponse {
  return {
    decisions: request.toolCalls.map((toolCall) => ({
      callId: toolCall.callId,
      type: "reject",
    })),
  };
}

function createApprovalRejectionResolution(): RuntimeResolution {
  return {
    reason: "approval_rejected",
    type: "end_turn",
  };
}

function toOptionalHash(value: PathValue): HashString | null {
  if (typeof value === "string") {
    return value;
  }

  if (value === null) {
    return null;
  }

  throw new TuvrenRuntimeError("expected a single-hash path value", {
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

  throw new TuvrenRuntimeError("expected an ordered hash array path value", {
    code: "invalid_path_value_shape",
    details: {
      value,
    },
  });
}

function isTurnLineageRecord(value: unknown): value is TurnLineageRecord {
  return isRecord(value) && typeof value.activeTurnId === "string";
}

function hasAssistantOutputMessages(messages: TuvrenMessage[]): boolean {
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
      throw new TuvrenRuntimeError(
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
      throw new TuvrenRuntimeError(
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
