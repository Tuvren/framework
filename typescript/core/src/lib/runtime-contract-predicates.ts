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

type KrakenJsonValuePredicate = (
  value: unknown,
  activeParents: WeakSet<object>
) => value is TuvrenJsonValue;

type TuvrenJsonSchemaPredicate = (value: unknown) => value is TuvrenJsonSchema;

const EVENT_SOURCE_KEYS = new Set(["agent", "runner", "threadId", "workerId"]);
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

/**
 * True when `value` is a plain, fully-enumerable data object: prototype is
 * `Object.prototype` or `null`, no symbol-keyed properties, and every own
 * property is enumerable. Class instances, proxies with non-enumerable
 * descriptors, and prototype-carrying objects are rejected so
 * contract-boundary objects round-trip through JSON-like serialization
 * without hidden state. Never throws.
 */
export const isPlainObject = (
  value: unknown
): value is Record<string, unknown> => {
  try {
    if (value === null || typeof value !== "object") {
      return false;
    }

    const prototype: unknown = Object.getPrototypeOf(value);

    if (!(prototype === Object.prototype || prototype === null)) {
      return false;
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      return false;
    }

    // Contract-boundary objects must be fully enumerable so they round-trip
    // through normal JSON-like serialization without hidden state.
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => descriptor.enumerable === true
    );
  } catch {
    return false;
  }
};

/**
 * True when every own enumerable key of `value` belongs to `allowedKeys`.
 *
 * This is the exact-surface check behind every contract guard: unknown
 * extra fields are rejected rather than ignored, so the validated payload
 * surface always matches the released contract version.
 */
export const hasOnlyAllowedKeys = (
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): boolean => Object.keys(value).every((key) => allowedKeys.has(key));

/** True when `value` is a string with non-whitespace content. */
export const isNonEmptyStringValue = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** True when `value[key]` is a non-empty (after trimming) string. */
export const isNonEmptyStringProperty = <TKey extends string>(
  value: Record<string, unknown>,
  key: TKey
): value is Record<string, unknown> & Record<TKey, string> =>
  isNonEmptyStringValue(value[key]);

/**
 * True when `value` is a valid {@link EventSource} attribution record
 * (KrakenFrameworkSpecification §1.8): a plain object with a non-empty
 * `agent` string, optional non-empty `runner`, `threadId`, and `workerId`
 * strings, and no other keys.
 */
export const isEventSource = (value: unknown): value is EventSource => {
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
    "runner" in value &&
    value.runner !== undefined &&
    !isNonEmptyStringProperty(value, "runner")
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
};

/**
 * Validates the shared stream-event envelope: `timestamp` must be a
 * canonical `EpochMs` (safe integer, never `-0`) and `source`, when present
 * and defined, must be a valid {@link EventSource} attribution record
 * (KrakenFrameworkSpecification §1.8).
 */
export const hasCanonicalEpochMsTimestampAndValidSource = (
  value: Record<string, unknown>
): value is Record<string, unknown> & { timestamp: number } => {
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
};

/** True when `value[key]` is `undefined` or a boolean. */
export const isOptionalBooleanProperty = (
  value: Record<string, unknown>,
  key: string
): boolean => value[key] === undefined || typeof value[key] === "boolean";

/**
 * True when `value` is a valid {@link ApprovalPolicy}: a static boolean or a
 * per-invocation policy function. The function is never invoked here — the
 * check stays structural so probing untrusted input cannot execute user
 * code.
 */
export const isApprovalPolicy = (value: unknown): value is ApprovalPolicy =>
  typeof value === "boolean" || typeof value === "function";

/** True when `value[key]` is `undefined` or a valid {@link ApprovalPolicy}. */
export const isOptionalApprovalPolicy = (
  value: Record<string, unknown>,
  key: string
): boolean => value[key] === undefined || isApprovalPolicy(value[key]);

/**
 * True when `value[key]` is `undefined` or a canonical `HashString`
 * (lowercase 64-character SHA-256 hex digest).
 */
export const isOptionalHashStringProperty = (
  value: Record<string, unknown>,
  key: string
): boolean => value[key] === undefined || isHashString(value[key]);

