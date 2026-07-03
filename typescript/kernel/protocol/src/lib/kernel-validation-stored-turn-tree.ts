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
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnTreeIdentity,
} from "./kernel-identity.js";
import type {
  PathCollectionKind,
  StoredObject,
  StoredOrderedPathChunk,
  StoredSchema,
  StoredTurnTree,
  StoredTurnTreePath,
  TurnTreeManifest,
  TurnTreeSchema,
} from "./kernel-types.js";
import {
  assertPathCollectionKind,
  assertSchemaPath,
  assertTurnTreeManifest,
  assertTurnTreeSchema,
} from "./kernel-validation-runtime.js";
import {
  assertAllowedObjectKeys,
  assertDecodedHashStringArray,
  assertDecodedHashStringArrayCardinality,
  assertDecodedKernelRecord,
  assertEpochMs,
  assertHashString,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertNullableHashString,
  assertOptionalFieldIsOmittedWhenUndefined,
  assertPlainObject,
  assertUint8Array,
  isStringLiteral,
  tryAssert,
  validationError,
} from "./kernel-validation-shared.js";

const ORDERED_ENCODINGS = ["flat", "chunked"] as const;

interface StoredTurnTreePathCandidate {
  collectionKind: PathCollectionKind;
  orderedChunkListCbor?: Uint8Array;
  orderedCount?: number;
  orderedEncoding?: "flat" | "chunked";
  orderedInlineCbor?: Uint8Array;
  path: string;
  singleHash?: string | null;
  turnTreeHash: string;
}

export function isStoredObject(value: unknown): value is StoredObject {
  return tryAssert(value, assertStoredObject);
}

export function assertStoredObject(
  value: unknown,
  label = "value"
): asserts value is StoredObject {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["byteLength", "bytes", "createdAtMs", "hash", "mediaType"],
    label
  );

  assertHashString(objectValue.hash, `${label}.hash`);
  assertNonEmptyString(objectValue.mediaType, `${label}.mediaType`);
  assertUint8Array(objectValue.bytes, `${label}.bytes`);
  assertNonNegativeInteger(objectValue.byteLength, `${label}.byteLength`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);

  if (objectValue.byteLength !== objectValue.bytes.byteLength) {
    throw validationError(
      `${label}.byteLength must match ${label}.bytes.byteLength`,
      "invalid_stored_object_byte_length",
      {
        actualByteLength: objectValue.bytes.byteLength,
        byteLength: objectValue.byteLength,
      }
    );
  }
}

export async function assertStoredObjectIdentity(
  value: unknown,
  label = "value"
): Promise<void> {
  assertStoredObject(value, label);

  const expectedHash = await hashOpaqueObjectBytes(value.bytes);

  if (value.hash !== expectedHash) {
    throw validationError(
      `${label}.hash must match the SHA-256 digest of ${label}.bytes`,
      "invalid_stored_object_hash",
      {
        expectedHash,
        hash: value.hash,
      }
    );
  }
}

export function isStoredSchema(value: unknown): value is StoredSchema {
  return tryAssert(value, assertStoredSchema);
}

export function assertStoredSchema(
  value: unknown,
  label = "value"
): asserts value is StoredSchema {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["createdAtMs", "schemaCbor", "schemaId"],
    label
  );
  const schemaCbor = objectValue.schemaCbor;
  const schemaId = objectValue.schemaId;

  assertNonEmptyString(schemaId, `${label}.schemaId`);
  assertUint8Array(schemaCbor, `${label}.schemaCbor`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  const decodedSchema = assertDecodedKernelRecord(
    schemaCbor,
    assertTurnTreeSchema,
    `${label}.schemaCbor`
  );

  if (decodedSchema.schemaId !== schemaId) {
    throw validationError(
      `${label}.schemaId must match the decoded schemaId in ${label}.schemaCbor`,
      "invalid_stored_schema_id",
      {
        decodedSchemaId: decodedSchema.schemaId,
        schemaId,
      }
    );
  }
}

export function isStoredTurnTree(value: unknown): value is StoredTurnTree {
  return tryAssert(
    value,
    (candidate, innerLabel = "value"): asserts candidate is StoredTurnTree => {
      assertStoredTurnTreeShape(candidate, innerLabel);
    }
  );
}

