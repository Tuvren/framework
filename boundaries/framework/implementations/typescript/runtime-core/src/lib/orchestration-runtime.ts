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
  ApprovalResponse,
  ContentPart,
  ExecutionHandle,
  ExecutionStatus,
  InputSignal,
  KrakenErrorProjection,
  KrakenRuntime,
  KrakenStreamEvent,
  OrchestrationHandle,
  OrchestrationRuntime,
  ToolResultPart,
} from "@kraken/framework-runtime-api";
import { type EpochMs, KrakenRuntimeError } from "@kraken/shared-core-types";
import {
  AsyncEventQueue,
  createDeferred,
  detachPromise,
  EventFanout,
  normalizeError,
  normalizeInputSignal,
  projectError,
} from "./runtime-core-shared.js";

export interface OrchestrationRuntimeOptions {
  agents: Record<string, AgentConfig>;
  framework: KrakenRuntime;
  now?: () => EpochMs;
}

interface ExecutionBinding {
  agent: string;
  branchId: string;
  handle: ExecutionHandle;
  threadId: string;
  workerId?: string;
}

interface ChildSpawnRequest {
  agent: string;
  signal: InputSignal;
}

class OrchestrationNode {
  private readonly children = new Set<OrchestrationNode>();
  private currentBinding?: ExecutionBinding;
  private currentBindingPromise?: Promise<ExecutionBinding>;
  private bindingGeneration = 0;
  private watchingGeneration?: number;
  private initializationFailed = false;
  private cancelledBeforeReady = false;
  private lastErrorProjection?: KrakenErrorProjection;
  private readonly now: () => EpochMs;
  private readonly resultState = createDeferred<unknown>();
  private readonly runtime: OrchestrationRuntimeImpl;
  private selfPhase: ExecutionStatus["phase"] = "running";
  private selfResultResolved = false;
  private selfVisibleResult?: ContentPart[] | ToolResultPart;
  private startedExecution = false;
  private readonly subtreeEvents = new EventFanout<KrakenStreamEvent>();
  private subtreeSettled = false;
  private readonly workerId?: string;
  private readonly localAgent: string;
  private readonly localHandleStatus: ExecutionStatus;

