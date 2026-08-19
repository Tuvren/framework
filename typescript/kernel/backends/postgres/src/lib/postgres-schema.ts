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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Constructor for the backend's persistence errors, injected so this module
 * stays free of a direct error-module dependency.
 */
export type PostgresPersistenceErrorFactory = (
  message: string,
  code: string,
  context?: Record<string, unknown>
) => Error;

/** Checked-in relational migration (issue #110 / ADR-067). */
export const RELATIONAL_SCHEMA_MIGRATION_NAME = "0001_relational_schema.sql";

/**
 * Legacy blob-era migration ledger names (pre-#110). Retained so open-time
 * migration can recognize databases that still need blob→row explode, and so
 * health checks do not treat them as unknown future migrations.
 */
export const LEGACY_BLOB_INITIAL_MIGRATION_NAME = "0001_initial_schema.sql";
export const LEGACY_BLOB_SCOPE_PARTITION_MIGRATION_NAME =
  "0002_scope_partition.sql";

/**
 * Family + support tables created by {@link RELATIONAL_SCHEMA_MIGRATION_NAME}
 * — the single roster consumed by both posture validation (order-agnostic)
 * and `purgeScope`'s per-table deletes, so adding a family cannot silently
 * miss one consumer. Ordered children-first for the purge path's
 * readability; deferred foreign keys make the order non-load-bearing.
 */
export const RELATIONAL_REQUIRED_TABLES = [
  "observe_annotations",
  "staged_results",
  "runs",
  "turns",
  "branches",
  "threads",
  "turn_tree_paths",
  "turn_node_lineage_roots",
  "turn_nodes",
  "ordered_path_chunks",
  "turn_trees",
  "objects",
  "schemas",
] as const;

/** Indexes created by {@link RELATIONAL_SCHEMA_MIGRATION_NAME}. */
export const RELATIONAL_REQUIRED_INDEXES = [
  "idx_turn_trees_scope_schema_id",
  "idx_turn_tree_paths_scope_path_turn_tree_hash",
  "idx_turn_nodes_scope_previous_turn_node_hash",
  "idx_turn_nodes_scope_turn_tree_hash",
  "idx_threads_scope_root_turn_node_hash",
  "idx_threads_scope_created_at_ms_thread_id",
  "idx_branches_scope_thread_id",
  "idx_branches_scope_head_turn_node_hash",
  "idx_branches_scope_archived_from_branch_id",
  "idx_turns_scope_thread_id",
  "idx_turns_scope_branch_id",
  "idx_turns_scope_parent_turn_id",
  "idx_turns_scope_thread_branch_head_turn_node",
  "idx_runs_scope_turn_id",
  "idx_runs_scope_branch_id",
  "idx_runs_scope_branch_id_status",
  "idx_runs_scope_status_lease_expires_at_ms",
  "idx_staged_results_scope_run_id_status",
  "idx_staged_results_scope_object_hash",
  "idx_observe_annotations_scope_run_id_created_at_ms",
  "idx_turn_node_lineage_roots_scope_root_depth",
] as const;

