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

import { isEpochMs, isHashString } from "./kernel-records.js";
import type {
  ApprovalDecision,
  ApprovalPolicy,
  CustomSchema,
  EventSource,
  PendingToolCall,
  ProviderUsage,
  TuvrenErrorProjection,
  TuvrenJsonSchema,
  TuvrenJsonValue,
} from "./runtime-contract-shapes.js";

const EVENT_SOURCE_KEYS = new Set(["agent", "driver", "threadId", "workerId"]);
const PROVIDER_USAGE_KEYS = new Set(["inputTokens", "outputTokens"]);
const KRAKEN_ERROR_PROJECTION_KEYS = new Set(["message", "code", "details"]);
const JSON_SCHEMA_TYPE_NAMES = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);
const NON_NEGATIVE_INTEGER_SCHEMA_KEYWORDS = [
  "maxItems",
  "maxLength",
  "maxProperties",
  "maxContains",
  "minItems",
  "minLength",
  "minProperties",
  "minContains",
];
const FINITE_NUMBER_SCHEMA_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
];
const STRING_SCHEMA_KEYWORDS = [
  "$anchor",
  "$comment",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$ref",
  "$schema",
  "contentEncoding",
  "contentMediaType",
  "description",
  "format",
  "pattern",
  "title",
];
const BOOLEAN_SCHEMA_KEYWORDS = [
  "deprecated",
  "readOnly",
  "uniqueItems",
  "writeOnly",
];
const SCHEMA_KEYWORDS = [
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
];
const NON_EMPTY_SCHEMA_ARRAY_KEYWORDS = [
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
];
const SCHEMA_RECORD_KEYWORDS = [
  "$defs",
  "dependentSchemas",
  "patternProperties",
  "properties",
];

export function hasCanonicalEpochMsTimestampAndValidSource(
  value: Record<string, unknown>
): value is Record<string, unknown> & { timestamp: number } {
  if (!isEpochMs(value.timestamp)) {
    return false;
  }

  if (
    "source" in value &&
    value.source !== undefined &&
    !isEventSource(value.source)
  ) {
    return false;
  }

  return true;
}

export function isOptionalBooleanProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || typeof value[key] === "boolean";
}

export function isOptionalApprovalPolicy<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isApprovalPolicy(value[key]);
}

export function isOptionalHashStringProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isHashString(value[key]);
}

export function isOptionalSerializableRecordProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isSerializableRecord(value[key]);
}

export function isOptionalSerializableContractValueProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isSerializableContractValue(value[key]);
}

export function isOptionalProviderUsage<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isProviderUsage(value[key]);
}

export function isOptionalStringProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

export function isOptionalNonEmptyStringProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isNonEmptyStringProperty(value, key);
}

export function isNonEmptyStringProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return isNonEmptyStringValue(value[key]);
}

export function isNonEmptyStringValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isNonEmptyArray(
  value: unknown
): value is [unknown, ...unknown[]] {
  return Array.isArray(value) && value.length > 0;
}

export function isOptionalTimeoutProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isTimeoutMs(value[key]);
}

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return typeof value === "boolean" || typeof value === "function";
}

export function isNonNegativeFiniteNumberProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  const numericValue = value[key];
  return (
    typeof numericValue === "number" &&
    Number.isFinite(numericValue) &&
    numericValue >= 0
  );
}

export function isTuvrenJsonSchema(value: unknown): value is TuvrenJsonSchema {
  return (
    typeof value === "boolean" ||
    (isKrakenJsonObject(value, new WeakSet()) && isValidJsonSchemaObject(value))
  );
}

export function isSerializableContractValue(
  value: unknown
): value is TuvrenJsonValue {
  return isKrakenJsonValue(value, new WeakSet());
}

export function isSerializableRecord(
  value: unknown
): value is { [key: string]: TuvrenJsonValue } {
  return isKrakenJsonObject(value, new WeakSet());
}

export function isKrakenToolSchema(
  value: unknown
): value is TuvrenJsonSchema | CustomSchema {
  return isTuvrenJsonSchema(value) || isCustomSchema(value);
}

export function isProviderUsage(value: unknown): value is ProviderUsage {
  return (
    isPlainObject(value) &&
    hasOnlyAllowedKeys(value, PROVIDER_USAGE_KEYS) &&
    isNonNegativeSafeIntegerProperty(value, "inputTokens") &&
    isNonNegativeSafeIntegerProperty(value, "outputTokens")
  );
}

