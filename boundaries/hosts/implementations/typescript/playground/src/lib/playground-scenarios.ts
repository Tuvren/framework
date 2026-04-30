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
import type { TuvrenStreamEvent } from "@tuvren/event-stream";
import type {
  ExecutionHandle,
  InputSignal,
  LoopPolicy,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/runtime-api";
import {
  TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS,
  TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL,
} from "@tuvren/runtime-core";
import { toAgUiEvents } from "@tuvren/stream-agui";
import { teeTuvrenStreamEvents } from "@tuvren/stream-core";
import { toSseFrames } from "@tuvren/stream-sse";
import { isAimockProviderMode } from "./playground-config.js";
import { createPlaygroundHost } from "./playground-host.js";
import { createPlaygroundProvider } from "./playground-provider.js";
import { createPlaygroundTools, textSignal } from "./playground-tools.js";
import type {
  PlaygroundConfig,
  PlaygroundHost,
  PlaygroundScenarioExecutionPlan,
  PlaygroundScenarioReport,
  PlaygroundStreamProjection,
  PlaygroundTelemetryEvidence,
  PlaygroundThreadSummary,
} from "./playground-types.js";

const CONTINUE_ONCE_POLICY: LoopPolicy = {
  evaluate(_response, _manifest, iterationCount) {
    return {
      continue: iterationCount < 2,
      executeTools: true,
      reason: "playground_continue_once",
    };
  },
};

export async function runPlaygroundScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  switch (config.scenario) {
    case "approval":
      return await runApprovalScenario(config);
    case "branching":
      return await runBranchingScenario(config);
    case "cancel":
      return await runCancelScenario(config);
    case "metadata":
    case "streaming":
    case "structured":
    case "tools":
      return await runSingleTurnScenario(config);
    case "reload":
      return await runReloadScenario(config);
    case "steering":
      return await runSteeringScenario(config);
    default:
      return await runSingleTurnScenario(config);
  }
}

async function runSingleTurnScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const executionPlan = createScenarioExecutionPlan(config);
  const handle = host.executeTurn({
    branchId: thread.branchId,
    config: {
      ...executionPlan.config,
      model: executionPlan.model,
      name: "primary",
      responseFormat:
        config.scenario === "structured"
          ? {
              name: "playground_summary",
              schema: {
                properties: {
                  scenario: { type: "string" },
                  status: { type: "string" },
                },
                required: ["scenario", "status"],
                type: "object",
              },
            }
          : undefined,
      tools: executionPlan.tools,
    },
    signal: executionPlan.signal,
    threadId: thread.threadId,
  });
  const projection = await host.project(handle);
  const messages = await host.readBranchMessages(thread.branchId);
  const toolResultCount = projection.canonical.filter(
    (event) => event.type === "tool.result"
  ).length;
  const toolCallThoughtSignatureCount =
    countToolCallThoughtSignatureEvents(projection);
  const durableToolCallThoughtSignatureCount =
    countDurableToolCallThoughtSignatures(messages);
  const toolCallProviderCallIdCount =
    countToolCallProviderCallIdEvents(projection);
  const durableToolCallProviderCallIdCount =
    countDurableToolCallProviderCallIds(messages);
  const metadataObserved = readMetadataObserved(config, messages);
  const toolHistoryPreserved = readToolHistoryPreserved(
    config,
    durableToolCallProviderCallIdCount,
    durableToolCallThoughtSignatureCount
  );
  const toolTraceObserved = readToolTraceObserved(
    config,
    toolCallProviderCallIdCount,
    toolCallThoughtSignatureCount
  );

  return createReport({
    checks: {
      aguiObserved: projection.agui.length > 0,
      canonicalObserved: projection.canonical.length > 0,
      completed: handle.status().phase === "completed",
      metadataObserved,
      sseObserved: projection.sse.length > 0,
      structuredObserved:
        config.scenario !== "structured" ||
        projection.canonical.some((event) => event.type === "structured.done"),
      toolObserved:
        config.scenario !== "tools" ||
        (config.providerMode === "ai-sdk-google"
          ? toolResultCount >= 2
          : toolResultCount > 0),
      toolHistoryPreserved,
      toolTraceObserved,
    },
    config,
    error: readProjectionError(projection),
    handle,
    projection,
    thread: withHead(thread, projection),
  });
}

