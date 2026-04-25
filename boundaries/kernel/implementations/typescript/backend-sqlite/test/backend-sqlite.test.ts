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
  deepStrictEqual,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { TuvrenPersistenceError } from "@tuvren/core-types";
import {
  encodeDeterministicKernelRecord,
  type RuntimeBackendTx as KrakenBackendTx,
} from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createHashFromIndex,
  createIncrementingClock as createNowClock,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
  delay,
  registerBackendConformanceSuite,
  registerBackendInvariantSuite,
  registerBackendRecoverySuite,
} from "@tuvren/kernel-testkit";
import Database from "better-sqlite3";
import { createSqliteBackend } from "../src/index.js";

const NESTED_TRANSACTION_ERROR_PATTERN = /must not be nested/u;
const MIGRATION_CONFLICT_ERROR_PATTERN = /table turn_trees already exists/u;
const MISSING_SCHEMA_ERROR_PATTERN =
  /applied migration without its required schema tables/u;
const MISSING_INDEX_ERROR_PATTERN =
  /applied migration without its required schema indexes/u;
const NON_PERSISTENT_DATABASE_ERROR_PATTERN =
  /requires a filesystem database path|non-empty filesystem database path/u;
const NORMALIZED_ENGINE_ERROR_PATTERN =
  /sqlite backend engine operation failed/u;
const NORMALIZED_STARTUP_ERROR_PATTERN =
  /sqlite backend engine operation failed|sqlite backend operation failed/u;
const NORMALIZED_SQLITE_ERROR_PATTERN =
  /required schema tables|missing schema tables/u;
const SCHEMA_MISMATCH_ERROR_PATTERN =
  /column contract does not match|foreign-key contract does not match/u;
const INDEX_MISMATCH_ERROR_PATTERN = /index whose definition does not match/u;
const UNKNOWN_MIGRATION_ERROR_PATTERN = /does not recognize/u;
const MULTIPLE_ACTIVE_RUNS_ERROR_PATTERN = /more than one active run/u;
const BACKWARD_ARCHIVE_ERROR_PATTERN = /archive branch/u;
const RUN_STATUS_ERROR_PATTERN = /valid run status/u;
const RUN_SHAPE_ERROR_PATTERN = /currentStepIndex/u;
const RUN_STAGED_RESULT_ERROR_PATTERN =
  /staged results may only exist for running runs|terminal or paused runs must not retain staged results/u;
const RUN_TURN_SPAN_ERROR_PATTERN = /referenced turn head|turn span/u;
const STAGED_RESULT_ROW_ERROR_PATTERN =
  /valid staged result status|interrupt_payload_cbor/u;
const TURN_TREE_PATH_ROW_ERROR_PATTERN = /valid ordered or single variant/u;
const LINEAGE_METADATA_ERROR_PATTERN = /lineage metadata/u;
const ORDERED_CARDINALITY_ERROR_PATTERN =
  /orderedCount aligned|item_count aligned|decoded item count/u;
const OBJECT_ROW_ERROR_PATTERN = /byteLength|SHA-256 digest/u;
const TURN_PARENT_ERROR_PATTERN = /chain contiguously/u;
const TURN_NODE_ROW_ERROR_PATTERN = /consumedStagedResultsCbor/u;
const THREAD_ROW_ERROR_PATTERN = /createdAtMs|epoch millisecond value/u;
const BRANCH_ROW_ERROR_PATTERN = /updatedAtMs/u;
const TURN_ROW_ERROR_PATTERN = /updatedAtMs/u;
const tempDirectories = new Set<string>();

function createTempDirectory(prefix = "kraken-sqlite-"): string {
  const tempDirectory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.add(tempDirectory);
  return tempDirectory;
}

function createTempDatabasePath(): string {
  const tempDirectory = createTempDirectory();
  return join(tempDirectory, "kraken.db");
}

function createWorkspaceTempDirectory(prefix: string): string {
  const tempDirectory = mkdtempSync(join(process.cwd(), prefix));
  tempDirectories.add(tempDirectory);
  return tempDirectory;
}

function linkWorkspaceNodeModules(targetDirectory: string): void {
  symlinkSync(
    resolve(process.cwd(), "../../../../../node_modules"),
    join(targetDirectory, "node_modules"),
    "dir"
  );
}

interface CorruptionSeed {
  databasePath: string;
  objectHash: string;
  rootTurnNodeHash: string;
  runId: string;
  runStartTurnNodeHash: string;
  turnTreeHash: string;
}

interface LineageMembershipCorruptionSeed extends CorruptionSeed {
  foreignBranchId: string;
  foreignThreadId: string;
}

interface ExplainQueryPlanRow {
  detail: string;
}

