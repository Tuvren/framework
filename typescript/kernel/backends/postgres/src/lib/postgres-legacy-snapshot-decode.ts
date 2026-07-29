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

/**
 * Retired blob-era snapshot decode surface (ADR-067 / issue #110). This
 * module's only production reader is the one-time open-time migration in
 * `postgres-blob-migration.ts`, which lazily imports it (via
 * `postgres-schema-init.ts`'s `migrateLegacyBlobSnapshotsIfPresent`) to
 * explode a pre-#110 database's legacy `backend_postgres_snapshots` blob
 * table into the relational family tables. No live write path in this
 * package still produces this wire format — the relational rewrite retired
 * every production writer of it (there is no `snapshot_cbor` column left to
 * populate) — and no eagerly-imported module in this package reaches this
 * file, so the decoder's ~265 lines of shape-validation machinery stay out
 * of the module graph every backend construction actually walks. Tests that
 * exercise this decode path directly import it from this module path (see
 * `test/legacy-snapshot-encoder.ts`, the writer half kept test-only, and
 * `test/backend-postgres.blob-migration.test.ts`).
 */

import {
  assertStoredBranch,
  assertStoredObject,
  assertStoredObserveAnnotation,
  assertStoredOrderedPathChunk,
  assertStoredRun,
  assertStoredSchema,
  assertStoredStagedResult,
  assertStoredThread,
  assertStoredTurn,
  assertStoredTurnNode,
  assertStoredTurnTree,
  assertStoredTurnTreePath,
  decodeDeterministicKernelRecord,
  type StoredStagedResult,
  type StoredTurnTree,
  type StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import { persistenceError } from "./postgres-errors.js";
import {
  type BackendState,
  createEmptyState,
  decodeTurnTreeSchema,
} from "./postgres-records.js";
import {
  cloneStoredBranch,
  cloneStoredObject,
  cloneStoredObserveAnnotation,
  cloneStoredOrderedPathChunk,
  cloneStoredRun,
  cloneStoredSchema,
  cloneStoredStagedResult,
  cloneStoredThread,
  cloneStoredTurn,
  cloneStoredTurnNode,
  cloneStoredTurnTree,
  cloneStoredTurnTreePath,
} from "./postgres-state-utils.js";

/** Wire-format version stamped into every encoded snapshot payload. */
export const CURRENT_SNAPSHOT_VERSION = 1;

/**
 * Decodes the snapshot wire format back into a `BackendState`, re-validating
 * every record with the kernel-protocol `assertStored*` guards as it is
 * inserted (schema records first, since turn trees and turn tree paths need
 * their schema to validate) and checking the payload's schema version.
 *
 * The only production consumer is the one-time blob→row migration
 * (`postgres-blob-migration.ts`'s `explodeLegacyBlobSnapshots`, which decodes
 * a pre-#110 database's legacy `backend_postgres_snapshots` blob); tests that
 * exercise this decode path directly do so against a snapshot payload built
 * by the test-only `encodeSnapshot` in `test/legacy-snapshot-encoder.ts` (the
 * writer side of this wire format retired from production source once
 * ADR-067's relational schema replaced blob-per-scope persistence).
 *
 * @throws TuvrenPersistenceError with code `postgres_backend_snapshot_payload_invalid`
 *   when the payload or a field's shape is malformed, or
 *   `postgres_backend_snapshot_payload_version_unsupported` when the
 *   embedded version does not match {@link CURRENT_SNAPSHOT_VERSION}.
 */
export function decodeSnapshot(value: Uint8Array): BackendState {
  const decoded = decodeDeterministicKernelRecord(toUint8Array(value));
  const snapshot = readSnapshotRecord(decoded);
  const state = createEmptyState();

  for (const record of readSnapshotArray(
    snapshot.objects,
    assertStoredObject,
    "objects"
  )) {
    state.objects.set(record.hash, cloneStoredObject(record));
  }

  for (const record of readSnapshotArray(
    snapshot.schemas,
    assertStoredSchema,
    "schemas"
  )) {
    state.schemas.set(record.schemaId, cloneStoredSchema(record));
  }

  for (const [index, record] of readUntypedSnapshotArray(
    snapshot.turnTrees,
    "turnTrees"
  ).entries()) {
    const candidate = record as StoredTurnTree;
    const schema = getSchemaForSchemaId(
      state,
      candidate.schemaId,
      `turnTrees[${index}].schemaId`
    );
    assertStoredTurnTree(candidate, schema, `turnTrees[${index}]`);
    state.turnTrees.set(candidate.hash, cloneStoredTurnTree(candidate));
  }

  for (const record of readSnapshotArray(
    snapshot.orderedPathChunks,
    assertStoredOrderedPathChunk,
    "orderedPathChunks"
  )) {
    state.orderedPathChunks.set(
      record.chunkHash,
      cloneStoredOrderedPathChunk(record)
    );
  }

  for (const [index, record] of readUntypedSnapshotArray(
    snapshot.turnTreePaths,
    "turnTreePaths"
  ).entries()) {
    const candidate = record as StoredTurnTreePath;
    const turnTree = state.turnTrees.get(candidate.turnTreeHash);

    if (turnTree === undefined) {
      throw persistenceError(
        "postgres backend snapshot turn tree path references an unknown turn tree",
        "postgres_backend_snapshot_payload_invalid",
        {
          index,
          turnTreeHash: candidate.turnTreeHash,
        }
      );
    }

    const schema = getSchemaForTurnTree(state, turnTree);
    assertStoredTurnTreePath(candidate, schema, `turnTreePaths[${index}]`);
    const treePaths =
      state.turnTreePaths.get(candidate.turnTreeHash) ??
      new Map<string, StoredTurnTreePath>();
    treePaths.set(candidate.path, cloneStoredTurnTreePath(candidate));
    state.turnTreePaths.set(candidate.turnTreeHash, treePaths);
  }

  for (const record of readSnapshotArray(
    snapshot.turnNodes,
    assertStoredTurnNode,
    "turnNodes"
  )) {
    state.turnNodes.set(record.hash, cloneStoredTurnNode(record));
  }

  for (const record of readSnapshotArray(
    snapshot.threads,
    assertStoredThread,
    "threads"
  )) {
    state.threads.set(record.threadId, cloneStoredThread(record));
  }

  for (const record of readSnapshotArray(
    snapshot.branches,
    assertStoredBranch,
    "branches"
  )) {
    state.branches.set(record.branchId, cloneStoredBranch(record));
  }

  for (const record of readSnapshotArray(
    snapshot.turns,
    assertStoredTurn,
    "turns"
  )) {
    state.turns.set(record.turnId, cloneStoredTurn(record));
  }

  for (const record of readSnapshotArray(
    snapshot.runs,
    assertStoredRun,
    "runs"
  )) {
    state.runs.set(record.runId, cloneStoredRun(record));
  }

  for (const record of readSnapshotArray(
    snapshot.stagedResults,
    assertStoredStagedResult,
    "stagedResults"
  )) {
    const runResults =
      state.stagedResults.get(record.runId) ??
      new Map<string, StoredStagedResult>();
    runResults.set(record.taskId, cloneStoredStagedResult(record));
    state.stagedResults.set(record.runId, runResults);
  }

  for (const record of readSnapshotArray(
    snapshot.observeAnnotations,
    assertStoredObserveAnnotation,
    "observeAnnotations"
  )) {
    const runAnnotations = state.observeAnnotations.get(record.runId) ?? [];
    runAnnotations.push(cloneStoredObserveAnnotation(record));
    state.observeAnnotations.set(record.runId, runAnnotations);
  }

  const version = readSnapshotVersion(snapshot.version);

  if (version !== CURRENT_SNAPSHOT_VERSION) {
    throw persistenceError(
      "postgres backend snapshot payload version is unsupported",
      "postgres_backend_snapshot_payload_version_unsupported",
      { actualVersion: version, expectedVersion: CURRENT_SNAPSHOT_VERSION }
    );
  }

  return state;
}

// Snapshot-decoding helpers below validate the raw decoded CBOR value's
// shape before `decodeSnapshot` hands it to the kernel-protocol `assertStored*`
// guards, so a malformed snapshot payload fails with a clear
// `postgres_backend_snapshot_payload_invalid` error instead of a confusing
// downstream type error.

/** Asserts the decoded snapshot root is a plain object. */
function readSnapshotRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw persistenceError(
      "postgres backend snapshot payload must be an object",
      "postgres_backend_snapshot_payload_invalid"
    );
  }

  return value as Record<string, unknown>;
}

