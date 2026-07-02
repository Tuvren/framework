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

import { type EpochMs, TuvrenRuntimeError } from "@tuvren/core";
import type {
  TuvrenErrorProjection,
  TuvrenStreamEvent,
} from "@tuvren/core/events";
import type {
  AgentConfig,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  InputSignal,
} from "@tuvren/core/execution";
import type { ApprovalResponse } from "@tuvren/core/tools";
import {
  AsyncEventQueue,
  cloneValue,
  createDeferred,
  detachPromise,
  normalizeError,
  normalizeInputSignal,
  projectError,
} from "./runtime-core-shared.js";

export interface ExecutionBinding {
  agent: string;
  branchId: string;
  driverId?: string;
  handle: ExecutionHandle;
  schemaId?: string;
  threadId: string;
  tools?: AgentConfig["tools"];
  workerId?: string;
}

export interface ChildSpawnRequest {
  agent: string;
  signal: InputSignal;
}

export interface OrchestrationRuntimeNodeHost {
  createChildBinding(
    parentBinding: ExecutionBinding,
    workerId: string,
    input: ChildSpawnRequest
  ): Promise<ExecutionBinding>;
  createId(): string;
}

export class OrchestrationNode {
  private activeEventStreams = 0;
  private activeResultAwaiters = 0;
  private activeSubtreeStreams = 0;
  private readonly childForwarders = new Map<
    OrchestrationNode,
    AsyncIterator<TuvrenStreamEvent>
  >();
  private readonly children = new Set<OrchestrationNode>();
  private currentBinding?: ExecutionBinding;
  private currentBindingPromise?: Promise<ExecutionBinding>;
  private bindingGeneration = 0;
  private watchingGeneration?: number;
  private initializationFailed = false;
  private cancelledBeforeReady = false;
  private lastErrorProjection?: TuvrenErrorProjection;
  private readonly now: () => EpochMs;
  private readonly pendingSteering: InputSignal[] = [];
  private readonly resultState = createDeferred<void>();
  private readonly runtime: OrchestrationRuntimeNodeHost;
  private selfPhase: ExecutionStatus["phase"] = "running";
  private selfEventsClaimed = false;
  private selfEventsQueue?: AsyncEventQueue<TuvrenStreamEvent>;
  private selfResultResolved = false;
  private startedExecution = false;
  private readonly subtreeEventSubscribers = new Set<
    AsyncEventQueue<TuvrenStreamEvent>
  >();
  private subtreeEventsClaimed = false;
  private subtreeEventsQueue?: AsyncEventQueue<TuvrenStreamEvent>;
  private subtreeSettled = false;
  private readonly workerId?: string;
  private readonly localAgent: string;
  private readonly localHandleStatus: ExecutionStatus;

  constructor(
    runtime: OrchestrationRuntimeNodeHost,
    agent: string,
    now: () => EpochMs,
    options: {
      binding?: ExecutionBinding;
      bindingPromise?: Promise<ExecutionBinding>;
      workerId?: string;
    }
  ) {
    this.runtime = runtime;
    this.localAgent = agent;
    this.now = now;
    this.workerId = options.workerId;
    this.localHandleStatus = {
      activeAgent: agent,
      iterationCount: 0,
      phase: "running",
    };

    if (options.binding !== undefined) {
      this.currentBinding = options.binding;
      this.currentBindingPromise = Promise.resolve(options.binding);
    } else if (options.bindingPromise === undefined) {
      throw new Error("orchestration nodes require an execution binding");
    } else {
      this.currentBindingPromise = options.bindingPromise
        .then((binding) => {
          this.currentBinding = binding;

          for (const pendingSignal of this.pendingSteering) {
            binding.handle.steer(pendingSignal);
          }

          this.pendingSteering.length = 0;

          if (this.cancelledBeforeReady) {
            binding.handle.cancel();
          }

          return binding;
        })
        .catch((error: unknown) => {
          this.initializationFailed = true;
          const normalizedError = normalizeError(error);
          this.lastErrorProjection = projectError(normalizedError);
          this.selfPhase = "failed";
          throw normalizedError;
        });
    }
  }

