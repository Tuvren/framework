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

import { isContentPart } from "./runtime-content-approval-predicates.js";
import {
  hasOnlyAllowedKeys,
  isNonEmptyStringProperty,
  isOptionalProviderUsage,
  isOptionalSerializableRecordProperty,
  isOptionalStringProperty,
  isPlainObject,
  isSerializableContractValue,
  isStringProperty,
  safePredicate,
} from "./runtime-contract-predicates.js";
import type {
  ProviderStreamChunk,
  TuvrenModelResponse,
} from "./runtime-contract-shapes.js";
import { TuvrenValidationError } from "./tuvren-error.js";

const PROVIDER_STREAM_CHUNK_TYPES = new Set([
  "text_delta",
  "reasoning_delta",
  "reasoning_done",
  "structured_delta",
  "structured_done",
  "tool_call_start",
  "tool_call_args_delta",
  "tool_call_done",
  "provider_tool_result",
  "finish",
  "error",
]);
export const FINISH_REASONS = new Set([
  "stop",
  "tool_call",
  "length",
  "error",
  "content_filter",
]);
const PROVIDER_TEXT_DELTA_KEYS = new Set(["type", "text"]);
const PROVIDER_REASONING_DELTA_KEYS = new Set(["type", "text", "signature"]);
const PROVIDER_REASONING_DONE_KEYS = new Set(["type"]);
const PROVIDER_STRUCTURED_DELTA_KEYS = new Set(["type", "delta"]);
const PROVIDER_STRUCTURED_DONE_KEYS = new Set(["type", "data", "name"]);
const PROVIDER_TOOL_CALL_START_KEYS = new Set([
  "type",
  "providerCallId",
  "name",
]);
const PROVIDER_TOOL_CALL_ARGS_DELTA_KEYS = new Set([
  "type",
  "providerCallId",
  "delta",
]);
const PROVIDER_TOOL_CALL_DONE_KEYS = new Set([
  "type",
  "providerCallId",
  "name",
  "input",
  "providerMetadata",
]);
const PROVIDER_TOOL_RESULT_KEYS = new Set([
  "type",
  "providerCallId",
  "name",
  "result",
  "isError",
  "providerMetadata",
]);
const PROVIDER_FINISH_KEYS = new Set([
  "type",
  "finishReason",
  "usage",
  "providerMetadata",
]);
const PROVIDER_ERROR_KEYS = new Set(["type", "error"]);
const PROVIDER_TOOL_EXECUTION_CLASSES = new Set([
  "provider-native",
  "provider-mediated",
]);
const PROVIDER_NATIVE_INVOCATION_RECORD_KEYS = new Set([
  "callId",
  "executionClass",
  "isError",
  "name",
  "providerCallId",
  "providerMetadata",
  "result",
]);
const TUVREN_MODEL_RESPONSE_KEYS = new Set([
  "finishReason",
  "parts",
  "providerToolResults",
  "providerMetadata",
  "usage",
]);

/**
 * True when `value` is a valid `ProviderNativeInvocationRecord`: exact key
 * allowlist, non-empty `callId`/`name`/`providerCallId`, an
 * `executionClass` of `provider-native` or `provider-mediated`, a present
 * `result` field, optional boolean `isError`, and optional serializable
 * `providerMetadata`.
 */
const isProviderNativeInvocationRecord = (value: unknown): boolean =>
  safePredicate(
    () =>
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, PROVIDER_NATIVE_INVOCATION_RECORD_KEYS) &&
      isNonEmptyStringProperty(value, "callId") &&
      isStringProperty(value, "executionClass") &&
      PROVIDER_TOOL_EXECUTION_CLASSES.has(value.executionClass) &&
      isNonEmptyStringProperty(value, "name") &&
      isNonEmptyStringProperty(value, "providerCallId") &&
      "result" in value &&
      (value.isError === undefined || typeof value.isError === "boolean") &&
      isOptionalSerializableRecordProperty(value, "providerMetadata")
  );

