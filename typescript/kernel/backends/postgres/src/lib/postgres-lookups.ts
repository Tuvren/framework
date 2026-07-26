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

import type { EpochMs } from "@tuvren/core";
import type {
  StoredBranch,
  StoredObject,
  StoredObserveAnnotation,
  StoredOrderedPathChunk,
  StoredRun,
  StoredSchema,
  StoredStagedResult,
  StoredThread,
  StoredTurn,
  StoredTurnNode,
  StoredTurnTree,
  StoredTurnTreePath,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { persistenceError } from "./postgres-errors.js";
import {
  decodeBranchRow,
  decodeObjectRow,
  decodeObserveAnnotationRow,
  decodeOrderedPathChunkRow,
  decodeRunRow,
  decodeSchemaRow,
  decodeStagedResultRow,
  decodeThreadRow,
  decodeTurnNodeLineageMetadataRow,
  decodeTurnNodeRow,
  decodeTurnRow,
  decodeTurnTreePathRow,
  decodeTurnTreeRow,
  decodeTurnTreeSchema,
  type PostgresBranchRow,
  type PostgresObjectRow,
  type PostgresObserveAnnotationRow,
  type PostgresOrderedPathChunkRow,
  type PostgresRunRow,
  type PostgresSchemaRow,
  type PostgresStagedResultRow,
  type PostgresThreadRow,
  type PostgresTurnNodeLineageRootRow,
  type PostgresTurnNodeRow,
  type PostgresTurnRow,
  type PostgresTurnTreePathRow,
  type PostgresTurnTreeRow,
  type TurnNodeLineageMetadata,
} from "./postgres-records.js";
import type { DbSql } from "./postgres-sql.js";
import { qualifyIdentifier } from "./postgres-sql.js";

// Row-level lookup helpers over a connection/transaction. `select*` functions
// return the decoded Stored* record or null (lists in deterministic
// created-at/key order); `ensure*InDatabase` variants raise a
// `postgres_backend_missing_*_reference` persistence error instead of
// returning null, for referential-integrity checks at write time.
// Every query is scoped by ADR-048/049 `scope` and schema-qualified tables.

async function selectOne<T>(
  sql: DbSql,
  query: string,
  params: unknown[]
): Promise<T | undefined> {
  const rows = await sql.unsafe<T[]>(query, params as never[]);
  return rows[0];
}

async function selectMany<T>(
  sql: DbSql,
  query: string,
  params: unknown[]
): Promise<T[]> {
  return await sql.unsafe<T[]>(query, params as never[]);
}

/** Fetches one object by content hash, or `null`. */
export async function selectObject(
  sql: DbSql,
  schemaName: string,
  scope: string,
  hash: string
): Promise<StoredObject | null> {
  const table = qualifyIdentifier(schemaName, "objects");
  const row = await selectOne<PostgresObjectRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND hash = $2`,
    [scope, hash]
  );
  return row === undefined ? null : decodeObjectRow(row);
}

/** Fetches one schema by ID, or `null`. */
export async function selectSchema(
  sql: DbSql,
  schemaName: string,
  scope: string,
  schemaId: string
): Promise<StoredSchema | null> {
  const table = qualifyIdentifier(schemaName, "schemas");
  const row = await selectOne<PostgresSchemaRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND schema_id = $2`,
    [scope, schemaId]
  );
  return row === undefined ? null : decodeSchemaRow(row);
}

/** Fetches one turn tree by content hash, or `null`. */
export async function selectTurnTree(
  sql: DbSql,
  schemaName: string,
  scope: string,
  hash: string
): Promise<StoredTurnTree | null> {
  const table = qualifyIdentifier(schemaName, "turn_trees");
  const row = await selectOne<PostgresTurnTreeRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND hash = $2`,
    [scope, hash]
  );
  return row === undefined ? null : decodeTurnTreeRow(row);
}

/** Fetches one turn-tree path by (tree hash, path), or `null`. */
export async function selectTurnTreePath(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnTreeHash: string,
  path: string
): Promise<StoredTurnTreePath | null> {
  const table = qualifyIdentifier(schemaName, "turn_tree_paths");
  const row = await selectOne<PostgresTurnTreePathRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND turn_tree_hash = $2 AND path = $3`,
    [scope, turnTreeHash, path]
  );
  return row === undefined ? null : decodeTurnTreePathRow(row);
}

