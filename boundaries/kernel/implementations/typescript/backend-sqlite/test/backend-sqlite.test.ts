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
  type KrakenBackendTx,
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
const UNKNOWN_MIGRATION_ERROR_PATTERN = /does not recognize/u;
const MULTIPLE_ACTIVE_RUNS_ERROR_PATTERN = /more than one active run/u;
const RUN_STATUS_ERROR_PATTERN = /valid run status/u;
const RUN_SHAPE_ERROR_PATTERN = /currentStepIndex/u;
const STAGED_RESULT_ROW_ERROR_PATTERN =
  /valid staged result status|interrupt_payload_cbor/u;
const TURN_TREE_PATH_ROW_ERROR_PATTERN = /valid ordered or single variant/u;
const ORDERED_CARDINALITY_ERROR_PATTERN =
  /orderedCount aligned|item_count aligned|decoded item count/u;
const OBJECT_ROW_ERROR_PATTERN = /byteLength|SHA-256 digest/u;
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
  runId: string;
  runStartTurnNodeHash: string;
  turnTreeHash: string;
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
    runId: run.runId,
    runStartTurnNodeHash: run.startTurnNodeHash,
    turnTreeHash: turnTree.hash,
  };
}

async function expectCorruptedStateRejection(
  databasePath: string,
  pattern: RegExp
): Promise<void> {
  const backend = createSqliteBackend({ databasePath });
  await rejects(
    backend.transact(async () => undefined),
    pattern
  );
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
    deepStrictEqual(migrationRows, [{ name: "0001_initial_schema.sql" }]);
    deepStrictEqual(objectsTable, { name: "objects" });

    createSqliteBackend({ databasePath, now: createNowClock(20) });
    const secondProbe = new Database(databasePath, { readonly: true });
    const reappliedRows = secondProbe
      .prepare("SELECT name FROM backend_sqlite_migrations ORDER BY name")
      .all() as Array<{ name: string }>;
    secondProbe.close();

    deepStrictEqual(reappliedRows, [{ name: "0001_initial_schema.sql" }]);
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

    deepStrictEqual(migrationRows, [{ name: "0001_initial_schema.sql" }]);
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
    copyFileSync(
      join(process.cwd(), "migrations", "0001_initial_schema.sql"),
      join(fakeMigrationsDirectory, "0001_initial_schema.sql")
    );

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
    copyFileSync(
      join(process.cwd(), "migrations", "0001_initial_schema.sql"),
      join(fakeMigrationsDirectory, "0001_initial_schema.sql")
    );
    writeFileSync(
      join(fakeMigrationsDirectory, "0002_add_objects_extra.sql"),
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
      { name: "0002_add_objects_extra.sql" },
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
    copyFileSync(
      join(process.cwd(), "migrations", "0001_initial_schema.sql"),
      join(fakeMigrationsDirectory, "0001_initial_schema.sql")
    );
    writeFileSync(
      join(fakeMigrationsDirectory, "0002_rebuild_runs_index.sql"),
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

  test("rejects invariant-broken persisted state before running the user callback", async () => {
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
    await rejects(
      backend.transact(() => {
        callbackRan = true;
        return Promise.resolve(undefined);
      }),
      MULTIPLE_ACTIVE_RUNS_ERROR_PATTERN
    );
    strictEqual(callbackRan, false);
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

  test("rolls back and normalizes preflight failures before the user callback runs", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE objects SET hash = ? WHERE hash = ?")
      .run(createHashFromIndex(999), seeded.objectHash);
    probe.close();

    await rejects(
      backend.transact(async () => undefined),
      OBJECT_ROW_ERROR_PATTERN
    );

    await rejects(
      backend.transact(async () => undefined),
      OBJECT_ROW_ERROR_PATTERN
    );
  });

  test("normalizes missing-table preflight failures into backend errors", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });
    const probe = new Database(databasePath);
    probe.exec("DROP TABLE objects");
    probe.close();

    await rejects(
      backend.transact(async () => undefined),
      NORMALIZED_SQLITE_ERROR_PATTERN
    );
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