function getCompiledSqliteRuntimePath(): string {
  return join(
    process.cwd(),
    ".tmp-tests",
    "boundaries",
    "kernel",
    "implementations",
    "typescript",
    "backend-sqlite",
    "src",
    "lib",
    "sqlite-backend.js"
  );
}

function getBaselineMigrationSql(): string {
  return readFileSync(
    join(process.cwd(), "migrations", "0001_initial_schema.sql"),
    "utf8"
  );
}

function getTargetedValidationMigrationSql(): string {
  return readFileSync(
    join(process.cwd(), "migrations", "0002_targeted_validation_indexes.sql"),
    "utf8"
  );
}

function copyCurrentPackageMigrations(targetDirectory: string): void {
  const migrationsDirectory = join(process.cwd(), "migrations");
  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of migrationFiles) {
    copyFileSync(
      join(migrationsDirectory, fileName),
      join(targetDirectory, fileName)
    );
  }
}

function explainQueryPlanDetails(
  db: Database.Database,
  sql: string,
  parameters: readonly unknown[] = []
): string[] {
  return (
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...parameters) as ExplainQueryPlanRow[]
  ).map((row) => row.detail);
}

function assertPlanUsesIndex(
  db: Database.Database,
  sql: string,
  indexName: string,
  parameters: readonly unknown[] = []
): void {
  const details = explainQueryPlanDetails(db, sql, parameters);
  strictEqual(
    details.some((detail) => detail.includes(indexName)),
    true,
    details.join("\n")
  );
}

async function seedCorruptionDatabase(
  options: { messageCount?: number } = {}
): Promise<CorruptionSeed> {
  const databasePath = createTempDatabasePath();
  const backend = createSqliteBackend({ databasePath });
  const messageCount = options.messageCount ?? 0;
  const messages = Array.from({ length: messageCount }, (_, index) =>
    createHashFromIndex(index + 1)
  );
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, 1);
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    { "context.manifest": null, messages },
    2
  );
  const objectRecord = await createStoredObjectRecord(new Uint8Array([7]), 3);
  const rootTurnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 4,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const headTurnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 5,
    eventHash: null,
    previousTurnNodeHash: rootTurnNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread = {
    createdAtMs: 6,
    rootTurnNodeHash: rootTurnNode.hash,
    schemaId: schema.schemaId,
    threadId: "thread_corruption",
  };
  const branch = {
    branchId: "branch_corruption",
    createdAtMs: 7,
    headTurnNodeHash: headTurnNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 7,
  };
  const turn = {
    branchId: branch.branchId,
    createdAtMs: 8,
    headTurnNodeHash: headTurnNode.hash,
    parentTurnId: null,
    startTurnNodeHash: rootTurnNode.hash,
    threadId: thread.threadId,
    turnId: "turn_corruption",
    updatedAtMs: 8,
  };
  const run = {
    branchId: branch.branchId,
    createdAtMs: 9,
    createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
    currentStepIndex: 0,
    runId: "run_corruption",
    schemaId: schema.schemaId,
    startTurnNodeHash: headTurnNode.hash,
    status: "running" as const,
    stepSequenceCbor: encodeDeterministicKernelRecord([
      {
        deterministic: false,
        id: "model_call",
        sideEffects: false,
      },
    ]),
    turnId: turn.turnId,
    updatedAtMs: 9,
  };

  await backend.transact(async (tx) => {
    await tx.objects.put(objectRecord);
    await tx.schemas.put(schemaRecord);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, {
        "context.manifest": null,
        messages,
      })
    );
    await tx.turnNodes.put(rootTurnNode);
    await tx.turnNodes.put(headTurnNode);
    await tx.threads.put(thread);
    await tx.branches.set(branch);
    await tx.turns.set(turn);
    await tx.runs.set(run);
  });

  return {
    databasePath,
    objectHash: objectRecord.hash,
    rootTurnNodeHash: rootTurnNode.hash,
    runId: run.runId,
    runStartTurnNodeHash: run.startTurnNodeHash,
    turnTreeHash: turnTree.hash,
  };
}