async function runApprovalScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const executionPlan = createScenarioExecutionPlan(config);
  const pausedHandle = host.executeTurn({
    branchId: thread.branchId,
    config: {
      ...executionPlan.config,
      model: executionPlan.model,
      maxParallelToolCalls: 2,
      name: "primary",
      tools: executionPlan.tools,
    },
    signal: executionPlan.signal,
    threadId: thread.threadId,
  });
  const pausedProjection = await host.project(pausedHandle);
  const approval = pausedHandle.status().approval;
  const pausedMessages = await host.readBranchMessages(thread.branchId);
  const pausedToolCallProviderCallIdCount =
    countDurableToolCallProviderCallIds(pausedMessages);
  const pausedToolMetadataObserved = readApprovalToolMetadataObserved(
    config,
    pausedProjection,
    pausedMessages
  );
  const pausedToolMetadataHistoryPreserved = readApprovalToolMetadataHistory(
    config,
    pausedMessages,
    pausedToolCallProviderCallIdCount
  );

  if (approval === undefined) {
    return createReport({
      checks: {
        approvalRequested: false,
        approvalResolved: false,
        editedEmailInputExecuted: false,
        pausedFirst: pausedHandle.status().phase === "paused",
        resumedCompleted: false,
        toolMetadataHistoryPreserved: pausedToolMetadataHistoryPreserved,
        toolMetadataObserved: pausedToolMetadataObserved,
        toolResultAfterResume: false,
      },
      config,
      error: readProjectionError(pausedProjection) ?? {
        message: "approval scenario did not pause for approval",
      },
      handle: pausedHandle,
      projection: pausedProjection,
      thread: withHead(thread, pausedProjection),
    });
  }

  const emailApproval = approval.toolCalls.find(
    (toolCall) => toolCall.name === "email"
  );

  if (emailApproval === undefined) {
    return createReport({
      checks: {
        approvalRequested: projectionHasEvent(
          pausedProjection,
          "approval.requested"
        ),
        approvalResolved: false,
        editedEmailInputExecuted: false,
        pausedFirst: pausedHandle.status().phase === "paused",
        resumedCompleted: false,
        toolMetadataHistoryPreserved: pausedToolMetadataHistoryPreserved,
        toolMetadataObserved: pausedToolMetadataObserved,
        toolResultAfterResume: false,
      },
      config,
      error: {
        message: "approval scenario did not request email approval",
      },
      handle: pausedHandle,
      projection: pausedProjection,
      thread: withHead(thread, pausedProjection),
    });
  }

  const resumedHandle = host.approve(pausedHandle, {
    decisions: approval.toolCalls.map((toolCall) => {
      if (toolCall.name === "email") {
        return {
          callId: toolCall.callId,
          editedInput: {
            subject: "Edited status update",
            to: "ops@example.com",
          },
          message: "Playground approved with deterministic input.",
          type: "edit",
        };
      }

      return {
        callId: toolCall.callId,
        message: "Playground approved with deterministic input.",
        type: "approve",
      };
    }),
  });
  const resumedProjection = await projectContinuationCapture(resumedHandle);
  const projection = mergeProjections(pausedProjection, resumedProjection);
  const resumedMessages = await host.readBranchMessages(thread.branchId);

  return createReport({
    checks: {
      approvalRequested: projection.canonical.some(
        (event) => event.type === "approval.requested"
      ),
      approvalResolved: projection.canonical.some(
        (event) => event.type === "approval.resolved"
      ),
      editedEmailInputExecuted: resumedProjection.canonical.some(
        isEditedEmailToolStart
      ),
      pausedFirst: pausedHandle.status().phase === "paused",
      resumedCompleted: resumedHandle.status().phase === "completed",
      thoughtSignatureHistoryPreserved:
        config.providerMode === "ai-sdk-google"
          ? countDurableToolCallThoughtSignatures(resumedMessages) >= 1
          : true,
      thoughtSignatureObserved:
        config.providerMode === "ai-sdk-google"
          ? countToolCallThoughtSignatureEvents(projection) >= 1
          : true,
      toolMetadataHistoryPreserved: readApprovalToolMetadataHistory(
        config,
        resumedMessages,
        countDurableToolCallProviderCallIds(resumedMessages)
      ),
      toolMetadataObserved: readApprovalToolMetadataObserved(
        config,
        projection,
        resumedMessages
      ),
      toolResultAfterResume: resumedProjection.canonical.some(
        (event) =>
          event.type === "tool.result" && event.callId === emailApproval.callId
      ),
    },
    config,
    error: readProjectionError(projection),
    handle: resumedHandle,
    projection,
    thread: withHead(thread, projection),
  });
}

