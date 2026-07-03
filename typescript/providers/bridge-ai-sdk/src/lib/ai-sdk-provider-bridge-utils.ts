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

import type {
  JSONSchema7,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";
import { AISDKError } from "@ai-sdk/provider";
import { TuvrenProviderError } from "@tuvren/core";
import type {
  StructuredOutputRequest,
  TuvrenPrompt,
} from "@tuvren/provider-api";

type TuvrenPromptPart = Extract<
  TuvrenPrompt["messages"][number],
  {
    parts: unknown[];
  }
>["parts"][number];

interface JsonObject {
  [key: string]: JsonValue | undefined;
}

type JsonValue = null | boolean | JsonObject | JsonValue[] | number | string;

export interface StreamToolState {
  doneEmitted: boolean;
  ended: boolean;
  inputBuffer: string;
  name: string;
  providerMetadata?: Record<string, unknown>;
  /**
   * True when the streamed tool input belongs to a declared provider-executed
   * (`providerExecuted`/`dynamic`) tool. Real providers stream provider-executed
   * tools as `tool-input-start` → `tool-input-delta` → `tool-input-end` →
   * `tool-call` → `tool-result`; only `tool-input-start` carries the
   * `providerExecuted`/`dynamic` flags, so the marker is seeded there and read by
   * the later input parts to keep them out of the client tool_call stream
   * (KRT-BH005 / ADR-055).
   */
  providerOwned?: boolean;
  started: boolean;
}

const ASSISTANT_REASONING_REPLAY_PROVIDER_KEYS = {
  anthropic: new Set(["redactedData", "signature"]),
  azure: new Set(["reasoningEncryptedContent"]),
  google: new Set(["thoughtSignature"]),
  openai: new Set(["reasoningEncryptedContent"]),
  vertex: new Set(["thoughtSignature"]),
} as const;

const ASSISTANT_TEXT_REPLAY_PROVIDER_KEYS = {
  google: new Set(["thoughtSignature"]),
  vertex: new Set(["thoughtSignature"]),
} as const;

export function captureStreamPartMetadata(
  collection: unknown[],
  part: LanguageModelV3StreamPart
): void {
  if (!("providerMetadata" in part) || part.providerMetadata === undefined) {
    return;
  }

  collection.push(
    sanitizeMetadataValue({
      id: "id" in part ? part.id : undefined,
      providerMetadata: part.providerMetadata,
      toolCallId: "toolCallId" in part ? part.toolCallId : undefined,
      type: part.type,
    })
  );
}

export function mapPromptProviderOptions(
  providerMetadata: Record<string, unknown> | undefined
): SharedV3ProviderOptions | undefined {
  const sanitized = sanitizeRecord(providerMetadata);

  if (sanitized === undefined) {
    return undefined;
  }

  const normalized = normalizePromptProviderMetadata(sanitized);

  return normalized === undefined
    ? undefined
    : cloneProviderOptions(normalized);
}

export function mapAssistantReplayProviderOptions(
  activeProvider: string,
  part: TuvrenPromptPart
): SharedV3ProviderOptions | undefined {
  const sanitized = sanitizeRecord(part.providerMetadata);

  if (sanitized === undefined) {
    return undefined;
  }

  switch (part.type) {
    case "text":
      return cloneProviderOptionsOrUndefined(
        collectAssistantReplayProviderOptions(
          sanitized,
          ASSISTANT_TEXT_REPLAY_PROVIDER_KEYS
        )
      );
    case "reasoning": {
      const normalized = collectAssistantReplayProviderOptions(
        sanitized,
        ASSISTANT_REASONING_REPLAY_PROVIDER_KEYS
      );

      if (typeof sanitized.signature === "string") {
        applyFlatReasoningSignature(
          normalized,
          activeProvider,
          sanitized.signature
        );
      }

      return cloneProviderOptionsOrUndefined(normalized);
    }
    case "tool_call":
      return cloneProviderOptionsOrUndefined(
        collectAssistantReplayProviderOptions(
          sanitized,
          ASSISTANT_TEXT_REPLAY_PROVIDER_KEYS
        )
      );
    default:
      return undefined;
  }
}

function applyFlatReasoningSignature(
  providerOptions: Record<string, unknown>,
  activeProvider: string,
  signature: string
): void {
  const providerNamespace =
    getFlatReasoningSignatureProviderNamespace(activeProvider);

  providerOptions[providerNamespace] = mergePromptProviderNamespace(
    providerOptions[providerNamespace],
    providerNamespace === "anthropic"
      ? {
          signature,
        }
      : {
          thoughtSignature: signature,
        }
  );
}

function getFlatReasoningSignatureProviderNamespace(
  activeProvider: string
): "anthropic" | "google" | "vertex" {
  if (activeProvider.includes("vertex")) {
    return "vertex";
  }

  if (activeProvider.includes("google")) {
    return "google";
  }

  return "anthropic";
}

function normalizePromptProviderMetadata(
  providerMetadata: Record<string, unknown>
): Record<string, unknown> | undefined {
  const normalized: Record<string, unknown> = {};
  let hasProviderOptions = false;

  for (const [providerName, providerValue] of Object.entries(
    providerMetadata
  )) {
    if (!isPlainObject(providerValue)) {
      continue;
    }

    normalized[providerName] = cloneMetadataValue(providerValue);
    hasProviderOptions = true;
  }

  if (typeof providerMetadata.signature === "string") {
    normalized.anthropic = mergePromptProviderNamespace(normalized.anthropic, {
      signature: providerMetadata.signature,
    });
    hasProviderOptions = true;
  }

  return hasProviderOptions ? normalized : undefined;
}

function cloneProviderOptionsOrUndefined(
  providerOptions: Record<string, unknown>
): SharedV3ProviderOptions | undefined {
  return Object.keys(providerOptions).length === 0
    ? undefined
    : cloneProviderOptions(providerOptions);
}

function collectAssistantReplayProviderOptions(
  providerMetadata: Record<string, unknown>,
  allowedProviderKeys: Record<string, Set<string>>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [providerName, allowedKeys] of Object.entries(
    allowedProviderKeys
  )) {
    const providerValue = providerMetadata[providerName];

    if (!isPlainObject(providerValue)) {
      continue;
    }

    const filteredProviderMetadata: Record<string, unknown> = {};

    for (const key of allowedKeys) {
      const value = providerValue[key];

      if (value !== undefined) {
        filteredProviderMetadata[key] = cloneMetadataValue(value);
      }
    }

    if (Object.keys(filteredProviderMetadata).length > 0) {
      normalized[providerName] = filteredProviderMetadata;
    }
  }

  return normalized;
}

