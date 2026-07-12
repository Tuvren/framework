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
import type {
  RunnerExecutionContext,
  RunnerExecutionResult,
  RuntimeRunner,
} from "@tuvren/core/runner";
import type { ToolRegistry } from "@tuvren/core/tools";
import { observationForClass } from "./capability-attribution.js";
import { updateContextManifest } from "./context-manifest.js";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import { validateRunnerAssistantEvents } from "./runtime-core-assistant-validation.js";
import {
  createCancelledResolution,
  hasAssistantOutputMessages,
  type LoopOutcome,
  shouldDiscardRunnerProgressAfterLeaseLoss,
} from "./runtime-core-recovery.js";
import { synthesizeResponse } from "./runtime-core-response.js";
import { cloneValue } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

/**
 * Result of one runner iteration phase: either the iteration executed and
 * produced an {@link ExecutedIterationResult} for the loop to continue with,
 * or the phase short-circuited into a terminal {@link LoopOutcome} (lease
 * loss, invalid runner behavior, a tool-batch outcome, or an invalid pause
 * resolution).
 */
export type IterationPhaseResult =
  | {
      kind: "executed";
      result: ExecutedIterationResult;
    }
  | {
      kind: "outcome";
      outcome: LoopOutcome;
    };

/**
 * Outputs of a completed runner iteration, consumed by the iteration loop to
 * decide whether to continue, pause, hand off, or finish the turn.
 */
export interface ExecutedIterationResult {
  /** Tracked-run id created for this iteration. */
  iterationRunId: string;
  /**
   * True when the runner reported partial output or was cancelled after
   * already producing assistant output messages.
   */
  partial: boolean;
  /** Tool calls extracted from the runner's durable assistant messages. */
  requestedToolCalls: ToolCallPart[];
  /**
   * Final resolution after tool-batch application, after-iteration hooks,
   * pause reconciliation, and cancellation checks.
   */
  resolution: RuntimeResolution;
  /** Model response synthesized from the runner's durable messages. */
  runnerResponse: TuvrenModelResponse;
  /**
   * Branch head hash observed before the iteration ran; the stable anchor
   * used when failing without a branch advance.
   */
  stableHeadTurnNodeHash: HashString;
  /** Execution mode requested for the tool batch (defaults to "parallel"). */
  toolExecutionMode: "parallel" | "sequential";
  /** Results of tool calls executed within this iteration. */
  toolResults: ToolResultPart[];
  /**
   * Turn node hash committed for this iteration, or undefined when the run
   * did not advance the branch (for example on a hard failure).
   */
  turnNodeHash: HashString | undefined;
}

/**
 * Host capabilities {@link executeIterationPhase} needs from the runtime
 * core: run tracking, runner materialization and execution, message staging,
 * event publication and buffering, tool-batch application, iteration
 * artifact commits, and pause/cancellation reconciliation.
 *
 * Implemented by the runtime-core orchestration layer so the iteration phase
 * itself stays dependency-injected and testable.
 */
