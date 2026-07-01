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

import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type SqlitePersistenceErrorFactory = (
  message: string,
  code: string,
  context?: Record<string, unknown>
) => Error;

export const INITIAL_SCHEMA_MIGRATION_NAME = "0001_initial_schema.sql";
export const TARGETED_VALIDATION_MIGRATION_NAME =
  "0002_targeted_validation_indexes.sql";
export const PENDING_SIGNALS_AND_ANNOTATIONS_MIGRATION_NAME =
  "0003_pending_signals_and_annotations.sql";
export const OBSERVE_ANNOTATIONS_MIGRATION_NAME =
  "0004_observe_annotations.sql";
export const RUN_LIVENESS_MIGRATION_NAME = "0005_run_liveness.sql";
export const INITIAL_SCHEMA_REQUIRED_TABLES = [
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
export const INITIAL_SCHEMA_REQUIRED_INDEXES = [
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
export const TARGETED_VALIDATION_REQUIRED_TABLES = [
  "turn_node_lineage_roots",
] as const;
export const OBSERVE_ANNOTATIONS_REQUIRED_TABLES = [
  "observe_annotations",
] as const;
export const TARGETED_VALIDATION_REQUIRED_INDEXES = [
  "idx_turn_node_lineage_roots_root_depth",
  "idx_threads_root_turn_node_hash",
  "idx_branches_archived_from_branch_id",
  "idx_turns_thread_branch_head_turn_node",
] as const;
export const OBSERVE_ANNOTATIONS_REQUIRED_INDEXES = [
  "idx_observe_annotations_run_id_created_at_ms",
] as const;
export const RUN_LIVENESS_REQUIRED_INDEXES = [
  "idx_runs_status_lease_expires_at_ms",
] as const;
export const SQLITE_TRANSIENT_MEMORY_PATH = ":memory:";

export interface ExpectedSqliteColumnSchema {
  name: string;
  notNull: boolean;
  primaryKeyOrder: number;
  type: string;
}

export interface ExpectedSqliteForeignKeySchema {
  columns: readonly string[];
  referencedColumns: readonly string[];
  referencedTable: string;
}

export interface ExpectedSqliteIndexSchema {
  columns: readonly string[];
  tableName: string;
  unique: boolean;
}

export interface ExpectedSqliteTableSchema {
  columns: readonly ExpectedSqliteColumnSchema[];
  foreignKeys: readonly ExpectedSqliteForeignKeySchema[];
}

export const INITIAL_SCHEMA_TABLE_DEFINITIONS = {
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
      {
        name: "pending_signals_cbor",
        notNull: false,
        primaryKeyOrder: 0,
        type: "BLOB",
      },
      {
        name: "last_step_annotations_cbor",
        notNull: false,
        primaryKeyOrder: 0,
        type: "BLOB",
      },
      {
        name: "execution_owner_id",
        notNull: false,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "lease_expires_at_ms",
        notNull: false,
        primaryKeyOrder: 0,
        type: "INTEGER",
      },
      {
        name: "fencing_token",
        notNull: false,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "preemption_reason",
        notNull: false,
        primaryKeyOrder: 0,
        type: "TEXT",
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
export const PRE_PENDING_RUN_COLUMN_NAMES = new Set([
  "last_step_annotations_cbor",
  "pending_signals_cbor",
]);
export const RUN_LIVENESS_RUN_COLUMN_NAMES = new Set([
  "execution_owner_id",
  "lease_expires_at_ms",
  "fencing_token",
  "preemption_reason",
]);
export const PRE_PENDING_SIGNALS_SCHEMA_TABLE_DEFINITIONS: Record<
  (typeof INITIAL_SCHEMA_REQUIRED_TABLES)[number],
  ExpectedSqliteTableSchema
> = {
  ...INITIAL_SCHEMA_TABLE_DEFINITIONS,
  runs: {
    ...INITIAL_SCHEMA_TABLE_DEFINITIONS.runs,
    columns: INITIAL_SCHEMA_TABLE_DEFINITIONS.runs.columns.filter(
      (column) =>
        !(
          PRE_PENDING_RUN_COLUMN_NAMES.has(column.name) ||
          RUN_LIVENESS_RUN_COLUMN_NAMES.has(column.name)
        )
    ),
  },
};
export const PRE_RUN_LIVENESS_SCHEMA_TABLE_DEFINITIONS: Record<
  (typeof INITIAL_SCHEMA_REQUIRED_TABLES)[number],
  ExpectedSqliteTableSchema
> = {
  ...INITIAL_SCHEMA_TABLE_DEFINITIONS,
  runs: {
    ...INITIAL_SCHEMA_TABLE_DEFINITIONS.runs,
    columns: INITIAL_SCHEMA_TABLE_DEFINITIONS.runs.columns.filter(
      (column) => !RUN_LIVENESS_RUN_COLUMN_NAMES.has(column.name)
    ),
  },
};
export const INITIAL_SCHEMA_INDEX_DEFINITIONS = {
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
export const TARGETED_VALIDATION_TABLE_DEFINITIONS = {
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
export const TARGETED_VALIDATION_INDEX_DEFINITIONS = {
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
export const OBSERVE_ANNOTATIONS_TABLE_DEFINITIONS = {
  observe_annotations: {
    columns: [
      {
        name: "record_key",
        notNull: false,
        primaryKeyOrder: 1,
        type: "TEXT",
      },
      {
        name: "run_id",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "annotation_hash",
        notNull: true,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "turn_node_hash",
        notNull: false,
        primaryKeyOrder: 0,
        type: "TEXT",
      },
      {
        name: "annotation_cbor",
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
        columns: ["run_id"],
        referencedColumns: ["run_id"],
        referencedTable: "runs",
      },
      {
        columns: ["turn_node_hash"],
        referencedColumns: ["hash"],
        referencedTable: "turn_nodes",
      },
    ],
  },
} as const satisfies Record<
  (typeof OBSERVE_ANNOTATIONS_REQUIRED_TABLES)[number],
  ExpectedSqliteTableSchema
>;
export const OBSERVE_ANNOTATIONS_INDEX_DEFINITIONS = {
  idx_observe_annotations_run_id_created_at_ms: {
    columns: ["run_id", "created_at_ms"],
    tableName: "observe_annotations",
    unique: false,
  },
} as const satisfies Record<
  (typeof OBSERVE_ANNOTATIONS_REQUIRED_INDEXES)[number],
  ExpectedSqliteIndexSchema
>;
export const RUN_LIVENESS_INDEX_DEFINITIONS = {
  idx_runs_status_lease_expires_at_ms: {
    columns: ["status", "lease_expires_at_ms"],
    tableName: "runs",
    unique: false,
  },
} as const satisfies Record<
  (typeof RUN_LIVENESS_REQUIRED_INDEXES)[number],
  ExpectedSqliteIndexSchema
>;

export function listMigrationFiles(migrationDirectory: string): string[] {
  return readdirSync(migrationDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
}

export function resolveMigrationDirectory(
  persistenceError: SqlitePersistenceErrorFactory
): string {
  const candidates = [
    fileURLToPath(new URL("./migrations", import.meta.url)),
    fileURLToPath(new URL("../../migrations", import.meta.url)),
    fileURLToPath(new URL("../migrations", import.meta.url)),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    // Nx-cached builds can leave behind an empty dist/migrations directory
    // before the authoritative SQL files are copied in. Treating "directory
    // exists" as sufficient would silently skip every migration on a new DB.
    if (listMigrationFiles(candidate).length > 0) {
      return candidate;
    }
  }

  throw persistenceError(
    "sqlite backend could not locate its migrations directory",
    "sqlite_backend_missing_migrations_directory"
  );
}