async function seedLineageMembershipCorruptionDatabase(): Promise<LineageMembershipCorruptionSeed> {
  const seeded = await seedCorruptionDatabase();
  const backend = createSqliteBackend({ databasePath: seeded.databasePath });
  const schema = createCanonicalKernelTestSchema();
  const foreignTurnTree = await createStoredTurnTreeRecord(
    schema,
    {
      "context.manifest": null,
      messages: [createHashFromIndex(999)],
    },
    12
  );
  const foreignRootTurnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 13,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: "schema_main",
    turnTreeHash: foreignTurnTree.hash,
  });
  const foreignThreadId = "thread_lineage_membership";
  const foreignBranchId = "branch_lineage_membership";

  await backend.transact(async (tx) => {
    await tx.turnTrees.put(foreignTurnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(foreignTurnTree, {
        "context.manifest": null,
        messages: [createHashFromIndex(999)],
      })
    );
    await tx.turnNodes.put(foreignRootTurnNode);
    await tx.threads.put({
      createdAtMs: 14,
      rootTurnNodeHash: foreignRootTurnNode.hash,
      schemaId: "schema_main",
      threadId: foreignThreadId,
    });
    await tx.branches.set({
      branchId: foreignBranchId,
      createdAtMs: 15,
      headTurnNodeHash: foreignRootTurnNode.hash,
      threadId: foreignThreadId,
      updatedAtMs: 15,
    });
    await tx.turns.set({
      branchId: foreignBranchId,
      createdAtMs: 16,
      headTurnNodeHash: foreignRootTurnNode.hash,
      parentTurnId: null,
      startTurnNodeHash: foreignRootTurnNode.hash,
      threadId: foreignThreadId,
      turnId: "turn_lineage_membership",
      updatedAtMs: 16,
    });
  });

  const probe = new Database(seeded.databasePath);
  probe
    .prepare(
      `
        UPDATE turn_node_lineage_roots
        SET root_turn_node_hash = ?
        WHERE turn_node_hash = ?
      `
    )
    .run(foreignRootTurnNode.hash, seeded.runStartTurnNodeHash);
  probe.close();

  return {
    ...seeded,
    foreignBranchId,
    foreignThreadId,
  };
}

async function expectCorruptedStateRejection(
  databasePath: string,
  pattern: RegExp
): Promise<void> {
  const backend = createSqliteBackend({ databasePath });
  const health = await backend.health();
  deepStrictEqual(health.ok, false);
  if (health.ok) {
    throw new Error("expected unhealthy status");
  }
  strictEqual(pattern.test(health.reason), true);
}

