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
import type { DriverExecutionContext } from "@tuvren/core/driver";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  ContextManifest,
  HandoffContextBuilder,
  HandoffContextPlan,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type {
  ToolCallPart,
  ToolResultPart,
  TuvrenMessage,
} from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import type { ToolRegistry } from "@tuvren/core/tools";
import { isClientEndpointTool } from "./binding-resolver.js";
import { buildCapabilityMetadataFromTools } from "./capability-policy-engine.js";
import { runAfterIterationHooks } from "./extension-runtime.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type { LoopOutcome } from "./runtime-core-recovery.js";
import { composeResolutions } from "./runtime-core-response.js";
import {
  cloneValue,
  createFrozenSnapshot,
  normalizeError,
} from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import {
  executeToolBatch,
  type ToolBatchOutcome,
  type ToolExecutionMode,
} from "./tool-execution.js";

// ---------------------------------------------------------------------------
// Exposure-time filtering helpers (BB001)
// ---------------------------------------------------------------------------

function buildUnavailableCapabilityIds(
  tools: ReturnType<ToolRegistry["list"]>,
  boundary:
    | import("@tuvren/core/capabilities").ClientEndpointBoundary
    | undefined
): ReadonlySet<string> | undefined {
  if (boundary === undefined) {
    return undefined;
  }
  const unavailable = new Set<string>();
  for (const tool of tools) {
    if (isClientEndpointTool(tool) && !boundary.isAvailable(tool.name)) {
      unavailable.add(tool.name);
    }
  }
  return unavailable.size > 0 ? unavailable : undefined;
}

function createFilteredToolRegistry(
  base: ToolRegistry,
  filteredTools: ReturnType<ToolRegistry["list"]>
): ToolRegistry {
  const byName = new Map(filteredTools.map((t) => [t.name, t]));
  return {
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
    list: () => [...filteredTools],
    register: (tool) => base.register(tool),
    toDefinitions: () => base.toDefinitions().filter((d) => byName.has(d.name)),
  };
}

export interface RuntimeCoreDriverHost {
  completeIterationRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    resolution: RuntimeResolution,
    manifest: ContextManifest,
    iterationCount: number,
    loopState: LoopState,
    nextTreeHash: HashString | undefined
  ): Promise<HashString | undefined>;
  createDriverAgentConfigSnapshot(
    config: LoopState["activeConfig"]
  ): LoopState["activeConfig"];
  createDriverHandoffContextPlan(
    input: {
      builder?: HandoffContextBuilder;
      mode?: string;
      payload?: unknown;
      reason: string;
      targetAgent: string;
    },
    headState: HeadState,
    loopState: LoopState
  ): HandoffContextPlan;
  createDriverPublishedEvent(
    handle: RuntimeExecutionHandle,
    event: TuvrenStreamEvent,
    loopState: LoopState
  ): TuvrenStreamEvent;
  createIterationTree(
    schemaId: string,
    baseTurnTreeHash: HashString,
    baseMessageHashes: HashString[],
    appendedMessageHashes: HashString[],
    manifestHash: HashString,
    runtimeStatusHash?: HashString
  ): Promise<HashString>;
  createReadonlyDriverToolRegistry(registry: ToolRegistry): ToolRegistry;
  createToolBatchEnvironment(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    manifest: ContextManifest,
    iterationCount: number,
    runId: string
  ): Parameters<typeof executeToolBatch>[1];
  failTrackedRunWithoutBranchAdvance(
    handle: RuntimeExecutionHandle,
    runId: string,
    stableHeadTurnNodeHash: HashString
  ): Promise<void>;
  now(): number;
  publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void;
  publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ): void;
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