/** Lists a turn tree's stored paths in path order. */
export async function selectTurnTreePathsByTurnTree(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnTreeHash: string
): Promise<StoredTurnTreePath[]> {
  const table = qualifyIdentifier(schemaName, "turn_tree_paths");
  const rows = await selectMany<PostgresTurnTreePathRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND turn_tree_hash = $2 ORDER BY path`,
    [scope, turnTreeHash]
  );
  return rows.map(decodeTurnTreePathRow);
}

/** Fetches one ordered-path chunk by content hash, or `null`. */
export async function selectOrderedPathChunk(
  sql: DbSql,
  schemaName: string,
  scope: string,
  chunkHash: string
): Promise<StoredOrderedPathChunk | null> {
  const table = qualifyIdentifier(schemaName, "ordered_path_chunks");
  const row = await selectOne<PostgresOrderedPathChunkRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND chunk_hash = $2`,
    [scope, chunkHash]
  );
  return row === undefined ? null : decodeOrderedPathChunkRow(row);
}

/** Fetches one turn node by content hash, or `null`. */
export async function selectTurnNode(
  sql: DbSql,
  schemaName: string,
  scope: string,
  hash: string
): Promise<StoredTurnNode | null> {
  const table = qualifyIdentifier(schemaName, "turn_nodes");
  const row = await selectOne<PostgresTurnNodeRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND hash = $2`,
    [scope, hash]
  );
  return row === undefined ? null : decodeTurnNodeRow(row);
}

/** Fetches a turn node's derived lineage-root metadata, or `null`. */
export async function selectTurnNodeLineageMetadata(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnNodeHash: string
): Promise<TurnNodeLineageMetadata | null> {
  const table = qualifyIdentifier(schemaName, "turn_node_lineage_roots");
  const row = await selectOne<PostgresTurnNodeLineageRootRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND turn_node_hash = $2`,
    [scope, turnNodeHash]
  );
  return row === undefined ? null : decodeTurnNodeLineageMetadataRow(row);
}

/** Fetches one thread by ID, or `null`. */
export async function selectThread(
  sql: DbSql,
  schemaName: string,
  scope: string,
  threadId: string
): Promise<StoredThread | null> {
  const table = qualifyIdentifier(schemaName, "threads");
  const row = await selectOne<PostgresThreadRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND thread_id = $2`,
    [scope, threadId]
  );
  return row === undefined ? null : decodeThreadRow(row);
}

/** Fetches one branch by ID, or `null`. */
export async function selectBranch(
  sql: DbSql,
  schemaName: string,
  scope: string,
  branchId: string
): Promise<StoredBranch | null> {
  const table = qualifyIdentifier(schemaName, "branches");
  const row = await selectOne<PostgresBranchRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND branch_id = $2`,
    [scope, branchId]
  );
  return row === undefined ? null : decodeBranchRow(row);
}

/** Lists a thread's branches in deterministic order. */
export async function selectBranchesByThread(
  sql: DbSql,
  schemaName: string,
  scope: string,
  threadId: string
): Promise<StoredBranch[]> {
  const table = qualifyIdentifier(schemaName, "branches");
  const rows = await selectMany<PostgresBranchRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND thread_id = $2 ORDER BY created_at_ms, branch_id`,
    [scope, threadId]
  );
  return rows.map(decodeBranchRow);
}

/** Fetches one turn by ID, or `null`. */
export async function selectTurn(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnId: string
): Promise<StoredTurn | null> {
  const table = qualifyIdentifier(schemaName, "turns");
  const row = await selectOne<PostgresTurnRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND turn_id = $2`,
    [scope, turnId]
  );
  return row === undefined ? null : decodeTurnRow(row);
}

/** Lists a thread's turns ordered by `created_at_ms`, then `turn_id`. */
export async function selectTurnsByThread(
  sql: DbSql,
  schemaName: string,
  scope: string,
  threadId: string
): Promise<StoredTurn[]> {
  const table = qualifyIdentifier(schemaName, "turns");
  const rows = await selectMany<PostgresTurnRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND thread_id = $2 ORDER BY created_at_ms, turn_id`,
    [scope, threadId]
  );
  return rows.map(decodeTurnRow);
}

/** Fetches one run by ID, or `null`. */
export async function selectRun(
  sql: DbSql,
  schemaName: string,
  scope: string,
  runId: string
): Promise<StoredRun | null> {
  const table = qualifyIdentifier(schemaName, "runs");
  const row = await selectOne<PostgresRunRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND run_id = $2`,
    [scope, runId]
  );
  return row === undefined ? null : decodeRunRow(row);
}

/** Lists a run's observe annotations in insertion (created-at/key) order. */
export async function selectObserveAnnotationsByRun(
  sql: DbSql,
  schemaName: string,
  scope: string,
  runId: string
): Promise<StoredObserveAnnotation[]> {
  const table = qualifyIdentifier(schemaName, "observe_annotations");
  const rows = await selectMany<PostgresObserveAnnotationRow>(
    sql,
    `
        SELECT *
        FROM ${table}
        WHERE scope = $1 AND run_id = $2
        ORDER BY created_at_ms, record_key
      `,
    [scope, runId]
  );
  return rows.map(decodeObserveAnnotationRow);
}

