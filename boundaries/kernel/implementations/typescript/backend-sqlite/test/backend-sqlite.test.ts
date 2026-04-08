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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { KrakenBackendTx } from "@kraken/kernel-contract-protocol";
import {
  createIncrementingClock as createNowClock,
  delay,
  registerBackendConformanceSuite,
  registerBackendInvariantSuite,
  registerBackendRecoverySuite,
} from "@kraken/kernel-testkit";
import { KrakenPersistenceError } from "@kraken/shared-core-types";
import Database from "better-sqlite3";
import { createSqliteBackend } from "../src/index.js";

const NESTED_TRANSACTION_ERROR_PATTERN = /must not be nested/u;
const MIGRATION_CONFLICT_ERROR_PATTERN = /table turn_trees already exists/u;
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

after(() => {
  for (const tempDirectory of tempDirectories) {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

registerBackendConformanceSuite({
  createBackend: () =>
    createSqliteBackend({ databasePath: createTempDatabasePath() }),
  suiteName: "@kraken/backend-sqlite shared conformance",
  testApi: { describe, test },
});

registerBackendInvariantSuite({
  createBackend: () =>
    createSqliteBackend({ databasePath: createTempDatabasePath() }),
  suiteName: "@kraken/backend-sqlite shared invariants",
  testApi: { describe, test },
});

registerBackendRecoverySuite({
  createBackend: () =>
    createSqliteBackend({ databasePath: createTempDatabasePath() }),
  suiteName: "@kraken/backend-sqlite shared recovery",
  testApi: { describe, test },
});

describe("@kraken/backend-sqlite", () => {
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
      KrakenPersistenceError
    );
  });
});
