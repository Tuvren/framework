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

import { randomUUID } from "node:crypto";
import type {
  AgentConfig,
  ApprovalRequest,
  ApprovalResponse,
  ExecutionHandle,
  ExecutionStatus,
  HandoffContextBuilder,
  InputSignal,
  KrakenErrorProjection,
  KrakenMessage,
  KrakenRuntime,
  KrakenStreamEvent,
  KrakenToolDefinition,
  OrchestrationHandle,
  OrchestrationRuntime,
  WorkerStatus,
} from "@kraken/framework-runtime-api";
import { assertKrakenMessage } from "@kraken/framework-runtime-api";
import {
  decodeDeterministicKernelRecord,
  type KrakenKernel,
  type PathValue,
} from "@kraken/kernel-contract-protocol";
import {
  type EpochMs,
  type HashString,
  KrakenLineageError,
  KrakenRuntimeError,
} from "@kraken/shared-core-types";
import {
  createKrakenRuntimeCore,
  type RuntimeCoreOptions,
} from "./runtime-core.js";
import {
  cloneValue,
  cloneWorkerStatus,
  createDeferred,
  detachPromise,
  EventFanout,
  isRecord,
  normalizeError,
  normalizeInputSignal,
  projectError,
  stripEventSource,
} from "./runtime-core-shared.js";

interface OrchestrationRuntimeBaseOptions {
  agents: Record<string, AgentConfig>;
  entrypoint: string;
  handoffContextBuilder?: HandoffContextBuilder;
  sequence?: string[];
}

type InternalOrchestrationRuntimeOptions = OrchestrationRuntimeBaseOptions &
  Omit<RuntimeCoreOptions, "resolveAgentConfig" | "resolveNextAgent"> & {
    framework?: undefined;
  };

type DelegatedOrchestrationRuntimeOptions = OrchestrationRuntimeBaseOptions & {
  createId?: RuntimeCoreOptions["createId"];
  defaultDriverId?: string;
  driverRegistry?: RuntimeCoreOptions["driverRegistry"];
  enableStateObservability?: RuntimeCoreOptions["enableStateObservability"];
  framework: KrakenRuntime;
  kernel: KrakenKernel;
  now?: () => EpochMs;
  resolveParentTurnId?: RuntimeCoreOptions["resolveParentTurnId"];
};