async function runBranchingScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const firstHandle = host.executeTurn({
    branchId: thread.branchId,
    signal: textSignal("Create branch source"),
    threadId: thread.threadId,
  });
  const firstProjection = await host.project(firstHandle);
  const sourceThread = withHead(thread, firstProjection);
  const branch = await host.branchFromHead({
    threadId: thread.threadId,
    turnNodeHash: sourceThread.headTurnNodeHash ?? thread.rootTurnNodeHash,
  });
  const branchMessagesBeforeTurn = await host.readBranchMessages(
    branch.branchId
  );
  const branchHandle = host.executeTurn({
    branchId: branch.branchId,
    signal: textSignal("Run alternate branch"),
    threadId: thread.threadId,
  });
  const branchProjection = await host.project(branchHandle);
  const branchMessagesAfterTurn = await host.readBranchMessages(
    branch.branchId
  );
  const projection = mergeProjections(firstProjection, branchProjection);

  return createReport({
    checks: {
      branchCreated: branch.branchId !== thread.branchId,
      branchCompleted: branchHandle.status().phase === "completed",
      branchedFromSourceHead:
        branch.headTurnNodeHash === sourceThread.headTurnNodeHash,
      branchMessagesAdvanced:
        branchMessagesAfterTurn.length > branchMessagesBeforeTurn.length,
      branchMessagesVisible: branchMessagesBeforeTurn.length > 0,
      sourceCompleted: firstHandle.status().phase === "completed",
    },
    config,
    handle: branchHandle,
    projection,
    thread: withHead(thread, projection),
  });
}

async function runSteeringScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const handle = host.executeTurn({
    branchId: thread.branchId,
    signal: textSignal("Run steering source"),
    threadId: thread.threadId,
  });
  const capture = startProjectionCapture(handle);
  await steerWhenRunning(host, handle, textSignal("Injected steering"));

  const projection = await capture;
  const messages = await host.readBranchMessages(thread.branchId);

  return createReport({
    checks: {
      completed: handle.status().phase === "completed",
      steeringEventObserved: projection.canonical.some(
        (event) => event.type === "steering.incorporated"
      ),
      steeringMessageDurable: messages.some(hasInjectedSteeringMessage),
      steeringResponseObserved: projection.canonical.some(
        (event) =>
          event.type === "text.done" && event.text === "Steering incorporated."
      ),
    },
    config,
    handle,
    projection,
    thread: withHead(thread, projection),
  });
}

async function runCancelScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const handle = host.executeTurn({
    branchId: thread.branchId,
    config: {
      loopPolicy: CONTINUE_ONCE_POLICY,
      name: "primary",
    },
    signal: textSignal("Run cancellation"),
    threadId: thread.threadId,
  });
  const capture = startProjectionCapture(handle);

  await waitFor(() => handle.status().iterationCount >= 2);
  host.cancel(handle);

  const projection = await capture;

  return createReport({
    checks: {
      cancelled: handle.status().phase === "failed",
      errorObserved: projection.canonical.some(
        (event) => event.type === "error"
      ),
      terminalFailed: projection.canonical.some(
        (event) => event.type === "turn.end" && event.status === "failed"
      ),
    },
    config,
    handle,
    projection,
    thread: withHead(thread, projection),
  });
}

