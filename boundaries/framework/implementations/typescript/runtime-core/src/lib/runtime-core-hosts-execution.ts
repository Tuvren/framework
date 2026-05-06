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

import type { EpochMs, HashString, KernelRecord } from "@tuvren/core-types";
import type { PathValue, RunCompletionStatus } from "@tuvren/kernel-protocol";
import type {
  ContextManifest,
  RuntimeResolution,
  ToolRegistry,
} from "@tuvren/runtime-api";
import type { RuntimeCoreDriverHost } from "./runtime-core-driver.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type { RuntimeCoreStatusHost } from "./runtime-core-status.js";
import type { RuntimeCoreToolResumeHost } from "./runtime-core-tool-resume.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

interface DriverHostDependencies {
  completeIterationRun: RuntimeCoreDriverHost["completeIterationRun"];
  createDriverAgentConfigSnapshot(
    config: LoopState["activeConfig"]
  ): LoopState["activeConfig"];
  createDriverHandoffContextPlan: RuntimeCoreDriverHost["createDriverHandoffContextPlan"];
  createDriverPublishedEvent: RuntimeCoreDriverHost["createDriverPublishedEvent"];
  createIterationTree: RuntimeCoreDriverHost["createIterationTree"];
  createReadonlyDriverToolRegistry(registry: ToolRegistry): ToolRegistry;
  createToolBatchEnvironment: RuntimeCoreDriverHost["createToolBatchEnvironment"];
  failTrackedRunWithoutBranchAdvance(
    handle: RuntimeExecutionHandle,
    runId: string,
    stableHeadTurnNodeHash: HashString
  ): Promise<void>;
  now(): EpochMs;
  publishCustomEvent: RuntimeCoreDriverHost["publishCustomEvent"];
  publishProjectedError: RuntimeCoreDriverHost["publishProjectedError"];
  stageManifest: RuntimeCoreDriverHost["stageManifest"];
  stageMessage: RuntimeCoreDriverHost["stageMessage"];
  stageRuntimeStatus: RuntimeCoreDriverHost["stageRuntimeStatus"];
}

interface ToolResumeHostDependencies {
  beginIterationStep(runId: string, stepId: string): Promise<void>;
  completeIterationRun: RuntimeCoreToolResumeHost["completeIterationRun"];
  createId(): string;
  createIterationTree: RuntimeCoreToolResumeHost["createIterationTree"];
  createTrackedRun: RuntimeCoreToolResumeHost["createTrackedRun"];
  failTrackedRunWithoutBranchAdvance(
    handle: RuntimeExecutionHandle,
    runId: string,
    stableHeadTurnNodeHash: HashString
  ): Promise<void>;
  loadHeadState(branchId: string): Promise<HeadState>;
  now(): EpochMs;
  publishCustomEvent: RuntimeCoreToolResumeHost["publishCustomEvent"];
  publishEvent: RuntimeCoreToolResumeHost["publishEvent"];
  publishProjectedError: RuntimeCoreToolResumeHost["publishProjectedError"];
  resolveActiveMaxParallelToolCalls(loopState: LoopState): number;
  resolveCheckpointedPausedRun(
    runId: string,
    turnId: string,
    resolution: RuntimeResolution
  ): Promise<void>;
  stageManifest: RuntimeCoreToolResumeHost["stageManifest"];
  stageMessage: RuntimeCoreToolResumeHost["stageMessage"];
  stageRuntimeStatus: RuntimeCoreToolResumeHost["stageRuntimeStatus"];
}

interface StatusHostDependencies {
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
    status: RunCompletionStatus,
    event?: KernelRecord
  ): Promise<{ turnNodeHash?: HashString }>;
  createId(): string;
  createTrackedRun: RuntimeCoreStatusHost["createTrackedRun"];
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): Promise<void>;
  loadHeadState(branchId: string): Promise<HeadState>;
  stageManifest: RuntimeCoreStatusHost["stageManifest"];
  stageRuntimeStatus: RuntimeCoreStatusHost["stageRuntimeStatus"];
  storeEventRecord(event: KernelRecord): Promise<HashString>;
  syncRunLeaseStateFromStepResult(
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
  ): void;
  treeCreate(
    schemaId: string,
    changes: Record<string, PathValue>,
    baseTurnTreeHash: HashString
  ): Promise<HashString>;
}

