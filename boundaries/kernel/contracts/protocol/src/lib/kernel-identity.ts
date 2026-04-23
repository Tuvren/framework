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

import type { HashString, KernelRecord } from "@tuvren/core-types";
import {
  assertEpochMs,
  assertHashString,
  assertKernelRecord,
  TuvrenValidationError,
} from "@tuvren/core-types";
import { Decoder, Encoder } from "cbor-x";
import type {
  StagedResult,
  TurnNode,
  TurnTreeManifest,
  TurnTreeSchema,
} from "./kernel-types.js";

const deterministicEncoderOptions = {
  tagUint8Array: false,
  useTag259ForMaps: false,
  useRecords: false,
  variableMapSize: true,
};

const deterministicEncoder = new Encoder(deterministicEncoderOptions);

const deterministicScalarEncoder = new Encoder({
  tagUint8Array: false,
  useRecords: false,
  variableMapSize: true,
});

const deterministicDecoder = new Decoder({
  mapsAsObjects: false,
  useRecords: false,
});
const STAGED_RESULT_STATUSES = ["completed", "failed", "interrupted"] as const;

export function canonicalizeKernelRecord(value: KernelRecord): unknown {
  assertKernelRecord(value);

  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof Uint8Array
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeKernelRecord(item));
  }

  const sortedEntries = Object.entries(value).sort(([leftKey], [rightKey]) =>
    compareByteArrays(
      encodeDeterministicScalar(leftKey),
      encodeDeterministicScalar(rightKey)
    )
  );

  return new Map(
    sortedEntries.map(([key, nestedValue]) => [
      key,
      canonicalizeKernelRecord(nestedValue),
    ])
  );
}

export function encodeDeterministicKernelRecord(
  value: KernelRecord
): Uint8Array {
  const canonicalValue = canonicalizeKernelRecord(value);
  return new Uint8Array(
    deterministicEncoder.encode(prepareCanonicalKernelValue(canonicalValue))
  );
}

export function decodeDeterministicKernelRecord(
  bytes: Uint8Array
): KernelRecord {
  let decodedValue: unknown;

  try {
    decodedValue = deterministicDecoder.decode(bytes);
  } catch (error: unknown) {
    throw new TuvrenValidationError(
      "decoded kernel record bytes must contain valid deterministic CBOR",
      {
        code: "invalid_decoded_kernel_record",
        details: {
          cause:
            error instanceof Error
              ? error.message
              : "unknown CBOR decode failure",
        },
      }
    );
  }

  const normalizedValue = normalizeDecodedKernelValue(decodedValue, "value");
  const canonicalBytes = encodeDeterministicKernelRecord(normalizedValue);

  assertKernelRecord(normalizedValue, "decoded kernel record");

  if (!areByteArraysEqual(bytes, canonicalBytes)) {
    throw new TuvrenValidationError(
      "decoded kernel record must already use the canonical deterministic CBOR encoding",
      {
        code: "non_canonical_kernel_record_encoding",
        details: {
          canonicalHex: bytesToHex(canonicalBytes),
          receivedHex: bytesToHex(bytes),
        },
      }
    );
  }

  return normalizedValue;
}

export function hashKernelRecord(value: KernelRecord): Promise<HashString> {
  return hashBytesToHex(encodeDeterministicKernelRecord(value));
}

export function hashOpaqueObjectBytes(bytes: Uint8Array): Promise<HashString> {
  return hashBytesToHex(bytes);
}

export function hashTurnTreeIdentity(
  schemaId: string,
  manifest: TurnTreeManifest,
  schema: TurnTreeSchema
): Promise<HashString> {
  assertNonEmptyString(schemaId, "schemaId");
  assertTurnTreeManifestIdentityInput(manifest, schema, "manifest");
  if (schema.schemaId !== schemaId) {
    throw turnTreeIdentityError("schemaId must match schema.schemaId", {
      expectedSchemaId: schema.schemaId,
      schemaId,
    });
  }
  return hashKernelRecord({ manifest, schemaId });
}

export async function hashTurnNodeIdentity(
  value: Omit<TurnNode, "hash"> | TurnNode
): Promise<HashString> {
  const turnNodeValue = assertTurnNodeIdentityInput(value);
  return await hashKernelRecord(toTurnNodeIdentityRecord(turnNodeValue));
}