/** Exact `table.column:type:nullability` roster created by the relational DDL. */
export const RELATIONAL_REQUIRED_COLUMNS = [
  "objects.scope:text:required",
  "objects.hash:text:required",
  "objects.media_type:text:required",
  "objects.bytes:bytea:required",
  "objects.byte_length:integer:required",
  "objects.created_at_ms:bigint:required",
  "schemas.scope:text:required",
  "schemas.schema_id:text:required",
  "schemas.schema_cbor:bytea:required",
  "schemas.created_at_ms:bigint:required",
  "turn_trees.scope:text:required",
  "turn_trees.hash:text:required",
  "turn_trees.schema_id:text:required",
  "turn_trees.manifest_cbor:bytea:required",
  "turn_trees.created_at_ms:bigint:required",
  "turn_tree_paths.scope:text:required",
  "turn_tree_paths.turn_tree_hash:text:required",
  "turn_tree_paths.path:text:required",
  "turn_tree_paths.collection_kind:text:required",
  "turn_tree_paths.single_hash:text:nullable",
  "turn_tree_paths.ordered_encoding:text:nullable",
  "turn_tree_paths.ordered_count:integer:nullable",
  "turn_tree_paths.ordered_inline_cbor:bytea:nullable",
  "turn_tree_paths.ordered_chunk_list_cbor:bytea:nullable",
  "ordered_path_chunks.scope:text:required",
  "ordered_path_chunks.chunk_hash:text:required",
  "ordered_path_chunks.item_count:integer:required",
  "ordered_path_chunks.items_cbor:bytea:required",
  "ordered_path_chunks.created_at_ms:bigint:required",
  "turn_nodes.scope:text:required",
  "turn_nodes.hash:text:required",
  "turn_nodes.previous_turn_node_hash:text:nullable",
  "turn_nodes.turn_tree_hash:text:required",
  "turn_nodes.consumed_staged_results_cbor:bytea:required",
  "turn_nodes.schema_id:text:required",
  "turn_nodes.event_hash:text:nullable",
  "turn_nodes.created_at_ms:bigint:required",
  "threads.scope:text:required",
  "threads.thread_id:text:required",
  "threads.schema_id:text:required",
  "threads.root_turn_node_hash:text:required",
  "threads.created_at_ms:bigint:required",
  "branches.scope:text:required",
  "branches.branch_id:text:required",
  "branches.thread_id:text:required",
  "branches.head_turn_node_hash:text:required",
  "branches.archived_from_branch_id:text:nullable",
  "branches.created_at_ms:bigint:required",
  "branches.updated_at_ms:bigint:required",
  "turns.scope:text:required",
  "turns.turn_id:text:required",
  "turns.thread_id:text:required",
  "turns.branch_id:text:required",
  "turns.parent_turn_id:text:nullable",
  "turns.start_turn_node_hash:text:required",
  "turns.head_turn_node_hash:text:required",
  "turns.created_at_ms:bigint:required",
  "turns.updated_at_ms:bigint:required",
  "runs.scope:text:required",
  "runs.run_id:text:required",
  "runs.turn_id:text:required",
  "runs.branch_id:text:required",
  "runs.schema_id:text:required",
  "runs.start_turn_node_hash:text:required",
  "runs.status:text:required",
  "runs.current_step_index:integer:required",
  "runs.step_sequence_cbor:bytea:required",
  "runs.created_turn_nodes_cbor:bytea:required",
  "runs.pending_signals_cbor:bytea:nullable",
  "runs.execution_owner_id:text:nullable",
  "runs.lease_expires_at_ms:bigint:nullable",
  "runs.fencing_token:text:nullable",
  "runs.preemption_reason:text:nullable",
  "runs.created_at_ms:bigint:required",
  "runs.updated_at_ms:bigint:required",
  "staged_results.scope:text:required",
  "staged_results.run_id:text:required",
  "staged_results.task_id:text:required",
  "staged_results.object_hash:text:required",
  "staged_results.object_type:text:required",
  "staged_results.status:text:required",
  "staged_results.interrupt_payload_cbor:bytea:nullable",
  "staged_results.created_at_ms:bigint:required",
  "observe_annotations.scope:text:required",
  "observe_annotations.record_key:text:required",
  "observe_annotations.run_id:text:required",
  "observe_annotations.annotation_hash:text:required",
  "observe_annotations.turn_node_hash:text:nullable",
  "observe_annotations.annotation_cbor:bytea:required",
  "observe_annotations.created_at_ms:bigint:required",
  "turn_node_lineage_roots.scope:text:required",
  "turn_node_lineage_roots.turn_node_hash:text:required",
  "turn_node_lineage_roots.root_turn_node_hash:text:required",
  "turn_node_lineage_roots.depth:integer:required",
] as const;

/** Produces the canonical structural signature used by the column roster. */
export function relationalColumnSignature(
  tableName: string,
  columnName: string,
  dataType: string,
  nullable: boolean
): string {
  return `${tableName}.${columnName}:${dataType}:${nullable ? "nullable" : "required"}`;
}

/**
 * Structural signatures of every foreign key created by the relational DDL.
 * Names are deliberately excluded because PostgreSQL generates them; source
 * and target tables plus ordered column tuples are the durable semantics.
 */