const isKrakenJsonObjectWithPredicate = (
  value: unknown,
  activeParents: WeakSet<object>,
  valuePredicate: KrakenJsonValuePredicate
): value is Record<string, TuvrenJsonValue> => {
  if (!isPlainObject(value)) {
    return false;
  }

  if (activeParents.has(value)) {
    return false;
  }

  activeParents.add(value);

  for (const key of Object.keys(value)) {
    if (!valuePredicate(value[key], activeParents)) {
      activeParents.delete(value);
      return false;
    }
  }

  activeParents.delete(value);
  return true;
};

const isKrakenJsonValue = (
  value: unknown,
  activeParents: WeakSet<object>
): value is TuvrenJsonValue => {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case "boolean":
    case "string": {
      return true;
    }
    case "number": {
      return Number.isFinite(value);
    }
    case "object": {
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

      return isKrakenJsonObjectWithPredicate(
        value,
        activeParents,
        isKrakenJsonValue
      );
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined": {
      return false;
    }
    default: {
      return false;
    }
  }
};

const isKrakenJsonObject = (
  value: unknown,
  activeParents: WeakSet<object>
): value is Record<string, TuvrenJsonValue> =>
  isKrakenJsonObjectWithPredicate(value, activeParents, isKrakenJsonValue);

/**
 * Returns `true` when `value` is a plain-object record whose values are all
 * JSON-serializable contract values (see
 * {@link isSerializableContractValue}).
 */
export const isSerializableRecord = (
  value: unknown
): value is Record<string, TuvrenJsonValue> =>
  isKrakenJsonObject(value, new WeakSet());

/**
 * True when `value[key]` is `undefined` or a JSON-serializable plain-object
 * record (see {@link isSerializableRecord}). Used for optional
 * `providerMetadata`/`metadata`-style fields.
 */
export const isOptionalSerializableRecordProperty = (
  value: Record<string, unknown>,
  key: string
): boolean => value[key] === undefined || isSerializableRecord(value[key]);

/**
 * Returns `true` when `value` is a JSON-serializable contract value:
 * `null`, booleans, strings, finite numbers, and acyclic arrays/plain
 * objects thereof. Cyclic structures and non-plain objects (class
 * instances, symbol keys, accessor properties) are rejected so the value
 * round-trips through JSON without loss.
 */
export const isSerializableContractValue = (
  value: unknown
): value is TuvrenJsonValue => isKrakenJsonValue(value, new WeakSet());

/**
 * True when `value[key]` is `undefined` or any JSON-serializable contract
 * value (see {@link isSerializableContractValue}).
 */
export const isOptionalSerializableContractValueProperty = (
  value: Record<string, unknown>,
  key: string
): boolean =>
  value[key] === undefined || isSerializableContractValue(value[key]);

/** True when `value[key]` is a non-negative safe integer. */
export const isNonNegativeSafeIntegerProperty = (
  value: Record<string, unknown>,
  key: string
): boolean => {
  const propertyValue = value[key];
  return (
    typeof propertyValue === "number" &&
    Number.isSafeInteger(propertyValue) &&
    propertyValue >= 0
  );
};

/**
 * True when `value` is a valid {@link ProviderUsage}: exactly `inputTokens`
 * and `outputTokens`, both non-negative safe integers.
 */
export const isProviderUsage = (value: unknown): value is ProviderUsage =>
  isPlainObject(value) &&
  hasOnlyAllowedKeys(value, PROVIDER_USAGE_KEYS) &&
  isNonNegativeSafeIntegerProperty(value, "inputTokens") &&
  isNonNegativeSafeIntegerProperty(value, "outputTokens");

/** True when `value[key]` is `undefined` or a valid {@link ProviderUsage}. */
export const isOptionalProviderUsage = (
  value: Record<string, unknown>,
  key: string
): boolean => value[key] === undefined || isProviderUsage(value[key]);

/** True when `value[key]` is `undefined` or a string (empty allowed). */
export const isOptionalStringProperty = (
  value: Record<string, unknown>,
  key: string
): boolean => value[key] === undefined || typeof value[key] === "string";

/**
 * True when `value[key]` is `undefined` or a non-empty (after trimming)
 * string.
 */
