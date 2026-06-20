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

// KRT-BF006 — substrate partition drop (full tenant offboarding, kernel spec
// §9.4). Dropping one Scope's partition must remove all of that Scope's durable
// state while leaving every co-tenant Scope sharing the substrate untouched —
// the cross-scope isolation Epic BE established, exercised through offboarding.

import { describe, expect, test } from "bun:test";
import {
  createMemoryBackend,
  createMemoryScopeStore,
} from "@tuvren/backend-memory";
import { createStoredObjectRecord } from "@tuvren/kernel-testkit";

describe("@tuvren/backend-memory purgeScope (KRT-BF006)", () => {
  test("dropping one scope's partition leaves a co-tenant scope sharing the store intact", async () => {
    const store = createMemoryScopeStore();
    const scopeA = createMemoryBackend({ scope: "tenant-a", store });
    const scopeB = createMemoryBackend({ scope: "tenant-b", store });

    const recordA = await createStoredObjectRecord(
      new Uint8Array([1, 1, 1]),
      1
    );
    const recordB = await createStoredObjectRecord(
      new Uint8Array([2, 2, 2]),
      2
    );

    await scopeA.transact(async (tx) => {
      await tx.objects.put(recordA);
    });
    await scopeB.transact(async (tx) => {
      await tx.objects.put(recordB);
    });

    expect(scopeA.purgeScope).toBeDefined();
    await scopeA.purgeScope?.();

    // Scope A's partition is gone: a fresh transaction observes an empty store.
    await scopeA.transact(async (tx) => {
      expect(await tx.objects.has(recordA.hash)).toBe(false);
    });

    // Scope B is wholly untouched.
    await scopeB.transact(async (tx) => {
      expect(await tx.objects.has(recordB.hash)).toBe(true);
    });

    // A second backend bound to the dropped Scope and the same store also sees
    // an empty partition — the drop cleared the shared substrate entry, not just
    // one instance's view.
    const scopeARebound = createMemoryBackend({ scope: "tenant-a", store });
    await scopeARebound.transact(async (tx) => {
      expect(await tx.objects.has(recordA.hash)).toBe(false);
    });
  });

  test("purgeScope is a safe no-op on an already empty scope partition", async () => {
    const backend = createMemoryBackend({ scope: "tenant-empty" });
    expect(backend.purgeScope).toBeDefined();
    await backend.purgeScope?.();

    const record = await createStoredObjectRecord(new Uint8Array([3]), 1);
    await backend.transact(async (tx) => {
      expect(await tx.objects.has(record.hash)).toBe(false);
    });
  });
});