function toTurnNodeIdentityRecord(
  value: Omit<TurnNode, "hash"> | TurnNode
): KernelRecord {
  const turnNodeValue = value as TurnNode & {
    hash?: HashString;
  };
  const identityRecord = {
    consumedStagedResults: turnNodeValue.consumedStagedResults.map(
      (stagedResult) => {
        const projectedResult = {
          objectHash: stagedResult.objectHash,
          objectType: stagedResult.objectType,
          status: stagedResult.status,
          taskId: stagedResult.taskId,
          timestamp: stagedResult.timestamp,
        } as {
          interruptPayload?: KernelRecord;
          objectHash: HashString;
          objectType: string;
          status: typeof stagedResult.status;
          taskId: string;
          timestamp: number;
        };

        if (stagedResult.interruptPayload !== undefined) {
          projectedResult.interruptPayload = stagedResult.interruptPayload;
        }

        return projectedResult;
      }
    ),
    eventHash: turnNodeValue.eventHash,
    previousTurnNodeHash: turnNodeValue.previousTurnNodeHash,
    schemaId: turnNodeValue.schemaId,
    turnTreeHash: turnNodeValue.turnTreeHash,
  } satisfies KernelRecord;

  assertKernelRecord(identityRecord, "turn node identity payload");

  return identityRecord;
}

function assertTurnNodeIdentityInput(
  value: Omit<TurnNode, "hash"> | TurnNode
): Omit<TurnNode, "hash"> | TurnNode {
  const objectValue = assertPlainObjectRecord(
    value,
    "turn node identity input"
  );

  assertAllowedKeys(
    objectValue,
    [
      "consumedStagedResults",
      "eventHash",
      "hash",
      "previousTurnNodeHash",
      "schemaId",
      "turnTreeHash",
    ],
    "turn node identity input"
  );

  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "hash",
    "turn node identity input"
  );

  if (Object.hasOwn(objectValue, "hash")) {
    assertHashStringOrThrow(objectValue.hash, "turn node identity input.hash");
  }

  assertNullableHashStringOrThrow(
    objectValue.eventHash,
    "turn node identity input.eventHash"
  );
  assertNullableHashStringOrThrow(
    objectValue.previousTurnNodeHash,
    "turn node identity input.previousTurnNodeHash"
  );
  assertHashStringOrThrow(
    objectValue.turnTreeHash,
    "turn node identity input.turnTreeHash"
  );
  assertNonEmptyString(
    objectValue.schemaId,
    "turn node identity input.schemaId"
  );

  const consumedStagedResults = objectValue.consumedStagedResults;
  assertDenseDataArray(
    consumedStagedResults,
    "turn node identity input.consumedStagedResults"
  );

  const normalizedConsumedStagedResults = consumedStagedResults.map(
    (stagedResult, index) =>
      assertStagedResultIdentityInput(
        stagedResult,
        `turn node identity input.consumedStagedResults[${index}]`
      )
  );
  assertUniqueStagedResultTaskIds(
    normalizedConsumedStagedResults,
    "turn node identity input.consumedStagedResults"
  );

  return Object.assign(Object.create(null), objectValue, {
    consumedStagedResults: normalizedConsumedStagedResults,
  }) as Omit<TurnNode, "hash"> | TurnNode;
}

function assertStagedResultIdentityInput(
  value: unknown,
  label: string
): StagedResult {
  const objectValue = assertPlainObjectRecord(value, label);

  assertAllowedKeys(
    objectValue,
    [
      "interruptPayload",
      "objectHash",
      "objectType",
      "status",
      "taskId",
      "timestamp",
    ],
    label
  );

  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "interruptPayload",
    label
  );
  const objectHash = objectValue.objectHash;
  const objectType = objectValue.objectType;
  const status = objectValue.status;
  const taskId = objectValue.taskId;
  const timestamp = objectValue.timestamp;
  const interruptPayload = objectValue.interruptPayload;

  assertHashStringOrThrow(objectHash, `${label}.objectHash`);
  assertNonEmptyString(objectType, `${label}.objectType`);
  assertStagedResultStatusOrThrow(status, `${label}.status`);
  assertNonEmptyString(taskId, `${label}.taskId`);
  assertEpochMs(timestamp, `${label}.timestamp`);

  if (interruptPayload !== undefined) {
    assertKernelRecord(interruptPayload, `${label}.interruptPayload`);
  }

  assertInterruptPayloadConsistency(
    status,
    interruptPayload,
    `${label}.interruptPayload`
  );

  if (status === "interrupted") {
    if (interruptPayload === undefined) {
      throw turnNodeIdentityError(
        `${label}.interruptPayload is required when status is "interrupted"`,
        { status }
      );
    }

    return {
      interruptPayload,
      objectHash,
      objectType,
      status,
      taskId,
      timestamp,
    };
  }

  return {
    objectHash,
    objectType,
    status,
    taskId,
    timestamp,
  };
}

