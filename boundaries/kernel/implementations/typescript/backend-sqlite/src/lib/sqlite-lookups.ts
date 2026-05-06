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

import type { EpochMs } from "@tuvren/core-types";
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
  type SqliteBranchRow,
  type SqliteObjectRow,
  type SqliteObserveAnnotationRow,
  type SqliteOrderedPathChunkRow,
  type SqliteRunRow,
  type SqliteSchemaRow,
  type SqliteStagedResultRow,
  type SqliteThreadRow,
  type SqliteTurnNodeLineageRootRow,
  type SqliteTurnNodeRow,
  type SqliteTurnRow,
  type SqliteTurnTreePathRow,
  type SqliteTurnTreeRow,
  type TurnNodeLineageMetadata,
} from "./sqlite-records.js";

export function selectObject(
  db: Database.Database,
  hash: string
): StoredObject | null {
  const row = db.prepare("SELECT * FROM objects WHERE hash = ?").get(hash) as
    | SqliteObjectRow
    | undefined;
  return row === undefined ? null : decodeObjectRow(row);
}

export function selectSchema(
  db: Database.Database,
  schemaId: string
): StoredSchema | null {
  const row = db
    .prepare("SELECT * FROM schemas WHERE schema_id = ?")
    .get(schemaId) as SqliteSchemaRow | undefined;
  return row === undefined ? null : decodeSchemaRow(row);
}

export function selectTurnTree(
  db: Database.Database,
  hash: string
): StoredTurnTree | null {
  const row = db.prepare("SELECT * FROM turn_trees WHERE hash = ?").get(hash) as
    | SqliteTurnTreeRow
    | undefined;
  return row === undefined ? null : decodeTurnTreeRow(row);
}

export function selectTurnTreePath(
  db: Database.Database,
  turnTreeHash: string,
  path: string
): StoredTurnTreePath | null {
  const row = db
    .prepare(
      "SELECT * FROM turn_tree_paths WHERE turn_tree_hash = ? AND path = ?"
    )
    .get(turnTreeHash, path) as SqliteTurnTreePathRow | undefined;
  return row === undefined ? null : decodeTurnTreePathRow(row);
}

export function selectTurnTreePathsByTurnTree(
  db: Database.Database,
  turnTreeHash: string
): StoredTurnTreePath[] {
  const rows = db
    .prepare(
      "SELECT * FROM turn_tree_paths WHERE turn_tree_hash = ? ORDER BY path"
    )
    .all(turnTreeHash) as SqliteTurnTreePathRow[];
  return rows.map(decodeTurnTreePathRow);
}

export function selectOrderedPathChunk(
  db: Database.Database,
  chunkHash: string
): StoredOrderedPathChunk | null {
  const row = db
    .prepare("SELECT * FROM ordered_path_chunks WHERE chunk_hash = ?")
    .get(chunkHash) as SqliteOrderedPathChunkRow | undefined;
  return row === undefined ? null : decodeOrderedPathChunkRow(row);
}

export function selectTurnNode(
  db: Database.Database,
  hash: string
): StoredTurnNode | null {
  const row = db.prepare("SELECT * FROM turn_nodes WHERE hash = ?").get(hash) as
    | SqliteTurnNodeRow
    | undefined;
  return row === undefined ? null : decodeTurnNodeRow(row);
}

export function selectTurnNodeLineageMetadata(
  db: Database.Database,
  turnNodeHash: string
): TurnNodeLineageMetadata | null {
  const row = db
    .prepare("SELECT * FROM turn_node_lineage_roots WHERE turn_node_hash = ?")
    .get(turnNodeHash) as SqliteTurnNodeLineageRootRow | undefined;
  return row === undefined ? null : decodeTurnNodeLineageMetadataRow(row);
}

export function selectThread(
  db: Database.Database,
  threadId: string
): StoredThread | null {
  const row = db
    .prepare("SELECT * FROM threads WHERE thread_id = ?")
    .get(threadId) as SqliteThreadRow | undefined;
  return row === undefined ? null : decodeThreadRow(row);
}

