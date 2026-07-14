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
import { screenValueForSecretPatterns } from "@tuvren/core/security";
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

/**
 * Per-tool bookkeeping for one streamed tool invocation, keyed by the
 * provider call id in `StreamMappingState.toolStates`. Tracks the incremental
 * input buffer, lifecycle flags (`started`/`ended`/`doneEmitted`), and merged
 * provider metadata so the terminal `tool_call_done` chunk can be emitted
 * exactly once with complete data.
 */
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

/**
 * Provider-metadata keys allowed to replay on assistant `reasoning` parts:
 * the opaque continuity artifacts (signatures, encrypted reasoning content)
 * each provider requires to accept its own prior reasoning back.
 */
const ASSISTANT_REASONING_REPLAY_PROVIDER_KEYS = {
  anthropic: new Set(["redactedData", "signature"]),
  azure: new Set(["reasoningEncryptedContent"]),
  google: new Set(["thoughtSignature"]),
  openai: new Set(["reasoningEncryptedContent"]),
  vertex: new Set(["thoughtSignature"]),
} as const;

/**
 * Provider-metadata keys allowed to replay on assistant `text` and
 * `tool_call` parts (Gemini thought signatures ride on those part types).
 */
const ASSISTANT_TEXT_REPLAY_PROVIDER_KEYS = {
  google: new Set(["thoughtSignature"]),
  vertex: new Set(["thoughtSignature"]),
} as const;

/**
 * Records a stream part's provider metadata (with part type and ids) into the
 * per-call collection surfaced on the finish chunk's provider metadata.
 * Parts without `providerMetadata` are ignored.
 */
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

/**
 * Maps a prompt part's stored `providerMetadata` to AI SDK `providerOptions`
 * for replay: keeps provider-namespaced plain objects, and lifts a legacy
 * flat `signature` string into the `anthropic` namespace. Returns
 * `undefined` when nothing survives sanitization.
 */
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

/**
 * Maps an assistant part's stored `providerMetadata` to the replay
 * `providerOptions`, filtered to the allow-listed continuity keys for the
 * part type ({@link ASSISTANT_REASONING_REPLAY_PROVIDER_KEYS} /
 * {@link ASSISTANT_TEXT_REPLAY_PROVIDER_KEYS}). A flat `signature` string on
 * a reasoning part is routed into the active provider's namespace. Returns
 * `undefined` for part types with no replay contract or when nothing
 * survives filtering.
 */
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

/**
 * Routes a flat (non-namespaced) reasoning `signature` into the active
 * provider's namespace under its expected key (`signature` for anthropic,
 * `thoughtSignature` for google/vertex), without overwriting existing keys.
 */
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

/**
 * Picks the provider-options namespace for a flat reasoning signature from
 * the active provider name; anything that is not vertex/google-flavored is
 * treated as anthropic.
 */
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

/**
 * Keeps provider-namespaced plain-object entries and lifts a flat
 * `signature` into the `anthropic` namespace; returns `undefined` when no
 * provider options remain.
 */
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

/** Clones a provider-options record, collapsing an empty record to `undefined`. */
function cloneProviderOptionsOrUndefined(
  providerOptions: Record<string, unknown>
): SharedV3ProviderOptions | undefined {
  return Object.keys(providerOptions).length === 0
    ? undefined
    : cloneProviderOptions(providerOptions);
}

/**
 * Filters provider metadata down to the allow-listed replay keys per
 * provider namespace, dropping namespaces that end up empty.
 */
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

/**
 * Merges additions into one provider namespace without overwriting keys the
 * namespace already defines (existing values win).
 */
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

/**
 * Sanitizes a generate result's response metadata (body, headers, id,
 * modelId, ISO timestamp) for provider-metadata attribution.
 */
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

/**
 * Extracts the well-typed fields (id, modelId, ISO timestamp) from a
 * `response-metadata` stream part, omitting anything malformed.
 */
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