export function createDriverExecutionContext(
  host: RuntimeCoreDriverHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  headState: HeadState,
  iterationCount: number,
  emittedDriverEvents: TuvrenStreamEvent[]
): DriverExecutionContext {
  // BB001: Apply exposure-time policy filtering before building the readonly
  // driver snapshot. When a policy engine is configured, evaluate exposure
  // decisions over all surfaces and filter out denied tools so the driver
  // (and the model via the provider bridge) never sees withheld capabilities.
  let registryForDriver = loopState.activeToolRegistry;
  const policyEngine = loopState.activeConfig.capabilityPolicyEngine;
  if (policyEngine !== undefined) {
    const allTools = loopState.activeToolRegistry.list();
    // Exposure surfaces use a stub inputSchema because the baseline engine
    // only reads surface.name/capabilityId. Custom policy engines that
    // inspect inputSchema at exposure time should receive the tool's real
    // schema — extend this when a host-engine use case requires it.
    const surfaces = allTools.map((tool) => ({
      capabilityId: tool.name,
      description: tool.description,
      inputSchema: { type: "object" as const },
      name: tool.name,
    }));
    const policyContextInputs =
      loopState.activeConfig.policyContextInputs ?? {};
    const capabilityMetadata = buildCapabilityMetadataFromTools(allTools);
    const exposureContext = {
      allowedResidencies: policyContextInputs.allowedResidencies,
      availableCredentialScopes: policyContextInputs.availableCredentialScopes,
      capabilityMetadata,
      modelId:
        typeof loopState.activeConfig.model === "string"
          ? loopState.activeConfig.model
          : "",
      permissions: [],
      providerId: "",
      // Wired path: only client-endpoint tools are checked here via
      // clientEndpointBoundary. Non-client requiresActiveEndpoint tools
      // cannot reach this dimension through policyContextInputs — they
      // must be filtered by a custom engine or a host-supplied context
      // extension in a future ADR.
      unavailableCapabilityIds: buildUnavailableCapabilityIds(
        allTools,
        loopState.clientEndpointBoundary
      ),
      userPresent: policyContextInputs.userPresent,
    };
    const decisions = policyEngine.evaluateExposure(surfaces, exposureContext);
    const exposedNames = new Set(
      decisions.filter((d) => d.exposed).map((d) => d.surfaceName)
    );
    if (exposedNames.size < allTools.length) {
      const filteredTools = allTools.filter((t) => exposedNames.has(t.name));
      registryForDriver = createFilteredToolRegistry(
        loopState.activeToolRegistry,
        filteredTools
      );
    }
  }

  const toolRegistrySnapshot =
    host.createReadonlyDriverToolRegistry(registryForDriver);

  return {
    branchId: handle.request.branchId,
    config: host.createDriverAgentConfigSnapshot(loopState.activeConfig),
    handoff: {
      createContextPlan: (input) =>
        host.createDriverHandoffContextPlan(input, headState, loopState),
    },
    iterationCount,
    manifest: createFrozenSnapshot(headState.manifest),
    messages: createFrozenSnapshot(headState.messages),
    runtime: {
      emit: (event) => {
        let clonedEvent: TuvrenStreamEvent;

        try {
          clonedEvent = cloneValue(event);
        } catch (error: unknown) {
          throw new TuvrenRuntimeError(
            "driver-emitted stream events must be cloneable",
            {
              code: "invalid_stream_event",
              details: {
                error: normalizeError(error).message,
              },
            }
          );
        }

        const publishedEvent = host.createDriverPublishedEvent(
          handle,
          clonedEvent,
          loopState
        );
        emittedDriverEvents.push(publishedEvent);
        handle.publish(publishedEvent);
      },
      now: () => host.now(),
    },
    schemaId,
    signal: handle.abortSignal,
    threadId: handle.request.threadId,
    toolRegistry: toolRegistrySnapshot,
    turnId: handle.turnId,
  };
}

export async function stageDriverMessages(
  host: RuntimeCoreDriverHost,
  runId: string,
  messages: TuvrenMessage[],
  iterationCount: number
): Promise<HashString[]> {
  const stagedMessageHashes: HashString[] = [];

  for (const [index, driverMessage] of messages.entries()) {
    stagedMessageHashes.push(
      await host.stageMessage(
        runId,
        driverMessage,
        `message_${iterationCount}_${index}`
      )
    );
  }

  return stagedMessageHashes;
}

