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

import { type HashString, TuvrenRuntimeError } from "@tuvren/core-types";
import type { PathValue } from "@tuvren/kernel-protocol";
import type {
  AgentConfig,
  ContextEngineeringContext,
  ContextEngineeringPlan,
  HandoffContextPlan,
  ToolRegistry,
} from "@tuvren/runtime-api";
import {
  createContextManifest,
  updateContextManifest,
} from "./context-manifest.js";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import type { HelperBundle } from "./runtime-core-context.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

export interface RuntimeCoreContextOpsHost {
  advanceTurnAndBranchHead(
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ): Promise<void>;
  beginRunStep(runId: string, stepId: string): Promise<void>;
  completeRunStep(
    runId: string,
    stepId: string,
    eventHash: HashString,
    treeHash?: HashString
  ): Promise<{
    lease?: { fencingToken: string; leaseExpiresAtMs: number };
    turnNodeHash?: HashString;
  }>;
  completeTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    status: "completed" | "failed" | "paused"
  ): Promise<{ turnNodeHash?: HashString }>;
  createActiveToolRegistry(
    runtimeTools: RuntimeExecutionHandle["request"]["tools"] | undefined,
    config: AgentConfig
  ): ToolRegistry;
  createContextEngineeringHelpers(
    messageHashes: HashString[],
    messages: RuntimeExecutionHandle["request"]["signal"]["parts"] extends never
      ? never
      : HeadState["messages"]
  ): HelperBundle;
  createId(): string;
  createTrackedRun(
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
  ): Promise<void>;
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: HeadState["manifest"]
  ): Promise<void>;
  loadHeadState(branchId: string): Promise<HeadState>;
  materializeContextMessages(
    hashes: HashString[],
    helpers: ContextEngineeringContext["helpers"]
  ): HeadState["messages"];
  publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void;
  resolveAgentConfig(name: string): AgentConfig | undefined;
  resolveHandoffSourceContext(
    plan: HandoffContextPlan,
    headState: HeadState,
    loopState: LoopState,
    targetConfig: AgentConfig,
    helpers: ContextEngineeringContext["helpers"]
  ): HandoffContextPlan["sourceContext"];
  stageRuntimeStatus(
    runId: string,
    status: {
      activeAgent?: string;
      state: "running";
    },
    taskId: string
  ): Promise<HashString>;
  storeEventRecord(event: Record<string, unknown>): Promise<HashString>;
  storeKernelRecord(value: unknown, label: string): Promise<HashString>;
  syncRunLeaseStateFromStepResult(
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: number } }
  ): void;
  treeCreate(
    schemaId: string,
    changes: Record<string, PathValue>,
    baseTurnTreeHash: HashString
  ): Promise<HashString>;
}

export async function applyContextEngineeringPlan(
  host: RuntimeCoreContextOpsHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  plan: ContextEngineeringPlan,
  loopState: LoopState,
  updates: ExtensionStateUpdate[]
): Promise<void> {
  const runId = host.createId();
  const headState = await host.loadHeadState(handle.request.branchId);
  const helperBundle = host.createContextEngineeringHelpers(
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
  const nextMessages = host.materializeContextMessages(
    resolvedMessageHashes,
    helperBundle.helpers
  );
  const nextManifest = updateContextManifest(
    createContextManifest(nextMessages, headState.manifest.extensions),
    [],
    updates
  );
  const nextManifestHash = await host.storeKernelRecord(
    nextManifest,
    "manifest"
  );
  const nextTreeHash = await host.treeCreate(
    schemaId,
    {
      "context.manifest": nextManifestHash,
      messages: resolvedMessageHashes,
    },
    headState.turnNode.turnTreeHash
  );

  await host.createTrackedRun(
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
  await host.beginRunStep(runId, "context_engineering");
  const stepResult = await completeRunStep(
    host,
    handle,
    runId,
    "context_engineering",
    {
      action: plan.action,
      turnId: handle.turnId,
      type: "context_engineering_applied",
    },
    nextTreeHash
  );
  await host.completeTrackedRun(handle, runId, "completed");
  if (stepResult.turnNodeHash !== undefined) {
    await host.advanceTurnAndBranchHead(handle, stepResult.turnNodeHash);
    await host.emitStateObservability(
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

export async function applyHandoff(
  host: RuntimeCoreContextOpsHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  plan: HandoffContextPlan,
  loopState: LoopState,
  updates: ExtensionStateUpdate[]
): Promise<{
  activeConfig: AgentConfig;
  activeToolRegistry: ToolRegistry;
}> {
  const targetConfig = host.resolveAgentConfig(plan.targetAgent);

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

  const headState = await host.loadHeadState(handle.request.branchId);
  const helperBundle = host.createContextEngineeringHelpers(
    headState.messageHashes,
    headState.messages
  );
  const sourceContext = host.resolveHandoffSourceContext(
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

  host.publishCustomEvent(
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
  const nextMessages = host.materializeContextMessages(
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
  const manifestHash = await host.storeKernelRecord(
    nextManifest,
    "handoff_manifest"
  );
  const statusHash = await host.storeKernelRecord(
    {
      activeAgent: targetConfig.name,
      state: "running",
    },
    "handoff_runtime_status"
  );
  const nextTreeHash = await host.treeCreate(
    schemaId,
    {
      "context.manifest": manifestHash,
      "runtime.status": statusHash,
      messages: resolvedMessageHashes,
    },
    headState.turnNode.turnTreeHash
  );
  const runId = host.createId();
  await host.createTrackedRun(
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
  await host.beginRunStep(runId, "handoff_context");
  const stepResult = await completeRunStep(
    host,
    handle,
    runId,
    "handoff_context",
    {
      targetAgent: targetConfig.name,
      turnId: handle.turnId,
      type: "handoff_applied",
    },
    nextTreeHash
  );
  await host.completeTrackedRun(handle, runId, "completed");

  if (stepResult.turnNodeHash !== undefined) {
    await host.advanceTurnAndBranchHead(handle, stepResult.turnNodeHash);
    await host.emitStateObservability(
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
  host.publishCustomEvent(
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
    activeToolRegistry: host.createActiveToolRegistry(undefined, targetConfig),
  };
}

function collectInitialExtensionStateUpdates(
  extensions: AgentConfig["extensions"],
  manifest: HeadState["manifest"]
): ExtensionStateUpdate[] {
  const extensionState = manifest.extensions;
  const updates: ExtensionStateUpdate[] = [];

  for (const extension of extensions ?? []) {
    const state = extensionState[extension.name];

    if (state !== undefined) {
      continue;
    }

    updates.push({
      extensionName: extension.name,
      state: { ...extension.state },
    });
  }

  return updates;
}

async function completeRunStep(
  host: RuntimeCoreContextOpsHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  stepId: string,
  event: Record<string, unknown>,
  treeHash?: HashString
) {
  const stepResult = await host.completeRunStep(
    runId,
    stepId,
    await host.storeEventRecord(event),
    treeHash
  );
  host.syncRunLeaseStateFromStepResult(handle, runId, stepResult);
  return stepResult;
}