  allEvents(): AsyncIterable<TuvrenStreamEvent> {
    return createSingleConsumerLazyStream({
      alreadyConsumedCode: "event_stream_already_consumed",
      alreadyConsumedMessage:
        "allEvents() can only be consumed once for an orchestration handle",
      isClaimed: () => this.subtreeEventsClaimed,
      onClaim: () => {
        this.subtreeEventsClaimed = true;
      },
      onClose: async () => {
        this.subtreeEventsQueue = undefined;
        await this.closeSubtreeConsumer();
      },
      onStart: (queue) => {
        this.subtreeEventsQueue = queue;
        this.startSubtreeConsumer(queue);
      },
    });
  }

  get nodeWorkerId(): string | undefined {
    return this.workerId;
  }

  async awaitResult(): Promise<ExecutionResult> {
    if (!this.startedExecution) {
      throw new TuvrenRuntimeError(
        "awaitResult() requires the orchestration handle to start execution first",
        {
          code: "orchestration_parent_not_started",
        }
      );
    }

    this.ensureWatchingCurrentBinding();
    this.activeResultAwaiters += 1;

    try {
      await this.resultState.promise;

      if (this.currentBinding !== undefined) {
        return await this.currentBinding.handle.awaitResult();
      }

      // Initialization failed — no binding was ever established.
      const projection = this.lastErrorProjection;
      const error = new TuvrenRuntimeError(
        projection?.message ?? "orchestration execution failed",
        { code: projection?.code ?? "execution_failed" }
      );
      return {
        error,
        executionStatus: this.currentStatus(),
        status: "failed",
      };
    } finally {
      this.activeResultAwaiters -= 1;
      this.maybeCancelUnobservedExecution();
    }
  }

  cancel(): void {
    if (this.currentBinding !== undefined) {
      this.currentBinding.handle.cancel();
      return;
    }

    this.cancelledBeforeReady = true;
    this.ensureWatchingCurrentBinding();
  }

  currentStatus(): ExecutionStatus {
    if (this.currentBinding !== undefined) {
      return this.currentBinding.handle.status();
    }

    if (this.initializationFailed) {
      return {
        ...this.localHandleStatus,
        phase: "failed",
      };
    }

    return this.localHandleStatus;
  }

  events(): AsyncIterable<TuvrenStreamEvent> {
    return createSingleConsumerLazyStream({
      alreadyConsumedCode: "event_stream_already_consumed",
      alreadyConsumedMessage:
        "events() can only be consumed once for an orchestration handle",
      isClaimed: () => this.selfEventsClaimed,
      onClaim: () => {
        this.selfEventsClaimed = true;
      },
      onClose: () => {
        this.selfEventsQueue = undefined;
        this.activeEventStreams -= 1;
        this.maybeCancelUnobservedExecution();
      },
      onStart: (queue) => {
        this.selfEventsQueue = queue;
        this.activeEventStreams += 1;
        this.startExecution();
      },
    });
  }

  hasStartedExecution(): boolean {
    return this.startedExecution;
  }

  registerChild(child: OrchestrationNode): void {
    this.children.add(child);
    detachPromise(this.observeChildSettlement(child));

    if (this.activeSubtreeStreams > 0) {
      this.startChildForwarding(child);
    }
  }

  steer(signal: InputSignal): void {
    const normalizedSignal = normalizeInputSignal(
      signal,
      "orchestration steering signal"
    );

    if (this.currentBinding !== undefined) {
      this.currentBinding.handle.steer(normalizedSignal);
      return;
    }

    if (!this.startedExecution || this.currentBindingPromise === undefined) {
      throw new TuvrenRuntimeError(
        "steer() requires the orchestration handle to start execution first",
        {
          code: "orchestration_parent_not_started",
        }
      );
    }

    if (this.selfPhase !== "running") {
      throw new TuvrenRuntimeError(
        "steer() requires a running orchestration handle",
        {
          code: "orchestration_parent_inactive",
          details: {
            phase: this.selfPhase,
          },
        }
      );
    }

    this.pendingSteering.push(normalizedSignal);
  }

