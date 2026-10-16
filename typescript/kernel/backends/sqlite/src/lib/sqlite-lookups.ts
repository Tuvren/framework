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
import type Database from "better-sqlite3";

import { persistenceError } from "./sqlite-errors.js";
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
} from "./sqlite-records.js";
import type {
  SqliteBranchRow,
  SqliteObjectRow,
  SqliteObserveAnnotationRow,
  SqliteOrderedPathChunkRow,
  SqliteRunRow,
  SqliteSchemaRow,
  SqliteStagedResultRow,
  SqliteThreadRow,
  SqliteTurnNodeLineageRootRow,
  SqliteTurnNodeRow,
  SqliteTurnRow,
  SqliteTurnTreePathRow,
  SqliteTurnTreeRow,
  TurnNodeLineageMetadata,
} from "./sqlite-records.js";

// Row-level lookup helpers over the open connection. `select*` functions
// return the decoded Stored* record or null (lists in deterministic
// created-at/key order); `ensure*InDatabase` variants raise a
// `sqlite_backend_missing_*_reference` persistence error instead of
// returning null, for referential-integrity checks at write time.

/** Fetches one object by content hash, or `null`. */
export const selectObject = (
  db: Database.Database,
  hash: string
): StoredObject | null => {
  const row = db
    .prepare<[string], SqliteObjectRow>("SELECT * FROM objects WHERE hash = ?")
    .get(hash);
  return row === undefined ? null : decodeObjectRow(row);
};

/** Fetches one schema by ID, or `null`. */
export const selectSchema = (
  db: Database.Database,
  schemaId: string
): StoredSchema | null => {
  const row = db
    .prepare<[string], SqliteSchemaRow>(
      "SELECT * FROM schemas WHERE schema_id = ?"
    )
    .get(schemaId);
  return row === undefined ? null : decodeSchemaRow(row);
};

/** Fetches one turn tree by content hash, or `null`. */
export const selectTurnTree = (
  db: Database.Database,
  hash: string
): StoredTurnTree | null => {
  const row = db
    .prepare<[string], SqliteTurnTreeRow>(
      "SELECT * FROM turn_trees WHERE hash = ?"
    )
    .get(hash);
  return row === undefined ? null : decodeTurnTreeRow(row);
};

/** Fetches one turn-tree path by (tree hash, path), or `null`. */
export const selectTurnTreePath = (
  db: Database.Database,
  turnTreeHash: string,
  path: string
): StoredTurnTreePath | null => {
  const row = db
    .prepare<[string, string], SqliteTurnTreePathRow>(
      "SELECT * FROM turn_tree_paths WHERE turn_tree_hash = ? AND path = ?"
    )
    .get(turnTreeHash, path);
  return row === undefined ? null : decodeTurnTreePathRow(row);
};

/** Lists a turn tree's stored paths in path order. */
export const selectTurnTreePathsByTurnTree = (
  db: Database.Database,
  turnTreeHash: string
): StoredTurnTreePath[] => {
  const rows = db
    .prepare<[string], SqliteTurnTreePathRow>(
      "SELECT * FROM turn_tree_paths WHERE turn_tree_hash = ? ORDER BY path"
    )
    .all(turnTreeHash);
  return rows.map(decodeTurnTreePathRow);
};

/** Fetches one ordered-path chunk by content hash, or `null`. */
export const selectOrderedPathChunk = (
  db: Database.Database,
  chunkHash: string
): StoredOrderedPathChunk | null => {
  const row = db
    .prepare<[string], SqliteOrderedPathChunkRow>(
      "SELECT * FROM ordered_path_chunks WHERE chunk_hash = ?"
    )
    .get(chunkHash);
  return row === undefined ? null : decodeOrderedPathChunkRow(row);
};

/** Fetches one turn node by content hash, or `null`. */
export const selectTurnNode = (
  db: Database.Database,
  hash: string
): StoredTurnNode | null => {
  const row = db
    .prepare<[string], SqliteTurnNodeRow>(
      "SELECT * FROM turn_nodes WHERE hash = ?"
    )
    .get(hash);
  return row === undefined ? null : decodeTurnNodeRow(row);
};

