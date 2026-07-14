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

import type { EpochMs } from "./kernel-records.js";
import { isHashString } from "./kernel-records.js";
import {
  hasDistinctApprovalRequestCallIds,
  isApprovalDecision,
  isContentPart,
  isPendingToolCall,
  isToolResultPart,
} from "./runtime-content-approval-predicates.js";
import {
  isContextManifest,
  isOptionalContextManifestProperty,
} from "./runtime-context-manifest-predicates.js";
import {
  hasApprovalDecisionCoverage,
  hasCanonicalEpochMsTimestampAndValidSource,
  hasOnlyAllowedKeys,
  hasUniqueApprovalDecisionCallIds,
  isKrakenToolSchema,
  isNonEmptyArray,
  isNonEmptyStringProperty,
  isNonNegativeSafeIntegerProperty,
  isOptionalApprovalPolicy,
  isOptionalBooleanProperty,
  isOptionalHashStringProperty,
  isOptionalNonEmptyStringProperty,
  isOptionalProviderUsage,
  isOptionalSerializableRecordProperty,
  isOptionalStringProperty,
  isOptionalTimeoutProperty,
  isPlainObject,
  isSerializableContractValue,
  isStringProperty,
  isTuvrenErrorProjection,
  matchesStreamEventVariant,
  safePredicate,
} from "./runtime-contract-predicates.js";
import type {
  ApprovalRequest,
  ApprovalResponse,
  ContextManifest,
  ExecutionStatus,
  ProviderStreamChunk,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
} from "./runtime-contract-shapes.js";
import { TuvrenValidationError } from "./tuvren-error.js";

const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);
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
const FINISH_REASONS = new Set([
  "stop",
  "tool_call",
  "length",
  "error",
  "content_filter",
]);
const STREAM_EVENT_TYPES = new Set([
  "turn.start",
  "turn.end",
  "iteration.start",
  "iteration.end",
  "message.start",
  "text.delta",
  "text.done",
  "reasoning.delta",
  "reasoning.done",
  "file.done",
  "structured.delta",
  "structured.done",
  "tool_call.start",
  "tool_call.args_delta",
  "tool_call.done",
  "message.done",
  "tool.start",
  "tool.result",
  "tool.audit",
  "approval.requested",
  "approval.resolved",
  "steering.incorporated",
  "state.snapshot",
  "state.checkpoint",
  "error",
  "custom",
]);
const TURN_END_STATUSES = new Set(["completed", "paused", "failed"]);
const TOOL_AUDIT_LIFECYCLES = new Set([
  "input_validated",
  "output_validated",
  "policy_denied",
  "retry_attempt",
  "rate_limited",
  "cancelled",
]);
const EXECUTION_PHASES = new Set(["running", "paused", "completed", "failed"]);
const SYSTEM_MESSAGE_KEYS = new Set(["role", "content"]);
const USER_MESSAGE_KEYS = new Set(["role", "parts"]);
const ASSISTANT_MESSAGE_KEYS = new Set(["role", "parts", "providerMetadata"]);
const TOOL_MESSAGE_KEYS = new Set(["role", "parts"]);
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
const TOOL_DEFINITION_KEYS = new Set([
  "approval",
  "description",
  "execute",
  "idempotent",
  "inputSchema",
  "maxRetries",
  "metadata",
  "name",
  "nonRetryable",
  "outputSchema",
  "requiredCredentialScopes",
  "requiredResidency",
  "requiresUserPresence",
  "riskClass",
  "timeout",
]);
const EXECUTION_STATUS_KEYS = new Set([
  "phase",
  "iterationCount",
  "activeAgent",
  "approval",
  "manifest",
  "pauseReason",
]);
const APPROVAL_REQUEST_KEYS = new Set(["toolCalls", "completedResults"]);
const APPROVAL_RESPONSE_KEYS = new Set(["decisions"]);
const CAPABILITY_EXECUTION_CLASSES = new Set([
  "provider-native",
  "provider-mediated",
  "tuvren-server",
  "tuvren-client",
]);
const CAPABILITY_INVOCATION_OWNERS = new Set(["provider", "tuvren"]);
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
 * True when `parent.attribution` is absent or is a valid capability
 * attribution record: non-empty `capabilityId`, a known `executionClass`
 * (`provider-native` | `provider-mediated` | `tuvren-server` |
 * `tuvren-client`), a known `owner` (`provider` | `tuvren`), and a plain
 * `observation` object. Additive optional field per ADR-046 AW006.
 */