  replaceAfterApproval(response: ApprovalResponse): OrchestrationNode {
    const binding = this.requireCurrentBinding("resolveApproval");
    const status = binding.handle.status();

    if (status.phase !== "paused") {
      throw new TuvrenRuntimeError(
        "resolveApproval() is only valid while execution is paused",
        {
          code: "invalid_approval_resolution",
        }
      );
    }

    const resumedHandle = binding.handle.resolveApproval(response);
    const nextBinding: ExecutionBinding = {
      ...binding,
      handle: resumedHandle,
    };
    this.currentBinding = nextBinding;
    this.currentBindingPromise = Promise.resolve(nextBinding);
    this.selfPhase = "running";
    this.bindingGeneration += 1;
    this.watchingGeneration = undefined;
    if (this.selfEventsQueue === undefined) {
      this.selfEventsClaimed = false;
    }
    if (this.subtreeEventsQueue === undefined) {
      this.subtreeEventsClaimed = false;
    }
    this.ensureWatchingCurrentBinding();
    return this;
  }

  spawn(input: ChildSpawnRequest): OrchestrationNode {
    if (!this.startedExecution) {
      throw new TuvrenRuntimeError(
        "spawn() requires the orchestration handle to start execution first",
        {
          code: "orchestration_parent_not_started",
        }
      );
    }

    const workerId = this.runtime.createId();
    const childBindingPromise =
      this.currentBinding === undefined
        ? this.requireCurrentBindingAsync("spawn").then(async (binding) => {
            const phase = binding.handle.status().phase;

            if (phase !== "running") {
              throw new TuvrenRuntimeError(
                "spawn() requires a running orchestration handle",
                {
                  code: "orchestration_parent_inactive",
                  details: {
                    phase,
                  },
                }
              );
            }

            return await this.runtime.createChildBinding(
              binding,
              workerId,
              input
            );
          })
        : (() => {
            const phase = this.currentBinding.handle.status().phase;

            if (phase !== "running") {
              throw new TuvrenRuntimeError(
                "spawn() requires a running orchestration handle",
                {
                  code: "orchestration_parent_inactive",
                  details: {
                    phase,
                  },
                }
              );
            }

            return this.runtime.createChildBinding(
              this.currentBinding,
              workerId,
              input
            );
          })();
    const childNode = new OrchestrationNode(
      this.runtime,
      input.agent,
      this.now,
      {
        bindingPromise: childBindingPromise,
        workerId,
      }
    );
    this.registerChild(childNode);
    childNode.startExecution();
    return childNode;
  }

  startExecution(): void {
    if (this.startedExecution) {
      this.ensureWatchingCurrentBinding();
      return;
    }

    this.startedExecution = true;
    this.ensureWatchingCurrentBinding();
  }

  private decorateEvent(
    event: TuvrenStreamEvent,
    binding: ExecutionBinding
  ): TuvrenStreamEvent {
    if (binding.workerId === undefined) {
      return event;
    }

    return {
      ...event,
      source: {
        ...(event.source ?? {}),
        agent: event.source?.agent ?? binding.agent,
        threadId: event.source?.threadId ?? binding.threadId,
        workerId: event.source?.workerId ?? binding.workerId,
      },
    };
  }

  private ensureWatchingCurrentBinding(): void {
    if (
      this.currentBindingPromise === undefined ||
      this.watchingGeneration === this.bindingGeneration
    ) {
      return;
    }

    this.watchingGeneration = this.bindingGeneration;
    detachPromise(
      this.watchCurrentBinding(
        this.bindingGeneration,
        this.currentBindingPromise
      )
    );
  }

  private finalizeCurrentBinding(binding: ExecutionBinding): void {
    const phase = binding.handle.status().phase;
    this.selfPhase = phase;

    if (phase === "paused") {
      return;
    }

    if (phase === "completed") {
      this.settleResultSuccess();
      this.maybeCloseSubtree();
      return;
    }

    this.settleResultFailureFromProjection();
    this.maybeCloseSubtree();
  }

  private maybeCloseSubtree(): void {
    if (this.subtreeSettled) {
      return;
    }

    if (this.selfPhase === "paused" || this.children.size > 0) {
      return;
    }

    if (this.selfPhase !== "completed" && this.selfPhase !== "failed") {
      return;
    }

    this.subtreeSettled = true;
    this.closeSubtreeEventStreams();
  }

