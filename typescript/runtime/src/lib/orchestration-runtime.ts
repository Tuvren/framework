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
import { type EpochMs, TuvrenRuntimeError } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  AgentConfig,
  ExecutionResult,
  ExecutionStatus,
  InputSignal,
  OrchestrationHandle,
  OrchestrationResult,
  OrchestrationRuntime,
  TuvrenRuntime,
} from "@tuvren/core/execution";
import type { ApprovalResponse } from "@tuvren/core/tools";
import {
  type ChildSpawnRequest,
  type ExecutionBinding,
  OrchestrationNode,
  type OrchestrationRuntimeNodeHost,
} from "./orchestration-runtime-node.js";
import {
  cloneExecutionStatus,
  cloneSnapshotPreservingFunctions,
  createFrozenSnapshot,
  normalizeInputSignal,
} from "./runtime-core-shared.js";

export interface OrchestrationRuntimeOptions {
  agents: Record<string, AgentConfig>;
  framework: TuvrenRuntime;
  now?: () => EpochMs;
}

class OrchestrationHandleImpl implements OrchestrationHandle {
  private active = true;
  private inactiveStatus?: ExecutionStatus;
  private readonly node: OrchestrationNode;
  private readonly spawnedChildNodes: Array<{
    node: OrchestrationNode;
    workerId: string;
  }> = [];

  constructor(
    node: OrchestrationNode,
    existingChildren?: ReadonlyArray<{
      node: OrchestrationNode;
      workerId: string;
    }>
  ) {
    this.node = node;
    if (existingChildren !== undefined) {
      this.spawnedChildNodes.push(...existingChildren);
    }
  }

  allEvents(): AsyncIterable<TuvrenStreamEvent> {
    this.assertActive("allEvents");
    return this.node.allEvents();
  }

  async awaitResult(): Promise<OrchestrationResult> {
    this.assertActive("awaitResult");
    const ownResult = await this.node.awaitResult();
    const childResults = await this.collectChildResults();

    if (ownResult.status === "completed") {
      return {
        childResults,
        executionStatus: ownResult.executionStatus,
        finalAssistantMessage: ownResult.finalAssistantMessage,
        status: "completed",
      };
    }

    return {
      childResults,
      error: ownResult.error,
      executionStatus: ownResult.executionStatus,
      status: "failed",
    };
  }

  cancel(): void {
    this.assertActive("cancel");
    this.node.cancel();
  }

  events(): AsyncIterable<TuvrenStreamEvent> {
    this.assertActive("events");
    return this.node.events();
  }

  resolveApproval(response: ApprovalResponse): OrchestrationHandle {
    this.assertActive("resolveApproval");
    const pausedStatus = this.node.currentStatus();
    const resumedNode = this.node.replaceAfterApproval(response);
    this.deactivate(pausedStatus);
    // Forward pre-pause children so awaitResult() on the resumed handle
    // still aggregates their results.
    return new OrchestrationHandleImpl(resumedNode, this.spawnedChildNodes);
  }

  spawn(input: { agent: string; signal: InputSignal }): OrchestrationHandle {
    this.assertActive("spawn");
    const childNode = this.node.spawn({
      agent: input.agent,
      signal: input.signal,
    });
    const workerId = childNode.nodeWorkerId;

    if (workerId !== undefined) {
      this.spawnedChildNodes.push({ node: childNode, workerId });
    }

    return new OrchestrationHandleImpl(childNode);
  }

  status(): ExecutionStatus {
    const status =
      this.active || this.inactiveStatus === undefined
        ? this.node.currentStatus()
        : this.inactiveStatus;

    return cloneExecutionStatus(status);
  }

  steer(signal: InputSignal): void {
    this.assertActive("steer");
    this.node.steer(signal);
  }