async function runReloadScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const handle = host.executeTurn({
    branchId: thread.branchId,
    signal: textSignal("Run reload source"),
    threadId: thread.threadId,
  });
  const projection = await host.project(handle);
  const sourceThread = withHead(thread, projection);
  const supportsReloadPersistence =
    config.backend === "sqlite" ||
    (config.kernelMode ?? "typescript-local") === "rust-grpc";

  if (!supportsReloadPersistence) {
    // Reload evidence is meaningful only when the runtime state survives a
    // fresh host instance. That is true for local SQLite and for a live remote
    // Rust kernel process, but not for the local in-process memory backend.
    return createReport({
      checks: {
        completedBeforeReload: handle.status().phase === "completed",
        durableReloadAttempted: false,
        continuedAfterReload: false,
        durableMessagesVisibleAfterReload: false,
        headAdvancedAfterReload: false,
        rootPreservedAfterReload: false,
        threadVisibleAfterReload: false,
      },
      config,
      handle,
      projection,
      thread: sourceThread,
    });
  }

  const reloadedHost = createPlaygroundHost(config);
  const reloadedThread = await reloadedHost.runtime.getThread(thread.threadId);
  const reloadedMessages = await reloadedHost.readBranchMessages(
    thread.branchId
  );
  const continuationHandle = reloadedHost.executeTurn({
    branchId: thread.branchId,
    signal: textSignal("Run reload continuation"),
    threadId: thread.threadId,
  });
  const continuationProjection = await reloadedHost.project(continuationHandle);
  const projectionAfterReload = mergeProjections(
    projection,
    continuationProjection
  );
  const continuedThread = withHead(sourceThread, continuationProjection);

  return createReport({
    checks: {
      completedBeforeReload: handle.status().phase === "completed",
      durableReloadAttempted: true,
      continuedAfterReload: continuationHandle.status().phase === "completed",
      durableMessagesVisibleAfterReload: reloadedMessages.length >= 2,
      headAdvancedAfterReload:
        sourceThread.headTurnNodeHash !== continuedThread.headTurnNodeHash,
      rootPreservedAfterReload:
        reloadedThread?.rootTurnNodeHash === thread.rootTurnNodeHash,
      threadVisibleAfterReload: reloadedThread !== null,
    },
    config,
    handle: continuationHandle,
    projection: projectionAfterReload,
    thread: continuedThread,
  });
}

function readMetadataObserved(
  config: PlaygroundConfig,
  messages: unknown[]
): boolean {
  if (config.scenario !== "metadata") {
    return true;
  }

  if (config.providerMode === "ai-sdk-google") {
    return messages.some(hasGoogleProviderMetadataEvidence);
  }

  if (isAimockProviderMode(config.providerMode)) {
    return messages.some(hasAimockResponseMetadataEvidence);
  }

  return messages.some(hasProviderMetadataEvidence);
}

function readToolHistoryPreserved(
  config: PlaygroundConfig,
  durableToolCallProviderCallIdCount: number,
  durableToolCallThoughtSignatureCount: number
): boolean {
  if (config.scenario !== "tools") {
    return true;
  }

  if (config.providerMode === "ai-sdk-google") {
    return durableToolCallThoughtSignatureCount >= 2;
  }

  if (config.providerMode === "aimock-google") {
    return durableToolCallProviderCallIdCount >= 1;
  }

  return true;
}

function readToolTraceObserved(
  config: PlaygroundConfig,
  toolCallProviderCallIdCount: number,
  toolCallThoughtSignatureCount: number
): boolean {
  if (config.scenario !== "tools") {
    return true;
  }

  if (config.providerMode === "ai-sdk-google") {
    return toolCallThoughtSignatureCount >= 2;
  }

  if (config.providerMode === "aimock-google") {
    return toolCallProviderCallIdCount >= 1;
  }

  return true;
}

function readApprovalToolMetadataObserved(
  config: PlaygroundConfig,
  projection: PlaygroundStreamProjection,
  messages: unknown[]
): boolean {
  if (config.providerMode === "ai-sdk-google") {
    return (
      countToolCallThoughtSignatureEvents(projection) >= 1 &&
      countDurableToolCallThoughtSignatures(messages) >= 1
    );
  }

  if (config.providerMode === "aimock-google") {
    return countToolCallProviderCallIdEvents(projection) >= 2;
  }

  return true;
}

function readApprovalToolMetadataHistory(
  config: PlaygroundConfig,
  messages: unknown[],
  durableToolCallProviderCallIdCount: number
): boolean {
  if (config.providerMode === "ai-sdk-google") {
    return countDurableToolCallThoughtSignatures(messages) >= 1;
  }

  if (config.providerMode === "aimock-google") {
    return durableToolCallProviderCallIdCount >= 2;
  }

  return true;
}