/** Fetches a turn node's derived lineage-root metadata, or `null`. */
export const selectTurnNodeLineageMetadata = (
  db: Database.Database,
  turnNodeHash: string
): TurnNodeLineageMetadata | null => {
  const row = db
    .prepare<[string], SqliteTurnNodeLineageRootRow>(
      "SELECT * FROM turn_node_lineage_roots WHERE turn_node_hash = ?"
    )
    .get(turnNodeHash);
  return row === undefined ? null : decodeTurnNodeLineageMetadataRow(row);
};

/** Fetches one thread by ID, or `null`. */
export const selectThread = (
  db: Database.Database,
  threadId: string
): StoredThread | null => {
  const row = db
    .prepare<[string], SqliteThreadRow>(
      "SELECT * FROM threads WHERE thread_id = ?"
    )
    .get(threadId);
  return row === undefined ? null : decodeThreadRow(row);
};

/** Fetches one branch by ID, or `null`. */
export const selectBranch = (
  db: Database.Database,
  branchId: string
): StoredBranch | null => {
  const row = db
    .prepare<[string], SqliteBranchRow>(
      "SELECT * FROM branches WHERE branch_id = ?"
    )
    .get(branchId);
  return row === undefined ? null : decodeBranchRow(row);
};

/** Lists a thread's branches in deterministic order. */
export const selectBranchesByThread = (
  db: Database.Database,
  threadId: string
): StoredBranch[] => {
  const rows = db
    .prepare<[string], SqliteBranchRow>(
      "SELECT * FROM branches WHERE thread_id = ? ORDER BY created_at_ms, branch_id"
    )
    .all(threadId);
  return rows.map(decodeBranchRow);
};

/** Fetches one turn by ID, or `null`. */
export const selectTurn = (
  db: Database.Database,
  turnId: string
): StoredTurn | null => {
  const row = db
    .prepare<[string], SqliteTurnRow>("SELECT * FROM turns WHERE turn_id = ?")
    .get(turnId);
  return row === undefined ? null : decodeTurnRow(row);
};

/** Lists a thread's turns ordered by `created_at_ms`, then `turn_id`. */
export const selectTurnsByThread = (
  db: Database.Database,
  threadId: string
): StoredTurn[] => {
  const rows = db
    .prepare<[string], SqliteTurnRow>(
      "SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at_ms, turn_id"
    )
    .all(threadId);
  return rows.map(decodeTurnRow);
};

/** Fetches one run by ID, or `null`. */
export const selectRun = (
  db: Database.Database,
  runId: string
): StoredRun | null => {
  const row = db
    .prepare<[string], SqliteRunRow>("SELECT * FROM runs WHERE run_id = ?")
    .get(runId);
  return row === undefined ? null : decodeRunRow(row);
};

/** Lists a run's observe annotations in insertion (created-at/key) order. */
export const selectObserveAnnotationsByRun = (
  db: Database.Database,
  runId: string
): StoredObserveAnnotation[] => {
  const rows = db
    .prepare<[string], SqliteObserveAnnotationRow>(
      `
        SELECT *
        FROM observe_annotations
        WHERE run_id = ?
        ORDER BY created_at_ms, record_key
      `
    )
    .all(runId);
  return rows.map(decodeObserveAnnotationRow);
};

/** Lists a turn's runs in deterministic order. */
export const selectRunsByTurn = (
  db: Database.Database,
  turnId: string
): StoredRun[] => {
  const rows = db
    .prepare<[string], SqliteRunRow>(
      "SELECT * FROM runs WHERE turn_id = ? ORDER BY created_at_ms, run_id"
    )
    .all(turnId);
  return rows.map(decodeRunRow);
};

