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

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createCanonicalKernelTestSchema,
  createStoredSchemaRecord,
} from "@tuvren/kernel-testkit";
import Database from "better-sqlite3";
import { createSqliteBackend } from "../src/index.js";
import { createTempDatabasePath } from "./backend-sqlite-test-helpers.js";

/**
 * KRT-BK011: backend-specific storage test uplift.
 *
 * `SqliteBackend.transact` (sqlite-backend.ts) issues a real, file-level
 * `db.exec("BEGIN IMMEDIATE")` before invoking `work`, which genuinely
 * acquires SQLite's write lock on the underlying WAL-mode database file for
 * the duration of the transaction -- this is a property of SQLite's
 * single-connection-per-file locking model, not something the shared
 * cross-backend testkit can express (it asserts uniform semantics across all
 * three backends).
 *
 * `backend-sqlite.startup.test.ts` already proves WAL mode is *enabled*
 * (`journal_mode = wal`); it does not exercise the resulting locking
 * behavior. These tests go further: they prove a second, independent raw
 * `better-sqlite3` connection against the *same* file is genuinely blocked by
 * SQLite's engine-level lock while a `transact()` call holds `BEGIN IMMEDIATE`
 * open, and that the lock is durably released on commit/rollback rather than
 * left stuck -- including across a fresh same-process reopen of the database
 * file, which is what proves the rollback was written to disk and not merely
 * rolled back in one instance's in-memory view.
 *
 * Out of scope (per the ticket's STOP condition and its own precedent in this
 * directory): simulating an actual process-crash mid-write. That is a
 * different epic's territory; this is about a *clean* same-process reopen
 * after a normal, in-process rollback.
 */

describe("@tuvren/backend-sqlite WAL locking (KRT-BK011)", () => {
  test("a concurrent raw-connection write is blocked by SQLITE_BUSY while transact() holds BEGIN IMMEDIATE open, and succeeds once it commits", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });

    // Confirm the backend is fully started (migrations applied) before probing
    // it, so migration DDL never competes with the probe for the write lock.
    deepStrictEqual(await backend.health(), { ok: true });

    // A scratch table for the probe's write attempts. Created before the held
    // -open transaction below starts, so its own DDL never contends with it.
    // `validateMigrationState` only checks for the presence of migration-owned
    // tables/columns/indexes, so this extra table does not affect subsequent
    // validation.
    const setupConnection = new Database(databasePath);
    setupConnection.exec(
      "CREATE TABLE krt_bk011_wal_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)"
    );
    setupConnection.close();

    let markWorkStarted: () => void = () => undefined;
    const workStarted = new Promise<void>((resolve) => {
      markWorkStarted = resolve;
    });
    let releaseWork: () => void = () => undefined;
    const workHeld = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });

    // By the time `work` starts executing, `SqliteBackend.transact` has
    // already run `BEGIN IMMEDIATE` (it executes before `work` is invoked), so
    // the write lock is genuinely held the instant this callback body starts.
    const transactPromise = backend.transact(async () => {
      markWorkStarted();
      await workHeld;
    });

    await workStarted;

    // While the transaction is held open, a second, independent connection's
    // write attempt must fail fast with a SQLITE_BUSY-class error rather than
    // hang -- a low busy_timeout makes this deterministic instead of racing an
    // indefinite block.
    const probe = new Database(databasePath);
    probe.pragma("busy_timeout = 50");

    let busyError: (Error & { code?: string }) | undefined;
    try {
      probe
        .prepare("INSERT INTO krt_bk011_wal_probe (id, value) VALUES (1, 1)")
        .run();
    } catch (error) {
      busyError = error as Error & { code?: string };
    }

    ok(
      busyError !== undefined,
      "expected the concurrent raw-connection write to be blocked while transact() holds BEGIN IMMEDIATE open"
    );
    ok(
      (busyError?.code ?? "").startsWith("SQLITE_BUSY"),
      `expected a SQLITE_BUSY-class error code, received "${busyError?.code}"`
    );

    // Release the held-open transaction and let it commit.
    releaseWork();
    await transactPromise;

    // The lock was genuinely released, not left stuck: the same raw connection
    // can now write successfully.
    probe
      .prepare("INSERT INTO krt_bk011_wal_probe (id, value) VALUES (1, 1)")
      .run();
    const row = probe
      .prepare("SELECT value FROM krt_bk011_wal_probe WHERE id = 1")
      .get();
    deepStrictEqual(row, { value: 1 });

    probe.close();
    await backend.close();
  });

  test("a same-process reopen after an aborted transact() sees the rollback durably, not a partially-applied write", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });

    const schema = createCanonicalKernelTestSchema();
    const schemaRecord = createStoredSchemaRecord(schema, 1);

    await rejects(
      backend.transact(async (tx) => {
        // A real write that must be rolled back once the callback throws.
        await tx.schemas.put(schemaRecord);
        throw new Error(
          "deliberately aborted for the KRT-BK011 same-process reopen test"
        );
      })
    );

    // (i) The same instance's own subsequent read must not observe the
    // aborted write, and the instance itself must remain healthy.
    deepStrictEqual(await backend.health(), { ok: true });
    const seenBySameInstance = await backend.transact((tx) =>
      tx.schemas.get(schema.schemaId)
    );
    strictEqual(seenBySameInstance, null);

    await backend.close();

    // (ii) A brand-new `SqliteBackend` instance reopening the same file must
    // also see the consistent, rolled-back state -- proving the rollback was
    // durably written to the file itself, not just rolled back in the
    // now-closed instance's in-memory view.
    const reopened = createSqliteBackend({ databasePath });
    deepStrictEqual(await reopened.health(), { ok: true });
    const seenByReopenedInstance = await reopened.transact((tx) =>
      tx.schemas.get(schema.schemaId)
    );
    strictEqual(seenByReopenedInstance, null);

    // A normal write on the reopened instance still succeeds and is durable.
    await reopened.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
    });
    const committedAfterReopen = await reopened.transact((tx) =>
      tx.schemas.get(schema.schemaId)
    );
    deepStrictEqual(committedAfterReopen, schemaRecord);

    await reopened.close();
  });
});
