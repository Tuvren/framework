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
import type { CapabilityInvocationAttribution } from "@tuvren/core/capabilities";
import type {
  DriverExecutionContext,
  DriverExecutionResult,
  RuntimeDriver as KrakenDriver,
} from "@tuvren/core/driver";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  AgentConfig,
  ContextManifest,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type {
  ToolCallPart,
  ToolResultPart,
  TuvrenMessage,
} from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import type { ToolRegistry } from "@tuvren/core/tools";
import { observationForClass } from "./capability-attribution.js";
import { updateContextManifest } from "./context-manifest.js";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import { validateDriverAssistantEvents } from "./runtime-core-assistant-validation.js";
import {
  createCancelledResolution,
  hasAssistantOutputMessages,
  type LoopOutcome,
  shouldDiscardDriverProgressAfterLeaseLoss,
} from "./runtime-core-recovery.js";
import { synthesizeResponse } from "./runtime-core-response.js";
import { cloneValue } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

export type IterationPhaseResult =
  | {
      kind: "executed";
      result: ExecutedIterationResult;
    }
  | {
      kind: "outcome";
      outcome: LoopOutcome;
    };

export interface ExecutedIterationResult {
  driverResponse: TuvrenModelResponse;
  iterationRunId: string;
  partial: boolean;
  requestedToolCalls: ToolCallPart[];
  resolution: RuntimeResolution;
  stableHeadTurnNodeHash: HashString;
  toolExecutionMode: "parallel" | "sequential";
  toolResults: ToolResultPart[];
  turnNodeHash: HashString | undefined;
}

export interface RuntimeCoreIterationHost {
  applyAfterIterationResolution(
    handle: RuntimeExecutionHandle,
    loopState: {
      activeConfig: AgentConfig;
      activeDriverId: string;
      activeToolRegistry: ToolRegistry;
      carriedStateUpdates: ExtensionStateUpdate[];
      enteredIterationLoop: boolean;
    },
    iterationCount: number,
    runId: string,
    resolution: RuntimeResolution,
    response: TuvrenModelResponse,
    toolResults: ToolResultPart[],
    headMessages: TuvrenMessage[],
    stagedMessages: TuvrenMessage[],
    manifest: ContextManifest
  ): Promise<RuntimeResolution>;
  applyRequestedToolBatchIfNeeded(input: {
    handle: RuntimeExecutionHandle;
    headState: {
      branchHeadHash: HashString;
      manifest: ContextManifest;
      messageHashes: HashString[];
      messages: TuvrenMessage[];
      turnNode: {
        turnTreeHash: HashString;
      };
    };
    iterationCount: number;
    loopState: {
      activeConfig: AgentConfig;
      activeDriverId: string;
      activeToolRegistry: ToolRegistry;
      carriedStateUpdates: ExtensionStateUpdate[];
      enteredIterationLoop: boolean;
    };
    requestedToolCalls: ToolCallPart[];
    resolution: RuntimeResolution;
    runId: string;
    stagedMessageHashes: HashString[];
    stagedMessages: TuvrenMessage[];
    toolExecutionMode: "parallel" | "sequential";
    toolResults: ToolResultPart[];
  }): Promise<LoopOutcome | RuntimeResolution>;
  beginIterationStep(runId: string, stepId: string): Promise<void>;
  completeIterationArtifacts(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: {
      activeConfig: AgentConfig;
      activeDriverId: string;
      activeToolRegistry: ToolRegistry;
      carriedStateUpdates: ExtensionStateUpdate[];
      enteredIterationLoop: boolean;
    },
    headState: {
      branchHeadHash: HashString;
      manifest: ContextManifest;
      messageHashes: HashString[];
      messages: TuvrenMessage[];
      turnNode: {
        turnTreeHash: HashString;
      };
    },
    iterationCount: number,
    runId: string,
    resolution: RuntimeResolution,
    manifest: ContextManifest,
    appendedMessageHashes: HashString[]
  ): Promise<HashString | undefined>;
  createDriverExecutionContext(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: {
      activeConfig: AgentConfig;
      activeDriverId: string;
      activeToolRegistry: ToolRegistry;
      carriedStateUpdates: ExtensionStateUpdate[];
      enteredIterationLoop: boolean;
    },
    headState: {
      branchHeadHash: HashString;
      manifest: ContextManifest;
      messageHashes: HashString[];
      messages: TuvrenMessage[];
      turnNode: {
        turnTreeHash: HashString;
      };
    },
    iterationCount: number,
    emittedDriverEvents: TuvrenStreamEvent[]
  ): DriverExecutionContext;
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
  ensureDriverAssistantEvents(
    handle: RuntimeExecutionHandle,
    messages: TuvrenMessage[],
    emittedEvents: TuvrenStreamEvent[],
    loopState: {
      activeConfig: AgentConfig;
      activeDriverId: string;
      activeToolRegistry: ToolRegistry;
      carriedStateUpdates: ExtensionStateUpdate[];
      enteredIterationLoop: boolean;
    }
  ): TuvrenStreamEvent[];
  executeDriver(
    driver: KrakenDriver,
    context: DriverExecutionContext
  ): Promise<DriverExecutionResult>;
  failInvalidPauseResolutionIfNeeded(
    handle: RuntimeExecutionHandle,
    iterationRunId: string,
    stableHeadTurnNodeHash: HashString,
    requestedToolCallCount: number,
    resolution: RuntimeResolution
  ): Promise<IterationPhaseResult | undefined>;
  failTrackedRunWithoutBranchAdvance(
    handle: RuntimeExecutionHandle,
    runId: string,
    stableHeadTurnNodeHash: HashString
  ): Promise<void>;
  flushBufferedDriverEventsIfNeeded(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    events: TuvrenStreamEvent[]
  ): TuvrenStreamEvent[];
  materializeDriver(driverId: string): KrakenDriver;
  now(): number;
  reconcileCheckpointedPauseResolution(
    checkpointedPause: boolean,
    runId: string,
    turnId: string,
    resolution: RuntimeResolution
  ): Promise<RuntimeResolution>;
  stageDriverMessages(
    runId: string,
    messages: TuvrenMessage[],
    iterationCount: number
  ): Promise<HashString[]>;
}

