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

import { type HashString, TuvrenRuntimeError } from "@tuvren/core";
import type {
  ContextManifest,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import { buildCapabilityMetadataFromTools } from "./capability-policy-engine.js";
import { updateContextManifest } from "./context-manifest.js";
import { runAfterIterationHooks } from "./extension-runtime.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type { LoopOutcome } from "./runtime-core-recovery.js";
import {
  composeResolutions,
  createApprovalRejectionResolution,
  createRejectedApprovalResponse,
  formatToolResultTaskId,
} from "./runtime-core-response.js";
import { normalizeError } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { PauseContext, ResumeContext } from "./runtime-execution-types.js";
import {
  resumeToolBatch,
  type ToolBatchEnvironment,
  type ToolBatchOutcome,
} from "./tool-execution.js";

export interface RuntimeCoreToolResumeHost {
  beginIterationStep(runId: string, stepId: string): Promise<void>;
  completeIterationRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    resolution: RuntimeResolution,
    manifest: ContextManifest,
    iterationCount: number,
    loopState: LoopState,
    nextTreeHash: HashString | undefined
  ): Promise<HashString | undefined>;
  createId(): string;
  createIterationTree(
    schemaId: string,
    baseTurnTreeHash: HashString,
    baseMessageHashes: HashString[],
    appendedMessageHashes: HashString[],
    manifestHash: HashString,
    runtimeStatusHash?: HashString
  ): Promise<HashString>;
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
  failTrackedRunWithoutBranchAdvance(
    handle: RuntimeExecutionHandle,
    runId: string,
    stableHeadTurnNodeHash: HashString
  ): Promise<void>;
  loadHeadState(branchId: string): Promise<HeadState>;
  now(): number;
  publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void;
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: {
      messageId?: HashString;
      timestamp: number;
      type: string;
    },
    loopState: LoopState
  ): void;
  publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ): void;
  resolveActiveMaxParallelToolCalls(loopState: LoopState): number;
  resolveCheckpointedPausedRun(
    runId: string,
    turnId: string,
    resolution: RuntimeResolution
  ): Promise<void>;
  stageManifest(
    runId: string,
    manifest: ContextManifest,
    warningContext?: {
      handle: RuntimeExecutionHandle;
      loopState: LoopState;
    }
  ): Promise<HashString>;
  stageMessage(
    runId: string,
    message: TuvrenMessage,
    taskId: string
  ): Promise<HashString>;
  stageRuntimeStatus(
    runId: string,
    status: {
      activeAgent?: string;
      pauseReason?: string;
      state: "completed" | "failed" | "paused" | "running";
    },
    taskId: string
  ): Promise<HashString>;
}

