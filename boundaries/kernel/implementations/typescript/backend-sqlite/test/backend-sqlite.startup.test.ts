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

import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { createSqliteBackend } from "../src/index.js";
import {
  copyCompiledSqliteRuntimeBundle,
  copyCurrentPackageMigrations,
  createTempDatabasePath,
  createTempDirectory,
  createWorkspaceTempDirectory,
  getBaselineMigrationSql,
  getPendingSignalsAndAnnotationsMigrationSql,
  getTargetedValidationMigrationSql,
  INDEX_MISMATCH_ERROR_PATTERN,
  linkWorkspaceNodeModules,
  MIGRATION_CONFLICT_ERROR_PATTERN,
  MISSING_SCHEMA_ERROR_PATTERN,
  NON_PERSISTENT_DATABASE_ERROR_PATTERN,
  NORMALIZED_STARTUP_ERROR_PATTERN,
  SCHEMA_MISMATCH_ERROR_PATTERN,
  UNKNOWN_MIGRATION_ERROR_PATTERN,
} from "./backend-sqlite-test-helpers.js";

describe("@tuvren/backend-sqlite startup", () => {
  test("enables WAL mode and applies package migrations once", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });

    deepStrictEqual(await backend.health(), { ok: true });

    const probe = new Database(databasePath, { readonly: true });
    const journalMode = probe.pragma("journal_mode", {
      simple: true,
    }) as string;
    const migrationRows = probe
      .prepare("SELECT name FROM backend_sqlite_migrations ORDER BY name")
      .all() as Array<{ name: string }>;
    const objectsTable = probe
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'objects'"
      )
      .get() as { name: string } | undefined;
    probe.close();

    strictEqual(journalMode.toLowerCase(), "wal");
    deepStrictEqual(migrationRows, [
      { name: "0001_initial_schema.sql" },
      { name: "0002_targeted_validation_indexes.sql" },
      { name: "0003_pending_signals_and_annotations.sql" },
      { name: "0004_observe_annotations.sql" },
      { name: "0005_run_liveness.sql" },
    ]);
    deepStrictEqual(objectsTable, { name: "objects" });

    createSqliteBackend({ databasePath });
    const secondProbe = new Database(databasePath, { readonly: true });
    const reappliedRows = secondProbe
      .prepare("SELECT name FROM backend_sqlite_migrations ORDER BY name")
      .all() as Array<{ name: string }>;
    secondProbe.close();

    deepStrictEqual(reappliedRows, migrationRows);
  });

  test("rejects non-persistent in-memory database paths", () => {
    throws(
      () => createSqliteBackend({ databasePath: ":memory:" }),
      NON_PERSISTENT_DATABASE_ERROR_PATTERN
    );
  });

  test("rejects empty-string temporary database paths as non-persistent", () => {
    throws(
      () => createSqliteBackend({ databasePath: "" }),
      NON_PERSISTENT_DATABASE_ERROR_PATTERN
    );
  });

  test("normalizes accepted file: paths to filesystem database files", {
    concurrency: false,
  }, async () => {
    const tempDirectory = createTempDirectory("kraken-sqlite-uri-");
    const originalCwd = process.cwd();
    const relativeDatabasePath = "file:relative-uri.db";
    const absoluteDatabasePath = `file:${join(tempDirectory, "absolute-uri.db")}`;

    try {
      process.chdir(tempDirectory);

      const relativeBackend = createSqliteBackend({
        databasePath: relativeDatabasePath,
      });
      const absoluteBackend = createSqliteBackend({
        databasePath: absoluteDatabasePath,
      });

      deepStrictEqual(await relativeBackend.health(), { ok: true });
      deepStrictEqual(await absoluteBackend.health(), { ok: true });

      strictEqual(existsSync(join(tempDirectory, "relative-uri.db")), true);
      strictEqual(existsSync(join(tempDirectory, relativeDatabasePath)), false);
      strictEqual(existsSync(join(tempDirectory, "absolute-uri.db")), true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("uses package-local migrations when cwd has unrelated SQL files", {
    concurrency: false,
  }, () => {
    const databasePath = createTempDatabasePath();
    const tempCwd = createTempDirectory("kraken-sqlite-cwd-");
    const originalCwd = process.cwd();

    mkdirSync(join(tempCwd, "migrations"));
    writeFileSync(
      join(tempCwd, "migrations", "0001_wrong.sql"),
      "THIS IS NOT SQL;\n",
      "utf8"
    );

    try {
      process.chdir(tempCwd);
      createSqliteBackend({ databasePath });
    } finally {
      process.chdir(originalCwd);
    }

    const probe = new Database(databasePath, { readonly: true });
    const migrationRows = probe
      .prepare("SELECT name FROM backend_sqlite_migrations ORDER BY name")
      .all() as Array<{ name: string }>;
    probe.close();

    deepStrictEqual(migrationRows, [
      { name: "0001_initial_schema.sql" },
      { name: "0002_targeted_validation_indexes.sql" },
      { name: "0003_pending_signals_and_annotations.sql" },
      { name: "0004_observe_annotations.sql" },
      { name: "0005_run_liveness.sql" },
    ]);
  });

  test("rolls back failed migration files without recording partial success", () => {
    const databasePath = createTempDatabasePath();
    const seed = new Database(databasePath);
    seed.exec("CREATE TABLE turn_trees (hash TEXT PRIMARY KEY)");
    seed.close();

    throws(
      () => createSqliteBackend({ databasePath }),
      MIGRATION_CONFLICT_ERROR_PATTERN
    );
  });

  test("rejects databases that record the baseline migration without its tables", () => {
    const databasePath = createTempDatabasePath();
    const seed = new Database(databasePath);
    seed.exec(`
      CREATE TABLE backend_sqlite_migrations (
        name TEXT PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      )
    `);
    seed
      .prepare(
        `
          INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
          VALUES (?, ?)
        `
      )
      .run("0001_initial_schema.sql", 1);
    seed.close();

    throws(
      () => createSqliteBackend({ databasePath }),
      MISSING_SCHEMA_ERROR_PATTERN
    );
  });

  test("upgrades databases from 0003 to 0005 during startup", async () => {
    const databasePath = createTempDatabasePath();
    const seed = new Database(databasePath);
    seed.exec(`
      CREATE TABLE backend_sqlite_migrations (
        name TEXT PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
    `);
    seed.exec(getBaselineMigrationSql());
    seed.exec(getTargetedValidationMigrationSql());
    seed.exec(getPendingSignalsAndAnnotationsMigrationSql());
    seed
      .prepare(
        `
          INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
          VALUES (?, ?)
        `
      )
      .run("0001_initial_schema.sql", 1);
    seed
      .prepare(
        `
          INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
          VALUES (?, ?)
        `
      )
      .run("0002_targeted_validation_indexes.sql", 2);
    seed
      .prepare(
        `
          INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
          VALUES (?, ?)
        `
      )
      .run("0003_pending_signals_and_annotations.sql", 3);
    seed.close();

    const backend = createSqliteBackend({ databasePath });
    deepStrictEqual(await backend.health(), { ok: true });
  });

  test("loads migrations from dist-local paths in dist-style layouts", async () => {
    const tempDirectory = createWorkspaceTempDirectory(
      ".tmp-sqlite-dist-layout-"
    );
    const fakeDistDirectory = join(tempDirectory, "deeper", "deep");
    const fakeMigrationsDirectory = join(fakeDistDirectory, "migrations");
    const runtimePath = join(fakeDistDirectory, "index.js");
    const databasePath = join(tempDirectory, "dist-only.sqlite");

    mkdirSync(fakeMigrationsDirectory, { recursive: true });
    linkWorkspaceNodeModules(tempDirectory);
    copyCompiledSqliteRuntimeBundle(runtimePath);
    copyCurrentPackageMigrations(fakeMigrationsDirectory);

    const runtimeModule = (await import(pathToFileURL(runtimePath).href)) as {
      createSqliteBackend: typeof createSqliteBackend;
    };
    const backend = runtimeModule.createSqliteBackend({ databasePath });

    deepStrictEqual(await backend.health(), { ok: true });
  });

  test("normalizes constructor open failures into backend persistence errors", () => {
    throws(
      () => createSqliteBackend({ databasePath: process.cwd() }),
      NORMALIZED_STARTUP_ERROR_PATTERN
    );
  });

  test("allows later migrations to extend baseline tables without revalidating them against 0001 exact shape", async () => {
    const tempDirectory = createWorkspaceTempDirectory(
      ".tmp-sqlite-future-table-layout-"
    );
    const fakeDistDirectory = join(tempDirectory, "deeper", "deep");
    const fakeMigrationsDirectory = join(fakeDistDirectory, "migrations");
    const runtimePath = join(fakeDistDirectory, "index.js");
    const databasePath = join(tempDirectory, "future-table.sqlite");

    mkdirSync(fakeMigrationsDirectory, { recursive: true });
    linkWorkspaceNodeModules(tempDirectory);
    copyCompiledSqliteRuntimeBundle(runtimePath);
    copyCurrentPackageMigrations(fakeMigrationsDirectory);
    writeFileSync(
      join(fakeMigrationsDirectory, "0006_add_objects_extra.sql"),
      "ALTER TABLE objects ADD COLUMN extra TEXT;\n",
      "utf8"
    );

    const runtimeModule = (await import(pathToFileURL(runtimePath).href)) as {
      createSqliteBackend: typeof createSqliteBackend;
    };
    const backend = runtimeModule.createSqliteBackend({ databasePath });

    deepStrictEqual(await backend.health(), { ok: true });
  });

  test("allows later migrations to rebuild baseline indexes without revalidating 0001 exact index definitions", async () => {
    const tempDirectory = createWorkspaceTempDirectory(
      ".tmp-sqlite-future-index-layout-"
    );
    const fakeDistDirectory = join(tempDirectory, "deeper", "deep");
    const fakeMigrationsDirectory = join(fakeDistDirectory, "migrations");
    const runtimePath = join(fakeDistDirectory, "index.js");
    const databasePath = join(tempDirectory, "future-index.sqlite");

    mkdirSync(fakeMigrationsDirectory, { recursive: true });
    linkWorkspaceNodeModules(tempDirectory);
    copyCompiledSqliteRuntimeBundle(runtimePath);
    copyCurrentPackageMigrations(fakeMigrationsDirectory);
    writeFileSync(
      join(fakeMigrationsDirectory, "0006_rebuild_runs_index.sql"),
      [
        "DROP INDEX idx_runs_branch_id_status;",
        "CREATE INDEX idx_runs_branch_id_status ON runs(branch_id, status, updated_at_ms);",
        "",
      ].join("\n"),
      "utf8"
    );

    const runtimeModule = (await import(pathToFileURL(runtimePath).href)) as {
      createSqliteBackend: typeof createSqliteBackend;
    };
    const backend = runtimeModule.createSqliteBackend({ databasePath });

    deepStrictEqual(await backend.health(), { ok: true });
  });

  test("rejects databases that contain unknown applied migrations", () => {
    const databasePath = createTempDatabasePath();
    const seed = new Database(databasePath);
    seed.exec(`
      CREATE TABLE backend_sqlite_migrations (
        name TEXT PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      )
    `);
    seed
      .prepare(
        `
          INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
          VALUES (?, ?)
        `
      )
      .run("9999_future_schema.sql", 1);
    seed.close();

    throws(
      () => createSqliteBackend({ databasePath }),
      UNKNOWN_MIGRATION_ERROR_PATTERN
    );
  });

  test("rejects latest package migration databases whose baseline table definitions drift", () => {
    const databasePath = createTempDatabasePath();
    const seed = new Database(databasePath);
    const malformedSchemaSql = getBaselineMigrationSql().replace(
      `CREATE TABLE objects (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);`,
      `CREATE TABLE objects (
  hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);`
    );

    seed.exec(`
      CREATE TABLE backend_sqlite_migrations (
        name TEXT PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      )
    `);

    for (const [migrationName, appliedAtMs] of [
      ["0001_initial_schema.sql", 1],
      ["0002_targeted_validation_indexes.sql", 2],
      ["0003_pending_signals_and_annotations.sql", 3],
    ] as const) {
      seed
        .prepare(
          `
            INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
            VALUES (?, ?)
          `
        )
        .run(migrationName, appliedAtMs);
    }

    seed.exec(malformedSchemaSql);
    seed.exec(getTargetedValidationMigrationSql());
    seed.exec(getPendingSignalsAndAnnotationsMigrationSql());
    seed.close();

    throws(
      () => createSqliteBackend({ databasePath }),
      SCHEMA_MISMATCH_ERROR_PATTERN
    );
  });

  test("rejects databases whose baseline table definitions no longer match the package schema", () => {
    const databasePath = createTempDatabasePath();
    const seed = new Database(databasePath);
    const malformedSchemaSql = getBaselineMigrationSql().replace(
      `CREATE TABLE objects (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);`,
      `CREATE TABLE objects (
  hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);`
    );

    seed.exec(`
      CREATE TABLE backend_sqlite_migrations (
        name TEXT PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      )
    `);
    seed
      .prepare(
        `
          INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
          VALUES (?, ?)
        `
      )
      .run("0001_initial_schema.sql", 1);
    seed.exec(malformedSchemaSql);
    seed.close();

    throws(
      () => createSqliteBackend({ databasePath }),
      SCHEMA_MISMATCH_ERROR_PATTERN
    );
  });

  test("rejects databases whose targeted validation table definitions no longer match the package schema", () => {
    const databasePath = createTempDatabasePath();
    const seed = new Database(databasePath);
    const malformedTargetedValidationSql =
      getTargetedValidationMigrationSql().replace(
        "  depth INTEGER NOT NULL,",
        "  depth TEXT NOT NULL,"
      );

    seed.exec(`
      CREATE TABLE backend_sqlite_migrations (
        name TEXT PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      )
    `);
    seed
      .prepare(
        `
          INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
          VALUES (?, ?)
        `
      )
      .run("0001_initial_schema.sql", 1);
    seed
      .prepare(
        `
          INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
          VALUES (?, ?)
        `
      )
      .run("0002_targeted_validation_indexes.sql", 2);
    seed.exec(getBaselineMigrationSql());
    seed.exec(malformedTargetedValidationSql);
    seed.close();

    throws(
      () => createSqliteBackend({ databasePath }),
      SCHEMA_MISMATCH_ERROR_PATTERN
    );
  });

  test("rejects databases whose targeted validation index definitions no longer match the package schema", () => {
    const databasePath = createTempDatabasePath();
    const seed = new Database(databasePath);
    const malformedTargetedValidationSql =
      getTargetedValidationMigrationSql().replace(
        "ON turn_node_lineage_roots(root_turn_node_hash, depth);",
        "ON turn_node_lineage_roots(depth, root_turn_node_hash);"
      );

    seed.exec(`
      CREATE TABLE backend_sqlite_migrations (
        name TEXT PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      )
    `);
    seed
      .prepare(
        `
          INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
          VALUES (?, ?)
        `
      )
      .run("0001_initial_schema.sql", 1);
    seed
      .prepare(
        `
          INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
          VALUES (?, ?)
        `
      )
      .run("0002_targeted_validation_indexes.sql", 2);
    seed.exec(getBaselineMigrationSql());
    seed.exec(malformedTargetedValidationSql);
    seed.close();

    throws(
      () => createSqliteBackend({ databasePath }),
      INDEX_MISMATCH_ERROR_PATTERN
    );
  });
});
