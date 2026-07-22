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
//
// The fault-hook-driven tests below (one per FaultPoint: "before-commit",
// "mid-commit", "after-commit-before-ack") close an M3 review
// recommendation by asserting this cache is never poisoned when a fault
// fires at any COMMIT-adjacent stage of the commit sequence -- whether that
// fault genuinely rolls the transaction back (before-commit) or fires after
// a real COMMIT has already succeeded (mid-commit, after-commit-before-ack).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TuvrenPersistenceError } from "@tuvren/core";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createFaultInjectingBackend,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
  type FaultPoint,
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

  test("a fault injected before COMMIT rolls back cleanly and does not poison the cache with the aborted draft", async () => {
    const options = createPostgresTestBackendOptions();
    const innerBackend = createPostgresBackend(options);
    const schema = createCanonicalKernelTestSchema();
    const committedObject = await createStoredObjectRecord(
      new Uint8Array([77]),
      2
    );
    const neverCommittedObject = await createStoredObjectRecord(
      new Uint8Array([78]),
      3
    );

    await innerBackend.transact(async (tx) => {
      await tx.schemas.put(createStoredSchemaRecord(schema, 1));
      await tx.objects.put(committedObject);
    });

    // "before-commit" fires after validateCommittedState but strictly
    // before persistStateSnapshot/COMMIT ever run, so the transaction
    // genuinely rolls back at the database level (unlike "mid-commit" and
    // "after-commit-before-ack", which let the real COMMIT succeed first
    // and only fail the caller's acknowledgment afterward -- not a rollback
    // scenario at all; see the fault-injected-after-COMMIT test below).
    const faultedBackend = createFaultInjectingBackend(innerBackend, {
      point: "before-commit",
      policy: "once",
    });

    await expect(
      faultedBackend.transact(async (tx) => {
        await tx.objects.put(neverCommittedObject);
      })
    ).rejects.toMatchObject({ code: "kernel_persistence_fault_injected" });

    // The next transact() (through the unwrapped inner backend, same
    // instance) must see the pre-fault committed state, proving the cache
    // was not poisoned by the fault-injected rollback (the fault fires
    // before persistStateSnapshot or COMMIT ever run, so this instance's
    // commit() closure -- and its snapshotCache.set() call -- never
    // executes for the faulted transaction).
    const secondObject = await createStoredObjectRecord(
      new Uint8Array([79]),
      4
    );
    await innerBackend.transact(async (tx) => {
      expect(await tx.objects.get(committedObject.hash)).toEqual(
        committedObject
      );
      expect(await tx.objects.get(neverCommittedObject.hash)).toBeNull();
      await tx.objects.put(secondObject);
    });

    const persistedBytes = await readSnapshotCbor(options);
    const independentBackend = createPostgresBackend(
      createPostgresTestBackendOptions({ schemaName: options.schemaName })
    );
    await independentBackend.transact(async (tx) => {
      expect(await tx.objects.get(committedObject.hash)).toEqual(
        committedObject
      );
      expect(await tx.objects.get(secondObject.hash)).toEqual(secondObject);
      expect(await tx.objects.get(neverCommittedObject.hash)).toBeNull();
    });
    expect(
      Buffer.from(await readSnapshotCbor(options)).equals(
        Buffer.from(persistedBytes)
      )
    ).toBe(true);
  }, 20_000);

  test("a mid-commit fault does not desynchronize the cache from its own already-committed write", async () => {
    await assertPostCommitFaultCacheStaysInSync("mid-commit", [81, 82]);
  }, 20_000);

  test("an after-commit-before-ack fault does not desynchronize the cache from its own already-committed write", async () => {
    await assertPostCommitFaultCacheStaysInSync(
      "after-commit-before-ack",
      [83, 84]
    );
  }, 20_000);

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

/**
 * Shared body for the "mid-commit" and "after-commit-before-ack" fault
 * points: both fire strictly AFTER the real COMMIT statement -- and this
 * instance's own `snapshotCache.set()` call -- have already run, so the
 * write genuinely persists even though the caller sees the `transact()`
 * call reject. This is a successful-write-failed-acknowledgment scenario,
 * not a rollback (contrast the "before-commit" test above, where the fault
 * fires before COMMIT and the write is genuinely aborted). The assertion
 * this proves is that the cache stays byte-for-byte in sync with the row it
 * was populated from, never silently diverging from what was actually
 * durably committed.
 */
async function assertPostCommitFaultCacheStaysInSync(
  point: FaultPoint,
  objectBytes: readonly [number, number]
): Promise<void> {
  const hitsAndMisses = createHitMissCounter();
  const options = createPostgresTestBackendOptions({
    snapshotCacheObserver: hitsAndMisses.observer,
  });
  const innerBackend = createPostgresBackend(options);
  const schema = createCanonicalKernelTestSchema();
  const [firstByte, secondByte] = objectBytes;
  const committedObject = await createStoredObjectRecord(
    new Uint8Array([firstByte]),
    2
  );
  const committedThroughFaultObject = await createStoredObjectRecord(
    new Uint8Array([secondByte]),
    3
  );

  await innerBackend.transact(async (tx) => {
    await tx.schemas.put(createStoredSchemaRecord(schema, 1));
    await tx.objects.put(committedObject);
  });

  const faultedBackend = createFaultInjectingBackend(innerBackend, {
    point,
    policy: "once",
  });

  await expect(
    faultedBackend.transact(async (tx) => {
      await tx.objects.put(committedThroughFaultObject);
    })
  ).rejects.toMatchObject({ code: "kernel_persistence_fault_injected" });

  // The faulted transact() call already primed this instance's cache before
  // the fault fired, so the next transact() on the SAME instance must be a
  // cache HIT that already reflects committedThroughFaultObject. A cache
  // MISS here would still self-correct via decodeSnapshot, but a hit
  // serving anything other than the real committed state would prove the
  // cache had gone out of sync with the row -- so the hit/miss tally below
  // is as load-bearing as the object-presence assertions.
  await innerBackend.transact(async (tx) => {
    expect(await tx.objects.get(committedObject.hash)).toEqual(committedObject);
    expect(await tx.objects.get(committedThroughFaultObject.hash)).toEqual(
      committedThroughFaultObject
    );
  });

  expect(hitsAndMisses.counts()).toEqual({ hits: 2, misses: 1 });

  const persistedBytes = await readSnapshotCbor(options);
  const independentBackend = createPostgresBackend(
    createPostgresTestBackendOptions({ schemaName: options.schemaName })
  );
  await independentBackend.transact(async (tx) => {
    expect(await tx.objects.get(committedObject.hash)).toEqual(committedObject);
    expect(await tx.objects.get(committedThroughFaultObject.hash)).toEqual(
      committedThroughFaultObject
    );
  });
  expect(
    Buffer.from(await readSnapshotCbor(options)).equals(
      Buffer.from(persistedBytes)
    )
  ).toBe(true);
}

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
