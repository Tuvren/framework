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

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertHashString,
  type EpochMs,
  TuvrenPersistenceError,
  TuvrenValidationError,
} from "@tuvren/core-types";
import {
  assertStoredBranch,
  assertStoredObject,
  assertStoredObjectIdentity,
  assertStoredOrderedPathChunk,
  assertStoredOrderedPathChunkIdentity,
  assertStoredRun,
  assertStoredSchema,
  assertStoredStagedResult,
  assertStoredThread,
  assertStoredTurn,
  assertStoredTurnNode,
  assertStoredTurnNodeIdentity,
  assertStoredTurnTree,
  assertStoredTurnTreeIdentity,
  assertStoredTurnTreePath,
  assertTurnTreeSchema,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  type RuntimeBackend as KrakenBackend,
  type RuntimeBackendTx as KrakenBackendTx,
  type StoredBranch,
  type StoredObject,
  type StoredOrderedPathChunk,
  type StoredRun,
  type StoredSchema,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
  type StoredTurnNode,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import Database from "better-sqlite3";

const ORDERED_PATH_CHUNK_THRESHOLD = 32;
const ORDERED_PATH_CHUNK_SIZE = 32;
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const INITIAL_SCHEMA_MIGRATION_NAME = "0001_initial_schema.sql";
const TARGETED_VALIDATION_MIGRATION_NAME =
  "0002_targeted_validation_indexes.sql";
const INITIAL_SCHEMA_REQUIRED_TABLES = [
  "objects",
  "schemas",
  "turn_trees",
  "turn_tree_paths",
  "ordered_path_chunks",
  "turn_nodes",
  "threads",
  "branches",
  "turns",
  "runs",
  "staged_results",
] as const;
const INITIAL_SCHEMA_REQUIRED_INDEXES = [
  "idx_turn_trees_schema_id",
  "idx_turn_tree_paths_path_turn_tree_hash",
  "idx_turn_nodes_previous_turn_node_hash",
  "idx_turn_nodes_turn_tree_hash",
  "idx_branches_thread_id",
  "idx_branches_head_turn_node_hash",
  "idx_turns_thread_id",
  "idx_turns_branch_id",
  "idx_turns_parent_turn_id",
  "idx_runs_turn_id",
  "idx_runs_branch_id",
  "idx_runs_branch_id_status",
  "idx_staged_results_run_id_status",
  "idx_staged_results_object_hash",
] as const;
const TARGETED_VALIDATION_REQUIRED_TABLES = [
  "turn_node_lineage_roots",
] as const;
const TARGETED_VALIDATION_REQUIRED_INDEXES = [
  "idx_turn_node_lineage_roots_root_depth",
  "idx_threads_root_turn_node_hash",
  "idx_branches_archived_from_branch_id",
  "idx_turns_thread_branch_head_turn_node",
] as const;
const SQLITE_TRANSIENT_MEMORY_PATH = ":memory:";

interface ExpectedSqliteColumnSchema {
  name: string;
  notNull: boolean;
  primaryKeyOrder: number;
  type: string;
}

interface ExpectedSqliteForeignKeySchema {
  columns: readonly string[];
  referencedColumns: readonly string[];
  referencedTable: string;
}

interface ExpectedSqliteIndexSchema {
  columns: readonly string[];
  tableName: string;
  unique: boolean;
}

interface ExpectedSqliteTableSchema {
  columns: readonly ExpectedSqliteColumnSchema[];
  foreignKeys: readonly ExpectedSqliteForeignKeySchema[];
}

const INITIAL_SCHEMA_TABLE_DEFINITIONS = {
  branches: {
    columns: [
      {
        name: "branch_id",
        notNull: false,
        primaryKeyOrder: 1,
        type: "TEXT",
      },
      { name: "thread_id", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      {
        name: "head_turn_node_hash",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "archived_from_branch_id",
        notNull: false,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "created_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
      {
        name: "updated_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
    ],
    foreignKeys: [
      {
        columns: ["thread_id"],
        referencedColumns: ["thread_id"],
        referencedTable: "threads",
      },
      {
        columns: ["head_turn_node_hash"],
        referencedColumns: ["hash"],
        referencedTable: "turn_nodes",
      },
      {
        columns: ["archived_from_branch_id"],
        referencedColumns: ["branch_id"],
        referencedTable: "branches",
      },
    ],
  },
  objects: {
    columns: [
      { name: "hash", notNull: false, primaryKeyOrder: 1, type: "TEXT" },
      { name: "media_type", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      { name: "bytes", notNull: true, primaryKeyOrder: 0, type: "BLOB" },
      {
        name: "byte_length",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
      {
        name: "created_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
    ],
    foreignKeys: [],
  },
  ordered_path_chunks: {
    columns: [
      {
        name: "chunk_hash",
        notNull: false,
        primaryKeyOrder: 1,
        type: "TEXT",
      },
      {
        name: "item_count",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
      { name: "items_cbor", notNull: true, primaryKeyOrder: 0, type: "BLOB" },
      {
        name: "created_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
    ],
    foreignKeys: [],
  },
  runs: {
    columns: [
      { name: "run_id", notNull: false, primaryKeyOrder: 1, type: "TEXT" },
      { name: "turn_id", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      { name: "branch_id", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      { name: "schema_id", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      {
        name: "start_turn_node_hash",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      { name: "status", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      {
        name: "current_step_index",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
      {
        name: "step_sequence_cbor",
        notNull: true,
        primaryKeyOrder: 0,
        type: "BLOB",
      },
      {
        name: "created_turn_nodes_cbor",
        notNull: true,
        primaryKeyOrder: 0,
        type: "BLOB",
      },
      {
        name: "created_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
      {
        name: "updated_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
    ],
    foreignKeys: [
      {
        columns: ["turn_id"],
        referencedColumns: ["turn_id"],
        referencedTable: "turns",
      },
      {
        columns: ["branch_id"],
        referencedColumns: ["branch_id"],
        referencedTable: "branches",
      },
      {
        columns: ["schema_id"],
        referencedColumns: ["schema_id"],
        referencedTable: "schemas",
      },
      {
        columns: ["start_turn_node_hash"],
        referencedColumns: ["hash"],
        referencedTable: "turn_nodes",
      },
    ],
  },
  schemas: {
    columns: [
      {
        name: "schema_id",
        notNull: false,
        primaryKeyOrder: 1,
        type: "TEXT",
      },
      {
        name: "schema_cbor",
        notNull: true,
        primaryKeyOrder: 0,
        type: "BLOB",
      },
      {
        name: "created_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
    ],
    foreignKeys: [],
  },
  staged_results: {
    columns: [
      { name: "run_id", notNull: true, primaryKeyOrder: 1, type: "TEXT" },
      { name: "task_id", notNull: true, primaryKeyOrder: 2, type: "TEXT" },
      {
        name: "object_hash",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "object_type",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      { name: "status", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      {
        name: "interrupt_payload_cbor",
        notNull: false,
        primaryKeyOrder: 0,
        type: "BLOB",
      },
      {
        name: "created_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
    ],
    foreignKeys: [
      {
        columns: ["run_id"],
        referencedColumns: ["run_id"],
        referencedTable: "runs",
      },
      {
        columns: ["object_hash"],
        referencedColumns: ["hash"],
        referencedTable: "objects",
      },
    ],
  },
  threads: {
    columns: [
      {
        name: "thread_id",
        notNull: false,
        primaryKeyOrder: 1,
        type: "TEXT",
      },
      { name: "schema_id", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      {
        name: "root_turn_node_hash",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "created_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
    ],
    foreignKeys: [
      {
        columns: ["schema_id"],
        referencedColumns: ["schema_id"],
        referencedTable: "schemas",
      },
      {
        columns: ["root_turn_node_hash"],
        referencedColumns: ["hash"],
        referencedTable: "turn_nodes",
      },
    ],
  },
  turn_nodes: {
    columns: [
      { name: "hash", notNull: false, primaryKeyOrder: 1, type: "TEXT" },
      {
        name: "previous_turn_node_hash",
        notNull: false,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "turn_tree_hash",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "consumed_staged_results_cbor",
        notNull: true,
        primaryKeyOrder: 0,
        type: "BLOB",
      },
      { name: "schema_id", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      { name: "event_hash", notNull: false, primaryKeyOrder: 0, type: "TEXT" },
      {
        name: "created_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
    ],
    foreignKeys: [
      {
        columns: ["previous_turn_node_hash"],
        referencedColumns: ["hash"],
        referencedTable: "turn_nodes",
      },
      {
        columns: ["turn_tree_hash"],
        referencedColumns: ["hash"],
        referencedTable: "turn_trees",
      },
      {
        columns: ["schema_id"],
        referencedColumns: ["schema_id"],
        referencedTable: "schemas",
      },
      {
        columns: ["event_hash"],
        referencedColumns: ["hash"],
        referencedTable: "objects",
      },
    ],
  },
  turn_tree_paths: {
    columns: [
      {
        name: "turn_tree_hash",
        notNull: true,
        primaryKeyOrder: 1,
        type: "TEXT",
      },
      { name: "path", notNull: true, primaryKeyOrder: 2, type: "TEXT" },
      {
        name: "collection_kind",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      { name: "single_hash", notNull: false, primaryKeyOrder: 0, type: "TEXT" },
      {
        name: "ordered_encoding",
        notNull: false,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "ordered_count",
        notNull: false,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
      {
        name: "ordered_inline_cbor",
        notNull: false,
        primaryKeyOrder: 0,
        type: "BLOB",
      },
      {
        name: "ordered_chunk_list_cbor",
        notNull: false,
        primaryKeyOrder: 0,
        type: "BLOB",
      },
    ],
    foreignKeys: [
      {
        columns: ["turn_tree_hash"],
        referencedColumns: ["hash"],
        referencedTable: "turn_trees",
      },
    ],
  },
  turn_trees: {
    columns: [
      { name: "hash", notNull: false, primaryKeyOrder: 1, type: "TEXT" },
      { name: "schema_id", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      {
        name: "manifest_cbor",
        notNull: true,
        primaryKeyOrder: 0,
        type: "BLOB",
      },
      {
        name: "created_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
    ],
    foreignKeys: [
      {
        columns: ["schema_id"],
        referencedColumns: ["schema_id"],
        referencedTable: "schemas",
      },
    ],
  },
  turns: {
    columns: [
      { name: "turn_id", notNull: false, primaryKeyOrder: 1, type: "TEXT" },
      { name: "thread_id", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      { name: "branch_id", notNull: true, primaryKeyOrder: 0, type: "TEXT" },
      {
        name: "parent_turn_id",
        notNull: false,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "start_turn_node_hash",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "head_turn_node_hash",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "created_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
      {
        name: "updated_at_ms",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
    ],
    foreignKeys: [
      {
        columns: ["thread_id"],
        referencedColumns: ["thread_id"],
        referencedTable: "threads",
      },
      {
        columns: ["branch_id"],
        referencedColumns: ["branch_id"],
        referencedTable: "branches",
      },
      {
        columns: ["parent_turn_id"],
        referencedColumns: ["turn_id"],
        referencedTable: "turns",
      },
      {
        columns: ["start_turn_node_hash"],
        referencedColumns: ["hash"],
        referencedTable: "turn_nodes",
      },
      {
        columns: ["head_turn_node_hash"],
        referencedColumns: ["hash"],
        referencedTable: "turn_nodes",
      },
    ],
  },
} as const satisfies Record<
  (typeof INITIAL_SCHEMA_REQUIRED_TABLES)[number],
  ExpectedSqliteTableSchema
>;
const INITIAL_SCHEMA_INDEX_DEFINITIONS = {
  idx_branches_head_turn_node_hash: {
    columns: ["head_turn_node_hash"],
    tableName: "branches",
    unique: false,
  },
  idx_branches_thread_id: {
    columns: ["thread_id"],
    tableName: "branches",
    unique: false,
  },
  idx_runs_branch_id: {
    columns: ["branch_id"],
    tableName: "runs",
    unique: false,
  },
  idx_runs_branch_id_status: {
    columns: ["branch_id", "status"],
    tableName: "runs",
    unique: false,
  },
  idx_runs_turn_id: {
    columns: ["turn_id"],
    tableName: "runs",
    unique: false,
  },
  idx_staged_results_object_hash: {
    columns: ["object_hash"],
    tableName: "staged_results",
    unique: false,
  },
  idx_staged_results_run_id_status: {
    columns: ["run_id", "status"],
    tableName: "staged_results",
    unique: false,
  },
  idx_turn_nodes_previous_turn_node_hash: {
    columns: ["previous_turn_node_hash"],
    tableName: "turn_nodes",
    unique: false,
  },
  idx_turn_nodes_turn_tree_hash: {
    columns: ["turn_tree_hash"],
    tableName: "turn_nodes",
    unique: false,
  },
  idx_turn_tree_paths_path_turn_tree_hash: {
    columns: ["path", "turn_tree_hash"],
    tableName: "turn_tree_paths",
    unique: false,
  },
  idx_turn_trees_schema_id: {
    columns: ["schema_id"],
    tableName: "turn_trees",
    unique: false,
  },
  idx_turns_branch_id: {
    columns: ["branch_id"],
    tableName: "turns",
    unique: false,
  },
  idx_turns_parent_turn_id: {
    columns: ["parent_turn_id"],
    tableName: "turns",
    unique: false,
  },
  idx_turns_thread_id: {
    columns: ["thread_id"],
    tableName: "turns",
    unique: false,
  },
} as const satisfies Record<
  (typeof INITIAL_SCHEMA_REQUIRED_INDEXES)[number],
  ExpectedSqliteIndexSchema
>;
const TARGETED_VALIDATION_TABLE_DEFINITIONS = {
  turn_node_lineage_roots: {
    columns: [
      {
        name: "turn_node_hash",
        notNull: false,
        primaryKeyOrder: 1,
        type: "TEXT",
      },
      {
        name: "root_turn_node_hash",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "depth",
        notNull: true,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
    ],
    foreignKeys: [
      {
        columns: ["turn_node_hash"],
        referencedColumns: ["hash"],
        referencedTable: "turn_nodes",
      },
      {
        columns: ["root_turn_node_hash"],
        referencedColumns: ["hash"],
        referencedTable: "turn_nodes",
      },
    ],
  },
} as const satisfies Record<
  (typeof TARGETED_VALIDATION_REQUIRED_TABLES)[number],
  ExpectedSqliteTableSchema
>;
const TARGETED_VALIDATION_INDEX_DEFINITIONS = {
  idx_branches_archived_from_branch_id: {
    columns: ["archived_from_branch_id"],
    tableName: "branches",
    unique: false,
  },
  idx_threads_root_turn_node_hash: {
    columns: ["root_turn_node_hash"],
    tableName: "threads",
    unique: true,
  },
  idx_turn_node_lineage_roots_root_depth: {
    columns: ["root_turn_node_hash", "depth"],
    tableName: "turn_node_lineage_roots",
    unique: false,
  },
  idx_turns_thread_branch_head_turn_node: {
    columns: ["thread_id", "branch_id", "head_turn_node_hash"],
    tableName: "turns",
    unique: false,
  },
} as const satisfies Record<
  (typeof TARGETED_VALIDATION_REQUIRED_INDEXES)[number],
  ExpectedSqliteIndexSchema
>;

interface BackendState {
  branches: Map<string, StoredBranch>;
  objects: Map<string, StoredObject>;
  orderedPathChunks: Map<string, StoredOrderedPathChunk>;
  runs: Map<string, StoredRun>;
  schemas: Map<string, StoredSchema>;
  stagedResults: Map<string, Map<string, StoredStagedResult>>;
  threads: Map<string, StoredThread>;
  turnNodes: Map<string, StoredTurnNode>;
  turns: Map<string, StoredTurn>;
  turnTreePaths: Map<string, Map<string, StoredTurnTreePath>>;
  turnTrees: Map<string, StoredTurnTree>;
}

interface TurnNodeLineageMetadata {
  depth: number;
  rootTurnNodeHash: string;
  turnNodeHash: string;
}

interface MutableRepositories extends KrakenBackendTx {
  readonly now: () => number;
}

interface SqliteMigrationRow {
  name: string;
}

interface SqliteForeignKeyPragmaRow {
  from: string;
  id: number;
  match: string;
  on_delete: string;
  on_update: string;
  seq: number;
  table: string;
  to: string;
}

interface SqliteIndexInfoPragmaRow {
  cid: number;
  name: string;
  seqno: number;
}

interface SqliteIndexListPragmaRow {
  name: string;
  origin: string;
  partial: number;
  seq: number;
  unique: number;
}

interface SqliteTableInfoPragmaRow {
  cid: number;
  dflt_value: unknown;
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

interface SqliteObjectRow {
  byte_length: number;
  bytes: Uint8Array;
  created_at_ms: number;
  hash: string;
  media_type: string;
}

interface SqliteSchemaRow {
  created_at_ms: number;
  schema_cbor: Uint8Array;
  schema_id: string;
}

interface SqliteTurnTreeRow {
  created_at_ms: number;
  hash: string;
  manifest_cbor: Uint8Array;
  schema_id: string;
}

interface SqliteTurnTreePathRow {
  collection_kind: "ordered" | "single";
  ordered_chunk_list_cbor: Uint8Array | null;
  ordered_count: number | null;
  ordered_encoding: "chunked" | "flat" | null;
  ordered_inline_cbor: Uint8Array | null;
  path: string;
  single_hash: string | null;
  turn_tree_hash: string;
}

interface SqliteOrderedPathChunkRow {
  chunk_hash: string;
  created_at_ms: number;
  item_count: number;
  items_cbor: Uint8Array;
}

interface SqliteTurnNodeRow {
  consumed_staged_results_cbor: Uint8Array;
  created_at_ms: number;
  event_hash: string | null;
  hash: string;
  previous_turn_node_hash: string | null;
  schema_id: string;
  turn_tree_hash: string;
}

interface SqliteTurnNodeLineageRootRow {
  depth: number;
  root_turn_node_hash: string;
  turn_node_hash: string;
}

interface SqliteTurnNodeLineageProofRow {
  depth: number;
  hash: string;
  previous_turn_node_hash: string | null;
}

interface SqliteThreadRow {
  created_at_ms: number;
  root_turn_node_hash: string;
  schema_id: string;
  thread_id: string;
}

interface SqliteBranchRow {
  archived_from_branch_id: string | null;
  branch_id: string;
  created_at_ms: number;
  head_turn_node_hash: string;
  thread_id: string;
  updated_at_ms: number;
}

interface SqliteTurnRow {
  branch_id: string;
  created_at_ms: number;
  head_turn_node_hash: string;
  parent_turn_id: string | null;
  start_turn_node_hash: string;
  thread_id: string;
  turn_id: string;
  updated_at_ms: number;
}

interface SqliteRunRow {
  branch_id: string;
  created_at_ms: number;
  created_turn_nodes_cbor: Uint8Array;
  current_step_index: number;
  run_id: string;
  schema_id: string;
  start_turn_node_hash: string;
  status: StoredRun["status"];
  step_sequence_cbor: Uint8Array;
  turn_id: string;
  updated_at_ms: number;
}

interface SqliteStagedResultRow {
  created_at_ms: number;
  interrupt_payload_cbor: Uint8Array | null;
  object_hash: string;
  object_type: string;
  run_id: string;
  status: StoredStagedResult["status"];
  task_id: string;
}

export interface SqliteBackendOptions {
  /**
   * Filesystem-backed SQLite database path.
   *
   * Supports plain filesystem paths and `file:` URIs that resolve to
   * filesystem locations. Temporary or in-memory database paths are rejected
   * because this package is the persistent backend baseline for Epic F.
   */
  databasePath: string;
  /**
   * Optional clock used for migration bookkeeping and tests.
   *
   * When omitted, the backend uses `Date.now`.
   */
  now?: () => EpochMs;
}

interface TrackedRecord<T> {
  after: T | null;
  before: T | null;
}

class TransactionWriteTracker {
  readonly branchIdsForActiveRunValidation = new Set<string>();
  readonly branchWrites = new Map<string, TrackedRecord<StoredBranch>>();
  readonly runIds = new Set<string>();
  readonly stagedResultRunIds = new Set<string>();
  readonly threadIds = new Set<string>();
  readonly turnIds = new Set<string>();
  readonly turnIdsForDependentValidation = new Set<string>();
  readonly turnNodeHashes = new Set<string>();
  readonly turnTreeHashes = new Set<string>();

  captureBranchBaseline(
    db: Database.Database,
    branchId: string
  ): StoredBranch | null {
    const existing = this.branchWrites.get(branchId);

    if (existing !== undefined) {
      return existing.before === null
        ? null
        : cloneStoredBranch(existing.before);
    }

    const before = selectBranch(db, branchId);
    this.branchWrites.set(branchId, {
      after: before === null ? null : cloneStoredBranch(before),
      before: before === null ? null : cloneStoredBranch(before),
    });

    return before === null ? null : cloneStoredBranch(before);
  }

  recordBranchSet(before: StoredBranch | null, after: StoredBranch): void {
    const existing = this.branchWrites.get(after.branchId);
    this.branchWrites.set(after.branchId, {
      after: cloneStoredBranch(after),
      before:
        existing?.before ??
        (before === null ? null : cloneStoredBranch(before)),
    });
    this.branchIdsForActiveRunValidation.add(after.branchId);

    if (after.archivedFromBranchId !== undefined) {
      this.branchIdsForActiveRunValidation.add(after.archivedFromBranchId);
    }
  }

  recordRunSet(before: StoredRun | null, after: StoredRun): void {
    this.runIds.add(after.runId);
    this.stagedResultRunIds.add(after.runId);
    this.branchIdsForActiveRunValidation.add(after.branchId);

    if (before !== null) {
      this.branchIdsForActiveRunValidation.add(before.branchId);
    }
  }

  recordStagedResultSet(record: StoredStagedResult): void {
    this.stagedResultRunIds.add(record.runId);
    this.runIds.add(record.runId);
  }

  recordStagedResultClear(runId: string): void {
    this.stagedResultRunIds.add(runId);
    this.runIds.add(runId);
  }

  recordThreadPut(record: StoredThread): void {
    this.threadIds.add(record.threadId);
  }

  recordTurnSet(before: StoredTurn | null, after: StoredTurn): void {
    this.turnIds.add(after.turnId);
    this.branchIdsForActiveRunValidation.add(after.branchId);

    if (before !== null && before.headTurnNodeHash !== after.headTurnNodeHash) {
      this.turnIdsForDependentValidation.add(after.turnId);
    }
  }

  recordTurnNodePut(record: StoredTurnNode): void {
    this.turnNodeHashes.add(record.hash);
  }

  recordTurnTreePathWrite(turnTreeHash: string): void {
    this.turnTreeHashes.add(turnTreeHash);
  }

  recordTurnTreePut(record: StoredTurnTree): void {
    this.turnTreeHashes.add(record.hash);
  }
}

class SqliteBackend implements KrakenBackend {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(options: SqliteBackendOptions) {
    this.now = options.now ?? Date.now;
    this.db = openConfiguredDatabase(options.databasePath);
    runMigrations(this.db, this.now);
  }

  private async queueConnectionWork<T>(work: () => Promise<T>): Promise<T> {
    const priorTransaction = this.transactionQueue;
    let releaseQueue: (() => void) | undefined;

    this.transactionQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await priorTransaction;

    try {
      return await work();
    } finally {
      releaseQueue?.();
    }
  }

  health(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.queueConnectionWork(async () => {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        await loadValidatedState(this.db);
        this.db.exec("ROLLBACK");
        return { ok: true as const };
      } catch (error: unknown) {
        if (this.db.inTransaction) {
          this.db.exec("ROLLBACK");
        }

        return {
          ok: false as const,
          reason: getErrorMessage(normalizeBackendError(error)),
        };
      }
    });
  }

  transact<T>(work: (tx: KrakenBackendTx) => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore() === true) {
      throw persistenceError(
        "sqlite backend transactions must not be nested",
        "sqlite_backend_nested_transaction"
      );
    }

    return this.queueConnectionWork(async () => {
      let active = false;
      try {
        this.db.exec("BEGIN IMMEDIATE");
        const writeTracker = new TransactionWriteTracker();
        active = true;
        const repositories = createRepositories(
          this.db,
          this.now,
          () => active && this.transactionContext.getStore() === true,
          writeTracker
        );

        try {
          const result = await this.transactionContext.run(true, () =>
            work(repositories)
          );
          active = false;
          validateTransactionWriteSet(this.db, writeTracker);
          this.db.exec("COMMIT");
          return result;
        } catch (error: unknown) {
          active = false;
          if (this.db.inTransaction) {
            this.db.exec("ROLLBACK");
          }
          throw normalizeBackendError(error);
        }
      } catch (error: unknown) {
        active = false;
        if (this.db.inTransaction) {
          this.db.exec("ROLLBACK");
        }
        throw normalizeBackendError(error);
      }
    });
  }
}

/**
 * Creates the official SQLite-backed persistent kernel backend.
 *
 * The backend serializes transactions on a single connection, enforces the
 * package-local migration posture, and validates persisted state before it is
 * exposed to callers.
 */
export function createSqliteBackend(
  options: SqliteBackendOptions
): KrakenBackend {
  return new SqliteBackend(options);
}

function createRepositories(
  db: Database.Database,
  now: () => number,
  isTransactionActive: () => boolean,
  writeTracker: TransactionWriteTracker
): MutableRepositories {
  const assertTransactionActive = (): void => {
    if (!isTransactionActive()) {
      throw persistenceError(
        "sqlite backend transaction handles must not outlive their transaction",
        "sqlite_backend_inactive_transaction_handle"
      );
    }
  };

  return {
    branches: {
      get(branchId) {
        assertTransactionActive();
        const record = selectBranch(db, branchId);
        return Promise.resolve(
          record === null ? null : cloneStoredBranch(record)
        );
      },
      listByThread(threadId) {
        assertTransactionActive();
        const branches = selectBranchesByThread(db, threadId);
        branches.sort(compareStoredBranch);
        return Promise.resolve(branches.map(cloneStoredBranch));
      },
      set(record) {
        assertTransactionActive();
        assertStoredBranch(record, "record");
        ensureThreadExistsInDatabase(db, record.threadId, "record.threadId");
        ensureTurnNodeExistsInDatabase(
          db,
          record.headTurnNodeHash,
          "record.headTurnNodeHash"
        );
        if (record.archivedFromBranchId !== undefined) {
          ensureBranchExistsInDatabase(
            db,
            record.archivedFromBranchId,
            "record.archivedFromBranchId"
          );
          writeTracker.captureBranchBaseline(db, record.archivedFromBranchId);
        }

        const existingBranch = selectBranch(db, record.branchId);
        if (existingBranch !== null) {
          assertImmutableField(
            existingBranch.threadId,
            record.threadId,
            "record.threadId",
            "sqlite_backend_branch_thread_immutable"
          );
          assertImmutableField(
            existingBranch.createdAtMs,
            record.createdAtMs,
            "record.createdAtMs",
            "sqlite_backend_branch_created_at_immutable"
          );
          assertImmutableOptionalField(
            existingBranch.archivedFromBranchId,
            record.archivedFromBranchId,
            "record.archivedFromBranchId",
            "sqlite_backend_branch_archive_source_immutable"
          );
          assertMonotonicUpdatedAtMs(
            existingBranch.updatedAtMs,
            record.updatedAtMs,
            "record.updatedAtMs",
            "sqlite_backend_branch_updated_at_regressed"
          );
          assertBranchHeadMoveIsLinearInDatabase(
            db,
            existingBranch.headTurnNodeHash,
            record.headTurnNodeHash,
            "record.headTurnNodeHash"
          );
        }

        db.prepare(
          `
            INSERT INTO branches (
              branch_id,
              thread_id,
              head_turn_node_hash,
              archived_from_branch_id,
              created_at_ms,
              updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(branch_id) DO UPDATE SET
              head_turn_node_hash = excluded.head_turn_node_hash,
              updated_at_ms = excluded.updated_at_ms
          `
        ).run(
          record.branchId,
          record.threadId,
          record.headTurnNodeHash,
          record.archivedFromBranchId ?? null,
          record.createdAtMs,
          record.updatedAtMs
        );
        writeTracker.recordBranchSet(existingBranch, record);

        return Promise.resolve();
      },
    },
    now,
    objects: {
      get(hash) {
        assertTransactionActive();
        const record = selectObject(db, hash);
        return Promise.resolve(
          record === null ? null : cloneStoredObject(record)
        );
      },
      has(hash) {
        assertTransactionActive();
        return Promise.resolve(selectObject(db, hash) !== null);
      },
      async put(record) {
        assertTransactionActive();
        assertStoredObject(record, "record");
        await assertStoredObjectIdentity(record, "record");
        const existing = selectObject(db, record.hash);

        if (existing !== null) {
          ensureImmutableRecordMatch(
            existing,
            record,
            areStoredObjectsEqual,
            "stored object"
          );
          return;
        }

        db.prepare(
          `
            INSERT INTO objects (
              hash,
              media_type,
              bytes,
              byte_length,
              created_at_ms
            ) VALUES (?, ?, ?, ?, ?)
          `
        ).run(
          record.hash,
          record.mediaType,
          bufferFromBytes(record.bytes),
          record.byteLength,
          record.createdAtMs
        );
      },
    },
    orderedPathChunks: {
      get(chunkHash) {
        assertTransactionActive();
        const record = selectOrderedPathChunk(db, chunkHash);
        return Promise.resolve(
          record === null ? null : cloneStoredOrderedPathChunk(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        assertStoredOrderedPathChunk(record, "record");
        await assertStoredOrderedPathChunkIdentity(record, "record");
        insertOrderedPathChunk(db, record);
      },
    },
    runs: {
      get(runId) {
        assertTransactionActive();
        const record = selectRun(db, runId);
        return Promise.resolve(record === null ? null : cloneStoredRun(record));
      },
      listByBranch(branchId) {
        assertTransactionActive();
        const runs = selectRunsByBranch(db, branchId);
        runs.sort(compareStoredRun);
        return Promise.resolve(runs.map(cloneStoredRun));
      },
      set(record) {
        assertTransactionActive();
        assertStoredRun(record, "record");
        const branch = ensureBranchExistsInDatabase(
          db,
          record.branchId,
          "record.branchId"
        );
        ensureTurnExistsInDatabase(db, record.turnId, "record.turnId");
        ensureSchemaExistsInDatabase(db, record.schemaId, "record.schemaId");
        ensureTurnNodeExistsInDatabase(
          db,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );

        const existingRun = selectRun(db, record.runId);
        if (existingRun !== null) {
          assertRunUpdateIsLegal(existingRun, record);
        } else if (record.status !== "running") {
          throw persistenceError(
            "new runs must start in running status",
            "sqlite_backend_invalid_initial_run_status",
            { runId: record.runId, status: record.status }
          );
        } else if (branch.headTurnNodeHash !== record.startTurnNodeHash) {
          throw persistenceError(
            "stored runs must start from the current branch head when first created",
            "sqlite_backend_run_start_turn_node_mismatch",
            {
              branchHeadTurnNodeHash: branch.headTurnNodeHash,
              runId: record.runId,
              startTurnNodeHash: record.startTurnNodeHash,
            }
          );
        }

        db.prepare(
          `
            INSERT INTO runs (
              run_id,
              turn_id,
              branch_id,
              schema_id,
              start_turn_node_hash,
              status,
              current_step_index,
              step_sequence_cbor,
              created_turn_nodes_cbor,
              created_at_ms,
              updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
              status = excluded.status,
              current_step_index = excluded.current_step_index,
              created_turn_nodes_cbor = excluded.created_turn_nodes_cbor,
              updated_at_ms = excluded.updated_at_ms
          `
        ).run(
          record.runId,
          record.turnId,
          record.branchId,
          record.schemaId,
          record.startTurnNodeHash,
          record.status,
          record.currentStepIndex,
          bufferFromBytes(record.stepSequenceCbor),
          bufferFromBytes(record.createdTurnNodesCbor),
          record.createdAtMs,
          record.updatedAtMs
        );
        writeTracker.recordRunSet(existingRun, record);

        return Promise.resolve();
      },
    },
    schemas: {
      get(schemaId) {
        assertTransactionActive();
        const record = selectSchema(db, schemaId);
        return Promise.resolve(
          record === null ? null : cloneStoredSchema(record)
        );
      },
      put(record) {
        assertTransactionActive();
        assertStoredSchema(record, "record");
        const existing = selectSchema(db, record.schemaId);

        if (existing !== null) {
          ensureImmutableRecordMatch(
            existing,
            record,
            areStoredSchemasEqual,
            "stored schema"
          );
          return Promise.resolve();
        }

        db.prepare(
          `
            INSERT INTO schemas (schema_id, schema_cbor, created_at_ms)
            VALUES (?, ?, ?)
          `
        ).run(
          record.schemaId,
          bufferFromBytes(record.schemaCbor),
          record.createdAtMs
        );

        return Promise.resolve();
      },
    },
    stagedResults: {
      clearRun(runId) {
        assertTransactionActive();
        const result = db
          .prepare("DELETE FROM staged_results WHERE run_id = ?")
          .run(runId);

        if (result.changes > 0) {
          writeTracker.recordStagedResultClear(runId);
        }

        return Promise.resolve();
      },
      get(runId, taskId) {
        assertTransactionActive();
        const record = selectStagedResult(db, runId, taskId);
        return Promise.resolve(
          record === null ? null : cloneStoredStagedResult(record)
        );
      },
      listByRun(runId) {
        assertTransactionActive();
        const stagedResults = selectStagedResultsByRun(db, runId);
        stagedResults.sort(compareStoredStagedResult);
        return Promise.resolve(stagedResults.map(cloneStoredStagedResult));
      },
      set(record) {
        assertTransactionActive();
        assertStoredStagedResult(record, "record");
        ensureRunExistsInDatabase(db, record.runId, "record.runId");
        ensureObjectExistsInDatabase(
          db,
          record.objectHash,
          "record.objectHash"
        );
        const existing = selectStagedResult(db, record.runId, record.taskId);

        if (existing !== null) {
          ensureImmutableRecordMatch(
            existing,
            record,
            areStoredStagedResultsEqual,
            "stored staged result"
          );
          return Promise.resolve();
        }

        db.prepare(
          `
            INSERT INTO staged_results (
              run_id,
              task_id,
              object_hash,
              object_type,
              status,
              interrupt_payload_cbor,
              created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          record.runId,
          record.taskId,
          record.objectHash,
          record.objectType,
          record.status,
          record.status === "interrupted"
            ? bufferFromBytes(record.interruptPayloadCbor)
            : null,
          record.createdAtMs
        );
        writeTracker.recordStagedResultSet(record);

        return Promise.resolve();
      },
    },
    threads: {
      get(threadId) {
        assertTransactionActive();
        const record = selectThread(db, threadId);
        return Promise.resolve(
          record === null ? null : cloneStoredThread(record)
        );
      },
      put(record) {
        assertTransactionActive();
        assertStoredThread(record, "record");
        ensureSchemaExistsInDatabase(db, record.schemaId, "record.schemaId");
        ensureTurnNodeExistsInDatabase(
          db,
          record.rootTurnNodeHash,
          "record.rootTurnNodeHash"
        );
        const existing = selectThread(db, record.threadId);

        if (existing !== null) {
          ensureImmutableRecordMatch(
            existing,
            record,
            areStoredThreadsEqual,
            "stored thread"
          );
          return Promise.resolve();
        }

        db.prepare(
          `
            INSERT INTO threads (
              thread_id,
              schema_id,
              root_turn_node_hash,
              created_at_ms
            ) VALUES (?, ?, ?, ?)
          `
        ).run(
          record.threadId,
          record.schemaId,
          record.rootTurnNodeHash,
          record.createdAtMs
        );
        writeTracker.recordThreadPut(record);

        return Promise.resolve();
      },
    },
    turnNodes: {
      get(hash) {
        assertTransactionActive();
        const record = selectTurnNode(db, hash);
        return Promise.resolve(
          record === null ? null : cloneStoredTurnNode(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        assertStoredTurnNode(record, "record");
        await assertStoredTurnNodeIdentity(record, "record");
        ensureTurnTreeExistsInDatabase(
          db,
          record.turnTreeHash,
          "record.turnTreeHash"
        );
        if (record.previousTurnNodeHash !== null) {
          ensureTurnNodeExistsInDatabase(
            db,
            record.previousTurnNodeHash,
            "record.previousTurnNodeHash"
          );
        }
        if (record.eventHash !== null) {
          ensureObjectExistsInDatabase(
            db,
            record.eventHash,
            "record.eventHash"
          );
        }
        const existing = selectTurnNode(db, record.hash);

        if (existing !== null) {
          ensureImmutableRecordMatch(
            existing,
            record,
            areStoredTurnNodesEqual,
            "stored turn node"
          );
          return;
        }

        db.prepare(
          `
            INSERT INTO turn_nodes (
              hash,
              previous_turn_node_hash,
              turn_tree_hash,
              consumed_staged_results_cbor,
              schema_id,
              event_hash,
              created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          record.hash,
          record.previousTurnNodeHash,
          record.turnTreeHash,
          bufferFromBytes(record.consumedStagedResultsCbor),
          record.schemaId,
          record.eventHash,
          record.createdAtMs
        );
        insertTurnNodeLineageMetadata(db, record);
        writeTracker.recordTurnNodePut(record);
      },
    },
    turnTreePaths: {
      get(turnTreeHash, path) {
        assertTransactionActive();
        const record = selectTurnTreePath(db, turnTreeHash, path);
        return Promise.resolve(
          record === null ? null : cloneStoredTurnTreePath(record)
        );
      },
      listByTurnTree(turnTreeHash) {
        assertTransactionActive();
        const records = selectTurnTreePathsByTurnTree(db, turnTreeHash);
        records.sort((left, right) => left.path.localeCompare(right.path));
        return Promise.resolve(records.map(cloneStoredTurnTreePath));
      },
      async putMany(records) {
        assertTransactionActive();
        const seenCompositeKeys = new Set<string>();

        for (const record of records) {
          const compositeKey = `${record.turnTreeHash}:${record.path}`;
          if (seenCompositeKeys.has(compositeKey)) {
            throw persistenceError(
              "turn tree path batches must not contain duplicate keys",
              "sqlite_backend_duplicate_turn_tree_path_batch_entry",
              { compositeKey }
            );
          }

          seenCompositeKeys.add(compositeKey);
          await insertTurnTreePathBatchEntry(db, record, now);
          writeTracker.recordTurnTreePathWrite(record.turnTreeHash);
        }
      },
    },
    turnTrees: {
      get(hash) {
        assertTransactionActive();
        const record = selectTurnTree(db, hash);
        return Promise.resolve(
          record === null ? null : cloneStoredTurnTree(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        const schema = getSchemaForSchemaIdInDatabase(
          db,
          record.schemaId,
          "record.schemaId"
        );
        assertStoredTurnTree(record, schema, "record");
        await assertStoredTurnTreeIdentity(record, schema, "record");
        const existing = selectTurnTree(db, record.hash);

        if (existing !== null) {
          ensureImmutableRecordMatch(
            existing,
            record,
            areStoredTurnTreesEqual,
            "stored turn tree"
          );
          return;
        }

        db.prepare(
          `
            INSERT INTO turn_trees (
              hash,
              schema_id,
              manifest_cbor,
              created_at_ms
            ) VALUES (?, ?, ?, ?)
          `
        ).run(
          record.hash,
          record.schemaId,
          bufferFromBytes(record.manifestCbor),
          record.createdAtMs
        );
        writeTracker.recordTurnTreePut(record);
      },
    },
    turns: {
      get(turnId) {
        assertTransactionActive();
        const record = selectTurn(db, turnId);
        return Promise.resolve(
          record === null ? null : cloneStoredTurn(record)
        );
      },
      set(record) {
        assertTransactionActive();
        assertStoredTurn(record, "record");
        ensureThreadExistsInDatabase(db, record.threadId, "record.threadId");
        ensureBranchExistsInDatabase(db, record.branchId, "record.branchId");
        ensureTurnNodeExistsInDatabase(
          db,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );
        ensureTurnNodeExistsInDatabase(
          db,
          record.headTurnNodeHash,
          "record.headTurnNodeHash"
        );
        if (record.parentTurnId !== null) {
          ensureTurnExistsInDatabase(
            db,
            record.parentTurnId,
            "record.parentTurnId"
          );
        }

        const existingTurn = selectTurn(db, record.turnId);
        if (existingTurn !== null) {
          assertImmutableField(
            existingTurn.branchId,
            record.branchId,
            "record.branchId",
            "sqlite_backend_turn_branch_immutable"
          );
          assertImmutableField(
            existingTurn.threadId,
            record.threadId,
            "record.threadId",
            "sqlite_backend_turn_thread_immutable"
          );
          assertImmutableField(
            existingTurn.startTurnNodeHash,
            record.startTurnNodeHash,
            "record.startTurnNodeHash",
            "sqlite_backend_turn_start_immutable"
          );
          assertImmutableOptionalField(
            existingTurn.parentTurnId,
            record.parentTurnId,
            "record.parentTurnId",
            "sqlite_backend_turn_parent_immutable"
          );
          assertImmutableField(
            existingTurn.createdAtMs,
            record.createdAtMs,
            "record.createdAtMs",
            "sqlite_backend_turn_created_at_immutable"
          );
          assertMonotonicUpdatedAtMs(
            existingTurn.updatedAtMs,
            record.updatedAtMs,
            "record.updatedAtMs",
            "sqlite_backend_turn_updated_at_regressed"
          );
        }

        db.prepare(
          `
            INSERT INTO turns (
              turn_id,
              thread_id,
              branch_id,
              parent_turn_id,
              start_turn_node_hash,
              head_turn_node_hash,
              created_at_ms,
              updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(turn_id) DO UPDATE SET
              head_turn_node_hash = excluded.head_turn_node_hash,
              updated_at_ms = excluded.updated_at_ms
          `
        ).run(
          record.turnId,
          record.threadId,
          record.branchId,
          record.parentTurnId,
          record.startTurnNodeHash,
          record.headTurnNodeHash,
          record.createdAtMs,
          record.updatedAtMs
        );
        writeTracker.recordTurnSet(existingTurn, record);

        return Promise.resolve();
      },
    },
  };
}

function ensureDatabaseDirectory(databasePath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true });
}

function assertPersistentDatabasePath(databasePath: string): void {
  if (databasePath.length === 0) {
    throw persistenceError(
      "sqlite persistent backend requires a non-empty filesystem database path",
      "sqlite_backend_requires_persistent_database_path",
      { databasePath }
    );
  }

  if (databasePath === SQLITE_TRANSIENT_MEMORY_PATH) {
    throw persistenceError(
      "sqlite persistent backend requires a filesystem database path instead of :memory:",
      "sqlite_backend_requires_persistent_database_path",
      { databasePath }
    );
  }

  if (!databasePath.startsWith("file:")) {
    return;
  }

  const url = new URL(databasePath);
  if (url.searchParams.get("mode") !== "memory") {
    return;
  }

  throw persistenceError(
    "sqlite persistent backend requires a filesystem database path instead of an in-memory file URI",
    "sqlite_backend_requires_persistent_database_path",
    { databasePath }
  );
}

function normalizePersistentDatabasePath(databasePath: string): string {
  assertPersistentDatabasePath(databasePath);
  return resolveFilesystemDatabasePath(databasePath);
}

function resolveFilesystemDatabasePath(databasePath: string): string {
  if (!databasePath.startsWith("file:")) {
    return databasePath;
  }

  const [pathComponent] = databasePath.slice("file:".length).split("?", 1);

  if (pathComponent.startsWith("//")) {
    return fileURLToPath(new URL(databasePath));
  }

  return decodeURIComponent(pathComponent);
}

async function insertTurnTreePathBatchEntry(
  db: Database.Database,
  record: StoredTurnTreePath,
  now: () => number
): Promise<void> {
  const turnTree = ensureTurnTreeExistsInDatabase(
    db,
    record.turnTreeHash,
    "record.turnTreeHash"
  );
  const schema = getSchemaForTurnTreeInDatabase(db, turnTree);
  assertStoredTurnTreePath(record, schema, "record");

  const normalizedRecord = await normalizeStoredTurnTreePathInDatabase(
    db,
    record,
    now
  );
  const existing = selectTurnTreePath(
    db,
    normalizedRecord.turnTreeHash,
    normalizedRecord.path
  );

  if (existing !== null) {
    ensureImmutableRecordMatch(
      existing,
      normalizedRecord,
      areStoredTurnTreePathsEqual,
      "stored turn tree path"
    );
    return;
  }

  db.prepare(
    `
      INSERT INTO turn_tree_paths (
        turn_tree_hash,
        path,
        collection_kind,
        single_hash,
        ordered_encoding,
        ordered_count,
        ordered_inline_cbor,
        ordered_chunk_list_cbor
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    normalizedRecord.turnTreeHash,
    normalizedRecord.path,
    normalizedRecord.collectionKind,
    normalizedRecord.collectionKind === "single"
      ? normalizedRecord.singleHash
      : null,
    normalizedRecord.collectionKind === "ordered"
      ? normalizedRecord.orderedEncoding
      : null,
    normalizedRecord.collectionKind === "ordered"
      ? normalizedRecord.orderedCount
      : null,
    normalizedRecord.collectionKind === "ordered" &&
      normalizedRecord.orderedEncoding === "flat"
      ? bufferFromBytes(normalizedRecord.orderedInlineCbor)
      : null,
    normalizedRecord.collectionKind === "ordered" &&
      normalizedRecord.orderedEncoding === "chunked"
      ? bufferFromBytes(normalizedRecord.orderedChunkListCbor)
      : null
  );
}

function configureDatabase(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  const journalMode = db.pragma("journal_mode = WAL", {
    simple: true,
  });

  if (typeof journalMode !== "string" || journalMode.toLowerCase() !== "wal") {
    throw persistenceError(
      "sqlite backend requires WAL journal mode",
      "sqlite_backend_requires_wal_mode",
      { journalMode }
    );
  }
}

function openConfiguredDatabase(databasePath: string): Database.Database {
  const normalizedDatabasePath = normalizePersistentDatabasePath(databasePath);

  try {
    ensureDatabaseDirectory(normalizedDatabasePath);
    const db = new Database(normalizedDatabasePath, {
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    configureDatabase(db);
    return db;
  } catch (error: unknown) {
    throw normalizeBackendError(error);
  }
}

function runMigrations(db: Database.Database, now: () => number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_sqlite_migrations (
      name TEXT PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    )
  `);

  const recordMigration = db.prepare(
    `
      INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
      VALUES (?, ?)
    `
  );
  const applyMigration = db.transaction((fileName: string, sql: string) => {
    db.exec(sql);
    recordMigration.run(fileName, now());
  });

  const applied = new Set(
    (
      db
        .prepare("SELECT name FROM backend_sqlite_migrations ORDER BY name")
        .all() as SqliteMigrationRow[]
    ).map((row) => row.name)
  );
  const migrationDirectory = resolveMigrationDirectory();
  const migrationFiles = listMigrationFiles(migrationDirectory);

  validateMigrationState(db);

  for (const fileName of migrationFiles) {
    if (applied.has(fileName)) {
      continue;
    }

    const sql = readFileSync(`${migrationDirectory}/${fileName}`, "utf8");
    applyMigration(fileName, sql);
  }

  validateMigrationState(db);
}

function resolveMigrationDirectory(): string {
  const candidates = [
    fileURLToPath(new URL("./migrations", import.meta.url)),
    fileURLToPath(new URL("../../migrations", import.meta.url)),
    fileURLToPath(new URL("../migrations", import.meta.url)),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw persistenceError(
    "sqlite backend could not locate its migrations directory",
    "sqlite_backend_missing_migrations_directory"
  );
}

function validateMigrationState(db: Database.Database): void {
  const knownMigrationFiles = listMigrationFiles(resolveMigrationDirectory());
  const appliedMigrationNames = loadAppliedMigrationNames(db);
  const appliedMigrations = new Set(appliedMigrationNames);
  const unknownAppliedMigrations = [...appliedMigrations].filter(
    (migrationName) => !knownMigrationFiles.includes(migrationName)
  );

  if (unknownAppliedMigrations.length > 0) {
    throw persistenceError(
      "sqlite backend found applied migrations that this package version does not recognize",
      "sqlite_backend_unknown_applied_migration",
      {
        knownMigrationFiles,
        unknownAppliedMigrations,
      }
    );
  }

  if (!appliedMigrations.has(INITIAL_SCHEMA_MIGRATION_NAME)) {
    return;
  }

  validateBaselineSchemaPresence(db);

  if (appliedMigrations.has(TARGETED_VALIDATION_MIGRATION_NAME)) {
    validateTargetedValidationSchemaPresence(db);
  }

  const latestAppliedMigrationName = appliedMigrationNames.at(-1);
  if (latestAppliedMigrationName === INITIAL_SCHEMA_MIGRATION_NAME) {
    validateBaselineSchemaShape(db);
    return;
  }

  if (latestAppliedMigrationName === TARGETED_VALIDATION_MIGRATION_NAME) {
    validateBaselineSchemaShape(db);
    validateTargetedValidationSchemaShape(db);
  }
}

function loadAppliedMigrationNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM backend_sqlite_migrations ORDER BY name")
      .all() as SqliteMigrationRow[]
  ).map((row) => row.name);
}

function validateBaselineSchemaPresence(db: Database.Database): void {
  const existingTables = loadSqliteMasterNames(db, "table");
  const missingTables = INITIAL_SCHEMA_REQUIRED_TABLES.filter(
    (tableName) => !existingTables.has(tableName)
  );

  if (missingTables.length > 0) {
    throw persistenceError(
      "sqlite backend found an applied migration without its required schema tables",
      "sqlite_backend_applied_migration_schema_missing",
      {
        migrationName: INITIAL_SCHEMA_MIGRATION_NAME,
        missingTables,
      }
    );
  }

  const existingIndexes = loadSqliteMasterNames(db, "index");
  const missingIndexes = INITIAL_SCHEMA_REQUIRED_INDEXES.filter(
    (indexName) => !existingIndexes.has(indexName)
  );

  if (missingIndexes.length > 0) {
    throw persistenceError(
      "sqlite backend found an applied migration without its required schema indexes",
      "sqlite_backend_applied_migration_index_missing",
      {
        migrationName: INITIAL_SCHEMA_MIGRATION_NAME,
        missingIndexes,
      }
    );
  }
}

function validateTargetedValidationSchemaPresence(db: Database.Database): void {
  const existingTables = loadSqliteMasterNames(db, "table");
  const missingTables = TARGETED_VALIDATION_REQUIRED_TABLES.filter(
    (tableName) => !existingTables.has(tableName)
  );

  if (missingTables.length > 0) {
    throw persistenceError(
      "sqlite backend found an applied migration without its targeted validation tables",
      "sqlite_backend_applied_migration_schema_missing",
      {
        migrationName: TARGETED_VALIDATION_MIGRATION_NAME,
        missingTables,
      }
    );
  }

  const existingIndexes = loadSqliteMasterNames(db, "index");
  const missingIndexes = TARGETED_VALIDATION_REQUIRED_INDEXES.filter(
    (indexName) => !existingIndexes.has(indexName)
  );

  if (missingIndexes.length > 0) {
    throw persistenceError(
      "sqlite backend found an applied migration without its targeted validation indexes",
      "sqlite_backend_applied_migration_index_missing",
      {
        migrationName: TARGETED_VALIDATION_MIGRATION_NAME,
        missingIndexes,
      }
    );
  }
}

function validateBaselineSchemaShape(db: Database.Database): void {
  validateSqliteSchemaShape(
    db,
    INITIAL_SCHEMA_MIGRATION_NAME,
    INITIAL_SCHEMA_TABLE_DEFINITIONS,
    INITIAL_SCHEMA_INDEX_DEFINITIONS
  );
}

function validateTargetedValidationSchemaShape(db: Database.Database): void {
  validateSqliteSchemaShape(
    db,
    TARGETED_VALIDATION_MIGRATION_NAME,
    TARGETED_VALIDATION_TABLE_DEFINITIONS,
    TARGETED_VALIDATION_INDEX_DEFINITIONS
  );
}

function validateSqliteSchemaShape(
  db: Database.Database,
  migrationName: string,
  tableDefinitions: Readonly<Record<string, ExpectedSqliteTableSchema>>,
  indexDefinitions: Readonly<Record<string, ExpectedSqliteIndexSchema>>
): void {
  for (const [tableName, tableSchema] of Object.entries(tableDefinitions)) {
    validateSqliteTableSchema(db, migrationName, tableName, tableSchema);
  }

  for (const [indexName, indexSchema] of Object.entries(indexDefinitions)) {
    validateSqliteIndexSchema(db, migrationName, indexName, indexSchema);
  }
}

function loadSqliteMasterNames(
  db: Database.Database,
  type: "index" | "table"
): Set<string> {
  return new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
  );
}

function listMigrationFiles(migrationDirectory: string): string[] {
  return readdirSync(migrationDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
}

function validateSqliteTableSchema(
  db: Database.Database,
  migrationName: string,
  tableName: string,
  expectedSchema: ExpectedSqliteTableSchema
): void {
  const tableInfo = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as SqliteTableInfoPragmaRow[];
  const actualColumns = tableInfo.map((column) => ({
    name: column.name,
    notNull: column.notnull === 1,
    primaryKeyOrder: column.pk,
    type: column.type.toUpperCase(),
  }));
  const expectedColumns = expectedSchema.columns.map((column) => ({
    ...column,
    type: column.type.toUpperCase(),
  }));

  if (!areExpectedColumnsEqual(actualColumns, expectedColumns)) {
    throw persistenceError(
      "sqlite backend found an applied migration table whose column contract does not match the package schema",
      "sqlite_backend_applied_migration_schema_mismatch",
      {
        actualColumns,
        expectedColumns,
        migrationName,
        tableName,
      }
    );
  }

  const foreignKeyRows = db
    .prepare(`PRAGMA foreign_key_list(${tableName})`)
    .all() as SqliteForeignKeyPragmaRow[];
  const actualForeignKeys = groupForeignKeyRows(foreignKeyRows);
  if (
    !areExpectedForeignKeysEqual(actualForeignKeys, expectedSchema.foreignKeys)
  ) {
    throw persistenceError(
      "sqlite backend found an applied migration table whose foreign-key contract does not match the package schema",
      "sqlite_backend_applied_migration_schema_mismatch",
      {
        actualForeignKeys,
        expectedForeignKeys: expectedSchema.foreignKeys,
        migrationName,
        tableName,
      }
    );
  }
}

function validateSqliteIndexSchema(
  db: Database.Database,
  migrationName: string,
  indexName: string,
  expectedSchema: ExpectedSqliteIndexSchema
): void {
  const indexEntry = (
    db
      .prepare(`PRAGMA index_list(${expectedSchema.tableName})`)
      .all() as SqliteIndexListPragmaRow[]
  ).find((entry) => entry.name === indexName);

  if (indexEntry === undefined) {
    throw persistenceError(
      "sqlite backend found an applied migration without its required schema indexes",
      "sqlite_backend_applied_migration_index_missing",
      {
        indexName,
        migrationName,
      }
    );
  }

  const actualIndex = {
    columns: (
      db
        .prepare(`PRAGMA index_info(${indexName})`)
        .all() as SqliteIndexInfoPragmaRow[]
    )
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => column.name),
    partial: indexEntry.partial === 1,
    origin: indexEntry.origin,
    tableName: expectedSchema.tableName,
    unique: indexEntry.unique === 1,
  };
  const expectedIndex = {
    columns: [...expectedSchema.columns],
    partial: false,
    origin: "c",
    tableName: expectedSchema.tableName,
    unique: expectedSchema.unique,
  };

  if (!areExpectedIndexDefinitionsEqual(actualIndex, expectedIndex)) {
    throw persistenceError(
      "sqlite backend found an applied migration index whose definition does not match the package schema",
      "sqlite_backend_applied_migration_index_mismatch",
      {
        actualIndex,
        expectedIndex,
        indexName,
        migrationName,
      }
    );
  }
}

function groupForeignKeyRows(
  rows: readonly SqliteForeignKeyPragmaRow[]
): ExpectedSqliteForeignKeySchema[] {
  const groupedRows = new Map<number, SqliteForeignKeyPragmaRow[]>();

  for (const row of rows) {
    const group = groupedRows.get(row.id) ?? [];
    group.push(row);
    groupedRows.set(row.id, group);
  }

  return [...groupedRows.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, group]) => {
      const sortedGroup = [...group].sort(
        (left, right) => left.seq - right.seq
      );
      const [firstRow] = sortedGroup;
      if (firstRow === undefined) {
        throw new Error("expected at least one foreign key row");
      }

      return {
        columns: sortedGroup.map((row) => row.from),
        referencedColumns: sortedGroup.map((row) => row.to),
        referencedTable: firstRow.table,
      };
    });
}

function areExpectedColumnsEqual(
  left: readonly ExpectedSqliteColumnSchema[],
  right: readonly ExpectedSqliteColumnSchema[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (const [index, leftColumn] of left.entries()) {
    const rightColumn = right[index];
    if (
      rightColumn === undefined ||
      leftColumn.name !== rightColumn.name ||
      leftColumn.notNull !== rightColumn.notNull ||
      leftColumn.primaryKeyOrder !== rightColumn.primaryKeyOrder ||
      leftColumn.type !== rightColumn.type
    ) {
      return false;
    }
  }

  return true;
}

function areExpectedForeignKeysEqual(
  left: readonly ExpectedSqliteForeignKeySchema[],
  right: readonly ExpectedSqliteForeignKeySchema[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const normalizedLeft = [...left].sort(compareExpectedForeignKeys);
  const normalizedRight = [...right].sort(compareExpectedForeignKeys);

  for (const [index, leftForeignKey] of normalizedLeft.entries()) {
    const rightForeignKey = normalizedRight[index];
    if (
      rightForeignKey === undefined ||
      leftForeignKey.referencedTable !== rightForeignKey.referencedTable ||
      !areStringArraysEqual(leftForeignKey.columns, rightForeignKey.columns) ||
      !areStringArraysEqual(
        leftForeignKey.referencedColumns,
        rightForeignKey.referencedColumns
      )
    ) {
      return false;
    }
  }

  return true;
}

function compareExpectedForeignKeys(
  left: ExpectedSqliteForeignKeySchema,
  right: ExpectedSqliteForeignKeySchema
): number {
  return [
    left.referencedTable,
    left.columns.join("\u0000"),
    left.referencedColumns.join("\u0000"),
  ]
    .join("\u0001")
    .localeCompare(
      [
        right.referencedTable,
        right.columns.join("\u0000"),
        right.referencedColumns.join("\u0000"),
      ].join("\u0001")
    );
}

function areExpectedIndexDefinitionsEqual(
  left: {
    columns: readonly string[];
    origin: string;
    partial: boolean;
    tableName: string;
    unique: boolean;
  },
  right: {
    columns: readonly string[];
    origin: string;
    partial: boolean;
    tableName: string;
    unique: boolean;
  }
): boolean {
  return (
    left.origin === right.origin &&
    left.partial === right.partial &&
    left.tableName === right.tableName &&
    left.unique === right.unique &&
    areStringArraysEqual(left.columns, right.columns)
  );
}

function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (const [index, leftValue] of left.entries()) {
    if (right[index] !== leftValue) {
      return false;
    }
  }

  return true;
}

function loadState(db: Database.Database): BackendState {
  const state = createEmptyState();

  for (const row of db
    .prepare("SELECT * FROM objects")
    .all() as SqliteObjectRow[]) {
    const record = decodeObjectRow(row);
    setUniqueLoadedRecord(state.objects, record.hash, record, "object", {
      hash: record.hash,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM schemas")
    .all() as SqliteSchemaRow[]) {
    const record = decodeSchemaRow(row);
    setUniqueLoadedRecord(state.schemas, record.schemaId, record, "schema", {
      schemaId: record.schemaId,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM turn_trees")
    .all() as SqliteTurnTreeRow[]) {
    const record = decodeTurnTreeRow(row);
    setUniqueLoadedRecord(state.turnTrees, record.hash, record, "turn tree", {
      hash: record.hash,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM ordered_path_chunks")
    .all() as SqliteOrderedPathChunkRow[]) {
    const record = decodeOrderedPathChunkRow(row);
    setUniqueLoadedRecord(
      state.orderedPathChunks,
      record.chunkHash,
      record,
      "ordered path chunk",
      { chunkHash: record.chunkHash }
    );
  }

  for (const row of db
    .prepare("SELECT * FROM turn_tree_paths")
    .all() as SqliteTurnTreePathRow[]) {
    const record = decodeTurnTreePathRow(row);
    const treePaths =
      state.turnTreePaths.get(record.turnTreeHash) ??
      new Map<string, StoredTurnTreePath>();
    setUniqueLoadedRecord(treePaths, record.path, record, "turn tree path", {
      path: record.path,
      turnTreeHash: record.turnTreeHash,
    });
    state.turnTreePaths.set(record.turnTreeHash, treePaths);
  }

  for (const row of db
    .prepare("SELECT * FROM turn_nodes")
    .all() as SqliteTurnNodeRow[]) {
    const record = decodeTurnNodeRow(row);
    setUniqueLoadedRecord(state.turnNodes, record.hash, record, "turn node", {
      hash: record.hash,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM threads")
    .all() as SqliteThreadRow[]) {
    const record = decodeThreadRow(row);
    setUniqueLoadedRecord(state.threads, record.threadId, record, "thread", {
      threadId: record.threadId,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM branches")
    .all() as SqliteBranchRow[]) {
    const record = decodeBranchRow(row);
    setUniqueLoadedRecord(state.branches, record.branchId, record, "branch", {
      branchId: record.branchId,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM turns")
    .all() as SqliteTurnRow[]) {
    const record = decodeTurnRow(row);
    setUniqueLoadedRecord(state.turns, record.turnId, record, "turn", {
      turnId: record.turnId,
    });
  }

  for (const row of db.prepare("SELECT * FROM runs").all() as SqliteRunRow[]) {
    const record = decodeRunRow(row);
    setUniqueLoadedRecord(state.runs, record.runId, record, "run", {
      runId: record.runId,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM staged_results")
    .all() as SqliteStagedResultRow[]) {
    const record = decodeStagedResultRow(row);
    const stagedResults =
      state.stagedResults.get(record.runId) ??
      new Map<string, StoredStagedResult>();
    setUniqueLoadedRecord(
      stagedResults,
      record.taskId,
      record,
      "staged result",
      { runId: record.runId, taskId: record.taskId }
    );
    state.stagedResults.set(record.runId, stagedResults);
  }

  return state;
}

async function loadValidatedState(
  db: Database.Database,
  priorState?: BackendState
): Promise<BackendState> {
  validateMigrationState(db);
  const state = loadState(db);
  await validateLoadedState(state);
  validateTurnNodeLineageRootIndex(db, state);
  validateCommittedState(state, priorState ?? state);
  return state;
}

function validateTransactionWriteSet(
  db: Database.Database,
  writeTracker: TransactionWriteTracker
): void {
  for (const threadId of writeTracker.threadIds) {
    validateThreadInDatabase(db, threadId);
  }

  for (const turnTreeHash of writeTracker.turnTreeHashes) {
    validateTurnTreePathsInDatabase(db, turnTreeHash);
  }

  for (const turnNodeHash of writeTracker.turnNodeHashes) {
    validateTurnNodeInDatabase(db, turnNodeHash);
  }

  for (const turnId of writeTracker.turnIds) {
    validateTurnInDatabase(db, turnId);
  }

  for (const turnId of writeTracker.turnIdsForDependentValidation) {
    validateTurnDependentsInDatabase(db, turnId);
  }

  for (const [branchId] of writeTracker.branchWrites) {
    validateBranchInDatabase(db, writeTracker, branchId);
  }

  for (const runId of writeTracker.runIds) {
    validateRunInDatabase(db, runId);
  }

  for (const runId of writeTracker.stagedResultRunIds) {
    validateStagedResultsForRunInDatabase(db, runId);
  }

  for (const branchId of writeTracker.branchIdsForActiveRunValidation) {
    validateActiveRunsForBranchInDatabase(db, branchId);
  }
}

function validateThreadInDatabase(
  db: Database.Database,
  threadId: string
): void {
  const thread = selectThread(db, threadId);

  if (thread === null) {
    return;
  }

  const rootTurnNode = ensureTurnNodeExistsInDatabase(
    db,
    thread.rootTurnNodeHash,
    "thread.rootTurnNodeHash"
  );
  validateTurnNodeLineageMetadataInDatabase(db, rootTurnNode);

  if (rootTurnNode.schemaId !== thread.schemaId) {
    throw persistenceError(
      "stored threads must use the schema of their root turn node",
      "sqlite_backend_thread_schema_mismatch",
      {
        rootTurnNodeHash: thread.rootTurnNodeHash,
        threadId: thread.threadId,
        threadSchemaId: thread.schemaId,
        turnNodeSchemaId: rootTurnNode.schemaId,
      }
    );
  }

  if (rootTurnNode.previousTurnNodeHash !== null) {
    throw persistenceError(
      "stored thread roots must be genesis turn nodes",
      "sqlite_backend_thread_root_not_genesis",
      {
        previousTurnNodeHash: rootTurnNode.previousTurnNodeHash,
        rootTurnNodeHash: rootTurnNode.hash,
        threadId: thread.threadId,
      }
    );
  }

  const duplicateRootThread = db
    .prepare(
      `
        SELECT thread_id
        FROM threads
        WHERE root_turn_node_hash = ? AND thread_id <> ?
        LIMIT 1
      `
    )
    .get(thread.rootTurnNodeHash, thread.threadId) as
    | { thread_id: string }
    | undefined;

  if (duplicateRootThread !== undefined) {
    throw persistenceError(
      "stored thread roots must be unique across threads",
      "sqlite_backend_thread_root_not_unique",
      {
        existingOwnerThreadId: duplicateRootThread.thread_id,
        rootTurnNodeHash: thread.rootTurnNodeHash,
        threadId: thread.threadId,
      }
    );
  }
}

function validateBranchInDatabase(
  db: Database.Database,
  writeTracker: TransactionWriteTracker,
  branchId: string
): void {
  const branch = selectBranch(db, branchId);

  if (branch === null) {
    return;
  }

  const thread = ensureThreadExistsInDatabase(
    db,
    branch.threadId,
    "branch.threadId"
  );
  assertTurnNodeBelongsToThreadInDatabase(
    db,
    branch.headTurnNodeHash,
    thread,
    "branch.headTurnNodeHash"
  );

  if (branch.archivedFromBranchId !== undefined) {
    validateArchiveBranchInDatabase(db, writeTracker, branch);
  }

  const trackedBranch = writeTracker.branchWrites.get(branch.branchId);

  if (trackedBranch?.before === null || trackedBranch?.before === undefined) {
    return;
  }

  const headMoveDirection = classifyTurnNodeRelationshipInDatabase(
    db,
    trackedBranch.before.headTurnNodeHash,
    branch.headTurnNodeHash
  );

  if (headMoveDirection === "backward") {
    assertBackwardBranchMoveIsArchivedInDatabase(
      db,
      writeTracker,
      trackedBranch.before,
      branch
    );
  }
}

function validateArchiveBranchInDatabase(
  db: Database.Database,
  writeTracker: TransactionWriteTracker,
  branch: StoredBranch
): void {
  if (branch.archivedFromBranchId === undefined) {
    return;
  }

  const sourceBranch = ensureBranchExistsInDatabase(
    db,
    branch.archivedFromBranchId,
    "branch.archivedFromBranchId"
  );

  if (sourceBranch.threadId !== branch.threadId) {
    throw persistenceError(
      "stored branches must archive only from branches in the same thread",
      "sqlite_backend_branch_archive_thread_mismatch",
      {
        archivedFromBranchId: sourceBranch.branchId,
        branchId: branch.branchId,
        branchThreadId: branch.threadId,
        sourceThreadId: sourceBranch.threadId,
      }
    );
  }

  const trackedArchive = writeTracker.branchWrites.get(branch.branchId);

  if (trackedArchive?.before !== null) {
    return;
  }

  const trackedSource = writeTracker.branchWrites.get(
    branch.archivedFromBranchId
  );
  const sourceBranchBeforeTransaction =
    trackedSource?.before ??
    writeTracker.captureBranchBaseline(db, branch.archivedFromBranchId);

  if (sourceBranchBeforeTransaction === null) {
    throw persistenceError(
      "new archive branches must reference a source branch that existed before the transaction",
      "sqlite_backend_branch_archive_source_missing_before_transaction",
      {
        archivedFromBranchId: branch.archivedFromBranchId,
        branchId: branch.branchId,
      }
    );
  }

  if (
    branch.headTurnNodeHash !== sourceBranchBeforeTransaction.headTurnNodeHash
  ) {
    throw persistenceError(
      "new archive branches must preserve the pre-rollback source branch head",
      "sqlite_backend_branch_archive_head_mismatch",
      {
        archivedFromBranchId: branch.archivedFromBranchId,
        archiveHeadTurnNodeHash: branch.headTurnNodeHash,
        sourceHeadTurnNodeHash: sourceBranchBeforeTransaction.headTurnNodeHash,
      }
    );
  }

  if (
    classifyTurnNodeRelationshipInDatabase(
      db,
      sourceBranchBeforeTransaction.headTurnNodeHash,
      sourceBranch.headTurnNodeHash
    ) !== "backward"
  ) {
    throw persistenceError(
      "new archive branches must be paired with a backward move on their source branch",
      "sqlite_backend_branch_archive_without_backward_move",
      {
        archivedFromBranchId: branch.archivedFromBranchId,
        branchId: branch.branchId,
        sourceBranchHeadTurnNodeHash: sourceBranch.headTurnNodeHash,
        sourceBranchPreviousHeadTurnNodeHash:
          sourceBranchBeforeTransaction.headTurnNodeHash,
      }
    );
  }
}

function validateTurnNodeInDatabase(
  db: Database.Database,
  turnNodeHash: string
): void {
  const turnNode = selectTurnNode(db, turnNodeHash);

  if (turnNode === null) {
    return;
  }

  const turnTree = ensureTurnTreeExistsInDatabase(
    db,
    turnNode.turnTreeHash,
    "turnNode.turnTreeHash"
  );

  if (turnTree.schemaId !== turnNode.schemaId) {
    throw persistenceError(
      "stored turn nodes must use the schema of their referenced turn tree",
      "sqlite_backend_turn_node_schema_mismatch",
      {
        turnNodeHash: turnNode.hash,
        turnNodeSchemaId: turnNode.schemaId,
        turnTreeHash: turnTree.hash,
        turnTreeSchemaId: turnTree.schemaId,
      }
    );
  }

  validateTurnNodeLineageMetadataInDatabase(db, turnNode);

  for (const objectHash of decodeTurnNodeConsumedStagedResultObjectHashes(
    turnNode
  )) {
    ensureObjectExistsInDatabase(
      db,
      objectHash,
      "turnNode.consumedStagedResultsCbor"
    );
  }
}

function validateTurnNodeLineageMetadataInDatabase(
  db: Database.Database,
  turnNode: StoredTurnNode,
  label = "turnNode.hash"
): TurnNodeLineageMetadata {
  const actualMetadata = ensureTurnNodeLineageMetadataInDatabase(
    db,
    turnNode.hash,
    label
  );
  const lineageProof = selectBoundedTurnNodeLineageProofInDatabase(
    db,
    turnNode.hash,
    actualMetadata.depth
  );

  if (
    lineageProof === undefined ||
    lineageProof.depth !== actualMetadata.depth ||
    lineageProof.hash !== actualMetadata.rootTurnNodeHash ||
    lineageProof.previous_turn_node_hash !== null
  ) {
    throw persistenceError(
      "turn node lineage metadata must match the parent-linked turn node chain",
      "sqlite_backend_turn_node_lineage_metadata_mismatch",
      {
        actualDepth: actualMetadata.depth,
        actualRootTurnNodeHash: actualMetadata.rootTurnNodeHash,
        expectedDepth: lineageProof?.depth ?? null,
        expectedRootHasParent:
          lineageProof === undefined
            ? null
            : lineageProof.previous_turn_node_hash !== null,
        expectedRootTurnNodeHash: lineageProof?.hash ?? null,
        turnNodeHash: turnNode.hash,
      }
    );
  }

  return actualMetadata;
}

function selectBoundedTurnNodeLineageProofInDatabase(
  db: Database.Database,
  turnNodeHash: string,
  depth: number
): SqliteTurnNodeLineageProofRow | undefined {
  return db
    .prepare(
      `
        WITH RECURSIVE lineage(hash, previous_turn_node_hash, depth) AS (
          SELECT
            hash,
            previous_turn_node_hash,
            0 AS depth
          FROM turn_nodes
          WHERE hash = ?
          UNION ALL
          SELECT
            parent.hash,
            parent.previous_turn_node_hash,
            lineage.depth + 1
          FROM turn_nodes AS parent
          JOIN lineage ON parent.hash = lineage.previous_turn_node_hash
          WHERE lineage.depth < ?
        )
        SELECT hash, previous_turn_node_hash, depth
        FROM lineage
        ORDER BY depth DESC
        LIMIT 1
      `
    )
    .get(turnNodeHash, depth) as SqliteTurnNodeLineageProofRow | undefined;
}

function validateTurnInDatabase(db: Database.Database, turnId: string): void {
  const turn = selectTurn(db, turnId);

  if (turn === null) {
    return;
  }

  const thread = ensureThreadExistsInDatabase(
    db,
    turn.threadId,
    "turn.threadId"
  );
  const branch = ensureBranchExistsInDatabase(
    db,
    turn.branchId,
    "turn.branchId"
  );

  if (branch.threadId !== thread.threadId) {
    throw persistenceError(
      "stored turns must reference a branch on the same thread",
      "sqlite_backend_turn_branch_thread_mismatch",
      {
        branchId: branch.branchId,
        branchThreadId: branch.threadId,
        threadId: thread.threadId,
        turnId: turn.turnId,
      }
    );
  }

  assertTurnNodeBelongsToThreadInDatabase(
    db,
    turn.startTurnNodeHash,
    thread,
    "turn.startTurnNodeHash"
  );
  assertTurnNodeBelongsToThreadInDatabase(
    db,
    turn.headTurnNodeHash,
    thread,
    "turn.headTurnNodeHash"
  );
  assertTurnNodeDescendsFromInDatabase(
    db,
    turn.headTurnNodeHash,
    turn.startTurnNodeHash,
    "turn.headTurnNodeHash"
  );
  assertTurnParentLinkInDatabase(db, turn, "turn.parentTurnId");
}

function validateTurnDependentsInDatabase(
  db: Database.Database,
  turnId: string
): void {
  for (const dependentTurn of selectTurnsByParentTurnId(db, turnId)) {
    validateTurnInDatabase(db, dependentTurn.turnId);
  }

  for (const run of selectRunsByTurn(db, turnId)) {
    validateRunInDatabase(db, run.runId);
  }
}

function validateRunInDatabase(db: Database.Database, runId: string): void {
  const run = selectRun(db, runId);

  if (run === null) {
    return;
  }

  const branch = ensureBranchExistsInDatabase(db, run.branchId, "run.branchId");
  const turn = ensureTurnExistsInDatabase(db, run.turnId, "run.turnId");
  const startTurnNode = ensureTurnNodeExistsInDatabase(
    db,
    run.startTurnNodeHash,
    "run.startTurnNodeHash"
  );
  const thread = ensureThreadExistsInDatabase(
    db,
    turn.threadId,
    "turn.threadId"
  );

  if (turn.branchId !== branch.branchId) {
    throw persistenceError(
      "stored runs must reference a turn on the same branch",
      "sqlite_backend_run_branch_mismatch",
      {
        branchId: branch.branchId,
        runId: run.runId,
        turnBranchId: turn.branchId,
        turnId: turn.turnId,
      }
    );
  }

  assertTurnNodeBelongsToThreadInDatabase(
    db,
    run.startTurnNodeHash,
    thread,
    "run.startTurnNodeHash"
  );

  if (startTurnNode.schemaId !== run.schemaId) {
    throw persistenceError(
      "stored runs must use the schema of their start turn node",
      "sqlite_backend_run_schema_mismatch",
      {
        runId: run.runId,
        runSchemaId: run.schemaId,
        startTurnNodeHash: startTurnNode.hash,
        turnNodeSchemaId: startTurnNode.schemaId,
      }
    );
  }

  assertRunStartTurnNodeWithinTurnSpanInDatabase(
    db,
    turn,
    run.startTurnNodeHash,
    "run.startTurnNodeHash"
  );

  for (const turnNodeHash of decodeRunCreatedTurnNodeHashes(run)) {
    const createdTurnNode = ensureTurnNodeExistsInDatabase(
      db,
      turnNodeHash,
      "run.createdTurnNodesCbor"
    );
    assertTurnNodeBelongsToThreadInDatabase(
      db,
      turnNodeHash,
      thread,
      "run.createdTurnNodesCbor"
    );
    assertRunCreatedTurnNodeWithinTurnSpanInDatabase(
      db,
      turn,
      createdTurnNode,
      "run.createdTurnNodesCbor"
    );
  }

  assertRunCreatedTurnNodesAreCanonicalInDatabase(db, run);

  if (run.status === "running" || run.status === "paused") {
    assertActiveRunHeadAlignmentInDatabase(run, branch, turn);
  }
}

function validateStagedResultsForRunInDatabase(
  db: Database.Database,
  runId: string
): void {
  const run = ensureRunExistsInDatabase(db, runId, "stagedResults.runId");
  const stagedResultCount = countStagedResultsByRun(db, runId);

  if (run.status !== "running" && stagedResultCount > 0) {
    throw persistenceError(
      "stored terminal or paused runs must not retain staged results",
      "sqlite_backend_run_has_terminal_staged_results",
      {
        runId: run.runId,
        stagedResultCount,
        status: run.status,
      }
    );
  }
}

function validateActiveRunsForBranchInDatabase(
  db: Database.Database,
  branchId: string
): void {
  const branch = selectBranch(db, branchId);

  if (branch === null) {
    return;
  }

  const activeRuns = selectActiveRunsByBranch(db, branch.branchId);

  if (activeRuns.length > 1) {
    throw persistenceError(
      "stored branches must not have more than one active run",
      "sqlite_backend_multiple_active_runs",
      {
        activeRunCount: activeRuns.length,
        branchId: branch.branchId,
      }
    );
  }

  for (const run of activeRuns) {
    const turn = ensureTurnExistsInDatabase(db, run.turnId, "run.turnId");
    assertActiveRunHeadAlignmentInDatabase(run, branch, turn);
  }
}

function validateTurnTreePathsInDatabase(
  db: Database.Database,
  turnTreeHash: string
): void {
  const turnTree = selectTurnTree(db, turnTreeHash);

  if (turnTree === null) {
    return;
  }

  const state = createEmptyState();
  const schemaRecord = ensureSchemaExistsInDatabase(
    db,
    turnTree.schemaId,
    "turnTree.schemaId"
  );
  const storedPaths = selectTurnTreePathsByTurnTree(db, turnTree.hash);
  const pathMap = new Map<string, StoredTurnTreePath>();

  state.schemas.set(schemaRecord.schemaId, schemaRecord);
  state.turnTrees.set(turnTree.hash, turnTree);

  for (const storedPath of storedPaths) {
    pathMap.set(storedPath.path, storedPath);

    if (storedPath.collectionKind !== "ordered") {
      continue;
    }

    if (storedPath.orderedEncoding !== "chunked") {
      continue;
    }

    for (const chunkHash of decodeHashStringArray(
      storedPath.orderedChunkListCbor,
      "storedPath.orderedChunkListCbor"
    )) {
      const chunk = ensureOrderedPathChunkExistsInDatabase(
        db,
        chunkHash,
        "storedPath.orderedChunkListCbor"
      );
      state.orderedPathChunks.set(chunk.chunkHash, chunk);
    }
  }

  if (pathMap.size > 0) {
    state.turnTreePaths.set(turnTree.hash, pathMap);
  }

  validateTurnTreePathInvariants(state);
}

function validateTurnNodeLineageRootIndex(
  db: Database.Database,
  state: BackendState
): void {
  const actualMetadataByTurnNodeHash = new Map<
    string,
    TurnNodeLineageMetadata
  >();

  for (const row of db
    .prepare("SELECT * FROM turn_node_lineage_roots")
    .all() as SqliteTurnNodeLineageRootRow[]) {
    const metadata = decodeTurnNodeLineageMetadataRow(row);
    setUniqueLoadedRecord(
      actualMetadataByTurnNodeHash,
      metadata.turnNodeHash,
      metadata,
      "turn node lineage metadata",
      { turnNodeHash: metadata.turnNodeHash }
    );
  }

  for (const metadata of actualMetadataByTurnNodeHash.values()) {
    if (!state.turnNodes.has(metadata.turnNodeHash)) {
      throw persistenceError(
        "turn node lineage metadata must reference an existing turn node",
        "sqlite_backend_orphan_turn_node_lineage_metadata",
        { turnNodeHash: metadata.turnNodeHash }
      );
    }

    if (!state.turnNodes.has(metadata.rootTurnNodeHash)) {
      throw persistenceError(
        "turn node lineage metadata must reference an existing root turn node",
        "sqlite_backend_orphan_turn_node_lineage_metadata",
        {
          rootTurnNodeHash: metadata.rootTurnNodeHash,
          turnNodeHash: metadata.turnNodeHash,
        }
      );
    }
  }

  for (const turnNode of state.turnNodes.values()) {
    const actualMetadata = actualMetadataByTurnNodeHash.get(turnNode.hash);

    if (actualMetadata === undefined) {
      throw persistenceError(
        "turn nodes must have lineage root metadata",
        "sqlite_backend_missing_turn_node_lineage_metadata",
        { turnNodeHash: turnNode.hash }
      );
    }

    const expectedMetadata = computeExpectedTurnNodeLineageMetadata(
      state,
      turnNode
    );

    if (
      actualMetadata.rootTurnNodeHash !== expectedMetadata.rootTurnNodeHash ||
      actualMetadata.depth !== expectedMetadata.depth
    ) {
      throw persistenceError(
        "turn node lineage metadata must match the parent-linked turn node chain",
        "sqlite_backend_turn_node_lineage_metadata_mismatch",
        {
          actualDepth: actualMetadata.depth,
          actualRootTurnNodeHash: actualMetadata.rootTurnNodeHash,
          expectedDepth: expectedMetadata.depth,
          expectedRootTurnNodeHash: expectedMetadata.rootTurnNodeHash,
          turnNodeHash: turnNode.hash,
        }
      );
    }
  }
}

function computeExpectedTurnNodeLineageMetadata(
  state: BackendState,
  turnNode: StoredTurnNode
): TurnNodeLineageMetadata {
  const visitedTurnNodeHashes = new Set<string>();
  let currentTurnNode = turnNode;
  let depth = 0;

  while (currentTurnNode.previousTurnNodeHash !== null) {
    if (visitedTurnNodeHashes.has(currentTurnNode.hash)) {
      throw persistenceError(
        "turn node lineage must not contain cycles",
        "sqlite_backend_turn_node_lineage_cycle",
        { turnNodeHash: turnNode.hash }
      );
    }

    visitedTurnNodeHashes.add(currentTurnNode.hash);
    const previousTurnNode = state.turnNodes.get(
      currentTurnNode.previousTurnNodeHash
    );

    if (previousTurnNode === undefined) {
      throw persistenceError(
        "turn node lineage metadata requires complete turn node parent links",
        "sqlite_backend_missing_turn_node_reference",
        {
          previousTurnNodeHash: currentTurnNode.previousTurnNodeHash,
          turnNodeHash: turnNode.hash,
        }
      );
    }

    currentTurnNode = previousTurnNode;
    depth += 1;
  }

  return {
    depth,
    rootTurnNodeHash: currentTurnNode.hash,
    turnNodeHash: turnNode.hash,
  };
}

function setUniqueLoadedRecord<T>(
  records: Map<string, T>,
  key: string,
  value: T,
  recordType: string,
  details: Record<string, string>
): void {
  if (records.has(key)) {
    throw persistenceError(
      `sqlite backend found duplicate ${recordType} rows while loading persisted state`,
      "sqlite_backend_duplicate_loaded_record",
      { key, recordType, ...details }
    );
  }

  records.set(key, value);
}

function selectObject(
  db: Database.Database,
  hash: string
): StoredObject | null {
  const row = db.prepare("SELECT * FROM objects WHERE hash = ?").get(hash) as
    | SqliteObjectRow
    | undefined;
  return row === undefined ? null : decodeObjectRow(row);
}

function selectSchema(
  db: Database.Database,
  schemaId: string
): StoredSchema | null {
  const row = db
    .prepare("SELECT * FROM schemas WHERE schema_id = ?")
    .get(schemaId) as SqliteSchemaRow | undefined;
  return row === undefined ? null : decodeSchemaRow(row);
}

function selectTurnTree(
  db: Database.Database,
  hash: string
): StoredTurnTree | null {
  const row = db.prepare("SELECT * FROM turn_trees WHERE hash = ?").get(hash) as
    | SqliteTurnTreeRow
    | undefined;
  return row === undefined ? null : decodeTurnTreeRow(row);
}

function selectTurnTreePath(
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

function selectTurnTreePathsByTurnTree(
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

function selectOrderedPathChunk(
  db: Database.Database,
  chunkHash: string
): StoredOrderedPathChunk | null {
  const row = db
    .prepare("SELECT * FROM ordered_path_chunks WHERE chunk_hash = ?")
    .get(chunkHash) as SqliteOrderedPathChunkRow | undefined;
  return row === undefined ? null : decodeOrderedPathChunkRow(row);
}

function selectTurnNode(
  db: Database.Database,
  hash: string
): StoredTurnNode | null {
  const row = db.prepare("SELECT * FROM turn_nodes WHERE hash = ?").get(hash) as
    | SqliteTurnNodeRow
    | undefined;
  return row === undefined ? null : decodeTurnNodeRow(row);
}

function selectTurnNodeLineageMetadata(
  db: Database.Database,
  turnNodeHash: string
): TurnNodeLineageMetadata | null {
  const row = db
    .prepare("SELECT * FROM turn_node_lineage_roots WHERE turn_node_hash = ?")
    .get(turnNodeHash) as SqliteTurnNodeLineageRootRow | undefined;
  return row === undefined ? null : decodeTurnNodeLineageMetadataRow(row);
}

function selectThread(
  db: Database.Database,
  threadId: string
): StoredThread | null {
  const row = db
    .prepare("SELECT * FROM threads WHERE thread_id = ?")
    .get(threadId) as SqliteThreadRow | undefined;
  return row === undefined ? null : decodeThreadRow(row);
}

function selectBranch(
  db: Database.Database,
  branchId: string
): StoredBranch | null {
  const row = db
    .prepare("SELECT * FROM branches WHERE branch_id = ?")
    .get(branchId) as SqliteBranchRow | undefined;
  return row === undefined ? null : decodeBranchRow(row);
}

function selectBranchesByThread(
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

function selectTurn(db: Database.Database, turnId: string): StoredTurn | null {
  const row = db.prepare("SELECT * FROM turns WHERE turn_id = ?").get(turnId) as
    | SqliteTurnRow
    | undefined;
  return row === undefined ? null : decodeTurnRow(row);
}

function selectRun(db: Database.Database, runId: string): StoredRun | null {
  const row = db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
    | SqliteRunRow
    | undefined;
  return row === undefined ? null : decodeRunRow(row);
}

function selectRunsByTurn(db: Database.Database, turnId: string): StoredRun[] {
  const rows = db
    .prepare(
      "SELECT * FROM runs WHERE turn_id = ? ORDER BY created_at_ms, run_id"
    )
    .all(turnId) as SqliteRunRow[];
  return rows.map(decodeRunRow);
}

function selectRunsByBranch(
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

function selectTurnsByParentTurnId(
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

function selectActiveRunsByBranch(
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

function selectStagedResult(
  db: Database.Database,
  runId: string,
  taskId: string
): StoredStagedResult | null {
  const row = db
    .prepare("SELECT * FROM staged_results WHERE run_id = ? AND task_id = ?")
    .get(runId, taskId) as SqliteStagedResultRow | undefined;
  return row === undefined ? null : decodeStagedResultRow(row);
}

function selectStagedResultsByRun(
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

function countStagedResultsByRun(db: Database.Database, runId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM staged_results WHERE run_id = ?")
    .get(runId) as { count: number } | undefined;
  return row?.count ?? 0;
}

function ensureObjectExistsInDatabase(
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

function ensureOrderedPathChunkExistsInDatabase(
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

function ensureSchemaExistsInDatabase(
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

function ensureTurnTreeExistsInDatabase(
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

function ensureTurnNodeExistsInDatabase(
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

function ensureTurnNodeLineageMetadataInDatabase(
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

function ensureThreadExistsInDatabase(
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

function ensureBranchExistsInDatabase(
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

function ensureTurnExistsInDatabase(
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

function ensureRunExistsInDatabase(
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

function getSchemaForSchemaIdInDatabase(
  db: Database.Database,
  schemaId: string,
  label: string
): TurnTreeSchema {
  const schemaRecord = ensureSchemaExistsInDatabase(db, schemaId, label);
  return decodeTurnTreeSchema(schemaRecord.schemaCbor, `${label} schema`);
}

function getSchemaForTurnTreeInDatabase(
  db: Database.Database,
  turnTree: StoredTurnTree
): TurnTreeSchema {
  return getSchemaForSchemaIdInDatabase(
    db,
    turnTree.schemaId,
    "turnTree.schemaId"
  );
}

async function normalizeStoredTurnTreePathInDatabase(
  db: Database.Database,
  record: StoredTurnTreePath,
  now: () => number
): Promise<StoredTurnTreePath> {
  if (record.collectionKind === "single") {
    return cloneStoredTurnTreePath(record);
  }

  if (record.orderedEncoding === "chunked") {
    const chunkHashes = decodeHashStringArray(
      record.orderedChunkListCbor,
      "record.orderedChunkListCbor"
    );

    if (record.orderedCount <= ORDERED_PATH_CHUNK_THRESHOLD) {
      throw persistenceError(
        "chunked ordered turn tree paths must only be used after crossing the promotion threshold",
        "sqlite_backend_chunked_turn_tree_path_below_threshold",
        {
          orderedCount: record.orderedCount,
          threshold: ORDERED_PATH_CHUNK_THRESHOLD,
        }
      );
    }

    let totalCount = 0;
    for (const [index, chunkHash] of chunkHashes.entries()) {
      const chunk = selectOrderedPathChunk(db, chunkHash);
      if (chunk === null) {
        throw persistenceError(
          "chunked turn tree paths must reference existing chunk records",
          "sqlite_backend_missing_ordered_path_chunk_reference",
          { chunkHash, path: record.path, turnTreeHash: record.turnTreeHash }
        );
      }

      assertChunkedTurnTreePathChunkLayout(chunk, index, chunkHashes.length);
      totalCount += chunk.itemCount;
    }

    if (totalCount !== record.orderedCount) {
      throw persistenceError(
        "chunked turn tree paths must agree with the stored chunk cardinality",
        "sqlite_backend_chunked_turn_tree_path_count_mismatch",
        { orderedCount: record.orderedCount, totalCount }
      );
    }

    return cloneStoredTurnTreePath(record);
  }

  if (record.orderedCount <= ORDERED_PATH_CHUNK_THRESHOLD) {
    return cloneStoredTurnTreePath(record);
  }

  const orderedHashes = decodeHashStringArray(
    record.orderedInlineCbor,
    "record.orderedInlineCbor"
  );
  const chunkHashes: string[] = [];

  for (
    let index = 0;
    index < orderedHashes.length;
    index += ORDERED_PATH_CHUNK_SIZE
  ) {
    const chunkItems = orderedHashes.slice(
      index,
      index + ORDERED_PATH_CHUNK_SIZE
    );
    const itemsCbor = encodeHashStringArray(chunkItems);
    const chunkHash = await hashKernelRecord(chunkItems);
    const existingChunk = selectOrderedPathChunk(db, chunkHash);
    const chunkRecord: StoredOrderedPathChunk = {
      chunkHash,
      createdAtMs: existingChunk?.createdAtMs ?? now(),
      itemCount: chunkItems.length,
      itemsCbor,
    };

    insertOrderedPathChunk(db, chunkRecord);
    chunkHashes.push(chunkHash);
  }

  return {
    collectionKind: "ordered",
    orderedChunkListCbor: encodeHashStringArray(chunkHashes),
    orderedCount: record.orderedCount,
    orderedEncoding: "chunked",
    path: record.path,
    turnTreeHash: record.turnTreeHash,
  };
}

function insertOrderedPathChunk(
  db: Database.Database,
  record: StoredOrderedPathChunk
): void {
  const existing = selectOrderedPathChunk(db, record.chunkHash);

  if (existing !== null) {
    ensureImmutableRecordMatch(
      existing,
      record,
      areStoredOrderedPathChunksEqual,
      "ordered path chunk"
    );
    return;
  }

  db.prepare(
    `
      INSERT INTO ordered_path_chunks (
        chunk_hash,
        item_count,
        items_cbor,
        created_at_ms
      ) VALUES (?, ?, ?, ?)
    `
  ).run(
    record.chunkHash,
    record.itemCount,
    bufferFromBytes(record.itemsCbor),
    record.createdAtMs
  );
}

function insertTurnNodeLineageMetadata(
  db: Database.Database,
  record: StoredTurnNode
): void {
  const previousMetadata =
    record.previousTurnNodeHash === null
      ? null
      : getValidatedTurnNodeLineageMetadataInDatabase(
          db,
          record.previousTurnNodeHash
        );
  const metadata: TurnNodeLineageMetadata = {
    depth: previousMetadata === null ? 0 : previousMetadata.depth + 1,
    rootTurnNodeHash:
      previousMetadata === null
        ? record.hash
        : previousMetadata.rootTurnNodeHash,
    turnNodeHash: record.hash,
  };

  db.prepare(
    `
      INSERT INTO turn_node_lineage_roots (
        turn_node_hash,
        root_turn_node_hash,
        depth
      ) VALUES (?, ?, ?)
    `
  ).run(metadata.turnNodeHash, metadata.rootTurnNodeHash, metadata.depth);
}

function getValidatedTurnNodeLineageMetadataInDatabase(
  db: Database.Database,
  turnNodeHash: string
): TurnNodeLineageMetadata {
  return ensureValidatedTurnNodeLineageMetadataInDatabase(
    db,
    turnNodeHash,
    "record.previousTurnNodeHash"
  );
}

function ensureValidatedTurnNodeLineageMetadataInDatabase(
  db: Database.Database,
  turnNodeHash: string,
  label: string
): TurnNodeLineageMetadata {
  const turnNode = ensureTurnNodeExistsInDatabase(db, turnNodeHash, label);
  return validateTurnNodeLineageMetadataInDatabase(db, turnNode, label);
}

function decodeObjectRow(row: SqliteObjectRow): StoredObject {
  const record: StoredObject = {
    byteLength: row.byte_length,
    bytes: cloneBytes(toUint8Array(row.bytes)),
    createdAtMs: row.created_at_ms,
    hash: row.hash,
    mediaType: row.media_type,
  };
  assertStoredObject(record, "stored object row");
  return record;
}

function decodeSchemaRow(row: SqliteSchemaRow): StoredSchema {
  const record: StoredSchema = {
    createdAtMs: row.created_at_ms,
    schemaCbor: cloneEncodedBytes(toUint8Array(row.schema_cbor)),
    schemaId: row.schema_id,
  };
  assertStoredSchema(record, "stored schema row");
  return record;
}

function decodeTurnTreeRow(row: SqliteTurnTreeRow): StoredTurnTree {
  const record: StoredTurnTree = {
    createdAtMs: row.created_at_ms,
    hash: row.hash,
    manifestCbor: cloneEncodedBytes(toUint8Array(row.manifest_cbor)),
    schemaId: row.schema_id,
  };
  return record;
}

function decodeTurnTreePathRow(row: SqliteTurnTreePathRow): StoredTurnTreePath {
  if (row.collection_kind === "single") {
    return {
      collectionKind: "single",
      path: row.path,
      singleHash: row.single_hash,
      turnTreeHash: row.turn_tree_hash,
    };
  }

  if (row.collection_kind !== "ordered") {
    throw persistenceError(
      "stored turn tree path rows must decode to a valid ordered or single variant",
      "sqlite_backend_invalid_turn_tree_path_row",
      { path: row.path, turnTreeHash: row.turn_tree_hash }
    );
  }

  const orderedCount = decodeStoredNonNegativeInteger(
    row.ordered_count,
    "ordered_count",
    "sqlite_backend_invalid_turn_tree_path_row",
    { path: row.path, turnTreeHash: row.turn_tree_hash }
  );

  if (row.ordered_encoding === "flat" && row.ordered_inline_cbor !== null) {
    return {
      collectionKind: "ordered",
      orderedCount,
      orderedEncoding: "flat",
      orderedInlineCbor: cloneEncodedBytes(
        toUint8Array(row.ordered_inline_cbor)
      ),
      path: row.path,
      turnTreeHash: row.turn_tree_hash,
    };
  }

  if (
    row.ordered_encoding === "chunked" &&
    row.ordered_chunk_list_cbor !== null
  ) {
    return {
      collectionKind: "ordered",
      orderedChunkListCbor: cloneEncodedBytes(
        toUint8Array(row.ordered_chunk_list_cbor)
      ),
      orderedCount,
      orderedEncoding: "chunked",
      path: row.path,
      turnTreeHash: row.turn_tree_hash,
    };
  }

  throw persistenceError(
    "stored turn tree path rows must decode to a valid ordered or single variant",
    "sqlite_backend_invalid_turn_tree_path_row",
    { path: row.path, turnTreeHash: row.turn_tree_hash }
  );
}

function decodeOrderedPathChunkRow(
  row: SqliteOrderedPathChunkRow
): StoredOrderedPathChunk {
  const itemsCbor = cloneEncodedBytes(toUint8Array(row.items_cbor));
  const itemHashes = decodeHashStringArray(itemsCbor, "chunk.itemsCbor");
  const itemCount = decodeStoredNonNegativeInteger(
    row.item_count,
    "item_count",
    "sqlite_backend_invalid_ordered_path_chunk_row",
    { chunkHash: row.chunk_hash }
  );

  if (itemCount !== itemHashes.length) {
    throw persistenceError(
      "stored ordered path chunk rows must keep item_count aligned with items_cbor",
      "sqlite_backend_ordered_path_chunk_item_count_mismatch",
      {
        chunkHash: row.chunk_hash,
        decodedCount: itemHashes.length,
        itemCount,
      }
    );
  }

  return {
    chunkHash: row.chunk_hash,
    createdAtMs: row.created_at_ms,
    itemCount,
    itemsCbor,
  };
}

function decodeTurnNodeRow(row: SqliteTurnNodeRow): StoredTurnNode {
  const record: StoredTurnNode = {
    consumedStagedResultsCbor: cloneEncodedBytes(
      toUint8Array(row.consumed_staged_results_cbor)
    ),
    createdAtMs: row.created_at_ms,
    eventHash: row.event_hash,
    hash: row.hash,
    previousTurnNodeHash: row.previous_turn_node_hash,
    schemaId: row.schema_id,
    turnTreeHash: row.turn_tree_hash,
  };
  assertStoredTurnNode(record, "stored turn node row");
  return record;
}

function decodeTurnNodeLineageMetadataRow(
  row: SqliteTurnNodeLineageRootRow
): TurnNodeLineageMetadata {
  const turnNodeHash = validateHashString(row.turn_node_hash);
  const rootTurnNodeHash = validateHashString(row.root_turn_node_hash);
  const depth = decodeStoredNonNegativeInteger(
    row.depth,
    "depth",
    "sqlite_backend_invalid_turn_node_lineage_metadata_row",
    { rootTurnNodeHash, turnNodeHash }
  );

  return {
    depth,
    rootTurnNodeHash,
    turnNodeHash,
  };
}

function decodeThreadRow(row: SqliteThreadRow): StoredThread {
  const record: StoredThread = {
    createdAtMs: row.created_at_ms,
    rootTurnNodeHash: row.root_turn_node_hash,
    schemaId: row.schema_id,
    threadId: row.thread_id,
  };
  assertStoredThread(record, "stored thread row");
  return record;
}

function decodeBranchRow(row: SqliteBranchRow): StoredBranch {
  const record: StoredBranch = {
    ...(row.archived_from_branch_id === null
      ? {}
      : { archivedFromBranchId: row.archived_from_branch_id }),
    branchId: row.branch_id,
    createdAtMs: row.created_at_ms,
    headTurnNodeHash: row.head_turn_node_hash,
    threadId: row.thread_id,
    updatedAtMs: row.updated_at_ms,
  };
  assertStoredBranch(record, "stored branch row");
  return record;
}

function decodeTurnRow(row: SqliteTurnRow): StoredTurn {
  const record: StoredTurn = {
    branchId: row.branch_id,
    createdAtMs: row.created_at_ms,
    headTurnNodeHash: row.head_turn_node_hash,
    parentTurnId: row.parent_turn_id,
    startTurnNodeHash: row.start_turn_node_hash,
    threadId: row.thread_id,
    turnId: row.turn_id,
    updatedAtMs: row.updated_at_ms,
  };
  assertStoredTurn(record, "stored turn row");
  return record;
}

function decodeUnknownTurnRow(row: unknown): StoredTurn {
  const label = "stored turn query row";

  if (!isUnknownRecord(row)) {
    throw persistenceError(
      `${label} must be an object`,
      "sqlite_backend_invalid_turn_row",
      {}
    );
  }

  return decodeTurnRow({
    branch_id: readSqliteStringColumn(row, "branch_id", label),
    created_at_ms: readSqliteNumberColumn(row, "created_at_ms", label),
    head_turn_node_hash: readSqliteStringColumn(
      row,
      "head_turn_node_hash",
      label
    ),
    parent_turn_id: readSqliteNullableStringColumn(
      row,
      "parent_turn_id",
      label
    ),
    start_turn_node_hash: readSqliteStringColumn(
      row,
      "start_turn_node_hash",
      label
    ),
    thread_id: readSqliteStringColumn(row, "thread_id", label),
    turn_id: readSqliteStringColumn(row, "turn_id", label),
    updated_at_ms: readSqliteNumberColumn(row, "updated_at_ms", label),
  });
}

function readSqliteStringColumn(
  row: Record<string, unknown>,
  column: string,
  label: string
): string {
  const value = row[column];

  if (typeof value === "string") {
    return value;
  }

  throw persistenceError(
    `${label} column "${column}" must be a string`,
    "sqlite_backend_invalid_turn_row",
    { column }
  );
}

function readSqliteNullableStringColumn(
  row: Record<string, unknown>,
  column: string,
  label: string
): string | null {
  const value = row[column];

  if (value === null || typeof value === "string") {
    return value;
  }

  throw persistenceError(
    `${label} column "${column}" must be a string or null`,
    "sqlite_backend_invalid_turn_row",
    { column }
  );
}

function readSqliteNumberColumn(
  row: Record<string, unknown>,
  column: string,
  label: string
): number {
  const value = row[column];

  if (typeof value === "number") {
    return value;
  }

  throw persistenceError(
    `${label} column "${column}" must be a number`,
    "sqlite_backend_invalid_turn_row",
    { column }
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeRunRow(row: SqliteRunRow): StoredRun {
  const status = decodeStoredRunStatus(row.status, row.run_id);

  const record: StoredRun = {
    branchId: row.branch_id,
    createdAtMs: row.created_at_ms,
    createdTurnNodesCbor: cloneEncodedBytes(
      toUint8Array(row.created_turn_nodes_cbor)
    ),
    currentStepIndex: row.current_step_index,
    runId: row.run_id,
    schemaId: row.schema_id,
    startTurnNodeHash: row.start_turn_node_hash,
    status,
    stepSequenceCbor: cloneEncodedBytes(toUint8Array(row.step_sequence_cbor)),
    turnId: row.turn_id,
    updatedAtMs: row.updated_at_ms,
  };
  assertStoredRun(record, "stored run row");
  return record;
}

function decodeStagedResultRow(row: SqliteStagedResultRow): StoredStagedResult {
  if (row.status === "interrupted") {
    if (row.interrupt_payload_cbor === null) {
      throw persistenceError(
        "stored staged result rows with interrupted status must include interrupt_payload_cbor",
        "sqlite_backend_invalid_staged_result_row",
        { runId: row.run_id, status: row.status, taskId: row.task_id }
      );
    }

    const record: StoredStagedResult = {
      createdAtMs: row.created_at_ms,
      interruptPayloadCbor: cloneEncodedBytes(
        toUint8Array(row.interrupt_payload_cbor)
      ),
      objectHash: row.object_hash,
      objectType: row.object_type,
      runId: row.run_id,
      status: "interrupted",
      taskId: row.task_id,
    };
    assertStoredStagedResult(record, "stored staged result row");
    return record;
  }

  if (row.interrupt_payload_cbor !== null) {
    throw persistenceError(
      "stored staged result rows may only include interrupt_payload_cbor for interrupted status",
      "sqlite_backend_invalid_staged_result_row",
      { runId: row.run_id, status: row.status, taskId: row.task_id }
    );
  }

  if (row.status !== "completed" && row.status !== "failed") {
    throw persistenceError(
      "stored staged result rows must decode to a valid staged result status",
      "sqlite_backend_invalid_staged_result_row",
      { runId: row.run_id, status: row.status, taskId: row.task_id }
    );
  }

  const record: StoredStagedResult = {
    createdAtMs: row.created_at_ms,
    objectHash: row.object_hash,
    objectType: row.object_type,
    runId: row.run_id,
    status: row.status,
    taskId: row.task_id,
  };
  assertStoredStagedResult(record, "stored staged result row");
  return record;
}

function decodeStoredNonNegativeInteger(
  value: number | null,
  field: string,
  code: string,
  details: Record<string, unknown>
): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    throw persistenceError(
      `stored rows must keep ${field} as a non-negative safe integer`,
      code,
      details
    );
  }

  return value;
}

function decodeStoredRunStatus(
  value: unknown,
  runId: string
): StoredRun["status"] {
  if (
    value === "running" ||
    value === "paused" ||
    value === "completed" ||
    value === "failed"
  ) {
    return value;
  }

  throw persistenceError(
    "stored run rows must decode to a valid run status",
    "sqlite_backend_invalid_run_status",
    { runId, status: value }
  );
}

function toUint8Array(bytes: Uint8Array): Uint8Array {
  return Buffer.from(bytes);
}

function bufferFromBytes(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

function normalizeBackendError(error: unknown): Error {
  if (error instanceof TuvrenPersistenceError) {
    return error;
  }

  if (error instanceof TuvrenValidationError) {
    return error;
  }

  if (error instanceof Error) {
    const sqliteCode =
      typeof Reflect.get(error, "code") === "string"
        ? (Reflect.get(error, "code") as string)
        : undefined;

    if (sqliteCode?.startsWith("SQLITE_") === true) {
      return persistenceError(
        `sqlite backend engine operation failed: ${error.message}`,
        "sqlite_backend_engine_error",
        {
          message: error.message,
          sqliteCode,
        },
        error
      );
    }

    return error;
  }

  return persistenceError(
    "sqlite backend operation failed",
    "sqlite_backend_operation_failed",
    { value: String(error) }
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createEmptyState(): BackendState {
  return {
    branches: new Map(),
    objects: new Map(),
    orderedPathChunks: new Map(),
    runs: new Map(),
    schemas: new Map(),
    stagedResults: new Map(),
    threads: new Map(),
    turnNodes: new Map(),
    turnTreePaths: new Map(),
    turnTrees: new Map(),
    turns: new Map(),
  };
}

async function validateLoadedState(state: BackendState): Promise<void> {
  for (const objectRecord of state.objects.values()) {
    await assertStoredObjectIdentity(objectRecord, "stored object row");
  }

  for (const schemaRecord of state.schemas.values()) {
    assertStoredSchema(schemaRecord, "stored schema row");
  }

  for (const turnTree of state.turnTrees.values()) {
    const schema = getSchemaForSchemaId(
      state,
      turnTree.schemaId,
      "turnTree.schemaId"
    );
    await assertStoredTurnTreeIdentity(
      turnTree,
      schema,
      "stored turn tree row"
    );
  }

  for (const chunkRecord of state.orderedPathChunks.values()) {
    await assertStoredOrderedPathChunkIdentity(
      chunkRecord,
      "stored ordered path chunk row"
    );
  }

  for (const storedPaths of state.turnTreePaths.values()) {
    for (const storedPath of storedPaths.values()) {
      const turnTree = ensureTurnTreeExists(
        state,
        storedPath.turnTreeHash,
        "turnTreePath.turnTreeHash"
      );
      const schema = getSchemaForSchemaId(
        state,
        turnTree.schemaId,
        "turnTree.schemaId"
      );
      assertStoredTurnTreePath(storedPath, schema, "stored turn tree path row");
    }
  }

  for (const turnNode of state.turnNodes.values()) {
    await assertStoredTurnNodeIdentity(turnNode, "stored turn node row");
  }

  for (const thread of state.threads.values()) {
    assertStoredThread(thread, "stored thread row");
  }

  for (const branch of state.branches.values()) {
    assertStoredBranch(branch, "stored branch row");
  }

  for (const turn of state.turns.values()) {
    assertStoredTurn(turn, "stored turn row");
  }

  for (const run of state.runs.values()) {
    assertStoredRun(run, "stored run row");
  }

  for (const stagedResults of state.stagedResults.values()) {
    for (const stagedResult of stagedResults.values()) {
      assertStoredStagedResult(stagedResult, "stored staged result row");
    }
  }
}

function validateCommittedState(
  state: BackendState,
  baseState: BackendState
): void {
  validateThreadInvariants(state);
  validateBranchInvariants(state, baseState);
  validateTurnNodeInvariants(state);
  validateTurnInvariants(state);
  validateRunInvariants(state);
  validateTurnTreePathInvariants(state);
}

function validateThreadInvariants(state: BackendState): void {
  const rootTurnNodeOwners = new Map<string, string>();

  for (const thread of state.threads.values()) {
    const rootTurnNode = ensureTurnNodeExists(
      state,
      thread.rootTurnNodeHash,
      "thread.rootTurnNodeHash"
    );

    if (rootTurnNode.schemaId !== thread.schemaId) {
      throw persistenceError(
        "stored threads must use the schema of their root turn node",
        "sqlite_backend_thread_schema_mismatch",
        {
          rootTurnNodeHash: thread.rootTurnNodeHash,
          threadId: thread.threadId,
          threadSchemaId: thread.schemaId,
          turnNodeSchemaId: rootTurnNode.schemaId,
        }
      );
    }

    if (rootTurnNode.previousTurnNodeHash !== null) {
      throw persistenceError(
        "stored thread roots must be genesis turn nodes",
        "sqlite_backend_thread_root_not_genesis",
        {
          previousTurnNodeHash: rootTurnNode.previousTurnNodeHash,
          rootTurnNodeHash: rootTurnNode.hash,
          threadId: thread.threadId,
        }
      );
    }

    const existingOwnerThreadId = rootTurnNodeOwners.get(
      thread.rootTurnNodeHash
    );
    if (
      existingOwnerThreadId !== undefined &&
      existingOwnerThreadId !== thread.threadId
    ) {
      throw persistenceError(
        "stored thread roots must be unique across threads",
        "sqlite_backend_thread_root_not_unique",
        {
          existingOwnerThreadId,
          rootTurnNodeHash: thread.rootTurnNodeHash,
          threadId: thread.threadId,
        }
      );
    }

    rootTurnNodeOwners.set(thread.rootTurnNodeHash, thread.threadId);
  }
}

function validateBranchInvariants(
  state: BackendState,
  baseState: BackendState
): void {
  for (const branch of state.branches.values()) {
    const thread = ensureThreadExists(
      state,
      branch.threadId,
      "branch.threadId"
    );

    assertTurnNodeBelongsToThread(
      state,
      branch.headTurnNodeHash,
      thread,
      "branch.headTurnNodeHash"
    );

    if (branch.archivedFromBranchId === undefined) {
      continue;
    }

    const sourceBranch = ensureBranchExists(
      state,
      branch.archivedFromBranchId,
      "branch.archivedFromBranchId"
    );

    if (sourceBranch.threadId !== branch.threadId) {
      throw persistenceError(
        "stored branches must archive only from branches in the same thread",
        "sqlite_backend_branch_archive_thread_mismatch",
        {
          archivedFromBranchId: sourceBranch.branchId,
          branchId: branch.branchId,
          branchThreadId: branch.threadId,
          sourceThreadId: sourceBranch.threadId,
        }
      );
    }

    const existingBranch = baseState.branches.get(branch.branchId);
    const sourceBranchBeforeTransaction = baseState.branches.get(
      branch.archivedFromBranchId
    );

    if (
      existingBranch === undefined &&
      sourceBranchBeforeTransaction === undefined
    ) {
      throw persistenceError(
        "new archive branches must reference a source branch that existed before the transaction",
        "sqlite_backend_branch_archive_source_missing_before_transaction",
        {
          archivedFromBranchId: branch.archivedFromBranchId,
          branchId: branch.branchId,
        }
      );
    }

    if (
      existingBranch === undefined &&
      sourceBranchBeforeTransaction !== undefined &&
      branch.headTurnNodeHash !== sourceBranchBeforeTransaction.headTurnNodeHash
    ) {
      throw persistenceError(
        "new archive branches must preserve the pre-rollback source branch head",
        "sqlite_backend_branch_archive_head_mismatch",
        {
          archivedFromBranchId: branch.archivedFromBranchId,
          archiveHeadTurnNodeHash: branch.headTurnNodeHash,
          sourceHeadTurnNodeHash:
            sourceBranchBeforeTransaction.headTurnNodeHash,
        }
      );
    }

    if (
      existingBranch === undefined &&
      sourceBranchBeforeTransaction !== undefined &&
      classifyTurnNodeRelationship(
        state,
        sourceBranchBeforeTransaction.headTurnNodeHash,
        sourceBranch.headTurnNodeHash
      ) !== "backward"
    ) {
      throw persistenceError(
        "new archive branches must be paired with a backward move on their source branch",
        "sqlite_backend_branch_archive_without_backward_move",
        {
          archivedFromBranchId: branch.archivedFromBranchId,
          branchId: branch.branchId,
          sourceBranchHeadTurnNodeHash: sourceBranch.headTurnNodeHash,
          sourceBranchPreviousHeadTurnNodeHash:
            sourceBranchBeforeTransaction.headTurnNodeHash,
        }
      );
    }
  }

  for (const branch of state.branches.values()) {
    const previousBranch = baseState.branches.get(branch.branchId);

    if (previousBranch === undefined) {
      continue;
    }

    const headMoveDirection = classifyTurnNodeRelationship(
      state,
      previousBranch.headTurnNodeHash,
      branch.headTurnNodeHash
    );

    if (headMoveDirection !== "backward") {
      continue;
    }

    assertBackwardBranchMoveIsArchived(
      state,
      baseState,
      previousBranch,
      branch
    );
  }
}

function validateTurnNodeInvariants(state: BackendState): void {
  for (const turnNode of state.turnNodes.values()) {
    const turnTree = ensureTurnTreeExists(
      state,
      turnNode.turnTreeHash,
      "turnNode.turnTreeHash"
    );

    if (turnTree.schemaId !== turnNode.schemaId) {
      throw persistenceError(
        "stored turn nodes must use the schema of their referenced turn tree",
        "sqlite_backend_turn_node_schema_mismatch",
        {
          turnNodeHash: turnNode.hash,
          turnNodeSchemaId: turnNode.schemaId,
          turnTreeHash: turnTree.hash,
          turnTreeSchemaId: turnTree.schemaId,
        }
      );
    }

    for (const objectHash of decodeTurnNodeConsumedStagedResultObjectHashes(
      turnNode
    )) {
      ensureObjectExists(
        state,
        objectHash,
        "turnNode.consumedStagedResultsCbor"
      );
    }
  }
}

function validateTurnInvariants(state: BackendState): void {
  for (const turn of state.turns.values()) {
    const thread = ensureThreadExists(state, turn.threadId, "turn.threadId");
    const branch = ensureBranchExists(state, turn.branchId, "turn.branchId");

    if (branch.threadId !== thread.threadId) {
      throw persistenceError(
        "stored turns must reference a branch on the same thread",
        "sqlite_backend_turn_branch_thread_mismatch",
        {
          branchId: branch.branchId,
          branchThreadId: branch.threadId,
          threadId: thread.threadId,
          turnId: turn.turnId,
        }
      );
    }

    assertTurnNodeBelongsToThread(
      state,
      turn.startTurnNodeHash,
      thread,
      "turn.startTurnNodeHash"
    );
    assertTurnNodeBelongsToThread(
      state,
      turn.headTurnNodeHash,
      thread,
      "turn.headTurnNodeHash"
    );
    assertTurnNodeDescendsFrom(
      state,
      turn.headTurnNodeHash,
      turn.startTurnNodeHash,
      "turn.headTurnNodeHash"
    );

    assertTurnParentLink(state, turn, "turn.parentTurnId");
  }
}

function validateRunInvariants(state: BackendState): void {
  const activeRunCounts = new Map<string, number>();

  for (const run of state.runs.values()) {
    const branch = ensureBranchExists(state, run.branchId, "run.branchId");
    const turn = ensureTurnExists(state, run.turnId, "run.turnId");
    const startTurnNode = ensureTurnNodeExists(
      state,
      run.startTurnNodeHash,
      "run.startTurnNodeHash"
    );
    const thread = ensureThreadExists(state, turn.threadId, "turn.threadId");

    if (turn.branchId !== branch.branchId) {
      throw persistenceError(
        "stored runs must reference a turn on the same branch",
        "sqlite_backend_run_branch_mismatch",
        {
          branchId: branch.branchId,
          runId: run.runId,
          turnBranchId: turn.branchId,
          turnId: turn.turnId,
        }
      );
    }

    assertTurnNodeBelongsToThread(
      state,
      run.startTurnNodeHash,
      thread,
      "run.startTurnNodeHash"
    );

    if (startTurnNode.schemaId !== run.schemaId) {
      throw persistenceError(
        "stored runs must use the schema of their start turn node",
        "sqlite_backend_run_schema_mismatch",
        {
          runId: run.runId,
          runSchemaId: run.schemaId,
          startTurnNodeHash: startTurnNode.hash,
          turnNodeSchemaId: startTurnNode.schemaId,
        }
      );
    }

    assertRunStartTurnNodeWithinTurnSpan(
      state,
      turn,
      run.startTurnNodeHash,
      "run.startTurnNodeHash"
    );

    for (const turnNodeHash of decodeRunCreatedTurnNodeHashes(run)) {
      const createdTurnNode = ensureTurnNodeExists(
        state,
        turnNodeHash,
        "run.createdTurnNodesCbor"
      );
      assertTurnNodeBelongsToThread(
        state,
        turnNodeHash,
        thread,
        "run.createdTurnNodesCbor"
      );
      assertRunCreatedTurnNodeWithinTurnSpan(
        state,
        turn,
        createdTurnNode,
        "run.createdTurnNodesCbor"
      );
    }

    assertRunCreatedTurnNodesAreCanonical(state, run);

    if (run.status === "running" || run.status === "paused") {
      assertActiveRunHeadAlignment(run, branch, turn);
      const currentActiveCount = activeRunCounts.get(run.branchId) ?? 0;
      activeRunCounts.set(run.branchId, currentActiveCount + 1);
    }

    const stagedResultsForRun = state.stagedResults.get(run.runId);

    if (run.status !== "running" && stagedResultsForRun !== undefined) {
      throw persistenceError(
        "stored terminal or paused runs must not retain staged results",
        "sqlite_backend_run_has_terminal_staged_results",
        {
          runId: run.runId,
          stagedResultCount: stagedResultsForRun.size,
          status: run.status,
        }
      );
    }
  }

  for (const [branchId, activeRunCount] of activeRunCounts.entries()) {
    if (activeRunCount > 1) {
      throw persistenceError(
        "stored branches must not have more than one active run",
        "sqlite_backend_multiple_active_runs",
        {
          activeRunCount,
          branchId,
        }
      );
    }
  }

  for (const [runId, stagedResults] of state.stagedResults.entries()) {
    const run = ensureRunExists(state, runId, "stagedResults.runId");

    if (run.status !== "running") {
      throw persistenceError(
        "stored staged results may only exist for running runs",
        "sqlite_backend_staged_result_run_not_running",
        {
          runId,
          stagedResultCount: stagedResults.size,
          status: run.status,
        }
      );
    }
  }
}

function validateTurnTreePathInvariants(state: BackendState): void {
  for (const [turnTreeHash, storedPaths] of state.turnTreePaths.entries()) {
    ensureTurnTreeExists(state, turnTreeHash, "turnTreePath.turnTreeHash");

    if (storedPaths.size === 0) {
      throw persistenceError(
        "stored turn tree path collections must not be empty",
        "sqlite_backend_empty_turn_tree_path_collection",
        { turnTreeHash }
      );
    }
  }

  validateTurnTreePathCardinalityMetadata(state);

  for (const turnTree of state.turnTrees.values()) {
    assertTurnTreeManifestMatchesStoredPaths(state, turnTree);
  }
}

function validateTurnTreePathCardinalityMetadata(state: BackendState): void {
  for (const storedPaths of state.turnTreePaths.values()) {
    for (const storedPath of storedPaths.values()) {
      if (storedPath.collectionKind === "single") {
        continue;
      }

      if (storedPath.orderedEncoding === "flat") {
        validateOrderedFlatPathCardinality(storedPath);
        continue;
      }

      validateOrderedChunkedPathCardinality(state, storedPath);
    }
  }
}

function validateOrderedFlatPathCardinality(
  storedPath: Extract<
    StoredTurnTreePath,
    { collectionKind: "ordered"; orderedEncoding: "flat" }
  >
): void {
  const hashes = decodeHashStringArray(
    storedPath.orderedInlineCbor,
    "storedPath.orderedInlineCbor"
  );

  if (storedPath.orderedCount !== hashes.length) {
    throw persistenceError(
      "stored ordered turn tree paths must keep orderedCount aligned with encoded hashes",
      "sqlite_backend_turn_tree_path_ordered_count_mismatch",
      {
        decodedCount: hashes.length,
        orderedCount: storedPath.orderedCount,
        path: storedPath.path,
        turnTreeHash: storedPath.turnTreeHash,
      }
    );
  }
}

function validateOrderedChunkedPathCardinality(
  state: BackendState,
  storedPath: Extract<
    StoredTurnTreePath,
    { collectionKind: "ordered"; orderedEncoding: "chunked" }
  >
): void {
  const chunkHashes = decodeHashStringArray(
    storedPath.orderedChunkListCbor,
    "storedPath.orderedChunkListCbor"
  );
  let totalCount = 0;

  for (const [index, chunkHash] of chunkHashes.entries()) {
    const chunk = ensureOrderedPathChunkExists(
      state,
      chunkHash,
      "storedPath.orderedChunkListCbor"
    );
    const chunkItemHashes = decodeHashStringArray(
      chunk.itemsCbor,
      "chunk.itemsCbor"
    );

    if (chunk.itemCount !== chunkItemHashes.length) {
      throw persistenceError(
        "stored ordered path chunk rows must keep itemCount aligned with itemsCbor",
        "sqlite_backend_ordered_path_chunk_item_count_mismatch",
        {
          chunkHash: chunk.chunkHash,
          decodedCount: chunkItemHashes.length,
          itemCount: chunk.itemCount,
        }
      );
    }

    assertChunkedTurnTreePathChunkLayout(chunk, index, chunkHashes.length);
    totalCount += chunk.itemCount;
  }

  if (totalCount !== storedPath.orderedCount) {
    throw persistenceError(
      "stored ordered turn tree paths must keep orderedCount aligned with referenced chunk cardinality",
      "sqlite_backend_turn_tree_path_ordered_count_mismatch",
      {
        orderedCount: storedPath.orderedCount,
        path: storedPath.path,
        totalCount,
        turnTreeHash: storedPath.turnTreeHash,
      }
    );
  }
}

function listTurnsByThread(
  state: BackendState,
  threadId: string,
  excludedTurnId?: string
): StoredTurn[] {
  const turns: StoredTurn[] = [];

  for (const turn of state.turns.values()) {
    if (turn.threadId !== threadId || turn.turnId === excludedTurnId) {
      continue;
    }

    turns.push(turn);
  }

  turns.sort(compareStoredTurn);
  return turns;
}

function decodeTurnTreeSchema(
  bytes: Uint8Array,
  label: string
): TurnTreeSchema {
  const decodedValue = decodeDeterministicKernelRecord(bytes);
  assertTurnTreeSchema(decodedValue, label);
  return decodedValue;
}

function decodeHashStringArray(bytes: Uint8Array, label: string): string[] {
  const decodedValue = decodeDeterministicKernelRecord(bytes);

  if (!Array.isArray(decodedValue)) {
    throw persistenceError(
      `${label} must decode to a HashString[]`,
      "sqlite_backend_invalid_hash_array_payload",
      { label }
    );
  }

  const hashes: string[] = [];

  for (const [index, item] of decodedValue.entries()) {
    assertHashString(item, `${label}[${index}]`);
    hashes.push(item);
  }

  return hashes;
}

function getSchemaForSchemaId(
  state: BackendState,
  schemaId: string,
  label: string
): TurnTreeSchema {
  const schemaRecord = ensureSchemaRecordExists(state, schemaId, label);
  return decodeTurnTreeSchema(schemaRecord.schemaCbor, `${label} schema`);
}

function getSchemaForTurnTree(
  state: BackendState,
  turnTree: StoredTurnTree
): TurnTreeSchema {
  return getSchemaForSchemaId(state, turnTree.schemaId, "turnTree.schemaId");
}

function assertTurnNodeBelongsToThread(
  state: BackendState,
  turnNodeHash: string,
  thread: StoredThread,
  label: string
): void {
  const visitedTurnNodes = new Set<string>();
  let currentTurnNodeHash: string | null = turnNodeHash;

  while (currentTurnNodeHash !== null) {
    if (visitedTurnNodes.has(currentTurnNodeHash)) {
      throw persistenceError(
        `${label} must not traverse a cyclic turn node lineage`,
        "sqlite_backend_cyclic_turn_node_lineage",
        {
          threadId: thread.threadId,
          turnNodeHash,
        }
      );
    }

    visitedTurnNodes.add(currentTurnNodeHash);

    if (currentTurnNodeHash === thread.rootTurnNodeHash) {
      return;
    }

    currentTurnNodeHash = ensureTurnNodeExists(
      state,
      currentTurnNodeHash,
      label
    ).previousTurnNodeHash;
  }

  throw persistenceError(
    `${label} must belong to the referenced thread by lineage walk`,
    "sqlite_backend_thread_lineage_mismatch",
    {
      threadId: thread.threadId,
      threadRootTurnNodeHash: thread.rootTurnNodeHash,
      turnNodeHash,
    }
  );
}

function assertTurnNodeDescendsFrom(
  state: BackendState,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string,
  label: string
): void {
  const visitedTurnNodes = new Set<string>();
  let currentTurnNodeHash: string | null = descendantTurnNodeHash;

  while (currentTurnNodeHash !== null) {
    if (visitedTurnNodes.has(currentTurnNodeHash)) {
      throw persistenceError(
        `${label} must not traverse a cyclic turn node lineage`,
        "sqlite_backend_cyclic_turn_node_lineage",
        {
          ancestorTurnNodeHash,
          descendantTurnNodeHash,
        }
      );
    }

    if (currentTurnNodeHash === ancestorTurnNodeHash) {
      return;
    }

    visitedTurnNodes.add(currentTurnNodeHash);
    currentTurnNodeHash = ensureTurnNodeExists(
      state,
      currentTurnNodeHash,
      label
    ).previousTurnNodeHash;
  }

  throw persistenceError(
    `${label} must be a descendant of the referenced start turn node`,
    "sqlite_backend_turn_node_not_descendant",
    {
      ancestorTurnNodeHash,
      descendantTurnNodeHash,
    }
  );
}

function assertTurnTreeManifestMatchesStoredPaths(
  state: BackendState,
  turnTree: StoredTurnTree
): void {
  const schema = getSchemaForTurnTree(state, turnTree);
  const manifestValue = decodeDeterministicKernelRecord(turnTree.manifestCbor);
  const storedPaths = state.turnTreePaths.get(turnTree.hash);

  if (
    manifestValue === null ||
    typeof manifestValue !== "object" ||
    Array.isArray(manifestValue) ||
    manifestValue instanceof Uint8Array
  ) {
    throw persistenceError(
      "stored turn trees must decode to a manifest object",
      "sqlite_backend_invalid_turn_tree_manifest",
      {
        turnTreeHash: turnTree.hash,
      }
    );
  }

  if (storedPaths === undefined) {
    throw persistenceError(
      "stored turn trees must have indexed path rows",
      "sqlite_backend_missing_turn_tree_paths",
      {
        turnTreeHash: turnTree.hash,
      }
    );
  }

  if (storedPaths.size !== schema.paths.length) {
    throw persistenceError(
      "stored turn tree paths must fully cover the schema-defined manifest",
      "sqlite_backend_turn_tree_path_count_mismatch",
      {
        pathCount: storedPaths.size,
        schemaPathCount: schema.paths.length,
        turnTreeHash: turnTree.hash,
      }
    );
  }

  for (const pathDefinition of schema.paths) {
    const storedPath = storedPaths.get(pathDefinition.path);

    if (storedPath === undefined) {
      throw persistenceError(
        "stored turn tree paths must include every schema path",
        "sqlite_backend_missing_turn_tree_path",
        {
          path: pathDefinition.path,
          turnTreeHash: turnTree.hash,
        }
      );
    }

    const manifestPathValue = Reflect.get(manifestValue, pathDefinition.path);
    const storedPathValue = resolveStoredTurnTreePathValue(state, storedPath);

    if (!areManifestPathValuesEqual(manifestPathValue, storedPathValue)) {
      throw persistenceError(
        "stored turn tree paths must match the logical manifest",
        "sqlite_backend_turn_tree_manifest_path_mismatch",
        {
          path: pathDefinition.path,
          turnTreeHash: turnTree.hash,
        }
      );
    }
  }
}

function resolveStoredTurnTreePathValue(
  state: BackendState,
  storedPath: StoredTurnTreePath
): string[] | string | null {
  if (storedPath.collectionKind === "single") {
    return storedPath.singleHash;
  }

  if (storedPath.orderedEncoding === "flat") {
    return decodeHashStringArray(
      storedPath.orderedInlineCbor,
      "storedPath.orderedInlineCbor"
    );
  }

  const resolvedHashes: string[] = [];
  const chunkHashes = decodeHashStringArray(
    storedPath.orderedChunkListCbor,
    "storedPath.orderedChunkListCbor"
  );

  for (const chunkHash of chunkHashes) {
    const chunk = ensureOrderedPathChunkExists(
      state,
      chunkHash,
      "storedPath.orderedChunkListCbor"
    );

    resolvedHashes.push(
      ...decodeHashStringArray(chunk.itemsCbor, "chunk.itemsCbor")
    );
  }

  return resolvedHashes;
}

function areManifestPathValuesEqual(
  left: unknown,
  right: string[] | string | null
): boolean {
  if (left === null || typeof left === "string") {
    return left === right;
  }

  if (
    !(Array.isArray(left) && Array.isArray(right)) ||
    left.length !== right.length
  ) {
    return false;
  }

  for (const [index, item] of left.entries()) {
    if (item !== right[index]) {
      return false;
    }
  }

  return true;
}

function encodeHashStringArray(hashes: string[]): Uint8Array {
  return encodeDeterministicKernelRecord(
    hashes.map((hash) => validateHashString(hash))
  );
}

function assertRunUpdateIsLegal(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  assertImmutableField(
    existingRun.branchId,
    nextRun.branchId,
    "record.branchId",
    "sqlite_backend_run_branch_immutable"
  );
  assertImmutableField(
    existingRun.turnId,
    nextRun.turnId,
    "record.turnId",
    "sqlite_backend_run_turn_immutable"
  );
  assertImmutableField(
    existingRun.schemaId,
    nextRun.schemaId,
    "record.schemaId",
    "sqlite_backend_run_schema_immutable"
  );
  assertImmutableField(
    existingRun.startTurnNodeHash,
    nextRun.startTurnNodeHash,
    "record.startTurnNodeHash",
    "sqlite_backend_run_start_immutable"
  );
  assertImmutableField(
    existingRun.createdAtMs,
    nextRun.createdAtMs,
    "record.createdAtMs",
    "sqlite_backend_run_created_at_immutable"
  );
  assertImmutableBytes(
    existingRun.stepSequenceCbor,
    nextRun.stepSequenceCbor,
    "record.stepSequenceCbor",
    "sqlite_backend_run_step_sequence_immutable"
  );
  assertMonotonicUpdatedAtMs(
    existingRun.updatedAtMs,
    nextRun.updatedAtMs,
    "record.updatedAtMs",
    "sqlite_backend_run_updated_at_regressed"
  );

  if (
    existingRun.status === "running" ||
    (existingRun.status === "paused" && nextRun.status === "failed")
  ) {
    // Approval resume can surface a terminal failure after a paused run has
    // already durably recorded prior checkpoints. Keep the append-only and
    // monotonic checks active for that final transition instead of treating it
    // like a fully immutable halted record.
    assertMonotonicRunStepIndex(existingRun, nextRun);
    assertAppendOnlyRunCreatedTurnNodes(existingRun, nextRun);
  } else {
    assertImmutableField(
      existingRun.currentStepIndex,
      nextRun.currentStepIndex,
      "record.currentStepIndex",
      "sqlite_backend_run_step_index_immutable_after_halt"
    );
    assertImmutableBytes(
      existingRun.createdTurnNodesCbor,
      nextRun.createdTurnNodesCbor,
      "record.createdTurnNodesCbor",
      "sqlite_backend_run_created_turn_nodes_immutable_after_halt"
    );
  }

  assertRunStatusTransition(existingRun.status, nextRun.status);
}

function assertMonotonicRunStepIndex(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  if (nextRun.currentStepIndex < existingRun.currentStepIndex) {
    throw persistenceError(
      "stored runs must not move currentStepIndex backwards",
      "sqlite_backend_run_step_index_regressed",
      {
        nextCurrentStepIndex: nextRun.currentStepIndex,
        previousCurrentStepIndex: existingRun.currentStepIndex,
        runId: existingRun.runId,
      }
    );
  }
}

function assertMonotonicUpdatedAtMs(
  previousUpdatedAtMs: number,
  nextUpdatedAtMs: number,
  label: string,
  code: string
): void {
  if (nextUpdatedAtMs < previousUpdatedAtMs) {
    throw persistenceError(`${label} must not move backwards`, code, {
      nextUpdatedAtMs,
      previousUpdatedAtMs,
    });
  }
}

function assertAppendOnlyRunCreatedTurnNodes(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  const existingTurnNodeHashes = decodeRunCreatedTurnNodeHashes(existingRun);
  const nextTurnNodeHashes = decodeRunCreatedTurnNodeHashes(nextRun);

  if (nextTurnNodeHashes.length < existingTurnNodeHashes.length) {
    throw persistenceError(
      "stored runs must keep createdTurnNodesCbor append-only",
      "sqlite_backend_run_created_turn_nodes_not_append_only",
      {
        nextCount: nextTurnNodeHashes.length,
        previousCount: existingTurnNodeHashes.length,
        runId: existingRun.runId,
      }
    );
  }

  for (const [index, turnNodeHash] of existingTurnNodeHashes.entries()) {
    if (nextTurnNodeHashes[index] !== turnNodeHash) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor append-only",
        "sqlite_backend_run_created_turn_nodes_not_append_only",
        {
          index,
          nextTurnNodeHash: nextTurnNodeHashes[index],
          previousTurnNodeHash: turnNodeHash,
          runId: existingRun.runId,
        }
      );
    }
  }
}

function assertRunStartTurnNodeWithinTurnSpan(
  state: BackendState,
  turn: StoredTurn,
  startTurnNodeHash: string,
  label: string
): void {
  const relationshipToTurnStart = classifyTurnNodeRelationship(
    state,
    turn.startTurnNodeHash,
    startTurnNodeHash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} must lie within the referenced turn span`,
      "sqlite_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = classifyTurnNodeRelationship(
    state,
    startTurnNodeHash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} must not move past the referenced turn head`,
      "sqlite_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

function assertRunCreatedTurnNodeWithinTurnSpan(
  state: BackendState,
  turn: StoredTurn,
  createdTurnNode: StoredTurnNode,
  label: string
): void {
  const relationshipToTurnStart = classifyTurnNodeRelationship(
    state,
    turn.startTurnNodeHash,
    createdTurnNode.hash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must remain within the referenced turn span`,
      "sqlite_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = classifyTurnNodeRelationship(
    state,
    createdTurnNode.hash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must not move beyond the referenced turn head`,
      "sqlite_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

function assertRunCreatedTurnNodesAreCanonical(
  state: BackendState,
  run: StoredRun
): void {
  const createdTurnNodeHashes = decodeRunCreatedTurnNodeHashes(run);
  const seenTurnNodeHashes = new Set<string>();
  let previousTurnNodeHash = run.startTurnNodeHash;

  for (const [index, turnNodeHash] of createdTurnNodeHashes.entries()) {
    if (seenTurnNodeHashes.has(turnNodeHash)) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor unique",
        "sqlite_backend_run_created_turn_nodes_duplicate",
        {
          duplicateTurnNodeHash: turnNodeHash,
          index,
          runId: run.runId,
        }
      );
    }

    const createdTurnNode = ensureTurnNodeExists(
      state,
      turnNodeHash,
      "run.createdTurnNodesCbor"
    );
    const isImmediateNextTurnNode =
      createdTurnNode.previousTurnNodeHash === previousTurnNodeHash;

    if (!isImmediateNextTurnNode) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor as a canonical contiguous lineage",
        "sqlite_backend_run_created_turn_nodes_not_contiguous",
        {
          createdTurnNodePreviousTurnNodeHash:
            createdTurnNode.previousTurnNodeHash,
          index,
          previousTurnNodeHash,
          runId: run.runId,
          turnNodeHash,
        }
      );
    }

    seenTurnNodeHashes.add(turnNodeHash);
    previousTurnNodeHash = turnNodeHash;
  }
}

function assertActiveRunHeadAlignment(
  run: StoredRun,
  branch: StoredBranch,
  turn: StoredTurn
): void {
  const activeTurnNodeHash = getRunActiveTurnNodeHash(run);

  if (activeTurnNodeHash !== branch.headTurnNodeHash) {
    throw persistenceError(
      "stored active runs must stay aligned with the current branch head",
      "sqlite_backend_active_run_branch_head_mismatch",
      {
        activeTurnNodeHash,
        branchHeadTurnNodeHash: branch.headTurnNodeHash,
        branchId: branch.branchId,
        runId: run.runId,
        status: run.status,
      }
    );
  }

  if (activeTurnNodeHash !== turn.headTurnNodeHash) {
    throw persistenceError(
      "stored active runs must stay aligned with the current turn head",
      "sqlite_backend_active_run_turn_head_mismatch",
      {
        activeTurnNodeHash,
        runId: run.runId,
        status: run.status,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

function assertTurnParentLink(
  state: BackendState,
  turn: StoredTurn,
  label: string
): void {
  const candidateTurnsAtStart = listTurnsByThread(
    state,
    turn.threadId,
    turn.turnId
  ).filter(
    (candidateTurn) => candidateTurn.headTurnNodeHash === turn.startTurnNodeHash
  );
  const sameBranchCandidateTurns = candidateTurnsAtStart.filter(
    (candidateTurn) => candidateTurn.branchId === turn.branchId
  );
  const immediatelyPreviousSameBranchTurn = sameBranchCandidateTurns.at(-1);

  if (turn.parentTurnId === null) {
    if (candidateTurnsAtStart.length === 0) {
      return;
    }

    throw persistenceError(
      `${label} must reference the previous semantic turn when one exists`,
      "sqlite_backend_turn_parent_required",
      {
        candidateParentTurnIds: candidateTurnsAtStart.map(
          (candidateTurn) => candidateTurn.turnId
        ),
        startTurnNodeHash: turn.startTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }

  const parentTurn = ensureTurnExists(state, turn.parentTurnId, label);

  if (parentTurn.threadId !== turn.threadId) {
    throw persistenceError(
      "stored turns must reference a parent turn on the same thread",
      "sqlite_backend_turn_parent_thread_mismatch",
      {
        parentThreadId: parentTurn.threadId,
        threadId: turn.threadId,
        turnId: turn.turnId,
      }
    );
  }

  if (parentTurn.headTurnNodeHash !== turn.startTurnNodeHash) {
    throw persistenceError(
      `${label} must chain contiguously into record.startTurnNodeHash`,
      "sqlite_backend_turn_parent_start_turn_node_mismatch",
      {
        parentTurnHeadTurnNodeHash: parentTurn.headTurnNodeHash,
        parentTurnId: parentTurn.turnId,
        startTurnNodeHash: turn.startTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }

  if (parentTurn.branchId !== turn.branchId) {
    return;
  }

  if (
    immediatelyPreviousSameBranchTurn === undefined ||
    immediatelyPreviousSameBranchTurn.turnId !== parentTurn.turnId
  ) {
    throw persistenceError(
      `${label} must reference the immediately previous semantic turn at record.startTurnNodeHash`,
      "sqlite_backend_turn_parent_not_immediate_predecessor",
      {
        candidateParentTurnIds: sameBranchCandidateTurns.map(
          (candidateTurn) => candidateTurn.turnId
        ),
        expectedParentTurnId: immediatelyPreviousSameBranchTurn?.turnId ?? null,
        parentTurnId: parentTurn.turnId,
        turnId: turn.turnId,
      }
    );
  }
}

function assertBackwardBranchMoveIsArchived(
  state: BackendState,
  baseState: BackendState,
  previousBranch: StoredBranch,
  nextBranch: StoredBranch
): void {
  let archiveBranchFound = false;

  for (const branch of state.branches.values()) {
    if (branch.branchId === nextBranch.branchId) {
      continue;
    }

    const branchBeforeTransaction = baseState.branches.get(branch.branchId);

    if (
      branchBeforeTransaction === undefined &&
      branch.archivedFromBranchId === nextBranch.branchId &&
      branch.headTurnNodeHash === previousBranch.headTurnNodeHash
    ) {
      archiveBranchFound = true;
      break;
    }
  }

  if (!archiveBranchFound) {
    throw persistenceError(
      "stored backward branch moves must preserve the abandoned head as an archive branch",
      "sqlite_backend_backward_branch_move_missing_archive",
      {
        branchId: nextBranch.branchId,
        nextHeadTurnNodeHash: nextBranch.headTurnNodeHash,
        previousHeadTurnNodeHash: previousBranch.headTurnNodeHash,
      }
    );
  }

  for (const run of state.runs.values()) {
    if (
      run.branchId !== nextBranch.branchId ||
      (run.status !== "running" && run.status !== "paused")
    ) {
      continue;
    }

    const activeTurnNodeHash = getRunActiveTurnNodeHash(run);

    if (activeTurnNodeHash === nextBranch.headTurnNodeHash) {
      continue;
    }

    throw persistenceError(
      "stored backward branch moves must fail active runs from the abandoned segment",
      "sqlite_backend_backward_branch_move_active_run_not_failed",
      {
        activeTurnNodeHash,
        branchHeadTurnNodeHash: nextBranch.headTurnNodeHash,
        branchId: nextBranch.branchId,
        runId: run.runId,
        startTurnNodeHash: run.startTurnNodeHash,
        status: run.status,
      }
    );
  }
}

function assertBackwardBranchMoveIsArchivedInDatabase(
  db: Database.Database,
  writeTracker: TransactionWriteTracker,
  previousBranch: StoredBranch,
  nextBranch: StoredBranch
): void {
  let archiveBranchFound = false;

  for (const [branchId, trackedBranch] of writeTracker.branchWrites) {
    if (branchId === nextBranch.branchId || trackedBranch.before !== null) {
      continue;
    }

    const archiveBranch = trackedBranch.after;

    if (
      archiveBranch !== null &&
      archiveBranch.archivedFromBranchId === nextBranch.branchId &&
      archiveBranch.headTurnNodeHash === previousBranch.headTurnNodeHash
    ) {
      archiveBranchFound = true;
      break;
    }
  }

  if (!archiveBranchFound) {
    throw persistenceError(
      "stored backward branch moves must preserve the abandoned head as an archive branch",
      "sqlite_backend_backward_branch_move_missing_archive",
      {
        branchId: nextBranch.branchId,
        nextHeadTurnNodeHash: nextBranch.headTurnNodeHash,
        previousHeadTurnNodeHash: previousBranch.headTurnNodeHash,
      }
    );
  }

  for (const run of selectActiveRunsByBranch(db, nextBranch.branchId)) {
    const activeTurnNodeHash = getRunActiveTurnNodeHash(run);

    if (activeTurnNodeHash === nextBranch.headTurnNodeHash) {
      continue;
    }

    throw persistenceError(
      "stored backward branch moves must fail active runs from the abandoned segment",
      "sqlite_backend_backward_branch_move_active_run_not_failed",
      {
        activeTurnNodeHash,
        branchHeadTurnNodeHash: nextBranch.headTurnNodeHash,
        branchId: nextBranch.branchId,
        runId: run.runId,
        startTurnNodeHash: run.startTurnNodeHash,
        status: run.status,
      }
    );
  }
}

function assertTurnNodeBelongsToThreadInDatabase(
  db: Database.Database,
  turnNodeHash: string,
  thread: StoredThread,
  label: string
): void {
  const metadata = ensureValidatedTurnNodeLineageMetadataInDatabase(
    db,
    turnNodeHash,
    label
  );

  if (metadata.rootTurnNodeHash === thread.rootTurnNodeHash) {
    return;
  }

  throw persistenceError(
    `${label} must belong to the referenced thread by lineage walk`,
    "sqlite_backend_thread_lineage_mismatch",
    {
      threadId: thread.threadId,
      threadRootTurnNodeHash: thread.rootTurnNodeHash,
      turnNodeHash,
    }
  );
}

function assertTurnNodeDescendsFromInDatabase(
  db: Database.Database,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string,
  label: string
): void {
  if (
    isTurnNodeDescendantOfInDatabase(
      db,
      descendantTurnNodeHash,
      ancestorTurnNodeHash
    )
  ) {
    return;
  }

  throw persistenceError(
    `${label} must be a descendant of the referenced start turn node`,
    "sqlite_backend_turn_node_not_descendant",
    {
      ancestorTurnNodeHash,
      descendantTurnNodeHash,
    }
  );
}

function assertTurnParentLinkInDatabase(
  db: Database.Database,
  turn: StoredTurn,
  label: string
): void {
  const candidateTurns = selectCandidateParentTurns(db, turn);
  const sameBranchCandidateTurns = candidateTurns.filter(
    (candidateTurn) => candidateTurn.branchId === turn.branchId
  );
  const immediatelyPreviousSameBranchTurn = sameBranchCandidateTurns.at(-1);

  if (turn.parentTurnId === null) {
    if (candidateTurns.length === 0) {
      return;
    }

    throw persistenceError(
      `${label} must reference the previous semantic turn when one exists`,
      "sqlite_backend_turn_parent_required",
      {
        candidateParentTurnIds: candidateTurns.map(
          (candidateTurn) => candidateTurn.turnId
        ),
        startTurnNodeHash: turn.startTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }

  const parentTurn = ensureTurnExistsInDatabase(db, turn.parentTurnId, label);

  if (parentTurn.threadId !== turn.threadId) {
    throw persistenceError(
      "stored turns must reference a parent turn on the same thread",
      "sqlite_backend_turn_parent_thread_mismatch",
      {
        parentThreadId: parentTurn.threadId,
        threadId: turn.threadId,
        turnId: turn.turnId,
      }
    );
  }

  if (parentTurn.headTurnNodeHash !== turn.startTurnNodeHash) {
    throw persistenceError(
      `${label} must chain contiguously into record.startTurnNodeHash`,
      "sqlite_backend_turn_parent_start_turn_node_mismatch",
      {
        parentTurnHeadTurnNodeHash: parentTurn.headTurnNodeHash,
        parentTurnId: parentTurn.turnId,
        startTurnNodeHash: turn.startTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }

  if (parentTurn.branchId !== turn.branchId) {
    return;
  }

  if (
    immediatelyPreviousSameBranchTurn === undefined ||
    immediatelyPreviousSameBranchTurn.turnId !== parentTurn.turnId
  ) {
    throw persistenceError(
      `${label} must reference the immediately previous semantic turn at record.startTurnNodeHash`,
      "sqlite_backend_turn_parent_not_immediate_predecessor",
      {
        candidateParentTurnIds: sameBranchCandidateTurns.map(
          (candidateTurn) => candidateTurn.turnId
        ),
        expectedParentTurnId: immediatelyPreviousSameBranchTurn?.turnId ?? null,
        parentTurnId: parentTurn.turnId,
        turnId: turn.turnId,
      }
    );
  }
}

function selectCandidateParentTurns(
  db: Database.Database,
  turn: StoredTurn
): StoredTurn[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM turns
        WHERE thread_id = ?
          AND head_turn_node_hash = ?
          AND turn_id <> ?
        ORDER BY created_at_ms, turn_id
      `
    )
    .all(turn.threadId, turn.startTurnNodeHash, turn.turnId);
  return rows.map(decodeUnknownTurnRow);
}

function assertRunStartTurnNodeWithinTurnSpanInDatabase(
  db: Database.Database,
  turn: StoredTurn,
  startTurnNodeHash: string,
  label: string
): void {
  const relationshipToTurnStart = classifyTurnNodeRelationshipInDatabase(
    db,
    turn.startTurnNodeHash,
    startTurnNodeHash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} must lie within the referenced turn span`,
      "sqlite_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = classifyTurnNodeRelationshipInDatabase(
    db,
    startTurnNodeHash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} must not move past the referenced turn head`,
      "sqlite_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

function assertRunCreatedTurnNodeWithinTurnSpanInDatabase(
  db: Database.Database,
  turn: StoredTurn,
  createdTurnNode: StoredTurnNode,
  label: string
): void {
  const relationshipToTurnStart = classifyTurnNodeRelationshipInDatabase(
    db,
    turn.startTurnNodeHash,
    createdTurnNode.hash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must remain within the referenced turn span`,
      "sqlite_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = classifyTurnNodeRelationshipInDatabase(
    db,
    createdTurnNode.hash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must not move beyond the referenced turn head`,
      "sqlite_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

function assertRunCreatedTurnNodesAreCanonicalInDatabase(
  db: Database.Database,
  run: StoredRun
): void {
  const createdTurnNodeHashes = decodeRunCreatedTurnNodeHashes(run);
  const seenTurnNodeHashes = new Set<string>();
  let previousTurnNodeHash = run.startTurnNodeHash;

  for (const [index, turnNodeHash] of createdTurnNodeHashes.entries()) {
    if (seenTurnNodeHashes.has(turnNodeHash)) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor unique",
        "sqlite_backend_run_created_turn_nodes_duplicate",
        {
          duplicateTurnNodeHash: turnNodeHash,
          index,
          runId: run.runId,
        }
      );
    }

    const createdTurnNode = ensureTurnNodeExistsInDatabase(
      db,
      turnNodeHash,
      "run.createdTurnNodesCbor"
    );
    const isImmediateNextTurnNode =
      createdTurnNode.previousTurnNodeHash === previousTurnNodeHash;

    if (!isImmediateNextTurnNode) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor as a canonical contiguous lineage",
        "sqlite_backend_run_created_turn_nodes_not_contiguous",
        {
          createdTurnNodePreviousTurnNodeHash:
            createdTurnNode.previousTurnNodeHash,
          index,
          previousTurnNodeHash,
          runId: run.runId,
          turnNodeHash,
        }
      );
    }

    seenTurnNodeHashes.add(turnNodeHash);
    previousTurnNodeHash = turnNodeHash;
  }
}

function assertActiveRunHeadAlignmentInDatabase(
  run: StoredRun,
  branch: StoredBranch,
  turn: StoredTurn
): void {
  const activeTurnNodeHash = getRunActiveTurnNodeHash(run);

  if (activeTurnNodeHash !== branch.headTurnNodeHash) {
    throw persistenceError(
      "stored active runs must stay aligned with the current branch head",
      "sqlite_backend_active_run_branch_head_mismatch",
      {
        activeTurnNodeHash,
        branchHeadTurnNodeHash: branch.headTurnNodeHash,
        branchId: branch.branchId,
        runId: run.runId,
        status: run.status,
      }
    );
  }

  if (activeTurnNodeHash !== turn.headTurnNodeHash) {
    throw persistenceError(
      "stored active runs must stay aligned with the current turn head",
      "sqlite_backend_active_run_turn_head_mismatch",
      {
        activeTurnNodeHash,
        runId: run.runId,
        status: run.status,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

function assertBranchHeadMoveIsLinearInDatabase(
  db: Database.Database,
  previousHeadTurnNodeHash: string,
  nextHeadTurnNodeHash: string,
  label: string
): void {
  const relationship = classifyTurnNodeRelationshipInDatabase(
    db,
    previousHeadTurnNodeHash,
    nextHeadTurnNodeHash
  );

  if (relationship === "lateral") {
    throw persistenceError(
      `${label} must remain on the same thread lineage as the current branch head`,
      "sqlite_backend_branch_head_lateral_move",
      {
        nextHeadTurnNodeHash,
        previousHeadTurnNodeHash,
      }
    );
  }
}

type TurnNodeRelationship = "backward" | "forward" | "lateral" | "same";

function classifyTurnNodeRelationshipInDatabase(
  db: Database.Database,
  sourceTurnNodeHash: string,
  targetTurnNodeHash: string
): TurnNodeRelationship {
  if (sourceTurnNodeHash === targetTurnNodeHash) {
    return "same";
  }

  const sourceMetadata = ensureValidatedTurnNodeLineageMetadataInDatabase(
    db,
    sourceTurnNodeHash,
    "sourceTurnNodeHash"
  );
  const targetMetadata = ensureValidatedTurnNodeLineageMetadataInDatabase(
    db,
    targetTurnNodeHash,
    "targetTurnNodeHash"
  );

  if (sourceMetadata.rootTurnNodeHash !== targetMetadata.rootTurnNodeHash) {
    return "lateral";
  }

  if (targetMetadata.depth > sourceMetadata.depth) {
    if (
      sourceMetadata.depth === 0 &&
      targetMetadata.rootTurnNodeHash === sourceTurnNodeHash
    ) {
      return "forward";
    }

    return isTurnNodeDescendantOfInDatabase(
      db,
      targetTurnNodeHash,
      sourceTurnNodeHash
    )
      ? "forward"
      : "lateral";
  }

  if (targetMetadata.depth < sourceMetadata.depth) {
    if (
      targetMetadata.depth === 0 &&
      sourceMetadata.rootTurnNodeHash === targetTurnNodeHash
    ) {
      return "backward";
    }

    return isTurnNodeDescendantOfInDatabase(
      db,
      sourceTurnNodeHash,
      targetTurnNodeHash
    )
      ? "backward"
      : "lateral";
  }

  return "lateral";
}

function isTurnNodeDescendantOfInDatabase(
  db: Database.Database,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string
): boolean {
  if (descendantTurnNodeHash === ancestorTurnNodeHash) {
    return true;
  }

  const descendantMetadata = ensureValidatedTurnNodeLineageMetadataInDatabase(
    db,
    descendantTurnNodeHash,
    "descendantTurnNodeHash"
  );
  const ancestorMetadata = ensureValidatedTurnNodeLineageMetadataInDatabase(
    db,
    ancestorTurnNodeHash,
    "ancestorTurnNodeHash"
  );

  if (
    descendantMetadata.rootTurnNodeHash !== ancestorMetadata.rootTurnNodeHash ||
    descendantMetadata.depth < ancestorMetadata.depth
  ) {
    return false;
  }

  if (
    ancestorMetadata.depth === 0 &&
    descendantMetadata.rootTurnNodeHash === ancestorTurnNodeHash
  ) {
    return true;
  }

  const row = db
    .prepare(
      `
        WITH RECURSIVE lineage(hash, previous_turn_node_hash, remaining_depth) AS (
          SELECT hash, previous_turn_node_hash, ? AS remaining_depth
          FROM turn_nodes
          WHERE hash = ?
          UNION ALL
          SELECT
            turn_nodes.hash,
            turn_nodes.previous_turn_node_hash,
            lineage.remaining_depth - 1
          FROM turn_nodes
          JOIN lineage ON turn_nodes.hash = lineage.previous_turn_node_hash
          WHERE lineage.remaining_depth > 0
        )
        SELECT 1 AS found
        FROM lineage
        WHERE hash = ?
        LIMIT 1
      `
    )
    .get(
      descendantMetadata.depth - ancestorMetadata.depth,
      descendantTurnNodeHash,
      ancestorTurnNodeHash
    ) as { found: number } | undefined;

  return row !== undefined;
}

function classifyTurnNodeRelationship(
  state: BackendState,
  sourceTurnNodeHash: string,
  targetTurnNodeHash: string
): TurnNodeRelationship {
  if (sourceTurnNodeHash === targetTurnNodeHash) {
    return "same";
  }

  if (isTurnNodeDescendantOf(state, targetTurnNodeHash, sourceTurnNodeHash)) {
    return "forward";
  }

  if (isTurnNodeDescendantOf(state, sourceTurnNodeHash, targetTurnNodeHash)) {
    return "backward";
  }

  return "lateral";
}

function isTurnNodeDescendantOf(
  state: BackendState,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string
): boolean {
  const visitedTurnNodes = new Set<string>();
  let currentTurnNodeHash: string | null = descendantTurnNodeHash;

  while (currentTurnNodeHash !== null) {
    if (visitedTurnNodes.has(currentTurnNodeHash)) {
      throw persistenceError(
        "turn node lineage must not contain cycles",
        "sqlite_backend_cyclic_turn_node_lineage",
        {
          ancestorTurnNodeHash,
          descendantTurnNodeHash,
        }
      );
    }

    if (currentTurnNodeHash === ancestorTurnNodeHash) {
      return true;
    }

    visitedTurnNodes.add(currentTurnNodeHash);
    currentTurnNodeHash = ensureTurnNodeExists(
      state,
      currentTurnNodeHash,
      "turnNodeHash"
    ).previousTurnNodeHash;
  }

  return false;
}

function decodeRunCreatedTurnNodeHashes(run: StoredRun): string[] {
  return decodeHashStringArray(
    run.createdTurnNodesCbor,
    "run.createdTurnNodesCbor"
  );
}

function getRunActiveTurnNodeHash(run: StoredRun): string {
  const createdTurnNodeHashes = decodeRunCreatedTurnNodeHashes(run);
  return createdTurnNodeHashes.at(-1) ?? run.startTurnNodeHash;
}

function assertChunkedTurnTreePathChunkLayout(
  chunk: StoredOrderedPathChunk,
  index: number,
  totalChunks: number
): void {
  if (chunk.itemCount < 1 || chunk.itemCount > ORDERED_PATH_CHUNK_SIZE) {
    throw persistenceError(
      "ordered path chunks must contain between one and the fixed chunk size number of items",
      "sqlite_backend_ordered_path_chunk_size_invalid",
      {
        chunkHash: chunk.chunkHash,
        chunkItemCount: chunk.itemCount,
        chunkSize: ORDERED_PATH_CHUNK_SIZE,
      }
    );
  }

  if (index < totalChunks - 1 && chunk.itemCount !== ORDERED_PATH_CHUNK_SIZE) {
    throw persistenceError(
      "non-final ordered path chunks must use the fixed chunk size",
      "sqlite_backend_ordered_path_chunk_not_fixed_size",
      {
        chunkHash: chunk.chunkHash,
        chunkIndex: index,
        chunkItemCount: chunk.itemCount,
        chunkSize: ORDERED_PATH_CHUNK_SIZE,
        totalChunks,
      }
    );
  }
}

function decodeTurnNodeConsumedStagedResultObjectHashes(
  turnNode: StoredTurnNode
): string[] {
  const decodedValue = decodeDeterministicKernelRecord(
    turnNode.consumedStagedResultsCbor
  );

  if (!Array.isArray(decodedValue)) {
    throw persistenceError(
      "stored turn node consumedStagedResultsCbor must decode to an array",
      "sqlite_backend_invalid_consumed_staged_results_cbor",
      {
        turnNodeHash: turnNode.hash,
      }
    );
  }

  const objectHashes: string[] = [];

  for (const [index, value] of decodedValue.entries()) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value instanceof Uint8Array
    ) {
      throw persistenceError(
        "stored turn node consumedStagedResultsCbor entries must decode to staged result objects",
        "sqlite_backend_invalid_consumed_staged_result_entry",
        {
          index,
          turnNodeHash: turnNode.hash,
        }
      );
    }

    const objectHash = Reflect.get(value, "objectHash");

    if (typeof objectHash !== "string") {
      throw persistenceError(
        "stored turn node consumedStagedResultsCbor entries must include objectHash",
        "sqlite_backend_invalid_consumed_staged_result_entry",
        {
          index,
          turnNodeHash: turnNode.hash,
        }
      );
    }

    objectHashes.push(validateHashString(objectHash));
  }

  return objectHashes;
}

function assertRunStatusTransition(
  previousStatus: StoredRun["status"],
  nextStatus: StoredRun["status"]
): void {
  if (previousStatus === nextStatus) {
    return;
  }

  const isLegalTransition =
    (previousStatus === "running" &&
      (nextStatus === "completed" ||
        nextStatus === "failed" ||
        nextStatus === "paused")) ||
    // A paused run can still fail during resume reconciliation or approval
    // handling; Epic V relies on both local and remote kernels accepting that
    // terminal transition consistently.
    (previousStatus === "paused" && nextStatus === "failed");

  if (!isLegalTransition) {
    throw persistenceError(
      "stored runs must not use illegal status transitions",
      "sqlite_backend_run_status_transition_illegal",
      {
        nextStatus,
        previousStatus,
      }
    );
  }
}

function assertImmutableField<T>(
  previousValue: T,
  nextValue: T,
  label: string,
  code: string
): void {
  if (previousValue !== nextValue) {
    throw persistenceError(`${label} must remain immutable`, code, {
      nextValue,
      previousValue,
    });
  }
}

function assertImmutableOptionalField<T>(
  previousValue: T | undefined,
  nextValue: T | undefined,
  label: string,
  code: string
): void {
  if (previousValue !== nextValue) {
    throw persistenceError(`${label} must remain immutable`, code, {
      nextValue,
      previousValue,
    });
  }
}

function assertImmutableBytes(
  previousValue: Uint8Array,
  nextValue: Uint8Array,
  label: string,
  code: string
): void {
  if (!areBytesEqual(previousValue, nextValue)) {
    throw persistenceError(`${label} must remain immutable`, code, {
      label,
    });
  }
}

function validateHashString(hash: string): string {
  assertHashString(hash, "hash");
  return hash;
}

function ensureImmutableRecordMatch<T>(
  existing: T,
  incoming: T,
  areEqual: (left: T, right: T) => boolean,
  label: string
): void {
  if (!areEqual(existing, incoming)) {
    throw persistenceError(
      `${label} writes must be idempotent for the same identity key`,
      "sqlite_backend_immutable_record_conflict",
      { label }
    );
  }
}

function ensureObjectExists(
  state: BackendState,
  hash: string,
  label: string
): StoredObject {
  const record = state.objects.get(hash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing object`,
      "sqlite_backend_missing_object_reference",
      {
        hash,
        label,
      }
    );
  }

  return record;
}

function ensureSchemaRecordExists(
  state: BackendState,
  schemaId: string,
  label: string
): StoredSchema {
  const record = state.schemas.get(schemaId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing schema`,
      "sqlite_backend_missing_schema_reference",
      {
        label,
        schemaId,
      }
    );
  }

  return record;
}

function ensureTurnTreeExists(
  state: BackendState,
  hash: string,
  label: string
): StoredTurnTree {
  const record = state.turnTrees.get(hash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing turn tree`,
      "sqlite_backend_missing_turn_tree_reference",
      { hash, label }
    );
  }

  return record;
}

function ensureOrderedPathChunkExists(
  state: BackendState,
  chunkHash: string,
  label: string
): StoredOrderedPathChunk {
  const record = state.orderedPathChunks.get(chunkHash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing ordered path chunk`,
      "sqlite_backend_missing_ordered_path_chunk_reference",
      { chunkHash, label }
    );
  }

  return record;
}

function ensureTurnNodeExists(
  state: BackendState,
  hash: string,
  label: string
): StoredTurnNode {
  const record = state.turnNodes.get(hash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing turn node`,
      "sqlite_backend_missing_turn_node_reference",
      { hash, label }
    );
  }

  return record;
}

function ensureThreadExists(
  state: BackendState,
  threadId: string,
  label: string
): StoredThread {
  const record = state.threads.get(threadId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing thread`,
      "sqlite_backend_missing_thread_reference",
      { label, threadId }
    );
  }

  return record;
}

function ensureBranchExists(
  state: BackendState,
  branchId: string,
  label: string
): StoredBranch {
  const record = state.branches.get(branchId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing branch`,
      "sqlite_backend_missing_branch_reference",
      { branchId, label }
    );
  }

  return record;
}

function ensureTurnExists(
  state: BackendState,
  turnId: string,
  label: string
): StoredTurn {
  const record = state.turns.get(turnId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing turn`,
      "sqlite_backend_missing_turn_reference",
      { label, turnId }
    );
  }

  return record;
}

function ensureRunExists(
  state: BackendState,
  runId: string,
  label: string
): StoredRun {
  const record = state.runs.get(runId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing run`,
      "sqlite_backend_missing_run_reference",
      { label, runId }
    );
  }

  return record;
}

function cloneStoredObject(record: StoredObject): StoredObject {
  return {
    ...record,
    bytes: cloneBytes(record.bytes),
  };
}

function cloneStoredSchema(record: StoredSchema): StoredSchema {
  return {
    ...record,
    schemaCbor: cloneEncodedBytes(record.schemaCbor),
  };
}

function cloneStoredTurnTree(record: StoredTurnTree): StoredTurnTree {
  return {
    ...record,
    manifestCbor: cloneEncodedBytes(record.manifestCbor),
  };
}

function cloneStoredOrderedPathChunk(
  record: StoredOrderedPathChunk
): StoredOrderedPathChunk {
  return {
    ...record,
    itemsCbor: cloneEncodedBytes(record.itemsCbor),
  };
}

function cloneStoredTurnNode(record: StoredTurnNode): StoredTurnNode {
  return {
    ...record,
    consumedStagedResultsCbor: cloneEncodedBytes(
      record.consumedStagedResultsCbor
    ),
  };
}

function cloneStoredRun(record: StoredRun): StoredRun {
  return {
    ...record,
    createdTurnNodesCbor: cloneEncodedBytes(record.createdTurnNodesCbor),
    stepSequenceCbor: cloneEncodedBytes(record.stepSequenceCbor),
  };
}

function cloneStoredStagedResult(
  record: StoredStagedResult
): StoredStagedResult {
  if (record.status === "interrupted") {
    return {
      ...record,
      interruptPayloadCbor: cloneEncodedBytes(record.interruptPayloadCbor),
    };
  }

  return { ...record };
}

function cloneStoredThread(record: StoredThread): StoredThread {
  return { ...record };
}

function cloneStoredBranch(record: StoredBranch): StoredBranch {
  return { ...record };
}

function cloneStoredTurn(record: StoredTurn): StoredTurn {
  return { ...record };
}

function cloneStoredTurnTreePath(
  record: StoredTurnTreePath
): StoredTurnTreePath {
  if (record.collectionKind === "single") {
    return { ...record };
  }

  if (record.orderedEncoding === "flat") {
    return {
      ...record,
      orderedInlineCbor: cloneEncodedBytes(record.orderedInlineCbor),
    };
  }

  return {
    ...record,
    orderedChunkListCbor: cloneEncodedBytes(record.orderedChunkListCbor),
  };
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function cloneEncodedBytes(bytes: Uint8Array): Uint8Array {
  const cloned = Uint8Array.from(bytes);
  Reflect.set(
    cloned,
    "dataView",
    new DataView(cloned.buffer, cloned.byteOffset, cloned.byteLength)
  );
  return cloned;
}

function areStoredObjectsEqual(
  left: StoredObject,
  right: StoredObject
): boolean {
  return (
    left.hash === right.hash &&
    left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.bytes, right.bytes)
  );
}

function areStoredSchemasEqual(
  left: StoredSchema,
  right: StoredSchema
): boolean {
  return (
    left.schemaId === right.schemaId &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.schemaCbor, right.schemaCbor)
  );
}

function areStoredTurnTreesEqual(
  left: StoredTurnTree,
  right: StoredTurnTree
): boolean {
  return (
    left.hash === right.hash &&
    left.schemaId === right.schemaId &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.manifestCbor, right.manifestCbor)
  );
}

function areStoredOrderedPathChunksEqual(
  left: StoredOrderedPathChunk,
  right: StoredOrderedPathChunk
): boolean {
  return (
    left.chunkHash === right.chunkHash &&
    left.itemCount === right.itemCount &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.itemsCbor, right.itemsCbor)
  );
}

function areStoredTurnNodesEqual(
  left: StoredTurnNode,
  right: StoredTurnNode
): boolean {
  return (
    left.hash === right.hash &&
    left.previousTurnNodeHash === right.previousTurnNodeHash &&
    left.turnTreeHash === right.turnTreeHash &&
    left.schemaId === right.schemaId &&
    left.eventHash === right.eventHash &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(
      left.consumedStagedResultsCbor,
      right.consumedStagedResultsCbor
    )
  );
}

function areStoredThreadsEqual(
  left: StoredThread,
  right: StoredThread
): boolean {
  return (
    left.threadId === right.threadId &&
    left.createdAtMs === right.createdAtMs &&
    left.schemaId === right.schemaId &&
    left.rootTurnNodeHash === right.rootTurnNodeHash
  );
}

function areStoredStagedResultsEqual(
  left: StoredStagedResult,
  right: StoredStagedResult
): boolean {
  if (
    left.runId !== right.runId ||
    left.taskId !== right.taskId ||
    left.objectHash !== right.objectHash ||
    left.objectType !== right.objectType ||
    left.status !== right.status ||
    left.createdAtMs !== right.createdAtMs
  ) {
    return false;
  }

  if (left.status === "interrupted" && right.status === "interrupted") {
    return areBytesEqual(left.interruptPayloadCbor, right.interruptPayloadCbor);
  }

  return left.status !== "interrupted" && right.status !== "interrupted";
}

function areStoredTurnTreePathsEqual(
  left: StoredTurnTreePath,
  right: StoredTurnTreePath
): boolean {
  if (
    left.turnTreeHash !== right.turnTreeHash ||
    left.path !== right.path ||
    left.collectionKind !== right.collectionKind
  ) {
    return false;
  }

  if (left.collectionKind === "single" && right.collectionKind === "single") {
    return left.singleHash === right.singleHash;
  }

  if (left.collectionKind === "ordered" && right.collectionKind === "ordered") {
    if (
      left.orderedEncoding !== right.orderedEncoding ||
      left.orderedCount !== right.orderedCount
    ) {
      return false;
    }

    if (left.orderedEncoding === "flat" && right.orderedEncoding === "flat") {
      return areBytesEqual(left.orderedInlineCbor, right.orderedInlineCbor);
    }

    if (
      left.orderedEncoding === "chunked" &&
      right.orderedEncoding === "chunked"
    ) {
      return areBytesEqual(
        left.orderedChunkListCbor,
        right.orderedChunkListCbor
      );
    }
  }

  return false;
}

function compareStoredBranch(left: StoredBranch, right: StoredBranch): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.branchId,
    right.branchId
  );
}

function compareStoredRun(left: StoredRun, right: StoredRun): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.runId,
    right.runId
  );
}

function compareStoredTurn(left: StoredTurn, right: StoredTurn): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.turnId,
    right.turnId
  );
}

function compareStoredStagedResult(
  left: StoredStagedResult,
  right: StoredStagedResult
): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.taskId,
    right.taskId
  );
}

function compareByTimestampAndKey(
  leftTimestamp: number,
  rightTimestamp: number,
  leftKey: string,
  rightKey: string
): number {
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  return leftKey.localeCompare(rightKey);
}

function areBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function persistenceError(
  message: string,
  code: string,
  details?: unknown,
  cause?: unknown
): TuvrenPersistenceError {
  return new TuvrenPersistenceError(message, { cause, code, details });
}
