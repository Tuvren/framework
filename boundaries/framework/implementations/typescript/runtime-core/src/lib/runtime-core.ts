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
} from "@kraken/framework-runtime-api";
import { assertApprovalResponseForRequest } from "@kraken/framework-runtime-api";
import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  type KrakenKernel,
  type PathValue,
  type TurnNode,
  type TurnTreeSchema,
} from "@kraken/kernel-contract-protocol";
import {
  assertKernelRecord,
  type EpochMs,
  type HashString,
  KrakenLineageError,
  KrakenRuntimeError,
} from "@kraken/shared-core-types";
import {
  createContextManifest,
  createEmptyContextManifest,
  createLastOutputOnlyHandoffContextBuilder,
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
  kind: "driver_pause" | "tool_approval";
  pausedIteration?: PausedIterationState;
  pausedRunId: string;
  pausedTurnNodeHash: HashString;
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
}

interface WorkerRecord {
  agent: string;
  handle: ExecutionHandle;
  resolveResult(value: unknown): void;
  result?: unknown;
  resultPromise: Promise<unknown>;
  status: "running" | "completed" | "failed";
  threadId: string;
  workerId: string;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private closed = false;
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
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
      subscriber.push(item);
    }
  }

  subscribe(): AsyncIterable<T> {
    const queue = new AsyncEventQueue<T>();

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
  private readonly abortController = new AbortController();
  private readonly eventsFanout = new EventFanout<KrakenStreamEvent>();
  private pauseContext?: PauseContext;
  private readonly runtime: RuntimeCore;
  private readonly steeringQueue: InputSignal[] = [];
  private started = false;
  private statusSnapshot: ExecutionStatus;
  readonly request: ExecutionSessionRequest;
  readonly resumedFrom?: ResumeContext;
  readonly schemaId: string;
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
    this.schemaId = schemaId;
    this.resumedFrom = resumedFrom;
    this.statusSnapshot = {
      activeAgent: request.config.name,
      iterationCount: 0,
      phase: "running",
    };
  }

  cancel(): void {
    this.abortController.abort();
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

  publish(event: KrakenStreamEvent): void {
    this.eventsFanout.emit(event);
  }

  rememberPauseContext(context: PauseContext): void {
    this.pauseContext = context;
    this.replaceStatus({
      activeAgent: context.activeConfig.name,
      approval: context.approval,
      iterationCount: this.statusSnapshot.iterationCount,
      manifest: this.statusSnapshot.manifest,
      pauseReason: "approval_required",
      phase: "paused",
    });
  }

  replaceStatus(status: ExecutionStatus): void {
    this.statusSnapshot = cloneExecutionStatus(status);
  }

  resolveApproval(response: ApprovalResponse): ExecutionHandle {
    if (
      this.statusSnapshot.phase !== "paused" ||
      this.pauseContext === undefined ||
      this.statusSnapshot.approval === undefined
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

    return this.runtime.createResumedExecutionHandle(
      this,
      this.pauseContext,
      response
    );
  }

  status(): ExecutionStatus {
    return cloneExecutionStatus(this.statusSnapshot);
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

    this.steeringQueue.push(signal);
  }

  updateStatus(patch: Partial<ExecutionStatus>): void {
    this.statusSnapshot = cloneExecutionStatus({
      ...this.statusSnapshot,
      ...patch,
    });
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
    return new RuntimeExecutionHandle(
      this,
      request,
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
    handle.replaceStatus({
      activeAgent: pauseContext.activeConfig.name,
      iterationCount: previousHandle.status().iterationCount,
      manifest: previousHandle.status().manifest,
      phase: "running",
    });
    return handle;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is the runtime's top-level turn lifecycle coordinator.
  async startExecution(handle: RuntimeExecutionHandle): Promise<void> {
    try {
      const schemaId = await this.resolveExecutionSchemaId(handle.request);
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

      const loopState: LoopState = {
        activeConfig: handle.request.config,
        activeDriverId: handle.request.driverId ?? this.options.defaultDriverId,
        activeToolRegistry: createToolRegistry(
          handle.request.tools ?? handle.request.config.tools ?? [],
          handle.request.config.extensions ?? []
        ),
        carriedStateUpdates: [],
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
        this.publishEvent(
          handle,
          {
            response: handle.resumedFrom.approval,
            timestamp: this.now(),
            type: "approval.resolved",
          },
          loopState
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
          } else if (resumedOutcome.resolution.type !== "continue_iteration") {
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
      const runtimeError = normalizeError(error);
      const loopState: LoopState = {
        activeConfig: handle.request.config,
        activeDriverId: handle.request.driverId ?? this.options.defaultDriverId,
        activeToolRegistry: createToolRegistry(
          handle.request.tools ?? handle.request.config.tools ?? [],
          handle.request.config.extensions ?? []
        ),
        carriedStateUpdates: [],
        enteredIterationLoop: false,
      };
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
      await runAfterTurnHooks({
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
    }

    await this.finalizeTurnStatus(handle, resolution, loopState);
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
          loopState.carriedStateUpdates
        );
        loopState.carriedStateUpdates = [];
        headState = await this.loadHeadState(handle.request.branchId);
      }

      const driver = this.resolveDriver(loopState.activeDriverId);
      const iterationRunId = this.createId();

      await this.options.kernel.run.create(
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
      const stagedMessages = [...driverMessages];
      const driverResponse = synthesizeResponse(driverMessages, resolution);
      const requestedToolCalls = extractToolCallsFromMessages(driverMessages);
      const toolResults: ToolResultPart[] = [];

      for (let index = 0; index < stagedMessages.length; index += 1) {
        await this.stageMessage(
          iterationRunId,
          stagedMessages[index],
          `message_${nextIteration}_${index}`
        );
      }

      if (
        requestedToolCalls.length > 0 &&
        resolution.type !== "continue_iteration"
      ) {
        resolution = {
          error: new KrakenRuntimeError(
            "drivers must not return executable tool calls with a terminal resolution",
            {
              code: "invalid_driver_resolution",
              details: {
                resolutionType: resolution.type,
                toolCallCount: requestedToolCalls.length,
              },
            }
          ),
          fatality: "hard",
          type: "fail",
        };
      } else if (
        resolution.type === "continue_iteration" &&
        requestedToolCalls.length > 0
      ) {
        const toolBatch = await executeToolBatch(
          requestedToolCalls,
          this.createToolBatchEnvironment(
            handle,
            loopState,
            headState.manifest,
            nextIteration,
            iterationRunId
          )
        );
        toolResults.push(...toolBatch.results);
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
      await this.stageManifest(iterationRunId, manifest);

      if (resolution.type === "pause") {
        await this.stageRuntimeStatus(
          iterationRunId,
          {
            activeAgent: driverResult.activeAgent,
            iterationCount: nextIteration,
            pauseReason: resolution.reason,
            state: "paused",
          },
          "runtime_status"
        );
      }

      const turnNodeHash = await this.completeIterationRun(
        handle,
        iterationRunId,
        resolution,
        manifest,
        nextIteration,
        loopState
      );

      handle.updateStatus({
        activeAgent: driverResult.activeAgent,
        manifest,
      });

      if (resolution.type !== "pause") {
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
          this.publishProjectedError(
            handle,
            resolution.error,
            false,
            loopState
          );
        }
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
            kind:
              requestedToolCalls.length > 0 ? "tool_approval" : "driver_pause",
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
        continue;
      }

      const sequenceTarget = this.options.resolveNextAgent?.(
        loopState.activeConfig.name
      );

      if (
        resolution.type === "end_turn" &&
        sequenceTarget !== undefined &&
        this.options.resolveAgentConfig !== undefined
      ) {
        const targetConfig = this.options.resolveAgentConfig(sequenceTarget);

        if (targetConfig !== undefined) {
          const latestHeadState = await this.loadHeadState(
            handle.request.branchId
          );
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
          continue;
        }
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

    await this.options.kernel.run.create(
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
    await this.stageRuntimeStatus(
      runId,
      {
        activeAgent: loopState.activeConfig.name,
        iterationCount: pausedIteration.iterationCount,
        state: "running",
      },
      "runtime_status_running"
    );

    const toolBatch = await resumeToolBatch(
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
    const resumedMessages = toolBatch.results.map((result) => ({
      parts: [result],
      role: "tool",
    })) satisfies KrakenMessage[];
    const manifest = updateContextManifest(
      headState.manifest,
      resumedMessages,
      toolBatch.updates
    );
    await this.stageManifest(runId, manifest);

    let resolution: RuntimeResolution =
      toolBatch.approval === undefined
        ? { type: "continue_iteration" }
        : {
            approval: toolBatch.approval,
            reason: "approval_required",
            type: "pause",
          };

    if (resolution.type === "pause") {
      await this.stageRuntimeStatus(
        runId,
        {
          activeAgent: loopState.activeConfig.name,
          iterationCount: pausedIteration.iterationCount,
          pauseReason: resolution.reason,
          state: "paused",
        },
        "runtime_status_paused"
      );
    }

    const turnNodeHash = await this.completeIterationRun(
      handle,
      runId,
      resolution,
      manifest,
      pausedIteration.iterationCount,
      loopState
    );

    handle.updateStatus({
      activeAgent: loopState.activeConfig.name,
      iterationCount: pausedIteration.iterationCount,
      manifest,
    });

    if (resolution.type === "pause") {
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
          kind: "tool_approval",
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
      runId,
      signal: handle.abortSignal,
      stageResult: async (result) => {
        await this.stageMessage(
          runId,
          {
            parts: [result],
            role: "tool",
          },
          `tool_message_${result.callId}`
        );
      },
      threadId: handle.request.threadId,
      toolRegistry: loopState.activeToolRegistry,
      turnId: handle.turnId,
    };
  }

  private async executeDriver(
    driver: KrakenDriver,
    context: DriverExecutionContext,
    resumeContext: ResumeContext | undefined
  ) {
    try {
      return resumeContext === undefined
        ? await driver.execute(context)
        : await driver.resume({
            ...context,
            approval: resumeContext.approval,
            resumedFrom: resumeContext.pausedTurnNodeHash,
          } satisfies DriverResumeContext);
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
    loopState: LoopState
  ): Promise<HashString | undefined> {
    let turnNodeHash: HashString | undefined;

    if (resolution.type === "fail" && resolution.fatality === "hard") {
      const completion = await this.options.kernel.run.complete(
        runId,
        "failed"
      );
      turnNodeHash = completion.turnNodeHash;
    } else {
      const stepResult = await this.options.kernel.run.completeStep(
        runId,
        "iterate"
      );
      const completion = await this.options.kernel.run.complete(
        runId,
        resolution.type === "pause" ? "paused" : "completed"
      );
      turnNodeHash = stepResult.turnNodeHash ?? completion.turnNodeHash;
    }

    if (turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(handle.turnId, turnNodeHash);
      await this.emitStateObservability(
        handle,
        loopState,
        turnNodeHash,
        manifest,
        iterationCount
      );
    }

    return turnNodeHash;
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
    const manifest = updateContextManifest(headState.manifest, [userMessage]);

    await this.options.kernel.run.create(
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
      },
      "runtime_status"
    );
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "incorporate_input"
    );
    await this.options.kernel.run.complete(runId, "completed");

    if (stepResult.turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(
        handle.turnId,
        stepResult.turnNodeHash
      );
      await this.emitStateObservability(
        handle,
        loopState,
        stepResult.turnNodeHash,
        manifest,
        0
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

    await this.options.kernel.run.create(
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
    await this.stageMessage(runId, steeringMessage, "steering_message");
    await this.stageManifest(runId, manifest);
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "incorporate_steering"
    );
    await this.options.kernel.run.complete(runId, "completed");

    if (stepResult.turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(
        handle.turnId,
        stepResult.turnNodeHash
      );
      await this.emitStateObservability(
        handle,
        loopState,
        stepResult.turnNodeHash,
        manifest,
        handle.status().iterationCount
      );
    }

    handle.updateStatus({
      manifest,
    });
    this.publishEvent(
      handle,
      {
        messageId: stepResult.turnNodeHash ?? this.createId(),
        timestamp: this.now(),
        type: "steering.incorporated",
      },
      loopState
    );
  }

  private async applyContextEngineeringPlan(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    plan: ContextEngineeringPlan,
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

    const nextMessages = nextMessageHashes
      .map((hash) => helperBundle.helpers.loadMessage(hash))
      .filter((message): message is KrakenMessage => message !== null);
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
        messages: nextMessageHashes,
      },
      headState.turnNode.turnTreeHash
    );

    await this.options.kernel.run.create(
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
      undefined,
      undefined,
      nextTreeHash
    );
    await this.options.kernel.run.complete(runId, "completed");
    if (stepResult.turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(
        handle.turnId,
        stepResult.turnNodeHash
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
    const nextMessages = nextMessageHashes
      .map((hash) => helperBundle.helpers.loadMessage(hash))
      .filter((message): message is KrakenMessage => message !== null);
    const nextManifest = updateContextManifest(
      createContextManifest(nextMessages, headState.manifest.extensions),
      [],
      updates
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
        messages: nextMessageHashes,
      },
      headState.turnNode.turnTreeHash
    );
    const runId = this.createId();
    await this.options.kernel.run.create(
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
      undefined,
      undefined,
      nextTreeHash
    );
    await this.options.kernel.run.complete(runId, "completed");

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
        nextManifest,
        handle.status().iterationCount
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
      activeToolRegistry: createToolRegistry(
        targetConfig.tools ?? [],
        targetConfig.extensions ?? []
      ),
    };
  }

  private createContextEngineeringHelpers(
    messageHashes: HashString[],
    messages: KrakenMessage[]
  ): HelperBundle {
    const kernel = this.options.kernel;
    const existingMessages = new Map<HashString, KrakenMessage>();
    const pendingMessages = new Map<HashString, KrakenMessage>();
    const pendingRecords = new Map<HashString, Uint8Array>();

    for (let index = 0; index < messageHashes.length; index += 1) {
      existingMessages.set(messageHashes[index], messages[index]);
    }

    return {
      async flush() {
        for (const record of pendingRecords.values()) {
          await kernel.store.put(record);
        }
      },
      helpers: {
        loadMessage(hash) {
          return (
            pendingMessages.get(hash) ?? existingMessages.get(hash) ?? null
          );
        },
        storeMessage(message) {
          const encoded = encodeKernelRecord(message, "message");
          const hash = hashRecord(encoded);
          pendingMessages.set(hash, message);
          pendingRecords.set(hash, encoded);
          return hash;
        },
        storeMessages(messagesToStore) {
          return messagesToStore.map((message) => {
            const encoded = encodeKernelRecord(message, "message");
            const hash = hashRecord(encoded);
            pendingMessages.set(hash, message);
            pendingRecords.set(hash, encoded);
            return hash;
          });
        },
      },
    };
  }

  private async finalizeTurnStatus(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    loopState: LoopState
  ): Promise<void> {
    const phase = resolutionToPhase(resolution);
    const headState = await this.loadHeadState(handle.request.branchId);
    const runId = this.createId();
    await this.options.kernel.run.create(
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
        state: phase,
      },
      "runtime_status_final"
    );
    const stepResult = await this.options.kernel.run.completeStep(
      runId,
      "finalize_turn_status"
    );
    await this.options.kernel.run.complete(runId, "completed");

    if (stepResult.turnNodeHash !== undefined) {
      await this.options.kernel.turn.updateHead(
        handle.turnId,
        stepResult.turnNodeHash
      );
      await this.emitStateObservability(
        handle,
        loopState,
        stepResult.turnNodeHash,
        handle.status().manifest ?? createEmptyContextManifest(),
        handle.status().iterationCount
      );
    }
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

    return decodeDeterministicKernelRecord(
      payload
    ) as unknown as ContextManifest;
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

    return decodeDeterministicKernelRecord(payload) as KrakenMessage;
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
    if (explicitParentTurnId !== undefined) {
      return explicitParentTurnId;
    }

    const resolved = await this.options.resolveParentTurnId?.(
      threadId,
      branchId
    );
    return resolved ?? null;
  }

  private resolveDriver(driverId: string): KrakenDriver {
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
  ): Promise<void> {
    await this.options.kernel.staging.stage(
      runId,
      encodeKernelRecord(manifest, "manifest"),
      "manifest",
      "context_manifest",
      "completed"
    );
  }

  private async stageMessage(
    runId: string,
    message: KrakenMessage,
    taskId: string
  ): Promise<void> {
    await this.options.kernel.staging.stage(
      runId,
      encodeKernelRecord(message, "message"),
      taskId,
      "message",
      "completed"
    );
  }

  private async stageRuntimeStatus(
    runId: string,
    status: Record<string, unknown>,
    taskId: string
  ): Promise<void> {
    await this.options.kernel.staging.stage(
      runId,
      encodeKernelRecord(status, "runtime status"),
      taskId,
      "runtime_status",
      "completed"
    );
  }

  private async storeKernelRecord(
    value: unknown,
    label: string
  ): Promise<HashString> {
    return await this.options.kernel.store.put(
      encodeKernelRecord(value, label)
    );
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
    handle.publish({
      ...event,
      source: event.source ?? {
        agent: loopState.activeConfig.name,
        driver: loopState.activeDriverId,
        threadId: handle.request.threadId,
      },
    });
  }

  private publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ): void {
    this.publishEvent(
      handle,
      {
        error: {
          code:
            "code" in error
              ? String((error as { code: unknown }).code)
              : undefined,
          details:
            "details" in error
              ? (error as { details: unknown }).details
              : undefined,
          message: error.message,
        },
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
    manifest: ContextManifest,
    iterationCount: number
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
  private readonly openWorkers = new Set<string>();
  private readonly runtime: OrchestrationRuntimeImpl;
  private parentHandle: ExecutionHandle;
  private readonly workerEventFanouts = new Map<
    string,
    EventFanout<KrakenStreamEvent>
  >();

  constructor(
    runtime: OrchestrationRuntimeImpl,
    parentHandle: ExecutionHandle
  ) {
    this.runtime = runtime;
    this.parentHandle = parentHandle;
    detachPromise(this.watchParent());
  }

  allEvents(): AsyncIterable<KrakenStreamEvent> {
    return this.allEventsFanout.subscribe();
  }

  cancel(): void {
    this.parentHandle.cancel();
    this.runtime.cancelWorkers();
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
    this.allEventsFanout.emit(event);
  }

  registerWorker(workerId: string): void {
    this.openWorkers.add(workerId);
  }

  parentEvents(): AsyncIterable<KrakenStreamEvent> {
    return this.parentEventsFanout.subscribe();
  }

  resolveApproval(response: ApprovalResponse): ExecutionHandle {
    this.parentHandle = this.parentHandle.resolveApproval(response);
    detachPromise(this.watchParent());
    this.runtime.flushQueuedWorkerResults();
    return this;
  }

  status(): ExecutionStatus {
    return this.parentHandle.status();
  }

  steer(signal: InputSignal): void {
    this.parentHandle.steer(signal);
  }

  workerEvents(workerId: string): AsyncIterable<KrakenStreamEvent> {
    const fanout =
      this.workerEventFanouts.get(workerId) ??
      new EventFanout<KrakenStreamEvent>();
    this.workerEventFanouts.set(workerId, fanout);
    return fanout.subscribe();
  }

  workers(): ReadonlyMap<
    string,
    {
      agent: string;
      result?: unknown;
      status: "running" | "completed" | "failed";
      threadId: string;
      workerId: string;
    }
  > {
    return this.runtime.getWorkerStatuses();
  }

  private async watchParent(): Promise<void> {
    const observedHandle = this.parentHandle;

    for await (const event of observedHandle.events()) {
      const parentEvent = stripEventSource(event);
      this.parentEventsFanout.emit(parentEvent);
      this.allEventsFanout.emit(parentEvent);
    }

    if (observedHandle.status().phase === "paused") {
      return;
    }

    this.parentCompleted = true;
    this.parentEventsFanout.close();
    this.runtime.cancelWorkers();
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
  }
}

class OrchestrationRuntimeImpl implements OrchestrationRuntime {
  private currentHandle?: OrchestrationHandleImpl;
  private readonly agents: Record<string, AgentConfig>;
  private readonly defaultDriverId?: string;
  private readonly entrypoint: string;
  private readonly framework: KrakenRuntime;
  private readonly now: () => EpochMs;
  private readonly pendingWorkerSignals: InputSignal[] = [];
  private readonly workers = new Map<string, WorkerRecord>();

  constructor(
    framework: KrakenRuntime,
    agents: Record<string, AgentConfig>,
    entrypoint: string,
    now: () => EpochMs,
    defaultDriverId?: string
  ) {
    this.framework = framework;
    this.agents = agents;
    this.entrypoint = entrypoint;
    this.now = now;
    this.defaultDriverId = defaultDriverId;
  }

  async awaitWorker(workerId: string): Promise<unknown> {
    const worker = this.workers.get(workerId);

    if (worker === undefined) {
      throw new KrakenRuntimeError(`worker "${workerId}" is not known`, {
        code: "unknown_worker",
        details: {
          workerId,
        },
      });
    }

    return await worker.resultPromise;
  }

  cancel(): void {
    this.currentHandle?.cancel();
    this.cancelWorkers();
  }

  cancelWorkers(): void {
    for (const worker of this.workers.values()) {
      if (worker.status === "running") {
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

    const parentHandle = this.framework.executeTurn({
      ...input,
      config,
      driverId: input.driverId ?? this.defaultDriverId,
    });
    const orchestrationHandle = new OrchestrationHandleImpl(this, parentHandle);
    this.currentHandle = orchestrationHandle;
    return orchestrationHandle;
  }

  flushQueuedWorkerResults(): void {
    const handle = this.currentHandle;

    if (handle === undefined) {
      return;
    }

    while (
      this.pendingWorkerSignals.length > 0 &&
      handle.status().phase === "running"
    ) {
      const signal = this.pendingWorkerSignals.shift();

      if (signal !== undefined) {
        handle.steer(signal);
      }
    }
  }

  getWorkerStatuses(): ReadonlyMap<
    string,
    {
      agent: string;
      result?: unknown;
      status: "running" | "completed" | "failed";
      threadId: string;
      workerId: string;
    }
  > {
    const snapshot = new Map<
      string,
      {
        agent: string;
        result?: unknown;
        status: "running" | "completed" | "failed";
        threadId: string;
        workerId: string;
      }
    >();

    for (const [workerId, worker] of this.workers) {
      snapshot.set(workerId, {
        agent: worker.agent,
        result: worker.result,
        status: worker.status,
        threadId: worker.threadId,
        workerId,
      });
    }

    return snapshot;
  }

  async launchWorker(agent: string, task: unknown): Promise<string> {
    const config = this.agents[agent];
    const currentHandle = this.currentHandle;

    if (config === undefined) {
      throw new KrakenRuntimeError(`worker agent "${agent}" is not defined`, {
        code: "unknown_worker_agent",
        details: {
          agent,
        },
      });
    }

    if (currentHandle === undefined) {
      throw new KrakenRuntimeError(
        "launchWorker() requires an active orchestration handle",
        {
          code: "orchestration_parent_missing",
        }
      );
    }

    const thread = await this.framework.createThread({});
    const workerId = thread.threadId;
    const deferred = createDeferred<unknown>();
    const handle = this.framework.executeTurn({
      branchId: thread.branchId,
      config,
      driverId: this.defaultDriverId,
      signal: normalizeWorkerTask(task),
      threadId: thread.threadId,
    });
    const record: WorkerRecord = {
      agent,
      handle,
      resolveResult: deferred.resolve,
      resultPromise: deferred.promise,
      status: "running",
      threadId: thread.threadId,
      workerId,
    };
    this.workers.set(workerId, record);
    currentHandle.registerWorker(workerId);
    currentHandle.emitWorkerEvent(workerId, {
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
    detachPromise(this.watchWorker(record, currentHandle));
    return workerId;
  }

  private async watchWorker(
    worker: WorkerRecord,
    parentHandle: OrchestrationHandleImpl
  ): Promise<void> {
    let lastText = "";

    for await (const event of worker.handle.events()) {
      if (event.type === "text.done") {
        lastText = event.text;
      }

      parentHandle.emitWorkerEvent(worker.workerId, {
        ...event,
        source: {
          ...(event.source ?? {}),
          agent: worker.agent,
          threadId: worker.threadId,
          workerId: worker.workerId,
        },
      });
    }

    worker.result = lastText;
    worker.status =
      worker.handle.status().phase === "failed" ? "failed" : "completed";
    worker.resolveResult(lastText);
    parentHandle.emitWorkerEvent(worker.workerId, {
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

    if (worker.status === "completed") {
      const signal = createWorkerResultSignal(worker, worker.result);

      if (parentHandle.status().phase === "running") {
        parentHandle.steer(signal);
      } else if (parentHandle.status().phase === "paused") {
        this.pendingWorkerSignals.push(signal);
      }
    }

    parentHandle.workerFinished(worker.workerId);
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
  const sequenceResolver = buildSequenceResolver(options.sequence);
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
      resolveNextAgent: sequenceResolver,
      sequenceHandoffContextBuilder: options.handoffContextBuilder,
      resolveParentTurnId: options.resolveParentTurnId,
    });

  return new OrchestrationRuntimeImpl(
    framework,
    options.agents,
    options.entrypoint,
    options.now ?? Date.now,
    options.defaultDriverId
  );
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

function cloneExecutionStatus(status: ExecutionStatus): ExecutionStatus {
  return {
    activeAgent: status.activeAgent,
    approval: status.approval,
    iterationCount: status.iterationCount,
    manifest: status.manifest,
    pauseReason: status.pauseReason,
    phase: status.phase,
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

function encodeKernelRecord(value: unknown, label: string): Uint8Array {
  assertKernelRecord(value, label);
  return encodeDeterministicKernelRecord(value);
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

function hashRecord(value: Uint8Array): HashString {
  return createHash("sha256").update(value).digest("hex");
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

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeWorkerTask(task: unknown): InputSignal {
  if (
    task !== null &&
    typeof task === "object" &&
    "parts" in task &&
    Array.isArray((task as { parts?: unknown }).parts)
  ) {
    return task as InputSignal;
  }

  return {
    parts: [
      {
        data: task,
        name: "worker_task",
        type: "structured",
      },
    ],
  };
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
          output,
          status: "completed",
          workerId: worker.workerId,
        },
        name: "worker_result",
        type: "structured",
      },
    ],
  };
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