  constructor(
    runtime: OrchestrationRuntimeImpl,
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
          this.emitSyntheticLifecycleFailure(normalizedError);
          throw normalizedError;
        });
    }
  }

  allEvents(): AsyncIterable<KrakenStreamEvent> {
    this.ensureWatchingCurrentBinding();
    return this.subtreeEvents.subscribe();
  }

  async awaitResult(): Promise<unknown> {
    this.ensureWatchingCurrentBinding();
    return await this.resultState.promise;
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

  events(): AsyncIterable<KrakenStreamEvent> {
    const queue = new AsyncEventQueue<KrakenStreamEvent>();
    this.ensureWatchingCurrentBinding();
    detachPromise(this.forwardCurrentGenerationEvents(queue));
    return queue;
  }

  hasStartedExecution(): boolean {
    return this.startedExecution;
  }

  registerChild(child: OrchestrationNode): void {
    this.children.add(child);
    detachPromise(this.forwardChildEvents(child));
  }

  steer(signal: InputSignal): void {
    this.requireCurrentBinding("steer").handle.steer(signal);
  }

  replaceAfterApproval(response: ApprovalResponse): OrchestrationNode {
    const binding = this.requireCurrentBinding("resolveApproval");
    const status = binding.handle.status();

    if (status.phase !== "paused") {
      throw new KrakenRuntimeError(
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
    this.ensureWatchingCurrentBinding();
    return this;
  }

  spawn(input: ChildSpawnRequest): OrchestrationNode {
    const binding = this.requireCurrentBinding("spawn");

    if (!this.startedExecution) {
      throw new KrakenRuntimeError(
        "spawn() requires the orchestration handle to start execution first",
        {
          code: "orchestration_parent_not_started",
        }
      );
    }

    const phase = binding.handle.status().phase;

    if (phase !== "running" && phase !== "paused") {
      throw new KrakenRuntimeError(
        "spawn() requires a running or paused orchestration handle",
        {
          code: "orchestration_parent_inactive",
          details: {
            phase,
          },
        }
      );
    }

    const workerId = this.runtime.createId();
    const childNode = new OrchestrationNode(
      this.runtime,
      input.agent,
      this.now,
      {
        bindingPromise: this.runtime.createChildBinding(
          binding,
          workerId,
          input
        ),
        workerId,
      }
    );
    this.registerChild(childNode);
    childNode.ensureWatchingCurrentBinding();
    return childNode;
  }

  private decorateEvent(
    event: KrakenStreamEvent,
    binding: ExecutionBinding
  ): KrakenStreamEvent {
    if (binding.workerId === undefined) {
      return event;
    }

    return {
      ...event,
      source: {
        ...(event.source ?? {}),
        agent: binding.agent,
        threadId: binding.threadId,
        workerId: binding.workerId,
      },
    };
  }

  private emitSyntheticLifecycleFailure(error: Error): void {
    const source =
      this.workerId === undefined
        ? {
            agent: this.localAgent,
          }
        : {
            agent: this.localAgent,
            workerId: this.workerId,
          };
    this.subtreeEvents.emit({
      error: projectError(error),
      fatal: true,
      source,
      timestamp: this.now(),
      type: "error",
    });
    this.settleResultFailure(error);
    this.maybeCloseSubtree();
  }

  private ensureWatchingCurrentBinding(): void {
    if (
      this.currentBindingPromise === undefined ||
      this.watchingGeneration === this.bindingGeneration
    ) {
      return;
    }

    this.startedExecution = true;
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

  private async forwardChildEvents(child: OrchestrationNode): Promise<void> {
    try {
      for await (const event of child.allEvents()) {
        this.subtreeEvents.emit(event);
      }
    } finally {
      this.children.delete(child);
      this.maybeCloseSubtree();
    }
  }

  private async forwardCurrentGenerationEvents(
    queue: AsyncEventQueue<KrakenStreamEvent>
  ): Promise<void> {
    try {
      const binding = await this.requireCurrentBindingAsync("events");

      for await (const event of binding.handle.events()) {
        queue.push(this.decorateEvent(event, binding));
      }
    } catch (error: unknown) {
      queue.push({
        error: projectError(normalizeError(error)),
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
      });
    } finally {
      queue.close();
    }
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
    this.subtreeEvents.close();
  }

  private requireCurrentBinding(methodName: string): ExecutionBinding {
    if (this.currentBinding === undefined) {
      throw new KrakenRuntimeError(
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
      throw new KrakenRuntimeError(
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
    this.resultState.resolve(
      Promise.reject(Object.assign(new Error(projection.message), projection))
    );
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
    this.resultState.resolve(this.selfVisibleResult);
  }

  private trackVisibleResult(
    event: KrakenStreamEvent,
    state: {
      assistantParts: ContentPart[];
      lastVisible: ContentPart[] | ToolResultPart | undefined;
    }
  ): void {
    switch (event.type) {
      case "message.start":
        state.assistantParts = [];
        return;
      case "file.done":
        state.assistantParts.push({
          data:
            typeof event.data === "string"
              ? event.data
              : new Uint8Array(event.data),
          filename: event.filename,
          mediaType: event.mediaType,
          type: "file",
        });
        return;
      case "text.done":
        state.assistantParts.push({
          text: event.text,
          type: "text",
        });
        return;
      case "structured.done":
        state.assistantParts.push({
          data: structuredClone(event.data),
          name: event.name,
          type: "structured",
        });
        return;
      case "tool.result":
        state.lastVisible = {
          callId: event.callId,
          isError: event.isError,
          name: event.name,
          output: event.output,
          type: "tool_result",
        };
        return;
      case "message.done":
        if (state.assistantParts.length > 0) {
          state.lastVisible = state.assistantParts.map((part) =>
            cloneVisibleContentPart(part)
          );
        }

        state.assistantParts = [];
        return;
      case "error":
        this.lastErrorProjection = event.error;
        return;
      default:
        return;
    }
  }

  private async watchCurrentBinding(
    generation: number,
    bindingPromise: Promise<ExecutionBinding>
  ): Promise<void> {
    try {
      const binding = await bindingPromise;
      const visibleState = {
        assistantParts: [],
        lastVisible: this.selfVisibleResult,
      } satisfies {
        assistantParts: ContentPart[];
        lastVisible: ContentPart[] | ToolResultPart | undefined;
      };

      for await (const event of binding.handle.events()) {
        if (generation !== this.bindingGeneration) {
          return;
        }

        const decoratedEvent = this.decorateEvent(event, binding);
        this.trackVisibleResult(event, visibleState);
        this.subtreeEvents.emit(decoratedEvent);
      }

      this.selfVisibleResult = visibleState.lastVisible;

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
      this.subtreeEvents.emit({
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
      });
      this.selfPhase = "failed";
      this.settleResultFailure(normalizedError);
      this.maybeCloseSubtree();
    }
  }
}

class OrchestrationHandleImpl implements OrchestrationHandle {
  private active = true;
  private readonly localSubtreeEvents = new EventFanout<KrakenStreamEvent>();
  private subtreeForwardingStarted = false;
  private readonly node: OrchestrationNode;

  constructor(node: OrchestrationNode) {
    this.node = node;
  }

  allEvents(): AsyncIterable<KrakenStreamEvent> {
    this.assertActive("allEvents");
    this.ensureSubtreeForwarding();
    return this.localSubtreeEvents.subscribe();
  }

  awaitResult(): Promise<unknown> {
    return this.node.awaitResult();
  }

  cancel(): void {
    this.assertActive("cancel");
    this.node.cancel();
  }

  events(): AsyncIterable<KrakenStreamEvent> {
    this.assertActive("events");
    return this.node.events();
  }

  resolveApproval(response: ApprovalResponse): OrchestrationHandle {
    this.assertActive("resolveApproval");
    const resumedNode = this.node.replaceAfterApproval(response);
    this.deactivate();
    return new OrchestrationHandleImpl(resumedNode);
  }

  spawn(input: { agent: string; signal: InputSignal }): OrchestrationHandle {
    this.assertActive("spawn");
    return new OrchestrationHandleImpl(
      this.node.spawn({
        agent: input.agent,
        signal: input.signal,
      })
    );
  }

  status(): ExecutionStatus {
    return this.node.currentStatus();
  }

  steer(signal: InputSignal): void {
    this.assertActive("steer");
    this.node.steer(signal);
  }

  private assertActive(methodName: string): void {
    if (!this.active) {
      throw new KrakenRuntimeError(
        `${methodName}() requires the current orchestration handle`,
        {
          code: "invalid_orchestration_handle",
        }
      );
    }
  }

  private deactivate(): void {
    if (!this.active) {
      return;
    }

    this.active = false;
    this.localSubtreeEvents.close();
  }

  private ensureSubtreeForwarding(): void {
    if (this.subtreeForwardingStarted) {
      return;
    }

    this.subtreeForwardingStarted = true;
    detachPromise(
      (async () => {
        try {
          for await (const event of this.node.allEvents()) {
            if (!this.active) {
              break;
            }

            this.localSubtreeEvents.emit(event);
          }
        } finally {
          this.localSubtreeEvents.close();
        }
      })()
    );
  }
}

class OrchestrationRuntimeImpl implements OrchestrationRuntime {
  private readonly agents: Record<string, AgentConfig>;
  private readonly framework: KrakenRuntime;
  private readonly now: () => EpochMs;

  constructor(
    framework: KrakenRuntime,
    agents: Record<string, AgentConfig>,
    now: () => EpochMs
  ) {
    this.framework = framework;
    this.agents = agents;
    this.now = now;
  }

  executeTurn(input: {
    agent: string;
    branchId: string;
    driverId?: string;
    parentTurnId?: string | null;
    schemaId?: string;
    signal: InputSignal;
    threadId: string;
    tools?: AgentConfig["tools"];
  }): OrchestrationHandle {
    const config = this.resolveAgent(input.agent);
    const handle = this.framework.executeTurn({
      branchId: input.branchId,
      config,
      driverId: input.driverId,
      parentTurnId: input.parentTurnId,
      schemaId: input.schemaId,
      signal: input.signal,
      threadId: input.threadId,
      tools: input.tools,
    });
    const node = new OrchestrationNode(this, input.agent, this.now, {
      binding: {
        agent: input.agent,
        branchId: input.branchId,
        handle,
        threadId: input.threadId,
      },
    });
    return new OrchestrationHandleImpl(node);
  }

  async createChildBinding(
    parentBinding: ExecutionBinding,
    workerId: string,
    input: ChildSpawnRequest
  ): Promise<ExecutionBinding> {
    const config = this.resolveAgent(input.agent);
    const parentThread = await this.framework.getThread(parentBinding.threadId);

    if (parentThread === null) {
      throw new KrakenRuntimeError(
        "orchestration could not resolve the parent thread before spawning a child",
        {
          code: "invalid_orchestration_parent",
          details: {
            parentThreadId: parentBinding.threadId,
          },
        }
      );
    }

    const childThread = await this.framework.createThread({
      schemaId: parentThread.schemaId,
    });
    const childHandle = this.framework.executeTurn({
      branchId: childThread.branchId,
      config,
      signal: normalizeInputSignal(input.signal, "orchestration child signal"),
      threadId: childThread.threadId,
    });

    return {
      agent: input.agent,
      branchId: childThread.branchId,
      handle: childHandle,
      threadId: childThread.threadId,
      workerId,
    };
  }

  createId(): string {
    return randomUUID();
  }

  private resolveAgent(agentName: string): AgentConfig {
    const config = this.agents[agentName];

    if (config === undefined) {
      throw new KrakenRuntimeError(
        `orchestration agent "${agentName}" is not defined`,
        {
          code: "unknown_orchestration_agent",
          details: {
            agentName,
          },
        }
      );
    }

    return config;
  }
}

export function createOrchestrationRuntime(
  options: OrchestrationRuntimeOptions
): OrchestrationRuntime {
  return new OrchestrationRuntimeImpl(
    options.framework,
    options.agents,
    options.now ?? Date.now
  );
}

function cloneVisibleContentPart(part: ContentPart): ContentPart {
  switch (part.type) {
    case "file":
      return {
        data:
          typeof part.data === "string" ? part.data : new Uint8Array(part.data),
        filename: part.filename,
        mediaType: part.mediaType,
        providerMetadata:
          part.providerMetadata === undefined
            ? undefined
            : structuredClone(part.providerMetadata),
        type: "file",
      };
    case "structured":
      return {
        data: structuredClone(part.data),
        name: part.name,
        providerMetadata:
          part.providerMetadata === undefined
            ? undefined
            : structuredClone(part.providerMetadata),
        type: "structured",
      };
    case "text":
      return {
        providerMetadata:
          part.providerMetadata === undefined
            ? undefined
            : structuredClone(part.providerMetadata),
        text: part.text,
        type: "text",
      };
    default:
      return part;
  }
}