export function mergePromptProviderNamespace(
  current: unknown,
  additions: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  if (isPlainObject(current)) {
    for (const [key, value] of Object.entries(current)) {
      merged[key] = cloneMetadataValue(value);
    }
  }

  for (const [key, value] of Object.entries(additions)) {
    if (!(key in merged)) {
      merged[key] = cloneMetadataValue(value);
    }
  }

  return merged;
}

export function sanitizeGenerateResponseMetadata(
  response: LanguageModelV3GenerateResult["response"]
): unknown {
  if (response === undefined) {
    return undefined;
  }

  return sanitizeMetadataValue({
    body: response.body,
    headers: response.headers,
    id: response.id,
    modelId: response.modelId,
    timestamp:
      response.timestamp instanceof Date
        ? response.timestamp.toISOString()
        : undefined,
  });
}

export function sanitizeResponseMetadata(
  response: Extract<LanguageModelV3StreamPart, { type: "response-metadata" }>
): Record<string, unknown> {
  return {
    ...(typeof response.id === "string"
      ? {
          id: response.id,
        }
      : {}),
    ...(typeof response.modelId === "string"
      ? {
          modelId: response.modelId,
        }
      : {}),
    ...(response.timestamp instanceof Date
      ? {
          timestamp: response.timestamp.toISOString(),
        }
      : {}),
  };
}