/** Lists a turn's runs in deterministic order. */
export async function selectRunsByTurn(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnId: string
): Promise<StoredRun[]> {
  const table = qualifyIdentifier(schemaName, "runs");
  const rows = await selectMany<PostgresRunRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND turn_id = $2 ORDER BY created_at_ms, run_id`,
    [scope, turnId]
  );
  return rows.map(decodeRunRow);
}

/** Lists a branch's runs in deterministic order. */
export async function selectRunsByBranch(
  sql: DbSql,
  schemaName: string,
  scope: string,
  branchId: string
): Promise<StoredRun[]> {
  const table = qualifyIdentifier(schemaName, "runs");
  const rows = await selectMany<PostgresRunRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND branch_id = $2 ORDER BY created_at_ms, run_id`,
    [scope, branchId]
  );
  return rows.map(decodeRunRow);
}

/**
 * Lists running leased runs whose lease expired at or before `nowMs` — the
 * fully leased (owner + fencing token + expiry) subset only; leaseless runs
 * never appear here.
 */
export async function selectExpiredRuns(
  sql: DbSql,
  schemaName: string,
  scope: string,
  nowMs: EpochMs
): Promise<StoredRun[]> {
  const table = qualifyIdentifier(schemaName, "runs");
  const rows = await selectMany<PostgresRunRow>(
    sql,
    `
        SELECT *
        FROM ${table}
        WHERE scope = $1
          AND status = 'running'
          AND execution_owner_id IS NOT NULL
          AND fencing_token IS NOT NULL
          AND lease_expires_at_ms IS NOT NULL
          AND lease_expires_at_ms <= $2
        ORDER BY created_at_ms, run_id
      `,
    [scope, nowMs]
  );
  return rows.map(decodeRunRow);
}

/** Lists the turns naming `parentTurnId` as their semantic parent. */
export async function selectTurnsByParentTurnId(
  sql: DbSql,
  schemaName: string,
  scope: string,
  parentTurnId: string
): Promise<StoredTurn[]> {
  const table = qualifyIdentifier(schemaName, "turns");
  const rows = await selectMany<PostgresTurnRow>(
    sql,
    `
        SELECT *
        FROM ${table}
        WHERE scope = $1 AND parent_turn_id = $2
        ORDER BY created_at_ms, turn_id
      `,
    [scope, parentTurnId]
  );
  return rows.map(decodeTurnRow);
}

/** Lists a branch's running or paused runs in deterministic order. */
export async function selectActiveRunsByBranch(
  sql: DbSql,
  schemaName: string,
  scope: string,
  branchId: string
): Promise<StoredRun[]> {
  const table = qualifyIdentifier(schemaName, "runs");
  const rows = await selectMany<PostgresRunRow>(
    sql,
    `
        SELECT *
        FROM ${table}
        WHERE scope = $1 AND branch_id = $2 AND status IN ('running', 'paused')
        ORDER BY created_at_ms, run_id
      `,
    [scope, branchId]
  );
  return rows.map(decodeRunRow);
}

/** Fetches one staged result by (run, task), or `null`. */
export async function selectStagedResult(
  sql: DbSql,
  schemaName: string,
  scope: string,
  runId: string,
  taskId: string
): Promise<StoredStagedResult | null> {
  const table = qualifyIdentifier(schemaName, "staged_results");
  const row = await selectOne<PostgresStagedResultRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND run_id = $2 AND task_id = $3`,
    [scope, runId, taskId]
  );
  return row === undefined ? null : decodeStagedResultRow(row);
}

/** Lists a run's staged results in deterministic order. */
export async function selectStagedResultsByRun(
  sql: DbSql,
  schemaName: string,
  scope: string,
  runId: string
): Promise<StoredStagedResult[]> {
  const table = qualifyIdentifier(schemaName, "staged_results");
  const rows = await selectMany<PostgresStagedResultRow>(
    sql,
    `SELECT * FROM ${table} WHERE scope = $1 AND run_id = $2 ORDER BY created_at_ms, task_id`,
    [scope, runId]
  );
  return rows.map(decodeStagedResultRow);
}

/** Counts a run's staged-result rows without decoding them. */
export async function countStagedResultsByRun(
  sql: DbSql,
  schemaName: string,
  scope: string,
  runId: string
): Promise<number> {
  const table = qualifyIdentifier(schemaName, "staged_results");
  const row = await selectOne<{ count: number | string | bigint }>(
    sql,
    `SELECT COUNT(*)::int AS count FROM ${table} WHERE scope = $1 AND run_id = $2`,
    [scope, runId]
  );
  return row === undefined ? 0 : Number(row.count);
}

/** Like `selectObject`, but raises `postgres_backend_missing_object_reference`. */
export async function ensureObjectExistsInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  hash: string,
  label: string
): Promise<StoredObject> {
  const record = await selectObject(sql, schemaName, scope, hash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing object`,
      "postgres_backend_missing_object_reference",
      { hash, label }
    );
  }
  return record;
}

