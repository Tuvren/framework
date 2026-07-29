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

import {
  NOOP_PHASE_OBSERVER,
  type PhaseObserver,
} from "@tuvren/backend-shared";
import type { EpochMs } from "@tuvren/core";
import type { Sql, TransactionSql } from "postgres";
import { persistenceError } from "./postgres-errors.js";
import {
  LEGACY_BLOB_INITIAL_MIGRATION_NAME,
  LEGACY_BLOB_SCOPE_PARTITION_MIGRATION_NAME,
  LEGACY_SNAPSHOTS_TABLE,
  listMigrationFiles,
  MIGRATIONS_TABLE,
  RELATIONAL_REQUIRED_INDEXES,
  RELATIONAL_REQUIRED_TABLES,
  RELATIONAL_SCHEMA_MIGRATION_NAME,
  readMigrationSql,
  resolveMigrationDirectory,
} from "./postgres-schema.js";
import {
  type DbSql,
  deriveAdvisoryLockKey,
  qualifyIdentifier,
  quoteIdentifier,
} from "./postgres-sql.js";

type Tx = TransactionSql<Record<string, never>>;

/**
 * Memoized `(migrationDirectory, migrationFiles)` pair, computed at most
 * once per process. The migrations directory's location and its checked-in
 * `.sql` file listing are fixed at build/install time (issue #108 M5 follow-
 * up): they cannot change while the process is running, so every repeated
 * `resolveMigrationDirectory`/`listMigrationFiles` pair after the first was
 * paying `existsSync`/`readdirSync` system calls for an answer that could
 * never differ — most visibly on `health()`, which callers may poll often.
 */
let memoizedMigrationFiles: { directory: string; names: string[] } | undefined;

/**
 * Returns the resolved migrations directory and its sorted `.sql` file
 * listing, computing it once per process and reusing the memoized result on
 * every later call (see {@link memoizedMigrationFiles}).
 */
function resolveMigrationFileListing(): {
  directory: string;
  names: string[];
} {
  if (memoizedMigrationFiles === undefined) {
    const directory = resolveMigrationDirectory(persistenceError);
    memoizedMigrationFiles = {
      directory,
      names: listMigrationFiles(directory),
    };
  }

  return memoizedMigrationFiles;
}

/**
 * Idempotently provisions a host PostgreSQL schema for the relational
 * backend (ADR-067 / issue #110): creates the schema and migration ledger,
 * applies checked-in SQL migrations, and runs the open-time blob→row
 * explode when a legacy `backend_postgres_snapshots` table is present.
 *
 * Concurrent initializers of the same schema are serialized via a
 * transaction-scoped advisory lock keyed on the schema name (see
 * {@link deriveAdvisoryLockKey}). The wait is deliberately unbounded: a
 * process arriving second may legitimately be waiting on another process's
 * one-time blob→row migration of the same schema.
 */
export async function ensurePostgresRelationalSchemaInitialized(
  sql: Sql,
  schemaName: string,
  now: () => EpochMs,
  phaseObserver: PhaseObserver = NOOP_PHASE_OBSERVER
): Promise<void> {
  const migrationsTable = qualifyIdentifier(schemaName, MIGRATIONS_TABLE);
  const lockKey = deriveAdvisoryLockKey(
    "tuvren-postgres-schema-init",
    schemaName
  );

  await sql.begin(async (tx) => {
    // The key is a bigint derived from our own SHA-256, safe to inline; the
    // single-statement no-parameter form keeps this on one round trip.
    await tx.unsafe(`SELECT pg_advisory_xact_lock(${lockKey})`);
    await tx.unsafe(
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`
    );
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS ${migrationsTable} (
        name TEXT PRIMARY KEY,
        applied_at_ms BIGINT NOT NULL
      )`
    );

    const applied = await loadAppliedMigrations(tx, migrationsTable);
    const { directory: migrationDirectory, names: migrationFiles } =
      resolveMigrationFileListing();

    for (const migrationName of migrationFiles) {
      if (applied.has(migrationName)) {
        continue;
      }

      const body = readMigrationSql(migrationDirectory, migrationName);
      // Migration SQL uses unqualified table names; set search_path for the
      // host schema so CREATE TABLE lands in the right namespace.
      await tx.unsafe(
        `SET LOCAL search_path TO ${quoteIdentifier(schemaName)}, public`
      );
      await tx.unsafe(body);
      await tx.unsafe(
        `INSERT INTO ${migrationsTable} (name, applied_at_ms) VALUES ($1, $2)`,
        [migrationName, now()]
      );
      applied.add(migrationName);
    }

    if (!applied.has(RELATIONAL_SCHEMA_MIGRATION_NAME)) {
      // The loop above applies every checked-in migration file, so reaching
      // here means the resolved migrations directory did not contain the
      // relational migration at all — a broken install, not a valid state.
      throw persistenceError(
        "postgres backend migrations directory is missing the relational schema migration",
        "postgres_backend_relational_schema_missing",
        { migrationDirectory, schemaName }
      );
    }

    await migrateLegacyBlobSnapshotsIfPresent(tx, schemaName, phaseObserver);
  });
}

