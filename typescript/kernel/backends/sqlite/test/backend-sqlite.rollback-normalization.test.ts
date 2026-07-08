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
import { TuvrenPersistenceError, TuvrenValidationError } from "@tuvren/core";
import {
  createCanonicalKernelTestSchema,
  createStoredObjectRecord,
  createStoredSchemaRecord,
} from "@tuvren/kernel-testkit";
import Database from "better-sqlite3";
import { createSqliteBackend } from "../src/index.js";
import { normalizeBackendError } from "../src/lib/sqlite-errors.js";
import {
  createTempDatabasePath,
  NORMALIZED_ENGINE_ERROR_PATTERN,
} from "./backend-sqlite-test-helpers.js";

/**
 * KRT-BK009: `SqliteBackend.transact` used to run a nested try/catch, with an
 * inner catch normalizing a rollback error and rethrowing it, and an outer
 * catch normalizing that already-normalized error again. `normalizeBackendError`
 * is idempotent (a `TuvrenPersistenceError`/`TuvrenValidationError` input is
 * returned unchanged), so the double call never actually produced a different
 * observable shape -- but the structure was still double-normalization debt.
 *
 * The tests in this file verify the *shape* of the normalized error and its
 * `cause` chain: (a) direct property coverage of `normalizeBackendError`'s
 * idempotency for every input kind it distinguishes, and (b) an end-to-end
 * `transact` rollback whose resulting error has the expected message, code,
 * and cause. Because `normalizeBackendError` is idempotent, these shape
 * assertions hold identically whether the rollback path normalizes once or
 * twice -- they cannot by themselves distinguish single- from
 * double-normalization. The structural single-normalization invariant (that
 * `normalizeBackendError` is invoked exactly once on the rollback path) is
 * pinned separately, by a call-count spy, in
 * `backend-sqlite.rollback-normalization-guard.test.ts`.
 */

const ROLLBACK_TRIGGER_MESSAGE_PATTERN =
  /blocked by rollback-normalization test/u;

interface ShapeableError {
  cause?: unknown;
  code?: string;
  message: string;
}

function shapeOf(error: ShapeableError): {
  cause: unknown;
  code: string | undefined;
  message: string;
} {
  return { cause: error.cause, code: error.code, message: error.message };
}

describe("@tuvren/backend-sqlite normalizeBackendError idempotency (KRT-BK009)", () => {
  test("is idempotent for a raw SQLITE_-coded engine error", () => {
    const raw = new Error("no such table: turn_trees") as Error & {
      code: string;
    };
    raw.code = "SQLITE_CONSTRAINT";

    const single = normalizeBackendError(raw) as TuvrenPersistenceError;
    const double = normalizeBackendError(
      normalizeBackendError(raw)
    ) as TuvrenPersistenceError;

    ok(single instanceof TuvrenPersistenceError);
    ok(double instanceof TuvrenPersistenceError);
    deepStrictEqual(shapeOf(double), shapeOf(single));
    // The cause must point directly at the original raw error on both paths --
    // never at an intermediate already-normalized wrapper.
    strictEqual(single.cause, raw);
    strictEqual(double.cause, raw);
  });

  test("is idempotent for a generic Error with no sqlite code", () => {
    const raw = new Error("plain failure, not sqlite-shaped");

    const single = normalizeBackendError(raw);
    const double = normalizeBackendError(normalizeBackendError(raw));

    // Neither call wraps a plain Error without a SQLITE_ code: both return the
    // exact original reference.
    strictEqual(single, raw);
    strictEqual(double, raw);
    deepStrictEqual(shapeOf(double), shapeOf(single));
  });

  test("is idempotent for a non-Error throw", () => {
    const raw = { unexpected: "payload" };

    const single = normalizeBackendError(raw) as TuvrenPersistenceError;
    const double = normalizeBackendError(
      normalizeBackendError(raw)
    ) as TuvrenPersistenceError;

    ok(single instanceof TuvrenPersistenceError);
    ok(double instanceof TuvrenPersistenceError);
    deepStrictEqual(shapeOf(double), shapeOf(single));
    strictEqual(single.cause, undefined);
    strictEqual(double.cause, undefined);
  });
});

describe("@tuvren/backend-sqlite transact rollback normalization (KRT-BK009)", () => {
  test("normalizes a mid-transaction rollback error exactly once and leaves the backend usable", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });

    // A real engine-level failure (not a fabricated stand-in): block writes to
    // `objects` so the second write in the transaction below throws a genuine
    // SQLITE_-coded error from better-sqlite3, after a real prior write, so a
    // real ROLLBACK is exercised.
    const probe = new Database(databasePath);
    probe.exec(`
      CREATE TRIGGER objects_block_insert
      BEFORE INSERT ON objects
      BEGIN
        SELECT RAISE(FAIL, 'blocked by rollback-normalization test');
      END;
    `);
    probe.close();

    const schema = createCanonicalKernelTestSchema();
    const schemaRecord = createStoredSchemaRecord(schema, 1);
    const objectRecord = await createStoredObjectRecord(new Uint8Array([9]), 2);

    await rejects(
      backend.transact(async (tx) => {
        // A real write that must be rolled back once the second write below
        // throws.
        await tx.schemas.put(schemaRecord);
        // Blocked by the trigger: throws a genuine SQLITE_-coded error.
        await tx.objects.put(objectRecord);
      }),
      (error: unknown) => {
        ok(error instanceof TuvrenPersistenceError);
        strictEqual(error.code, "sqlite_backend_engine_error");
        ok(NORMALIZED_ENGINE_ERROR_PATTERN.test(error.message));

        // (i) Shape check: `cause` points directly at the original raw sqlite
        // error, not at an intermediate already-normalized wrapper. Note this
        // does NOT by itself prove single-normalization: because
        // `normalizeBackendError` is idempotent, a second call onto its own
        // already-normalized output returns that same instance unchanged, so
        // this cause chain is identical whether the rollback path normalizes
        // once or twice. The call-count spy in
        // `backend-sqlite.rollback-normalization-guard.test.ts` is what
        // actually pins the single-normalization structural invariant.
        const { cause } = error;
        ok(cause instanceof Error);
        ok(!(cause instanceof TuvrenPersistenceError));
        ok(!(cause instanceof TuvrenValidationError));
        ok(ROLLBACK_TRIGGER_MESSAGE_PATTERN.test(cause.message));

        return true;
      }
    );

    // (ii) Rolled back cleanly: `health()` runs `BEGIN IMMEDIATE` on the exact
    // same private connection `transact` used, so it would fail here if that
    // connection were still mid-transaction.
    const health = await backend.health();
    strictEqual(health.ok, true);

    // The rolled-back write must not be observable.
    const afterRollback = await backend.transact((tx) =>
      tx.schemas.get(schema.schemaId)
    );
    strictEqual(afterRollback, null);

    // (iii) The lock/transaction state was not corrupted by the rollback
    // attempt: a subsequent transact() on the same instance succeeds
    // normally and its write is durable.
    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
    });
    const afterSecondTransact = await backend.transact((tx) =>
      tx.schemas.get(schema.schemaId)
    );
    deepStrictEqual(afterSecondTransact, schemaRecord);

    await backend.close();
  });
});