function createReport(input: {
  checks: Record<string, boolean>;
  config: PlaygroundConfig;
  error?: {
    code?: string;
    message: string;
  };
  handle: ExecutionHandle;
  projection: PlaygroundStreamProjection;
  thread: PlaygroundThreadSummary;
}): PlaygroundScenarioReport {
  return {
    backend: input.config.backend,
    checks: input.checks,
    ...(input.error === undefined ? {} : { error: input.error }),
    events: {
      aguiTypes: input.projection.agui.map((event) => String(event.type)),
      canonicalTypes: input.projection.canonical.map((event) => event.type),
      sseEvents: input.projection.sse.map((event) => event.event ?? "message"),
    },
    kernelMode: input.config.kernelMode ?? "typescript-local",
    providerMode: input.config.providerMode,
    scenario: input.config.scenario,
    status: input.handle.status(),
    telemetry: createTelemetryEvidence(input),
    thread: input.thread,
  };
}

function createTelemetryEvidence(input: {
  config: PlaygroundConfig;
  projection: PlaygroundStreamProjection;
  thread: PlaygroundThreadSummary;
}): PlaygroundTelemetryEvidence {
  const turnStarts = input.projection.canonical.filter(
    (event): event is Extract<TuvrenStreamEvent, { type: "turn.start" }> =>
      event.type === "turn.start"
  );
  const checkpoints = input.projection.canonical.filter(
    (
      event
    ): event is Extract<TuvrenStreamEvent, { type: "state.checkpoint" }> =>
      event.type === "state.checkpoint"
  );
  const toolCallStarts = input.projection.canonical.filter(
    (event): event is Extract<TuvrenStreamEvent, { type: "tool_call.start" }> =>
      event.type === "tool_call.start"
  );
  const driverId =
    turnStarts[0]?.source?.driver ??
    input.projection.canonical.find(
      (event) => event.source?.driver !== undefined
    )?.source?.driver ??
    null;
  const runIds = input.projection.agui.flatMap((event) => {
    if (event.type !== "RUN_STARTED") {
      return [];
    }

    return typeof event.runId === "string" ? [event.runId] : [];
  });
  const attributes = {
    "tuvren.runtime.backend.id": input.config.backend,
    "tuvren.runtime.branch.id": input.thread.branchId,
    "tuvren.runtime.checkpoint.hash": collapseTelemetryValues(
      checkpoints.map((event) => event.turnNodeHash)
    ),
    "tuvren.runtime.driver.id": driverId,
    "tuvren.runtime.parent_checkpoint.hash": collapseTelemetryValues(
      checkpoints.slice(0, -1).map((event) => event.turnNodeHash)
    ),
    "tuvren.runtime.provider.id": input.config.providerMode,
    "tuvren.runtime.resumed_from.hash": collapseTelemetryValues(
      turnStarts.flatMap((event) =>
        event.resumedFrom === undefined ? [] : [event.resumedFrom]
      )
    ),
    "tuvren.runtime.run.id": collapseTelemetryValues(runIds),
    "tuvren.runtime.tool_call.id": collapseTelemetryValues(
      toolCallStarts.map((event) => event.callId)
    ),
    "tuvren.runtime.turn.id": collapseTelemetryValues(
      turnStarts.map((event) => event.turnId)
    ),
  } satisfies PlaygroundTelemetryEvidence["attributes"];

  return {
    attributes,
    observedKeys: TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS.filter((key) => {
      const value = attributes[key];
      return (
        value !== null &&
        (!Array.isArray(value) || value.length > 0) &&
        value !== ""
      );
    }),
    schemaUrl: TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL,
  };
}

function collapseTelemetryValues(
  values: readonly string[]
): string | string[] | null {
  const uniqueValues = [...new Set(values)];

  if (uniqueValues.length === 0) {
    return null;
  }

  if (uniqueValues.length === 1) {
    return uniqueValues[0] ?? null;
  }

  return uniqueValues;
}

function createScenarioExecutionPlan(
  config: PlaygroundConfig
): PlaygroundScenarioExecutionPlan {
  if (config.providerMode !== "ai-sdk-google") {
    return {
      signal: textSignal(`Run ${config.scenario}`),
      tools: createPlaygroundTools(),
    };
  }

  switch (config.scenario) {
    case "approval": {
      const emailTool = findToolDefinition("email");

      return {
        model: createScenarioProvider(config, {
          requiredToolResultsBeforeRelease: 1,
          toolChoice: "email",
        }),
        signal: textSignal(
          'Call the email tool with subject "Status update" and to "ops@example.com".'
        ),
        tools: [emailTool],
      };
    }
    case "tools": {
      const searchTool = findToolDefinition("search");

      return {
        model: createScenarioProvider(config, {
          requiredToolResultsBeforeRelease: 2,
          toolChoice: "search",
        }),
        signal: textSignal(
          'Use the search tool exactly twice in this order: first with query "docs", then with query "runtime". After the second search result, reply with one short summary sentence.'
        ),
        tools: [searchTool],
      };
    }
    case "structured":
      return {
        signal: textSignal(
          'Return a playground_summary object. Set scenario to "structured" and status to "ready".'
        ),
      };
    case "metadata":
      return {
        signal: textSignal(
          "Reply with a short sentence confirming provider metadata is preserved."
        ),
      };
    case "streaming":
      return {
        signal: textSignal(
          "Reply with a short single-sentence streaming confirmation."
        ),
      };
    default:
      return {
        signal: textSignal(`Run ${config.scenario}`),
      };
  }
}