export function selectBranch(
  db: Database.Database,
  branchId: string
): StoredBranch | null {
  const row = db
    .prepare("SELECT * FROM branches WHERE branch_id = ?")
    .get(branchId) as SqliteBranchRow | undefined;
  return row === undefined ? null : decodeBranchRow(row);
}

export function selectBranchesByThread(
  db: Database.Database,
  threadId: string
): StoredBranch[] {
  const rows = db
    .prepare(
      "SELECT * FROM branches WHERE thread_id = ? ORDER BY created_at_ms, branch_id"
    )
    .all(threadId) as SqliteBranchRow[];
  return rows.map(decodeBranchRow);
}

export function selectTurn(
  db: Database.Database,
  turnId: string
): StoredTurn | null {
  const row = db.prepare("SELECT * FROM turns WHERE turn_id = ?").get(turnId) as
    | SqliteTurnRow
    | undefined;
  return row === undefined ? null : decodeTurnRow(row);
}

export function selectTurnsByThread(
  db: Database.Database,
  threadId: string
): StoredTurn[] {
  const rows = db
    .prepare(
      "SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at_ms, turn_id"
    )
    .all(threadId) as SqliteTurnRow[];
  return rows.map(decodeTurnRow);
}

export function selectRun(
  db: Database.Database,
  runId: string
): StoredRun | null {
  const row = db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
    | SqliteRunRow
    | undefined;
  return row === undefined ? null : decodeRunRow(row);
}

export function selectObserveAnnotationsByRun(
  db: Database.Database,
  runId: string
): StoredObserveAnnotation[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM observe_annotations
        WHERE run_id = ?
        ORDER BY created_at_ms, record_key
      `
    )
    .all(runId) as SqliteObserveAnnotationRow[];
  return rows.map(decodeObserveAnnotationRow);
}

export function selectRunsByTurn(
  db: Database.Database,
  turnId: string
): StoredRun[] {
  const rows = db
    .prepare(
      "SELECT * FROM runs WHERE turn_id = ? ORDER BY created_at_ms, run_id"
    )
    .all(turnId) as SqliteRunRow[];
  return rows.map(decodeRunRow);
}

export function selectRunsByBranch(
  db: Database.Database,
  branchId: string
): StoredRun[] {
  const rows = db
    .prepare(
      "SELECT * FROM runs WHERE branch_id = ? ORDER BY created_at_ms, run_id"
    )
    .all(branchId) as SqliteRunRow[];
  return rows.map(decodeRunRow);
}

export function selectExpiredRuns(
  db: Database.Database,
  nowMs: EpochMs
): StoredRun[] {
  const rows = db
    .prepare(
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
    .all(nowMs) as SqliteRunRow[];
  return rows.map(decodeRunRow);
}

export function selectTurnsByParentTurnId(
  db: Database.Database,
  parentTurnId: string
): StoredTurn[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM turns
        WHERE parent_turn_id = ?
        ORDER BY created_at_ms, turn_id
      `
    )
    .all(parentTurnId) as SqliteTurnRow[];
  return rows.map(decodeTurnRow);
}

export function selectActiveRunsByBranch(
  db: Database.Database,
  branchId: string
): StoredRun[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM runs
        WHERE branch_id = ? AND status IN ('running', 'paused')
        ORDER BY created_at_ms, run_id
      `
    )
    .all(branchId) as SqliteRunRow[];
  return rows.map(decodeRunRow);
}

export function selectStagedResult(
  db: Database.Database,
  runId: string,
  taskId: string
): StoredStagedResult | null {
  const row = db
    .prepare("SELECT * FROM staged_results WHERE run_id = ? AND task_id = ?")
    .get(runId, taskId) as SqliteStagedResultRow | undefined;
  return row === undefined ? null : decodeStagedResultRow(row);
}

export function selectStagedResultsByRun(
  db: Database.Database,
  runId: string
): StoredStagedResult[] {
  const rows = db
    .prepare(
      "SELECT * FROM staged_results WHERE run_id = ? ORDER BY created_at_ms, task_id"
    )
    .all(runId) as SqliteStagedResultRow[];
  return rows.map(decodeStagedResultRow);
}

export function countStagedResultsByRun(
  db: Database.Database,
  runId: string
): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM staged_results WHERE run_id = ?")
    .get(runId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function ensureObjectExistsInDatabase(
  db: Database.Database,
  hash: string,
  label: string
): StoredObject {
  const record = selectObject(db, hash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing object`,
      "sqlite_backend_missing_object_reference",
      { hash, label }
    );
  }
  return record;
}