export interface RuntimeCoreIterationHost {
  applyAfterIterationResolution(
    handle: RuntimeExecutionHandle,
    loopState: {
      activeConfig: AgentConfig;
      activeRunnerId: string;
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
      activeRunnerId: string;
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
      activeRunnerId: string;
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
  createId(): string;
  createRunnerExecutionContext(
    handle: RuntimeExecutionHandle,
    schemaId: string,
    loopState: {
      activeConfig: AgentConfig;
      activeRunnerId: string;
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
    emittedRunnerEvents: TuvrenStreamEvent[]
  ): RunnerExecutionContext;
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
  ensureRunnerAssistantEvents(
    handle: RuntimeExecutionHandle,
    messages: TuvrenMessage[],
    emittedEvents: TuvrenStreamEvent[],
    loopState: {
      activeConfig: AgentConfig;
      activeRunnerId: string;
      activeToolRegistry: ToolRegistry;
      carriedStateUpdates: ExtensionStateUpdate[];
      enteredIterationLoop: boolean;
    }
  ): TuvrenStreamEvent[];
  executeRunner(
    runner: RuntimeRunner,
    context: RunnerExecutionContext
  ): Promise<RunnerExecutionResult>;
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
  flushBufferedRunnerEventsIfNeeded(
    handle: RuntimeExecutionHandle,
    resolution: RuntimeResolution,
    events: TuvrenStreamEvent[]
  ): TuvrenStreamEvent[];
  materializeRunner(runnerId: string): RuntimeRunner;
  now(): number;
  /**
   * Publish an event through the full runtime event + telemetry path. Used by
   * provider-tool attribution to ensure telemetry observes the same events as
   * the canonical stream (KRT-BA002: taxonomy consistent across stream and telemetry).
   */
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: TuvrenStreamEvent,
    loopState: {
      activeConfig: AgentConfig;
      activeRunnerId: string;
      activeToolRegistry: ToolRegistry;
      carriedStateUpdates: ExtensionStateUpdate[];
      enteredIterationLoop: boolean;
    }
  ): void;
  reconcileCheckpointedPauseResolution(
    checkpointedPause: boolean,
    runId: string,
    turnId: string,
    resolution: RuntimeResolution
  ): Promise<RuntimeResolution>;
  stageRunnerMessages(
    runId: string,
    messages: TuvrenMessage[],
    iterationCount: number
  ): Promise<HashString[]>;
}

/**
 * Rejects runner resolutions that are inconsistent with the requested tool
 * calls.
 *
 * A runner that requests tool calls must resolve with "continue_iteration"
 * (or a partial "fail"); any other terminal resolution is invalid.
 * Runner-returned "pause" resolutions are always rejected here: approval
 * pauses may only originate from the shared core's own tool-approval flow.
 *
 * @returns A `TuvrenRuntimeError` with code `invalid_runner_resolution`, or
 * `undefined` when the combination is valid.
 */
export function findInvalidRunnerResolution(
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
      "runners must not return executable tool calls with a terminal resolution",
      {
        code: "invalid_runner_resolution",
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
        code: "invalid_runner_resolution",
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

export function findInvalidRunnerStateUpdateError(
  activeExtensions: TuvrenExtension[],
  stateUpdates: RunnerExecutionResult["stateUpdates"]
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
      "runner state updates must target extensions active in the current agent config",
      {
        code: "invalid_runner_result",
        details: {
          extensionName: update.extensionName,
        },
      }
    );
  }

  return undefined;
}

export function applyRunnerStateUpdates(
  loopState: {
    carriedStateUpdates: ExtensionStateUpdate[];
  },
  stateUpdates: RunnerExecutionResult["stateUpdates"]
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

export function findInvalidRunnerExecutionError(
  activeExtensions: TuvrenExtension[],
  requestedToolCallCount: number,
  resolution: RuntimeResolution,
  cancellationResolution: RuntimeResolution | undefined,
  partial: boolean,
  assistantEventValidationError: TuvrenRuntimeError | undefined,
  stateUpdates: RunnerExecutionResult["stateUpdates"]
): TuvrenRuntimeError | undefined {
  if (cancellationResolution === undefined) {
    const invalidRunnerResolutionError = findInvalidRunnerResolution(
      requestedToolCallCount,
      resolution,
      partial
    );

    if (invalidRunnerResolutionError !== undefined) {
      return invalidRunnerResolutionError;
    }
  }

  if (assistantEventValidationError !== undefined) {
    return assistantEventValidationError;
  }

  return findInvalidRunnerStateUpdateError(activeExtensions, stateUpdates);
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
 * (AY003). Provider-owned results arrive as tool-role messages in runnerMessages
 * rather than going through the Tool Execution Gateway. The framework emits
 * attribution events with owner:"provider" so observers see the full invocation
 * lifecycle with correct observation limits (canAudit/canCancel/canRetry = false).
 *
 * No tool.audit event is emitted — provider classes have canAudit:false.
 * providerMetadata is never spread into event payloads, so continuity tokens
 * remain isolated (AY005).
 */
function emitProviderToolAttributionEvents(
  runnerMessages: TuvrenMessage[],
  now: () => number,
  publishEvent: (event: TuvrenStreamEvent) => void
): void {
  for (const message of runnerMessages) {
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
        // Invariant: isPrestagedProviderToolMessage in runner-contract-guards.ts
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
      publishEvent({
        attribution,
        callId: part.callId,
        // Provider-owned inputs are not available to the framework; null is
        // used as the JSON-serializable sentinel for "input not observed"
        // so it passes assertTuvrenStreamEvent's isSerializableContractValue check.
        input: null,
        name: part.name,
        timestamp: now(),
        type: "tool.start",
      });
      publishEvent({
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
      activeRunnerId: string;
      activeToolRegistry: ToolRegistry;
      carriedStateUpdates: ExtensionStateUpdate[];
      enteredIterationLoop: boolean;
    };
    schemaId: string;
  }
): Promise<IterationPhaseResult> {
  const runner = input.handle.getOrCreateRunner(
    input.loopState.activeRunnerId,
    (runnerId) => host.materializeRunner(runnerId)
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

  const emittedRunnerEvents: TuvrenStreamEvent[] = [];
  const runnerResult = await host.executeRunner(
    runner,
    host.createRunnerExecutionContext(
      input.handle,
      input.schemaId,
      input.loopState,
      input.headState,
      input.iterationCount,
      emittedRunnerEvents
    )
  );
  if (shouldDiscardRunnerProgressAfterLeaseLoss(input.handle)) {
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

  let resolution = runnerResult.resolution;
  const runnerMessages = [...(runnerResult.messages ?? [])];
  const cancellationResolution = createCancelledResolution(input.handle);
  const assistantEventValidationError = validateRunnerAssistantEvents(
    runnerMessages,
    emittedRunnerEvents,
    cancellationResolution ?? resolution,
    runnerResult.assistantEventReconciliation,
    input.loopState.activeConfig.extensions ?? []
  );
  const synthesizedAssistantEvents = host.ensureRunnerAssistantEvents(
    input.handle,
    runnerMessages,
    emittedRunnerEvents,
    input.loopState
  );
  const requestedToolCalls = extractToolCallsFromMessages(runnerMessages);
  const toolExecutionMode = runnerResult.toolExecutionMode ?? "parallel";
  const partial =
    runnerResult.partial === true ||
    (cancellationResolution !== undefined &&
      hasAssistantOutputMessages(runnerMessages));
  const invalidRunnerError = findInvalidRunnerExecutionError(
    input.loopState.activeConfig.extensions ?? [],
    requestedToolCalls.length,
    resolution,
    cancellationResolution,
    partial,
    assistantEventValidationError,
    runnerResult.stateUpdates
  );

  if (invalidRunnerError !== undefined) {
    await host.failTrackedRunWithoutBranchAdvance(
      input.handle,
      iterationRunId,
      input.headState.branchHeadHash
    );
    return {
      kind: "outcome",
      outcome: {
        resolution: {
          error: invalidRunnerError,
          fatality: "hard",
          type: "fail",
        },
      },
    };
  }

  applyRunnerStateUpdates(input.loopState, runnerResult.stateUpdates);

  host.flushBufferedRunnerEventsIfNeeded(
    input.handle,
    resolution,
    synthesizedAssistantEvents
  );

  const stagedMessages = [...runnerMessages];
  const stagedMessageHashes = await host.stageRunnerMessages(
    iterationRunId,
    runnerMessages,
    input.iterationCount
  );
  emitProviderToolAttributionEvents(
    runnerMessages,
    () => host.now(),
    (event) => host.publishEvent(input.handle, event, input.loopState)
  );
  const runnerResponse = synthesizeResponse(
    runnerMessages,
    resolution,
    emittedRunnerEvents,
    runnerResult.assistantEventReconciliation
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
    runnerResponse,
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
      runnerResponse,
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