export function isTimeoutMs(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isNonNegativeSafeIntegerProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  const propertyValue = value[key];
  return (
    typeof propertyValue === "number" &&
    Number.isSafeInteger(propertyValue) &&
    propertyValue >= 0
  );
}

export function isMessageIndexValue(
  value: unknown,
  messageCount: number
): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1) {
    return false;
  }

  if (messageCount === 0) {
    return value === -1;
  }

  return value < messageCount;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function hasUniqueApprovalDecisionCallIds(
  decisions: ApprovalDecision[]
): boolean {
  const seenCallIds = new Set<string>();

  for (const decision of decisions) {
    if (seenCallIds.has(decision.callId)) {
      return false;
    }

    seenCallIds.add(decision.callId);
  }

  return true;
}

export function hasApprovalDecisionCoverage(
  decisions: ApprovalDecision[],
  toolCalls: PendingToolCall[]
): boolean {
  if (
    decisions.length !== toolCalls.length ||
    !hasApprovalDecisionCallIdsWithinRequest(decisions, toolCalls)
  ) {
    return false;
  }

  const pendingToolCallsById = new Map(
    toolCalls.map((toolCall) => [toolCall.callId, toolCall])
  );

  for (const decision of decisions) {
    const matchingToolCall = pendingToolCallsById.get(decision.callId);

    if (
      matchingToolCall === undefined ||
      !matchingToolCall.decisions.includes(decision.type)
    ) {
      return false;
    }
  }

  return true;
}

export function hasUniqueStrings(values: string[]): boolean {
  return new Set(values).size === values.length;
}

export function isEventSource(value: unknown): value is EventSource {
  if (
    !(
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, EVENT_SOURCE_KEYS) &&
      isNonEmptyStringProperty(value, "agent")
    )
  ) {
    return false;
  }

  if (
    "driver" in value &&
    value.driver !== undefined &&
    !isNonEmptyStringProperty(value, "driver")
  ) {
    return false;
  }

  if (
    "threadId" in value &&
    value.threadId !== undefined &&
    !isNonEmptyStringProperty(value, "threadId")
  ) {
    return false;
  }

  if (
    "workerId" in value &&
    value.workerId !== undefined &&
    !isNonEmptyStringProperty(value, "workerId")
  ) {
    return false;
  }

  return true;
}

export function isTuvrenErrorProjection(
  value: unknown
): value is TuvrenErrorProjection {
  return (
    isPlainObject(value) &&
    hasOnlyAllowedKeys(value, KRAKEN_ERROR_PROJECTION_KEYS) &&
    typeof value.message === "string" &&
    isOptionalStringProperty(value, "code") &&
    isOptionalSerializableContractValueProperty(value, "details")
  );
}

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object") {
      return false;
    }

    const prototype = Object.getPrototypeOf(value);

    if (!(prototype === Object.prototype || prototype === null)) {
      return false;
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      return false;
    }

    // Contract-boundary objects must be fully enumerable so they round-trip
    // through normal JSON-like serialization without hidden state.
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => descriptor.enumerable
    );
  } catch {
    return false;
  }
}

export function isStringProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): value is TObject & Record<TKey, string> {
  return typeof value[key] === "string";
}

export function safePredicate(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    // `is*` guards are used to probe untrusted input, so malformed accessors
    // must collapse to `false` instead of escaping as thrown errors.
    return false;
  }
}