function isOptionalCapabilityAttribution(
  parent: Record<string, unknown>
): boolean {
  if (!("attribution" in parent) || parent.attribution === undefined) {
    return true;
  }
  if (!isPlainObject(parent.attribution)) {
    return false;
  }
  const attr = parent.attribution as Record<string, unknown>;
  return (
    typeof attr.capabilityId === "string" &&
    attr.capabilityId.length > 0 &&
    typeof attr.executionClass === "string" &&
    CAPABILITY_EXECUTION_CLASSES.has(attr.executionClass) &&
    typeof attr.owner === "string" &&
    CAPABILITY_INVOCATION_OWNERS.has(attr.owner) &&
    isPlainObject(attr.observation)
  );
}

/**
 * True when `value` is a valid `ProviderNativeInvocationRecord`: exact key
 * allowlist, non-empty `callId`/`name`/`providerCallId`, an
 * `executionClass` of `provider-native` or `provider-mediated`, a present
 * `result` field, optional boolean `isError`, and optional serializable
 * `providerMetadata`.
 */
function isProviderNativeInvocationRecord(value: unknown): boolean {
  return safePredicate(
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
}

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
export function isTuvrenModelResponse(
  value: unknown
): value is TuvrenModelResponse {
  return safePredicate(
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
}

/**
 * Asserts that `value` is a valid {@link TuvrenModelResponse}.
 *
 * @param value - Untrusted candidate model response.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_model_response` when
 *   {@link isTuvrenModelResponse} rejects the value.
 */
export function assertTuvrenModelResponse(
  value: unknown,
  label = "value"
): asserts value is TuvrenModelResponse {
  if (!isTuvrenModelResponse(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid TuvrenModelResponse`,
      { code: "invalid_model_response", details: value }
    );
  }
}

/**
 * Returns `true` when `value` is a structurally valid {@link TuvrenMessage}
 * (KrakenFrameworkSpecification §1.2).
 *
 * Validates per-role, each against its exact key set:
 * - `system`: a non-empty `content` string; `parts` and `providerMetadata`
 *   are forbidden.
 * - `user`: a non-empty `parts` array of valid content parts.
 * - `assistant`: a non-empty `parts` array of valid content parts, plus an
 *   optional serializable `providerMetadata` record.
 * - `tool`: a non-empty `parts` array in which every part is a
 *   `tool_result` part.
 *
 * Never throws; probe failures collapse to `false`.
 *
 * @see {@link assertTuvrenMessage} for the throwing variant.
 */
export function isTuvrenMessage(value: unknown): value is TuvrenMessage {
  return safePredicate(() => {
    if (!isPlainObject(value)) {
      return false;
    }

    if (!(isStringProperty(value, "role") && MESSAGE_ROLES.has(value.role))) {
      return false;
    }

    switch (value.role) {
      case "system":
        return (
          hasOnlyAllowedKeys(value, SYSTEM_MESSAGE_KEYS) &&
          isNonEmptyStringProperty(value, "content") &&
          !("parts" in value) &&
          !("providerMetadata" in value)
        );
      case "user":
        return (
          hasOnlyAllowedKeys(value, USER_MESSAGE_KEYS) &&
          isNonEmptyArray(value.parts) &&
          value.parts.every(isContentPart)
        );
      case "assistant":
        return (
          hasOnlyAllowedKeys(value, ASSISTANT_MESSAGE_KEYS) &&
          isNonEmptyArray(value.parts) &&
          value.parts.every(isContentPart) &&
          isOptionalSerializableRecordProperty(value, "providerMetadata")
        );
      case "tool":
        return (
          hasOnlyAllowedKeys(value, TOOL_MESSAGE_KEYS) &&
          isNonEmptyArray(value.parts) &&
          value.parts.every(isToolResultPart)
        );
      default:
        return false;
    }
  });
}

/**
 * Asserts that `value` is a valid {@link TuvrenMessage}.
 *
 * @param value - Untrusted candidate message.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_tuvren_message` when
 *   {@link isTuvrenMessage} rejects the value.
 */
export function assertTuvrenMessage(
  value: unknown,
  label = "value"
): asserts value is TuvrenMessage {
  if (!isTuvrenMessage(value)) {
    throw new TuvrenValidationError(`${label} must be a valid TuvrenMessage`, {
      code: "invalid_tuvren_message",
      details: value,
    });
  }
}

/**
 * Returns `true` when `value` is a structurally valid {@link ApprovalRequest}
 * (KrakenFrameworkSpecification §1.7).
 *
 * Requires exactly the keys `toolCalls` and `completedResults`, with
 * `toolCalls` a non-empty array of valid pending tool calls and
 * `completedResults` an array (possibly empty) of valid `tool_result`
 * parts. Every `callId` must be distinct across `toolCalls` and
 * `completedResults` combined, so each decision can be linked to exactly
 * one call. Never throws; probe failures collapse to `false`.
 *
 * @see {@link assertApprovalRequest} for the throwing variant.
 */
export function isApprovalRequest(value: unknown): value is ApprovalRequest {
  return safePredicate(() => {
    if (
      !(
        isPlainObject(value) &&
        hasOnlyAllowedKeys(value, APPROVAL_REQUEST_KEYS) &&
        Array.isArray(value.toolCalls) &&
        value.toolCalls.length > 0 &&
        value.toolCalls.every(isPendingToolCall) &&
        Array.isArray(value.completedResults) &&
        value.completedResults.every(isToolResultPart)
      )
    ) {
      return false;
    }

    return hasDistinctApprovalRequestCallIds(
      value.toolCalls,
      value.completedResults
    );
  });
}

/**
 * Asserts that `value` is a valid {@link ApprovalRequest}.
 *
 * @param value - Untrusted candidate approval request.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_approval_request` when
 *   {@link isApprovalRequest} rejects the value.
 */
export function assertApprovalRequest(
  value: unknown,
  label = "value"
): asserts value is ApprovalRequest {
  if (!isApprovalRequest(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ApprovalRequest`,
      { code: "invalid_approval_request", details: value }
    );
  }
}

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
export function isProviderStreamChunk(
  value: unknown
): value is ProviderStreamChunk {
  return safePredicate(() => {
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
      case "text_delta":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_TEXT_DELTA_KEYS) &&
          typeof value.text === "string"
        );
      case "reasoning_delta":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_REASONING_DELTA_KEYS) &&
          typeof value.text === "string" &&
          isOptionalStringProperty(value, "signature")
        );
      case "reasoning_done":
        return hasOnlyAllowedKeys(value, PROVIDER_REASONING_DONE_KEYS);
      case "structured_delta":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_STRUCTURED_DELTA_KEYS) &&
          typeof value.delta === "string"
        );
      case "structured_done":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_STRUCTURED_DONE_KEYS) &&
          "data" in value &&
          isSerializableContractValue(value.data) &&
          isOptionalStringProperty(value, "name")
        );
      case "tool_call_start":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_TOOL_CALL_START_KEYS) &&
          isNonEmptyStringProperty(value, "providerCallId") &&
          isNonEmptyStringProperty(value, "name")
        );
      case "tool_call_args_delta":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_TOOL_CALL_ARGS_DELTA_KEYS) &&
          isNonEmptyStringProperty(value, "providerCallId") &&
          typeof value.delta === "string"
        );
      case "tool_call_done":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_TOOL_CALL_DONE_KEYS) &&
          isNonEmptyStringProperty(value, "providerCallId") &&
          isNonEmptyStringProperty(value, "name") &&
          "input" in value &&
          isSerializableContractValue(value.input) &&
          isOptionalSerializableRecordProperty(value, "providerMetadata")
        );
      case "provider_tool_result":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_TOOL_RESULT_KEYS) &&
          isNonEmptyStringProperty(value, "providerCallId") &&
          isNonEmptyStringProperty(value, "name") &&
          "result" in value &&
          isSerializableContractValue(value.result) &&
          (value.isError === undefined || typeof value.isError === "boolean") &&
          isOptionalSerializableRecordProperty(value, "providerMetadata")
        );
      case "finish":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_FINISH_KEYS) &&
          isStringProperty(value, "finishReason") &&
          FINISH_REASONS.has(value.finishReason) &&
          isOptionalProviderUsage(value, "usage") &&
          isOptionalSerializableRecordProperty(value, "providerMetadata")
        );
      case "error":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_ERROR_KEYS) && "error" in value
        );
      default:
        return false;
    }
  });
}

/**
 * Asserts that `value` is a valid {@link ProviderStreamChunk}.
 *
 * @param value - Untrusted candidate chunk from a provider adapter.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_provider_stream_chunk`
 *   when {@link isProviderStreamChunk} rejects the value.
 */
export function assertProviderStreamChunk(
  value: unknown,
  label = "value"
): asserts value is ProviderStreamChunk {
  if (!isProviderStreamChunk(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ProviderStreamChunk`,
      { code: "invalid_provider_stream_chunk", details: value }
    );
  }
}

/**
 * Returns `true` when `value` is a structurally valid
 * {@link TuvrenStreamEvent} (KrakenFrameworkSpecification §1.8).
 *
 * Three layers are checked:
 * 1. The `type` discriminant must belong to the canonical event vocabulary
 *    (`turn.*`, `iteration.*`, `message.*`, `text.*`, `reasoning.*`,
 *    `file.done`, `structured.*`, `tool_call.*`, `tool.*`, `approval.*`,
 *    `steering.incorporated`, `state.*`, `error`, `custom`).
 * 2. The envelope must carry a canonical `EpochMs` `timestamp` and, when
 *    present, a valid `source` attribution record.
 * 3. The variant payload must match that event type's exact key set and
 *    field predicates (non-empty identifiers, canonical `finishReason` and
 *    status enums, serializable `input`/`output`/`data`, valid nested
 *    approval request/response, manifest, or error projection, and the
 *    additive optional `attribution` on `tool.start`/`tool.result` per
 *    ADR-046 AW006).
 *
 * Never throws; probe failures collapse to `false`.
 *
 * @see {@link assertTuvrenStreamEvent} for the throwing variant.
 */
export function isTuvrenStreamEvent(
  value: unknown
): value is TuvrenStreamEvent {
  return safePredicate(() => {
    if (
      !(
        isPlainObject(value) &&
        isStringProperty(value, "type") &&
        STREAM_EVENT_TYPES.has(value.type)
      )
    ) {
      return false;
    }

    if (!hasCanonicalEpochMsTimestampAndValidSource(value)) {
      return false;
    }

    return hasValidStreamEventPayload(value);
  });
}

/**
 * Dispatches on the event `type` and validates the variant payload against
 * its exact key set (plus the shared `type`/`timestamp`/`source` envelope
 * keys) and per-field predicates.
 */
function hasValidStreamEventPayload(
  value: Record<string, unknown> & { timestamp: EpochMs; type: string }
): boolean {
  switch (value.type) {
    case "turn.start":
      return matchesStreamEventVariant(
        value,
        ["turnId", "threadId", "resumedFrom"],
        () =>
          isNonEmptyStringProperty(value, "turnId") &&
          isNonEmptyStringProperty(value, "threadId") &&
          isOptionalHashStringProperty(value, "resumedFrom")
      );
    case "turn.end":
      return matchesStreamEventVariant(
        value,
        ["turnId", "status"],
        () =>
          isNonEmptyStringProperty(value, "turnId") &&
          isStringProperty(value, "status") &&
          TURN_END_STATUSES.has(value.status)
      );
    case "iteration.start":
    case "iteration.end":
      return matchesStreamEventVariant(value, ["iterationCount"], () =>
        isNonNegativeSafeIntegerProperty(value, "iterationCount")
      );
    case "message.start":
      return matchesStreamEventVariant(
        value,
        ["messageId", "role"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          value.role === "assistant"
      );
    case "text.delta":
      return matchesStreamEventVariant(
        value,
        ["messageId", "delta"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          typeof value.delta === "string"
      );
    case "text.done":
      return matchesStreamEventVariant(
        value,
        ["messageId", "text"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          typeof value.text === "string"
      );
    case "reasoning.delta":
      return matchesStreamEventVariant(
        value,
        ["messageId", "delta"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          typeof value.delta === "string"
      );
    case "reasoning.done":
      return matchesStreamEventVariant(value, ["messageId"], () =>
        isNonEmptyStringProperty(value, "messageId")
      );
    case "file.done":
      return matchesStreamEventVariant(
        value,
        ["messageId", "data", "filename", "mediaType"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          "data" in value &&
          (typeof value.data === "string" ||
            value.data instanceof Uint8Array) &&
          isOptionalStringProperty(value, "filename") &&
          isNonEmptyStringProperty(value, "mediaType")
      );
    case "structured.delta":
      return matchesStreamEventVariant(
        value,
        ["messageId", "delta"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          typeof value.delta === "string"
      );
    case "structured.done":
      return matchesStreamEventVariant(
        value,
        ["messageId", "data", "name"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          "data" in value &&
          isSerializableContractValue(value.data) &&
          isOptionalStringProperty(value, "name")
      );
    case "tool_call.start":
      return matchesStreamEventVariant(
        value,
        ["messageId", "callId", "name"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          isNonEmptyStringProperty(value, "callId") &&
          isNonEmptyStringProperty(value, "name")
      );
    case "tool_call.args_delta":
      return matchesStreamEventVariant(
        value,
        ["callId", "delta"],
        () =>
          isNonEmptyStringProperty(value, "callId") &&
          typeof value.delta === "string"
      );
    case "tool_call.done":
      return matchesStreamEventVariant(
        value,
        ["callId", "name", "input", "providerMetadata"],
        () =>
          isNonEmptyStringProperty(value, "callId") &&
          isNonEmptyStringProperty(value, "name") &&
          "input" in value &&
          isSerializableContractValue(value.input) &&
          isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    case "message.done":
      return matchesStreamEventVariant(
        value,
        ["messageId", "finishReason", "usage"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          isStringProperty(value, "finishReason") &&
          FINISH_REASONS.has(value.finishReason) &&
          isOptionalProviderUsage(value, "usage")
      );
    case "tool.start":
      return matchesStreamEventVariant(
        value,
        // "attribution" is an additive optional field per ADR-046 AW006
        ["callId", "name", "input", "attribution"],
        () =>
          isNonEmptyStringProperty(value, "callId") &&
          isNonEmptyStringProperty(value, "name") &&
          "input" in value &&
          isSerializableContractValue(value.input) &&
          isOptionalCapabilityAttribution(value)
      );
    case "tool.result":
      return matchesStreamEventVariant(
        value,
        // "attribution" is an additive optional field per ADR-046 AW006
        ["callId", "name", "output", "isError", "attribution"],
        () =>
          isNonEmptyStringProperty(value, "callId") &&
          isNonEmptyStringProperty(value, "name") &&
          "output" in value &&
          isSerializableContractValue(value.output) &&
          isOptionalBooleanProperty(value, "isError") &&
          isOptionalCapabilityAttribution(value)
      );
    case "tool.audit":
      return matchesStreamEventVariant(
        value,
        [
          "callId",
          "capabilityId",
          "executionClass",
          "lifecycle",
          "runId",
          "turnId",
          "attempt",
          "validationPassed",
        ],
        () =>
          isNonEmptyStringProperty(value, "callId") &&
          isNonEmptyStringProperty(value, "capabilityId") &&
          isNonEmptyStringProperty(value, "executionClass") &&
          isNonEmptyStringProperty(value, "lifecycle") &&
          TOOL_AUDIT_LIFECYCLES.has(value.lifecycle as string) &&
          isNonEmptyStringProperty(value, "runId") &&
          isNonEmptyStringProperty(value, "turnId") &&
          (value.attempt === undefined || typeof value.attempt === "number") &&
          (value.validationPassed === undefined ||
            typeof value.validationPassed === "boolean")
      );
    case "approval.requested":
      return matchesStreamEventVariant(value, ["request"], () =>
        isApprovalRequest(value.request)
      );
    case "approval.resolved":
      return matchesStreamEventVariant(value, ["response"], () =>
        isApprovalResponse(value.response)
      );
    case "steering.incorporated":
      return matchesStreamEventVariant(value, ["messageId"], () =>
        isNonEmptyStringProperty(value, "messageId")
      );
    case "state.snapshot":
      return matchesStreamEventVariant(value, ["manifest"], () =>
        isContextManifest(value.manifest)
      );
    case "state.checkpoint":
      return matchesStreamEventVariant(
        value,
        ["iterationCount", "turnNodeHash"],
        () =>
          isNonNegativeSafeIntegerProperty(value, "iterationCount") &&
          isHashString(value.turnNodeHash)
      );
    case "error":
      return matchesStreamEventVariant(
        value,
        ["error", "fatal"],
        () =>
          isTuvrenErrorProjection(value.error) &&
          typeof value.fatal === "boolean"
      );
    case "custom":
      return matchesStreamEventVariant(
        value,
        ["name", "data"],
        () =>
          isNonEmptyStringProperty(value, "name") &&
          "data" in value &&
          isSerializableContractValue(value.data)
      );
    default:
      return false;
  }
}

/**
 * Asserts that `value` is a valid {@link TuvrenStreamEvent}.
 *
 * @param value - Untrusted candidate stream event.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_stream_event` when
 *   {@link isTuvrenStreamEvent} rejects the value.
 */
export function assertTuvrenStreamEvent(
  value: unknown,
  label = "value"
): asserts value is TuvrenStreamEvent {
  if (!isTuvrenStreamEvent(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid TuvrenStreamEvent`,
      { code: "invalid_stream_event", details: value }
    );
  }
}

/**
 * Returns `true` when `value` is a structurally valid
 * {@link TuvrenToolDefinition} (KrakenFrameworkSpecification §8.1).
 *
 * Requires an exact key allowlist, a non-empty `name`, a string
 * `description`, an `execute` function, and an `inputSchema` that is either
 * a structurally valid JSON Schema or an executable `CustomSchema`
 * (`toJSONSchema`/`validate`). Optional policy fields are shape-checked
 * when present: `approval` (boolean or function), `idempotent`,
 * `nonRetryable`, `requiresUserPresence` (booleans), `maxRetries` (number),
 * `metadata` (serializable record), `outputSchema` (schema),
 * `requiredCredentialScopes` (string array), `requiredResidency` (string),
 * `riskClass` (`low` | `medium` | `high`), and `timeout` (non-negative
 * finite milliseconds). Never throws; probe failures collapse to `false`.
 *
 * @see {@link assertTuvrenToolDefinition} for the throwing variant.
 */
export function isTuvrenToolDefinition(
  value: unknown
): value is TuvrenToolDefinition {
  return safePredicate(
    () =>
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, TOOL_DEFINITION_KEYS) &&
      isNonEmptyStringProperty(value, "name") &&
      typeof value.description === "string" &&
      typeof value.execute === "function" &&
      isKrakenToolSchema(value.inputSchema) &&
      isOptionalApprovalPolicy(value, "approval") &&
      (value.idempotent === undefined ||
        typeof value.idempotent === "boolean") &&
      (value.maxRetries === undefined ||
        typeof value.maxRetries === "number") &&
      isOptionalSerializableRecordProperty(value, "metadata") &&
      (value.nonRetryable === undefined ||
        typeof value.nonRetryable === "boolean") &&
      (value.outputSchema === undefined ||
        isKrakenToolSchema(value.outputSchema)) &&
      (value.requiredCredentialScopes === undefined ||
        (Array.isArray(value.requiredCredentialScopes) &&
          value.requiredCredentialScopes.every(
            (s) => typeof s === "string"
          ))) &&
      (value.requiredResidency === undefined ||
        typeof value.requiredResidency === "string") &&
      (value.requiresUserPresence === undefined ||
        typeof value.requiresUserPresence === "boolean") &&
      (value.riskClass === undefined ||
        value.riskClass === "low" ||
        value.riskClass === "medium" ||
        value.riskClass === "high") &&
      isOptionalTimeoutProperty(value, "timeout")
  );
}

/**
 * Asserts that `value` is a valid {@link TuvrenToolDefinition}.
 *
 * @param value - Untrusted candidate tool definition.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_tool_definition` when
 *   {@link isTuvrenToolDefinition} rejects the value.
 */
export function assertTuvrenToolDefinition(
  value: unknown,
  label = "value"
): asserts value is TuvrenToolDefinition {
  if (!isTuvrenToolDefinition(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid TuvrenToolDefinition`,
      { code: "invalid_tool_definition", details: value }
    );
  }
}

/**
 * Returns `true` when `value` is a structurally valid {@link ExecutionStatus}
 * (KrakenFrameworkSpecification §7.1).
 *
 * Beyond the exact key allowlist (`phase`, `iterationCount`, `activeAgent`,
 * `approval`, `manifest`, `pauseReason`), a canonical `phase`
 * (`running` | `paused` | `completed` | `failed`), a non-negative safe
 * integer `iterationCount`, and shape checks on the optional fields, it
 * enforces the pause coupling invariant: `approval` and `pauseReason` may
 * only be present when `phase === "paused"`, and a paused status must carry
 * both. Never throws; probe failures collapse to `false`.
 *
 * @see {@link assertExecutionStatus} for the throwing variant.
 */
export function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return safePredicate(() => {
    if (
      !(
        isPlainObject(value) &&
        hasOnlyAllowedKeys(value, EXECUTION_STATUS_KEYS) &&
        isStringProperty(value, "phase") &&
        EXECUTION_PHASES.has(value.phase) &&
        isNonNegativeSafeIntegerProperty(value, "iterationCount") &&
        isOptionalApprovalRequest(value, "approval") &&
        isOptionalNonEmptyStringProperty(value, "activeAgent") &&
        isOptionalContextManifestProperty(value, "manifest") &&
        isOptionalNonEmptyStringProperty(value, "pauseReason")
      )
    ) {
      return false;
    }

    if (value.approval !== undefined && value.phase !== "paused") {
      return false;
    }

    if (value.pauseReason !== undefined && value.phase !== "paused") {
      return false;
    }

    if (
      value.phase === "paused" &&
      (value.approval === undefined || value.pauseReason === undefined)
    ) {
      return false;
    }

    return true;
  });
}

/**
 * Asserts that `value` is a valid {@link ExecutionStatus}.
 *
 * @param value - Untrusted candidate execution status.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_execution_status` when
 *   {@link isExecutionStatus} rejects the value.
 */
export function assertExecutionStatus(
  value: unknown,
  label = "value"
): asserts value is ExecutionStatus {
  if (!isExecutionStatus(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ExecutionStatus`,
      { code: "invalid_execution_status", details: value }
    );
  }
}

/**
 * Returns `true` when `value` is a structurally valid
 * {@link ApprovalResponse} (KrakenFrameworkSpecification §1.7).
 *
 * Requires exactly the key `decisions`, holding a non-empty array of valid
 * approval decisions with unique `callId`s. This check is
 * request-independent; use {@link isApprovalResponseForRequest} to also
 * verify coverage against the pending {@link ApprovalRequest}. Never
 * throws; probe failures collapse to `false`.
 */
export function isApprovalResponse(value: unknown): value is ApprovalResponse {
  return safePredicate(
    () =>
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, APPROVAL_RESPONSE_KEYS) &&
      Array.isArray(value.decisions) &&
      value.decisions.length > 0 &&
      value.decisions.every(isApprovalDecision) &&
      hasUniqueApprovalDecisionCallIds(value.decisions)
  );
}

/**
 * Returns `true` when `value` is a valid {@link ApprovalResponse} that fully
 * answers `request` (KrakenFrameworkSpecification §1.7).
 *
 * In addition to {@link isApprovalResponse}, it enforces decision coverage:
 * there must be exactly one decision per pending tool call, every decision
 * `callId` must match a pending call in the request, and each decision
 * `type` must be one of the decision options that pending call offered.
 *
 * @param value - Untrusted candidate response.
 * @param request - The active approval request the response must cover.
 */
export function isApprovalResponseForRequest(
  value: unknown,
  request: ApprovalRequest
): value is ApprovalResponse {
  return safePredicate(
    () =>
      isApprovalResponse(value) &&
      hasApprovalDecisionCoverage(value.decisions, request.toolCalls)
  );
}

/**
 * Asserts that `value` is a valid {@link ApprovalResponse}.
 *
 * @param value - Untrusted candidate approval response.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_approval_response` when
 *   {@link isApprovalResponse} rejects the value.
 */
export function assertApprovalResponse(
  value: unknown,
  label = "value"
): asserts value is ApprovalResponse {
  if (!isApprovalResponse(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ApprovalResponse`,
      { code: "invalid_approval_response", details: value }
    );
  }
}

/**
 * Asserts that `value` is a valid {@link ApprovalResponse} that fully covers
 * the pending tool calls of `request`.
 *
 * @param value - Untrusted candidate approval response.
 * @param request - The active approval request the response must cover.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_approval_response` when
 *   {@link isApprovalResponseForRequest} rejects the value.
 */
export function assertApprovalResponseForRequest(
  value: unknown,
  request: ApprovalRequest,
  label = "value"
): asserts value is ApprovalResponse {
  if (!isApprovalResponseForRequest(value, request)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ApprovalResponse for the active approval request`,
      { code: "invalid_approval_response", details: value }
    );
  }
}

/** True when `value[key]` is `undefined` or a valid {@link ApprovalRequest}. */
function isOptionalApprovalRequest<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isApprovalRequest(value[key]);
}

/**
 * Asserts that `value` is a valid {@link ContextManifest}
 * (KrakenFrameworkSpecification §1.6).
 *
 * Delegates to `isContextManifest`, which checks the exact key set, the
 * role/name counters, and the internal consistency invariants between
 * counters, last-role indexes, and turn boundaries.
 *
 * @param value - Untrusted candidate manifest.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_context_manifest` when
 *   the value is not a valid manifest.
 */
export function assertContextManifest(
  value: unknown,
  label = "value"
): asserts value is ContextManifest {
  if (!isContextManifest(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ContextManifest`,
      { code: "invalid_context_manifest", details: value }
    );
  }
}