function createScenarioProvider(
  config: PlaygroundConfig,
  settings: {
    requiredToolResultsBeforeRelease?: number;
    toolChoice?: string;
  }
): TuvrenProvider {
  const provider = createPlaygroundProvider({
    aimockBaseUrl: config.aimockBaseUrl,
    googleApiKey: config.googleApiKey,
    modelId: config.modelId,
    mode: config.providerMode,
    scenario: config.scenario,
  });

  return {
    generate(prompt) {
      return provider.generate(
        mergePromptSettings(prompt, provider.id, settings)
      );
    },
    id: provider.id,
    stream(prompt) {
      return provider.stream(
        mergePromptSettings(prompt, provider.id, settings)
      );
    },
  };
}

function mergePromptSettings(
  prompt: TuvrenPrompt,
  providerId: string,
  settings: {
    requiredToolResultsBeforeRelease?: number;
    toolChoice?: string;
  }
): TuvrenPrompt {
  const mergedSettings = {
    ...(prompt.config?.settings ?? {}),
  };
  const toolResultCount = countPromptToolResults(prompt.messages);
  const releaseAfter = settings.requiredToolResultsBeforeRelease ?? 0;

  if (toolResultCount < releaseAfter && settings.toolChoice !== undefined) {
    mergedSettings.toolChoice = settings.toolChoice;
  } else if ("toolChoice" in mergedSettings) {
    mergedSettings.toolChoice = undefined;
  }

  return {
    ...prompt,
    config: {
      ...prompt.config,
      provider: providerId,
      ...(Object.keys(mergedSettings).length === 0
        ? {}
        : {
            settings: mergedSettings,
          }),
    },
  };
}

function countPromptToolResults(messages: TuvrenPrompt["messages"]): number {
  let count = 0;

  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }

    // Count concrete tool results, not tool-message envelopes, so batched tool
    // result messages cannot release Gemini tool-choice steering early.
    count += message.parts.length;
  }

  return count;
}

function findToolDefinition(name: "email" | "search") {
  const tool = createPlaygroundTools().find((entry) => entry.name === name);

  if (tool === undefined) {
    throw new TuvrenRuntimeError(`missing playground tool "${name}"`, {
      code: "invalid_playground_config",
    });
  }

  return tool;
}

function projectionHasEvent(
  projection: PlaygroundStreamProjection,
  type: TuvrenStreamEvent["type"]
): boolean {
  return projection.canonical.some((event) => event.type === type);
}

