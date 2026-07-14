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

// biome-ignore-all lint/performance/noBarrelFile: This focused contract subpath intentionally re-exports deterministic identity helpers alongside local identity guards.

import type { HashString, KernelRecord } from "@tuvren/core";
import {
  assertEpochMs,
  assertHashString,
  assertKernelRecord,
  TuvrenValidationError,
} from "@tuvren/core";
import type {
  StagedResult,
  TurnNode,
  TurnTreeManifest,
  TurnTreeSchema,
} from "./kernel-types.js";

export {
  canonicalizeKernelRecord,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
} from "./kernel-record-identity.js";

import { hashKernelRecord } from "./kernel-record-identity.js";

/**
 * Allowed {@link StagedResult} statuses, mirrored locally for identity-input
 * validation.
 */
const STAGED_RESULT_STATUSES = ["completed", "failed", "interrupted"] as const;

/**
 * Computes a TurnTree's content-address from its identity tuple
 * `{ schemaId, manifest }` (docs/KrakenKernelSpecification.md §3.2).
 *
 * The manifest is validated as a full manifest against the supplied schema
 * before hashing: every schema path must be present, every manifest path must be
 * schema-defined, and each value must match its path's collection kind
 * (`HashString[]` for `"ordered"`, `HashString | null` for `"single"`). The hash
 * is the SHA-256 digest of the canonical deterministic CBOR encoding of the
 * identity record (see {@link hashKernelRecord}).
 *
 * @param schemaId - Schema identity; must equal `schema.schemaId`.
 * @param manifest - Full path-to-value manifest of the tree.
 * @param schema - Registered schema the manifest must conform to; itself
 *   validated against the registration rules of kernel spec §3.1.
 * @returns The TurnTree hash.
 * @throws TuvrenValidationError With code `invalid_turn_tree_hash` when the
 *   manifest, schema, or schemaId pairing is invalid.
 */
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

/**
 * Computes a TurnNode's content-address from all identity fields except `hash`
 * itself (docs/KrakenKernelSpecification.md §3.3).
 *
 * The input is strictly validated as a contract-shaped TurnNode identity:
 * unknown keys are rejected, hash fields must be valid `HashString`s,
 * `consumedStagedResults` must be a dense data-only array with unique `taskId`s,
 * and `interruptPayload` must be present exactly when a staged result's status
 * is `"interrupted"`. Staged results are projected onto their contract fields
 * before hashing so extra runtime state can never leak into identity. Committed
 * cross-language vectors for this digest live in
 * spec/conformance/kernel/fixtures/kernel-protocol-deterministic.json.
 *
 * @param value - TurnNode identity fields; an existing `hash` field is accepted
 *   but excluded from the digest.
 * @returns The TurnNode hash.
 * @throws TuvrenValidationError With code `invalid_turn_node_hash` when the
 *   input is not a valid TurnNode identity payload.
 */
export async function hashTurnNodeIdentity(
  value: Omit<TurnNode, "hash"> | TurnNode
): Promise<HashString> {
  const turnNodeValue = assertTurnNodeIdentityInput(value);
  return await hashKernelRecord(toTurnNodeIdentityRecord(turnNodeValue));
}

/**
 * Projects a TurnNode onto its identity record: every contract field except
 * `hash`, with each consumed staged result reduced to contract fields only
 * (`interruptPayload` included only when present).
 */
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

/**
 * Validates and normalizes a TurnNode identity input: contract keys only, valid
 * hash fields, and a dense staged-result array with unique `taskId`s. Returns a
 * null-prototype copy with normalized staged results.
 */
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

/**
 * Validates one staged result and returns a fresh object containing only
 * contract fields, with `interruptPayload` present exactly when `status` is
 * `"interrupted"`.
 */
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

/**
 * Rejects arrays with holes, symbol keys, accessors, or non-index own
 * properties, so identity hashing only ever sees pure data.
 */
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

/**
 * Rejects duplicate staged-result `taskId`s: identity is `taskId` within the
 * owning Run (kernel spec §3.4).
 */
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

/**
 * Enforces that `interruptPayload` is present when `status` is `"interrupted"`
 * and omitted otherwise.
 */
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

/**
 * Rejects any own key outside the declared contract shape.
 */
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

/**
 * Validates a full TurnTree manifest against its schema: every schema path must
 * be present, no unknown paths, and each value must match its path's collection
 * kind (kernel spec §3.2).
 */
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

/**
 * Validates one manifest value against its collection kind: `HashString | null`
 * for `"single"` paths, an array of `HashString`s for `"ordered"` paths.
 */
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

/**
 * Validates a TurnTreeSchema against the registration rules of kernel spec §3.1
 * / Appendix B: contract keys only, non-empty `schemaId`, valid path
 * definitions, and consistent incorporation rules.
 */
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

/**
 * Validates schema path definitions: dot-separated non-empty paths, collection
 * kinds limited to `"ordered"` / `"single"`, optional `metadata` as a
 * KernelRecord, and no duplicate paths (kernel spec §3.1).
 */
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

/**
 * Validates incorporation rules: every `targetPath` must reference a defined
 * schema path and `objectType` mappings must be unique (kernel spec §3.1).
 */
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

/**
 * Array-shape guard mirroring `assertDenseDataArray`, but throwing the
 * TurnTree-identity error code.
 */
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

/**
 * Plain-object guard mirroring `assertPlainObjectRecord`, but throwing the
 * TurnTree-identity error code. Returns a null-prototype copy of the record.
 */
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

/**
 * Non-empty-string guard throwing the TurnTree-identity error code.
 */
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

/**
 * Validates a schema path: a non-empty, dot-separated string with non-empty
 * segments.
 */
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

/**
 * HashString guard that rethrows core validation failures with the
 * TurnTree-identity error code.
 */
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

/**
 * Rejects non-plain objects (class instances, symbol keys, accessors) and
 * returns a null-prototype copy, so identity input is prototype-free data.
 */
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

/**
 * Optional contract fields must be omitted rather than set to `undefined`, so
 * field presence stays unambiguous across encodings.
 */
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

/**
 * HashString guard that rethrows core validation failures with the
 * TurnNode-identity error code.
 */
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

/**
 * Accepts `null` or a valid HashString; rejects everything else with the
 * TurnNode-identity error code.
 */
function assertNullableHashStringOrThrow(
  value: unknown,
  label: string
): asserts value is HashString | null {
  if (value === null) {
    return;
  }

  assertHashStringOrThrow(value, label);
}

/**
 * Non-empty-string guard throwing the TurnNode-identity error code.
 */
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

/**
 * Guards that a value is one of the allowed StagedResult statuses.
 */
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

/**
 * True for objects whose prototype is `Object.prototype` or `null`.
 */
function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Builds a TuvrenValidationError with code `invalid_turn_node_hash`.
 */
function turnNodeIdentityError(
  message: string,
  details: unknown
): TuvrenValidationError {
  return new TuvrenValidationError(message, {
    code: "invalid_turn_node_hash",
    details,
  });
}

/**
 * Builds a TuvrenValidationError with code `invalid_turn_tree_hash`.
 */
function turnTreeIdentityError(
  message: string,
  details: unknown
): TuvrenValidationError {
  return new TuvrenValidationError(message, {
    code: "invalid_turn_tree_hash",
    details,
  });
}
