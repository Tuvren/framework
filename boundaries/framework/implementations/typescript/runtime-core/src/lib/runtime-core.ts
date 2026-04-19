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

import { createHash } from "node:crypto";
import type {
  DriverExecutionContext,
  DriverRegistry,
  DriverResumeContext,
  KrakenDriver,
} from "@kraken/framework-driver-api";
import type {
  AgentConfig,
  ApprovalRequest,
  ApprovalResponse,
  ContextEngineeringContext,
  ContextEngineeringHelpers,
  ContextEngineeringPlan,
  ContextManifest,
  ExecutionHandle,
  ExecutionStatus,
  HandoffContextBuilder,
  HandoffContextPlan,
  HandoffSourceContext,
  InputSignal,
  KrakenErrorProjection,
  KrakenExtension,
  KrakenMessage,
  KrakenModelResponse,
  KrakenRuntime,
  KrakenStreamEvent,
  KrakenToolDefinition,
  OrchestrationHandle,
  OrchestrationRuntime,
  RuntimeResolution,
  ToolCallPart,
  ToolRegistry,
  ToolResultPart,
  TurnEndEvent,
  WorkerStatus,
} from "@kraken/framework-runtime-api";
import {
  assertApprovalRequest,
  assertApprovalResponseForRequest,
  assertContextManifest,
  assertKrakenMessage,
  assertKrakenModelResponse,
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
  createLastOutputOnlyHandoffContextBuilder,
  createPreserveTraceHandoffContextBuilder,
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
    { objectType: "runtime_status", targetPath: "runtime.status" },
  ],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
    { collection: "single", path: "runtime.status" },
  ],
  schemaId: DEFAULT_AGENT_SCHEMA_ID,
};

export interface ExecutionSessionRequest {
  branchId: string;
  config: AgentConfig;
  driverId?: string;
  parentTurnId?: string | null;
  schemaId?: string;
  signal: InputSignal;
  threadId: string;
  tools?: KrakenToolDefinition[];
}

export interface RuntimeCoreOptions {
  createId?: () => string;
  defaultDriverId: string;
  driverRegistry?: DriverRegistry;
  enableStateObservability?: boolean;
  kernel: KrakenKernel;
  now?: () => EpochMs;
  resolveAgentConfig?: (agentName: string) => AgentConfig | undefined;
  resolveNextAgent?: (agentName: string) => string | undefined;
  resolveParentTurnId?: (
    threadId: string,
    branchId: string
  ) => Promise<string | null> | string | null;
  resolveSequenceStep?: (agentName: string) => number | undefined;
  sequenceHandoffContextBuilder?: HandoffContextBuilder;
}

export interface OrchestrationRuntimeOptions
  extends Omit<RuntimeCoreOptions, "resolveAgentConfig" | "resolveNextAgent"> {
  agents: Record<string, AgentConfig>;
  entrypoint: string;
  framework?: KrakenRuntime;
  handoffContextBuilder?: HandoffContextBuilder;
  sequence?: string[];
}

interface ResolvedRuntimeCoreOptions {
  createId: () => string;
  defaultDriverId: string;
  driverRegistry: DriverRegistry;
  enableStateObservability: boolean;
  kernel: KrakenKernel;
  now: () => EpochMs;
  resolveAgentConfig?: (agentName: string) => AgentConfig | undefined;
  resolveNextAgent?: (agentName: string) => string | undefined;
  resolveParentTurnId?: (
    threadId: string,
    branchId: string
  ) => Promise<string | null> | string | null;
  resolveSequenceStep?: (agentName: string) => number | undefined;
  sequenceHandoffContextBuilder?: HandoffContextBuilder;
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

interface PausedIterationState {
  iterationCount: number;
  response: KrakenModelResponse;
  toolResults: ToolResultPart[];
}

interface PauseContext {
  activeConfig: AgentConfig;
  activeDriverId: string;
  activeToolRegistry: ToolRegistry;
  approval: ApprovalRequest;
  carriedStateUpdates: ExtensionStateUpdate[];
  kind: "driver_pause" | "tool_approval";
  pausedIteration?: PausedIterationState;
  pausedRunId: string;
  pausedTurnNodeHash: HashString;
  pauseReason: string;
}

interface ResumeContext {
  approval: ApprovalResponse;
  pauseContext: PauseContext;
  pausedRunId: string;
  pausedTurnNodeHash: HashString;
}

interface LoopOutcome {
  pauseContext?: PauseContext;
  resolution: RuntimeResolution;
}

interface HelperBundle {
  flush(): Promise<void>;
  helpers: ContextEngineeringHelpers;
  resolveHashes(hashes: HashString[]): HashString[];
}

interface WorkerRecord {
  agent: string;
  approval?: ApprovalRequest;
  branchId: string;
  handle: ExecutionHandle;
  resolveResult(value: unknown): void;
  result?: unknown;
  resultPromise: Promise<unknown>;
  sessionId: string;
  status: WorkerStatus["status"];
  threadId: string;
  workerId: string;
}

type WorkerAccess =
  | {
      kind: "live";
      worker: WorkerRecord;
    }
  | {
      kind: "retained";
      worker: WorkerStatus;
    };

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

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private closed = false;
  private readonly items: T[] = [];
  private onClose?: () => void;
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];

  constructor(onClose?: () => void) {
    this.onClose = onClose;
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }

    this.onClose?.();
    this.onClose = undefined;
  }

  push(item: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();

    if (waiter !== undefined) {
      waiter({ done: false, value: item });
      return;
    }

    this.items.push(item);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return {
            done: false,
            value: this.items.shift() as T,
          };
        }

        if (this.closed) {
          return {
            done: true,
            value: undefined,
          };
        }

        return await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({
          done: true,
          value: undefined,
        });
      },
    };
  }
}

class EventFanout<T> {
  private closed = false;
  private readonly subscribers = new Set<AsyncEventQueue<T>>();

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const subscriber of this.subscribers) {
      subscriber.close();
    }

    this.subscribers.clear();
  }

  emit(item: T): void {
    if (this.closed) {
      return;
    }

    for (const subscriber of this.subscribers) {
      subscriber.push(cloneValue(item));
    }
  }

  subscribe(): AsyncIterable<T> {
    let queue: AsyncEventQueue<T>;
    queue = new AsyncEventQueue<T>(() => {
      this.subscribers.delete(queue);
    });

    if (this.closed) {
      queue.close();
      return queue;
    }

    this.subscribers.add(queue);
    return queue;
  }
}

function detachPromise(task: Promise<unknown>): void {
  task.catch(() => undefined);
}

class RuntimeExecutionHandle implements ExecutionHandle {
  private activeRunId?: string;
  private readonly abortController = new AbortController();
  private readonly eventsFanout = new EventFanout<KrakenStreamEvent>();
  private lastErrorProjection?: KrakenErrorProjection;
  private materializedDriver?: KrakenDriver;
  private materializedDriverId?: string;
  private pauseContext?: PauseContext;
  private replacementHandle?: RuntimeExecutionHandle;
  private readonly runtime: RuntimeCore;
  private schemaIdValue: string;
  private readonly steeringQueue: InputSignal[] = [];
  private started = false;
  private statusSnapshot: ExecutionStatus;
  readonly request: ExecutionSessionRequest;
  readonly resumedFrom?: ResumeContext;
  readonly turnId: string;

  constructor(
    runtime: RuntimeCore,
    request: ExecutionSessionRequest,
    turnId: string,
    schemaId: string,
    resumedFrom?: ResumeContext
  ) {
    this.runtime = runtime;
    this.request = request;
    this.turnId = turnId;
    this.schemaIdValue = schemaId;
    this.resumedFrom = resumedFrom;
    this.statusSnapshot = {
      activeAgent: request.config.name,
      iterationCount: 0,
      phase: "running",
    };
  }

  cancel(): void {
    if (this.replacementHandle !== undefined) {
      this.replacementHandle.cancel();
      return;
    }

    this.abortController.abort();
    this.runtime.cancelPausedExecution(this);
  }

  consumeSteeringSignal(): InputSignal | undefined {
    return this.steeringQueue.shift();
  }

  events(): AsyncIterable<KrakenStreamEvent> {
    const events = this.eventsFanout.subscribe();

    if (!this.started) {
      this.started = true;
      detachPromise(this.runtime.startExecution(this));
    }

    return events;
  }

  finish(): void {
    this.eventsFanout.close();
  }

  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  getActiveRunId(): string | undefined {
    return this.activeRunId;
  }

  get schemaId(): string {
    return this.schemaIdValue;
  }

  hasStartedExecution(): boolean {
    return this.started;
  }

  publish(event: KrakenStreamEvent): void {
    this.eventsFanout.emit(event);
  }

  rememberError(error: KrakenErrorProjection): void {
    this.lastErrorProjection = error;
  }