export function buildProviderMetadata(input: {
  bridgeExtras: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  const providerMetadata = sanitizeRecord(input.providerMetadata);
  const extras = sanitizeRecord(input.bridgeExtras);

  if (providerMetadata !== undefined) {
    Object.assign(metadata, providerMetadata);
  }

  if (extras !== undefined) {
    metadata.aiSdkBridge = extras;
  }

  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

export function mergeProviderMetadataRecords(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (current === undefined) {
    return next === undefined ? undefined : cloneMetadataValue(next);
  }

  if (next === undefined) {
    return current;
  }

  const merged = cloneMetadataValue(current);

  for (const [providerName, providerValue] of Object.entries(next)) {
    const existingValue = merged[providerName];

    if (isPlainObject(existingValue) && isPlainObject(providerValue)) {
      const mergedProviderMetadata: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(existingValue)) {
        mergedProviderMetadata[key] = cloneMetadataValue(value);
      }

      for (const [key, value] of Object.entries(providerValue)) {
        mergedProviderMetadata[key] = cloneMetadataValue(value);
      }

      merged[providerName] = mergedProviderMetadata;
      continue;
    }

    merged[providerName] = cloneMetadataValue(providerValue);
  }

  return merged;
}

export function readReasoningStreamSignature(
  providerMetadata: Record<string, unknown> | undefined
): string | undefined {
  const sanitized = sanitizeRecord(providerMetadata);

  if (sanitized === undefined) {
    return undefined;
  }

  const anthropicMetadata = sanitized.anthropic;
  const googleMetadata = sanitized.google;
  const vertexMetadata = sanitized.vertex;

  if (
    isPlainObject(anthropicMetadata) &&
    typeof anthropicMetadata.signature === "string"
  ) {
    return anthropicMetadata.signature;
  }

  if (
    isPlainObject(googleMetadata) &&
    typeof googleMetadata.thoughtSignature === "string"
  ) {
    return googleMetadata.thoughtSignature;
  }

  return isPlainObject(vertexMetadata) &&
    typeof vertexMetadata.thoughtSignature === "string"
    ? vertexMetadata.thoughtSignature
    : undefined;
}

export function hasAnthropicRedactedReasoningMetadata(
  providerMetadata: Record<string, unknown> | undefined
): boolean {
  const sanitized = sanitizeRecord(providerMetadata);

  if (sanitized === undefined) {
    return false;
  }

  const anthropicMetadata = sanitized.anthropic;

  return (
    isPlainObject(anthropicMetadata) &&
    typeof anthropicMetadata.redactedData === "string"
  );
}

export function sanitizeRecord(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const sanitized = sanitizeMetadataValue(value);
  return isPlainObject(sanitized) ? sanitized : undefined;
}

export function sanitizeMetadataValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value === undefined) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (value instanceof Uint8Array) {
    return {
      base64: Buffer.from(value).toString("base64"),
      type: "uint8array",
    };
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMetadataValue(entry));
  }

  if (isPlainObject(value)) {
    const sanitized: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      const normalized = sanitizeMetadataValue(entry);

      if (normalized !== undefined) {
        sanitized[key] = normalized;
      }
    }

    return sanitized;
  }

  return String(value);
}

export function cloneProviderOptions(
  value: SharedV3ProviderOptions | Record<string, unknown> | undefined
): SharedV3ProviderOptions | undefined {
  if (value === undefined) {
    return undefined;
  }

  const cloned: SharedV3ProviderOptions = {};

  for (const [key, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      throw bridgeError(
        "AI SDK bridge providerOptions entries must be plain objects",
        "invalid_ai_sdk_bridge_config",
        {
          providerNamespace: key,
          value: entry,
        }
      );
    }

    cloned[key] = cloneJsonObject(entry);
  }

  return cloned;
}

export function cloneHeaders(
  value: Record<string, string | undefined> | undefined
): Record<string, string | undefined> | undefined {
  if (value === undefined) {
    return undefined;
  }

  return {
    ...value,
  };
}

export function cloneMetadataValue<T>(value: T): T {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => cloneMetadataValue(entry)) as T;
  }

  if (isPlainObject(value)) {
    const clone: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      clone[key] = cloneMetadataValue(entry);
    }

    return clone as T;
  }

  return value;
}

export function cloneFileData(value: string | Uint8Array): string | Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : value;
}

export function cloneJsonSchema(
  schema: StructuredOutputRequest["schema"]
): JSONSchema7 {
  return cloneMetadataValue(schema) as JSONSchema7;
}

export function parseJsonInput(
  text: string,
  label: string,
  code: string,
  details?: Record<string, unknown>
): unknown {
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    throw normalizeBridgeError(error, code, {
      ...details,
      label,
      text,
    });
  }
}