export function findInvalidDriverResolution(
  requestedToolCallCount: number,
  resolution: RuntimeResolution,
  partial: boolean
): TuvrenRuntimeError | undefined {
  if (
    requestedToolCallCount > 0 &&
    resolution.type !== "continue_iteration" &&
    !(partial && resolution.type === "fail")
  ) {
    return new TuvrenRuntimeError(
      "drivers must not return executable tool calls with a terminal resolution",
      {
        code: "invalid_driver_resolution",
        details: {
          pauseRequiresToolCalls: resolution.type === "pause",
          resolutionType: resolution.type,
          toolCallCount: requestedToolCallCount,
        },
      }
    );
  }

  if (requestedToolCallCount === 0 && resolution.type === "pause") {
    return new TuvrenRuntimeError(
      "shared core only permits approval pauses that originate from requested tool calls",
      {
        code: "invalid_driver_resolution",
        details: {
          pauseRequiresToolCalls: true,
          resolutionType: resolution.type,
          toolCallCount: requestedToolCallCount,
        },
      }
    );
  }

  return undefined;
}

export function findInvalidDriverStateUpdateError(
  activeExtensions: TuvrenExtension[],
  stateUpdates: DriverExecutionResult["stateUpdates"]
): TuvrenRuntimeError | undefined {
  if (stateUpdates === undefined || stateUpdates.length === 0) {
    return undefined;
  }

  const activeExtensionNames = new Set(
    activeExtensions.map((extension) => extension.name)
  );

  for (const update of stateUpdates) {
    if (activeExtensionNames.has(update.extensionName)) {
      continue;
    }

    return new TuvrenRuntimeError(
      "driver state updates must target extensions active in the current agent config",
      {
        code: "invalid_driver_result",
        details: {
          extensionName: update.extensionName,
        },
      }
    );
  }

  return undefined;
}

export function applyDriverStateUpdates(
  loopState: {
    carriedStateUpdates: ExtensionStateUpdate[];
  },
  stateUpdates: DriverExecutionResult["stateUpdates"]
): void {
  if (stateUpdates === undefined) {
    return;
  }

  loopState.carriedStateUpdates.push(
    ...stateUpdates.map((update) => ({
      extensionName: update.extensionName,
      state: cloneValue(update.state),
    }))
  );
}

export function findInvalidDriverExecutionError(
  activeExtensions: TuvrenExtension[],
  requestedToolCallCount: number,
  resolution: RuntimeResolution,
  cancellationResolution: RuntimeResolution | undefined,
  partial: boolean,
  assistantEventValidationError: TuvrenRuntimeError | undefined,
  stateUpdates: DriverExecutionResult["stateUpdates"]
): TuvrenRuntimeError | undefined {
  if (cancellationResolution === undefined) {
    const invalidDriverResolutionError = findInvalidDriverResolution(
      requestedToolCallCount,
      resolution,
      partial
    );

    if (invalidDriverResolutionError !== undefined) {
      return invalidDriverResolutionError;
    }
  }

  if (assistantEventValidationError !== undefined) {
    return assistantEventValidationError;
  }

  return findInvalidDriverStateUpdateError(activeExtensions, stateUpdates);
}