function readProjectionError(
  projection: PlaygroundStreamProjection
): PlaygroundScenarioReport["error"] | undefined {
  const errorEvent = [...projection.canonical]
    .reverse()
    .find(
      (event): event is Extract<TuvrenStreamEvent, { type: "error" }> =>
        event.type === "error"
    );

  if (errorEvent === undefined) {
    return undefined;
  }

  const error = errorEvent.error;

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return {
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}

function startProjectionCapture(
  handle: ExecutionHandle
): Promise<PlaygroundStreamProjection> {
  const [canonicalBranch, sseBranch, aguiBranch] = teeTuvrenStreamEvents(
    handle.events(),
    3
  );

  return Promise.all([
    collect(canonicalBranch),
    collect(toSseFrames(sseBranch)),
    collect(toAgUiEvents(aguiBranch)),
  ]).then(([canonical, sse, agui]) => ({
    agui,
    canonical,
    sse,
  }));
}

function projectContinuationCapture(
  handle: ExecutionHandle
): Promise<PlaygroundStreamProjection> {
  const [canonicalBranch, sseBranch] = teeTuvrenStreamEvents(
    handle.events(),
    2
  );

  return Promise.all([
    collect(canonicalBranch),
    collect(toSseFrames(sseBranch)),
  ]).then(([canonical, sse]) => ({
    agui: [],
    canonical,
    sse,
  }));
}

function mergeProjections(
  left: PlaygroundStreamProjection,
  right: PlaygroundStreamProjection
): PlaygroundStreamProjection {
  return {
    agui: [...left.agui, ...right.agui],
    canonical: [...left.canonical, ...right.canonical],
    sse: [...left.sse, ...right.sse],
  };
}

function withHead(
  thread: PlaygroundThreadSummary,
  projection: PlaygroundStreamProjection
): PlaygroundThreadSummary {
  const checkpoint = [...projection.canonical]
    .reverse()
    .find(
      (
        event
      ): event is Extract<TuvrenStreamEvent, { type: "state.checkpoint" }> =>
        event.type === "state.checkpoint"
    );

  return {
    ...thread,
    headTurnNodeHash: checkpoint?.turnNodeHash ?? thread.rootTurnNodeHash,
  };
}

function hasProviderMetadataEvidence(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }

  const providerMetadata = value.providerMetadata;

  if (
    isPlainRecord(providerMetadata) &&
    (isPlainRecord(providerMetadata.playground) ||
      isPlainRecord(providerMetadata.fixture) ||
      isPlainRecord(providerMetadata.aiSdkBridge))
  ) {
    return true;
  }

  return Object.values(value).some((entry) => {
    if (Array.isArray(entry)) {
      return entry.some(hasProviderMetadataEvidence);
    }

    return hasProviderMetadataEvidence(entry);
  });
}

function hasAimockResponseMetadataEvidence(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }

  const providerMetadata = value.providerMetadata;

  if (isPlainRecord(providerMetadata)) {
    const bridgeMetadata = providerMetadata.aiSdkBridge;

    if (isPlainRecord(bridgeMetadata)) {
      const response = bridgeMetadata.response;

      if (isPlainRecord(response)) {
        const metadata = response.metadata;

        // The aimock metadata scenario uses a fixture-specific response id and
        // provider-selected model so the report proves provider response
        // metadata survived the HTTP boundary, bridge mapping, and durable
        // message persistence across OpenAI, Anthropic, and Gemini shapes.
        if (
          isPlainRecord(metadata) &&
          metadata.id === "aimock-metadata-response" &&
          typeof metadata.modelId === "string" &&
          metadata.modelId.length > 0
        ) {
          return true;
        }

        if (hasGoogleProviderNamespace(providerMetadata)) {
          return hasGoogleProviderMetadataEvidence(value);
        }
      }
    }
  }

  return Object.values(value).some((entry) => {
    if (Array.isArray(entry)) {
      return entry.some(hasAimockResponseMetadataEvidence);
    }

    return hasAimockResponseMetadataEvidence(entry);
  });
}

function hasGoogleProviderMetadataEvidence(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }

  const providerMetadata = value.providerMetadata;

  if (isPlainRecord(providerMetadata)) {
    const bridgeMetadata = providerMetadata.aiSdkBridge;

    if (isPlainRecord(bridgeMetadata)) {
      const response = bridgeMetadata.response;
      const streamPartMetadata = bridgeMetadata.streamPartMetadata;
      const responseHeaders = isPlainRecord(response)
        ? response.headers
        : undefined;

      // Google adapters do not consistently surface response-level ids/model
      // metadata, so this proof keys off provider-native `google` / `vertex`
      // metadata surviving both the finish part capture and the durable
      // assistant message rather than on OpenAI-shaped response ids.
      if (
        (hasGoogleThoughtSignature(providerMetadata) ||
          hasGoogleProviderNamespace(providerMetadata)) &&
        isPlainRecord(responseHeaders) &&
        Array.isArray(streamPartMetadata) &&
        streamPartMetadata.some(hasGoogleFinishPartMetadataEvidence)
      ) {
        return true;
      }
    }
  }

  return Object.values(value).some((entry) => {
    if (Array.isArray(entry)) {
      return entry.some(hasGoogleProviderMetadataEvidence);
    }

    return hasGoogleProviderMetadataEvidence(entry);
  });
}

function countToolCallThoughtSignatureEvents(
  projection: PlaygroundStreamProjection
): number {
  return projection.canonical.filter((event) => {
    if (event.type !== "tool_call.done") {
      return false;
    }

    return hasGoogleThoughtSignature(event.providerMetadata);
  }).length;
}

