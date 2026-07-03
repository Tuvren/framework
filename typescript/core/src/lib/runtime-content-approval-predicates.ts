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

import {
  hasOnlyAllowedKeys,
  hasUniqueStrings,
  isNonEmptyStringProperty,
  isNonEmptyStringValue,
  isOptionalBooleanProperty,
  isOptionalNonEmptyStringProperty,
  isOptionalSerializableRecordProperty,
  isOptionalStringProperty,
  isPlainObject,
  isSerializableContractValue,
  isStringProperty,
} from "./runtime-contract-predicates.js";
import type {
  ApprovalDecision,
  ContentPart,
  PendingToolCall,
  ToolResultPart,
} from "./runtime-contract-shapes.js";

const CONTENT_PART_TYPES = new Set([
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "file",
  "structured",
]);
const TEXT_PART_KEYS = new Set(["type", "text", "providerMetadata"]);
const REASONING_PART_KEYS = new Set([
  "type",
  "text",
  "redacted",
  "providerMetadata",
]);
const TOOL_CALL_PART_KEYS = new Set([
  "type",
  "callId",
  "name",
  "input",
  "providerMetadata",
]);
const TOOL_RESULT_PART_KEYS = new Set([
  "type",
  "callId",
  "name",
  "output",
  "isError",
  "providerMetadata",
]);
const FILE_PART_KEYS = new Set([
  "type",
  "data",
  "mediaType",
  "filename",
  "providerMetadata",
]);
const STRUCTURED_PART_KEYS = new Set([
  "type",
  "data",
  "name",
  "providerMetadata",
]);
const PENDING_TOOL_CALL_KEYS = new Set([
  "callId",
  "decisions",
  "input",
  "message",
  "name",
]);
const APPROVAL_DECISION_KEYS = new Set([
  "callId",
  "type",
  "editedInput",
  "message",
]);

export function isContentPart(value: unknown): value is ContentPart {
  if (
    !(
      isPlainObject(value) &&
      isStringProperty(value, "type") &&
      CONTENT_PART_TYPES.has(value.type)
    )
  ) {
    return false;
  }

  switch (value.type) {
    case "text":
      return (
        hasOnlyAllowedKeys(value, TEXT_PART_KEYS) &&
        typeof value.text === "string" &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    case "reasoning":
      return (
        hasOnlyAllowedKeys(value, REASONING_PART_KEYS) &&
        typeof value.text === "string" &&
        typeof value.redacted === "boolean" &&
        (value.redacted || value.text.length > 0) &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    case "tool_call":
      return (
        hasOnlyAllowedKeys(value, TOOL_CALL_PART_KEYS) &&
        isNonEmptyStringProperty(value, "callId") &&
        isNonEmptyStringProperty(value, "name") &&
        "input" in value &&
        isSerializableContractValue(value.input) &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    case "tool_result":
      return (
        hasOnlyAllowedKeys(value, TOOL_RESULT_PART_KEYS) &&
        isNonEmptyStringProperty(value, "callId") &&
        isNonEmptyStringProperty(value, "name") &&
        "output" in value &&
        isSerializableContractValue(value.output) &&
        isOptionalBooleanProperty(value, "isError") &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    case "file":
      return (
        hasOnlyAllowedKeys(value, FILE_PART_KEYS) &&
        (typeof value.data === "string" || value.data instanceof Uint8Array) &&
        isNonEmptyStringProperty(value, "mediaType") &&
        isOptionalStringProperty(value, "filename") &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    case "structured":
      return (
        hasOnlyAllowedKeys(value, STRUCTURED_PART_KEYS) &&
        "data" in value &&
        isSerializableContractValue(value.data) &&
        isOptionalStringProperty(value, "name") &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    default:
      return false;
  }
}

export function isToolResultPart(value: unknown): value is ToolResultPart {
  return (
    isPlainObject(value) &&
    hasOnlyAllowedKeys(value, TOOL_RESULT_PART_KEYS) &&
    value.type === "tool_result" &&
    isNonEmptyStringProperty(value, "callId") &&
    isNonEmptyStringProperty(value, "name") &&
    "output" in value &&
    isSerializableContractValue(value.output) &&
    isOptionalBooleanProperty(value, "isError") &&
    isOptionalSerializableRecordProperty(value, "providerMetadata")
  );
}

export function isPendingToolCall(value: unknown): value is PendingToolCall {
  return (
    isPlainObject(value) &&
    hasOnlyAllowedKeys(value, PENDING_TOOL_CALL_KEYS) &&
    isNonEmptyStringProperty(value, "callId") &&
    isNonEmptyStringProperty(value, "name") &&
    isNonEmptyStringProperty(value, "message") &&
    "input" in value &&
    isSerializableContractValue(value.input) &&
    Array.isArray(value.decisions) &&
    value.decisions.length > 0 &&
    value.decisions.every(isNonEmptyStringValue) &&
    hasUniqueStrings(value.decisions)
  );
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  if (
    !(
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, APPROVAL_DECISION_KEYS) &&
      isNonEmptyStringProperty(value, "callId") &&
      isNonEmptyStringProperty(value, "type") &&
      isOptionalNonEmptyStringProperty(value, "message")
    )
  ) {
    return false;
  }

  if (value.type === "edit" && !("editedInput" in value)) {
    return false;
  }

  if (value.type !== "edit" && "editedInput" in value) {
    return false;
  }

  if (
    value.type === "edit" &&
    !isSerializableContractValue(value.editedInput)
  ) {
    return false;
  }

  // Approval notes are optional for all decision types, but if present they
  // should carry real explanatory text instead of an empty placeholder.
  return true;
}

export function hasDistinctApprovalRequestCallIds(
  toolCalls: PendingToolCall[],
  completedResults: ToolResultPart[]
): boolean {
  const seenCallIds = new Set<string>();

  for (const toolCall of toolCalls) {
    if (seenCallIds.has(toolCall.callId)) {
      return false;
    }

    seenCallIds.add(toolCall.callId);
  }

  for (const result of completedResults) {
    if (seenCallIds.has(result.callId)) {
      return false;
    }

    seenCallIds.add(result.callId);
  }

  return true;
}