function assertDenseDataArray(
  value: unknown,
  label: string
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw turnNodeIdentityError(`${label} must be an array`, { value });
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw turnNodeIdentityError(`${label} must be a dense data-only array`, {
      value,
    });
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    if (key === "length") {
      continue;
    }

    const descriptor = descriptors[key];
    const index = Number(key);

    if (
      !(
        descriptor?.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < value.length &&
        String(index) === key
      ) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      throw turnNodeIdentityError(`${label} must be a dense data-only array`, {
        value,
      });
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw turnNodeIdentityError(`${label} must be a dense data-only array`, {
        value,
      });
    }
  }
}

function assertUniqueStagedResultTaskIds(
  stagedResults: StagedResult[],
  label: string
): void {
  const seenTaskIds = new Set<string>();

  for (const stagedResult of stagedResults) {
    if (seenTaskIds.has(stagedResult.taskId)) {
      throw turnNodeIdentityError(
        `${label} must not contain duplicate staged result taskIds`,
        { taskId: stagedResult.taskId }
      );
    }

    seenTaskIds.add(stagedResult.taskId);
  }
}

function assertInterruptPayloadConsistency(
  status: StagedResult["status"],
  interruptPayload: KernelRecord | undefined,
  label: string
): void {
  if (status === "interrupted") {
    if (interruptPayload === undefined) {
      throw turnNodeIdentityError(
        `${label} is required when status is "interrupted"`,
        { status }
      );
    }

    return;
  }

  if (interruptPayload !== undefined) {
    throw turnNodeIdentityError(
      `${label} must be omitted unless status is "interrupted"`,
      { status }
    );
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string
): void {
  const allowedKeySet = new Set(allowedKeys);

  for (const key of Object.keys(value)) {
    if (!allowedKeySet.has(key)) {
      throw turnNodeIdentityError(
        `${label}.${key} is not part of the contract shape`,
        {
          allowedKeys,
          key,
        }
      );
    }
  }
}

function assertTurnTreeManifestIdentityInput(
  value: TurnTreeManifest,
  schema: TurnTreeSchema,
  label: string
): void {
  const objectValue = assertTurnTreePlainObjectRecord(value, label);

  assertKernelRecord(objectValue, label);
  assertTurnTreeSchemaIdentityInput(schema, "schema");

  const pathDefinitions = new Map(
    schema.paths.map((definition) => [definition.path, definition.collection])
  );

  for (const definition of schema.paths) {
    if (!Object.hasOwn(objectValue, definition.path)) {
      throw turnTreeIdentityError(
        `${label}.${definition.path} must be present in a full TurnTree manifest`,
        { path: definition.path, schemaId: schema.schemaId }
      );
    }
  }

  for (const [path, pathValue] of Object.entries(objectValue)) {
    const collectionKind = pathDefinitions.get(path);

    if (collectionKind === undefined) {
      throw turnTreeIdentityError(
        `${label}.${path} must reference a schema-defined path`,
        { path, schemaId: schema.schemaId }
      );
    }

    assertTurnTreeSchemaPath(path, `${label} path`);
    assertTurnTreePathValue(pathValue, collectionKind, `${label}.${path}`);
  }
}

function assertTurnTreePathValue(
  value: unknown,
  collectionKind: "ordered" | "single",
  label: string
): void {
  if (collectionKind === "single") {
    if (value === null) {
      return;
    }

    assertTurnTreeHashStringOrThrow(value, label);
    return;
  }

  if (!Array.isArray(value)) {
    throw turnTreeIdentityError(
      `${label} must be a HashString[] for an ordered path`,
      { collectionKind, value }
    );
  }

  for (const [index, item] of value.entries()) {
    assertTurnTreeHashStringOrThrow(item, `${label}[${index}]`);
  }
}

function assertTurnTreeSchemaIdentityInput(
  value: TurnTreeSchema,
  label: string
): void {
  const objectValue = assertTurnTreePlainObjectRecord(value, label);
  assertAllowedKeys(
    objectValue,
    ["incorporationRules", "paths", "schemaId"],
    label
  );
  assertTurnTreeNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  const pathDefinitions = assertTurnTreeSchemaPathDefinitions(
    objectValue.paths,
    `${label}.paths`
  );
  assertTurnTreeSchemaIncorporationRules(
    objectValue.incorporationRules,
    pathDefinitions,
    `${label}.incorporationRules`
  );
}

function assertTurnTreeSchemaPathDefinitions(
  value: unknown,
  label: string
): Array<{ collection: "ordered" | "single"; path: string }> {
  const definitions = assertTurnTreeDenseDataArray(value, label);
  const seenPaths = new Set<string>();
  const validatedDefinitions: Array<{
    collection: "ordered" | "single";
    path: string;
  }> = [];

  for (const [index, definition] of definitions.entries()) {
    const definitionValue = assertTurnTreePlainObjectRecord(
      definition,
      `${label}[${index}]`
    );
    assertAllowedKeys(
      definitionValue,
      ["collection", "metadata", "path"],
      `${label}[${index}]`
    );
    const pathValue = definitionValue.path;
    const collectionValue = definitionValue.collection;

    assertTurnTreeSchemaPath(pathValue, `${label}[${index}].path`);
    if (!(collectionValue === "ordered" || collectionValue === "single")) {
      throw turnTreeIdentityError(
        `${label}[${index}].collection must be "ordered" or "single"`,
        { value: collectionValue }
      );
    }
    const path: string = pathValue;
    const collection: "ordered" | "single" = collectionValue;

    if (Object.hasOwn(definitionValue, "metadata")) {
      if (definitionValue.metadata === undefined) {
        throw turnTreeIdentityError(
          `${label}[${index}].metadata must be omitted instead of undefined`,
          { key: "metadata" }
        );
      }

      assertKernelRecord(
        definitionValue.metadata,
        `${label}[${index}].metadata`
      );
    }

    if (seenPaths.has(path)) {
      throw turnTreeIdentityError(
        `${label} must not contain duplicate schema paths`,
        { path }
      );
    }

    seenPaths.add(path);
    validatedDefinitions.push({ collection, path });
  }

  return validatedDefinitions;
}

function assertTurnTreeSchemaIncorporationRules(
  value: unknown,
  pathDefinitions: Array<{ collection: "ordered" | "single"; path: string }>,
  label: string
): void {
  const rules = assertTurnTreeDenseDataArray(value, label);
  const knownPaths = new Set(pathDefinitions.map(({ path }) => path));
  const seenObjectTypes = new Set<string>();

  for (const [index, rule] of rules.entries()) {
    const ruleValue = assertTurnTreePlainObjectRecord(
      rule,
      `${label}[${index}]`
    );
    assertAllowedKeys(
      ruleValue,
      ["objectType", "targetPath"],
      `${label}[${index}]`
    );
    assertTurnTreeNonEmptyString(
      ruleValue.objectType,
      `${label}[${index}].objectType`
    );
    assertTurnTreeNonEmptyString(
      ruleValue.targetPath,
      `${label}[${index}].targetPath`
    );

    if (!knownPaths.has(ruleValue.targetPath)) {
      throw turnTreeIdentityError(
        `${label}[${index}].targetPath must reference a defined schema path`,
        { targetPath: ruleValue.targetPath }
      );
    }

    if (seenObjectTypes.has(ruleValue.objectType)) {
      throw turnTreeIdentityError(
        `${label} must not contain duplicate objectType mappings`,
        { objectType: ruleValue.objectType }
      );
    }

    seenObjectTypes.add(ruleValue.objectType);
  }
}

function assertTurnTreeDenseDataArray(
  value: unknown,
  label: string
): unknown[] {
  if (!Array.isArray(value)) {
    throw turnTreeIdentityError(`${label} must be a dense data-only array`, {
      value,
    });
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw turnTreeIdentityError(`${label} must be a dense data-only array`, {
      value,
    });
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    if (key === "length") {
      continue;
    }

    const descriptor = descriptors[key];
    const index = Number(key);

    if (
      !(
        descriptor?.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < value.length &&
        String(index) === key
      ) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      throw turnTreeIdentityError(`${label} must be a dense data-only array`, {
        value,
      });
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw turnTreeIdentityError(`${label} must be a dense data-only array`, {
        value,
      });
    }
  }

  return value;
}

function assertTurnTreePlainObjectRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw turnTreeIdentityError(`${label} must be a plain object`, { value });
  }

  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw turnTreeIdentityError(`${label} must be a plain object`, { value });
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    const descriptor = descriptors[key];

    if (
      !(descriptor?.enumerable && Object.hasOwn(descriptor, "value")) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      throw turnTreeIdentityError(`${label} must be a plain object`, { value });
    }
  }

  return Object.assign(
    Object.create(null),
    Object.fromEntries(Object.entries(value))
  ) as Record<string, unknown>;
}