/**
 * Assembles the provider metadata attached to a response or finish chunk:
 * the provider's own metadata namespaces plus the bridge's captured extras
 * under an `aiSdkBridge` key.
 *
 * Only the bridge extras are screened for secret-shaped substrings before
 * they can reach event payloads and durable run records (ADR-044); the
 * provider namespaces are left intact because reasoning-signature strings
 * would otherwise trip the screening (see the inline note).
 */
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
    // Screen only the bridge's own captured extras (raw requestBody, response
    // headers, warnings, ...) for secret-shaped substrings before they reach
    // "tool_call.done" event payloads and durable run records (ADR-044,
    // KRT-BK004). `providerMetadata` above is deliberately left untouched:
    // `readReasoningStreamSignature` reads long opaque reasoning-signature
    // strings out of it (anthropic.signature, google/vertex.thoughtSignature),
    // which would otherwise collide with the long-secretish pattern below.
    metadata.aiSdkBridge = screenValueForSecretPatterns(extras);
  }

  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

/**
 * Deep-merges two provider-metadata records: same-named provider namespaces
 * merge key-by-key with `next` winning; other entries are cloned through.
 * Returns the surviving record, or `undefined` when both inputs are.
 */
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

/**
 * Reads the opaque reasoning signature from stream-part provider metadata,
 * checking `anthropic.signature`, then `google.thoughtSignature`, then
 * `vertex.thoughtSignature`.
 */
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

/**
 * True when provider metadata carries Anthropic redacted-reasoning content
 * (`anthropic.redactedData`), which streams no visible text.
 */
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

/**
 * Sanitizes a record via {@link sanitizeMetadataValue}, returning `undefined`
 * unless the result is still a plain object.
 */
export function sanitizeRecord(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const sanitized = sanitizeMetadataValue(value);
  return isPlainObject(sanitized) ? sanitized : undefined;
}

/**
 * Recursively converts an arbitrary value into a JSON-safe shape for
 * metadata and error details: Dates/URLs become strings, `Uint8Array`
 * becomes a base64-tagged object, Errors keep name and message,
 * `undefined` object entries are dropped, and anything non-plain is
 * stringified.
 */
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

/**
 * Deep-clones a provider-options record, enforcing that every provider
 * namespace is a plain JSON-serializable object.
 *
 * @throws TuvrenProviderError with code `invalid_ai_sdk_bridge_config` when
 *   a namespace entry is not a plain object.
 */
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

/** Shallow-clones a headers record so callers cannot mutate bridge defaults. */
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

/**
 * Structurally clones metadata values (arrays, plain objects, `Uint8Array`);
 * other values are returned as-is.
 */
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

/** Clones binary file data; string (URL/base64) file data is immutable as-is. */
export function cloneFileData(value: string | Uint8Array): string | Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : value;
}

/**
 * Deep-clones a structured-output schema before handing it to Ajv or the AI
 * SDK, so neither can observe later host mutations.
 */
export function cloneJsonSchema(
  schema: StructuredOutputRequest["schema"]
): JSONSchema7 {
  return cloneMetadataValue(schema) as JSONSchema7;
}

/**
 * Parses text as JSON, wrapping any parse failure in a `TuvrenProviderError`
 * with the given code and the offending text in its details.
 */
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

/**
 * Builds the `unsupported_ai_sdk_content` rejection for provider-owned tool
 * execution the host never declared provider-native/mediated — the baseline
 * bridge's protection against silently accepting provider-side execution.
 */
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

/**
 * Looks up the tool state seeded by `tool-input-start` for a provider call
 * id.
 *
 * @throws TuvrenProviderError with code `unsupported_ai_sdk_stream_part`
 *   when input parts arrive before the tool input started.
 */
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

/**
 * Builds the `unsupported_ai_sdk_stream_part` rejection for stream parts
 * outside the baseline contract, tagging provider-owned approval/result
 * parts with a machine-readable `reason`.
 */
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

/**
 * Normalizes any thrown value into a `TuvrenProviderError`: existing
 * `TuvrenProviderError`s pass through unchanged (their original code wins),
 * `AISDKError`s and plain `Error`s keep their message with the error name in
 * details, and anything else is sanitized into the details.
 */
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

/**
 * Constructs a `TuvrenProviderError` with a stable bridge error code and
 * sanitized (JSON-safe) details.
 */
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

/**
 * Strict plain-object predicate: `Object.prototype` or `null` prototype
 * only, no symbol keys, and only enumerable data properties — the shape the
 * bridge accepts for provider options and metadata records.
 */
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

/**
 * Recursive JSON-value predicate; non-finite numbers and non-plain objects
 * are rejected.
 */
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

/**
 * Deep-clones a record as a JSON object, dropping `undefined` entries.
 *
 * @throws TuvrenProviderError with code `invalid_ai_sdk_bridge_config` when
 *   an entry is not JSON-serializable.
 */
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