/**
 * Validates the schema's durable posture without loading state: the
 * migration ledger contains the relational migration and nothing this
 * package version does not recognize (legacy blob-era ledger names are
 * expected on migrated databases), every required family table and index
 * exists, every `TEXT` column on those tables still carries the byte-wise
 * `COLLATE "C"` the migration created it with, and every foreign key among
 * those tables is still `DEFERRABLE INITIALLY DEFERRED`. This is the
 * coherence half of `health()` — the relational equivalent of the SQLite
 * backend's `validateMigrationState` — and it is also the first step of
 * `loadValidatedState`, so `fsck()`/`reclaim()` catch the same drift (e.g. an
 * operator manually dropping a required index or altering a column's
 * collation) that `health()` catches.
 *
 * Each aspect below costs exactly one round trip: one query against
 * `information_schema.tables`, one against `pg_indexes`, one against
 * `information_schema.columns` for collation, and one against `pg_constraint`
 * for FK deferrability.
 *
 * @throws TuvrenPersistenceError `postgres_backend_unknown_migrations`,
 *   `postgres_backend_relational_schema_missing`,
 *   `postgres_backend_relational_tables_missing`,
 *   `postgres_backend_relational_indexes_missing`,
 *   `postgres_backend_relational_collation_invalid`, or
 *   `postgres_backend_relational_fks_not_deferrable` naming what is wrong.
 */