  private async closeSubtreeConsumer(): Promise<void> {
    this.activeSubtreeStreams -= 1;

    if (this.activeSubtreeStreams === 0) {
      await this.stopAllChildForwarders();
    }

    this.maybeCancelUnobservedExecution();
  }

  private maybeCancelUnobservedExecution(): void {
    const currentPhase =
      this.currentBinding?.handle.status().phase ?? this.selfPhase;

    if (
      !this.startedExecution ||
      currentPhase !== "running" ||
      this.activeEventStreams > 0 ||
      this.activeSubtreeStreams > 0 ||
      this.activeResultAwaiters > 0
    ) {
      return;
    }

    this.cancel();
  }

  private requireCurrentBinding(methodName: string): ExecutionBinding {
    if (this.currentBinding === undefined) {
      throw new TuvrenRuntimeError(
        `${methodName}() requires the orchestration handle to start execution first`,
        {
          code: "orchestration_parent_not_started",
        }
      );
    }

    return this.currentBinding;
  }

  private async requireCurrentBindingAsync(
    methodName: string
  ): Promise<ExecutionBinding> {
    if (this.currentBindingPromise === undefined) {
      throw new TuvrenRuntimeError(
        `${methodName}() requires the orchestration handle to start execution first`,
        {
          code: "orchestration_parent_not_started",
        }
      );
    }

    return await this.currentBindingPromise;
  }

  private settleResultFailure(error: Error): void {
    if (this.selfResultResolved) {
      return;
    }

    this.selfResultResolved = true;
    const projection = projectError(error);
    this.lastErrorProjection = projection;
    this.resultState.resolve();
  }

  private settleResultFailureFromProjection(): void {
    const projection =
      this.lastErrorProjection ??
      projectError(new Error("orchestration execution failed"));

    this.settleResultFailure(
      Object.assign(new Error(projection.message), projection)
    );
  }

  private settleResultSuccess(): void {
    if (this.selfResultResolved) {
      return;
    }

    this.selfResultResolved = true;
    this.resultState.resolve(undefined);
  }

  private async observeChildSettlement(
    child: OrchestrationNode
  ): Promise<void> {
    await child.waitUntilSettled();
    await this.stopChildForwarding(child);
    this.children.delete(child);
    this.maybeCloseSubtree();
  }

  private startChildForwarding(child: OrchestrationNode): void {
    if (this.childForwarders.has(child) || this.activeSubtreeStreams === 0) {
      return;
    }

    const iterator = child.subscribeInternalSubtreeEvents();
    this.childForwarders.set(child, iterator);
    detachPromise(
      (async () => {
        try {
          while (true) {
            const nextEvent = await iterator.next();

            if (nextEvent.done) {
              return;
            }

            this.publishSubtreeEvent(nextEvent.value);
          }
        } finally {
          if (this.childForwarders.get(child) === iterator) {
            this.childForwarders.delete(child);
          }
        }
      })()
    );
  }

  private startChildForwardingForAllChildren(): void {
    for (const child of this.children) {
      this.startChildForwarding(child);
    }
  }

  private closeSubtreeEventStreams(): void {
    this.subtreeEventsQueue?.close();

    for (const subscriber of [...this.subtreeEventSubscribers]) {
      subscriber.close();
    }
  }

  private publishSubtreeEvent(event: TuvrenStreamEvent): void {
    this.subtreeEventsQueue?.push(cloneValue(event));

    for (const subscriber of this.subtreeEventSubscribers) {
      subscriber.push(cloneValue(event));
    }
  }

  private startSubtreeConsumer(
    queue: AsyncEventQueue<TuvrenStreamEvent>
  ): void {
    this.activeSubtreeStreams += 1;
    this.startExecution();

    if (this.subtreeSettled) {
      queue.close();
      return;
    }

    this.startChildForwardingForAllChildren();
  }

  private subscribeInternalSubtreeEvents(): AsyncIterator<TuvrenStreamEvent> {
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }

