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
import type { RuntimeBackend, StoredThread } from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "@tuvren/kernel-testkit";
import { createSqliteBackend } from "../src/index.js";
import { createTempDatabasePath } from "./backend-sqlite-test-helpers.js";

// Seeds a minimal thread (schema + genesis turn tree/node + thread) so
// enumeration isolation can be asserted via threads.list.
async function seedThread(
  backend: RuntimeBackend,
  threadId: string,
  base: number
): Promise<string> {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, base);
  const manifest = { "context.manifest": null, messages: [] as string[] };
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
    await tx.schemas.put(schemaRecord);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, manifest)
    );
    await tx.turnNodes.put(turnNode);
    await tx.threads.put(thread);
  });

  return threadId;
}

describe("@tuvren/backend-sqlite scope isolation (KRT-BE004)", () => {
  test("content stored under one scope is not retrievable or existence-checkable through another scope sharing a base path", async () => {
    const databasePath = createTempDatabasePath();
    const scopeA = createSqliteBackend({ databasePath, scope: "tenant-a" });
    const scopeB = createSqliteBackend({ databasePath, scope: "tenant-b" });

    const record = await createStoredObjectRecord(new Uint8Array([1, 2, 3]), 1);

    await scopeA.transact(async (tx) => {
      await tx.objects.put(record);
    });

    await scopeB.transact(async (tx) => {
      strictEqual(await tx.objects.has(record.hash), false);
      strictEqual(await tx.objects.get(record.hash), null);
    });

    await scopeA.transact(async (tx) => {
      strictEqual(await tx.objects.has(record.hash), true);
      const stored = await tx.objects.get(record.hash);
      deepStrictEqual(Array.from(stored?.bytes ?? []), [1, 2, 3]);
    });

    await scopeA.close();
    await scopeB.close();
  });

  test("enumeration is scope-confined: a sibling scope file cannot list this scope's threads", async () => {
    const databasePath = createTempDatabasePath();
    const scopeA = createSqliteBackend({ databasePath, scope: "tenant-a" });
    const scopeB = createSqliteBackend({ databasePath, scope: "tenant-b" });

    const threadId = await seedThread(scopeA, "thread_a", 100);

    await scopeB.transact(async (tx) => {
      const list = tx.threads.list;
      ok(list);
      const listed = await list?.({});
      deepStrictEqual(listed?.threads ?? [], []);
      strictEqual(await tx.threads.get(threadId), null);
    });

    await scopeA.transact(async (tx) => {
      const list = tx.threads.list;
      ok(list);
      const listed = await list?.({});
      deepStrictEqual(
        (listed?.threads ?? []).map((thread) => thread.threadId),
        [threadId]
      );
    });

    await scopeA.close();
    await scopeB.close();
  });

  test("identical content under two scopes is two independent durable objects (no cross-scope dedup)", async () => {
    const databasePath = createTempDatabasePath();
    const scopeA = createSqliteBackend({ databasePath, scope: "tenant-a" });
    const scopeB = createSqliteBackend({ databasePath, scope: "tenant-b" });

    const recordA = await createStoredObjectRecord(new Uint8Array([7, 7]), 1);
    const recordB = await createStoredObjectRecord(new Uint8Array([7, 7]), 1);
    strictEqual(recordA.hash, recordB.hash);

    await scopeA.transact(async (tx) => {
      await tx.objects.put(recordA);
    });
    // Scope B can independently store the identical content; it does not collide
    // with scope A and is invisible across the scope boundary.
    await scopeB.transact(async (tx) => {
      strictEqual(await tx.objects.has(recordB.hash), false);
      await tx.objects.put(recordB);
      strictEqual(await tx.objects.has(recordB.hash), true);
    });

    await scopeA.close();
    await scopeB.close();
  });

  test("two backends bound to the same scope and base path share that scope's durable state across reopen", async () => {
    const databasePath = createTempDatabasePath();
    const record = await createStoredObjectRecord(new Uint8Array([9]), 1);

    const first = createSqliteBackend({ databasePath, scope: "tenant-x" });
    await first.transact(async (tx) => {
      await tx.objects.put(record);
    });
    await first.close();

    const second = createSqliteBackend({ databasePath, scope: "tenant-x" });
    await second.transact(async (tx) => {
      strictEqual(await tx.objects.has(record.hash), true);
    });
    await second.close();
  });

  test("existing single-scope behavior is preserved: the default scope uses the verbatim path and persists across reopen", async () => {
    const databasePath = createTempDatabasePath();
    const record = await createStoredObjectRecord(new Uint8Array([4, 2]), 1);

    const first = createSqliteBackend({ databasePath });
    await first.transact(async (tx) => {
      await tx.objects.put(record);
    });
    await first.close();

    const reopened = createSqliteBackend({ databasePath });
    await reopened.transact(async (tx) => {
      strictEqual(await tx.objects.has(record.hash), true);
    });
    await reopened.close();
  });

  test("a non-default scope derives a sibling file, leaving the default-scope database untouched", async () => {
    const databasePath = createTempDatabasePath();
    const defaultRecord = await createStoredObjectRecord(
      new Uint8Array([1]),
      1
    );
    const scopedRecord = await createStoredObjectRecord(new Uint8Array([2]), 2);

    const defaultBackend = createSqliteBackend({ databasePath });
    await defaultBackend.transact(async (tx) => {
      await tx.objects.put(defaultRecord);
    });

    const scopedBackend = createSqliteBackend({
      databasePath,
      scope: "tenant-a",
    });
    await scopedBackend.transact(async (tx) => {
      strictEqual(await tx.objects.has(defaultRecord.hash), false);
      await tx.objects.put(scopedRecord);
    });

    await defaultBackend.transact(async (tx) => {
      strictEqual(await tx.objects.has(defaultRecord.hash), true);
      strictEqual(await tx.objects.has(scopedRecord.hash), false);
    });

    await defaultBackend.close();
    await scopedBackend.close();
  });

  test("rejects an empty scope binding at construction", () => {
    const databasePath = createTempDatabasePath();
    throws(() => createSqliteBackend({ databasePath, scope: "" }), TypeError);
  });
});
