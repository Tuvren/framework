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

export function readMetadataObserved(
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

export function readToolHistoryPreserved(
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

export function readToolTraceObserved(
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

export function readApprovalToolMetadataObserved(
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

export function readApprovalToolMetadataHistory(
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

export function createReport(input: {
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

export function createScenarioExecutionPlan(
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

export function readProjectionError(
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

export function startProjectionCapture(
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

export function projectContinuationCapture(
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

export function mergeProjections(
  left: PlaygroundStreamProjection,
  right: PlaygroundStreamProjection
): PlaygroundStreamProjection {
  return {
    agui: [...left.agui, ...right.agui],
    canonical: [...left.canonical, ...right.canonical],
    sse: [...left.sse, ...right.sse],
  };
}

export function withHead(
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

export function countToolCallThoughtSignatureEvents(
  projection: PlaygroundStreamProjection
): number {
  return projection.canonical.filter((event) => {
    if (event.type !== "tool_call.done") {
      return false;
    }

    return hasGoogleThoughtSignature(event.providerMetadata);
  }).length;
}

export function countDurableToolCallThoughtSignatures(
  messages: unknown[]
): number {
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

export function countToolCallProviderCallIdEvents(
  projection: PlaygroundStreamProjection
): number {
  return projection.canonical.filter((event) => {
    if (event.type !== "tool_call.done") {
      return false;
    }

    return hasProviderCallId(event.providerMetadata);
  }).length;
}

export function countDurableToolCallProviderCallIds(
  messages: unknown[]
): number {
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

export function isEditedEmailToolStart(event: TuvrenStreamEvent): boolean {
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

export async function waitFor(
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

export async function steerWhenRunning(
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

export function readSteeringMessageDurable(messages: unknown[]): boolean {
  return messages.some(hasInjectedSteeringMessage);
}