  rememberPauseContext(context: PauseContext): void {
    this.pauseContext = context;
    this.replaceStatus({
      activeAgent: context.activeConfig.name,
      approval: context.approval,
      iterationCount: this.statusSnapshot.iterationCount,
      manifest: this.statusSnapshot.manifest,
      pauseReason: context.pauseReason,
      phase: "paused",
    });
  }

  replaceStatus(status: ExecutionStatus): void {
    this.statusSnapshot = cloneExecutionStatus(status);
  }

  setActiveRunId(runId: string): void {
    this.activeRunId = runId;
  }

  setSchemaId(schemaId: string): void {
    this.schemaIdValue = schemaId;
  }

  takeActiveRunId(): string | undefined {
    const activeRunId = this.activeRunId;
    this.activeRunId = undefined;
    return activeRunId;
  }

  takePauseContextForCancellation(): PauseContext | undefined {
    if (this.pauseContext === undefined) {
      return undefined;
    }

    const canCancelPausedExecution =
      this.statusSnapshot.phase === "paused" ||
      (!this.started &&
        this.resumedFrom !== undefined &&
        this.statusSnapshot.phase === "running");

    if (!canCancelPausedExecution) {
      return undefined;
    }

    const pauseContext = this.pauseContext;
    this.pauseContext = undefined;
    return pauseContext;
  }

  resolveApproval(response: ApprovalResponse): ExecutionHandle {
    if (
      this.statusSnapshot.phase !== "paused" ||
      this.pauseContext === undefined ||
      this.statusSnapshot.approval === undefined ||
      this.replacementHandle !== undefined
    ) {
      throw new KrakenRuntimeError(
        "resolveApproval() is only valid while execution is paused",
        {
          code: "invalid_approval_resolution",
        }
      );
    }

    assertApprovalResponseForRequest(
      response,
      this.statusSnapshot.approval,
      "response"
    );

    const resumedHandle = this.runtime.createResumedExecutionHandle(
      this,
      this.pauseContext,
      response
    );
    this.replacementHandle = resumedHandle;
    this.pauseContext = undefined;
    return resumedHandle;
  }

  status(): ExecutionStatus {
    return cloneExecutionStatus(this.statusSnapshot);
  }

  getLastErrorProjection(): KrakenErrorProjection | undefined {
    return this.lastErrorProjection;
  }

  getOrCreateDriver(
    driverId: string,
    materialize: (driverId: string) => KrakenDriver
  ): KrakenDriver {
    if (
      this.materializedDriver !== undefined &&
      this.materializedDriverId === driverId
    ) {
      return this.materializedDriver;
    }

    const driver = materialize(driverId);
    this.materializedDriver = driver;
    this.materializedDriverId = driverId;
    return driver;
  }

  steer(signal: InputSignal): void {
    if (this.statusSnapshot.phase !== "running") {
      throw new KrakenRuntimeError(
        "steer() is only valid while execution is running",
        {
          code: "invalid_steering_state",
          details: {
            phase: this.statusSnapshot.phase,
          },
        }
      );
    }

    this.steeringQueue.push(normalizeInputSignal(signal, "steering signal"));
  }

  updateStatus(patch: Partial<ExecutionStatus>): void {
    this.statusSnapshot = cloneExecutionStatus({
      ...this.statusSnapshot,
      ...patch,
    });
  }

  moveSteeringQueueTo(target: RuntimeExecutionHandle): void {
    while (this.steeringQueue.length > 0) {
      const signal = this.steeringQueue.shift();

      if (signal !== undefined) {
        target.steeringQueue.push(signal);
      }
    }
  }

  primeResumedCancellation(pauseContext: PauseContext): void {
    this.pauseContext = pauseContext;
  }

  clearPendingResumeCancellation(): void {
    if (this.statusSnapshot.phase === "running") {
      this.pauseContext = undefined;
    }
  }

  reuseDriverCache(previousHandle: RuntimeExecutionHandle): void {
    this.materializedDriver = previousHandle.materializedDriver;
    this.materializedDriverId = previousHandle.materializedDriverId;
  }
}

class RuntimeCore implements KrakenRuntime {
  private readonly options: ResolvedRuntimeCoreOptions;

