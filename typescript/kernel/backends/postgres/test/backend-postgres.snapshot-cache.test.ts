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

// Issue #108 M3 (A3 content-hash memoization): validates the postgres
// backend's single-entry snapshot cache -- a per-instance memo of {hash of
// the last snapshot_cbor bytes this instance itself committed or decoded,
// that snapshot's already-decoded BackendState} that lets
// loadPersistedStateForUpdate skip decodeSnapshot entirely on a hash match,
// while the row lock and schema_version check keep running unconditionally.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TuvrenPersistenceError } from "@tuvren/core";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "@tuvren/kernel-testkit";
import type { SnapshotCacheObserver } from "../src/index.js";
import { createPostgresBackend } from "../src/index.js";
import {
  decodeSnapshot,
  encodeSnapshot,
} from "../src/lib/postgres-backend-persistence.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
  readSnapshotCbor,
  writeSnapshotCbor,
} from "./postgres-test-helpers.js";

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres single-entry snapshot cache (issue #108 M3)", () => {
  test("a warmed cache produces byte-identical persisted snapshots to a decode-every-time baseline", async () => {
    const fixedNow = () => 1_700_000_000_000;
    const schema = createCanonicalKernelTestSchema();
    const schemaRecord = createStoredSchemaRecord(schema, 1);
    const firstObject = await createStoredObjectRecord(
      new Uint8Array([1, 1, 1]),
      2
    );
    const secondObject = await createStoredObjectRecord(
      new Uint8Array([2, 2, 2]),
      3
    );

    const hitsAndMisses = createHitMissCounter();
    const cachedOptions = createPostgresTestBackendOptions({
      now: fixedNow,
      snapshotCacheObserver: hitsAndMisses.observer,
    });
    const cachedBackend = createPostgresBackend(cachedOptions);

    // First transact() is necessarily a cache miss (nothing memoized yet).
    await cachedBackend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.objects.put(firstObject);
    });
    // Second transact() on the SAME instance, with no other writer touching
    // the row in between, must be a cache hit.
    await cachedBackend.transact(async (tx) => {
      await tx.objects.put(secondObject);
    });

    expect(hitsAndMisses.counts()).toEqual({ hits: 1, misses: 1 });

    // Baseline: a fresh backend instance (empty cache) per write, so every
    // write's base state is forced through decodeSnapshot, never the memo.
    const baselineOptions = createPostgresTestBackendOptions({
      now: fixedNow,
    });
    await createPostgresBackend(baselineOptions).transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.objects.put(firstObject);
    });
    await createPostgresBackend(baselineOptions).transact(async (tx) => {
      await tx.objects.put(secondObject);
    });

    const cachedBytes = await readSnapshotCbor(cachedOptions);
    const baselineBytes = await readSnapshotCbor(baselineOptions);

    expect(Buffer.from(cachedBytes).equals(Buffer.from(baselineBytes))).toBe(
      true
    );
  });

  test("detects a cross-process write and falls back to a full decode instead of serving a stale hit", async () => {
    const options = createPostgresTestBackendOptions();
    const schema = createCanonicalKernelTestSchema();
    const objectA = await createStoredObjectRecord(new Uint8Array([10]), 2);
    const objectC = await createStoredObjectRecord(new Uint8Array([30]), 3);
    const objectB = await createStoredObjectRecord(new Uint8Array([20]), 4);
    const objectD = await createStoredObjectRecord(new Uint8Array([40]), 5);

    const hitsAndMisses = createHitMissCounter();
    const backendA = createPostgresBackend({
      ...options,
      snapshotCacheObserver: hitsAndMisses.observer,
    });

    // Miss #1: nothing memoized yet.
    await backendA.transact(async (tx) => {
      await tx.schemas.put(createStoredSchemaRecord(schema, 1));
      await tx.objects.put(objectA);
    });
    // Hit #1: same instance, no other writer in between.
    await backendA.transact(async (tx) => {
      await tx.objects.put(objectC);
    });

    expect(hitsAndMisses.counts()).toEqual({ hits: 1, misses: 1 });

    // A second, independent backend instance bound to the SAME schema/scope
    // simulates a different process/worker writing to this Scope's row.
    // backendA has no way to observe this except by re-hashing the row on
    // its next load.
    const backendB = createPostgresBackend(options);
    await backendB.transact(async (tx) => {
      await tx.objects.put(objectB);
    });

    // Miss #2: backendA's memoized hash no longer matches the row's bytes,
    // so it must fully decode -- and the decoded state must include
    // backendB's write, not just what backendA itself last saw.
    await backendA.transact(async (tx) => {
      await tx.objects.put(objectD);
    });

    expect(hitsAndMisses.counts()).toEqual({ hits: 1, misses: 2 });

    await backendA.transact(async (tx) => {
      expect(await tx.objects.get(objectA.hash)).toEqual(objectA);
      expect(await tx.objects.get(objectC.hash)).toEqual(objectC);
      expect(await tx.objects.get(objectB.hash)).toEqual(objectB);
      expect(await tx.objects.get(objectD.hash)).toEqual(objectD);
    });
  });

  test("rejects a corrupted snapshot payload on the next load", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);
    const schema = createCanonicalKernelTestSchema();

    await backend.transact(async (tx) => {
      await tx.schemas.put(createStoredSchemaRecord(schema, 1));
    });

    // Valid canonical deterministic CBOR (so decodeDeterministicKernelRecord
    // itself succeeds) of the wrong top-level shape (a string instead of the
    // snapshot object), so the corruption is caught by decodeSnapshot's own
    // shape guard rather than by the lower-level CBOR decoder -- this is the
    // scenario a byte-level row tamper (not merely truncation) realistically
    // produces once the tamper happens to still be valid CBOR.
    const corruptedBytes = encodeDeterministicKernelRecord(
      "corrupted-snapshot-payload"
    );
    await writeSnapshotCbor(options, corruptedBytes);

    let caught: unknown;
    try {
      await backend.transact(async (tx) => {
        await tx.schemas.get(schema.schemaId);
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TuvrenPersistenceError);
    expect(
      caught instanceof TuvrenPersistenceError ? caught.code : undefined
    ).toBe("postgres_backend_snapshot_payload_invalid");
  });

  test("a rolled-back transaction does not poison the cache", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);
    const schema = createCanonicalKernelTestSchema();
    const schemaRecord = createStoredSchemaRecord(schema, 1);
    const committedObject = await createStoredObjectRecord(
      new Uint8Array([99]),
      2
    );
    const neverCommittedObject = await createStoredObjectRecord(
      new Uint8Array([100]),
      3
    );

    // Commit a baseline the cache should remember.
    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.objects.put(committedObject);
    });

    // A transact() whose work callback throws AFTER mutating the draft must
    // roll back cleanly and must never let the draft it built become the
    // cached "committed" state.
    await expect(
      backend.transact(async (tx) => {
        await tx.objects.put(neverCommittedObject);
        throw new Error("simulated work failure after mutation");
      })
    ).rejects.toThrow("simulated work failure after mutation");

    // The next transact() must see the pre-failure committed state: the
    // rolled-back object must be absent, and the persisted bytes this
    // transact() commits must still descend from the real committed base,
    // not from the poisoned draft.
    await backend.transact(async (tx) => {
      expect(await tx.objects.get(committedObject.hash)).toEqual(
        committedObject
      );
      expect(await tx.objects.get(neverCommittedObject.hash)).toBeNull();
    });

    // Cross-check against a fresh, cache-less backend instance reading the
    // same row: if the rollback had poisoned backendA's cache, this
    // instance's independently-decoded view would disagree with what
    // backendA itself just asserted above.
    const independentBackend = createPostgresBackend(options);
    await independentBackend.transact(async (tx) => {
      expect(await tx.objects.get(committedObject.hash)).toEqual(
        committedObject
      );
      expect(await tx.objects.get(neverCommittedObject.hash)).toBeNull();
    });
  });

  test("decodeSnapshot(encodeSnapshot(cachedState)) round-trips a nontrivial committed state byte-for-byte", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);
    const schema = createCanonicalKernelTestSchema();
    const schemaRecord = createStoredSchemaRecord(schema, 1);
    const rootTurnTree = await createStoredTurnTreeRecord(
      schema,
      { "context.manifest": null, messages: [] },
      2
    );
    const rootTurnNode = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 3,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: rootTurnTree.hash,
    });
    const eventObject = await createStoredObjectRecord(
      new Uint8Array([1, 2, 3, 4, 5]),
      4
    );
    const childTurnTree = await createStoredTurnTreeRecord(
      schema,
      { "context.manifest": null, messages: [eventObject.hash] },
      5
    );
    const childTurnNode = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 6,
      eventHash: eventObject.hash,
      previousTurnNodeHash: rootTurnNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: childTurnTree.hash,
    });

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.objects.put(eventObject);
      await tx.turnTrees.put(rootTurnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(rootTurnTree, {
          "context.manifest": null,
          messages: [],
        })
      );
      await tx.turnNodes.put(rootTurnNode);
      await tx.turnTrees.put(childTurnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(childTurnTree, {
          "context.manifest": null,
          messages: [eventObject.hash],
        })
      );
      await tx.turnNodes.put(childTurnNode);
      await tx.threads.put({
        createdAtMs: 7,
        rootTurnNodeHash: rootTurnNode.hash,
        schemaId: schema.schemaId,
        threadId: "thread_snapshot_cache_roundtrip",
      });
      await tx.branches.set({
        branchId: "branch_snapshot_cache_roundtrip",
        createdAtMs: 8,
        headTurnNodeHash: childTurnNode.hash,
        threadId: "thread_snapshot_cache_roundtrip",
        updatedAtMs: 8,
      });
    });

    const persistedBytes = await readSnapshotCbor(options);
    const decoded = decodeSnapshot(persistedBytes);

    // Sanity: this is a genuinely nontrivial state, not an empty snapshot.
    expect(decoded.schemas.size).toBeGreaterThan(0);
    expect(decoded.objects.size).toBeGreaterThan(0);
    expect(decoded.turnTrees.size).toBeGreaterThan(0);
    expect(decoded.turnNodes.size).toBeGreaterThan(0);
    expect(decoded.threads.size).toBeGreaterThan(0);
    expect(decoded.branches.size).toBeGreaterThan(0);

    const reEncoded = encodeSnapshot(decoded);

    expect(Buffer.from(reEncoded).equals(Buffer.from(persistedBytes))).toBe(
      true
    );
  });
});

/** Small hit/miss counter built on {@link SnapshotCacheObserver}. */
function createHitMissCounter(): {
  counts(): { hits: number; misses: number };
  observer: SnapshotCacheObserver;
} {
  let hits = 0;
  let misses = 0;

  return {
    counts: () => ({ hits, misses }),
    observer: {
      recordHit: () => {
        hits += 1;
      },
      recordMiss: () => {
        misses += 1;
      },
    },
  };
}