      closed = true;
      this.subtreeEventSubscribers.delete(queue);
      await this.closeSubtreeConsumer();
    };
    const queue = new AsyncEventQueue<TuvrenStreamEvent>(() => {
      detachPromise(close());
    });

    this.subtreeEventSubscribers.add(queue);
    this.startSubtreeConsumer(queue);
    return queue[Symbol.asyncIterator]();
  }

  private async stopAllChildForwarders(): Promise<void> {
    const iterators = [...this.childForwarders.values()];
    this.childForwarders.clear();
    const stopTasks: Promise<IteratorResult<TuvrenStreamEvent>>[] = [];

    for (const iterator of iterators) {
      if (iterator.return !== undefined) {
        stopTasks.push(iterator.return());
      }
    }

    await Promise.allSettled(stopTasks);
  }

  private async stopChildForwarding(child: OrchestrationNode): Promise<void> {
    const iterator = this.childForwarders.get(child);

    if (iterator === undefined) {
      return;
    }

    this.childForwarders.delete(child);

    if (iterator.return !== undefined) {
      await iterator.return();
    }
  }

  private async watchCurrentBinding(
    generation: number,
    bindingPromise: Promise<ExecutionBinding>
  ): Promise<void> {
    try {
      const binding = await bindingPromise;

      for await (const event of binding.handle.events()) {
        if (generation !== this.bindingGeneration) {
          return;
        }

        if (event.type === "error") {
          this.lastErrorProjection = event.error;
        }

        const decoratedEvent = this.decorateEvent(event, binding);
        this.selfEventsQueue?.push(cloneValue(decoratedEvent));
        this.publishSubtreeEvent(decoratedEvent);
      }

      this.selfEventsQueue?.close();

      if (generation !== this.bindingGeneration) {
        return;
      }

      this.finalizeCurrentBinding(binding);
    } catch (error: unknown) {
      if (generation !== this.bindingGeneration) {
        return;
      }

      const normalizedError = normalizeError(error);
      this.lastErrorProjection = projectError(normalizedError);
      const event: TuvrenStreamEvent = {
        error: this.lastErrorProjection,
        fatal: true,
        source:
          this.workerId === undefined
            ? {
                agent: this.localAgent,
              }
            : {
                agent: this.localAgent,
                workerId: this.workerId,
              },
        timestamp: this.now(),
        type: "error",
      };
      this.selfEventsQueue?.push(cloneValue(event));
      this.publishSubtreeEvent(event);
      this.selfEventsQueue?.close();
      this.selfPhase = "failed";
      this.settleResultFailure(normalizedError);
      this.maybeCloseSubtree();
    }
  }

  private async waitUntilSettled(): Promise<void> {
    await this.resultState.promise;
  }
}

function createSingleConsumerLazyStream<T>(input: {
  alreadyConsumedCode: string;
  alreadyConsumedMessage: string;
  isClaimed(): boolean;
  onClaim(): void;
  onClose: () => Promise<void> | void;
  onStart: (queue: AsyncEventQueue<T>) => void;
}): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
      let closed = false;
      let iterator: AsyncIterator<T> | undefined;
      let queue: AsyncEventQueue<T> | undefined;
      let started = false;

      const close = async (): Promise<void> => {
        if (!started || closed) {
          return;
        }

        closed = true;
        await input.onClose();
      };

      const start = (): void => {
        if (started) {
          return;
        }

        if (input.isClaimed()) {
          throw new TuvrenRuntimeError(input.alreadyConsumedMessage, {
            code: input.alreadyConsumedCode,
          });
        }

        try {
          input.onClaim();
          queue = new AsyncEventQueue<T>(() => {
            detachPromise(close());
          });
          iterator = queue[Symbol.asyncIterator]();
          started = true;
          input.onStart(queue);
        } catch (error: unknown) {
          queue?.close();
          throw error;
        }
      };

      return {
        next: async (): Promise<IteratorResult<T, undefined>> => {
          start();

          if (iterator === undefined) {
            return createIteratorDoneResult<T>();
          }

          const nextValue = await iterator.next();

          if (nextValue.done) {
            await close();
          }

          return nextValue;
        },
        return: async (): Promise<IteratorResult<T, undefined>> => {
          if (!started || iterator === undefined) {
            return createIteratorDoneResult<T>();
          }

          const result =
            iterator.return === undefined
              ? createIteratorDoneResult<T>()
              : await iterator.return();
          await close();
          return result;
        },
      };
    },
  };
}

function createIteratorDoneResult<T>(): IteratorResult<T, undefined> {
  return {
    done: true,
    value: undefined,
  };
}