function assertTurnTreeNonEmptyString(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw turnTreeIdentityError(`${label} must be a non-empty string`, {
      value,
    });
  }
}

function assertTurnTreeSchemaPath(
  value: unknown,
  label: string
): asserts value is string {
  assertTurnTreeNonEmptyString(value, label);
  const pathValue = value;
  const segments = pathValue.split(".");

  if (segments.some((segment) => segment.length === 0)) {
    throw turnTreeIdentityError(
      `${label} must be a dot-separated path with non-empty segments`,
      { value: pathValue }
    );
  }
}

function assertTurnTreeHashStringOrThrow(value: unknown, label: string): void {
  try {
    assertHashString(value, label);
  } catch (error: unknown) {
    throw turnTreeIdentityError(
      error instanceof Error ? error.message : `${label} must be a hash string`,
      { value }
    );
  }
}

function assertPlainObjectRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw turnNodeIdentityError(`${label} must be a plain object`, { value });
  }

  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw turnNodeIdentityError(`${label} must be a plain object`, { value });
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    const descriptor = descriptors[key];

    if (
      !(descriptor?.enumerable && Object.hasOwn(descriptor, "value")) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      throw turnNodeIdentityError(`${label} must be a plain object`, { value });
    }
  }

  return Object.assign(
    Object.create(null),
    Object.fromEntries(Object.entries(value))
  ) as Record<string, unknown>;
}