/**
 * Returns `true` when `value` is a structurally valid
 * {@link TuvrenModelResponse} (KrakenFrameworkSpecification §1.4).
 *
 * Requires an exact key allowlist (`finishReason`, `parts`,
 * `providerToolResults`, `usage`, `providerMetadata`), a `finishReason` from
 * the canonical set (`stop` | `tool_call` | `length` | `error` |
 * `content_filter`), `parts` composed entirely of valid content parts,
 * optional `providerToolResults` as provider-native invocation records,
 * optional token `usage`, and optional serializable `providerMetadata`.
 * Never throws; probe failures collapse to `false`.
 *
 * @see {@link assertTuvrenModelResponse} for the throwing variant.
 */
export const isTuvrenModelResponse = (
  value: unknown
): value is TuvrenModelResponse =>
  safePredicate(
    () =>
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, TUVREN_MODEL_RESPONSE_KEYS) &&
      isStringProperty(value, "finishReason") &&
      FINISH_REASONS.has(value.finishReason) &&
      Array.isArray(value.parts) &&
      value.parts.every(isContentPart) &&
      (!("providerToolResults" in value) ||
        (Array.isArray(value.providerToolResults) &&
          value.providerToolResults.every(isProviderNativeInvocationRecord))) &&
      isOptionalProviderUsage(value, "usage") &&
      isOptionalSerializableRecordProperty(value, "providerMetadata")
  );

/**
 * Asserts that `value` is a valid {@link TuvrenModelResponse}.
 *
 * @param value - Untrusted candidate model response.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws {TuvrenValidationError} With code `invalid_model_response` when
 *   {@link isTuvrenModelResponse} rejects the value.
 */