export type OrchestrationRuntimeOptions =
  | InternalOrchestrationRuntimeOptions
  | DelegatedOrchestrationRuntimeOptions;

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
  private replacedByResume = false;
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

  wasReplacedByResume(): boolean {
    return this.replacedByResume;
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
    this.runtime.registerHandle(resumedHandle);
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

  workerEvents(workerId: string): AsyncIterable<KrakenStreamEvent> {
    const existingFanout = this.workerEventFanouts.get(workerId);

    if (existingFanout !== undefined) {
      const events = existingFanout.subscribe();
      this.ensureStarted();
      return events;
    }

    if (
      !(this.openWorkers.has(workerId) || this.retainedWorkers.has(workerId))
    ) {
      throw new KrakenRuntimeError(`worker "${workerId}" is not known`, {
        code: "unknown_worker",
        details: {
          workerId,
        },
      });
    }

    const fanout = new EventFanout<KrakenStreamEvent>();
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
    this.replacedByResume = true;
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
    this.registerHandle(orchestrationHandle);
    return orchestrationHandle;
  }

  registerHandle(handle: OrchestrationHandleImpl): void {
    this.sessionHandles.set(handle.sessionId, handle);
  }

  releaseHandle(handle: OrchestrationHandleImpl): void {
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

  getWorkerStatuses(sessionId: string): ReadonlyMap<string, WorkerStatus> {
    const snapshot = new Map<string, WorkerStatus>();

    for (const [workerId, worker] of this.workers) {
      if (worker.sessionId !== sessionId) {
        continue;
      }

      snapshot.set(workerId, createWorkerStatusSnapshot(worker));
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

      if (phase !== "completed" && phase !== "failed") {
        throw new KrakenRuntimeError(
          "worker stream exhausted before terminal turn status",
          {
            code: "invalid_worker_lifecycle",
            details: {
              phase,
              workerId: worker.workerId,
            },
          }
        );
      }

      completedTerminalWatch = true;
      sessionHandle = this.resolveSessionHandle(worker.sessionId);
      worker.approval = undefined;
      worker.status = phase;

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
    return randomUUID();
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

    const soleActiveSession = this.getSoleActiveSessionHandle();

    if (soleActiveSession === undefined) {
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

    if (liveWorker === undefined) {
      const retainedWorker =
        soleActiveSession.getRetainedWorkerStatus(workerId);

      if (retainedWorker !== undefined) {
        return {
          kind: "retained",
          worker: retainedWorker,
        };
      }

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

    if (soleActiveSession.sessionId !== liveWorker.sessionId) {
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

  private getSoleActiveSessionHandle(): OrchestrationHandleImpl | undefined {
    if (this.sessionHandles.size !== 1) {
      return undefined;
    }

    return this.sessionHandles.values().next().value;
  }

  private requireRuntimeParentHandle(
    parent: OrchestrationHandle,
    methodName: string
  ): OrchestrationHandleImpl {
    if (
      !(
        parent instanceof OrchestrationHandleImpl &&
        parent.belongsToRuntime(this)
      )
    ) {
      throw new KrakenRuntimeError(
        `${methodName}() requires a parent handle created by this orchestration runtime`,
        {
          code: "invalid_orchestration_parent",
        }
      );
    }

    if (parent.wasReplacedByResume()) {
      throw new KrakenRuntimeError(
        `${methodName}() requires the current parent handle for that orchestration session`,
        {
          code: "invalid_orchestration_parent",
          details: {
            methodName,
            reason: "stale_replaced_handle",
            sessionId: parent.sessionId,
          },
        }
      );
    }

    const currentHandle = this.resolveSessionHandle(parent.sessionId);

    if (currentHandle !== undefined && currentHandle !== parent) {
      throw new KrakenRuntimeError(
        `${methodName}() requires the current parent handle for that orchestration session`,
        {
          code: "invalid_orchestration_parent",
          details: {
            methodName,
            reason: "superseded_session_handle",
            sessionId: parent.sessionId,
          },
        }
      );
    }

    return parent;
  }

  private requireCurrentParentHandle(
    parent: OrchestrationHandle,
    methodName: string
  ): OrchestrationHandleImpl {
    const parentHandle = this.requireRuntimeParentHandle(parent, methodName);

    if (this.resolveSessionHandle(parentHandle.sessionId) !== parentHandle) {
      throw new KrakenRuntimeError(
        `${methodName}() requires an active current parent handle`,
        {
          code: "invalid_orchestration_parent",
          details: {
            methodName,
            sessionId: parentHandle.sessionId,
          },
        }
      );
    }

    return parentHandle;
  }

  private resolveSessionHandle(
    sessionId: string
  ): OrchestrationHandleImpl | undefined {
    return this.sessionHandles.get(sessionId);
  }

  private resolveLaunchParentHandle(
    parent: OrchestrationHandle | undefined
  ): OrchestrationHandleImpl {
    if (parent !== undefined) {
      const parentHandle = this.requireCurrentParentHandle(
        parent,
        "launchWorker"
      );
      this.assertLaunchableParentHandle(parentHandle);
      return parentHandle;
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

export function createOrchestrationRuntime(
  options: OrchestrationRuntimeOptions
): OrchestrationRuntime {
  validateOrchestrationConfiguration(
    options.agents,
    options.entrypoint,
    options.sequence
  );
  const framework =
    options.framework === undefined
      ? createKrakenRuntimeCore({
          createId: options.createId,
          defaultDriverId: options.defaultDriverId,
          driverRegistry: options.driverRegistry,
          enableStateObservability: options.enableStateObservability,
          handoffContextBuilder: options.handoffContextBuilder,
          kernel: options.kernel,
          now: options.now,
          resolveAgentConfig: (agentName) => options.agents[agentName],
          resolveNextAgent: buildSequenceResolver(options.sequence),
          resolveSequenceStep: buildSequenceStepResolver(options.sequence),
          resolveParentTurnId: options.resolveParentTurnId,
        })
      : options.framework;

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

  const decoded = decodeDeterministicKernelRecord(payload);
  assertKrakenMessage(decoded, `message "${hash}"`);
  return decoded;
}

function extractWorkerOutput(messages: KrakenMessage[]): unknown {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role === "assistant" || message.role === "tool") {
      const projectedOutput = projectMessageOutput(message);

      if (projectedOutput !== undefined) {
        return projectedOutput;
      }
    }
  }

  return undefined;
}

function projectMessageOutput(
  message: Extract<KrakenMessage, { role: "assistant" | "tool" }>
): unknown {
  const projectedParts: unknown[] = [];

  for (const part of message.parts) {
    const projectedPart = projectWorkerOutputPart(part);

    if (projectedPart !== OMITTED_WORKER_OUTPUT_PART) {
      projectedParts.push(projectedPart);
    }
  }

  if (projectedParts.length === 0) {
    return undefined;
  }

  return projectedParts.length === 1 ? projectedParts[0] : projectedParts;
}

export const OMITTED_WORKER_OUTPUT_PART = Symbol("omitted_worker_output_part");

export function projectWorkerOutputPart(
  part: Extract<KrakenMessage, { role: "assistant" | "tool" }>["parts"][number]
): unknown | typeof OMITTED_WORKER_OUTPUT_PART {
  switch (part.type) {
    case "file":
      return {
        data: part.data,
        filename: part.filename,
        mediaType: part.mediaType,
        type: part.type,
      };
    case "reasoning":
      return OMITTED_WORKER_OUTPUT_PART;
    case "structured":
      return part.data;
    case "text":
      return part.text;
    case "tool_call":
      return OMITTED_WORKER_OUTPUT_PART;
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