export function hasOnlyAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): boolean {
  // Runtime validators define the exact payload surface for the current
  // released contract version. Minor releases stay compatible by extending
  // these allowlists alongside any newly-added optional fields.
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function matchesStreamEventVariant(
  value: Record<string, unknown>,
  eventSpecificKeys: string[],
  predicate: () => boolean
): boolean {
  return hasOnlyStreamEventKeys(value, eventSpecificKeys) && predicate();
}

export function hasUniqueTuvrenJsonValues(values: TuvrenJsonValue[]): boolean {
  const seenValues = new Set<string>();

  for (const value of values) {
    const canonicalValueKey = toCanonicalTuvrenJsonValueKey(value);

    if (seenValues.has(canonicalValueKey)) {
      return false;
    }

    seenValues.add(canonicalValueKey);
  }

  return true;
}

function hasApprovalDecisionCallIdsWithinRequest(
  decisions: ApprovalDecision[],
  toolCalls: PendingToolCall[]
): boolean {
  const pendingCallIds = new Set(toolCalls.map((toolCall) => toolCall.callId));
  return decisions.every((decision) => pendingCallIds.has(decision.callId));
}

function isValidJsonSchemaObject(value: {
  [key: string]: TuvrenJsonValue;
}): boolean {
  // This is a structural guard for the shared contract seam. It rejects
  // malformed standard keyword shapes without trying to replace a full
  // metaschema engine such as Ajv. Structurally valid but unsatisfiable
  // schemas still remain valid JSON Schema and are intentionally allowed.
  if ("type" in value && !isValidJsonSchemaType(value.type)) {
    return false;
  }

  if (!hasValidUniqueStringArrayKeyword(value, "required")) {
    return false;
  }

  if (!hasValidUniqueStringArrayRecordKeyword(value, "dependentRequired")) {
    return false;
  }

  if (!hasValidEnumKeyword(value)) {
    return false;
  }

  if (!hasValidFiniteNumberKeyword(value, "multipleOf", { positive: true })) {
    return false;
  }

  if (!hasValidBooleanKeyword(value, "uniqueItems")) {
    return false;
  }

  if (
    !NON_NEGATIVE_INTEGER_SCHEMA_KEYWORDS.every((keyword) =>
      hasValidNonNegativeIntegerKeyword(value, keyword)
    )
  ) {
    return false;
  }

  if (
    !FINITE_NUMBER_SCHEMA_KEYWORDS.every((keyword) =>
      hasValidFiniteNumberKeyword(value, keyword)
    )
  ) {
    return false;
  }

  if (
    !STRING_SCHEMA_KEYWORDS.every((keyword) =>
      hasValidStringKeyword(value, keyword)
    )
  ) {
    return false;
  }

  if (
    !BOOLEAN_SCHEMA_KEYWORDS.every((keyword) =>
      hasValidBooleanKeyword(value, keyword)
    )
  ) {
    return false;
  }

  if (
    !SCHEMA_KEYWORDS.every((keyword) => hasValidSchemaKeyword(value, keyword))
  ) {
    return false;
  }

  if (
    !NON_EMPTY_SCHEMA_ARRAY_KEYWORDS.every((keyword) =>
      hasValidSchemaArrayKeyword(value, keyword, { requireNonEmpty: true })
    )
  ) {
    return false;
  }

  return SCHEMA_RECORD_KEYWORDS.every((keyword) =>
    hasValidSchemaRecordKeyword(value, keyword)
  );
}

function isKrakenJsonObject(
  value: unknown,
  activeParents: WeakSet<object>
): value is { [key: string]: TuvrenJsonValue } {
  if (!isPlainObject(value)) {
    return false;
  }

  if (activeParents.has(value)) {
    return false;
  }

  activeParents.add(value);

  for (const key of Object.keys(value)) {
    if (!isKrakenJsonValue(value[key], activeParents)) {
      activeParents.delete(value);
      return false;
    }
  }

  activeParents.delete(value);
  return true;
}

function isKrakenJsonValue(
  value: unknown,
  activeParents: WeakSet<object>
): value is TuvrenJsonValue {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) {
        if (activeParents.has(value)) {
          return false;
        }

        activeParents.add(value);

        for (const item of value) {
          if (!isKrakenJsonValue(item, activeParents)) {
            activeParents.delete(value);
            return false;
          }
        }

        activeParents.delete(value);
        return true;
      }

      return isKrakenJsonObject(value, activeParents);
    default:
      return false;
  }
}

function isCustomSchema(value: unknown): value is CustomSchema {
  // Custom schemas are executable objects. The boundary guard intentionally
  // stays structural here so probing untrusted input never invokes arbitrary
  // user code inside `toJSONSchema()` or `validate()`.
  return (
    value !== null &&
    typeof value === "object" &&
    "toJSONSchema" in value &&
    typeof value.toJSONSchema === "function" &&
    "validate" in value &&
    typeof value.validate === "function"
  );
}

function isValidJsonSchemaType(value: unknown): boolean {
  return (
    (typeof value === "string" && JSON_SCHEMA_TYPE_NAMES.has(value)) ||
    (Array.isArray(value) &&
      value.length > 0 &&
      hasUniqueStrings(value) &&
      value.every(
        (item) => typeof item === "string" && JSON_SCHEMA_TYPE_NAMES.has(item)
      ))
  );
}