/** Lists a branch's runs in deterministic order. */
export const selectRunsByBranch = (
  db: Database.Database,
  branchId: string
): StoredRun[] => {
  const rows = db
    .prepare<[string], SqliteRunRow>(
      "SELECT * FROM runs WHERE branch_id = ? ORDER BY created_at_ms, run_id"
    )
    .all(branchId);
  return rows.map(decodeRunRow);
};

/**
 * Lists running leased runs whose lease expired at or before `nowMs` — the
 * fully leased (owner + fencing token + expiry) subset only; leaseless runs
 * never appear here.
 */
export const selectExpiredRuns = (
  db: Database.Database,
  nowMs: EpochMs
): StoredRun[] => {
  const rows = db
    .prepare<[number], SqliteRunRow>(
      `
        SELECT *
        FROM runs
        WHERE status = 'running'
          AND execution_owner_id IS NOT NULL
          AND fencing_token IS NOT NULL
          AND lease_expires_at_ms IS NOT NULL
          AND lease_expires_at_ms <= ?
        ORDER BY created_at_ms, run_id
      `
    )
    .all(nowMs);
  return rows.map(decodeRunRow);
};

/** Lists the turns naming `parentTurnId` as their semantic parent. */
export const selectTurnsByParentTurnId = (
  db: Database.Database,
  parentTurnId: string
): StoredTurn[] => {
  const rows = db
    .prepare<[string], SqliteTurnRow>(
      `
        SELECT *
        FROM turns
        WHERE parent_turn_id = ?
        ORDER BY created_at_ms, turn_id
      `
    )
    .all(parentTurnId);
  return rows.map(decodeTurnRow);
};

/** Lists a branch's running or paused runs in deterministic order. */
export const selectActiveRunsByBranch = (
  db: Database.Database,
  branchId: string
): StoredRun[] => {
  const rows = db
    .prepare<[string], SqliteRunRow>(
      `
        SELECT *
        FROM runs
        WHERE branch_id = ? AND status IN ('running', 'paused')
        ORDER BY created_at_ms, run_id
      `
    )
    .all(branchId);
  return rows.map(decodeRunRow);
};

/** Fetches one staged result by (run, task), or `null`. */
export const selectStagedResult = (
  db: Database.Database,
  runId: string,
  taskId: string
): StoredStagedResult | null => {
  const row = db
    .prepare<[string, string], SqliteStagedResultRow>(
      "SELECT * FROM staged_results WHERE run_id = ? AND task_id = ?"
    )
    .get(runId, taskId);
  return row === undefined ? null : decodeStagedResultRow(row);
};

/** Lists a run's staged results in deterministic order. */
export const selectStagedResultsByRun = (
  db: Database.Database,
  runId: string
): StoredStagedResult[] => {
  const rows = db
    .prepare<[string], SqliteStagedResultRow>(
      "SELECT * FROM staged_results WHERE run_id = ? ORDER BY created_at_ms, task_id"
    )
    .all(runId);
  return rows.map(decodeStagedResultRow);
};

/** Counts a run's staged-result rows without decoding them. */
export const countStagedResultsByRun = (
  db: Database.Database,
  runId: string
): number => {
  const row = db
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM staged_results WHERE run_id = ?"
    )
    .get(runId);
  return row?.count ?? 0;
};

/** Like `selectObject`, but raises `sqlite_backend_missing_object_reference`. */
export const ensureObjectExistsInDatabase = (
  db: Database.Database,
  hash: string,
  label: string
): StoredObject => {
  const record = selectObject(db, hash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing object`,
      "sqlite_backend_missing_object_reference",
      { hash, label }
    );
  }
  return record;
};

/** Like `selectOrderedPathChunk`, but raises on a missing chunk. */
export const ensureOrderedPathChunkExistsInDatabase = (
  db: Database.Database,
  chunkHash: string,
  label: string
): StoredOrderedPathChunk => {
  const record = selectOrderedPathChunk(db, chunkHash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing ordered path chunk`,
      "sqlite_backend_missing_ordered_path_chunk_reference",
      { chunkHash, label }
    );
  }
  return record;
};