export function ensureOrderedPathChunkExistsInDatabase(
  db: Database.Database,
  chunkHash: string,
  label: string
): StoredOrderedPathChunk {
  const record = selectOrderedPathChunk(db, chunkHash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing ordered path chunk`,
      "sqlite_backend_missing_ordered_path_chunk_reference",
      { chunkHash, label }
    );
  }
  return record;
}

export function ensureSchemaExistsInDatabase(
  db: Database.Database,
  schemaId: string,
  label: string
): StoredSchema {
  const record = selectSchema(db, schemaId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing schema`,
      "sqlite_backend_missing_schema_reference",
      { label, schemaId }
    );
  }
  return record;
}

export function ensureTurnTreeExistsInDatabase(
  db: Database.Database,
  hash: string,
  label: string
): StoredTurnTree {
  const record = selectTurnTree(db, hash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing turn tree`,
      "sqlite_backend_missing_turn_tree_reference",
      { hash, label }
    );
  }
  return record;
}

export function ensureTurnNodeExistsInDatabase(
  db: Database.Database,
  hash: string,
  label: string
): StoredTurnNode {
  const record = selectTurnNode(db, hash);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing turn node`,
      "sqlite_backend_missing_turn_node_reference",
      { hash, label }
    );
  }
  return record;
}

export function ensureTurnNodeLineageMetadataInDatabase(
  db: Database.Database,
  turnNodeHash: string,
  label: string
): TurnNodeLineageMetadata {
  const metadata = selectTurnNodeLineageMetadata(db, turnNodeHash);
  if (metadata === null) {
    throw persistenceError(
      `${label} must have lineage root metadata`,
      "sqlite_backend_missing_turn_node_lineage_metadata",
      { label, turnNodeHash }
    );
  }
  return metadata;
}

export function ensureThreadExistsInDatabase(
  db: Database.Database,
  threadId: string,
  label: string
): StoredThread {
  const record = selectThread(db, threadId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing thread`,
      "sqlite_backend_missing_thread_reference",
      { label, threadId }
    );
  }
  return record;
}

export function ensureBranchExistsInDatabase(
  db: Database.Database,
  branchId: string,
  label: string
): StoredBranch {
  const record = selectBranch(db, branchId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing branch`,
      "sqlite_backend_missing_branch_reference",
      { branchId, label }
    );
  }
  return record;
}

export function ensureTurnExistsInDatabase(
  db: Database.Database,
  turnId: string,
  label: string
): StoredTurn {
  const record = selectTurn(db, turnId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing turn`,
      "sqlite_backend_missing_turn_reference",
      { label, turnId }
    );
  }
  return record;
}

export function ensureRunExistsInDatabase(
  db: Database.Database,
  runId: string,
  label: string
): StoredRun {
  const record = selectRun(db, runId);
  if (record === null) {
    throw persistenceError(
      `${label} must reference an existing run`,
      "sqlite_backend_missing_run_reference",
      { label, runId }
    );
  }
  return record;
}

export function getSchemaForSchemaIdInDatabase(
  db: Database.Database,
  schemaId: string,
  label: string
): TurnTreeSchema {
  const schemaRecord = ensureSchemaExistsInDatabase(db, schemaId, label);
  return decodeTurnTreeSchema(schemaRecord.schemaCbor, `${label} schema`);
}

export function getSchemaForTurnTreeInDatabase(
  db: Database.Database,
  turnTree: StoredTurnTree
): TurnTreeSchema {
  return getSchemaForSchemaIdInDatabase(
    db,
    turnTree.schemaId,
    "turnTree.schemaId"
  );
}