export function assertStoredTurnTree(
  value: unknown,
  schema: TurnTreeSchema,
  label?: string
): asserts value is StoredTurnTree;
export function assertStoredTurnTree(
  value: unknown,
  schema: TurnTreeSchema,
  label = "value"
): asserts value is StoredTurnTree {
  assertTurnTreeSchema(schema, "schema");
  const resolvedLabel = label;
  const objectValue = assertStoredTurnTreeShape(value, resolvedLabel);
  assertAllowedObjectKeys(
    objectValue,
    ["createdAtMs", "hash", "manifestCbor", "schemaId"],
    resolvedLabel
  );
  const manifestCbor = objectValue.manifestCbor;

  if (schema.schemaId !== objectValue.schemaId) {
    throw validationError(
      `${resolvedLabel}.schemaId must match schema.schemaId`,
      "invalid_stored_turn_tree_schema_id",
      {
        expectedSchemaId: schema.schemaId,
        schemaId: objectValue.schemaId,
      }
    );
  }

  assertDecodedKernelRecord(
    manifestCbor,
    (
      decodedValue: unknown,
      manifestLabel: string
    ): asserts decodedValue is TurnTreeManifest => {
      assertTurnTreeManifest(decodedValue, schema, manifestLabel);
    },
    `${resolvedLabel}.manifestCbor`
  );
}

export async function assertStoredTurnTreeIdentity(
  value: unknown,
  schema: TurnTreeSchema,
  label?: string
): Promise<void>;
export async function assertStoredTurnTreeIdentity(
  value: unknown,
  schema: TurnTreeSchema,
  label = "value"
): Promise<void> {
  assertTurnTreeSchema(schema, "schema");
  const resolvedLabel = label;
  assertStoredTurnTree(value, schema, resolvedLabel);

  const manifest = assertDecodedKernelRecord<TurnTreeManifest>(
    value.manifestCbor,
    (decodedValue, manifestLabel) =>
      assertTurnTreeManifest(decodedValue, schema, manifestLabel),
    `${resolvedLabel}.manifestCbor`
  );
  const expectedHash = await hashTurnTreeIdentity(
    value.schemaId,
    manifest,
    schema
  );

  if (value.hash !== expectedHash) {
    throw validationError(
      `${resolvedLabel}.hash must match the deterministic hash of ${resolvedLabel}.schemaId and ${resolvedLabel}.manifestCbor`,
      "invalid_stored_turn_tree_hash",
      {
        expectedHash,
        hash: value.hash,
      }
    );
  }
}

export function isStoredTurnTreePath(
  value: unknown
): value is StoredTurnTreePath {
  return tryAssert(value, assertStoredTurnTreePath);
}

export function assertStoredTurnTreePath(
  value: unknown,
  label?: string
): asserts value is StoredTurnTreePath;
export function assertStoredTurnTreePath(
  value: unknown,
  schema: TurnTreeSchema,
  label?: string
): asserts value is StoredTurnTreePath;
export function assertStoredTurnTreePath(
  value: unknown,
  schemaOrLabel?: string | TurnTreeSchema,
  label = "value"
): asserts value is StoredTurnTreePath {
  const { schema, resolvedLabel } = resolveSchemaAndLabel(
    schemaOrLabel,
    label,
    "schema"
  );
  const objectValue = assertPlainObject(value, resolvedLabel);
  assertAllowedObjectKeys(
    objectValue,
    [
      "collectionKind",
      "orderedChunkListCbor",
      "orderedCount",
      "orderedEncoding",
      "orderedInlineCbor",
      "path",
      "singleHash",
      "turnTreeHash",
    ],
    resolvedLabel
  );
  const turnTreeHash = objectValue.turnTreeHash;
  const path = objectValue.path;
  const collectionKind = objectValue.collectionKind;
  const singleHash = objectValue.singleHash;
  const orderedEncoding = objectValue.orderedEncoding;
  const orderedCount = objectValue.orderedCount;
  const orderedInlineCbor = objectValue.orderedInlineCbor;
  const orderedChunkListCbor = objectValue.orderedChunkListCbor;

  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "singleHash",
    resolvedLabel
  );
  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "orderedEncoding",
    resolvedLabel
  );
  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "orderedCount",
    resolvedLabel
  );
  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "orderedInlineCbor",
    resolvedLabel
  );
  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "orderedChunkListCbor",
    resolvedLabel
  );
  assertHashString(turnTreeHash, `${resolvedLabel}.turnTreeHash`);
  assertSchemaPath(path, `${resolvedLabel}.path`);
  assertPathCollectionKind(collectionKind, `${resolvedLabel}.collectionKind`);

  if (singleHash !== undefined) {
    assertNullableHashString(singleHash, `${resolvedLabel}.singleHash`);
  }

  if (
    orderedEncoding !== undefined &&
    !isStringLiteral(orderedEncoding, ORDERED_ENCODINGS)
  ) {
    throw validationError(
      `${resolvedLabel}.orderedEncoding must be "flat" or "chunked"`,
      "invalid_ordered_encoding",
      { value: orderedEncoding }
    );
  }

  if (orderedCount !== undefined) {
    assertNonNegativeInteger(orderedCount, `${resolvedLabel}.orderedCount`);
  }

  if (orderedInlineCbor !== undefined) {
    assertUint8Array(orderedInlineCbor, `${resolvedLabel}.orderedInlineCbor`);
  }

  if (orderedChunkListCbor !== undefined) {
    assertUint8Array(
      orderedChunkListCbor,
      `${resolvedLabel}.orderedChunkListCbor`
    );
  }

  assertStoredTurnTreePathShape(
    {
      collectionKind,
      orderedChunkListCbor,
      orderedCount,
      orderedEncoding,
      orderedInlineCbor,
      path,
      singleHash,
      turnTreeHash,
    },
    resolvedLabel
  );

  if (schema !== undefined) {
    assertStoredTurnTreePathMatchesSchema(
      {
        collectionKind,
        orderedChunkListCbor,
        orderedCount,
        orderedEncoding,
        orderedInlineCbor,
        path,
        singleHash,
        turnTreeHash,
      },
      schema,
      resolvedLabel
    );
  }
}

