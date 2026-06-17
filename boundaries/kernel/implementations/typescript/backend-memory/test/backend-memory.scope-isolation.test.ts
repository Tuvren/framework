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

import { describe, expect, test } from "bun:test";
import {
  createMemoryBackend,
  createMemoryScopeStore,
} from "@tuvren/backend-memory";
import type { RuntimeBackend, StoredThread } from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
  delay,
} from "@tuvren/kernel-testkit";
import { createCanonicalTurnTreePaths } from "./backend-memory-test-helpers.js";

// Seeds a minimal thread (schema + genesis turn tree/node + thread) so
// enumeration isolation can be asserted via threads.list.
async function seedThread(
  backend: RuntimeBackend,
  threadId: string,
  base: number
): Promise<string> {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, base);
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    { "context.manifest": null, messages: [] },
    base + 1
  );
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
    await tx.turnTreePaths.putMany(createCanonicalTurnTreePaths(turnTree, []));
    await tx.turnNodes.put(turnNode);
    await tx.threads.put(thread);
  });

  return threadId;
}

describe("@tuvren/backend-memory scope isolation (KRT-BE003)", () => {
  test("content stored under one scope is not retrievable or existence-checkable through another scope sharing a store", async () => {
    const store = createMemoryScopeStore();
    const scopeA = createMemoryBackend({ scope: "tenant-a", store });
    const scopeB = createMemoryBackend({ scope: "tenant-b", store });

    const record = await createStoredObjectRecord(new Uint8Array([1, 2, 3]), 1);

    await scopeA.transact(async (tx) => {
      await tx.objects.put(record);
    });

    await scopeB.transact(async (tx) => {
      expect(await tx.objects.has(record.hash)).toBe(false);
      expect(await tx.objects.get(record.hash)).toBeNull();
    });

    await scopeA.transact(async (tx) => {
      expect(await tx.objects.has(record.hash)).toBe(true);
      const stored = await tx.objects.get(record.hash);
      expect(stored).not.toBeNull();
      expect(Array.from(stored?.bytes ?? [])).toEqual([1, 2, 3]);
    });
  });

  test("enumeration is scope-confined: another scope cannot list this scope's threads", async () => {
    const store = createMemoryScopeStore();
    const scopeA = createMemoryBackend({ scope: "tenant-a", store });
    const scopeB = createMemoryBackend({ scope: "tenant-b", store });

    const threadId = await seedThread(scopeA, "thread_a", 100);

    await scopeB.transact(async (tx) => {
      const list = tx.threads.list;
      expect(list).toBeDefined();
      const listed = await list?.({});
      expect(listed?.threads ?? []).toEqual([]);
      expect(await tx.threads.get(threadId)).toBeNull();
    });

    await scopeA.transact(async (tx) => {
      const list = tx.threads.list;
      expect(list).toBeDefined();
      const listed = await list?.({});
      expect((listed?.threads ?? []).map((t) => t.threadId)).toEqual([
        threadId,
      ]);
    });
  });

  test("identical content under two scopes is two independent durable objects (no cross-scope dedup)", async () => {
    const store = createMemoryScopeStore();
    const scopeA = createMemoryBackend({ scope: "tenant-a", store });
    const scopeB = createMemoryBackend({ scope: "tenant-b", store });

    const recordA = await createStoredObjectRecord(new Uint8Array([7, 7]), 1);
    const recordB = await createStoredObjectRecord(new Uint8Array([7, 7]), 1);
    expect(recordA.hash).toBe(recordB.hash);

    await scopeA.transact(async (tx) => {
      await tx.objects.put(recordA);
    });
    // Scope B can independently store the identical content; it does not collide
    // with scope A and is invisible across the scope boundary.
    await scopeB.transact(async (tx) => {
      expect(await tx.objects.has(recordB.hash)).toBe(false);
      await tx.objects.put(recordB);
      expect(await tx.objects.has(recordB.hash)).toBe(true);
    });
  });

  test("two backends bound to the same scope and store share that scope's durable state", async () => {
    const store = createMemoryScopeStore();
    const first = createMemoryBackend({ scope: "tenant-x", store });
    const second = createMemoryBackend({ scope: "tenant-x", store });

    const record = await createStoredObjectRecord(new Uint8Array([9]), 1);

    await first.transact(async (tx) => {
      await tx.objects.put(record);
    });

    await second.transact(async (tx) => {
      expect(await tx.objects.has(record.hash)).toBe(true);
    });
  });

  test("serializes transactions across separate backend instances sharing a scope and store", async () => {
    const store = createMemoryScopeStore();
    const first = createMemoryBackend({ scope: "tenant-x", store });
    const second = createMemoryBackend({ scope: "tenant-x", store });
    const order: string[] = [];

    const firstTransaction = first.transact(async () => {
      order.push("first:start");
      await delay(20);
      order.push("first:end");
    });
    const secondTransaction = second.transact(() => {
      order.push("second:start");
      order.push("second:end");
      return Promise.resolve();
    });

    await Promise.all([firstTransaction, secondTransaction]);
    // The store's per-Scope lock serializes the two instances: the second
    // transaction never interleaves with the first, even across instances.
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  test("transactions for distinct scopes sharing a store run concurrently (no cross-scope lock contention)", async () => {
    const store = createMemoryScopeStore();
    const scopeA = createMemoryBackend({ scope: "tenant-a", store });
    const scopeB = createMemoryBackend({ scope: "tenant-b", store });
    const order: string[] = [];

    const aTransaction = scopeA.transact(async () => {
      order.push("a:start");
      await delay(20);
      order.push("a:end");
    });
    const bTransaction = scopeB.transact(() => {
      order.push("b:start");
      order.push("b:end");
      return Promise.resolve();
    });

    await Promise.all([aTransaction, bTransaction]);
    // Distinct scopes do not contend, so scope B completes while scope A waits.
    expect(order).toEqual(["a:start", "b:start", "b:end", "a:end"]);
  });

  test("default unscoped backends each own a private isolated substrate", async () => {
    const first = createMemoryBackend();
    const second = createMemoryBackend();

    const record = await createStoredObjectRecord(new Uint8Array([5]), 1);

    await first.transact(async (tx) => {
      await tx.objects.put(record);
    });

    await second.transact(async (tx) => {
      expect(await tx.objects.has(record.hash)).toBe(false);
    });

    await first.transact(async (tx) => {
      expect(await tx.objects.has(record.hash)).toBe(true);
    });
  });

  test("a scoped backend with a private store round-trips its own content", async () => {
    const backend = createMemoryBackend({ scope: "solo" });
    const record = await createStoredObjectRecord(new Uint8Array([4, 2]), 1);

    await backend.transact(async (tx) => {
      await tx.objects.put(record);
    });
    await backend.transact(async (tx) => {
      expect(await tx.objects.has(record.hash)).toBe(true);
    });
  });

  test("rejects an empty scope binding at construction", () => {
    expect(() => createMemoryBackend({ scope: "" })).toThrow(TypeError);
  });
});