export const assertTuvrenModelResponse: (
  value: unknown,
  label?: string
) => asserts value is TuvrenModelResponse = (
  value: unknown,
  label = "value"
): asserts value is TuvrenModelResponse => {
  if (!isTuvrenModelResponse(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid TuvrenModelResponse`,
      { code: "invalid_model_response", details: value }
    );
  }
};

const isProviderTextDelta = (value: Record<string, unknown>): boolean =>
  hasOnlyAllowedKeys(value, PROVIDER_TEXT_DELTA_KEYS) &&
  typeof value.text === "string";

const isProviderReasoningDelta = (value: Record<string, unknown>): boolean =>
  hasOnlyAllowedKeys(value, PROVIDER_REASONING_DELTA_KEYS) &&
  typeof value.text === "string" &&
  isOptionalStringProperty(value, "signature");

const isProviderStructuredDelta = (value: Record<string, unknown>): boolean =>
  hasOnlyAllowedKeys(value, PROVIDER_STRUCTURED_DELTA_KEYS) &&
  typeof value.delta === "string";

const isProviderStructuredDone = (value: Record<string, unknown>): boolean =>
  hasOnlyAllowedKeys(value, PROVIDER_STRUCTURED_DONE_KEYS) &&
  "data" in value &&
  isSerializableContractValue(value.data) &&
  isOptionalStringProperty(value, "name");

const isProviderToolCallStart = (value: Record<string, unknown>): boolean =>
  hasOnlyAllowedKeys(value, PROVIDER_TOOL_CALL_START_KEYS) &&
  isNonEmptyStringProperty(value, "providerCallId") &&
  isNonEmptyStringProperty(value, "name");

const isProviderToolCallArgsDelta = (value: Record<string, unknown>): boolean =>
  hasOnlyAllowedKeys(value, PROVIDER_TOOL_CALL_ARGS_DELTA_KEYS) &&
  isNonEmptyStringProperty(value, "providerCallId") &&
  typeof value.delta === "string";

const isProviderToolCallDone = (value: Record<string, unknown>): boolean =>
  hasOnlyAllowedKeys(value, PROVIDER_TOOL_CALL_DONE_KEYS) &&
  isNonEmptyStringProperty(value, "providerCallId") &&
  isNonEmptyStringProperty(value, "name") &&
  "input" in value &&
  isSerializableContractValue(value.input) &&
  isOptionalSerializableRecordProperty(value, "providerMetadata");

const isProviderToolResult = (value: Record<string, unknown>): boolean =>
  hasOnlyAllowedKeys(value, PROVIDER_TOOL_RESULT_KEYS) &&
  isNonEmptyStringProperty(value, "providerCallId") &&
  isNonEmptyStringProperty(value, "name") &&
  "result" in value &&
  isSerializableContractValue(value.result) &&
  (value.isError === undefined || typeof value.isError === "boolean") &&
  isOptionalSerializableRecordProperty(value, "providerMetadata");

const isProviderFinish = (value: Record<string, unknown>): boolean =>
  hasOnlyAllowedKeys(value, PROVIDER_FINISH_KEYS) &&
  isStringProperty(value, "finishReason") &&
  FINISH_REASONS.has(value.finishReason) &&
  isOptionalProviderUsage(value, "usage") &&
  isOptionalSerializableRecordProperty(value, "providerMetadata");

/**
 * Returns `true` when `value` is a structurally valid
 * {@link ProviderStreamChunk} (KrakenFrameworkSpecification §3.2).
 *
 * The chunk must carry a known `type` discriminant (`text_delta`,
 * `reasoning_delta`, `reasoning_done`, `structured_delta`,
 * `structured_done`, `tool_call_start`, `tool_call_args_delta`,
 * `tool_call_done`, `provider_tool_result`, `finish`, or `error`) and its
 * variant payload is checked against that variant's exact key allowlist:
 * identifiers (`providerCallId`, `name`) must be non-empty strings, deltas
 * must be strings, `input`/`result`/`data` must be present and
 * JSON-serializable, `finishReason` must come from the canonical set, and
 * `usage`/`providerMetadata` are optional. Never throws; probe failures
 * collapse to `false`.
 *
 * @see {@link assertProviderStreamChunk} for the throwing variant.
 */
export const isProviderStreamChunk = (
  value: unknown
): value is ProviderStreamChunk =>
  safePredicate(() => {
    if (
      !(
        isPlainObject(value) &&
        isStringProperty(value, "type") &&
        PROVIDER_STREAM_CHUNK_TYPES.has(value.type)
      )
    ) {
      return false;
    }

    switch (value.type) {
      case "text_delta": {
        return isProviderTextDelta(value);
      }
      case "reasoning_delta": {
        return isProviderReasoningDelta(value);
      }
      case "reasoning_done": {
        return hasOnlyAllowedKeys(value, PROVIDER_REASONING_DONE_KEYS);
      }
      case "structured_delta": {
        return isProviderStructuredDelta(value);
      }
      case "structured_done": {
        return isProviderStructuredDone(value);
      }
      case "tool_call_start": {
        return isProviderToolCallStart(value);
      }
      case "tool_call_args_delta": {
        return isProviderToolCallArgsDelta(value);
      }
      case "tool_call_done": {
        return isProviderToolCallDone(value);
      }
      case "provider_tool_result": {
        return isProviderToolResult(value);
      }
      case "finish": {
        return isProviderFinish(value);
      }
      case "error": {
        return (
          hasOnlyAllowedKeys(value, PROVIDER_ERROR_KEYS) && "error" in value
        );
      }
      default: {
        return false;
      }
    }
  });

/**
 * Asserts that `value` is a valid {@link ProviderStreamChunk}.
 *
 * @param value - Untrusted candidate chunk from a provider adapter.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws {TuvrenValidationError} With code `invalid_provider_stream_chunk`
 *   when {@link isProviderStreamChunk} rejects the value.
 */
export const assertProviderStreamChunk: (
  value: unknown,
  label?: string
) => asserts value is ProviderStreamChunk = (
  value: unknown,
  label = "value"
): asserts value is ProviderStreamChunk => {
  if (!isProviderStreamChunk(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ProviderStreamChunk`,
      { code: "invalid_provider_stream_chunk", details: value }
    );
  }
};
