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

// Round-6 review P2 — `fsck()` opened its read-only snapshot transaction and
// `health()` issued its posture/liveness queries with no `SET LOCAL
// lock_timeout` of their own (unlike `transact`/`reclaim`/`purgeScope`, which
// take the same-scope advisory lock under `acquireScopeTransactionLock`'s
// explicit `SET LOCAL`). A lock-blocked `fsck()`/`health()` call therefore had
// no bound at all and, because the pool is `max: 1` and
// `withSerializedConnection` holds the reservation until the body resolves,
// could wedge every other operation on the instance behind it forever. The
// fix sends `lock_timeout` as a `postgres.js` startup parameter via the
// `connection` configuration key, so every physical connection the pool ever
// opens (including one opened after `idle_timeout: 5` recycles an idle one)
// starts with the bound already in place. This file empirically proves both
// halves: (1) the startup-parameter mechanism itself actually sets the GUC on
// a fresh connection, and (2) `fsck()`/`health()` genuinely fail within the
// bound instead of hanging when a concurrent session holds a conflicting
// table lock.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPostgresBackend } from "../src/index.js";
import { createPostgresClient } from "../src/lib/postgres-backend-persistence.js";
import { qualifyIdentifier } from "../src/lib/postgres-sql.js";
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

// The driver's own message for a `lock_timeout` cancellation (PostgreSQL
// SQLSTATE 55P03), not a generic connection failure.
const LOCK_TIMEOUT_REASON_PATTERN = /lock timeout/iu;

describe("@tuvren/backend-postgres connection-wide lock_timeout startup parameter", () => {
  test("createPostgresClient's connection carries a 5s lock_timeout from the first query on a fresh connection, with no session-level SET", async () => {
    const options = createPostgresTestBackendOptions();
    const client = createPostgresClient(options);

    try {
      // No `SET`/`SET LOCAL` has run on this connection yet: the very first
      // query already observes the bound, proving it was carried as a
      // startup parameter (the `connection` configuration key), not
      // something this test itself established.
      const rows = await client<{ lock_timeout: string }[]>`SHOW lock_timeout`;
      expect(rows[0]?.lock_timeout).toBe("5s");
    } finally {
      await client.end({ timeout: 0 });
    }
  });

  test("a replacement connection reserved after a prior one is released still carries the 5s lock_timeout", async () => {
    const options = createPostgresTestBackendOptions();
    const client = createPostgresClient(options);

    try {
      const first = await client.reserve();
      await first.unsafe("SELECT 1");
      await first.release();

      const second = await client.reserve();
      try {
        const rows =
          await second.unsafe<{ lock_timeout: string }[]>("SHOW lock_timeout");
        expect(rows[0]?.lock_timeout).toBe("5s");
      } finally {
        await second.release();
      }
    } finally {
      await client.end({ timeout: 0 });
    }
  });

  test("fsck() fails within the bounded lock_timeout instead of hanging when another session holds a conflicting ACCESS EXCLUSIVE table lock", async () => {
    const options = createPostgresTestBackendOptions();
    const schemaName = options.schemaName;
    if (schemaName === undefined) {
      throw new Error(
        "expected createPostgresTestBackendOptions to allocate a schema name"
      );
    }

    const backend = createPostgresBackend(options);
    const admin = createAdminClient(options);
    let adminReserved: Awaited<ReturnType<typeof admin.reserve>> | undefined;

    try {
      // Provision the schema/tables before contending on them, so schema
      // init latency cannot masquerade as lock wait below.
      expect(await backend.health()).toEqual({ ok: true });

      adminReserved = await admin.reserve();
      await adminReserved.unsafe("BEGIN");
      await adminReserved.unsafe(
        `LOCK TABLE ${qualifyIdentifier(schemaName, "objects")} IN ACCESS EXCLUSIVE MODE`
      );

      const startedAtMs = Date.now();
      const result = await backend.fsck();
      const elapsedMs = Date.now() - startedAtMs;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(LOCK_TIMEOUT_REASON_PATTERN);
      }

      // Bounded by the connection-wide lock_timeout (5000ms); a generous
      // upper bound keeps this robust against CI scheduling jitter while
      // still proving fsck() did not hang indefinitely behind the lock.
      expect(elapsedMs).toBeGreaterThanOrEqual(4000);
      expect(elapsedMs).toBeLessThan(20_000);
    } finally {
      if (adminReserved !== undefined) {
        try {
          await adminReserved.unsafe("ROLLBACK");
        } catch {
          // Best-effort: the connection may already have been dropped.
        }
        await adminReserved.release();
      }
      await admin.end({ timeout: 0 });
      await backend.destroy({ dropSchema: true });
    }
  }, 20_000);

  test("health() fails within the bounded lock_timeout instead of hanging when another session holds a conflicting ACCESS EXCLUSIVE table lock", async () => {
    const options = createPostgresTestBackendOptions();
    const schemaName = options.schemaName;
    if (schemaName === undefined) {
      throw new Error(
        "expected createPostgresTestBackendOptions to allocate a schema name"
      );
    }

    const backend = createPostgresBackend(options);
    const admin = createAdminClient(options);
    let adminReserved: Awaited<ReturnType<typeof admin.reserve>> | undefined;

    try {
      expect(await backend.health()).toEqual({ ok: true });

      adminReserved = await admin.reserve();
      await adminReserved.unsafe("BEGIN");
      await adminReserved.unsafe(
        `LOCK TABLE ${qualifyIdentifier(schemaName, "objects")} IN ACCESS EXCLUSIVE MODE`
      );

      const startedAtMs = Date.now();
      const result = await backend.health();
      const elapsedMs = Date.now() - startedAtMs;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(LOCK_TIMEOUT_REASON_PATTERN);
      }
      expect(elapsedMs).toBeGreaterThanOrEqual(4000);
      expect(elapsedMs).toBeLessThan(20_000);
    } finally {
      if (adminReserved !== undefined) {
        try {
          await adminReserved.unsafe("ROLLBACK");
        } catch {
          // Best-effort: the connection may already have been dropped.
        }
        await adminReserved.release();
      }
      await admin.end({ timeout: 0 });
      await backend.destroy({ dropSchema: true });
    }
  }, 20_000);
});