/** Like `selectSchema`, but raises `sqlite_backend_missing_schema_reference`. */
export const ensureSchemaExistsInDatabase = (
  db: Database.Database,
  schemaId: string,
  label: string
): StoredSchema => {
  const record = selectSchema(db, schemaId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing schema`,
      "sqlite_backend_missing_schema_reference",
      { label, schemaId }
    );
  }
  return record;
};

/** Like `selectTurnTree`, but raises on a missing turn tree. */
export const ensureTurnTreeExistsInDatabase = (
  db: Database.Database,
  hash: string,
  label: string
): StoredTurnTree => {
  const record = selectTurnTree(db, hash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing turn tree`,
      "sqlite_backend_missing_turn_tree_reference",
      { hash, label }
    );
  }
  return record;
};

/** Like `selectTurnNode`, but raises on a missing turn node. */
export const ensureTurnNodeExistsInDatabase = (
  db: Database.Database,
  hash: string,
  label: string
): StoredTurnNode => {
  const record = selectTurnNode(db, hash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing turn node`,
      "sqlite_backend_missing_turn_node_reference",
      { hash, label }
    );
  }
  return record;
};

/** Like `selectTurnNodeLineageMetadata`, but raises on missing metadata. */
export const ensureTurnNodeLineageMetadataInDatabase = (
  db: Database.Database,
  turnNodeHash: string,
  label: string
): TurnNodeLineageMetadata => {
  const metadata = selectTurnNodeLineageMetadata(db, turnNodeHash);
  if (metadata === null) {
    throw persistenceError(
      `${label} must have lineage root metadata`,
      "sqlite_backend_missing_turn_node_lineage_metadata",
      { label, turnNodeHash }
    );
  }
  return metadata;
};

/** Like `selectThread`, but raises `sqlite_backend_missing_thread_reference`. */
export const ensureThreadExistsInDatabase = (
  db: Database.Database,
  threadId: string,
  label: string
): StoredThread => {
  const record = selectThread(db, threadId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing thread`,
      "sqlite_backend_missing_thread_reference",
      { label, threadId }
    );
  }
  return record;
};

/** Like `selectBranch`, but raises `sqlite_backend_missing_branch_reference`. */
export const ensureBranchExistsInDatabase = (
  db: Database.Database,
  branchId: string,
  label: string
): StoredBranch => {
  const record = selectBranch(db, branchId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing branch`,
      "sqlite_backend_missing_branch_reference",
      { branchId, label }
    );
  }
  return record;
};

/** Like `selectTurn`, but raises `sqlite_backend_missing_turn_reference`. */
export const ensureTurnExistsInDatabase = (
  db: Database.Database,
  turnId: string,
  label: string
): StoredTurn => {
  const record = selectTurn(db, turnId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing turn`,
      "sqlite_backend_missing_turn_reference",
      { label, turnId }
    );
  }
  return record;
};

/** Like `selectRun`, but raises `sqlite_backend_missing_run_reference`. */
export const ensureRunExistsInDatabase = (
  db: Database.Database,
  runId: string,
  label: string
): StoredRun => {
  const record = selectRun(db, runId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing run`,
      "sqlite_backend_missing_run_reference",
      { label, runId }
    );
  }
  return record;
};

/** Loads and decodes the turn-tree schema stored under `schemaId`. */
export const getSchemaForSchemaIdInDatabase = (
  db: Database.Database,
  schemaId: string,
  label: string
): TurnTreeSchema => {
  const schemaRecord = ensureSchemaExistsInDatabase(db, schemaId, label);
  return decodeTurnTreeSchema(schemaRecord.schemaCbor, `${label} schema`);
};

/** Loads and decodes the turn-tree schema a stored turn tree references. */
export const getSchemaForTurnTreeInDatabase = (
  db: Database.Database,
  turnTree: StoredTurnTree
): TurnTreeSchema =>
  getSchemaForSchemaIdInDatabase(db, turnTree.schemaId, "turnTree.schemaId");
