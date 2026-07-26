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

// Issue #108 M3 whole-blob decode memoization is retired under ADR-067 /
// issue #110: the relational write path no longer loads or caches a
// Scope-wide snapshot_cbor. This file keeps a single construction-compat
// check so `snapshotCacheObserver` remains a harmless options field, and
// otherwise documents the retirement.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createStoredObjectRecord } from "@tuvren/kernel-testkit";
import { createPostgresBackend } from "../src/index.js";
import type { SnapshotCacheObserver } from "../src/lib/postgres-backend-snapshot-cache.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres snapshot cache (retired under ADR-067)", () => {
  test("snapshotCacheObserver is accepted at construction and does not affect relational writes", async () => {
    let hitCount = 0;
    let missCount = 0;
    const observer: SnapshotCacheObserver = {
      recordHit: () => {
        hitCount += 1;
      },
      recordMiss: () => {
        missCount += 1;
      },
    };

    const options = createPostgresTestBackendOptions({
      snapshotCacheObserver: observer,
    });
    const backend = createPostgresBackend(options);
    try {
      const object = await createStoredObjectRecord(new Uint8Array([1, 2]), 1);
      await backend.transact(async (tx) => {
        await tx.objects.put(object);
      });
      await backend.transact(async (tx) => {
        expect(await tx.objects.get(object.hash)).toEqual(object);
      });
      // Relational path never consults the blob memo — observer stays silent.
      expect({ hits: hitCount, misses: missCount }).toEqual({
        hits: 0,
        misses: 0,
      });
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });
});