/** Like `selectOrderedPathChunk`, but raises on a missing chunk. */
export async function ensureOrderedPathChunkExistsInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  chunkHash: string,
  label: string
): Promise<StoredOrderedPathChunk> {
  const record = await selectOrderedPathChunk(sql, schemaName, scope, chunkHash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing ordered path chunk`,
      "postgres_backend_missing_ordered_path_chunk_reference",
      { chunkHash, label }
    );
  }
  return record;
}

/** Like `selectSchema`, but raises `postgres_backend_missing_schema_reference`. */
export async function ensureSchemaExistsInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  schemaId: string,
  label: string
): Promise<StoredSchema> {
  const record = await selectSchema(sql, schemaName, scope, schemaId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing schema`,
      "postgres_backend_missing_schema_reference",
      { label, schemaId }
    );
  }
  return record;
}

/** Like `selectTurnTree`, but raises on a missing turn tree. */
export async function ensureTurnTreeExistsInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  hash: string,
  label: string
): Promise<StoredTurnTree> {
  const record = await selectTurnTree(sql, schemaName, scope, hash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing turn tree`,
      "postgres_backend_missing_turn_tree_reference",
      { hash, label }
    );
  }
  return record;
}

/** Like `selectTurnNode`, but raises on a missing turn node. */
export async function ensureTurnNodeExistsInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  hash: string,
  label: string
): Promise<StoredTurnNode> {
  const record = await selectTurnNode(sql, schemaName, scope, hash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing turn node`,
      "postgres_backend_missing_turn_node_reference",
      { hash, label }
    );
  }
  return record;
}

/** Like `selectTurnNodeLineageMetadata`, but raises on missing metadata. */
export async function ensureTurnNodeLineageMetadataInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnNodeHash: string,
  label: string
): Promise<TurnNodeLineageMetadata> {
  const metadata = await selectTurnNodeLineageMetadata(
    sql,
    schemaName,
    scope,
    turnNodeHash
  );
  if (metadata === null) {
    throw persistenceError(
      `${label} must have lineage root metadata`,
      "postgres_backend_missing_turn_node_lineage_metadata",
      { label, turnNodeHash }
    );
  }
  return metadata;
}

/** Like `selectThread`, but raises `postgres_backend_missing_thread_reference`. */
export async function ensureThreadExistsInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  threadId: string,
  label: string
): Promise<StoredThread> {
  const record = await selectThread(sql, schemaName, scope, threadId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing thread`,
      "postgres_backend_missing_thread_reference",
      { label, threadId }
    );
  }
  return record;
}

/** Like `selectBranch`, but raises `postgres_backend_missing_branch_reference`. */
export async function ensureBranchExistsInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  branchId: string,
  label: string
): Promise<StoredBranch> {
  const record = await selectBranch(sql, schemaName, scope, branchId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing branch`,
      "postgres_backend_missing_branch_reference",
      { branchId, label }
    );
  }
  return record;
}

/** Like `selectTurn`, but raises `postgres_backend_missing_turn_reference`. */
export async function ensureTurnExistsInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnId: string,
  label: string
): Promise<StoredTurn> {
  const record = await selectTurn(sql, schemaName, scope, turnId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing turn`,
      "postgres_backend_missing_turn_reference",
      { label, turnId }
    );
  }
  return record;
}

/** Like `selectRun`, but raises `postgres_backend_missing_run_reference`. */
export async function ensureRunExistsInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  runId: string,
  label: string
): Promise<StoredRun> {
  const record = await selectRun(sql, schemaName, scope, runId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing run`,
      "postgres_backend_missing_run_reference",
      { label, runId }
    );
  }
  return record;
}

/** Loads and decodes the turn-tree schema stored under `schemaId`. */
export async function getSchemaForSchemaIdInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  schemaId: string,
  label: string
): Promise<TurnTreeSchema> {
  const schemaRecord = await ensureSchemaExistsInDatabase(
    sql,
    schemaName,
    scope,
    schemaId,
    label
  );
  return decodeTurnTreeSchema(schemaRecord.schemaCbor, `${label} schema`);
}

/** Loads and decodes the turn-tree schema a stored turn tree references. */
export async function getSchemaForTurnTreeInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnTree: StoredTurnTree
): Promise<TurnTreeSchema> {
  return getSchemaForSchemaIdInDatabase(
    sql,
    schemaName,
    scope,
    turnTree.schemaId,
    "turnTree.schemaId"
  );
}