export function isStoredOrderedPathChunk(
  value: unknown
): value is StoredOrderedPathChunk {
  return tryAssert(value, assertStoredOrderedPathChunk);
}

export function assertStoredOrderedPathChunk(
  value: unknown,
  label = "value"
): asserts value is StoredOrderedPathChunk {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["chunkHash", "createdAtMs", "itemCount", "itemsCbor"],
    label
  );

  assertHashString(objectValue.chunkHash, `${label}.chunkHash`);
  assertNonNegativeInteger(objectValue.itemCount, `${label}.itemCount`);
  assertUint8Array(objectValue.itemsCbor, `${label}.itemsCbor`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  assertDecodedHashStringArrayCardinality(
    objectValue.itemsCbor,
    objectValue.itemCount,
    `${label}.itemsCbor`,
    `${label}.itemCount`
  );
}

export async function assertStoredOrderedPathChunkIdentity(
  value: unknown,
  label = "value"
): Promise<void> {
  assertStoredOrderedPathChunk(value, label);

  const items = assertDecodedHashStringArray(
    value.itemsCbor,
    `${label}.itemsCbor`
  );
  const expectedHash = await hashKernelRecord(items);

  if (value.chunkHash !== expectedHash) {
    throw validationError(
      `${label}.chunkHash must match the deterministic hash of ${label}.itemsCbor`,
      "invalid_stored_ordered_path_chunk_hash",
      {
        expectedHash,
        hash: value.chunkHash,
      }
    );
  }
}

function assertStoredTurnTreePathShape(
  value: StoredTurnTreePathCandidate,
  label: string
): void {
  if (value.collectionKind === "single") {
    assertStoredSingleTurnTreePathShape(value, label);
    return;
  }

  assertStoredOrderedTurnTreePathShape(value, label);
}

function assertStoredSingleTurnTreePathShape(
  value: StoredTurnTreePathCandidate,
  label: string
): void {
  if (value.singleHash === undefined) {
    throw validationError(
      `${label}.singleHash is required when collectionKind is "single"`,
      "invalid_stored_turn_tree_path_shape",
      { collectionKind: value.collectionKind }
    );
  }

  if (
    value.orderedEncoding !== undefined ||
    value.orderedCount !== undefined ||
    value.orderedInlineCbor !== undefined ||
    value.orderedChunkListCbor !== undefined
  ) {
    throw validationError(
      `${label} must not include ordered-path fields when collectionKind is "single"`,
      "invalid_stored_turn_tree_path_shape",
      { collectionKind: value.collectionKind }
    );
  }
}

function assertStoredOrderedTurnTreePathShape(
  value: StoredTurnTreePathCandidate,
  label: string
): void {
  if (value.singleHash !== undefined) {
    throw validationError(
      `${label}.singleHash must be omitted when collectionKind is "ordered"`,
      "invalid_stored_turn_tree_path_shape",
      { collectionKind: value.collectionKind }
    );
  }

  if (value.orderedEncoding === undefined) {
    throw validationError(
      `${label}.orderedEncoding is required when collectionKind is "ordered"`,
      "invalid_stored_turn_tree_path_shape",
      { collectionKind: value.collectionKind }
    );
  }

  if (value.orderedCount === undefined) {
    throw validationError(
      `${label}.orderedCount is required when collectionKind is "ordered"`,
      "invalid_stored_turn_tree_path_shape",
      { collectionKind: value.collectionKind }
    );
  }

  if (value.orderedEncoding === "flat") {
    assertStoredFlatTurnTreePathShape(value, label);
    return;
  }

  assertStoredChunkedTurnTreePathShape(value, label);
}

