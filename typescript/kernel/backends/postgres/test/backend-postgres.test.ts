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
import type {
  RuntimeBackend,
  StoredBranch,
  StoredThread,
} from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createHashFromIndex,
  createStoredObjectRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
  registerBackendConformanceSuite,
  registerBackendInvariantSuite,
  registerBackendRecoverySuite,
} from "@tuvren/kernel-testkit";
import type { Sql } from "postgres";
import { createPostgresBackend } from "../src/index.js";
import {
  createEmptyState,
  validateCommittedState,
} from "../src/lib/memory-backend-state.js";
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

registerBackendConformanceSuite({
  createBackend: () =>
    createPostgresBackend(createPostgresTestBackendOptions()),
  suiteName: "@tuvren/backend-postgres shared conformance",
  testApi: { describe, test },
});

registerBackendInvariantSuite({
  createBackend: () =>
    createPostgresBackend(createPostgresTestBackendOptions()),
  suiteName: "@tuvren/backend-postgres shared invariants",
  testApi: { describe, test },
});

registerBackendRecoverySuite({
  createBackend: () =>
    createPostgresBackend(createPostgresTestBackendOptions()),
  suiteName: "@tuvren/backend-postgres shared recovery",
  testApi: { describe, test },
});

describe("@tuvren/backend-postgres", () => {
  test("persists records across backend re-instantiation within the same schema", async () => {
    const options = createPostgresTestBackendOptions();
    const firstBackend = createPostgresBackend(options);
    const objectRecord = await createStoredObjectRecord(
      new Uint8Array([1, 2, 3]),
      1
    );

    await firstBackend.transact(async (tx) => {
      await tx.objects.put(objectRecord);
    });

    const reopenedBackend = createPostgresBackend(options);

    await reopenedBackend.transact(async (tx) => {
      expect(await tx.objects.get(objectRecord.hash)).toEqual(objectRecord);
    });
  });

  test("retries initialization after a transient bootstrap failure", async () => {
    interface TestablePostgresBackend extends RuntimeBackend {
      destroy(options?: { dropSchema?: boolean }): Promise<void>;
      readonly sql: Sql;
    }

    const backend = createPostgresBackend(
      createPostgresTestBackendOptions()
    ) as TestablePostgresBackend;
    const originalBegin = backend.sql.begin.bind(backend.sql);
    let attempts = 0;

    backend.sql.begin = (async (...args: Parameters<Sql["begin"]>) => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error("transient bootstrap failure");
      }

      return await originalBegin(...args);
    }) as Sql["begin"];

    try {
      expect(await backend.health()).toEqual({
        ok: false,
        reason: "transient bootstrap failure",
      });
      expect(await backend.health()).toEqual({ ok: true });
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });
});

// Issue #108 M2: `assertTurnNodeBelongsToThread` now resolves every turn
// node's root+depth through one `TurnNodeLineageIndex` shared across the
// whole `validateCommittedState` pass instead of walking
// `previousTurnNodeHash` ancestry fresh per call. These cases prove that
// memoization did not change the two failure modes the walk itself detects:
// a cyclic lineage, and a lineage that reaches a different thread's root.
// The public write path forbids constructing either shape directly, so
// these craft a state and call the validator directly -- no database
// connection needed, mirroring the memory backend's equivalent coverage.
describe("@tuvren/backend-postgres validateCommittedState turn node lineage invariant (issue #108 M2)", () => {
  test("rejects a branch head whose turn node lineage is cyclic", async () => {
    const schema = createCanonicalKernelTestSchema();
    const turnTree = await createStoredTurnTreeRecord(
      schema,
      { "context.manifest": null, messages: [] },
      30
    );
    // `hashTurnNodeIdentity` does not fold `createdAtMs` into a turn node's
    // content-addressed hash -- only a distinct `eventHash` keeps these
    // three otherwise-identically-shaped nodes from colliding onto the same
    // map key.
    const rootNode = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 31,
      eventHash: createHashFromIndex(300),
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const nodeA = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 32,
      eventHash: createHashFromIndex(301),
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const nodeB = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 33,
      eventHash: createHashFromIndex(302),
      previousTurnNodeHash: nodeA.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    // The public write path can never produce a real cycle (a node's hash is
    // derived from its own previousTurnNodeHash, so two nodes cannot both
    // legitimately point at each other); craft one directly onto the loaded
    // state, at the same key `nodeA.hash` already occupies, the way a
    // database mutated outside the backend could.
    const cyclicNodeA = { ...nodeA, previousTurnNodeHash: nodeB.hash };

    const thread: StoredThread = {
      createdAtMs: 34,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_cycle",
    };
    const branch: StoredBranch = {
      branchId: "branch_cycle",
      createdAtMs: 35,
      headTurnNodeHash: cyclicNodeA.hash,
      threadId: thread.threadId,
      updatedAtMs: 35,
    };

    const state = createEmptyState();
    state.turnNodes.set(rootNode.hash, rootNode);
    state.turnNodes.set(cyclicNodeA.hash, cyclicNodeA);
    state.turnNodes.set(nodeB.hash, nodeB);
    state.threads.set(thread.threadId, thread);
    state.branches.set(branch.branchId, branch);

    expect(() => validateCommittedState(state, createEmptyState())).toThrow(
      "must not traverse a cyclic turn node lineage"
    );
  });

  test("rejects a branch head whose turn node lineage reaches a different thread's root", async () => {
    const schema = createCanonicalKernelTestSchema();
    const turnTree = await createStoredTurnTreeRecord(
      schema,
      { "context.manifest": null, messages: [] },
      40
    );
    // Distinct `eventHash` values, for the same reason as the cyclic-lineage
    // test above: these three would otherwise collide onto one map key.
    const ownRoot = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 41,
      eventHash: createHashFromIndex(400),
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const foreignRoot = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 42,
      eventHash: createHashFromIndex(401),
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const foreignChild = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 43,
      eventHash: createHashFromIndex(402),
      previousTurnNodeHash: foreignRoot.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });

    const thread: StoredThread = {
      createdAtMs: 44,
      rootTurnNodeHash: ownRoot.hash,
      schemaId: schema.schemaId,
      threadId: "thread_cross_root",
    };
    const branch: StoredBranch = {
      branchId: "branch_cross_root",
      createdAtMs: 45,
      // Genuinely on the foreign root's lineage, not the owning thread's own
      // root -- a real cross-thread-root membership violation, not a cycle.
      headTurnNodeHash: foreignChild.hash,
      threadId: thread.threadId,
      updatedAtMs: 45,
    };

    const state = createEmptyState();
    state.turnNodes.set(ownRoot.hash, ownRoot);
    state.turnNodes.set(foreignRoot.hash, foreignRoot);
    state.turnNodes.set(foreignChild.hash, foreignChild);
    state.threads.set(thread.threadId, thread);
    state.branches.set(branch.branchId, branch);

    expect(() => validateCommittedState(state, createEmptyState())).toThrow(
      "must belong to the referenced thread by lineage walk"
    );
  });
});