export async function resumePausedToolExecution(
  host: RuntimeCoreToolResumeHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  resumeContext: ResumeContext
): Promise<LoopOutcome> {
  const pausedIteration = resumeContext.pauseContext.pausedIteration;

  loopState.enteredIterationLoop = true;
  const headState = await host.loadHeadState(handle.request.branchId);
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
        id: "iterate",
        sideEffects: true,
      },
    ]
  );
  await host.beginIterationStep(runId, "iterate");

  let toolBatch: ToolBatchOutcome;

  try {
    toolBatch = await resumeToolBatch(
      resumeContext.pauseContext.approval,
      resumeContext.approval,
      createToolBatchEnvironment(
        host,
        handle,
        loopState,
        headState.manifest,
        pausedIteration.iterationCount,
        runId
      ),
      pausedIteration.toolExecutionMode
    );
  } catch (error: unknown) {
    await host.failTrackedRunWithoutBranchAdvance(
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
  const manifestHash = await host.stageManifest(runId, manifest, {
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
      ? await host.stageRuntimeStatus(
          runId,
          {
            activeAgent: loopState.activeConfig.name,
            pauseReason: resolution.reason,
            state: "paused",
          },
          "runtime_status_paused"
        )
      : undefined;
  const nextTreeHash = await host.createIterationTree(
    schemaId,
    headState.turnNode.turnTreeHash,
    headState.messageHashes,
    toolBatch.resultHashes,
    manifestHash,
    runtimeStatusHash
  );

  const turnNodeHash = await host.completeIterationRun(
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

  const latestHeadState = await host.loadHeadState(handle.request.branchId);
  const afterIteration = await runAfterIterationHooks({
    emit: (event) => {
      host.publishCustomEvent(handle, event, loopState);
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

  if (resolution.type === "pause") {
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
        clientEndpointBoundary: loopState.clientEndpointBoundary,
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

  if (resolution.type !== "continue_iteration") {
    await host.resolveCheckpointedPausedRun(runId, handle.turnId, resolution);

    if (resolution.type === "fail" && resolution.fatality === "soft") {
      host.publishProjectedError(handle, resolution.error, false, loopState);
    }
  }

  return {
    resolution,
  };
}

export async function finalizeRejectedPausedToolCancellation(
  host: RuntimeCoreToolResumeHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  pauseContext: PauseContext
): Promise<LoopOutcome> {
  const pausedIteration = pauseContext.pausedIteration;

  loopState.enteredIterationLoop = true;
  const headState = await host.loadHeadState(handle.request.branchId);
  const runId = host.createId();

  await host.createTrackedRun(
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
  await host.beginIterationStep(runId, "iterate");

  let toolBatch: ToolBatchOutcome;

  try {
    toolBatch = await resumeToolBatch(
      pauseContext.approval,
      createRejectedApprovalResponse(pauseContext.approval),
      createToolBatchEnvironment(
        host,
        handle,
        loopState,
        headState.manifest,
        pausedIteration.iterationCount,
        runId
      ),
      pausedIteration.toolExecutionMode
    );
  } catch (resumeError: unknown) {
    await host.failTrackedRunWithoutBranchAdvance(
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
  const manifestHash = await host.stageManifest(runId, manifest, {
    handle,
    loopState,
  });
  const nextTreeHash = await host.createIterationTree(
    handle.schemaId,
    headState.turnNode.turnTreeHash,
    headState.messageHashes,
    toolBatch.resultHashes,
    manifestHash
  );

  await host.completeIterationRun(
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

function createToolBatchEnvironment(
  host: RuntimeCoreToolResumeHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  manifest: ContextManifest,
  iterationCount: number,
  runId: string
): ToolBatchEnvironment {
  // BB005: include capability policy engine and context so the resume-path
  // invocation check in resolveResumeDecision can re-evaluate policy when
  // context may have changed between the initial pause and the resumed approval.
  const policyEngine = loopState.activeConfig.capabilityPolicyEngine;
  const policyCapabilityMetadata =
    policyEngine === undefined
      ? undefined
      : buildCapabilityMetadataFromTools(loopState.activeToolRegistry.list());
  const policyContextInputs =
    loopState.activeConfig.policyContextInputs ?? undefined;

  return {
    activeAgent: loopState.activeConfig.name,
    branchId: handle.request.branchId,
    capabilityPolicyEngine: policyEngine ?? undefined,
    extensions: loopState.activeConfig.extensions ?? [],
    iterationCount,
    manifest,
    maxParallelToolCalls: host.resolveActiveMaxParallelToolCalls(loopState),
    now: () => host.now(),
    policyCapabilityMetadata,
    policyContextInputs,
    publishCustom: (event) => {
      host.publishCustomEvent(handle, event, loopState);
    },
    publishEvent: (event) => {
      host.publishEvent(handle, event, loopState);
    },
    reportSoftError: (error) => {
      host.publishProjectedError(handle, error, false, loopState);
    },
    runId,
    signal: handle.abortSignal,
    stageResult: async (result, orderIndex) => {
      return await host.stageMessage(
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