after(() => {
  for (const tempDirectory of tempDirectories) {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

registerBackendConformanceSuite({
  createBackend: () =>
    createSqliteBackend({ databasePath: createTempDatabasePath() }),
  suiteName: "@tuvren/backend-sqlite shared conformance",
  testApi: { describe, test },
});

registerBackendInvariantSuite({
  createBackend: () =>
    createSqliteBackend({ databasePath: createTempDatabasePath() }),
  suiteName: "@tuvren/backend-sqlite shared invariants",
  testApi: { describe, test },
});

registerBackendRecoverySuite({
  createBackend: () =>
    createSqliteBackend({ databasePath: createTempDatabasePath() }),
  suiteName: "@tuvren/backend-sqlite shared recovery",
  testApi: { describe, test },
});

describe("@tuvren/backend-sqlite", () => {
  test("enables WAL mode and applies the baseline migration once", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({
      databasePath,
      now: createNowClock(10),
    });

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
    ]);
    deepStrictEqual(objectsTable, { name: "objects" });

    createSqliteBackend({ databasePath, now: createNowClock(20) });
    const secondProbe = new Database(databasePath, { readonly: true });
    const reappliedRows = secondProbe
      .prepare("SELECT name FROM backend_sqlite_migrations ORDER BY name")
      .all() as Array<{ name: string }>;
    secondProbe.close();

    deepStrictEqual(reappliedRows, [
      { name: "0001_initial_schema.sql" },
      { name: "0002_targeted_validation_indexes.sql" },
    ]);
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
    const objectsTable = probe
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'objects'"
      )
      .get() as { name: string } | undefined;
    probe.close();

    deepStrictEqual(migrationRows, [
      { name: "0001_initial_schema.sql" },
      { name: "0002_targeted_validation_indexes.sql" },
    ]);
    deepStrictEqual(objectsTable, { name: "objects" });
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

    const probe = new Database(databasePath, { readonly: true });
    const objectsTable = probe
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'objects'"
      )
      .get();
    const schemasTable = probe
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schemas'"
      )
      .get();
    const turnTreesTable = probe
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_trees'"
      )
      .get();
    const migrationRows = probe
      .prepare("SELECT name FROM backend_sqlite_migrations ORDER BY name")
      .all() as Array<{ name: string }>;
    probe.close();

    strictEqual(objectsTable, undefined);
    strictEqual(schemasTable, undefined);
    deepStrictEqual(turnTreesTable, { name: "turn_trees" });
    deepStrictEqual(migrationRows, []);
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
    copyFileSync(getCompiledSqliteRuntimePath(), runtimePath);
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
    copyFileSync(getCompiledSqliteRuntimePath(), runtimePath);
    copyCurrentPackageMigrations(fakeMigrationsDirectory);
    writeFileSync(
      join(fakeMigrationsDirectory, "0003_add_objects_extra.sql"),
      "ALTER TABLE objects ADD COLUMN extra TEXT;\n",
      "utf8"
    );

    const runtimeModule = (await import(pathToFileURL(runtimePath).href)) as {
      createSqliteBackend: typeof createSqliteBackend;
    };
    const backend = runtimeModule.createSqliteBackend({ databasePath });

    deepStrictEqual(await backend.health(), { ok: true });

    const probe = new Database(databasePath, { readonly: true });
    const objectColumns = probe
      .prepare("PRAGMA table_info(objects)")
      .all() as Array<{ name: string }>;
    const migrationRows = probe
      .prepare("SELECT name FROM backend_sqlite_migrations ORDER BY name")
      .all() as Array<{ name: string }>;
    probe.close();

    deepStrictEqual(
      objectColumns.some((column) => column.name === "extra"),
      true
    );
    deepStrictEqual(migrationRows, [
      { name: "0001_initial_schema.sql" },
      { name: "0002_targeted_validation_indexes.sql" },
      { name: "0003_add_objects_extra.sql" },
    ]);
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
    copyFileSync(getCompiledSqliteRuntimePath(), runtimePath);
    copyCurrentPackageMigrations(fakeMigrationsDirectory);
    writeFileSync(
      join(fakeMigrationsDirectory, "0003_rebuild_runs_index.sql"),
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

    const probe = new Database(databasePath, { readonly: true });
    const indexColumns = probe
      .prepare("PRAGMA index_info(idx_runs_branch_id_status)")
      .all() as Array<{ name: string }>;
    probe.close();

    deepStrictEqual(
      indexColumns.map((column) => column.name),
      ["branch_id", "status", "updated_at_ms"]
    );
  });

  test("reports unhealthy status when committed-state invariants are broken", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
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
        `
      )
      .run(
        "run_duplicate_active",
        "turn_corruption",
        "branch_corruption",
        "schema_main",
        seeded.runStartTurnNodeHash,
        "running",
        0,
        Buffer.from(
          encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "model_call",
              sideEffects: false,
            },
          ])
        ),
        Buffer.from(encodeDeterministicKernelRecord([])),
        10,
        10
      );
    probe.close();

    const health = await backend.health();
    deepStrictEqual(health.ok, false);
    if (health.ok) {
      throw new Error("expected unhealthy status");
    }
    strictEqual(MULTIPLE_ACTIVE_RUNS_ERROR_PATTERN.test(health.reason), true);
  });

  test("keeps invariant-broken persisted state out of the transaction hot path", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
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
        `
      )
      .run(
        "run_duplicate_preflight",
        "turn_corruption",
        "branch_corruption",
        "schema_main",
        seeded.runStartTurnNodeHash,
        "running",
        0,
        Buffer.from(
          encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "model_call",
              sideEffects: false,
            },
          ])
        ),
        Buffer.from(encodeDeterministicKernelRecord([])),
        10,
        10
      );
    probe.close();

    let callbackRan = false;
    await backend.transact(() => {
      callbackRan = true;
      return Promise.resolve(undefined);
    });
    strictEqual(callbackRan, true);

    const health = await backend.health();
    deepStrictEqual(health.ok, false);
    if (health.ok) {
      throw new Error("expected unhealthy status");
    }
    strictEqual(MULTIPLE_ACTIVE_RUNS_ERROR_PATTERN.test(health.reason), true);
  });

  test("rejects run status updates that leave staged results attached", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });

    await backend.transact(async (tx) => {
      await tx.stagedResults.set({
        createdAtMs: 10,
        objectHash: seeded.objectHash,
        objectType: "message",
        runId: seeded.runId,
        status: "completed",
        taskId: "staged_before_pause",
      });
    });

    await rejects(
      backend.transact(async (tx) => {
        const run = await tx.runs.get(seeded.runId);

        if (run === null) {
          throw new Error("expected seeded run");
        }

        await tx.runs.set({
          ...run,
          status: "failed",
          updatedAtMs: 11,
        });
      }),
      RUN_STAGED_RESULT_ERROR_PATTERN
    );

    deepStrictEqual(await backend.health(), { ok: true });
  });

  test("rejects turn head rewrites that break child turn parent links", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const childTurnNode = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 12,
      eventHash: null,
      previousTurnNodeHash: seeded.runStartTurnNodeHash,
      schemaId: "schema_main",
      turnTreeHash: seeded.turnTreeHash,
    });

    await backend.transact(async (tx) => {
      const run = await tx.runs.get(seeded.runId);

      if (run === null) {
        throw new Error("expected seeded run");
      }

      await tx.runs.set({
        ...run,
        status: "failed",
        updatedAtMs: 10,
      });
      await tx.turnNodes.put(childTurnNode);
      await tx.turns.set({
        branchId: "branch_corruption",
        createdAtMs: 12,
        headTurnNodeHash: childTurnNode.hash,
        parentTurnId: "turn_corruption",
        startTurnNodeHash: seeded.runStartTurnNodeHash,
        threadId: "thread_corruption",
        turnId: "turn_child_corruption",
        updatedAtMs: 12,
      });
      await tx.branches.set({
        branchId: "branch_corruption",
        createdAtMs: 7,
        headTurnNodeHash: childTurnNode.hash,
        threadId: "thread_corruption",
        updatedAtMs: 12,
      });
    });

    await rejects(
      backend.transact(async (tx) => {
        const parentTurn = await tx.turns.get("turn_corruption");

        if (parentTurn === null) {
          throw new Error("expected parent turn");
        }

        await tx.turns.set({
          ...parentTurn,
          headTurnNodeHash: seeded.rootTurnNodeHash,
          updatedAtMs: 13,
        });
      }),
      TURN_PARENT_ERROR_PATTERN
    );

    deepStrictEqual(await backend.health(), { ok: true });
  });

  test("rejects turn head rewrites that break terminal run spans", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });

    await backend.transact(async (tx) => {
      const run = await tx.runs.get(seeded.runId);

      if (run === null) {
        throw new Error("expected seeded run");
      }

      await tx.runs.set({
        ...run,
        status: "failed",
        updatedAtMs: 10,
      });
    });

    await rejects(
      backend.transact(async (tx) => {
        const turn = await tx.turns.get("turn_corruption");

        if (turn === null) {
          throw new Error("expected seeded turn");
        }

        await tx.turns.set({
          ...turn,
          headTurnNodeHash: seeded.rootTurnNodeHash,
          updatedAtMs: 11,
        });
      }),
      RUN_TURN_SPAN_ERROR_PATTERN
    );

    deepStrictEqual(await backend.health(), { ok: true });
  });

  test("requires a new archive branch for every rollback transaction", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });

    await backend.transact(async (tx) => {
      const run = await tx.runs.get(seeded.runId);

      if (run === null) {
        throw new Error("expected seeded run");
      }

      await tx.runs.set({
        ...run,
        status: "failed",
        updatedAtMs: 10,
      });
      await tx.branches.set({
        archivedFromBranchId: "branch_corruption",
        branchId: "branch_corruption_archive_1",
        createdAtMs: 10,
        headTurnNodeHash: seeded.runStartTurnNodeHash,
        threadId: "thread_corruption",
        updatedAtMs: 10,
      });
      await tx.branches.set({
        branchId: "branch_corruption",
        createdAtMs: 7,
        headTurnNodeHash: seeded.rootTurnNodeHash,
        threadId: "thread_corruption",
        updatedAtMs: 10,
      });
    });

    await backend.transact(async (tx) => {
      await tx.branches.set({
        branchId: "branch_corruption",
        createdAtMs: 7,
        headTurnNodeHash: seeded.runStartTurnNodeHash,
        threadId: "thread_corruption",
        updatedAtMs: 11,
      });
    });

    await rejects(
      backend.transact(async (tx) => {
        await tx.branches.set({
          branchId: "branch_corruption",
          createdAtMs: 7,
          headTurnNodeHash: seeded.rootTurnNodeHash,
          threadId: "thread_corruption",
          updatedAtMs: 12,
        });
      }),
      BACKWARD_ARCHIVE_ERROR_PATTERN
    );

    deepStrictEqual(await backend.health(), { ok: true });
  });

  test("keeps missing-run staged result clears idempotent", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });

    await backend.transact(async (tx) => {
      await tx.stagedResults.clearRun("missing_run");
    });

    deepStrictEqual(await backend.health(), { ok: true });
  });

  test("rejects appending turn nodes from stale lineage metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const childTurnNode = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 12,
      eventHash: null,
      previousTurnNodeHash: seeded.runStartTurnNodeHash,
      schemaId: "schema_main",
      turnTreeHash: seeded.turnTreeHash,
    });
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          UPDATE turn_node_lineage_roots
          SET root_turn_node_hash = turn_node_hash,
              depth = 0
          WHERE turn_node_hash = ?
        `
      )
      .run(seeded.runStartTurnNodeHash);
    probe.close();

    await rejects(
      backend.transact(async (tx) => {
        await tx.turnNodes.put(childTurnNode);
      }),
      LINEAGE_METADATA_ERROR_PATTERN
    );

    const readonlyProbe = new Database(seeded.databasePath, { readonly: true });
    try {
      strictEqual(
        readonlyProbe
          .prepare("SELECT 1 FROM turn_nodes WHERE hash = ?")
          .get(childTurnNode.hash),
        undefined
      );
      strictEqual(
        readonlyProbe
          .prepare(
            "SELECT 1 FROM turn_node_lineage_roots WHERE turn_node_hash = ?"
          )
          .get(childTurnNode.hash),
        undefined
      );
    } finally {
      readonlyProbe.close();
    }
  });

  test("rejects existing-node thread membership checks backed by stale lineage metadata", async () => {
    const seeded = await seedLineageMembershipCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });

    await rejects(
      backend.transact(async (tx) => {
        await tx.branches.set({
          branchId: "branch_stale_lineage_membership",
          createdAtMs: 20,
          headTurnNodeHash: seeded.runStartTurnNodeHash,
          threadId: seeded.foreignThreadId,
          updatedAtMs: 20,
        });
      }),
      LINEAGE_METADATA_ERROR_PATTERN
    );

    await rejects(
      backend.transact(async (tx) => {
        await tx.turns.set({
          branchId: seeded.foreignBranchId,
          createdAtMs: 21,
          headTurnNodeHash: seeded.runStartTurnNodeHash,
          parentTurnId: null,
          startTurnNodeHash: seeded.runStartTurnNodeHash,
          threadId: seeded.foreignThreadId,
          turnId: "turn_stale_lineage_membership",
          updatedAtMs: 21,
        });
      }),
      LINEAGE_METADATA_ERROR_PATTERN
    );

    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
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
        `
      )
      .run(
        "turn_stale_lineage_membership_seed",
        seeded.foreignThreadId,
        seeded.foreignBranchId,
        null,
        seeded.runStartTurnNodeHash,
        seeded.runStartTurnNodeHash,
        22,
        22
      );
    probe
      .prepare(
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
        `
      )
      .run(
        "run_stale_lineage_membership",
        "turn_stale_lineage_membership_seed",
        seeded.foreignBranchId,
        "schema_main",
        seeded.runStartTurnNodeHash,
        "running",
        0,
        Buffer.from(
          encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "model_call",
              sideEffects: false,
            },
          ])
        ),
        Buffer.from(encodeDeterministicKernelRecord([])),
        23,
        23
      );
    probe.close();

    await rejects(
      backend.transact(async (tx) => {
        await tx.runs.set({
          branchId: seeded.foreignBranchId,
          createdAtMs: 23,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
          currentStepIndex: 1,
          runId: "run_stale_lineage_membership",
          schemaId: "schema_main",
          startTurnNodeHash: seeded.runStartTurnNodeHash,
          status: "completed",
          stepSequenceCbor: encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "model_call",
              sideEffects: false,
            },
          ]),
          turnId: "turn_stale_lineage_membership_seed",
          updatedAtMs: 24,
        });
      }),
      LINEAGE_METADATA_ERROR_PATTERN
    );

    const readonlyProbe = new Database(seeded.databasePath, { readonly: true });
    try {
      strictEqual(
        readonlyProbe
          .prepare("SELECT 1 FROM branches WHERE branch_id = ?")
          .get("branch_stale_lineage_membership"),
        undefined
      );
      strictEqual(
        readonlyProbe
          .prepare("SELECT 1 FROM turns WHERE turn_id = ?")
          .get("turn_stale_lineage_membership"),
        undefined
      );
      deepStrictEqual(
        readonlyProbe
          .prepare("SELECT status FROM runs WHERE run_id = ?")
          .get("run_stale_lineage_membership"),
        { status: "running" }
      );
    } finally {
      readonlyProbe.close();
    }
  });

  test("reports unhealthy status when required schema tables are missing", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });
    const probe = new Database(databasePath);
    probe.exec("DROP TABLE objects");
    probe.close();

    const health = await backend.health();
    deepStrictEqual(health.ok, false);
    if (health.ok) {
      throw new Error("expected unhealthy status");
    }
    strictEqual(MISSING_SCHEMA_ERROR_PATTERN.test(health.reason), true);
  });

  test("leaves committed corruption detection on the explicit health path", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE objects SET hash = ? WHERE hash = ?")
      .run(createHashFromIndex(999), seeded.objectHash);
    probe.close();

    let callbackRan = false;
    await backend.transact(() => {
      callbackRan = true;
      return Promise.resolve(undefined);
    });
    strictEqual(callbackRan, true);

    const health = await backend.health();
    deepStrictEqual(health.ok, false);
    if (health.ok) {
      throw new Error("expected unhealthy status");
    }
    strictEqual(OBJECT_ROW_ERROR_PATTERN.test(health.reason), true);
  });

  test("reports missing tables through health instead of transaction preflight", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });
    const probe = new Database(databasePath);
    probe.exec("DROP TABLE objects");
    probe.close();

    await backend.transact(async () => undefined);

    const health = await backend.health();
    deepStrictEqual(health.ok, false);
    if (health.ok) {
      throw new Error("expected unhealthy status");
    }
    strictEqual(NORMALIZED_SQLITE_ERROR_PATTERN.test(health.reason), true);
  });

  test("normalizes SQLite engine write failures into backend persistence errors", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });
    const probe = new Database(databasePath);
    probe.exec(`
      CREATE TRIGGER objects_block_insert
      BEFORE INSERT ON objects
      BEGIN
        SELECT RAISE(FAIL, 'blocked');
      END;
    `);
    probe.close();
    const objectRecord = await createStoredObjectRecord(new Uint8Array([9]), 1);

    await rejects(
      backend.transact(async (tx) => {
        await tx.objects.put(objectRecord);
      }),
      NORMALIZED_ENGINE_ERROR_PATTERN
    );
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

  test("rejects databases whose baseline table definitions no longer match the package schema", async () => {
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
    const duplicateObject = await createStoredObjectRecord(
      new Uint8Array([1]),
      1
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
    seed
      .prepare(
        `
          INSERT INTO objects (
            hash,
            media_type,
            bytes,
            byte_length,
            created_at_ms
          ) VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(
        duplicateObject.hash,
        duplicateObject.mediaType,
        Buffer.from(duplicateObject.bytes),
        duplicateObject.byteLength,
        duplicateObject.createdAtMs
      );
    seed
      .prepare(
        `
          INSERT INTO objects (
            hash,
            media_type,
            bytes,
            byte_length,
            created_at_ms
          ) VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(
        duplicateObject.hash,
        duplicateObject.mediaType,
        Buffer.from(duplicateObject.bytes),
        duplicateObject.byteLength,
        duplicateObject.createdAtMs
      );
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

  test("rejects databases that are missing baseline indexes", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const probe = new Database(seeded.databasePath);
    probe.exec("DROP INDEX idx_runs_branch_id_status");
    probe.close();

    throws(
      () => createSqliteBackend({ databasePath: seeded.databasePath }),
      MISSING_INDEX_ERROR_PATTERN
    );

    const health = await backend.health();
    deepStrictEqual(health.ok, false);
    if (health.ok) {
      throw new Error("expected unhealthy status");
    }
    strictEqual(MISSING_INDEX_ERROR_PATTERN.test(health.reason), true);
  });

  test("uses targeted indexes for localized validation query plans", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath, { readonly: true });

    try {
      assertPlanUsesIndex(
        probe,
        `
          SELECT turn_node_hash
          FROM turn_node_lineage_roots
          WHERE root_turn_node_hash = ? AND depth >= ?
        `,
        "idx_turn_node_lineage_roots_root_depth",
        [seeded.runStartTurnNodeHash, 0]
      );
      assertPlanUsesIndex(
        probe,
        `
          SELECT *
          FROM runs
          WHERE branch_id = ? AND status IN ('running', 'paused')
          ORDER BY created_at_ms, run_id
        `,
        "idx_runs_branch_id_status",
        ["branch_corruption"]
      );
      assertPlanUsesIndex(
        probe,
        `
          SELECT *
          FROM branches
          WHERE archived_from_branch_id = ?
            AND branch_id <> ?
            AND head_turn_node_hash = ?
          LIMIT 1
        `,
        "idx_branches_archived_from_branch_id",
        ["branch_corruption", "branch_corruption", seeded.runStartTurnNodeHash]
      );
      assertPlanUsesIndex(
        probe,
        `
          SELECT *
          FROM turns
          WHERE thread_id = ?
            AND branch_id = ?
            AND head_turn_node_hash = ?
            AND turn_id <> ?
          ORDER BY created_at_ms, turn_id
        `,
        "idx_turns_thread_branch_head_turn_node",
        [
          "thread_corruption",
          "branch_corruption",
          seeded.runStartTurnNodeHash,
          "turn_corruption",
        ]
      );
    } finally {
      probe.close();
    }
  });

  test("rejects stored run rows with invalid status values", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE runs SET status = 'bogus' WHERE run_id = ?")
      .run(seeded.runId);
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      RUN_STATUS_ERROR_PATTERN
    );
  });

  test("rejects stored object rows with invalid byteLength metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE objects SET byte_length = 999 WHERE hash = ?")
      .run(seeded.objectHash);
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      OBJECT_ROW_ERROR_PATTERN
    );
  });

  test("rejects stored object rows whose hash no longer matches bytes", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE objects SET hash = ? WHERE hash = ?")
      .run(createHashFromIndex(999), seeded.objectHash);
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      OBJECT_ROW_ERROR_PATTERN
    );
  });

  test("rejects stored run rows with invalid currentStepIndex metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE runs SET current_step_index = -1 WHERE run_id = ?")
      .run(seeded.runId);
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      RUN_SHAPE_ERROR_PATTERN
    );
  });

  test("rejects stored staged result rows with interrupted status and null payload", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
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
      )
      .run(
        seeded.runId,
        "task_corrupted",
        seeded.objectHash,
        "message",
        "interrupted",
        null,
        10
      );
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      STAGED_RESULT_ROW_ERROR_PATTERN
    );
  });

  test("rejects stored turn node rows with malformed consumed staged results payloads", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        "UPDATE turn_nodes SET consumed_staged_results_cbor = ? WHERE hash = ?"
      )
      .run(
        Buffer.from(
          encodeDeterministicKernelRecord([{ objectHash: seeded.objectHash }])
        ),
        seeded.runStartTurnNodeHash
      );
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      TURN_NODE_ROW_ERROR_PATTERN
    );
  });

  test("rejects corrupted turn node lineage metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          UPDATE turn_node_lineage_roots
          SET depth = depth + 1
          WHERE turn_node_hash = ?
        `
      )
      .run(seeded.runStartTurnNodeHash);
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      LINEAGE_METADATA_ERROR_PATTERN
    );
  });

  test("rejects stored thread rows with invalid createdAtMs metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE threads SET created_at_ms = 1.5 WHERE thread_id = ?")
      .run("thread_corruption");
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      THREAD_ROW_ERROR_PATTERN
    );
  });

  test("rejects stored branch rows with regressed updatedAtMs metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        "UPDATE branches SET updated_at_ms = created_at_ms - 1 WHERE branch_id = ?"
      )
      .run("branch_corruption");
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      BRANCH_ROW_ERROR_PATTERN
    );
  });

  test("rejects stored turn rows with regressed updatedAtMs metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        "UPDATE turns SET updated_at_ms = created_at_ms - 1 WHERE turn_id = ?"
      )
      .run("turn_corruption");
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      TURN_ROW_ERROR_PATTERN
    );
  });

  test("rejects ordered turn tree rows with invalid collection kind", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          UPDATE turn_tree_paths
          SET collection_kind = 'bogus'
          WHERE turn_tree_hash = ? AND path = 'messages'
        `
      )
      .run(seeded.turnTreeHash);
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      TURN_TREE_PATH_ROW_ERROR_PATTERN
    );
  });

  test("rejects corrupted orderedCount metadata on persisted path rows", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          UPDATE turn_tree_paths
          SET ordered_count = 999
          WHERE turn_tree_hash = ? AND path = 'messages'
        `
      )
      .run(seeded.turnTreeHash);
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      ORDERED_CARDINALITY_ERROR_PATTERN
    );
  });

  test("rejects corrupted chunk item_count metadata on persisted chunk rows", async () => {
    const seeded = await seedCorruptionDatabase({ messageCount: 40 });
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          UPDATE ordered_path_chunks
          SET item_count = item_count + 1
          WHERE chunk_hash = (
            SELECT chunk_hash
            FROM ordered_path_chunks
            ORDER BY chunk_hash
            LIMIT 1
          )
        `
      )
      .run();
    probe.close();

    await expectCorruptedStateRejection(
      seeded.databasePath,
      ORDERED_CARDINALITY_ERROR_PATTERN
    );
  });

  test("serializes concurrent transactions and rejects nested transactions", async () => {
    const backend = createSqliteBackend({
      databasePath: createTempDatabasePath(),
    });
    const order: string[] = [];

    const firstTransaction = backend.transact(async () => {
      order.push("first:start");
      await delay(20);
      order.push("first:end");
    });
    const secondTransaction = backend.transact(() => {
      order.push("second:start");
      order.push("second:end");
      return Promise.resolve();
    });

    await Promise.all([firstTransaction, secondTransaction]);
    deepStrictEqual(order, [
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);

    await rejects(
      backend.transact(async () => {
        await backend.transact(async () => undefined);
      }),
      NESTED_TRANSACTION_ERROR_PATTERN
    );
  });

  test("rejects repository handle use after the transaction ends", async () => {
    const backend = createSqliteBackend({
      databasePath: createTempDatabasePath(),
    });
    const escapedTransactions: KrakenBackendTx[] = [];

    await backend.transact((tx) => {
      escapedTransactions.push(tx);
      return Promise.resolve();
    });

    const txHandle = escapedTransactions[0];
    if (txHandle === undefined) {
      throw new Error("expected escaped transaction handle");
    }

    await rejects(
      async () => txHandle.objects.has("0".repeat(64)),
      TuvrenPersistenceError
    );
  });
});