function countDurableToolCallThoughtSignatures(messages: unknown[]): number {
  let count = 0;

  for (const message of messages) {
    if (
      !isPlainRecord(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.parts)
    ) {
      continue;
    }

    for (const part of message.parts) {
      if (
        isPlainRecord(part) &&
        part.type === "tool_call" &&
        hasGoogleThoughtSignature(readProviderMetadata(part))
      ) {
        count += 1;
      }
    }
  }

  return count;
}

function countToolCallProviderCallIdEvents(
  projection: PlaygroundStreamProjection
): number {
  return projection.canonical.filter((event) => {
    if (event.type !== "tool_call.done") {
      return false;
    }

    return hasProviderCallId(event.providerMetadata);
  }).length;
}

function countDurableToolCallProviderCallIds(messages: unknown[]): number {
  let count = 0;

  for (const message of messages) {
    if (
      !isPlainRecord(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.parts)
    ) {
      continue;
    }

    for (const part of message.parts) {
      if (
        isPlainRecord(part) &&
        part.type === "tool_call" &&
        hasProviderCallId(readProviderMetadata(part))
      ) {
        count += 1;
      }
    }
  }

  return count;
}

function hasGoogleThoughtSignature(
  providerMetadata: Record<string, unknown> | undefined
): boolean {
  if (!isPlainRecord(providerMetadata)) {
    return false;
  }

  const googleMetadata = providerMetadata.google;

  if (
    isPlainRecord(googleMetadata) &&
    typeof googleMetadata.thoughtSignature === "string"
  ) {
    return true;
  }

  const vertexMetadata = providerMetadata.vertex;

  return (
    isPlainRecord(vertexMetadata) &&
    typeof vertexMetadata.thoughtSignature === "string"
  );
}

function hasGoogleProviderNamespace(
  providerMetadata: Record<string, unknown> | undefined
): boolean {
  if (!isPlainRecord(providerMetadata)) {
    return false;
  }

  return (
    isPlainRecord(providerMetadata.google) ||
    isPlainRecord(providerMetadata.vertex)
  );
}

function hasGoogleFinishPartMetadataEvidence(value: unknown): boolean {
  if (!isPlainRecord(value) || value.type !== "finish") {
    return false;
  }

  return hasGoogleProviderNamespace(readProviderMetadata(value));
}

function hasProviderCallId(
  providerMetadata: Record<string, unknown> | undefined
): boolean {
  return (
    isPlainRecord(providerMetadata) &&
    typeof providerMetadata.providerCallId === "string" &&
    providerMetadata.providerCallId.length > 0
  );
}

function readProviderMetadata(
  value: Record<string, unknown>
): Record<string, unknown> | undefined {
  return isPlainRecord(value.providerMetadata)
    ? value.providerMetadata
    : undefined;
}

function isEditedEmailToolStart(event: TuvrenStreamEvent): boolean {
  if (event.type !== "tool.start" || event.name !== "email") {
    return false;
  }

  const input = event.input;

  return (
    isPlainRecord(input) &&
    input.subject === "Edited status update" &&
    input.to === "ops@example.com"
  );
}

function hasInjectedSteeringMessage(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }

  if (value.role !== "user" || !Array.isArray(value.parts)) {
    return false;
  }

  return value.parts.some(
    (part) =>
      isPlainRecord(part) &&
      part.type === "text" &&
      part.text === "Injected steering"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];

  for await (const event of events) {
    output.push(event);
  }

  return output;
}

async function waitFor(
  condition: () => boolean,
  timeoutMilliseconds = 1000
): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMilliseconds) {
      throw new Error("timed out waiting for playground condition");
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

async function steerWhenRunning(
  host: PlaygroundHost,
  handle: ExecutionHandle,
  signal: InputSignal,
  timeoutMilliseconds = 1000
): Promise<void> {
  const startedAt = Date.now();

  while (true) {
    try {
      host.steer(handle, signal);
      return;
    } catch (error: unknown) {
      if (
        !(
          error instanceof TuvrenRuntimeError &&
          error.code === "invalid_steering_state" &&
          handle.status().phase === "running"
        )
      ) {
        throw error;
      }
    }

    if (Date.now() - startedAt >= timeoutMilliseconds) {
      throw new Error("timed out waiting for playground steering acceptance");
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}
