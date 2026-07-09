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

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, test } from "node:test";
import { TuvrenPersistenceError } from "@tuvren/core";
import type { RuntimeBackend, StoredThread } from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createHashFromIndex,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "@tuvren/kernel-testkit";
import { createSqliteBackend } from "../src/index.js";
import { createTempDatabasePath } from "./backend-sqlite-test-helpers.js";

// KRT-BK006: threads.list's dynamic LIMIT clause must reject unsafe numeric
// input before any SQL is built, and must parameterize a safe limit rather
// than string-interpolate it. Seeds a minimal thread (schema + genesis turn
// tree/node + thread) so pagination behavior can be asserted end to end.
//
// `index` seeds a per-thread synthetic content-manifest hash so each thread's
// turn tree/node identity (content-addressed, independent of createdAtMs) is
// distinct — otherwise a second seeded thread with an identical manifest
// would collide on the first thread's turn tree/node hash and trip the
// immutable-record-match guard on a differing createdAtMs. The schema record
// itself is registered once with a fixed createdAtMs across all seeded
// threads for the same reason (schemas are keyed by schemaId, not content).
async function seedThread(
  backend: RuntimeBackend,
  threadId: string,
  index: number,
  base: number
): Promise<void> {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, 1);
  const manifest = {
    "context.manifest": createHashFromIndex(index),
    messages: [] as string[],
  };
  const turnTree = await createStoredTurnTreeRecord(schema, manifest, base + 1);
  const turnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: base + 2,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread: StoredThread = {
    createdAtMs: base + 3,
    rootTurnNodeHash: turnNode.hash,
    schemaId: schema.schemaId,
    threadId,
  };

  await backend.transact(async (tx) => {
    // schemas.put is idempotent-by-identity: re-registering the same schema
    // record across seeded threads is fine as long as the bytes and
    // createdAtMs match, which is why createdAtMs is pinned above.
    await tx.schemas.put(schemaRecord);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, manifest)
    );
    await tx.turnNodes.put(turnNode);
    await tx.threads.put(thread);
  });
}

describe("@tuvren/backend-sqlite threads.list LIMIT guard (KRT-BK006)", () => {
  test("rejects a negative limit before touching the database", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });

    await backend.transact((tx) => {
      const list = tx.threads.list;
      ok(list);
      throws(() => {
        list({ limit: -1 });
      }, TuvrenPersistenceError);
      return Promise.resolve();
    });

    await backend.close();
  });

  test("rejects a non-integer limit", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });

    await backend.transact((tx) => {
      const list = tx.threads.list;
      ok(list);
      throws(() => {
        list({ limit: 1.5 });
      }, TuvrenPersistenceError);
      return Promise.resolve();
    });

    await backend.close();
  });

  test("rejects a limit that is not a safe integer", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });

    await backend.transact((tx) => {
      const list = tx.threads.list;
      ok(list);
      throws(() => {
        list({ limit: Number.MAX_SAFE_INTEGER + 1 });
      }, TuvrenPersistenceError);
      return Promise.resolve();
    });

    await backend.close();
  });

  test("the rejected-limit error carries the sqlite_backend_invalid_list_limit code", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });

    await backend.transact((tx) => {
      const list = tx.threads.list;
      ok(list);
      try {
        list({ limit: -5 });
        throw new Error("expected list() to throw");
      } catch (error) {
        ok(error instanceof TuvrenPersistenceError);
        strictEqual(error.code, "sqlite_backend_invalid_list_limit");
      }
      return Promise.resolve();
    });

    await backend.close();
  });

  test("accepts a zero limit and returns zero rows without rejecting", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });
    await seedThread(backend, "thread_zero_limit", 1, 100);

    await backend.transact(async (tx) => {
      const list = tx.threads.list;
      ok(list);
      const listed = await list({ limit: 0 });
      deepStrictEqual(listed.threads, []);
      strictEqual(listed.nextCursor, undefined);
    });

    await backend.close();
  });

  test("a normal positive limit still works and paginates correctly via the parameterized LIMIT clause", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });
    await seedThread(backend, "thread_a", 1, 100);
    await seedThread(backend, "thread_b", 2, 200);
    await seedThread(backend, "thread_c", 3, 300);

    await backend.transact(async (tx) => {
      const list = tx.threads.list;
      ok(list);

      const firstPage = await list({ limit: 2 });
      deepStrictEqual(
        firstPage.threads.map((thread) => thread.threadId),
        ["thread_a", "thread_b"]
      );
      ok(firstPage.nextCursor);

      const secondPage = await list({
        limit: 2,
        cursor: firstPage.nextCursor,
      });
      deepStrictEqual(
        secondPage.threads.map((thread) => thread.threadId),
        ["thread_c"]
      );
      strictEqual(secondPage.nextCursor, undefined);
    });

    await backend.close();
  });
});
