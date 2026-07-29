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

// `RELATIONAL_REQUIRED_TABLES` and `RELATIONAL_REQUIRED_INDEXES`
// (src/lib/postgres-schema.ts) are hand-transcribed from the checked-in
// migration SQL, and `RELATIONAL_REQUIRED_TABLES` is also the roster
// `purgeScope` walks for its per-table tenant-offboarding deletes. Nothing
// short of this test proves DDL subset-or-equal roster: a future migration
// that adds a family table without editing the roster would silently leak
// that tenant's rows through a purge. This is a pure source-text agreement
// guard (no database needed), the same shape as
// typescript/kernel/runtime/test/runtime-kernel-storage.chunk-constant-agreement.test.ts.
//
// Directory resolution deliberately reuses `listMigrationFiles` /
// `resolveMigrationDirectory` from src/lib/postgres-schema.ts instead of a
// hand-rolled path, and scans every `.sql` file the directory holds (not
// just 0001_relational_schema.sql), so a future migration is covered
// automatically without editing this test.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { persistenceError } from "../src/lib/postgres-errors.js";
import {
  listMigrationFiles,
  MIGRATIONS_TABLE,
  RELATIONAL_REQUIRED_INDEXES,
  RELATIONAL_REQUIRED_TABLES,
  readMigrationSql,
  resolveMigrationDirectory,
} from "../src/lib/postgres-schema.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SCHEMA_INIT_SOURCE_PATH = join(
  TEST_DIRECTORY,
  "../src/lib/postgres-schema-init.ts"
);

// `\s` in a JS regex already matches newlines, so this tolerates the
// multi-line `CREATE INDEX ... \n  ON table(...)` form the migration file
// actually uses (e.g. idx_turn_tree_paths_scope_path_turn_tree_hash) as well
// as the single-line form.
const CREATE_TABLE_PATTERN = /CREATE TABLE\s+(\w+)\s*\(/g;
const CREATE_INDEX_PATTERN = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)\s+ON/g;

// The migration ledger table must be created via `CREATE TABLE IF NOT
// EXISTS` bound to the `migrationsTable` identifier (derived from
// MIGRATIONS_TABLE through qualifyIdentifier) directly in the init module,
// not shipped inside a checked-in migration's SQL body.
const MIGRATIONS_TABLE_CREATE_PATTERN =
  /CREATE TABLE IF NOT EXISTS\s+\$\{migrationsTable\}/;
const MIGRATIONS_TABLE_BINDING_PATTERN =
  /qualifyIdentifier\(schemaName,\s*MIGRATIONS_TABLE\)/;

function extractAll(pattern: RegExp, sql: string): string[] {
  return [...sql.matchAll(pattern)].map((match) => {
    const name = match[1];
    if (name === undefined) {
      throw new Error(
        `pattern ${pattern.source} matched without a capture group`
      );
    }
    return name;
  });
}

function loadAllMigrationSql(): Array<{ name: string; sql: string }> {
  const migrationDirectory = resolveMigrationDirectory(persistenceError);
  return listMigrationFiles(migrationDirectory).map((name) => ({
    name,
    sql: readMigrationSql(migrationDirectory, name),
  }));
}

function formatSetDiff(missing: string[], extra: string[]): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing from roster: ${missing.sort().join(", ")}`);
  }
  if (extra.length > 0) {
    parts.push(`extra in roster (not in DDL): ${extra.sort().join(", ")}`);
  }
  return parts.join("; ");
}

function assertSetsEqual(
  ddlNames: Iterable<string>,
  rosterNames: readonly string[]
): void {
  const ddlSet = new Set(ddlNames);
  const rosterSet = new Set(rosterNames);

  const missingFromRoster = [...ddlSet].filter((name) => !rosterSet.has(name));
  const extraInRoster = [...rosterSet].filter((name) => !ddlSet.has(name));
  const diffMessage = formatSetDiff(missingFromRoster, extraInRoster);

  expect(missingFromRoster, diffMessage).toEqual([]);
  expect(extraInRoster, diffMessage).toEqual([]);
}

describe("relational Postgres schema DDL <-> roster agreement", () => {
  test("every CREATE TABLE across all migration files matches RELATIONAL_REQUIRED_TABLES exactly, excluding the migration ledger", () => {
    const migrations = loadAllMigrationSql();
    const ddlTableNames = migrations.flatMap(({ sql }) =>
      extractAll(CREATE_TABLE_PATTERN, sql)
    );

    // The migration ledger (backend_postgres_migrations) is provisioned
    // directly by the init code (verified below), never by a migration
    // file's CREATE TABLE, so it must never surface from this scan. If it
    // ever did, the roster comparison below would need to special-case it —
    // encode that expectation explicitly instead of silently tolerating it.
    expect(ddlTableNames).not.toContain(MIGRATIONS_TABLE);

    assertSetsEqual(ddlTableNames, RELATIONAL_REQUIRED_TABLES);
  });

  test("every CREATE [UNIQUE] INDEX across all migration files matches RELATIONAL_REQUIRED_INDEXES exactly", () => {
    const migrations = loadAllMigrationSql();
    const ddlIndexNames = migrations.flatMap(({ sql }) =>
      extractAll(CREATE_INDEX_PATTERN, sql)
    );

    assertSetsEqual(ddlIndexNames, RELATIONAL_REQUIRED_INDEXES);
  });

  test("the migration ledger table is provisioned by postgres-schema-init.ts outside any migration file, not by DDL", () => {
    // This is the claim the first test above relies on to justify excluding
    // MIGRATIONS_TABLE from the DDL <-> roster comparison. Verify it
    // directly against the init module's source text rather than assuming it.
    const initSource = readFileSync(SCHEMA_INIT_SOURCE_PATH, "utf8");

    expect(initSource).toMatch(MIGRATIONS_TABLE_CREATE_PATTERN);
    expect(initSource).toMatch(MIGRATIONS_TABLE_BINDING_PATTERN);

    const migrations = loadAllMigrationSql();
    for (const { name, sql } of migrations) {
      const tableNamesInFile = extractAll(CREATE_TABLE_PATTERN, sql);
      expect(
        tableNamesInFile,
        `migration ${name} unexpectedly declares the migration ledger table via DDL`
      ).not.toContain(MIGRATIONS_TABLE);
    }
  });
});