function assertStoredFlatTurnTreePathShape(
  value: StoredTurnTreePathCandidate,
  label: string
): void {
  if (value.orderedInlineCbor === undefined) {
    throw validationError(
      `${label}.orderedInlineCbor is required when orderedEncoding is "flat"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }

  if (value.orderedChunkListCbor !== undefined) {
    throw validationError(
      `${label}.orderedChunkListCbor must be omitted when orderedEncoding is "flat"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }

  const orderedCount = value.orderedCount;

  if (orderedCount === undefined) {
    throw validationError(
      `${label}.orderedCount is required when orderedEncoding is "flat"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }

  assertDecodedHashStringArrayCardinality(
    value.orderedInlineCbor,
    orderedCount,
    `${label}.orderedInlineCbor`,
    `${label}.orderedCount`
  );
}

function assertStoredChunkedTurnTreePathShape(
  value: StoredTurnTreePathCandidate,
  label: string
): void {
  if (value.orderedChunkListCbor === undefined) {
    throw validationError(
      `${label}.orderedChunkListCbor is required when orderedEncoding is "chunked"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }

  if (value.orderedInlineCbor !== undefined) {
    throw validationError(
      `${label}.orderedInlineCbor must be omitted when orderedEncoding is "chunked"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }

  const chunkHashes = assertDecodedHashStringArray(
    value.orderedChunkListCbor,
    `${label}.orderedChunkListCbor`
  );
  const orderedCount = value.orderedCount;

  if (orderedCount === undefined) {
    throw validationError(
      `${label}.orderedCount is required when orderedEncoding is "chunked"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }

  if (orderedCount === 0 && chunkHashes.length !== 0) {
    throw validationError(
      `${label}.orderedChunkListCbor must be empty when ${label}.orderedCount is 0`,
      "invalid_stored_turn_tree_path_shape",
      { chunkCount: chunkHashes.length, orderedCount }
    );
  }

  if (orderedCount === 0) {
    throw validationError(
      `${label} must use flat ordered storage when ${label}.orderedCount is 0`,
      "invalid_stored_turn_tree_path_shape",
      { orderedCount }
    );
  }

  if (orderedCount > 0 && chunkHashes.length === 0) {
    throw validationError(
      `${label}.orderedChunkListCbor must contain at least one chunk when ${label}.orderedCount is positive`,
      "invalid_stored_turn_tree_path_shape",
      { chunkCount: chunkHashes.length, orderedCount }
    );
  }
}

function assertStoredTurnTreePathMatchesSchema(
  value: StoredTurnTreePathCandidate,
  schema: TurnTreeSchema,
  label: string
): void {
  const pathDefinition = schema.paths.find(
    (definition) => definition.path === value.path
  );

  if (pathDefinition === undefined) {
    throw validationError(
      `${label}.path must reference a schema-defined path`,
      "unknown_turn_tree_path",
      { path: value.path, schemaId: schema.schemaId }
    );
  }

  if (pathDefinition.collection !== value.collectionKind) {
    throw validationError(
      `${label}.collectionKind must match the schema collection for ${label}.path`,
      "invalid_turn_tree_path_collection_kind",
      {
        collectionKind: value.collectionKind,
        expectedCollectionKind: pathDefinition.collection,
        path: value.path,
      }
    );
  }
}

function resolveSchemaAndLabel(
  schemaOrLabel: string | TurnTreeSchema | undefined,
  label: string,
  schemaLabel: string
): {
  resolvedLabel: string;
  schema?: TurnTreeSchema;
} {
  if (schemaOrLabel === undefined) {
    return { resolvedLabel: label };
  }

  if (typeof schemaOrLabel === "string") {
    return { resolvedLabel: schemaOrLabel };
  }

  assertTurnTreeSchema(schemaOrLabel, schemaLabel);
  return {
    resolvedLabel: label,
    schema: schemaOrLabel,
  };
}

function assertStoredTurnTreeShape(
  value: unknown,
  label: string
): {
  createdAtMs: unknown;
  hash: unknown;
  manifestCbor: Uint8Array;
  schemaId: unknown;
} {
  const objectValue = assertPlainObject(value, label);

  assertAllowedObjectKeys(
    objectValue,
    ["createdAtMs", "hash", "manifestCbor", "schemaId"],
    label
  );
  assertHashString(objectValue.hash, `${label}.hash`);
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertUint8Array(objectValue.manifestCbor, `${label}.manifestCbor`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);

  return {
    createdAtMs: objectValue.createdAtMs,
    hash: objectValue.hash,
    manifestCbor: objectValue.manifestCbor,
    schemaId: objectValue.schemaId,
  };
}
