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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { createStoredObjectRecord } from "@tuvren/kernel-testkit";
import { createPostgresBackend } from "../src/index.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

/**
 * KRT-BK011: backend-specific storage test uplift.
 *
 * `createPostgresClient` (postgres-backend-persistence.ts) hardcodes `max: 1`
 * on every `postgres.js` client, so each `PostgresBackend` instance owns
 * exactly one physical connection, and `loadPersistedStateForUpdate` takes a
 * real `SELECT ... FOR UPDATE` row lock keyed by `(schemaName, scope)`. These
 * are concrete properties of this backend's implementation that the shared
 * cross-backend testkit cannot express (it asserts uniform semantics across
 * all three backends and never constructs two backend instances contending
 * on one shared durable scope).
 *
 * `backend-postgres.scope-isolation.test.ts` already covers two backend
 * instances sharing a schema but bound to *different* scopes (no row
 * contention by construction, proven not to corrupt each other). This file is
 * the same-scope counterpart: it proves genuine PostgreSQL-level `FOR UPDATE`
 * row-lock contention between two independent instances, and that a single
 * instance's one physical connection safely serializes several concurrent
 * `transact()` calls rather than erroring under pool exhaustion.
 */

// Closes a backend's connection pool without dropping its schema, so two
// backends sharing a schema can each be closed independently before the
// afterAll teardown drops the schema.
async function closeBackend(
  backend: ReturnType<typeof createPostgresBackend>
): Promise<void> {
  await backend.destroy();
}

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres pool contention (KRT-BK011)", () => {
  test("a backend instance's held-open transaction blocks a second instance's concurrent transact() on the same scope until it commits", async () => {
    const sharedOptions = createPostgresTestBackendOptions({
      scope: "contention-scope",
    });
    const backendX = createPostgresBackend(sharedOptions);
    const backendY = createPostgresBackend(sharedOptions);

    // Pre-initialize both backends (creates the schema/table and this scope's
    // snapshot row, and commits it) before the contention window below. This
    // keeps a cold-start schema-initialization round-trip from masquerading as
    // "blocked", and ensures Y's own first-touch initialization (an
    // `INSERT ... ON CONFLICT DO NOTHING` against the same row) does not
    // itself contend with X's held `FOR UPDATE` lock -- Y should block on
    // exactly one thing: the `FOR UPDATE` read inside its real transact().
    expect(await backendX.health()).toEqual({ ok: true });
    expect(await backendY.health()).toEqual({ ok: true });

    const recordX = await createStoredObjectRecord(
      new Uint8Array([101, 101]),
      1
    );
    const recordY = await createStoredObjectRecord(
      new Uint8Array([202, 202]),
      2
    );

    const sequence: string[] = [];
    let markXHoldingRowLock: () => void = () => undefined;
    const xHoldingRowLock = new Promise<void>((resolve) => {
      markXHoldingRowLock = resolve;
    });
    let releaseXHold: () => void = () => undefined;
    const xHold = new Promise<void>((resolve) => {
      releaseXHold = resolve;
    });

    try {
      // By the time `work` starts executing, `PostgresBackend.transact` has
      // already run `SELECT ... FOR UPDATE` (loadPersistedStateForUpdate is
      // awaited before `work` is invoked), so the row lock is genuinely held
      // the instant this callback body starts.
      const xPromise = backendX.transact(async (tx) => {
        sequence.push("x-holding-row-lock");
        markXHoldingRowLock();
        await tx.objects.put(recordX);
        await xHold;
        sequence.push("x-about-to-commit");
      });

      await xHoldingRowLock;

      const yPromise = backendY.transact(async (tx) => {
        sequence.push("y-work-ran-after-x-committed");
        await tx.objects.put(recordY);
      });

      try {
        // Prove Y is genuinely blocked *while* X still holds the lock, instead
        // of only inferring it from final ordering: race Y's settlement
        // against a generous timeout. If the lock genuinely blocks, Y stays
        // pending no matter how long, so this has no false-failure risk -- it
        // only fails if the lock is broken, which is exactly the regression
        // this test exists to catch.
        const yStatusWhileXHolds = await Promise.race([
          yPromise.then(
            () => "settled" as const,
            () => "settled" as const
          ),
          delay(300).then(() => "pending" as const),
        ]);
        expect(yStatusWhileXHolds).toBe("pending");
      } finally {
        // Always release X's held-open transaction, even if the assertion
        // above throws -- otherwise X's FOR UPDATE lock stays open and
        // afterAll's DROP SCHEMA ... CASCADE teardown hangs on it.
        releaseXHold();
      }

      await xPromise;
      await yPromise;

      expect(sequence).toEqual([
        "x-holding-row-lock",
        "x-about-to-commit",
        "y-work-ran-after-x-committed",
      ]);

      await backendX.transact(async (tx) => {
        expect(await tx.objects.has(recordX.hash)).toBe(true);
        expect(await tx.objects.has(recordY.hash)).toBe(true);
      });
    } finally {
      await closeBackend(backendX);
      await closeBackend(backendY);
    }
  });

  test("a single instance safely serializes several concurrent transact() calls through its one max: 1 connection without corruption or pool errors", async () => {
    // This does not exercise raw postgres.js pool-level concurrency in
    // isolation -- `PostgresBackend.transact`'s in-process `transactionQueue`
    // already serializes concurrent calls on one instance before any of them
    // reach the pool. What this proves is the end-to-end guarantee that
    // matters operationally: firing several concurrent `transact()` calls at
    // one `max: 1` backend instance never throws a pool-exhaustion error and
    // never corrupts state, regardless of which layer performs the
    // serialization.
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);

    const records = await Promise.all(
      [1, 2, 3, 4, 5].map((seed) =>
        createStoredObjectRecord(new Uint8Array([seed, seed, seed]), seed)
      )
    );

    const hashes = await Promise.all(
      records.map((record) =>
        backend.transact(async (tx) => {
          await tx.objects.put(record);
          return record.hash;
        })
      )
    );

    expect([...hashes].sort()).toEqual(
      records.map((record) => record.hash).sort()
    );

    await backend.transact(async (tx) => {
      for (const record of records) {
        expect(await tx.objects.has(record.hash)).toBe(true);
        const stored = await tx.objects.get(record.hash);
        expect(stored?.hash).toBe(record.hash);
      }
    });

    await closeBackend(backend);
  });
});
