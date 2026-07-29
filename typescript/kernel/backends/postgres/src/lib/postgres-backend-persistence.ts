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

import type { PhaseObserver } from "@tuvren/backend-shared";
import type { EpochMs, Scope } from "@tuvren/core";
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
import postgres, { type Sql } from "postgres";
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
const VALID_SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Connection and partition options for the PostgreSQL backend's persistence layer. */
export interface PostgresBackendPersistenceOptions {
  connectionString?: string;
  database?: string;
  host?: string;
  now?: () => EpochMs;
  password?: string;
  /**
   * Phase-attribution seam (issue #108) for the relational persistence
   * path's per-transaction costs (ADR-067), sharing the same
   * {@link PersistencePhase} vocabulary as the SQLite backend: `lock-wait`
   * covers both waiting on the in-process transaction queue and waiting on
   * the database-level same-scope advisory lock (there are no row locks to
   * wait on here — Postgres's MVCC readers never block on a writer); `load`
   * is the maintenance-path cost of reading a record family's rows into an
   * in-memory projection; the four named `validate-*` phases
   * (`validate-loaded`, `validate-lineage-index`, `validate-committed`,
   * `validate-write-set`) and `validate-reclaim-survivors` are the distinct
   * validation passes `loadValidatedState`, `transact`, and `reclaim` each
   * run, not one undifferentiated `validate` phase; and `write` covers both
   * `COMMIT` on the transaction path and the maintenance paths' bulk row
   * deletions. A one-time `blob-migration` phase also reports the cost of
   * exploding a legacy blob-per-scope snapshot into its relational rows the
   * first time a pre-#110 schema is opened. Defaults to
   * {@link NOOP_PHASE_OBSERVER}, so omitting it costs one shared frozen no-op
   * call per phase and never changes measured production bytes or behavior.
   * Benches/tests supply a recording observer instead.
   */
  phaseObserver?: PhaseObserver;
  port?: number;
  schemaName?: string;
  /**
   * Host-supplied partition identity bound at construction (ADR-048).
   *
   * Isolation is realized as a `scope` column on every family table's primary
   * and foreign keys (ADR-067's one-table-per-record-family relational
   * schema), giving row-level isolation in a shared schema (ADR-049). Two
   * backends sharing a schema (the same database) but bound to different
   * Scopes therefore read and write disjoint rows across every table and can
   * never observe each other's state, with no cross-scope dedup. When
   * omitted, the backend binds the default Scope, so existing single-scope
   * databases keep working unchanged. Must be a non-empty string.
   */
  scope?: Scope;
  username?: string;
}

/**
 * Creates a `postgres` client configured for single-connection,
 * non-prepared-statement use (`max: 1`, `prepare: false`). Prefers
 * `options.connectionString` when set, otherwise builds the connection from
 * the discrete fields.
 *
 * `max: 1` is load-bearing: the backend's in-process transaction queue
 * (ADR-067) already serializes every `transact`/`reclaim` call onto a single
 * logical writer, so a single physical connection is enough and avoids paying
 * for a pool the backend never uses concurrently. `prepare: false` keeps the
 * client compatible with transaction-mode connection poolers (which cannot
 * hold named prepared statements across pooled connections) and avoids
 * accumulating named-statement state on the one connection. Prepared
 * statements remain a candidate optimization if per-statement query planning
 * ever shows up as a bottleneck in write benches.
 */
export function createPostgresClient(
  options: PostgresBackendPersistenceOptions
): Sql {
  const configuration = {
    connect_timeout: 5,
    database: options.database,
    host: options.host,
    idle_timeout: 5,
    max: 1,
    onnotice: () => undefined,
    password: options.password,
    port: options.port,
    prepare: false,
    username: options.username,
  };

  if (options.connectionString !== undefined) {
    return postgres(options.connectionString, configuration);
  }

  return postgres(configuration);
}

/**
 * PostgreSQL's `NAMEDATALEN` is 64, leaving 63 bytes for an identifier before
 * it is silently truncated (e.g. by `CREATE SCHEMA`). A caller-supplied name
 * longer than that would be truncated at creation time while posture queries
 * that compare the untruncated string would then fail with a misleading
 * "missing schema" error, so length is rejected up front instead.
 */
const MAX_SCHEMA_NAME_BYTES = 63;

/**
 * Defaults an unset schema name to `"public"` and validates it against
 * {@link VALID_SCHEMA_NAME_PATTERN} and {@link MAX_SCHEMA_NAME_BYTES} so it is
 * safe to interpolate into unparameterized DDL identifiers and will not be
 * truncated by PostgreSQL's `NAMEDATALEN` limit.
 *
 * @throws TuvrenPersistenceError `postgres_backend_invalid_schema_name` when
 *   the name does not match the pattern or exceeds the byte-length limit.
 */
export function normalizeSchemaName(schemaName: string | undefined): string {
  const normalized = schemaName ?? "public";

  if (!VALID_SCHEMA_NAME_PATTERN.test(normalized)) {
    throw persistenceError(
      `postgres backend schema "${normalized}" must match ${VALID_SCHEMA_NAME_PATTERN.source}`,
      "postgres_backend_invalid_schema_name",
      { schemaName: normalized }
    );
  }

  // The pattern is ASCII-only, so byte length already equals character
  // length here — but the byte-length check is kept explicit rather than
  // assumed, since it is the actual PostgreSQL-enforced limit.
  const byteLength = Buffer.byteLength(normalized, "utf8");
  if (byteLength > MAX_SCHEMA_NAME_BYTES) {
    throw persistenceError(
      `postgres backend schema "${normalized}" is ${byteLength} bytes, ` +
        `exceeding PostgreSQL's ${MAX_SCHEMA_NAME_BYTES}-byte identifier limit ` +
        "(NAMEDATALEN - 1); a longer name would be silently truncated",
      "postgres_backend_invalid_schema_name",
      { schemaName: normalized }
    );
  }

  return normalized;
}

/**
 * Decodes the snapshot wire format back into a `BackendState`, re-validating
 * every record with the kernel-protocol `assertStored*` guards as it is
 * inserted (schema records first, since turn trees and turn tree paths need
 * their schema to validate) and checking the payload's schema version.
 *
 * Exported (but not re-exported from the package's `index.ts`) for two
 * consumers: the production one-time blob→row migration
 * (`postgres-blob-migration.ts`'s `explodeLegacyBlobSnapshots`, which decodes
 * a pre-#110 database's legacy `backend_postgres_snapshots` blob), and tests
 * that exercise this decode path directly against a snapshot payload built by
 * the test-only `encodeSnapshot` in `test/legacy-snapshot-encoder.ts` (the
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