export async function validateRelationalSchemaPosture(
  sql: DbSql,
  schemaName: string
): Promise<void> {
  const migrationsTable = qualifyIdentifier(schemaName, MIGRATIONS_TABLE);
  const applied = await loadAppliedMigrations(sql, migrationsTable);

  // Known = every migration file this package version ships (so adding a
  // future 0002_*.sql never makes health() reject the ledger entry the same
  // package just wrote) plus the legacy blob-era ledger names retained on
  // migrated databases. Anything else is a future package's migration and a
  // genuine posture failure for this version.
  const knownMigrations = new Set<string>([
    ...resolveMigrationFileListing().names,
    LEGACY_BLOB_INITIAL_MIGRATION_NAME,
    LEGACY_BLOB_SCOPE_PARTITION_MIGRATION_NAME,
  ]);
  const unknownMigrations = [...applied].filter(
    (name) => !knownMigrations.has(name)
  );

  if (unknownMigrations.length > 0) {
    throw persistenceError(
      "postgres backend migration ledger contains migrations this package version does not recognize",
      "postgres_backend_unknown_migrations",
      { schemaName, unknownMigrations }
    );
  }

  if (!applied.has(RELATIONAL_SCHEMA_MIGRATION_NAME)) {
    throw persistenceError(
      "postgres backend migration ledger is missing the relational schema migration",
      "postgres_backend_relational_schema_missing",
      { schemaName }
    );
  }

  const presentTables = await sql.unsafe<Array<{ table_name: string }>>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1
        AND table_name = ANY($2::text[])`,
    [schemaName, [...RELATIONAL_REQUIRED_TABLES]]
  );
  const tableNames = new Set(presentTables.map((row) => row.table_name));
  const missingTables = RELATIONAL_REQUIRED_TABLES.filter(
    (table) => !tableNames.has(table)
  );

  if (missingTables.length > 0) {
    throw persistenceError(
      "postgres backend relational family tables are missing",
      "postgres_backend_relational_tables_missing",
      { missingTables, schemaName }
    );
  }

  const presentIndexes = await sql.unsafe<Array<{ indexname: string }>>(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = $1
        AND indexname = ANY($2::text[])`,
    [schemaName, [...RELATIONAL_REQUIRED_INDEXES]]
  );
  const indexNames = new Set(presentIndexes.map((row) => row.indexname));
  const missingIndexes = RELATIONAL_REQUIRED_INDEXES.filter(
    (index) => !indexNames.has(index)
  );

  if (missingIndexes.length > 0) {
    throw persistenceError(
      "postgres backend relational indexes are missing",
      "postgres_backend_relational_indexes_missing",
      { missingIndexes, schemaName }
    );
  }

  const misCollatedColumns = await sql.unsafe<
    Array<{ column_name: string; table_name: string }>
  >(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = ANY($2::text[])
        AND data_type IN ('text', 'character varying')
        AND collation_name IS DISTINCT FROM 'C'`,
    [schemaName, [...RELATIONAL_REQUIRED_TABLES]]
  );

  if (misCollatedColumns.length > 0) {
    throw persistenceError(
      'postgres backend relational text columns must use COLLATE "C"',
      "postgres_backend_relational_collation_invalid",
      {
        columns: misCollatedColumns.map(
          (row) => `${row.table_name}.${row.column_name}`
        ),
        schemaName,
      }
    );
  }

  const nonDeferrableForeignKeys = await sql.unsafe<
    Array<{ constraint_name: string; table_name: string }>
  >(
    `SELECT cls.relname AS table_name, con.conname AS constraint_name
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
      WHERE ns.nspname = $1
        AND cls.relname = ANY($2::text[])
        AND con.contype = 'f'
        AND NOT (con.condeferrable AND con.condeferred)`,
    [schemaName, [...RELATIONAL_REQUIRED_TABLES]]
  );

  if (nonDeferrableForeignKeys.length > 0) {
    throw persistenceError(
      "postgres backend relational foreign keys must be DEFERRABLE INITIALLY DEFERRED",
      "postgres_backend_relational_fks_not_deferrable",
      {
        constraints: nonDeferrableForeignKeys.map(
          (row) => `${row.table_name}.${row.constraint_name}`
        ),
        schemaName,
      }
    );
  }
}

async function loadAppliedMigrations(
  sql: DbSql,
  migrationsTable: string
): Promise<Set<string>> {
  const rows = await sql.unsafe<Array<{ name: string }>>(
    `SELECT name FROM ${migrationsTable} ORDER BY name`
  );
  return new Set(rows.map((row) => row.name));
}

async function tableExists(
  tx: Tx,
  schemaName: string,
  tableName: string
): Promise<boolean> {
  const rows = await tx.unsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = $2
     ) AS exists`,
    [schemaName, tableName]
  );
  return rows[0]?.exists === true;
}

/**
 * Explodes legacy blob-per-scope rows into the relational family tables and
 * drops `backend_postgres_snapshots`. Implemented in a separate module to keep
 * the snapshot decoder out of the hot path once migration has run.
 */
async function migrateLegacyBlobSnapshotsIfPresent(
  tx: Tx,
  schemaName: string,
  phaseObserver: PhaseObserver
): Promise<void> {
  const hasSnapshots = await tableExists(
    tx,
    schemaName,
    LEGACY_SNAPSHOTS_TABLE
  );
  if (!hasSnapshots) {
    return;
  }

  // Lazy import so the blob decoder is only pulled when a legacy DB is opened.
  const { explodeLegacyBlobSnapshots } = await import(
    "./postgres-blob-migration.js"
  );
  await explodeLegacyBlobSnapshots(tx, schemaName, phaseObserver);
}