export const isOptionalNonEmptyStringProperty = (
  value: Record<string, unknown>,
  key: string
): boolean => value[key] === undefined || isNonEmptyStringProperty(value, key);

/** True when `value` is an array with at least one element. */
export const isNonEmptyArray = (
  value: unknown
): value is [unknown, ...unknown[]] => Array.isArray(value) && value.length > 0;

/** True when `value` is a valid timeout: a non-negative finite number (ms). */
export const isTimeoutMs = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * True when `value[key]` is `undefined` or a valid timeout (non-negative
 * finite number of milliseconds; see {@link isTimeoutMs}).
 */
export const isOptionalTimeoutProperty = (
  value: Record<string, unknown>,
  key: string
): boolean => value[key] === undefined || isTimeoutMs(value[key]);

/** True when `value[key]` is a finite number greater than or equal to zero. */
export const isNonNegativeFiniteNumberProperty = (
  value: Record<string, unknown>,
  key: string
): boolean => {
  const numericValue = value[key];
  return (
    typeof numericValue === "number" &&
    Number.isFinite(numericValue) &&
    numericValue >= 0
  );
};

/** True when `values` contains no duplicate strings. */
export const hasUniqueStrings = (values: string[]): boolean =>
  new Set(values).size === values.length;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isValidJsonSchemaType = (value: unknown): boolean =>
  (typeof value === "string" && JSON_SCHEMA_TYPE_NAMES.has(value)) ||
  (isStringArray(value) &&
    value.length > 0 &&
    hasUniqueStrings(value) &&
    value.every((item) => JSON_SCHEMA_TYPE_NAMES.has(item)));

const hasValidUniqueStringArrayKeyword = (
  value: Record<string, TuvrenJsonValue>,
  key: string
): boolean => {
  if (!(key in value)) {
    return true;
  }

  const keywordValue = value[key];

  return isStringArray(keywordValue) && hasUniqueStrings(keywordValue);
};

const hasValidUniqueStringArrayRecordKeyword = (
  value: Record<string, TuvrenJsonValue>,
  key: string
): boolean => {
  if (!(key in value)) {
    return true;
  }

  const keywordValue = value[key];

  return (
    isKrakenJsonObject(keywordValue, new WeakSet<object>()) &&
    Object.values(keywordValue).every(
      (recordValue) =>
        isStringArray(recordValue) && hasUniqueStrings(recordValue)
    )
  );
};

