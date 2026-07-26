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

/** Family + support tables created by {@link RELATIONAL_SCHEMA_MIGRATION_NAME}. */
export const RELATIONAL_REQUIRED_TABLES = [
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
  "observe_annotations",
  "turn_node_lineage_roots",
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

/** Legacy blob table retired by the open-time migrator (issue #110). */
export const LEGACY_SNAPSHOTS_TABLE = "backend_postgres_snapshots";

/** Migration ledger table (shared name across blob and relational eras). */
export const MIGRATIONS_TABLE = "backend_postgres_migrations";

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