function assertOptionalFieldIsOmittedWhenUndefined(
  value: Record<string, unknown>,
  key: string,
  label: string
): void {
  if (Object.hasOwn(value, key) && value[key] === undefined) {
    throw turnNodeIdentityError(
      `${label}.${key} must be omitted instead of undefined`,
      { key }
    );
  }
}

function assertHashStringOrThrow(
  value: unknown,
  label: string
): asserts value is HashString {
  try {
    assertHashString(value, label);
  } catch (error: unknown) {
    throw turnNodeIdentityError(
      error instanceof Error ? error.message : `${label} must be a hash string`,
      { value }
    );
  }
}

function assertNullableHashStringOrThrow(
  value: unknown,
  label: string
): asserts value is HashString | null {
  if (value === null) {
    return;
  }

  assertHashStringOrThrow(value, label);
}

function assertNonEmptyString(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw turnNodeIdentityError(`${label} must be a non-empty string`, {
      value,
    });
  }
}

function assertStagedResultStatusOrThrow(
  value: unknown,
  label: string
): asserts value is StagedResult["status"] {
  if (
    !(
      typeof value === "string" &&
      (STAGED_RESULT_STATUSES as readonly string[]).includes(value)
    )
  ) {
    throw turnNodeIdentityError(
      `${label} must be one of ${STAGED_RESULT_STATUSES.join(", ")}`,
      { value }
    );
  }
}

function turnNodeIdentityError(
  message: string,
  details: unknown
): TuvrenValidationError {
  return new TuvrenValidationError(message, {
    code: "invalid_turn_node_hash",
    details,
  });
}

