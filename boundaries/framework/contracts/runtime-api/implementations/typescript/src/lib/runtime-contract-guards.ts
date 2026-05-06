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

import type { EpochMs } from "@tuvren/core-types";
import { isHashString, TuvrenValidationError } from "@tuvren/core-types";
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
  "approval.requested",
  "approval.resolved",
  "steering.incorporated",
  "state.snapshot",
  "state.checkpoint",
  "error",
  "custom",
]);
const TURN_END_STATUSES = new Set(["completed", "paused", "failed"]);
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
  "inputSchema",
  "metadata",
  "name",
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
const TUVREN_MODEL_RESPONSE_KEYS = new Set([
  "finishReason",
  "parts",
  "providerMetadata",
  "usage",
]);

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
      isOptionalProviderUsage(value, "usage") &&
      isOptionalSerializableRecordProperty(value, "providerMetadata")
  );
}

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
        ["callId", "name", "input"],
        () =>
          isNonEmptyStringProperty(value, "callId") &&
          isNonEmptyStringProperty(value, "name") &&
          "input" in value &&
          isSerializableContractValue(value.input)
      );
    case "tool.result":
      return matchesStreamEventVariant(
        value,
        ["callId", "name", "output", "isError"],
        () =>
          isNonEmptyStringProperty(value, "callId") &&
          isNonEmptyStringProperty(value, "name") &&
          "output" in value &&
          isSerializableContractValue(value.output) &&
          isOptionalBooleanProperty(value, "isError")
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
      isOptionalSerializableRecordProperty(value, "metadata") &&
      isOptionalTimeoutProperty(value, "timeout")
  );
}

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

function isOptionalApprovalRequest<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isApprovalRequest(value[key]);
}

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
