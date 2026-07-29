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

// Round-6 review P2 — closes a silent-data-loss residual left by the
// public → tuvren_kernel default-schema change. A pre-#110 deployment that
// omitted `schemaName` has its legacy `backend_postgres_snapshots` table in
// `"public"`; after upgrading to a package version defaulting to
// `"tuvren_kernel"`, the backend would otherwise provision a fresh, empty
// `"tuvren_kernel"` schema, the open-time migration would only ever look in
// the configured schema, and the app would come up with zero data with no
// error at all. This file drives `ensurePostgresRelationalSchemaInitialized`
// directly against disposable throwaway schemas (never the real
// "tuvren_kernel" name) to prove the guard fires only when all three
// conditions hold — the schema name was defaulted, the configured schema is
// being created for the first time, and a `backend_postgres_snapshots` table
// exists in some other schema — and stays silent otherwise.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { LEGACY_SNAPSHOTS_TABLE } from "../src/lib/postgres-schema.js";
import { ensurePostgresRelationalSchemaInitialized } from "../src/lib/postgres-schema-init.js";
import { quoteIdentifier } from "../src/lib/postgres-sql.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createAdminClient,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

function freshSchemaName(label: string): string {
  return `test_${label}_${randomUUID().replaceAll("-", "_")}`;
}

async function dropSchema(sql: Sql, schemaName: string): Promise<void> {
  await sql.unsafe(
    `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`
  );
}

async function schemaExists(sql: Sql, schemaName: string): Promise<boolean> {
  const rows = await sql.unsafe<Array<{ exists: boolean }>>(
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS exists",
    [schemaName]
  );
  return rows[0]?.exists === true;
}

const fixedNow = (): number => 1_700_000_000_000;

describe("@tuvren/backend-postgres legacy-blob-schema-elsewhere guard (round-6 review P2)", () => {
  let sql: Sql;
  const legacySchemaName = freshSchemaName("legacy_elsewhere");
  const throwawaySchemas: string[] = [];

  beforeAll(async () => {
    await assertDevenvPostgresReady();

    const options = createPostgresTestBackendOptions();
    sql = createAdminClient(options);

    // Seed a legacy blob table in a schema that is NOT any of this file's
    // init targets, simulating a pre-#110 deployment's
    // `backend_postgres_snapshots` table sitting in a schema the upgraded
    // backend never looks at.
    await sql.unsafe(
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(legacySchemaName)}`
    );
    await sql.unsafe(
      `CREATE TABLE ${quoteIdentifier(legacySchemaName)}.${quoteIdentifier(LEGACY_SNAPSHOTS_TABLE)} (id integer)`
    );
  });

  afterAll(async () => {
    await dropSchema(sql, legacySchemaName);
    for (const schemaName of throwawaySchemas) {
      await dropSchema(sql, schemaName);
    }
    await sql.end({ timeout: 0 });
    // createPostgresTestBackendOptions() above allocated a random schema
    // name for connection-options purposes only (never actually created in
    // the database); this drops it too, so this file leaves no schema
    // registered anywhere, real or phantom.
    await cleanupAllocatedSchemas();
  });

  test("throws postgres_backend_legacy_blob_schema_elsewhere when the schema name was defaulted, the target schema is new, and the legacy table exists elsewhere", async () => {
    const targetSchemaName = freshSchemaName("defaulted_new");
    throwawaySchemas.push(targetSchemaName);

    let caughtError: unknown;
    try {
      await ensurePostgresRelationalSchemaInitialized(
        sql,
        targetSchemaName,
        true,
        fixedNow
      );
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const normalizedError = caughtError as Error & {
      code?: string;
      details?: unknown;
    };
    expect(normalizedError.code).toBe(
      "postgres_backend_legacy_blob_schema_elsewhere"
    );
    const details = normalizedError.details as
      | { configuredSchemaName?: string; legacySchemas?: string[] }
      | undefined;
    expect(details?.configuredSchemaName).toBe(targetSchemaName);
    expect(details?.legacySchemas).toContain(legacySchemaName);

    // The guard fires before `CREATE SCHEMA IF NOT EXISTS` commits (the
    // whole init runs inside one transaction that rolls back on throw), so
    // the target schema must not have been left behind half-provisioned.
    expect(await schemaExists(sql, targetSchemaName)).toBe(false);
  });

  test("does not fire when schemaNameWasDefaulted is false, even though the legacy table exists elsewhere and the target schema is new", async () => {
    const targetSchemaName = freshSchemaName("explicit_new");
    throwawaySchemas.push(targetSchemaName);

    await ensurePostgresRelationalSchemaInitialized(
      sql,
      targetSchemaName,
      false,
      fixedNow
    );

    // Reaching here without throwing is the assertion; also confirm the
    // schema was actually provisioned normally, proving init did not just
    // short-circuit some other way.
    expect(await schemaExists(sql, targetSchemaName)).toBe(true);
  });

  test("does not fire when the target schema already existed before this init call, even with schemaNameWasDefaulted true", async () => {
    const targetSchemaName = freshSchemaName("preexisting");
    throwawaySchemas.push(targetSchemaName);

    // First call provisions the schema normally (flag false, unrelated to
    // this test's condition under check).
    await ensurePostgresRelationalSchemaInitialized(
      sql,
      targetSchemaName,
      false,
      fixedNow
    );
    expect(await schemaExists(sql, targetSchemaName)).toBe(true);

    // Second call, now with the defaulted flag true: the schema already
    // exists, so the "creating it for the first time" condition is false
    // and the guard must stay silent even though the legacy table still
    // exists elsewhere.
    await expect(
      ensurePostgresRelationalSchemaInitialized(
        sql,
        targetSchemaName,
        true,
        fixedNow
      )
    ).resolves.toBeUndefined();
  });
});