const toCanonicalTuvrenJsonValueKey = (value: TuvrenJsonValue): string => {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean": {
      return `boolean:${value}`;
    }
    case "number": {
      return `number:${value}`;
    }
    case "string": {
      return `string:${JSON.stringify(value)}`;
    }
    case "object": {
      if (Array.isArray(value)) {
        return `array:[${value.map(toCanonicalTuvrenJsonValueKey).join(",")}]`;
      }

      return `object:{${Object.keys(value)
        .toSorted()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${toCanonicalTuvrenJsonValueKey(value[key])}`
        )
        .join(",")}}`;
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined": {
      return "unknown";
    }
    default: {
      return "unknown";
    }
  }
};

/**
 * True when `values` contains no structural duplicates, comparing by a
 * canonical key (object keys sorted, so `{a:1,b:2}` equals `{b:2,a:1}`).
 * Used to reject degenerate JSON Schema `enum` arrays.
 */
export const hasUniqueTuvrenJsonValues = (
  values: TuvrenJsonValue[]
): boolean => {
  const seenValues = new Set<string>();

  for (const value of values) {
    const canonicalValueKey = toCanonicalTuvrenJsonValueKey(value);

    if (seenValues.has(canonicalValueKey)) {
      return false;
    }

    seenValues.add(canonicalValueKey);
  }

  return true;
};

const hasValidEnumKeyword = (
  value: Record<string, TuvrenJsonValue>
): boolean => {
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
};

const hasValidFiniteNumberKeyword = (
  value: Record<string, TuvrenJsonValue>,
  key: string,
  options?: { positive?: boolean }
): boolean => {
  if (!(key in value)) {
    return true;
  }

  const keywordValue = value[key];

  if (typeof keywordValue !== "number" || !Number.isFinite(keywordValue)) {
    return false;
  }

  if (options?.positive === true) {
    return keywordValue > 0;
  }

  return true;
};

const hasValidBooleanKeyword = (
  value: Record<string, TuvrenJsonValue>,
  key: string
): boolean => !(key in value) || typeof value[key] === "boolean";

/** True when `value` is a non-negative safe integer. */
export const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const hasValidNonNegativeIntegerKeyword = (
  value: Record<string, TuvrenJsonValue>,
  key: string
): boolean => !(key in value) || isNonNegativeSafeInteger(value[key]);

const hasValidStringKeyword = (
  value: Record<string, TuvrenJsonValue>,
  key: string
): boolean => !(key in value) || typeof value[key] === "string";

const hasValidSchemaKeyword = (
  value: Record<string, TuvrenJsonValue>,
  key: string,
  schemaPredicate: TuvrenJsonSchemaPredicate
): boolean => !(key in value) || schemaPredicate(value[key]);

const hasValidSchemaArrayKeyword = (
  value: Record<string, TuvrenJsonValue>,
  key: string,
  schemaPredicate: TuvrenJsonSchemaPredicate,
  options?: { requireNonEmpty?: boolean }
): boolean => {
  if (!(key in value)) {
    return true;
  }

  const keywordValue = value[key];

  return (
    Array.isArray(keywordValue) &&
    (options?.requireNonEmpty !== true || keywordValue.length > 0) &&
    keywordValue.every(schemaPredicate)
  );
};

const hasValidSchemaRecordKeyword = (
  value: Record<string, TuvrenJsonValue>,
  key: string,
  schemaPredicate: TuvrenJsonSchemaPredicate
): boolean => {
  if (!(key in value)) {
    return true;
  }

  const keywordValue = value[key];

  return (
    isKrakenJsonObject(keywordValue, new WeakSet<object>()) &&
    Object.values(keywordValue).every(schemaPredicate)
  );
};

const isValidJsonSchemaObject = (
  value: Record<string, TuvrenJsonValue>,
  schemaPredicate: TuvrenJsonSchemaPredicate
): boolean => {
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
    !SCHEMA_KEYWORDS.every((keyword) =>
      hasValidSchemaKeyword(value, keyword, schemaPredicate)
    )
  ) {
    return false;
  }

  if (
    !NON_EMPTY_SCHEMA_ARRAY_KEYWORDS.every((keyword) =>
      hasValidSchemaArrayKeyword(value, keyword, schemaPredicate, {
        requireNonEmpty: true,
      })
    )
  ) {
    return false;
  }

  return SCHEMA_RECORD_KEYWORDS.every((keyword) =>
    hasValidSchemaRecordKeyword(value, keyword, schemaPredicate)
  );
};

/**
 * Returns `true` when `value` is a structurally valid JSON Schema for the
 * shared contract seam: either a boolean schema or a JSON-serializable
 * plain object whose standard keywords (`type`, `required`, `enum`,
 * numeric bounds, string keywords, subschema keywords, ...) all have
 * well-formed shapes, recursively.
 *
 * This is a structural guard, not a metaschema engine: structurally valid
 * but unsatisfiable schemas are intentionally accepted.
 */
export const isTuvrenJsonSchema = (value: unknown): value is TuvrenJsonSchema =>
  typeof value === "boolean" ||
  (isKrakenJsonObject(value, new WeakSet()) &&
    isValidJsonSchemaObject(value, isTuvrenJsonSchema));

const isCustomSchema = (value: unknown): value is CustomSchema =>
  value !== null &&
  typeof value === "object" &&
  "toJSONSchema" in value &&
  typeof value.toJSONSchema === "function" &&
  "validate" in value &&
  typeof value.validate === "function";

/**
 * Returns `true` when `value` is usable as a tool input/output schema:
 * either a structurally valid JSON Schema ({@link isTuvrenJsonSchema}) or an
 * executable {@link CustomSchema} exposing `toJSONSchema()` and
 * `validate()` functions.
 */
export const isKrakenToolSchema = (
  value: unknown
): value is TuvrenJsonSchema | CustomSchema =>
  isTuvrenJsonSchema(value) || isCustomSchema(value);

/**
 * True when `value` is a valid last-message index for a history of
 * `messageCount` messages: a safe integer in `[-1, messageCount)`, where
 * `-1` is the "no such message" sentinel and is the only valid value when
 * `messageCount` is zero. Used for `ContextManifest` last-role indexes
 * (KrakenFrameworkSpecification §1.6).
 *
 * @param value - Candidate index.
 * @param messageCount - Total number of messages the index refers into.
 */
export const isMessageIndexValue = (
  value: unknown,
  messageCount: number
): value is number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1) {
    return false;
  }

  if (messageCount === 0) {
    return value === -1;
  }

  return value < messageCount;
};

/**
 * True when no two decisions target the same `callId` — each approval
 * decision must apply to exactly one pending tool call
 * (KrakenFrameworkSpecification §1.7).
 */
export const hasUniqueApprovalDecisionCallIds = (
  decisions: ApprovalDecision[]
): boolean => {
  const seenCallIds = new Set<string>();

  for (const decision of decisions) {
    if (seenCallIds.has(decision.callId)) {
      return false;
    }

    seenCallIds.add(decision.callId);
  }

  return true;
};

const hasApprovalDecisionCallIdsWithinRequest = (
  decisions: ApprovalDecision[],
  toolCalls: PendingToolCall[]
): boolean => {
  const pendingCallIds = new Set(toolCalls.map((toolCall) => toolCall.callId));
  return decisions.every((decision) => pendingCallIds.has(decision.callId));
};

/**
 * True when `decisions` exactly covers `toolCalls`: same cardinality, every
 * decision `callId` matches a pending call, and each decision `type` is one
 * of the decision options that pending call offered
 * (KrakenFrameworkSpecification §1.7).
 *
 * Callers should also check {@link hasUniqueApprovalDecisionCallIds}; with
 * unique ids, equal length plus id membership implies one decision per
 * pending call.
 */
export const hasApprovalDecisionCoverage = (
  decisions: ApprovalDecision[],
  toolCalls: PendingToolCall[]
): boolean => {
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
};

/**
 * True when `value` is a valid {@link TuvrenErrorProjection}: the
 * serializable, data-only projection of an error carried by `error` stream
 * events — a string `message`, optional string `code`, and optional
 * JSON-serializable `details`, with no other keys.
 */
export const isTuvrenErrorProjection = (
  value: unknown
): value is TuvrenErrorProjection =>
  isPlainObject(value) &&
  hasOnlyAllowedKeys(value, KRAKEN_ERROR_PROJECTION_KEYS) &&
  typeof value.message === "string" &&
  isOptionalStringProperty(value, "code") &&
  isOptionalSerializableContractValueProperty(value, "details");

/**
 * True when `value[key]` is a string; narrows the object type so the caller
 * can read the property as `string` afterwards.
 */
export const isStringProperty = <
  TKey extends string,
  TObject extends Record<string, unknown>,
>(
  value: TObject,
  key: TKey
): value is TObject & Record<TKey, string> => typeof value[key] === "string";

/**
 * Runs `check` and converts any thrown error into `false`.
 *
 * Wrap `is*` guard bodies with this when probing untrusted input, so a
 * hostile getter or revoked proxy can never turn a boolean probe into an
 * exception.
 */
export const safePredicate = (check: () => boolean): boolean => {
  try {
    return check();
  } catch {
    // `is*` guards are used to probe untrusted input, so malformed accessors
    // must collapse to `false` instead of escaping as thrown errors.
    return false;
  }
};

const hasOnlyStreamEventKeys = (
  value: Record<string, unknown>,
  eventSpecificKeys: string[]
): boolean =>
  hasOnlyAllowedKeys(
    value,
    new Set(["type", "timestamp", "source", ...eventSpecificKeys])
  );

/**
 * True when `value` carries only the shared stream-event envelope keys
 * (`type`, `timestamp`, `source`) plus this variant's `eventSpecificKeys`,
 * and the variant's own `predicate` passes.
 */
export const matchesStreamEventVariant = (
  value: Record<string, unknown>,
  eventSpecificKeys: string[],
  predicate: () => boolean
): boolean => hasOnlyStreamEventKeys(value, eventSpecificKeys) && predicate();
