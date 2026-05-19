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

import { TuvrenRuntimeError } from "@tuvren/core-types";
import type { RuntimeDriver as KrakenDriver } from "@tuvren/driver-api";
import type {
  ApprovalResponse,
  ContentPart,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  InputSignal,
  TuvrenErrorProjection,
  TuvrenMessage,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import { assertApprovalResponseForRequest } from "@tuvren/runtime-api";
import {
  AsyncEventQueue,
  cloneExecutionStatus,
  cloneValue,
  createExecutionCancelledError,
  detachPromise,
  normalizeInputSignal,
} from "./runtime-core-shared.js";
import type {
  ExecutionSessionRequest,
  PauseContext,
  ResumeContext,
} from "./runtime-execution-types.js";

export interface RuntimeExecutionHandleRuntime {
  cancelPausedExecution(handle: RuntimeExecutionHandle): void;
  createResumedExecutionHandle(
    previousHandle: RuntimeExecutionHandle,
    pauseContext: PauseContext,
    response: ApprovalResponse
  ): RuntimeExecutionHandle;
  startExecution(handle: RuntimeExecutionHandle): Promise<void>;
}

export class RuntimeExecutionHandle implements ExecutionHandle {
  private activeRunId?: string;
  private readonly abortController = new AbortController();
  private readonly eventsQueue: AsyncEventQueue<TuvrenStreamEvent>;
  private eventStreamClaimed = false;
  private lastErrorProjection?: TuvrenErrorProjection;
  private materializedDriver?: KrakenDriver;
  private materializedDriverId?: string;
  private pendingPausedCancellation?: Promise<void>;
  private pauseContext?: PauseContext;
  private replacementHandle?: RuntimeExecutionHandle;
  private readonly runtime: RuntimeExecutionHandleRuntime;
  private schemaIdValue: string;
  private readonly steeringQueue: InputSignal[] = [];
  private started = false;
  private statusSnapshot: ExecutionStatus;
  private resultSettled = false;
  private resultResolve!: (value: ExecutionResult) => void;
  private resultReject!: (reason: unknown) => void;
  private readonly resultPromise: Promise<ExecutionResult>;
  private pendingAssistantParts: ContentPart[] = [];
  private lastFinalAssistantMessage?: TuvrenMessage;
  readonly request: ExecutionSessionRequest;
  readonly resumedFrom?: ResumeContext;
  turnId: string;

  constructor(
    runtime: RuntimeExecutionHandleRuntime,
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
    this.eventsQueue = new AsyncEventQueue<TuvrenStreamEvent>(() => {
      if (!this.started || this.statusSnapshot.phase !== "running") {
        return;
      }

      this.cancel();
    });
    this.statusSnapshot = {
      activeAgent: request.config.name,
      iterationCount: 0,
      phase: "running",
    };

    this.resultPromise = new Promise<ExecutionResult>((resolve, reject) => {
      this.resultResolve = resolve;
      this.resultReject = reject;
    });
    this.resultPromise.catch(() => undefined);
  }

  cancel(): void {
    if (this.replacementHandle !== undefined) {
      throw new TuvrenRuntimeError(
        "cancel() is not valid once approval has been resolved",
        {
          code: "invalid_approval_resolution",
        }
      );
    }

    if (
      !this.started &&
      this.resumedFrom === undefined &&
      this.statusSnapshot.phase === "running"
    ) {
      this.abortController.abort(createExecutionCancelledError());
      this.replaceStatus({
        ...this.statusSnapshot,
        phase: "failed",
      });
      return;
    }

    this.abortController.abort(createExecutionCancelledError());

    if (!this.started && this.resumedFrom !== undefined) {
      // A resumed handle still owns the paused run until the resume path closes
      // it durably. Start the resumed execution shell immediately so cancel()
      // cannot leave the branch wedged on the old paused run.
      this.started = true;
      detachPromise(this.runtime.startExecution(this));
      return;
    }

    this.runtime.cancelPausedExecution(this);
  }

  consumeSteeringSignal(): InputSignal | undefined {
    return this.steeringQueue.shift();
  }

  events(): AsyncIterable<TuvrenStreamEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        this.claimEventStream();

        const iterator = this.eventsQueue[Symbol.asyncIterator]();
        let startedConsumption = false;

        const ensureStarted = () => {
          if (startedConsumption) {
            return;
          }

          startedConsumption = true;

          if (this.started) {
            return;
          }

          this.started = true;
          detachPromise(this.runtime.startExecution(this));
        };

        return {
          next: async () => {
            ensureStarted();

            return await iterator.next();
          },
          return: async () => {
            if (iterator.return === undefined) {
              return {
                done: true,
                value: undefined,
              };
            }

            return await iterator.return();
          },
        };
      },
    };
  }

  finish(): void {
    this.eventsQueue.close();
    const phase = this.statusSnapshot.phase;
    if (!this.resultSettled && phase !== "running" && phase !== "paused") {
      this.settleResult(phase);
    }
  }

  abortWithError(error: Error): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(error);
    }
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

  publish(event: TuvrenStreamEvent): void {
    this.eventsQueue.push(cloneValue(event));
    this.trackEventForResult(event);
  }

  private trackEventForResult(event: TuvrenStreamEvent): void {
    switch (event.type) {
      case "message.start":
        this.pendingAssistantParts = [];
        return;
      case "text.done":
        this.pendingAssistantParts.push({ text: event.text, type: "text" });
        return;
      case "file.done":
        this.pendingAssistantParts.push({
          data:
            typeof event.data === "string"
              ? event.data
              : new Uint8Array(event.data),
          filename: event.filename,
          mediaType: event.mediaType,
          type: "file",
        });
        return;
      case "structured.done":
        this.pendingAssistantParts.push({
          data: structuredClone(event.data),
          name: event.name,
          type: "structured",
        });
        return;
      case "tool_call.done":
        this.pendingAssistantParts.push({
          callId: event.callId,
          input: event.input,
          name: event.name,
          providerMetadata: event.providerMetadata,
          type: "tool_call",
        });
        return;
      case "message.done":
        if (this.pendingAssistantParts.length > 0) {
          this.lastFinalAssistantMessage = {
            parts: this.pendingAssistantParts as [
              ContentPart,
              ...ContentPart[],
            ],
            providerMetadata: undefined,
            role: "assistant",
          };
        }
        this.pendingAssistantParts = [];
        return;
      case "turn.end":
        this.settleResult(event.status);
        return;
      default:
        return;
    }
  }

  private settleResult(turnEndStatus: "completed" | "paused" | "failed"): void {
    if (turnEndStatus === "paused" || this.resultSettled) {
      return;
    }

    this.resultSettled = true;

    const { reason } = this.abortController.signal;
    const cancelledByUser =
      reason instanceof TuvrenRuntimeError &&
      reason.code === "runtime_execution_cancelled";

    if (turnEndStatus === "failed" && cancelledByUser) {
      this.resultReject(
        new TuvrenRuntimeError("Execution was cancelled", {
          code: "execution_cancelled",
        })
      );
      return;
    }

    const executionStatus = cloneExecutionStatus(this.statusSnapshot);

    if (turnEndStatus === "completed") {
      this.resultResolve({
        executionStatus,
        finalAssistantMessage: this.lastFinalAssistantMessage,
        status: "completed",
      });
    } else {
      const projection = this.lastErrorProjection;
      const error = new TuvrenRuntimeError(
        projection?.message ?? "Execution failed",
        { code: projection?.code ?? "execution_failed" }
      );
      this.resultResolve({ error, executionStatus, status: "failed" });
    }
  }

  awaitResult(): Promise<ExecutionResult> {
    if (!this.started) {
      this.started = true;
      detachPromise(this.runtime.startExecution(this));
    }

    return this.resultPromise;
  }

  rememberError(error: TuvrenErrorProjection): void {
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

  setTurnId(turnId: string): void {
    // Stale-run recovery can continue an existing durable turn; we retarget the
    // handle before any events are published so downstream state stays coherent.
    this.turnId = turnId;
  }

  takeActiveRunId(): string | undefined {
    const activeRunId = this.activeRunId;
    this.activeRunId = undefined;
    return activeRunId;
  }

  takePauseContextForCancellation(): PauseContext | undefined {
    if (
      this.pauseContext === undefined ||
      this.statusSnapshot.phase !== "paused"
    ) {
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
      throw new TuvrenRuntimeError(
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

  getLastErrorProjection(): TuvrenErrorProjection | undefined {
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
    if (!this.started || this.statusSnapshot.phase !== "running") {
      throw new TuvrenRuntimeError(
        "steer() is only valid while execution is running",
        {
          code: "invalid_steering_state",
          details: {
            phase: this.statusSnapshot.phase,
            started: this.started,
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

  getPendingPausedCancellation(): Promise<void> | undefined {
    return this.pendingPausedCancellation;
  }

  rememberPausedCancellation(task: Promise<void>): void {
    this.pendingPausedCancellation = task;
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

  private claimEventStream(): void {
    if (this.eventStreamClaimed) {
      throw new TuvrenRuntimeError(
        "events() can only be consumed once for an execution handle",
        {
          code: "event_stream_already_consumed",
        }
      );
    }

    this.eventStreamClaimed = true;
  }
}