function turnTreeIdentityError(
  message: string,
  details: unknown
): TuvrenValidationError {
  return new TuvrenValidationError(message, {
    code: "invalid_turn_tree_hash",
    details,
  });
}

function prepareCanonicalKernelValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    value instanceof Uint8Array
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (value > 0xff_ff_ff_ff || value < -0x1_00_00_00_00) {
      return BigInt(value);
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => prepareCanonicalKernelValue(item));
  }

  if (value instanceof Map) {
    return new Map(
      Array.from(value, ([key, nestedValue]) => [
        key,
        prepareCanonicalKernelValue(nestedValue),
      ])
    );
  }

  return value;
}

function normalizeDecodedKernelValue(
  value: unknown,
  label: string
): KernelRecord {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return normalizeDecodedKernelNumber(value, label);
  }

  if (typeof value === "bigint") {
    const normalizedInteger = Number(value);

    if (!Number.isSafeInteger(normalizedInteger)) {
      throw new TuvrenValidationError(
        `${label} decoded to an out-of-range bigint value`,
        {
          code: "invalid_decoded_kernel_record",
          details: { value: value.toString() },
        }
      );
    }

    return normalizedInteger;
  }

  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      normalizeDecodedKernelValue(item, `${label}[${index}]`)
    );
  }

  if (value instanceof Map) {
    const objectValue = Object.create(null) as Record<string, KernelRecord>;

    for (const [entryKey, entryValue] of value) {
      if (typeof entryKey !== "string") {
        throw new TuvrenValidationError(
          `${label} contains a non-string map key after CBOR decode`,
          {
            code: "invalid_decoded_kernel_record",
            details: { entryKey },
          }
        );
      }

      objectValue[entryKey] = normalizeDecodedKernelValue(
        entryValue,
        `${label}.${entryKey}`
      );
    }

    return objectValue;
  }

  if (typeof value !== "object") {
    throw new TuvrenValidationError(
      `${label} decoded to an unsupported kernel record type`,
      {
        code: "invalid_decoded_kernel_record",
        details: { decodedType: typeof value },
      }
    );
  }

  if (isPlainObject(value)) {
    const objectValue = Object.create(null) as Record<string, KernelRecord>;

    for (const [entryKey, entryValue] of Object.entries(value)) {
      objectValue[entryKey] = normalizeDecodedKernelValue(
        entryValue,
        `${label}.${entryKey}`
      );
    }

    return objectValue;
  }

  throw new TuvrenValidationError(
    `${label} decoded to an unsupported kernel record type`,
    {
      code: "invalid_decoded_kernel_record",
      details: {
        decodedType:
          value == null ? value : Object.prototype.toString.call(value),
      },
    }
  );
}

function normalizeDecodedKernelNumber(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number.isNaN(value) ||
    !Number.isFinite(value) ||
    Object.is(value, -0)
  ) {
    throw new TuvrenValidationError(
      `${label} decoded to a non-canonical kernel number`,
      {
        code: "invalid_decoded_kernel_record",
        details: { value },
      }
    );
  }

  return value;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeDeterministicScalar(value: string): Uint8Array {
  return new Uint8Array(deterministicScalarEncoder.encode(value));
}

function compareByteArrays(
  leftBytes: Uint8Array,
  rightBytes: Uint8Array
): number {
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);

  for (let index = 0; index < sharedLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] < rightBytes[index] ? -1 : 1;
    }
  }

  if (leftBytes.length === rightBytes.length) {
    return 0;
  }

  return leftBytes.length < rightBytes.length ? -1 : 1;
}

function areByteArraysEqual(
  leftBytes: Uint8Array,
  rightBytes: Uint8Array
): boolean {
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return false;
    }
  }

  return true;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

async function hashBytesToHex(bytes: Uint8Array): Promise<HashString> {
  const digestInput = getDigestInput(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  assertHashString(hash, "hash");
  return hash;
}

function getDigestInput(bytes: Uint8Array): BufferSource {
  const { buffer, byteLength, byteOffset } = bytes;

  if (!(buffer instanceof ArrayBuffer)) {
    return Uint8Array.from(bytes);
  }

  if (byteOffset === 0 && byteLength === buffer.byteLength) {
    return buffer;
  }

  return buffer.slice(byteOffset, byteOffset + byteLength);
}