/**
 * A tool part is "provider-owned" when the provider executed it itself
 * (`providerExecuted`) or it is a runtime-defined provider tool (`dynamic`, e.g.
 * an MCP call). AI SDK v6 surfaces both flags on provider-executed tool-calls
 * (vercel/ai #10888). Client-executed function tools carry neither.
 *
 * Invariant: this predicate only CLASSIFIES; it never decides skip-vs-execute on
 * its own. The bridge skips a provider-owned tool only when the host ALSO
 * declared that tool name provider-native/mediated (`ProviderToolClassLookup`
 * resolves it). A `dynamic` client function tool the host never declared
 * provider-native therefore can never be silently swallowed — it falls through
 * to the baseline rejection, exactly as before this seam existed.
 */
export function isProviderOwnedToolPart(part: {
  dynamic?: boolean;
  providerExecuted?: boolean;
}): boolean {
  return part.providerExecuted === true || part.dynamic === true;
}

export function providerOwnedToolExecutionUnsupportedError(
  toolName: string,
  model: {
    modelId: string;
    provider: string;
  }
): TuvrenProviderError {
  return bridgeError(
    "provider-owned tool execution is out of scope for the baseline AI SDK bridge",
    "unsupported_ai_sdk_content",
    {
      modelId: model.modelId,
      provider: model.provider,
      reason: "provider_owned_tool_execution_unsupported",
      toolName,
    }
  );
}

export function requireToolState(
  toolStates: Map<string, StreamToolState>,
  id: string,
  model: {
    modelId: string;
    provider: string;
  },
  part: {
    type: string;
  }
): StreamToolState {
  const state = toolStates.get(id);

  if (state !== undefined) {
    return state;
  }

  throw bridgeError(
    "AI SDK stream emitted tool input deltas before tool input started",
    "unsupported_ai_sdk_stream_part",
    {
      modelId: model.modelId,
      partType: part.type,
      provider: model.provider,
      providerCallId: id,
    }
  );
}

export function unsupportedStreamPartError(
  partType: string,
  model: {
    modelId: string;
    provider: string;
  }
): TuvrenProviderError {
  let reason: string | undefined;

  if (partType === "tool-approval-request") {
    reason = "provider_owned_tool_approval_unsupported";
  } else if (partType === "tool-result") {
    reason = "provider_owned_tool_result_unsupported";
  }

  return bridgeError(
    `AI SDK stream part "${partType}" is out of scope for the baseline bridge`,
    "unsupported_ai_sdk_stream_part",
    {
      modelId: model.modelId,
      partType,
      provider: model.provider,
      ...(reason === undefined ? {} : { reason }),
    }
  );
}

export function normalizeBridgeError(
  error: unknown,
  code: string,
  details?: Record<string, unknown>
): TuvrenProviderError {
  if (error instanceof TuvrenProviderError) {
    return error;
  }

  if (AISDKError.isInstance(error)) {
    return bridgeError(error.message, code, {
      ...details,
      aiSdkErrorName: error.name,
    });
  }

  if (error instanceof Error) {
    return bridgeError(error.message, code, {
      ...details,
      errorName: error.name,
    });
  }

  return bridgeError("unknown AI SDK bridge failure", code, {
    ...details,
    error: sanitizeMetadataValue(error),
  });
}

export function bridgeError(
  message: string,
  code: string,
  details?: Record<string, unknown>
): TuvrenProviderError {
  return new TuvrenProviderError(message, {
    code,
    ...(details === undefined
      ? {}
      : {
          details: sanitizeMetadataValue(details),
        }),
  });
}

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }

  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.enumerable === true && "value" in descriptor
  );
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  return Object.values(value).every((entry) => isJsonValue(entry));
}

export function cloneJsonObject(value: Record<string, unknown>): JsonObject {
  const cloned: JsonObject = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }

    if (!isJsonValue(entry)) {
      throw bridgeError(
        "AI SDK bridge JSON object values must be JSON-serializable",
        "invalid_ai_sdk_bridge_config",
        {
          key,
          value: entry,
        }
      );
    }

    cloned[key] = cloneJsonValue(entry);
  }

  return cloned;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry));
  }

  return cloneJsonObject(value);
}