export function extractToolCallsFromMessages(
  messages: TuvrenMessage[]
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

/**
 * Emit tool.start + tool.result events for pre-staged provider tool messages
 * (AY003). Provider-owned results arrive as tool-role messages in driverMessages
 * rather than going through the Tool Execution Gateway. The framework emits
 * attribution events with owner:"provider" so observers see the full invocation
 * lifecycle with correct observation limits (canAudit/canCancel/canRetry = false).
 *
 * No tool.audit event is emitted — provider classes have canAudit:false.
 * providerMetadata is never spread into event payloads, so continuity tokens
 * remain isolated (AY005).
 */
function emitProviderToolAttributionEvents(
  handle: RuntimeExecutionHandle,
  driverMessages: TuvrenMessage[],
  now: () => number
): void {
  for (const message of driverMessages) {
    if (message.role !== "tool") {
      continue;
    }
    for (const part of message.parts) {
      const meta = part.providerMetadata;
      if (
        typeof meta !== "object" ||
        meta === null ||
        (meta as Record<string, unknown>).owner !== "provider"
      ) {
        // Invariant: isPrestagedProviderToolMessage in driver-contract-guards.ts
        // uses parts.every(owner==="provider"), so a mixed tool message (some parts
        // provider-owned, some not) is rejected before reaching here. If that guard
        // is ever relaxed this per-part skip must be revisited to avoid leaving
        // non-provider parts without tool.start/tool.result events.
        continue;
      }
      const executionClass: "provider-native" | "provider-mediated" =
        (meta as Record<string, unknown>).executionClass === "provider-mediated"
          ? "provider-mediated"
          : "provider-native";
      const observation = observationForClass(executionClass);
      const attribution: CapabilityInvocationAttribution = {
        capabilityId: part.name,
        executionClass,
        observation,
        owner: "provider",
      };
      handle.publish({
        attribution,
        callId: part.callId,
        input: undefined,
        name: part.name,
        timestamp: now(),
        type: "tool.start",
      });
      handle.publish({
        attribution,
        callId: part.callId,
        isError: part.isError,
        name: part.name,
        output: part.output,
        timestamp: now(),
        type: "tool.result",
      });
    }
  }
}

export async function executeIterationPhase(
  host: RuntimeCoreIterationHost,
  input: {
    handle: RuntimeExecutionHandle;
    headState: {
      branchHeadHash: HashString;
      manifest: ContextManifest;
      messageHashes: HashString[];
      messages: TuvrenMessage[];
      turnNode: {
        turnTreeHash: HashString;
      };
    };
    iterationCount: number;
    loopState: {
      activeConfig: AgentConfig;
      activeDriverId: string;
      activeToolRegistry: ToolRegistry;
      carriedStateUpdates: ExtensionStateUpdate[];
      enteredIterationLoop: boolean;
    };
    schemaId: string;
  }
): Promise<IterationPhaseResult> {
  const driver = input.handle.getOrCreateDriver(
    input.loopState.activeDriverId,
    (driverId) => host.materializeDriver(driverId)
  );
  const iterationRunId = host.createId();

  await host.createTrackedRun(
    input.handle,
    iterationRunId,
    input.handle.turnId,
    input.handle.request.branchId,
    input.schemaId,
    input.headState.branchHeadHash,
    [
      {
        deterministic: false,
        id: "iterate",
        sideEffects: true,
      },
    ]
  );
  await host.beginIterationStep(iterationRunId, "iterate");

  const emittedDriverEvents: TuvrenStreamEvent[] = [];
  const driverResult = await host.executeDriver(
    driver,
    host.createDriverExecutionContext(
      input.handle,
      input.schemaId,
      input.loopState,
      input.headState,
      input.iterationCount,
      emittedDriverEvents
    )
  );
  if (shouldDiscardDriverProgressAfterLeaseLoss(input.handle)) {
    const leaseLostResolution = createCancelledResolution(input.handle);

    if (leaseLostResolution === undefined) {
      throw new TuvrenRuntimeError(
        "lease-loss aborts must surface a cancellation resolution",
        { code: "missing_run_lease_loss_resolution" }
      );
    }

    await host.failTrackedRunWithoutBranchAdvance(
      input.handle,
      iterationRunId,
      input.headState.branchHeadHash
    );
    return {
      kind: "outcome",
      outcome: {
        resolution: leaseLostResolution,
      },
    };
  }

  let resolution = driverResult.resolution;
  const driverMessages = [...(driverResult.messages ?? [])];
  const cancellationResolution = createCancelledResolution(input.handle);
  const assistantEventValidationError = validateDriverAssistantEvents(
    driverMessages,
    emittedDriverEvents,
    cancellationResolution ?? resolution,
    driverResult.assistantEventReconciliation,
    input.loopState.activeConfig.extensions ?? []
  );
  const synthesizedAssistantEvents = host.ensureDriverAssistantEvents(
    input.handle,
    driverMessages,
    emittedDriverEvents,
    input.loopState
  );
  const requestedToolCalls = extractToolCallsFromMessages(driverMessages);
  const toolExecutionMode = driverResult.toolExecutionMode ?? "parallel";
  const partial =
    driverResult.partial === true ||
    (cancellationResolution !== undefined &&
      hasAssistantOutputMessages(driverMessages));
  const invalidDriverError = findInvalidDriverExecutionError(
    input.loopState.activeConfig.extensions ?? [],
    requestedToolCalls.length,
    resolution,
    cancellationResolution,
    partial,
    assistantEventValidationError,
    driverResult.stateUpdates
  );

  if (invalidDriverError !== undefined) {
    await host.failTrackedRunWithoutBranchAdvance(
      input.handle,
      iterationRunId,
      input.headState.branchHeadHash
    );
    return {
      kind: "outcome",
      outcome: {
        resolution: {
          error: invalidDriverError,
          fatality: "hard",
          type: "fail",
        },
      },
    };
  }

  applyDriverStateUpdates(input.loopState, driverResult.stateUpdates);

  host.flushBufferedDriverEventsIfNeeded(
    input.handle,
    resolution,
    synthesizedAssistantEvents
  );

  const stagedMessages = [...driverMessages];
  const stagedMessageHashes = await host.stageDriverMessages(
    iterationRunId,
    driverMessages,
    input.iterationCount
  );
  emitProviderToolAttributionEvents(input.handle, driverMessages, () =>
    host.now()
  );
  const driverResponse = synthesizeResponse(
    driverMessages,
    resolution,
    emittedDriverEvents,
    driverResult.assistantEventReconciliation
  );
  const toolResults: ToolResultPart[] = [];

  resolution = cancellationResolution ?? resolution;
  const toolBatchResult = await host.applyRequestedToolBatchIfNeeded({
    handle: input.handle,
    headState: input.headState,
    iterationCount: input.iterationCount,
    loopState: input.loopState,
    requestedToolCalls,
    resolution,
    runId: iterationRunId,
    stagedMessageHashes,
    stagedMessages,
    toolExecutionMode,
    toolResults,
  });

  if ("type" in toolBatchResult) {
    resolution = toolBatchResult;
  } else {
    return {
      kind: "outcome",
      outcome: toolBatchResult,
    };
  }

  resolution = createCancelledResolution(input.handle) ?? resolution;

  const manifest = updateContextManifest(
    input.headState.manifest,
    stagedMessages,
    [...input.loopState.carriedStateUpdates],
    []
  );
  input.loopState.carriedStateUpdates = [];
  const turnNodeHash = await host.completeIterationArtifacts(
    input.handle,
    input.schemaId,
    input.loopState,
    input.headState,
    input.iterationCount,
    iterationRunId,
    resolution,
    manifest,
    stagedMessageHashes
  );
  const checkpointedPause = resolution.type === "pause";
  input.handle.updateStatus({
    activeAgent: input.loopState.activeConfig.name,
    manifest,
  });
  resolution = await host.applyAfterIterationResolution(
    input.handle,
    input.loopState,
    input.iterationCount,
    iterationRunId,
    resolution,
    driverResponse,
    toolResults,
    input.headState.messages,
    stagedMessages,
    manifest
  );
  resolution = await host.reconcileCheckpointedPauseResolution(
    checkpointedPause,
    iterationRunId,
    input.handle.turnId,
    resolution
  );
  resolution = createCancelledResolution(input.handle) ?? resolution;

  const invalidPauseOutcome = await host.failInvalidPauseResolutionIfNeeded(
    input.handle,
    iterationRunId,
    input.headState.branchHeadHash,
    requestedToolCalls.length,
    resolution
  );

  if (invalidPauseOutcome !== undefined) {
    return invalidPauseOutcome;
  }

  return {
    kind: "executed",
    result: {
      driverResponse,
      iterationRunId,
      partial,
      requestedToolCalls,
      resolution,
      stableHeadTurnNodeHash: input.headState.branchHeadHash,
      toolExecutionMode,
      toolResults,
      turnNodeHash,
    },
  };
}