export async function applyRequestedToolBatchIfNeeded(
  host: RuntimeCoreDriverHost,
  input: {
    handle: RuntimeExecutionHandle;
    headState: HeadState;
    iterationCount: number;
    loopState: LoopState;
    requestedToolCalls: ToolCallPart[];
    resolution: RuntimeResolution;
    runId: string;
    stagedMessageHashes: HashString[];
    stagedMessages: TuvrenMessage[];
    toolExecutionMode: ToolExecutionMode;
    toolResults: ToolResultPart[];
  }
): Promise<LoopOutcome | RuntimeResolution> {
  if (
    input.resolution.type !== "continue_iteration" ||
    input.requestedToolCalls.length === 0
  ) {
    return input.resolution;
  }

  const toolBatch = await executeRequestedToolBatch(host, input);

  if ("outcome" in toolBatch) {
    return toolBatch.outcome;
  }

  input.toolResults.push(...toolBatch.results);
  input.stagedMessageHashes.push(...toolBatch.resultHashes);
  input.loopState.carriedStateUpdates.push(...toolBatch.updates);

  for (const result of toolBatch.results) {
    input.stagedMessages.push({
      parts: [result],
      role: "tool",
    });
  }

  if (toolBatch.approval === undefined) {
    return input.resolution;
  }

  return {
    approval: toolBatch.approval,
    reason: "approval_required",
    type: "pause",
  };
}

async function executeRequestedToolBatch(
  host: RuntimeCoreDriverHost,
  input: {
    handle: RuntimeExecutionHandle;
    headState: HeadState;
    iterationCount: number;
    loopState: LoopState;
    requestedToolCalls: ToolCallPart[];
    runId: string;
    toolExecutionMode: ToolExecutionMode;
  }
): Promise<ToolBatchOutcome | { outcome: LoopOutcome }> {
  try {
    return await executeToolBatch(
      input.requestedToolCalls,
      host.createToolBatchEnvironment(
        input.handle,
        input.loopState,
        input.headState.manifest,
        input.iterationCount,
        input.runId
      ),
      input.toolExecutionMode
    );
  } catch (error: unknown) {
    await host.failTrackedRunWithoutBranchAdvance(
      input.handle,
      input.runId,
      input.headState.branchHeadHash
    );
    return {
      outcome: {
        resolution: {
          error: normalizeError(error),
          fatality: "hard",
          type: "fail",
        },
      },
    };
  }
}

export async function completeIterationArtifacts(
  host: RuntimeCoreDriverHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  headState: HeadState,
  iterationCount: number,
  runId: string,
  resolution: RuntimeResolution,
  manifest: ContextManifest,
  appendedMessageHashes: HashString[]
): Promise<HashString | undefined> {
  const manifestHash = await host.stageManifest(runId, manifest, {
    handle,
    loopState,
  });
  const runtimeStatusHash =
    resolution.type === "pause"
      ? await host.stageRuntimeStatus(
          runId,
          {
            activeAgent: loopState.activeConfig.name,
            pauseReason: resolution.reason,
            state: "paused",
          },
          "runtime_status"
        )
      : undefined;
  const nextTreeHash =
    resolution.type === "fail" && resolution.fatality === "hard"
      ? undefined
      : await host.createIterationTree(
          schemaId,
          headState.turnNode.turnTreeHash,
          headState.messageHashes,
          appendedMessageHashes,
          manifestHash,
          runtimeStatusHash
        );

  return await host.completeIterationRun(
    handle,
    runId,
    resolution,
    manifest,
    iterationCount,
    loopState,
    nextTreeHash
  );
}

export async function applyAfterIterationResolution(
  host: RuntimeCoreDriverHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  iterationCount: number,
  runId: string,
  resolution: RuntimeResolution,
  response: TuvrenModelResponse,
  toolResults: ToolResultPart[],
  headMessages: TuvrenMessage[],
  stagedMessages: TuvrenMessage[],
  manifest: ContextManifest
): Promise<RuntimeResolution> {
  const afterIteration = await runAfterIterationHooks({
    emit: (event) => {
      host.publishCustomEvent(handle, event, loopState);
    },
    extensions: loopState.activeConfig.extensions ?? [],
    iterationCount,
    manifest,
    messages: [...headMessages, ...stagedMessages],
    resolution,
    response,
    runId,
    toolResults,
    turnId: handle.turnId,
  });
  let nextResolution = composeResolutions(
    resolution,
    afterIteration.resolution
  );
  loopState.carriedStateUpdates.push(...afterIteration.updates);

  if (nextResolution.type === "fail" && nextResolution.fatality === "soft") {
    host.publishProjectedError(handle, nextResolution.error, false, loopState);
  }

  if (
    loopState.activeConfig.maxIterations !== undefined &&
    iterationCount >= loopState.activeConfig.maxIterations &&
    nextResolution.type === "continue_iteration"
  ) {
    nextResolution = {
      reason: "max_iterations",
      type: "end_turn",
    };
  }

  return nextResolution;
}
