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

import { DEFAULT_SCOPE, type EpochMs, type Scope } from "@tuvren/core";
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
  encodeDeterministicKernelRecord,
  type StoredObject,
  type StoredOrderedPathChunk,
  type StoredSchema,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
  type StoredTurnNode,
  type StoredTurnTree,
  type StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import postgres, { type Sql, type TransactionSql } from "postgres";
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
  compareStoredBranch,
  compareStoredObserveAnnotation,
  compareStoredRun,
  compareStoredStagedResult,
  persistenceError,
} from "./memory-backend-record-utils.js";
import { createEmptyState } from "./memory-backend-state.js";
import {
  getSchemaForSchemaId,
  getSchemaForTurnTree,
} from "./memory-backend-turn-tree.js";
import type { BackendState } from "./memory-backend-types.js";

const CURRENT_SNAPSHOT_VERSION = 1;
const INITIAL_MIGRATION_NAME = "0001_initial_schema.sql";
const SCOPE_PARTITION_MIGRATION_NAME = "0002_scope_partition.sql";
const SNAPSHOTS_PRIMARY_KEY_NAME = "backend_postgres_snapshots_pkey";
const SNAPSHOT_ROW_ID = 1;
const VALID_SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Connection and partition options for the PostgreSQL backend's persistence layer. */
export interface PostgresBackendPersistenceOptions {
  connectionString?: string;
  database?: string;
  host?: string;
  now?: () => EpochMs;
  password?: string;
  port?: number;
  schemaName?: string;
  /**
   * Host-supplied partition identity bound at construction (ADR-048).
   *
   * Isolation is realized as row-level isolation under the single-blob snapshot
   * model (ADR-049): each Scope owns its own snapshot row in the shared
   * `backend_postgres_snapshots` table, keyed by the composite primary key
   * `(snapshot_id, scope)`. Two backends sharing a schema (the same database)
   * but bound to different Scopes therefore read and write independent snapshot
   * rows and can never observe each other's state, with no cross-scope dedup.
   * When omitted, the backend binds the default Scope, so existing single-scope
   * databases keep working unchanged. Must be a non-empty string.
   */
  scope?: Scope;
  username?: string;
}

interface PersistedSnapshotRow {
  schema_version: number;
  snapshot_cbor: Uint8Array;
}

/**
 * Creates a `postgres` client configured for single-connection,
 * non-prepared-statement use (`max: 1`, `prepare: false`), matching the
 * backend's single-writer transaction model. Prefers `options.connectionString`
 * when set, otherwise builds the connection from the discrete fields.
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
 * Defaults an unset schema name to `"public"` and validates it against
 * {@link VALID_SCHEMA_NAME_PATTERN} so it is safe to interpolate into
 * unparameterized DDL identifiers.
 *
 * @throws TuvrenPersistenceError `postgres_backend_invalid_schema_name` when
 *   the name does not match the pattern.
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

  return normalized;
}

/**
 * Idempotently provisions a Scope's PostgreSQL storage: creates the schema
 * and its migrations/snapshots tables if absent, migrates a pre-scope
 * snapshots table to the row-level-isolation shape (ADR-049), records the
 * migration ledger, and lazily creates this Scope's snapshot row (seeded
 * with an empty state if this is the Scope's first use). Concurrent callers
 * provisioning the same schema are serialized via a transaction-scoped
 * PostgreSQL advisory lock keyed on the schema name.
 */