  private async collectChildResults(): Promise<
    Record<string, ExecutionResult>
  > {
    if (this.spawnedChildNodes.length === 0) {
      return {};
    }

    const entries = await Promise.all(
      this.spawnedChildNodes.map(async ({ node, workerId }) => {
        let result: ExecutionResult;

        try {
          result = await node.awaitResult();
        } catch (error: unknown) {
          result = {
            error:
              error instanceof TuvrenRuntimeError
                ? error
                : new TuvrenRuntimeError("Child execution failed", {
                    code: "execution_failed",
                  }),
            executionStatus: node.currentStatus(),
            status: "failed",
          };
        }

        return [workerId, result] as const;
      })
    );

    return Object.fromEntries(entries);
  }

  private assertActive(methodName: string): void {
    if (!this.active) {
      throw new TuvrenRuntimeError(
        `${methodName}() requires the current orchestration handle`,
        {
          code: "invalid_orchestration_handle",
        }
      );
    }
  }

  private deactivate(inactiveStatus?: ExecutionStatus): void {
    if (!this.active) {
      return;
    }

    this.active = false;
    if (inactiveStatus !== undefined) {
      this.inactiveStatus = cloneExecutionStatus(inactiveStatus);
    }
  }
}

class OrchestrationRuntimeImpl
  implements OrchestrationRuntime, OrchestrationRuntimeNodeHost
{
  private readonly agents: Record<string, AgentConfig>;
  private readonly framework: TuvrenRuntime;
  private readonly now: () => EpochMs;

  constructor(
    framework: TuvrenRuntime,
    agents: Record<string, AgentConfig>,
    now: () => EpochMs
  ) {
    this.framework = framework;
    this.agents = snapshotAgentConfigs(agents);
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
    const requestedTools =
      input.tools === undefined ? undefined : createFrozenSnapshot(input.tools);
    const handle = this.framework.executeTurn({
      branchId: input.branchId,
      config,
      driverId: input.driverId,
      parentTurnId: input.parentTurnId,
      schemaId: input.schemaId,
      signal: input.signal,
      threadId: input.threadId,
      tools: requestedTools,
    });
    const node = new OrchestrationNode(this, input.agent, this.now, {
      binding: {
        agent: input.agent,
        branchId: input.branchId,
        driverId: input.driverId,
        handle,
        schemaId: input.schemaId,
        threadId: input.threadId,
        tools: requestedTools,
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
      throw new TuvrenRuntimeError(
        "orchestration could not resolve the parent thread before spawning a child",
        {
          code: "invalid_orchestration_parent",
          details: {
            parentThreadId: parentBinding.threadId,
          },
        }
      );
    }

    // Child spawning stays intentionally minimal, so the caller's explicit
    // execution surface (including schemaId when provided) must carry forward.
    const resolvedSchemaId = parentBinding.schemaId ?? parentThread.schemaId;
    const childThread = await this.framework.createThread({
      schemaId: resolvedSchemaId,
    });
    const childHandle = this.framework.executeTurn({
      branchId: childThread.branchId,
      config,
      driverId: parentBinding.driverId,
      schemaId: resolvedSchemaId,
      signal: normalizeInputSignal(input.signal, "orchestration child signal"),
      threadId: childThread.threadId,
      tools: parentBinding.tools,
    });

    return {
      agent: input.agent,
      branchId: childThread.branchId,
      driverId: parentBinding.driverId,
      handle: childHandle,
      schemaId: resolvedSchemaId,
      threadId: childThread.threadId,
      tools: parentBinding.tools,
      workerId,
    };
  }

  createId(): string {
    return randomUUID();
  }

  private resolveAgent(agentName: string): AgentConfig {
    const config = this.agents[agentName];

    if (config === undefined) {
      throw new TuvrenRuntimeError(
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

function snapshotAgentConfigs(
  agents: Record<string, AgentConfig>
): Record<string, AgentConfig> {
  const snapshots: Record<string, AgentConfig> = {};

  for (const [agentName, config] of Object.entries(agents)) {
    // Snapshot orchestration-owned agent configs up front without freezing the
    // receiver objects that live execution invokes as method-style hooks.
    snapshots[agentName] = cloneSnapshotPreservingFunctions(config);
  }

  return snapshots;
}