/** Asserts a snapshot field is an array and validates every element with `assertRecord`. */
function readSnapshotArray<T>(
  value: unknown,
  assertRecord: (value: unknown, label: string) => asserts value is T,
  label: string
): T[] {
  if (!Array.isArray(value)) {
    throw persistenceError(
      `postgres backend snapshot field "${label}" must be an array`,
      "postgres_backend_snapshot_payload_invalid",
      { label }
    );
  }

  return value.map((entry, index) => {
    assertRecord(entry, `${label}[${index}]`);
    return entry;
  });
}

/**
 * Asserts a snapshot field is an array without validating element shape —
 * used where the element type still needs its schema resolved (turn trees,
 * turn tree paths) before it can be asserted.
 */
function readUntypedSnapshotArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw persistenceError(
      `postgres backend snapshot field "${label}" must be an array`,
      "postgres_backend_snapshot_payload_invalid",
      { label }
    );
  }

  return value;
}

/** Asserts the decoded snapshot's `version` field is a safe integer. */
function readSnapshotVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw persistenceError(
      "postgres backend snapshot version must be an integer",
      "postgres_backend_snapshot_payload_invalid",
      { field: "version" }
    );
  }

  return value;
}

/** Copies a possibly-driver-specific byte buffer into a plain `Uint8Array`. */
function toUint8Array(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

/** Resolves a turn-tree schema by id from a decoded snapshot state. */
function getSchemaForSchemaId(
  state: BackendState,
  schemaId: string,
  label: string
) {
  const record = state.schemas.get(schemaId);
  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing schema`,
      "postgres_backend_missing_schema_reference",
      { label, schemaId }
    );
  }
  return decodeTurnTreeSchema(record.schemaCbor, `${label} schema`);
}

/** Resolves the turn-tree schema referenced by a stored turn tree. */
function getSchemaForTurnTree(
  state: BackendState,
  turnTree: { schemaId: string }
) {
  return getSchemaForSchemaId(state, turnTree.schemaId, "turnTree.schemaId");
}
