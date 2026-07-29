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

// Round-5 review P1 — `withSerializedConnection`'s prologue
// (`ensureInitialized()`/`sql.reserve()`) used to run outside every
// operation's own `normalizeBackendError` catch, so a schema-initialization
// failure (e.g. the migration's plain `CREATE TABLE objects (...)` colliding
// with a pre-existing, host-owned table of the same name) surfaced as a raw
// driver error instead of the backend's typed `TuvrenPersistenceError`. This
// file proves `transact()` now normalizes that failure the same way every
// other entry point does.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPostgresBackend } from "../src/index.js";
import { qualifyIdentifier, quoteIdentifier } from "../src/lib/postgres-sql.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createAdminClient,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres schema-initialization error normalization", () => {
  test("transact() rejects with a normalized postgres_backend_engine_error, not a raw driver error, when schema init collides with a pre-existing conflicting table", async () => {
    const options = createPostgresTestBackendOptions();
    const schemaName = options.schemaName;
    if (schemaName === undefined) {
      throw new Error(
        "expected createPostgresTestBackendOptions to allocate a schema name"
      );
    }

    // Pre-create the schema with a conflicting `objects` table before the
    // backend ever touches it. The relational migration's `CREATE TABLE
    // objects (...)` has no `IF NOT EXISTS` guard (unlike the migrations
    // ledger table), so this makes `ensurePostgresRelationalSchemaInitialized`
    // fail with a genuine `42P07` (relation "objects" already exists).
    const admin = createAdminClient(options);
    try {
      await admin.unsafe(
        `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`
      );
      await admin.unsafe(
        `CREATE TABLE ${qualifyIdentifier(schemaName, "objects")} (id integer)`
      );
    } finally {
      await admin.end({ timeout: 0 });
    }

    const backend = createPostgresBackend(options);

    try {
      let caughtError: unknown;
      try {
        await backend.transact(async () => undefined);
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      const normalizedError = caughtError as Error & {
        code?: string;
        details?: unknown;
      };
      // Not just "is an Error": the raw driver error carries only
      // `code: "42P07"` with no `postgres_backend_*` code at all. Asserting
      // the normalized code proves the failure was actually wrapped, rather
      // than a raw PostgresError happening to also be an Error instance.
      expect(normalizedError.code).toBe("postgres_backend_engine_error");
      const details = normalizedError.details as
        | { postgresCode?: string }
        | undefined;
      expect(details?.postgresCode).toBe("42P07");
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });
});