export const RELATIONAL_REQUIRED_FOREIGN_KEYS = [
  "turn_trees(scope,schema_id)->schemas(scope,schema_id)",
  "turn_tree_paths(scope,turn_tree_hash)->turn_trees(scope,hash)",
  "turn_nodes(scope,previous_turn_node_hash)->turn_nodes(scope,hash)",
  "turn_nodes(scope,turn_tree_hash)->turn_trees(scope,hash)",
  "turn_nodes(scope,schema_id)->schemas(scope,schema_id)",
  "turn_nodes(scope,event_hash)->objects(scope,hash)",
  "threads(scope,schema_id)->schemas(scope,schema_id)",
  "threads(scope,root_turn_node_hash)->turn_nodes(scope,hash)",
  "branches(scope,thread_id)->threads(scope,thread_id)",
  "branches(scope,head_turn_node_hash)->turn_nodes(scope,hash)",
  "branches(scope,archived_from_branch_id)->branches(scope,branch_id)",
  "turns(scope,thread_id)->threads(scope,thread_id)",
  "turns(scope,branch_id)->branches(scope,branch_id)",
  "turns(scope,parent_turn_id)->turns(scope,turn_id)",
  "turns(scope,start_turn_node_hash)->turn_nodes(scope,hash)",
  "turns(scope,head_turn_node_hash)->turn_nodes(scope,hash)",
  "runs(scope,turn_id)->turns(scope,turn_id)",
  "runs(scope,branch_id)->branches(scope,branch_id)",
  "runs(scope,schema_id)->schemas(scope,schema_id)",
  "runs(scope,start_turn_node_hash)->turn_nodes(scope,hash)",
  "staged_results(scope,run_id)->runs(scope,run_id)",
  "staged_results(scope,object_hash)->objects(scope,hash)",
  "observe_annotations(scope,run_id)->runs(scope,run_id)",
  "observe_annotations(scope,turn_node_hash)->turn_nodes(scope,hash)",
  "turn_node_lineage_roots(scope,turn_node_hash)->turn_nodes(scope,hash)",
  "turn_node_lineage_roots(scope,root_turn_node_hash)->turn_nodes(scope,hash)",
] as const;

/** Produces the canonical structural signature used by the FK roster. */
export function relationalForeignKeySignature(
  sourceTable: string,
  sourceColumns: readonly string[],
  targetTable: string,
  targetColumns: readonly string[]
): string {
  return `${sourceTable}(${sourceColumns.join(",")})->${targetTable}(${targetColumns.join(",")})`;
}

/** Legacy blob table retired by the open-time migrator (issue #110). */
export const LEGACY_SNAPSHOTS_TABLE = "backend_postgres_snapshots";

/** Migration ledger table (shared name across blob and relational eras). */
export const MIGRATIONS_TABLE = "backend_postgres_migrations";

/** The table names {@link qualifyIdentifier} accepts, making the roster load-bearing at every call site. */
export type RelationalTableName =
  | (typeof RELATIONAL_REQUIRED_TABLES)[number]
  | typeof LEGACY_SNAPSHOTS_TABLE
  | typeof MIGRATIONS_TABLE;

/** Lists the directory's `.sql` migration files in application (name) order. */
export function listMigrationFiles(migrationDirectory: string): string[] {
  return readdirSync(migrationDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Locates the package's migrations directory across layouts (built `dist/`,
 * source checkout, and test execution), accepting only a candidate that
 * actually contains SQL files.
 *
 * @throws The injected persistence error with code
 *   `postgres_backend_missing_migrations_directory` when no candidate
 *   qualifies.
 */
export function resolveMigrationDirectory(
  persistenceError: PostgresPersistenceErrorFactory
): string {
  const candidates = [
    fileURLToPath(new URL("./postgres-migrations", import.meta.url)),
    fileURLToPath(new URL("./migrations", import.meta.url)),
    fileURLToPath(new URL("../../migrations", import.meta.url)),
    fileURLToPath(new URL("../migrations", import.meta.url)),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    // Nx-cached builds can leave behind an empty dist/migrations directory
    // before the authoritative SQL files are copied in.
    if (listMigrationFiles(candidate).length > 0) {
      return candidate;
    }
  }

  throw persistenceError(
    "postgres backend could not locate its migrations directory",
    "postgres_backend_missing_migrations_directory"
  );
}

/** Reads a migration file's SQL body from the resolved migrations directory. */
export function readMigrationSql(
  migrationDirectory: string,
  migrationName: string
): string {
  return readFileSync(`${migrationDirectory}/${migrationName}`, "utf8");
}