  constructor(options: RuntimeCoreOptions) {
    this.options = {
      createId:
        options.createId ??
        (() =>
          globalThis.crypto?.randomUUID?.() ??
          `${Date.now()}_${Math.random().toString(16).slice(2)}`),
      defaultDriverId: options.defaultDriverId,
      driverRegistry: options.driverRegistry ?? createDriverRegistry(),
      enableStateObservability: options.enableStateObservability ?? true,
      kernel: options.kernel,
      now: options.now ?? Date.now,
      resolveAgentConfig: options.resolveAgentConfig,
      resolveNextAgent: options.resolveNextAgent,
      resolveSequenceStep: options.resolveSequenceStep,
      sequenceHandoffContextBuilder: options.sequenceHandoffContextBuilder,
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
        config: pauseContext.activeConfig,
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is the runtime's top-level turn lifecycle coordinator.
  async startExecution(handle: RuntimeExecutionHandle): Promise<void> {
    try {
      const schemaId = await this.resolveExecutionSchemaId(handle.request);
      handle.setSchemaId(schemaId);
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

      if (handle.resumedFrom === undefined) {
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
          branch.headTurnNodeHash
        );
      }

      const resumedPauseContext = handle.resumedFrom?.pauseContext;
      const loopState: LoopState = {
        activeConfig:
          resumedPauseContext?.activeConfig ?? handle.request.config,
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

      if (handle.resumedFrom === undefined) {
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

        if (beforeTurn.resolution !== undefined) {
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
          } else {
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
              loopState,
              false
            );
            return;
          }
        }
      } else {
        await this.options.kernel.run.complete(
          handle.resumedFrom.pausedRunId,
          "failed"
        );
        handle.clearPendingResumeCancellation();
        this.publishEvent(
          handle,
          {
            response: handle.resumedFrom.approval,
            timestamp: this.now(),
            type: "approval.resolved",
          },
          loopState
        );
        await this.checkpointResumeRunningStatus(
          handle,
          schemaId,
          loopState,
          handle.resumedFrom.pauseContext.pausedIteration?.iterationCount ??
            handle.status().iterationCount
        );

        if (handle.resumedFrom.pauseContext.kind === "tool_approval") {
          const resumedOutcome = await this.resumePausedToolExecution(
            handle,
            schemaId,
            loopState,
            handle.resumedFrom
          );

          if (resumedOutcome.pauseContext !== undefined) {
            handle.rememberPauseContext(resumedOutcome.pauseContext);
            this.publishEvent(
              handle,
              {
                request: resumedOutcome.pauseContext.approval,
                timestamp: this.now(),
                type: "approval.requested",
              },
              {
                ...loopState,
                activeConfig: resumedOutcome.pauseContext.activeConfig,
                activeDriverId: resumedOutcome.pauseContext.activeDriverId,
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
            return;
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
          } else if (
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
              loopState,
              true
            );
            return;
          }
        }
      }

      const outcome = await this.runExecutionLoop(handle, schemaId, loopState);

      if (outcome.pauseContext !== undefined) {
        handle.rememberPauseContext(outcome.pauseContext);
        this.publishEvent(
          handle,
          {
            request: outcome.pauseContext.approval,
            timestamp: this.now(),
            type: "approval.requested",
          },
          {
            ...loopState,
            activeConfig: outcome.pauseContext.activeConfig,
            activeDriverId: outcome.pauseContext.activeDriverId,
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
        return;
      }

      await this.completeExecution(
        handle,
        outcome.resolution,
        loopState,
        loopState.enteredIterationLoop
      );
    } catch (error: unknown) {
      const finalizationFailure =
        error instanceof FinalizationFailure ? error : undefined;
      const runtimeError = normalizeError(error);
      const rootError =
        finalizationFailure?.rootCause ??
        finalizationFailure?.finalizationError;

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
        if (finalizationFailure.rootCause === undefined) {
          this.publishProjectedError(
            handle,
            finalizationFailure.finalizationError,
            true,
            loopState
          );
        } else {
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

        return;
      }

      if ((await this.options.kernel.turn.get(handle.turnId)) !== null) {
        try {
          await this.finalizeTurnStatus(handle, failureResolution, loopState);
        } catch (finalizeError: unknown) {
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
    } finally {
      handle.finish();
    }
  }

  private async completeExecution(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
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
      await this.finalizeTurnStatus(handle, resolution, loopState);
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

    handle.replaceStatus({
      activeAgent: loopState.activeConfig.name,
      iterationCount: handle.status().iterationCount,
      manifest: handle.status().manifest,
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This loop is the shared iteration state machine for driver-neutral execution.
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

      if (handle.abortSignal.aborted) {
        return {
          resolution: {
            error: new Error("execution cancelled"),
            fatality: "hard",
            type: "fail",
          },
        };
      }

      handle.updateStatus({
        activeAgent: loopState.activeConfig.name,
        approval: undefined,
        iterationCount: nextIteration,
        pauseReason: undefined,
        phase: "running",
      });
      this.publishEvent(
        handle,
        {
          iterationCount: nextIteration,
          timestamp: this.now(),
          type: "iteration.start",
        },
        loopState
      );

      if (pendingResume === undefined) {
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

      let headState = await this.loadHeadState(handle.request.branchId);
      handle.updateStatus({
        manifest: headState.manifest,
      });

      const beforeIteration = await runBeforeIterationHooks({
        emit: (event) => {
          this.publishCustomEvent(handle, event, loopState);
        },
        extensions: loopState.activeConfig.extensions ?? [],
        iterationCount: nextIteration,
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
            nextIteration
          );
          loopState.carriedStateUpdates = [];
          this.publishEvent(
            handle,
            {
              iterationCount: nextIteration,
              timestamp: this.now(),
              type: "iteration.end",
            },
            loopState
          );
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
        nextIteration
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

      const driverContext: DriverExecutionContext = {
        branchId: handle.request.branchId,
        config: loopState.activeConfig,
        handoff: {
          createContextPlan: (input) =>
            this.createDriverHandoffContextPlan(input, headState, loopState),
        },
        iterationCount: nextIteration,
        manifest: headState.manifest,
        messages: headState.messages,
        runtime: {
          emit: (event) => {
            this.publishEvent(handle, event, loopState);
          },
          now: () => this.now(),
        },
        schemaId,
        signal: handle.abortSignal,
        threadId: handle.request.threadId,
        toolRegistry: loopState.activeToolRegistry,
        turnId: handle.turnId,
      };

      const driverResult = await this.executeDriver(
        driver,
        driverContext,
        pendingResume
      );
      pendingResume = undefined;

      let resolution = driverResult.resolution;
      const driverMessages = driverResult.messages ?? [];
      const stagedMessageHashes: HashString[] = [];
      const requestedToolCalls = extractToolCallsFromMessages(driverMessages);
      const invalidDriverResolutionError =
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
          resolution: {
            error: invalidDriverResolutionError,
            fatality: "hard",
            type: "fail",
          },
        };
      }

      const stagedMessages = [...driverMessages];
      const driverResponse =
        driverResult.response ?? synthesizeResponse(driverMessages, resolution);
      const toolResults: ToolResultPart[] = [];

      for (const [index, driverMessage] of driverMessages.entries()) {
        assertKrakenMessage(driverMessage, `driverResult.messages[${index}]`);
      }

      for (let index = 0; index < stagedMessages.length; index += 1) {
        stagedMessageHashes.push(
          await this.stageMessage(
            iterationRunId,
            stagedMessages[index],
            `message_${nextIteration}_${index}`
          )
        );
      }

      if (
        resolution.type === "continue_iteration" &&
        requestedToolCalls.length > 0
      ) {
        let toolBatch: ToolBatchOutcome;

        try {
          toolBatch = await executeToolBatch(
            requestedToolCalls,
            this.createToolBatchEnvironment(
              handle,
              loopState,
              headState.manifest,
              nextIteration,
              iterationRunId
            )
          );
        } catch (error: unknown) {
          await this.failTrackedRunWithoutBranchAdvance(
            handle,
            iterationRunId,
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

      const manifest = updateContextManifest(
        headState.manifest,
        stagedMessages,
        loopState.carriedStateUpdates
      );
      loopState.carriedStateUpdates = [];
      const manifestHash = await this.stageManifest(iterationRunId, manifest);
      const runtimeStatusHash =
        resolution.type === "pause"
          ? await this.stageRuntimeStatus(
              iterationRunId,
              {
                activeAgent: loopState.activeConfig.name,
                iterationCount: nextIteration,
                pauseReason: resolution.reason,
                state: "paused",
                turnId: handle.turnId,
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
              stagedMessageHashes,
              manifestHash,
              runtimeStatusHash
            );

      const turnNodeHash = await this.completeIterationRun(
        handle,
        iterationRunId,
        resolution,
        manifest,
        nextIteration,
        loopState,
        nextTreeHash
      );

      handle.updateStatus({
        activeAgent: driverResult.activeAgent,
        manifest,
      });

      const afterIteration = await runAfterIterationHooks({
        emit: (event) => {
          this.publishCustomEvent(handle, event, loopState);
        },
        extensions: loopState.activeConfig.extensions ?? [],
        iterationCount: nextIteration,
        manifest,
        messages: [...headState.messages, ...stagedMessages],
        resolution,
        response: driverResponse,
        runId: iterationRunId,
        toolResults,
        turnId: handle.turnId,
      });
      resolution = composeResolutions(resolution, afterIteration.resolution);
      loopState.carriedStateUpdates.push(...afterIteration.updates);

      if (resolution.type === "fail" && resolution.fatality === "soft") {
        this.publishProjectedError(handle, resolution.error, false, loopState);
      }

      if (
        loopState.activeConfig.maxIterations !== undefined &&
        nextIteration >= loopState.activeConfig.maxIterations &&
        resolution.type === "continue_iteration"
      ) {
        resolution = {
          reason: "max_iterations",
          type: "end_turn",
        };
      }

      this.publishEvent(
        handle,
        {
          iterationCount: nextIteration,
          timestamp: this.now(),
          type: "iteration.end",
        },
        loopState
      );

      if (resolution.type === "continue_iteration") {
        continue;
      }

      if (resolution.type === "fail" && resolution.fatality === "soft") {
        continue;
      }

      if (resolution.type === "pause") {
        if (turnNodeHash === undefined) {
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
            approval: resolution.approval,
            carriedStateUpdates: [...loopState.carriedStateUpdates],
            kind:
              requestedToolCalls.length > 0 ? "tool_approval" : "driver_pause",
            pauseReason: resolution.reason,
            pausedIteration:
              requestedToolCalls.length > 0
                ? {
                    iterationCount: nextIteration,
                    response: driverResponse,
                    toolResults,
                  }
                : undefined,
            pausedRunId: iterationRunId,
            pausedTurnNodeHash: turnNodeHash,
          },
          resolution,
        };
      }

      if (
        await this.applyTerminalAgentTransitionIfNeeded(
          handle,
          schemaId,
          resolution,
          loopState
        )
      ) {
        continue;
      }

      return {
        resolution,
      };
    }
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
      toolBatch.updates
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
              iterationCount: pausedIteration.iterationCount,
              pauseReason: resolution.reason,
              state: "paused",
              turnId: handle.turnId,
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
      assertDriverExecutionResult(result);
      return result;
    } catch (error: unknown) {
      return {
        activeAgent: context.config.name,
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
          type: "iteration_failed",
        }
      );
      turnNodeHash = completion.turnNodeHash;
    } else {
      const stepEventHash = await this.storeEventRecord({
        iteration: iterationCount,
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
              type: "paused",
            }
          : {
              iteration: iterationCount,
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

  private createSequenceHandoffPlan(
    headState: HeadState,
    sourceAgent: AgentConfig,
    targetAgent: AgentConfig
  ): HandoffContextPlan {
    const helperBundle = this.createContextEngineeringHelpers(
      headState.messageHashes,
      headState.messages
    );

    return {
      builder:
        this.options.sequenceHandoffContextBuilder ??
        createLastOutputOnlyHandoffContextBuilder(),
      mode: "last_output_only",
      reason: "sequence_transition",
      sourceContext: {
        handoffIntent: {
          reason: "sequence_transition",
          targetAgent: targetAgent.name,
        },
        helpers: helperBundle.helpers,
        manifest: headState.manifest,
        messages: headState.messages,
        sourceAgent,
        targetAgent,
      },
      targetAgent: targetAgent.name,
    };
  }

  private resolveDefaultHandoffContextBuilder(
    mode: string
  ): HandoffContextBuilder {
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
      )
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
    await this.stageRuntimeStatus(
      runId,
      {
        activeAgent: loopState.activeConfig.name,
        state: "running",
        turnId: handle.turnId,
      },
      "runtime_status"
    );
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "incorporate_input",
      await this.storeEventRecord({
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
    const manifest = updateContextManifest(headState.manifest, [
      steeringMessage,
    ]);

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
      "commit_extension_state"
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
        turnId: handle.turnId,
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
        state: phase,
        turnId: handle.turnId,
      },
      "runtime_status_final"
    );
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "finalize_turn_status",
      await this.storeEventRecord({
        status: phase,
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

    await this.finalizeTurnStatus(handle, failureResolution, loopState);
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
        ? readRuntimeStatusTurnId(
            await readBranchRuntimeStatus(this.options.kernel, branchId),
            branchId
          )
        : resolvedParentTurnId;
    await this.assertValidParentTurnId(threadId, branchId, parentTurnId);
    return parentTurnId;
  }

  private async assertValidParentTurnId(
    threadId: string,
    branchId: string,
    parentTurnId: string | null
  ): Promise<void> {
    const expectedParentTurnId = readRuntimeStatusTurnId(
      await readBranchRuntimeStatus(this.options.kernel, branchId),
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
    if (resolution.type === "handoff") {
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

    const sequenceTarget =
      resolution.type === "end_turn"
        ? this.options.resolveNextAgent?.(loopState.activeConfig.name)
        : undefined;

    if (sequenceTarget === undefined) {
      return false;
    }

    if (this.options.resolveAgentConfig === undefined) {
      throw new KrakenRuntimeError(
        `agent transition target "${sequenceTarget}" cannot be resolved because no agent resolver is configured`,
        {
          code: "invalid_agent_transition",
          details: {
            from: loopState.activeConfig.name,
            to: sequenceTarget,
          },
        }
      );
    }

    const targetConfig = this.options.resolveAgentConfig(sequenceTarget);

    if (targetConfig === undefined) {
      throw new KrakenRuntimeError(
        `agent transition target "${sequenceTarget}" is not defined`,
        {
          code: "invalid_agent_transition",
          details: {
            from: loopState.activeConfig.name,
            to: sequenceTarget,
          },
        }
      );
    }

    this.publishCustomEvent(
      handle,
      {
        data: {
          from: loopState.activeConfig.name,
          step:
            this.options.resolveSequenceStep?.(loopState.activeConfig.name) ??
            null,
          to: targetConfig.name,
        },
        name: "sequence.step",
      },
      loopState
    );

    const latestHeadState = await this.loadHeadState(handle.request.branchId);
    const sequencePlan = this.createSequenceHandoffPlan(
      latestHeadState,
      loopState.activeConfig,
      targetConfig
    );
    const handoff = await this.applyHandoff(
      handle,
      schemaId,
      sequencePlan,
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
        iterationCount,
        state: "running",
        turnId: handle.turnId,
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
      undefined,
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

  private async stageRuntimeStatus(
    runId: string,
    status: Record<string, unknown>,
    taskId: string
  ): Promise<HashString> {
    const staged = await this.options.kernel.staging.stage(
      runId,
      encodeKernelRecord(status, "runtime status"),
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

class OrchestrationHandleImpl implements OrchestrationHandle {
  private readonly allEventsFanout = new EventFanout<KrakenStreamEvent>();
  private allEventsClosed = false;
  private parentCompleted = false;
  private readonly parentEventsFanout = new EventFanout<KrakenStreamEvent>();
  private readonly pendingWorkerSignals: InputSignal[] = [];
  private readonly openWorkers = new Set<string>();
  private readonly retainedWorkers = new Map<string, WorkerStatus>();
  private readonly runtime: OrchestrationRuntimeImpl;
  private readonly parentHandle: ExecutionHandle;
  private started = false;
  private readonly threadId: string;
  private readonly workerEventFanouts = new Map<
    string,
    EventFanout<KrakenStreamEvent>
  >();
  readonly sessionId: string;

  constructor(
    runtime: OrchestrationRuntimeImpl,
    parentHandle: ExecutionHandle,
    sessionId: string,
    threadId: string,
    options?: {
      openWorkers?: string[];
      pendingWorkerSignals?: InputSignal[];
      retainedWorkers?: WorkerStatus[];
    }
  ) {
    this.runtime = runtime;
    this.parentHandle = parentHandle;
    this.sessionId = sessionId;
    this.threadId = threadId;
    for (const workerId of options?.openWorkers ?? []) {
      this.openWorkers.add(workerId);
    }
    for (const signal of options?.pendingWorkerSignals ?? []) {
      this.pendingWorkerSignals.push(signal);
    }
    for (const worker of options?.retainedWorkers ?? []) {
      this.retainedWorkers.set(worker.workerId, cloneWorkerStatus(worker));
    }
  }

  allEvents(): AsyncIterable<KrakenStreamEvent> {
    const events = this.allEventsFanout.subscribe();
    this.ensureStarted();
    return events;
  }

  cancel(): void {
    const phase = this.parentHandle.status().phase;
    this.parentHandle.cancel();
    this.runtime.cancelSessionWorkers(this.sessionId);

    if (phase === "paused") {
      this.closeForCancelledParent();
    }
  }

  events(): AsyncIterable<KrakenStreamEvent> {
    return this.allEvents();
  }

  emitWorkerEvent(workerId: string, event: KrakenStreamEvent): void {
    const fanout =
      this.workerEventFanouts.get(workerId) ??
      new EventFanout<KrakenStreamEvent>();
    this.workerEventFanouts.set(workerId, fanout);
    fanout.emit(event);

    if (!this.allEventsClosed) {
      this.allEventsFanout.emit(event);
    }
  }

  registerWorker(workerId: string): void {
    this.openWorkers.add(workerId);
  }

  parentEvents(): AsyncIterable<KrakenStreamEvent> {
    const events = this.parentEventsFanout.subscribe();
    this.ensureStarted();
    return events;
  }

  queueWorkerSignal(signal: InputSignal): void {
    this.pendingWorkerSignals.push(signal);
  }

  belongsToRuntime(runtime: OrchestrationRuntimeImpl): boolean {
    return this.runtime === runtime;
  }

  getParentThreadId(): string {
    return this.threadId;
  }

  hasStartedExecution(): boolean {
    return this.started;
  }

  resolveApproval(response: ApprovalResponse): OrchestrationHandle {
    const resumedParentHandle = this.parentHandle.resolveApproval(response);
    const resumedHandle = new OrchestrationHandleImpl(
      this.runtime,
      resumedParentHandle,
      this.sessionId,
      this.threadId,
      {
        openWorkers: [...this.openWorkers],
        pendingWorkerSignals: [...this.pendingWorkerSignals],
        retainedWorkers: [...this.retainedWorkers.values()],
      }
    );
    this.runtime.setCurrentHandle(resumedHandle);
    this.closeForResume();
    resumedHandle.flushQueuedWorkerSignals();
    return resumedHandle;
  }

  status(): ExecutionStatus {
    return this.parentHandle.status();
  }

  steer(signal: InputSignal): void {
    this.parentHandle.steer(signal);
  }

  private flushQueuedWorkerSignals(): void {
    while (
      this.pendingWorkerSignals.length > 0 &&
      this.parentHandle.status().phase === "running"
    ) {
      const signal = this.pendingWorkerSignals.shift();

      if (signal !== undefined) {
        this.parentHandle.steer(signal);
      }
    }
  }

  workerEvents(workerId: string): AsyncIterable<KrakenStreamEvent> {
    const fanout =
      this.workerEventFanouts.get(workerId) ??
      new EventFanout<KrakenStreamEvent>();
    this.workerEventFanouts.set(workerId, fanout);
    const events = fanout.subscribe();
    this.ensureStarted();
    return events;
  }

  workers(): ReadonlyMap<string, WorkerStatus> {
    const snapshot = new Map(this.runtime.getWorkerStatuses(this.sessionId));

    for (const [workerId, status] of this.retainedWorkers) {
      snapshot.set(workerId, cloneWorkerStatus(status));
    }

    return snapshot;
  }

  getRetainedWorkerStatus(workerId: string): WorkerStatus | undefined {
    const status = this.retainedWorkers.get(workerId);
    return status === undefined ? undefined : cloneWorkerStatus(status);
  }

  retainWorkerStatus(status: WorkerStatus): void {
    this.retainedWorkers.set(status.workerId, cloneWorkerStatus(status));
  }

  private async watchParent(): Promise<void> {
    const observedHandle = this.parentHandle;

    for await (const event of observedHandle.events()) {
      const parentEvent = stripEventSource(event);
      this.parentEventsFanout.emit(parentEvent);
      this.allEventsFanout.emit(event);
    }

    if (observedHandle.status().phase === "paused") {
      this.closeForPausedParent();
      return;
    }

    this.parentCompleted = true;
    this.parentEventsFanout.close();
    this.closeAllEventsIfSettled();
  }

  workerFinished(workerId: string): void {
    this.openWorkers.delete(workerId);
    const fanout =
      this.workerEventFanouts.get(workerId) ??
      new EventFanout<KrakenStreamEvent>();
    this.workerEventFanouts.set(workerId, fanout);
    fanout.close();
    this.closeAllEventsIfSettled();
  }

  private closeAllEventsIfSettled(): void {
    if (
      this.allEventsClosed ||
      !this.parentCompleted ||
      this.openWorkers.size > 0
    ) {
      return;
    }

    this.allEventsClosed = true;
    this.allEventsFanout.close();
    this.runtime.releaseHandle(this);
  }

  private closeForResume(): void {
    this.parentCompleted = true;
    this.parentEventsFanout.close();
    this.allEventsClosed = true;
    this.allEventsFanout.close();
    this.closeWorkerEventFanouts();
    this.runtime.releaseHandle(this);
  }

  private closeForCancelledParent(): void {
    if (this.parentCompleted && this.allEventsClosed) {
      return;
    }

    this.parentCompleted = true;
    this.parentEventsFanout.close();
    this.allEventsClosed = true;
    this.allEventsFanout.close();
    this.closeWorkerEventFanouts();
    this.runtime.releaseHandle(this);
  }

  private closeForPausedParent(): void {
    if (this.allEventsClosed) {
      return;
    }

    this.parentEventsFanout.close();
    this.allEventsClosed = true;
    this.allEventsFanout.close();
  }

  private closeWorkerEventFanouts(): void {
    for (const fanout of this.workerEventFanouts.values()) {
      fanout.close();
    }

    this.workerEventFanouts.clear();
  }

  private ensureStarted(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    detachPromise(this.watchParent());
  }
}

class OrchestrationRuntimeImpl implements OrchestrationRuntime {
  private currentHandle?: OrchestrationHandleImpl;
  private readonly agents: Record<string, AgentConfig>;
  private readonly delegateDriverSelectionToFramework: boolean;
  private readonly defaultDriverId?: string;
  private readonly entrypoint: string;
  private readonly framework: KrakenRuntime;
  private readonly kernel: KrakenKernel;
  private readonly now: () => EpochMs;
  private readonly sessionHandles = new Map<string, OrchestrationHandleImpl>();
  private readonly workers = new Map<string, WorkerRecord>();

  constructor(
    framework: KrakenRuntime,
    kernel: KrakenKernel,
    agents: Record<string, AgentConfig>,
    entrypoint: string,
    now: () => EpochMs,
    delegateDriverSelectionToFramework: boolean,
    defaultDriverId?: string
  ) {
    this.framework = framework;
    this.kernel = kernel;
    this.agents = agents;
    this.entrypoint = entrypoint;
    this.now = now;
    this.delegateDriverSelectionToFramework =
      delegateDriverSelectionToFramework;
    this.defaultDriverId = defaultDriverId;
  }

  async awaitWorker(
    workerId: string,
    options?: { parent: OrchestrationHandle }
  ): Promise<unknown> {
    const workerAccess = this.requireWorkerAccess(
      workerId,
      options?.parent,
      "awaitWorker"
    );
    return workerAccess.kind === "live"
      ? await workerAccess.worker.resultPromise
      : workerAccess.worker.result;
  }

  cancel(): void {
    for (const handle of [...this.sessionHandles.values()]) {
      handle.cancel();
    }
  }

  cancelWorkers(): void {
    for (const worker of this.workers.values()) {
      if (worker.status === "running") {
        worker.handle.cancel();
      }
    }
  }

  cancelSessionWorkers(sessionId: string): void {
    for (const worker of this.workers.values()) {
      if (worker.sessionId !== sessionId) {
        continue;
      }

      if (worker.status === "running") {
        worker.handle.cancel();
        continue;
      }

      if (worker.status === "paused" && worker.approval !== undefined) {
        this.resolveWorkerApprovalForSession(
          worker.sessionId,
          worker.workerId,
          {
            decisions: worker.approval.toolCalls.map((toolCall) => ({
              callId: toolCall.callId,
              message: "Worker cancelled while awaiting approval.",
              type: "reject",
            })),
          }
        );
        worker.handle.cancel();
      }
    }
  }

  executeTurn(input: {
    branchId: string;
    driverId?: string;
    parentTurnId?: string | null;
    schemaId?: string;
    signal: InputSignal;
    threadId: string;
    tools?: KrakenToolDefinition[];
  }): OrchestrationHandle {
    const config = this.agents[this.entrypoint];

    if (config === undefined) {
      throw new KrakenRuntimeError(
        `entrypoint agent "${this.entrypoint}" is not defined`,
        {
          code: "unknown_orchestration_entrypoint",
        }
      );
    }

    const parentDriverId =
      input.driverId ??
      (this.delegateDriverSelectionToFramework
        ? undefined
        : this.defaultDriverId);
    const parentHandle = this.framework.executeTurn({
      ...input,
      config,
      ...(parentDriverId === undefined ? {} : { driverId: parentDriverId }),
    });
    const orchestrationHandle = new OrchestrationHandleImpl(
      this,
      parentHandle,
      this.createId(),
      input.threadId
    );
    this.setCurrentHandle(orchestrationHandle);
    return orchestrationHandle;
  }

  setCurrentHandle(handle: OrchestrationHandleImpl): void {
    this.currentHandle = handle;
    this.sessionHandles.set(handle.sessionId, handle);
  }

  releaseHandle(handle: OrchestrationHandleImpl): void {
    if (this.currentHandle === handle) {
      this.currentHandle = undefined;
    }

    if (this.sessionHandles.get(handle.sessionId) === handle) {
      this.sessionHandles.delete(handle.sessionId);
    }
  }

  resolveWorkerApproval(
    workerId: string,
    response: ApprovalResponse,
    options?: { parent: OrchestrationHandle }
  ): void {
    const workerAccess = this.requireWorkerAccess(
      workerId,
      options?.parent,
      "resolveWorkerApproval"
    );

    if (workerAccess.kind !== "live") {
      throw new KrakenRuntimeError(
        `worker "${workerId}" is not awaiting approval`,
        {
          code: "invalid_approval_resolution",
          details: {
            status: workerAccess.worker.status,
            workerId,
          },
        }
      );
    }

    const { worker } = workerAccess;

    if (worker.status !== "paused" || worker.approval === undefined) {
      throw new KrakenRuntimeError(
        `worker "${workerId}" is not awaiting approval`,
        {
          code: "invalid_approval_resolution",
          details: {
            status: worker.status,
            workerId,
          },
        }
      );
    }

    const resumedHandle = worker.handle.resolveApproval(response);
    worker.approval = undefined;
    worker.handle = resumedHandle;
    worker.status = "running";
    detachPromise(this.watchWorker(worker));
  }

  private resolveWorkerApprovalForSession(
    sessionId: string,
    workerId: string,
    response: ApprovalResponse
  ): void {
    const worker = this.requireWorker(workerId);

    if (worker.sessionId !== sessionId) {
      throw new KrakenRuntimeError(
        "internal worker approval attempted against the wrong orchestration session",
        {
          code: "orchestration_worker_parent_mismatch",
          details: {
            sessionId,
            workerId,
            workerSessionId: worker.sessionId,
          },
        }
      );
    }

    if (worker.status !== "paused" || worker.approval === undefined) {
      throw new KrakenRuntimeError(
        `worker "${workerId}" is not awaiting approval`,
        {
          code: "invalid_approval_resolution",
          details: {
            status: worker.status,
            workerId,
          },
        }
      );
    }

    const resumedHandle = worker.handle.resolveApproval(response);
    worker.approval = undefined;
    worker.handle = resumedHandle;
    worker.status = "running";
    detachPromise(this.watchWorker(worker));
  }

  getWorkerStatuses(sessionId: string): ReadonlyMap<string, WorkerStatus> {
    const snapshot = new Map<string, WorkerStatus>();

    for (const [workerId, worker] of this.workers) {
      if (worker.sessionId !== sessionId) {
        continue;
      }

      snapshot.set(workerId, {
        agent: worker.agent,
        approval: cloneValue(worker.approval),
        result: cloneValue(worker.result),
        status: worker.status,
        threadId: worker.threadId,
        workerId,
      });
    }

    return snapshot;
  }

  async launchWorker(
    agent: string,
    task: unknown,
    options?: { parent: OrchestrationHandle }
  ): Promise<string> {
    const config = this.agents[agent];
    const parentHandle = this.resolveLaunchParentHandle(options?.parent);
    const normalizedTask = normalizeWorkerTask(task);

    if (config === undefined) {
      throw new KrakenRuntimeError(`worker agent "${agent}" is not defined`, {
        code: "unknown_worker_agent",
        details: {
          agent,
        },
      });
    }

    const workerSchemaId = await this.resolveWorkerSchemaId(parentHandle);
    const thread = await this.framework.createThread({
      schemaId: workerSchemaId,
    });
    const workerId = thread.threadId;
    const deferred = createDeferred<unknown>();
    const workerDriverId = this.delegateDriverSelectionToFramework
      ? undefined
      : this.defaultDriverId;
    const handle = this.framework.executeTurn({
      branchId: thread.branchId,
      config,
      signal: normalizedTask,
      threadId: thread.threadId,
      ...(workerDriverId === undefined ? {} : { driverId: workerDriverId }),
    });
    const record: WorkerRecord = {
      agent,
      branchId: thread.branchId,
      handle,
      resolveResult: deferred.resolve,
      resultPromise: deferred.promise,
      sessionId: parentHandle.sessionId,
      status: "running",
      threadId: thread.threadId,
      workerId,
    };
    this.workers.set(workerId, record);
    parentHandle.registerWorker(workerId);
    parentHandle.emitWorkerEvent(workerId, {
      data: {
        agent,
        task,
        threadId: thread.threadId,
        workerId,
      },
      name: "worker.launched",
      source: {
        agent,
        threadId: thread.threadId,
        workerId,
      },
      timestamp: this.now(),
      type: "custom",
    });
    detachPromise(this.watchWorker(record));
    return workerId;
  }

  private async resolveWorkerSchemaId(
    parentHandle: OrchestrationHandleImpl
  ): Promise<string> {
    const parentThreadId = parentHandle.getParentThreadId();
    const frameworkThread = await this.framework.getThread(parentThreadId);
    const kernelThread = await this.kernel.thread.get(parentThreadId);

    if (frameworkThread === null || kernelThread === null) {
      throw new KrakenRuntimeError(
        "orchestration framework and kernel must agree on the parent thread before launching workers",
        {
          code: "invalid_orchestration_framework",
          details: {
            frameworkThreadMissing: frameworkThread === null,
            kernelThreadMissing: kernelThread === null,
            parentThreadId,
          },
        }
      );
    }

    if (
      frameworkThread.threadId !== kernelThread.threadId ||
      frameworkThread.schemaId !== kernelThread.schemaId ||
      frameworkThread.rootTurnNodeHash !== kernelThread.rootTurnNodeHash
    ) {
      throw new KrakenRuntimeError(
        "orchestration framework and kernel must reference the same parent thread state",
        {
          code: "invalid_orchestration_framework",
          details: {
            frameworkThread,
            kernelThread,
            parentThreadId,
          },
        }
      );
    }

    return frameworkThread.schemaId;
  }

  private async watchWorker(worker: WorkerRecord): Promise<void> {
    let lastError: KrakenErrorProjection | undefined;
    let completedTerminalWatch = false;
    let sessionHandle: OrchestrationHandleImpl | undefined;

    try {
      for await (const event of worker.handle.events()) {
        if (event.type === "error") {
          lastError = event.error;
        }

        this.resolveSessionHandle(worker.sessionId)?.emitWorkerEvent(
          worker.workerId,
          {
            ...event,
            source: {
              ...(event.source ?? {}),
              agent: worker.agent,
              threadId: worker.threadId,
              workerId: worker.workerId,
            },
          }
        );
      }

      const phase = worker.handle.status().phase;

      if (phase === "paused") {
        worker.approval = worker.handle.status().approval;
        worker.status = "paused";
        return;
      }

      completedTerminalWatch = true;
      sessionHandle = this.resolveSessionHandle(worker.sessionId);
      worker.approval = undefined;
      worker.status = phase === "failed" ? "failed" : "completed";

      try {
        worker.result = await this.resolveWorkerResult(worker, lastError);
      } catch (error: unknown) {
        worker.status = "failed";
        worker.result = projectError(normalizeError(error));
        this.emitWorkerLifecycleError(sessionHandle, worker, error);
      }

      worker.resolveResult(worker.result);
      sessionHandle?.retainWorkerStatus(createWorkerStatusSnapshot(worker));

      try {
        sessionHandle?.emitWorkerEvent(worker.workerId, {
          data: {
            agent: worker.agent,
            result: worker.result,
            status: worker.status,
            threadId: worker.threadId,
            workerId: worker.workerId,
          },
          name: "worker.completed",
          source: {
            agent: worker.agent,
            threadId: worker.threadId,
            workerId: worker.workerId,
          },
          timestamp: this.now(),
          type: "custom",
        });

        if (worker.status === "completed" || worker.status === "failed") {
          const signal = createWorkerResultSignal(worker, worker.result);

          if (sessionHandle?.status().phase === "running") {
            sessionHandle.steer(signal);
          } else if (sessionHandle?.status().phase === "paused") {
            sessionHandle.queueWorkerSignal(signal);
          }
        }
      } catch (error: unknown) {
        this.emitWorkerLifecycleError(sessionHandle, worker, error);
      }
    } catch (error: unknown) {
      completedTerminalWatch = true;
      sessionHandle = this.resolveSessionHandle(worker.sessionId);
      worker.approval = undefined;
      worker.status = "failed";
      worker.result = projectError(normalizeError(error));
      worker.resolveResult(worker.result);
      sessionHandle?.retainWorkerStatus(createWorkerStatusSnapshot(worker));
      this.emitWorkerLifecycleError(sessionHandle, worker, error);
    } finally {
      if (completedTerminalWatch) {
        this.workers.delete(worker.workerId);
        sessionHandle?.workerFinished(worker.workerId);
      }
    }
  }

  private async resolveWorkerResult(
    worker: WorkerRecord,
    lastError: KrakenErrorProjection | undefined
  ): Promise<unknown> {
    const messages = await readBranchMessages(this.kernel, worker.branchId);
    const projectedOutput = extractWorkerOutput(messages);
    const handleError =
      "getLastErrorProjection" in worker.handle &&
      typeof worker.handle.getLastErrorProjection === "function"
        ? worker.handle.getLastErrorProjection()
        : undefined;

    if (worker.handle.status().phase === "failed") {
      return (
        lastError ??
        handleError ??
        projectedOutput ?? {
          message: `worker "${worker.workerId}" failed`,
        }
      );
    }

    return projectedOutput;
  }

  private createId(): string {
    return (
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}_${Math.random().toString(16).slice(2)}`
    );
  }

  private requireWorker(workerId: string): WorkerRecord {
    const worker = this.workers.get(workerId);

    if (worker === undefined) {
      throw new KrakenRuntimeError(`worker "${workerId}" is not known`, {
        code: "unknown_worker",
        details: {
          workerId,
        },
      });
    }

    return worker;
  }

  private requireWorkerAccess(
    workerId: string,
    parent: OrchestrationHandle | undefined,
    methodName: "awaitWorker" | "resolveWorkerApproval"
  ): WorkerAccess {
    const liveWorker = this.workers.get(workerId);

    if (parent !== undefined) {
      const parentHandle = this.requireRuntimeParentHandle(parent, methodName);

      if (liveWorker !== undefined) {
        if (parentHandle.sessionId !== liveWorker.sessionId) {
          throw new KrakenRuntimeError(
            `${methodName}() requires the worker's owning parent handle`,
            {
              code: "orchestration_worker_parent_mismatch",
              details: {
                methodName,
                parentSessionId: parentHandle.sessionId,
                workerId,
                workerSessionId: liveWorker.sessionId,
              },
            }
          );
        }

        return {
          kind: "live",
          worker: liveWorker,
        };
      }

      const retainedWorker = parentHandle.getRetainedWorkerStatus(workerId);

      if (retainedWorker !== undefined) {
        return {
          kind: "retained",
          worker: retainedWorker,
        };
      }

      throw new KrakenRuntimeError(`worker "${workerId}" is not known`, {
        code: "unknown_worker",
        details: {
          workerId,
        },
      });
    }

    if (liveWorker === undefined) {
      throw new KrakenRuntimeError(
        `${methodName}() requires { parent } for workers from closed orchestration sessions`,
        {
          code: "orchestration_worker_parent_required",
          details: {
            methodName,
            workerId,
          },
        }
      );
    }

    if (this.countActiveOrchestrationSessions() > 1) {
      throw new KrakenRuntimeError(
        `${methodName}() requires { parent } when multiple orchestration sessions exist`,
        {
          code: "orchestration_worker_session_ambiguous",
          details: {
            methodName,
            workerId,
          },
        }
      );
    }

    if (!this.sessionHandles.has(liveWorker.sessionId)) {
      throw new KrakenRuntimeError(
        `${methodName}() requires { parent } for workers from closed orchestration sessions`,
        {
          code: "orchestration_worker_parent_required",
          details: {
            methodName,
            workerId,
          },
        }
      );
    }

    return {
      kind: "live",
      worker: liveWorker,
    };
  }

  private emitWorkerLifecycleError(
    sessionHandle: OrchestrationHandleImpl | undefined,
    worker: WorkerRecord,
    error: unknown
  ): void {
    if (sessionHandle === undefined) {
      return;
    }

    try {
      sessionHandle.emitWorkerEvent(worker.workerId, {
        error: projectError(normalizeError(error)),
        fatal: false,
        source: {
          agent: worker.agent,
          threadId: worker.threadId,
          workerId: worker.workerId,
        },
        timestamp: this.now(),
        type: "error",
      });
    } catch {
      return;
    }
  }

  private countActiveOrchestrationSessions(): number {
    return this.sessionHandles.size;
  }

  private requireRuntimeParentHandle(
    parent: OrchestrationHandle,
    methodName: string
  ): OrchestrationHandleImpl {
    if (
      parent instanceof OrchestrationHandleImpl &&
      parent.belongsToRuntime(this)
    ) {
      return parent;
    }

    throw new KrakenRuntimeError(
      `${methodName}() requires a parent handle created by this orchestration runtime`,
      {
        code: "invalid_orchestration_parent",
      }
    );
  }

  private resolveSessionHandle(
    sessionId: string
  ): OrchestrationHandleImpl | undefined {
    return this.sessionHandles.get(sessionId);
  }

  private resolveLaunchParentHandle(
    parent: OrchestrationHandle | undefined
  ): OrchestrationHandleImpl {
    if (parent instanceof OrchestrationHandleImpl) {
      if (!parent.belongsToRuntime(this)) {
        throw new KrakenRuntimeError(
          "launchWorker() requires a parent handle created by this orchestration runtime",
          {
            code: "invalid_orchestration_parent",
          }
        );
      }
      this.assertLaunchableParentHandle(parent);
      return parent;
    }

    if (parent !== undefined) {
      throw new KrakenRuntimeError(
        "launchWorker() requires a parent handle created by this orchestration runtime",
        {
          code: "invalid_orchestration_parent",
        }
      );
    }

    if (this.sessionHandles.size === 1) {
      const iterator = this.sessionHandles.values().next();

      if (!iterator.done) {
        this.assertLaunchableParentHandle(iterator.value);
        return iterator.value;
      }
    }

    throw new KrakenRuntimeError(
      this.sessionHandles.size === 0
        ? "launchWorker() requires an active orchestration handle"
        : "launchWorker() requires an explicit parent handle when multiple orchestration sessions are active",
      {
        code:
          this.sessionHandles.size === 0
            ? "orchestration_parent_missing"
            : "orchestration_parent_ambiguous",
      }
    );
  }

  private assertLaunchableParentHandle(
    parentHandle: OrchestrationHandleImpl
  ): void {
    if (!parentHandle.hasStartedExecution()) {
      throw new KrakenRuntimeError(
        "launchWorker() requires the parent handle to start execution first",
        {
          code: "orchestration_parent_not_started",
        }
      );
    }

    const phase = parentHandle.status().phase;

    if (phase !== "running" && phase !== "paused") {
      throw new KrakenRuntimeError(
        "launchWorker() requires a running or paused parent handle",
        {
          code: "orchestration_parent_inactive",
          details: {
            phase,
          },
        }
      );
    }
  }
}

export function createKrakenRuntimeCore(
  options: RuntimeCoreOptions
): KrakenRuntime {
  return new RuntimeCore(options);
}

export function createOrchestrationRuntime(
  options: OrchestrationRuntimeOptions
): OrchestrationRuntime {
  validateOrchestrationConfiguration(
    options.agents,
    options.entrypoint,
    options.sequence
  );
  const framework =
    options.framework ??
    createKrakenRuntimeCore({
      createId: options.createId,
      defaultDriverId: options.defaultDriverId,
      driverRegistry: options.driverRegistry,
      enableStateObservability: options.enableStateObservability,
      kernel: options.kernel,
      now: options.now,
      resolveAgentConfig: (agentName) => options.agents[agentName],
      resolveNextAgent: buildSequenceResolver(options.sequence),
      resolveSequenceStep: buildSequenceStepResolver(options.sequence),
      sequenceHandoffContextBuilder: options.handoffContextBuilder,
      resolveParentTurnId: options.resolveParentTurnId,
    });

  return new OrchestrationRuntimeImpl(
    framework,
    options.kernel,
    options.agents,
    options.entrypoint,
    options.now ?? Date.now,
    options.framework !== undefined,
    options.defaultDriverId
  );
}

function validateOrchestrationConfiguration(
  agents: Record<string, AgentConfig>,
  entrypoint: string,
  sequence: string[] | undefined
): void {
  if (!(entrypoint in agents)) {
    throw new KrakenRuntimeError(
      `entrypoint agent "${entrypoint}" is not defined`,
      {
        code: "unknown_orchestration_entrypoint",
      }
    );
  }

  if (sequence === undefined || sequence.length === 0) {
    return;
  }

  const seenAgents = new Set<string>();

  for (const agentName of sequence) {
    if (!(agentName in agents)) {
      throw new KrakenRuntimeError(
        `orchestration sequence agent "${agentName}" is not defined`,
        {
          code: "invalid_orchestration_sequence",
          details: {
            agentName,
            entrypoint,
            sequence,
          },
        }
      );
    }

    if (seenAgents.has(agentName)) {
      throw new KrakenRuntimeError(
        `orchestration sequences must not repeat agent "${agentName}"`,
        {
          code: "invalid_orchestration_sequence",
          details: {
            agentName,
            sequence,
          },
        }
      );
    }

    seenAgents.add(agentName);
  }

  if (sequence[0] !== entrypoint) {
    throw new KrakenRuntimeError(
      `orchestration sequence must start with entrypoint agent "${entrypoint}"`,
      {
        code: "invalid_orchestration_sequence",
        details: {
          entrypoint,
          firstSequenceAgent: sequence[0],
          sequence,
        },
      }
    );
  }
}

function buildSequenceResolver(
  sequence: string[] | undefined
): ((agentName: string) => string | undefined) | undefined {
  if (sequence === undefined || sequence.length < 2) {
    return undefined;
  }

  return (agentName: string) => {
    const index = sequence.indexOf(agentName);

    if (index === -1 || index + 1 >= sequence.length) {
      return undefined;
    }

    return sequence[index + 1];
  };
}

function buildSequenceStepResolver(
  sequence: string[] | undefined
): ((agentName: string) => number | undefined) | undefined {
  if (sequence === undefined || sequence.length < 2) {
    return undefined;
  }

  return (agentName: string) => {
    const index = sequence.indexOf(agentName);

    if (index === -1 || index + 1 >= sequence.length) {
      return undefined;
    }

    return index + 2;
  };
}

function cloneExecutionStatus(status: ExecutionStatus): ExecutionStatus {
  return {
    activeAgent: status.activeAgent,
    approval: cloneValue(status.approval),
    iterationCount: status.iterationCount,
    manifest: cloneValue(status.manifest),
    pauseReason: status.pauseReason,
    phase: status.phase,
  };
}

function cloneWorkerStatus(status: WorkerStatus): WorkerStatus {
  return {
    agent: status.agent,
    approval: cloneValue(status.approval),
    result: cloneValue(status.result),
    status: status.status,
    threadId: status.threadId,
    workerId: status.workerId,
  };
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });

  return {
    promise,
    resolve(value: T) {
      resolveValue?.(value);
    },
  };
}

function createWorkerStatusSnapshot(worker: WorkerRecord): WorkerStatus {
  return {
    agent: worker.agent,
    approval: cloneValue(worker.approval),
    result: cloneValue(worker.result),
    status: worker.status,
    threadId: worker.threadId,
    workerId: worker.workerId,
  };
}

function createActiveToolRegistry(
  requestTools: KrakenToolDefinition[] | undefined,
  config: AgentConfig
): ToolRegistry {
  const activeTools = requestTools ?? config.tools ?? [];

  return createToolRegistry(activeTools, config.extensions ?? []);
}

function cloneValue<T>(value: T): T {
  return globalThis.structuredClone(value);
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
      state: { ...extension.state },
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
  return createHash("sha256")
    .update("kraken-runtime-pending:")
    .update(value)
    .digest("hex");
}

async function readBranchMessages(
  kernel: KrakenKernel,
  branchId: string
): Promise<KrakenMessage[]> {
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

  const messageHashes = toOrderedHashArray(
    await kernel.tree.resolve(turnNode.turnTreeHash, "messages")
  );
  const messages: KrakenMessage[] = [];

  for (const hash of messageHashes) {
    messages.push(await readKernelMessage(kernel, hash));
  }

  return messages;
}

async function readBranchRuntimeStatus(
  kernel: KrakenKernel,
  branchId: string
): Promise<Record<string, unknown> | null> {
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

  const runtimeStatusHash = toOptionalHash(
    await kernel.tree.resolve(turnNode.turnTreeHash, "runtime.status")
  );

  if (runtimeStatusHash === null) {
    return null;
  }

  const payload = await kernel.store.get(runtimeStatusHash);

  if (payload === null) {
    throw new KrakenLineageError(
      `runtime status "${runtimeStatusHash}" does not exist`,
      {
        code: "missing_runtime_status",
        details: {
          hash: runtimeStatusHash,
        },
      }
    );
  }

  const status = decodeDeterministicKernelRecord(payload);
  return isRecord(status) ? status : null;
}

async function readKernelMessage(
  kernel: KrakenKernel,
  hash: HashString
): Promise<KrakenMessage> {
  const payload = await kernel.store.get(hash);

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

function extractWorkerOutput(messages: KrakenMessage[]): unknown {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role === "assistant" || message.role === "tool") {
      return projectMessageOutput(message);
    }
  }

  return undefined;
}

function projectMessageOutput(
  message: Extract<KrakenMessage, { role: "assistant" | "tool" }>
): unknown {
  if (message.parts.length === 1) {
    return projectContentPart(message.parts[0]);
  }

  return message.parts.map((part) => projectContentPart(part));
}

function projectContentPart(
  part: Extract<KrakenMessage, { role: "assistant" | "tool" }>["parts"][number]
): unknown {
  switch (part.type) {
    case "file":
      return {
        data: part.data,
        filename: part.filename,
        mediaType: part.mediaType,
        type: part.type,
      };
    case "reasoning":
      return {
        redacted: part.redacted,
        text: part.text,
        type: part.type,
      };
    case "structured":
      return part.data;
    case "text":
      return part.text;
    case "tool_call":
      return {
        callId: part.callId,
        input: part.input,
        name: part.name,
        type: part.type,
      };
    case "tool_result":
      return {
        callId: part.callId,
        isError: part.isError,
        name: part.name,
        output: part.output,
        type: part.type,
      };
    default:
      return part;
  }
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

function readRuntimeStatusTurnId(
  runtimeStatus: Record<string, unknown> | null,
  branchId: string
): string | null {
  if (runtimeStatus === null) {
    return null;
  }

  if (typeof runtimeStatus.turnId === "string") {
    return runtimeStatus.turnId;
  }

  throw new KrakenLineageError(
    `runtime status for branch "${branchId}" must carry a turnId`,
    {
      code: "invalid_runtime_status",
      details: {
        branchId,
        runtimeStatus,
      },
    }
  );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectError(error: Error): KrakenErrorProjection {
  const errorRecord = isRecord(error) ? error : undefined;

  return {
    code:
      errorRecord !== undefined && typeof errorRecord.code === "string"
        ? errorRecord.code
        : undefined,
    details:
      errorRecord === undefined
        ? undefined
        : sanitizeErrorDetails(errorRecord.details),
    message: error.message,
  };
}

function sanitizeErrorDetails(details: unknown): unknown {
  if (details === undefined) {
    return undefined;
  }

  try {
    assertKernelRecord(details, "error details");
    return cloneValue(details);
  } catch {
    return undefined;
  }
}

function normalizeWorkerTask(task: unknown): InputSignal {
  if (
    task !== null &&
    typeof task === "object" &&
    "parts" in task &&
    Array.isArray(task.parts)
  ) {
    return normalizeInputSignal(
      {
        parts: task.parts,
      },
      "worker task"
    );
  }

  return normalizeInputSignal(
    {
      parts: [
        {
          data: task,
          name: "worker_task",
          type: "structured",
        },
      ],
    },
    "worker task"
  );
}

function normalizeInputSignal(signal: InputSignal, label: string): InputSignal {
  const candidateMessage: unknown = {
    parts: cloneValue(signal.parts),
    role: "user",
  };
  assertKrakenMessage(candidateMessage, label);

  if (candidateMessage.role !== "user") {
    throw new KrakenRuntimeError(
      "input signals must normalize to user messages",
      {
        code: "invalid_input_signal",
      }
    );
  }

  return {
    parts: candidateMessage.parts,
  };
}

function assertDriverExecutionResult(result: unknown): asserts result is {
  activeAgent: string;
  messages?: KrakenMessage[];
  resolution: RuntimeResolution;
} {
  if (!isRecord(result) || typeof result.activeAgent !== "string") {
    throw new KrakenRuntimeError("driver result must include activeAgent", {
      code: "invalid_driver_result",
      details: result,
    });
  }

  if ("messages" in result && result.messages !== undefined) {
    if (!Array.isArray(result.messages)) {
      throw new KrakenRuntimeError("driver result messages must be an array", {
        code: "invalid_driver_result",
        details: result,
      });
    }

    for (const [index, message] of result.messages.entries()) {
      assertKrakenMessage(message, `driverResult.messages[${index}]`);
    }
  }

  if ("response" in result && result.response !== undefined) {
    assertKrakenModelResponse(result.response, "driverResult.response");
  }

  assertRuntimeResolution(result.resolution);
}

function assertRuntimeResolution(
  resolution: unknown
): asserts resolution is RuntimeResolution {
  if (!isRecord(resolution) || typeof resolution.type !== "string") {
    throw new KrakenRuntimeError(
      "driver result must include a valid resolution",
      {
        code: "invalid_driver_result",
        details: resolution,
      }
    );
  }

  switch (resolution.type) {
    case "continue_iteration":
      return;
    case "end_turn":
      if (typeof resolution.reason === "string") {
        return;
      }
      break;
    case "pause":
      if (typeof resolution.reason === "string" && "approval" in resolution) {
        assertApprovalRequest(
          resolution.approval,
          "driverResult.resolution.approval"
        );
        return;
      }
      break;
    case "handoff":
      if (typeof resolution.targetAgent === "string") {
        assertDriverHandoffContextPlan(
          resolution.contextPlan,
          "driverResult.resolution.contextPlan"
        );
        return;
      }
      break;
    case "fail":
      if (
        resolution.error instanceof Error &&
        (resolution.fatality === "hard" || resolution.fatality === "soft")
      ) {
        return;
      }
      break;
    default:
      break;
  }

  throw new KrakenRuntimeError("driver returned an invalid resolution", {
    code: "invalid_driver_result",
    details: resolution,
  });
}

function assertDriverHandoffContextPlan(
  plan: unknown,
  label: string
): asserts plan is HandoffContextPlan {
  if (
    !isRecord(plan) ||
    typeof plan.targetAgent !== "string" ||
    typeof plan.reason !== "string" ||
    typeof plan.mode !== "string" ||
    typeof plan.builder !== "function" ||
    !isRecord(plan.sourceContext)
  ) {
    throw new KrakenRuntimeError(`${label} must be a valid handoff plan`, {
      code: "invalid_driver_result",
      details: plan,
    });
  }

  assertDriverHandoffSourceContext(
    plan.sourceContext,
    `${label}.sourceContext`
  );
}

function assertDriverHandoffSourceContext(
  sourceContext: unknown,
  label: string
): asserts sourceContext is HandoffSourceContext {
  if (!isRecord(sourceContext)) {
    throw new KrakenRuntimeError(`${label} must be a valid handoff source`, {
      code: "invalid_driver_result",
      details: sourceContext,
    });
  }

  if (!Array.isArray(sourceContext.messages)) {
    throw new KrakenRuntimeError(`${label}.messages must be an array`, {
      code: "invalid_driver_result",
      details: sourceContext,
    });
  }

  for (const [index, message] of sourceContext.messages.entries()) {
    assertKrakenMessage(message, `${label}.messages[${index}]`);
  }

  assertContextManifest(sourceContext.manifest, `${label}.manifest`);

  if (
    !isRecord(sourceContext.handoffIntent) ||
    typeof sourceContext.handoffIntent.targetAgent !== "string" ||
    !isRecord(sourceContext.sourceAgent) ||
    typeof sourceContext.sourceAgent.name !== "string" ||
    !isRecord(sourceContext.targetAgent) ||
    typeof sourceContext.targetAgent.name !== "string" ||
    !isRecord(sourceContext.helpers) ||
    typeof sourceContext.helpers.loadMessage !== "function" ||
    typeof sourceContext.helpers.storeMessage !== "function" ||
    typeof sourceContext.helpers.storeMessages !== "function"
  ) {
    throw new KrakenRuntimeError(`${label} must be a valid handoff source`, {
      code: "invalid_driver_result",
      details: sourceContext,
    });
  }
}

function decodeKrakenMessageRecord(
  payload: Uint8Array,
  label: string
): KrakenMessage {
  const decoded = decodeDeterministicKernelRecord(payload);
  assertKrakenMessage(decoded, label);
  return decoded;
}

function createWorkerResultSignal(
  worker: WorkerRecord,
  output: unknown
): InputSignal {
  return {
    parts: [
      {
        data: {
          agent: worker.agent,
          output: sanitizeSignalValue(output),
          status: worker.status,
          workerId: worker.workerId,
        },
        name: "worker_result",
        type: "structured",
      },
    ],
  };
}

function sanitizeSignalValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Uint8Array
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSignalValue(entry));
  }

  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        sanitized[key] = sanitizeSignalValue(entry);
      }
    }

    return sanitized;
  }

  return String(value);
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

function stripEventSource<T extends KrakenStreamEvent>(event: T): T {
  if (event.source === undefined) {
    return event;
  }

  const { source: _source, ...rest } = event;
  return rest as T;
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