export function buildRuntimeCoreDriverHost(
  dependencies: DriverHostDependencies
): RuntimeCoreDriverHost {
  return {
    completeIterationRun: (...args) =>
      dependencies.completeIterationRun(...args),
    createDriverAgentConfigSnapshot: (config) =>
      dependencies.createDriverAgentConfigSnapshot(config),
    createDriverHandoffContextPlan: (...args) =>
      dependencies.createDriverHandoffContextPlan(...args),
    createDriverPublishedEvent: (...args) =>
      dependencies.createDriverPublishedEvent(...args),
    createIterationTree: (...args) => dependencies.createIterationTree(...args),
    createReadonlyDriverToolRegistry: (registry) =>
      dependencies.createReadonlyDriverToolRegistry(registry),
    createToolBatchEnvironment: (...args) =>
      dependencies.createToolBatchEnvironment(...args),
    failTrackedRunWithoutBranchAdvance: (...args) =>
      dependencies.failTrackedRunWithoutBranchAdvance(...args),
    now: () => dependencies.now(),
    publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
    publishProjectedError: (...args) =>
      dependencies.publishProjectedError(...args),
    stageManifest: (...args) => dependencies.stageManifest(...args),
    stageMessage: (...args) => dependencies.stageMessage(...args),
    stageRuntimeStatus: (...args) => dependencies.stageRuntimeStatus(...args),
  };
}

export function buildRuntimeCoreToolResumeHost(
  dependencies: ToolResumeHostDependencies
): RuntimeCoreToolResumeHost {
  return {
    beginIterationStep: (runId, stepId) =>
      dependencies.beginIterationStep(runId, stepId),
    completeIterationRun: (...args) =>
      dependencies.completeIterationRun(...args),
    createId: () => dependencies.createId(),
    createIterationTree: (...args) => dependencies.createIterationTree(...args),
    createTrackedRun: (...args) => dependencies.createTrackedRun(...args),
    failTrackedRunWithoutBranchAdvance: (...args) =>
      dependencies.failTrackedRunWithoutBranchAdvance(...args),
    loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
    now: () => dependencies.now(),
    publishCustomEvent: (...args) => dependencies.publishCustomEvent(...args),
    publishEvent: (...args) => dependencies.publishEvent(...args),
    publishProjectedError: (...args) =>
      dependencies.publishProjectedError(...args),
    resolveActiveMaxParallelToolCalls: (loopState) =>
      dependencies.resolveActiveMaxParallelToolCalls(loopState),
    resolveCheckpointedPausedRun: (...args) =>
      dependencies.resolveCheckpointedPausedRun(...args),
    stageManifest: (...args) => dependencies.stageManifest(...args),
    stageMessage: (...args) => dependencies.stageMessage(...args),
    stageRuntimeStatus: (...args) => dependencies.stageRuntimeStatus(...args),
  };
}

export function buildRuntimeCoreStatusHost(
  dependencies: StatusHostDependencies
): RuntimeCoreStatusHost {
  return {
    advanceTurnAndBranchHead: (...args) =>
      dependencies.advanceTurnAndBranchHead(...args),
    beginRunStep: (runId, stepId) => dependencies.beginRunStep(runId, stepId),
    completeRunStep: (runId, stepId, eventHash, treeHash) =>
      dependencies.completeRunStep(runId, stepId, eventHash, treeHash),
    completeTrackedRun: (...args) => dependencies.completeTrackedRun(...args),
    createId: () => dependencies.createId(),
    createTrackedRun: (...args) => dependencies.createTrackedRun(...args),
    emitStateObservability: (...args) =>
      dependencies.emitStateObservability(...args),
    loadHeadState: (branchId) => dependencies.loadHeadState(branchId),
    stageManifest: (...args) => dependencies.stageManifest(...args),
    stageRuntimeStatus: (...args) => dependencies.stageRuntimeStatus(...args),
    storeEventRecord: (event) => dependencies.storeEventRecord(event),
    syncRunLeaseStateFromStepResult: (...args) =>
      dependencies.syncRunLeaseStateFromStepResult(...args),
    treeCreate: (schemaId, changes, baseTurnTreeHash) =>
      dependencies.treeCreate(schemaId, changes, baseTurnTreeHash),
  };
}