export async function ensurePostgresSchemaInitialized(
  sql: Sql,
  schemaName: string,
  now: () => EpochMs,
  scope: Scope
): Promise<void> {
  const migrationsTable = qualifyIdentifier(
    schemaName,
    "backend_postgres_migrations"
  );
  const snapshotsTable = qualifyIdentifier(
    schemaName,
    "backend_postgres_snapshots"
  );
  const initialSnapshotBytes = encodeSnapshot(createEmptyState());

  await sql.begin(async (tx) => {
    // Serialize concurrent initializers of the same schema. Multiple backends
    // bound to different scopes routinely share one schema (the row-level
    // isolation model), so a host reconstructing per-request scoped backends can
    // first-touch the same schema concurrently. A transaction-scoped advisory
    // lock keyed on the schema name makes the idempotent `CREATE SCHEMA`/
    // `CREATE TABLE` and the one-time scope-partition migration race-free; it is
    // released automatically when this transaction commits or rolls back.
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [schemaName]);
    await tx.unsafe(
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`
    );
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS ${migrationsTable} (
        name TEXT PRIMARY KEY,
        applied_at_ms BIGINT NOT NULL
      )`
    );
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS ${snapshotsTable} (
        snapshot_id SMALLINT NOT NULL,
        scope TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        snapshot_cbor BYTEA NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        CONSTRAINT ${SNAPSHOTS_PRIMARY_KEY_NAME} PRIMARY KEY (snapshot_id, scope)
      )`
    );
    // Migrate a pre-scope snapshot table (single `snapshot_id` primary key, one
    // implicit scope) to the scope-partitioned shape (ADR-049 row-level
    // isolation). The pre-existing row becomes the default scope's snapshot, so
    // existing single-scope databases keep working unchanged.
    await migrateSnapshotsToScopePartition(tx, schemaName, snapshotsTable);
    // Record the ledger at the current schema level. A brand-new schema is
    // created directly in the 0002 (scope-partitioned) shape, so both names are
    // recorded even though no `ALTER` literally ran — the ledger encodes "this
    // schema is at the 0002 shape", not which statements executed.
    await tx.unsafe(
      `INSERT INTO ${migrationsTable} (name, applied_at_ms)
       VALUES ($1, $2), ($3, $4)
       ON CONFLICT (name) DO NOTHING`,
      [INITIAL_MIGRATION_NAME, now(), SCOPE_PARTITION_MIGRATION_NAME, now()]
    );
    // Lazily create the constructing scope's snapshot row. A first-seen scope
    // starts from the canonical empty state; a returning scope keeps its row.
    await tx.unsafe(
      `INSERT INTO ${snapshotsTable} (
         snapshot_id,
         scope,
         schema_version,
         snapshot_cbor,
         updated_at_ms
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (snapshot_id, scope) DO NOTHING`,
      [
        SNAPSHOT_ROW_ID,
        scope,
        CURRENT_SNAPSHOT_VERSION,
        initialSnapshotBytes,
        now(),
      ]
    );
  });
}

/**
 * Rewrites a legacy `backend_postgres_snapshots` table (primary key on
 * `snapshot_id` alone, with one implicit-scope row) into the scope-partitioned
 * shape used by ADR-049 row-level isolation: a `scope` column and a composite
 * primary key `(snapshot_id, scope)`. The single legacy row is assigned the
 * default scope. The migration is gated on the absence of the `scope` column so
 * it is idempotent and a no-op for tables already created in the scoped shape.
 */
async function migrateSnapshotsToScopePartition(
  tx: TransactionSql<Record<string, never>>,
  schemaName: string,
  snapshotsTable: string
): Promise<void> {
  const scopeColumns = await tx.unsafe<Array<{ column_name: string }>>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'backend_postgres_snapshots'
        AND column_name = 'scope'`,
    [schemaName]
  );

  if (scopeColumns.length > 0) {
    return;
  }

  await tx.unsafe(`ALTER TABLE ${snapshotsTable} ADD COLUMN scope TEXT`);
  await tx.unsafe(
    `UPDATE ${snapshotsTable} SET scope = $1 WHERE scope IS NULL`,
    [DEFAULT_SCOPE]
  );
  await tx.unsafe(
    `ALTER TABLE ${snapshotsTable} ALTER COLUMN scope SET NOT NULL`
  );
  await tx.unsafe(
    `ALTER TABLE ${snapshotsTable} DROP CONSTRAINT IF EXISTS ${SNAPSHOTS_PRIMARY_KEY_NAME}`
  );
  await tx.unsafe(
    `ALTER TABLE ${snapshotsTable} ADD CONSTRAINT ${SNAPSHOTS_PRIMARY_KEY_NAME} PRIMARY KEY (snapshot_id, scope)`
  );
}

/**
 * Loads and decodes a Scope's persisted `BackendState` snapshot, locking its
 * row with `FOR UPDATE` so the caller can safely mutate a draft and write it
 * back with {@link persistStateSnapshot} inside the same transaction.
 *
 * @throws TuvrenPersistenceError `postgres_backend_missing_snapshot_row` when
 *   the Scope has no snapshot row (e.g. reused after {@link deletePersistedStateSnapshot}),
 *   or `postgres_backend_snapshot_version_unsupported` when the row's schema
 *   version predates what this package version can decode.
 */
export async function loadPersistedStateForUpdate(
  sql: Sql | TransactionSql<Record<string, never>>,
  schemaName: string,
  scope: Scope
): Promise<BackendState> {
  const snapshotsTable = qualifyIdentifier(
    schemaName,
    "backend_postgres_snapshots"
  );
  const rows = await sql.unsafe<PersistedSnapshotRow[]>(
    `SELECT schema_version, snapshot_cbor
       FROM ${snapshotsTable}
      WHERE snapshot_id = $1 AND scope = $2
      FOR UPDATE`,
    [SNAPSHOT_ROW_ID, scope]
  );
  const row = rows[0];

  if (row === undefined) {
    throw persistenceError(
      "postgres backend snapshot row is missing",
      "postgres_backend_missing_snapshot_row",
      { scope }
    );
  }

  if (row.schema_version !== CURRENT_SNAPSHOT_VERSION) {
    throw persistenceError(
      "postgres backend snapshot version is unsupported",
      "postgres_backend_snapshot_version_unsupported",
      {
        actualVersion: row.schema_version,
        expectedVersion: CURRENT_SNAPSHOT_VERSION,
      }
    );
  }

  return decodeSnapshot(row.snapshot_cbor);
}

/**
 * Encodes `state` as deterministic CBOR and overwrites the Scope's snapshot
 * row with it, stamping `updatedAtMs`. Callers must hold the row lock from a
 * prior {@link loadPersistedStateForUpdate} in the same transaction.
 */
export async function persistStateSnapshot(
  sql: Sql | TransactionSql<Record<string, never>>,
  schemaName: string,
  scope: Scope,
  state: BackendState,
  updatedAtMs: EpochMs
): Promise<void> {
  const snapshotsTable = qualifyIdentifier(
    schemaName,
    "backend_postgres_snapshots"
  );
  const snapshotBytes = encodeSnapshot(state);

  await sql.unsafe(
    `UPDATE ${snapshotsTable}
        SET schema_version = $1,
            snapshot_cbor = $2,
            updated_at_ms = $3
      WHERE snapshot_id = $4 AND scope = $5`,
    [
      CURRENT_SNAPSHOT_VERSION,
      snapshotBytes,
      updatedAtMs,
      SNAPSHOT_ROW_ID,
      scope,
    ]
  );
}

/**
 * Drops a Scope's entire partition for full tenant offboarding (kernel spec
 * §9.4). Under the row-level isolation model each Scope owns one snapshot row in
 * the shared table, so deleting that row removes all of the Scope's durable
 * state while leaving every other Scope's row untouched. Per the
 * `RuntimeBackend.purgeScope` contract the offboarding instance is then
 * discarded (it caches its initialization, so reusing it after the row is gone
 * raises `postgres_backend_missing_snapshot_row`); only a *fresh* backend
 * re-creates an empty partition for the Scope on its next load.
 */
export async function deletePersistedStateSnapshot(
  sql: Sql | TransactionSql<Record<string, never>>,
  schemaName: string,
  scope: Scope
): Promise<void> {
  const snapshotsTable = qualifyIdentifier(
    schemaName,
    "backend_postgres_snapshots"
  );
  await sql.unsafe(
    `DELETE FROM ${snapshotsTable}
      WHERE snapshot_id = $1 AND scope = $2`,
    [SNAPSHOT_ROW_ID, scope]
  );
}

/**
 * Projects a `BackendState` into the snapshot wire format: every record
 * family flattened to a deterministically sorted array (so the encoding is
 * stable regardless of `Map` iteration order) and CBOR-encoded alongside the
 * schema version.
 */
function encodeSnapshot(state: BackendState): Uint8Array {
  const snapshot = {
    branches: Array.from(state.branches.values(), cloneStoredBranch).sort(
      compareStoredBranch
    ),
    objects: Array.from(state.objects.values(), cloneStoredObject).sort(
      compareStoredObject
    ),
    observeAnnotations: Array.from(
      state.observeAnnotations.values(),
      (records) => records.map(cloneStoredObserveAnnotation)
    )
      .flat()
      .sort(compareStoredObserveAnnotation),
    orderedPathChunks: Array.from(
      state.orderedPathChunks.values(),
      cloneStoredOrderedPathChunk
    ).sort(compareStoredOrderedPathChunk),
    runs: Array.from(state.runs.values(), cloneStoredRun).sort(
      compareStoredRun
    ),
    schemas: Array.from(state.schemas.values(), cloneStoredSchema).sort(
      compareStoredSchema
    ),
    stagedResults: Array.from(state.stagedResults.values(), (records) =>
      Array.from(records.values(), cloneStoredStagedResult)
    )
      .flat()
      .sort(compareStoredStagedResult),
    threads: Array.from(state.threads.values(), cloneStoredThread).sort(
      compareStoredThread
    ),
    turnNodes: Array.from(state.turnNodes.values(), cloneStoredTurnNode).sort(
      compareStoredTurnNode
    ),
    turnTreePaths: Array.from(state.turnTreePaths.values(), (records) =>
      Array.from(records.values(), cloneStoredTurnTreePath)
    )
      .flat()
      .sort(compareStoredTurnTreePath),
    turnTrees: Array.from(state.turnTrees.values(), cloneStoredTurnTree).sort(
      compareStoredTurnTree
    ),
    turns: Array.from(state.turns.values(), cloneStoredTurn).sort(
      compareStoredTurn
    ),
    version: CURRENT_SNAPSHOT_VERSION,
  } satisfies Record<string, unknown>;

  return encodeDeterministicKernelRecord(
    snapshot as unknown as Parameters<typeof encodeDeterministicKernelRecord>[0]
  );
}

/**
 * Decodes the snapshot wire format back into a `BackendState`, re-validating
 * every record with the kernel-protocol `assertStored*` guards as it is
 * inserted (schema records first, since turn trees and turn tree paths need
 * their schema to validate) and checking the payload's schema version.
 *
 * @throws TuvrenPersistenceError with code `postgres_backend_snapshot_payload_invalid`
 *   when the payload or a field's shape is malformed, or
 *   `postgres_backend_snapshot_payload_version_unsupported` when the
 *   embedded version does not match {@link CURRENT_SNAPSHOT_VERSION}.
 */
function decodeSnapshot(value: Uint8Array): BackendState {
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

/** Double-quotes and escapes a PostgreSQL identifier for safe interpolation. */
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Builds a `"schema"."table"` qualified, quoted identifier. */
function qualifyIdentifier(schemaName: string, tableName: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

/** Copies a possibly-driver-specific byte buffer into a plain `Uint8Array`. */
function toUint8Array(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

// Comparators below give the encoded snapshot a deterministic element order
// per record family, by identity key, independent of `Map` iteration order.

function compareStoredObject(left: StoredObject, right: StoredObject): number {
  return left.hash.localeCompare(right.hash);
}

function compareStoredOrderedPathChunk(
  left: StoredOrderedPathChunk,
  right: StoredOrderedPathChunk
): number {
  return left.chunkHash.localeCompare(right.chunkHash);
}

function compareStoredSchema(left: StoredSchema, right: StoredSchema): number {
  return left.schemaId.localeCompare(right.schemaId);
}

function compareStoredThread(left: StoredThread, right: StoredThread): number {
  return left.threadId.localeCompare(right.threadId);
}

function compareStoredTurnNode(
  left: StoredTurnNode,
  right: StoredTurnNode
): number {
  return left.hash.localeCompare(right.hash);
}

function compareStoredTurnTree(
  left: StoredTurnTree,
  right: StoredTurnTree
): number {
  return left.hash.localeCompare(right.hash);
}

function compareStoredTurnTreePath(
  left: StoredTurnTreePath,
  right: StoredTurnTreePath
): number {
  const treeCompare = left.turnTreeHash.localeCompare(right.turnTreeHash);

  if (treeCompare !== 0) {
    return treeCompare;
  }

  return left.path.localeCompare(right.path);
}

function compareStoredTurn(left: StoredTurn, right: StoredTurn): number {
  return left.turnId.localeCompare(right.turnId);
}