function hasValidNonNegativeIntegerKeyword(
  value: { [key: string]: TuvrenJsonValue },
  key: string
): boolean {
  return !(key in value) || isNonNegativeSafeInteger(value[key]);
}

function hasValidFiniteNumberKeyword(
  value: { [key: string]: TuvrenJsonValue },
  key: string,
  options?: { positive?: boolean }
): boolean {
  if (!(key in value)) {
    return true;
  }

  const keywordValue = value[key];

  if (typeof keywordValue !== "number" || !Number.isFinite(keywordValue)) {
    return false;
  }

  if (options?.positive) {
    return keywordValue > 0;
  }

  return true;
}

function hasValidBooleanKeyword(
  value: { [key: string]: TuvrenJsonValue },
  key: string
): boolean {
  return !(key in value) || typeof value[key] === "boolean";
}

function hasValidStringKeyword(
  value: { [key: string]: TuvrenJsonValue },
  key: string
): boolean {
  return !(key in value) || typeof value[key] === "string";
}

function hasValidEnumKeyword(value: {
  [key: string]: TuvrenJsonValue;
}): boolean {
  if (!("enum" in value)) {
    return true;
  }

  // The shared contract seam rejects degenerate enum arrays so provider-facing
  // schemas stay canonical instead of carrying duplicates or an always-invalid
  // empty choice set downstream.
  return (
    Array.isArray(value.enum) &&
    value.enum.length > 0 &&
    hasUniqueTuvrenJsonValues(value.enum)
  );
}

function hasValidUniqueStringArrayKeyword(
  value: { [key: string]: TuvrenJsonValue },
  key: string
): boolean {
  if (!(key in value)) {
    return true;
  }

  const keywordValue = value[key];

  return (
    Array.isArray(keywordValue) &&
    keywordValue.every((item) => typeof item === "string") &&
    hasUniqueStrings(keywordValue)
  );
}

function hasValidUniqueStringArrayRecordKeyword(
  value: { [key: string]: TuvrenJsonValue },
  key: string
): boolean {
  if (!(key in value)) {
    return true;
  }

  const keywordValue = value[key];

  return (
    isKrakenJsonObject(keywordValue, new WeakSet<object>()) &&
    Object.values(keywordValue).every(
      (recordValue) =>
        Array.isArray(recordValue) &&
        recordValue.every((item) => typeof item === "string") &&
        hasUniqueStrings(recordValue)
    )
  );
}

function hasValidSchemaKeyword(
  value: { [key: string]: TuvrenJsonValue },
  key: string
): boolean {
  return !(key in value) || isTuvrenJsonSchema(value[key]);
}

function hasValidSchemaArrayKeyword(
  value: { [key: string]: TuvrenJsonValue },
  key: string,
  options?: { requireNonEmpty?: boolean }
): boolean {
  if (!(key in value)) {
    return true;
  }

  const keywordValue = value[key];

  return (
    Array.isArray(keywordValue) &&
    (!options?.requireNonEmpty || keywordValue.length > 0) &&
    keywordValue.every(isTuvrenJsonSchema)
  );
}

function hasValidSchemaRecordKeyword(
  value: { [key: string]: TuvrenJsonValue },
  key: string
): boolean {
  if (!(key in value)) {
    return true;
  }

  const keywordValue = value[key];

  return (
    isKrakenJsonObject(keywordValue, new WeakSet<object>()) &&
    Object.values(keywordValue).every(isTuvrenJsonSchema)
  );
}

function hasOnlyStreamEventKeys(
  value: Record<string, unknown>,
  eventSpecificKeys: string[]
): boolean {
  return hasOnlyAllowedKeys(
    value,
    new Set(["type", "timestamp", "source", ...eventSpecificKeys])
  );
}

function toCanonicalTuvrenJsonValueKey(value: TuvrenJsonValue): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return `boolean:${value}`;
    case "number":
      return `number:${value}`;
    case "string":
      return `string:${JSON.stringify(value)}`;
    case "object":
      if (Array.isArray(value)) {
        return `array:[${value.map(toCanonicalTuvrenJsonValueKey).join(",")}]`;
      }

      return `object:{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${toCanonicalTuvrenJsonValueKey(value[key])}`
        )
        .join(",")}}`;
    default:
      return "unknown";
  }
}
