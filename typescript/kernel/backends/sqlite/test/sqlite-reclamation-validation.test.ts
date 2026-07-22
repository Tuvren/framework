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

// Issue #108 M6 — direct unit coverage for `assertReclamationSurvivorInvariants`,
// the targeted post-sweep check that replaces `reclaim()`'s former second full
// `loadValidatedState` pass. `doesNotThrow` proves a genuinely consistent
// post-sweep state passes; every other case starts from that same consistent
// state and corrupts exactly one cross-reference the way a *defective* sweep
// could (deleting a record something else still references), asserting the
// check rejects with the specific error code the brief asks for rather than
// silently letting the corruption reach `COMMIT`.

import { doesNotThrow, throws } from "node:assert/strict";
import { describe, test } from "node:test";
import { TuvrenPersistenceError } from "@tuvren/core";
import {
  encodeDeterministicKernelRecord,
  type RunStatus,
  type StoredBranch,
  type StoredRun,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
  type StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createStoredObjectRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "@tuvren/kernel-testkit";
import { assertReclamationSurvivorInvariants } from "../src/lib/sqlite-reclamation-validation.js";
import {
  type BackendState,
  createEmptyState,
} from "../src/lib/sqlite-records.js";

const SCHEMA_ID = "schema_reclaim_survivor";

interface BaseFixture {
  branch: StoredBranch;
  childNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  grandchildNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  object: Awaited<ReturnType<typeof createStoredObjectRecord>>;
  rootNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  run: StoredRun;
  stagedResult: StoredStagedResult;
  state: BackendState;
  thread: StoredThread;
  turn: StoredTurn;
  turnTreePath: StoredTurnTreePath;
}

/**
 * Builds a fully cross-referenced, check-passing post-sweep `BackendState`:
 * a three-node turn node chain (root -> child -> grandchild), a thread and
 * live branch rooted on it, a turn and a run spanning it, a staged result
 * the child node consumed, and a single-collection turn-tree path resolving
 * to the same object. Every test below starts from a fresh copy of this and
 * corrupts exactly one reference.
 */
async function buildBaseFixture(): Promise<BaseFixture> {
  const object = await createStoredObjectRecord(
    new Uint8Array([1, 2, 3]),
    1000
  );
  const schema = createCanonicalKernelTestSchema();
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    { "context.manifest": object.hash, messages: [] },
    999
  );

  const rootNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 1001,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: SCHEMA_ID,
    turnTreeHash: turnTree.hash,
  });
  const childNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [
      {
        objectHash: object.hash,
        objectType: "application/octet-stream",
        status: "completed",
        taskId: "task_child",
        timestamp: 1002,
      },
    ],
    createdAtMs: 1002,
    eventHash: null,
    previousTurnNodeHash: rootNode.hash,
    schemaId: SCHEMA_ID,
    turnTreeHash: turnTree.hash,
  });
  const grandchildNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 1003,
    eventHash: null,
    previousTurnNodeHash: childNode.hash,
    schemaId: SCHEMA_ID,
    turnTreeHash: turnTree.hash,
  });

  const thread: StoredThread = {
    createdAtMs: 1004,
    rootTurnNodeHash: rootNode.hash,
    schemaId: SCHEMA_ID,
    threadId: "thread_survivor",
  };
  const branch: StoredBranch = {
    branchId: "branch_survivor",
    createdAtMs: 1005,
    headTurnNodeHash: grandchildNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 1005,
  };
  const turn: StoredTurn = {
    branchId: branch.branchId,
    createdAtMs: 1006,
    headTurnNodeHash: grandchildNode.hash,
    parentTurnId: null,
    startTurnNodeHash: rootNode.hash,
    threadId: thread.threadId,
    turnId: "turn_survivor",
    updatedAtMs: 1006,
  };
  const status: RunStatus = "completed";
  const run: StoredRun = {
    branchId: branch.branchId,
    createdAtMs: 1007,
    createdTurnNodesCbor: encodeDeterministicKernelRecord([
      childNode.hash,
      grandchildNode.hash,
    ]),
    currentStepIndex: 1,
    runId: "run_survivor",
    schemaId: SCHEMA_ID,
    startTurnNodeHash: rootNode.hash,
    status,
    stepSequenceCbor: encodeDeterministicKernelRecord([]),
    turnId: turn.turnId,
    updatedAtMs: 1007,
  };
  const stagedResult: StoredStagedResult = {
    createdAtMs: 1008,
    objectHash: object.hash,
    objectType: "application/octet-stream",
    runId: run.runId,
    status: "completed",
    taskId: "task_child",
  };
  const turnTreePath: StoredTurnTreePath = {
    collectionKind: "single",
    path: "context.manifest",
    singleHash: object.hash,
    turnTreeHash: turnTree.hash,
  };

  const state = createEmptyState();
  state.objects.set(object.hash, object);
  state.turnTrees.set(turnTree.hash, turnTree);
  state.turnNodes.set(rootNode.hash, rootNode);
  state.turnNodes.set(childNode.hash, childNode);
  state.turnNodes.set(grandchildNode.hash, grandchildNode);
  state.threads.set(thread.threadId, thread);
  state.branches.set(branch.branchId, branch);
  state.turns.set(turn.turnId, turn);
  state.runs.set(run.runId, run);
  state.stagedResults.set(
    run.runId,
    new Map([[stagedResult.taskId, stagedResult]])
  );
  state.turnTreePaths.set(
    turnTree.hash,
    new Map([[turnTreePath.path, turnTreePath]])
  );

  return {
    branch,
    childNode,
    grandchildNode,
    object,
    rootNode,
    run,
    stagedResult,
    state,
    thread,
    turn,
    turnTreePath,
  };
}

describe("assertReclamationSurvivorInvariants (issue #108 M6)", () => {
  test("accepts a fully consistent post-sweep state", async () => {
    const { state } = await buildBaseFixture();

    doesNotThrow(() => assertReclamationSurvivorInvariants(state));
  });

  test("rejects a surviving branch whose head turn node a defective sweep deleted", async () => {
    const { state, grandchildNode } = await buildBaseFixture();
    state.turnNodes.delete(grandchildNode.hash);

    throws(
      () => assertReclamationSurvivorInvariants(state),
      (error: unknown) =>
        error instanceof TuvrenPersistenceError &&
        error.code === "sqlite_backend_missing_turn_node_reference"
    );
  });

  test("rejects a surviving turn node whose ancestor a defective sweep deleted", async () => {
    const { state, childNode } = await buildBaseFixture();
    // The grandchild (branch head, still present) descends from childNode,
    // which descends from rootNode. Deleting the *middle* node leaves the
    // branch head's own existence intact (isolating this from the previous
    // test) while breaking the lineage chain the grandchild depends on.
    state.turnNodes.delete(childNode.hash);

    throws(
      () => assertReclamationSurvivorInvariants(state),
      (error: unknown) =>
        error instanceof TuvrenPersistenceError &&
        error.code === "sqlite_backend_missing_turn_node_reference"
    );
  });

  test("rejects a turn node whose consumedStagedResultsCbor references an object a defective sweep deleted", async () => {
    const { state, object } = await buildBaseFixture();
    state.objects.delete(object.hash);

    throws(
      () => assertReclamationSurvivorInvariants(state),
      (error: unknown) =>
        error instanceof TuvrenPersistenceError &&
        error.code === "sqlite_backend_missing_object_reference"
    );
  });

  test("rejects a run whose createdTurnNodesCbor references a turn node a defective sweep deleted", async () => {
    const { state, grandchildNode, branch, turn, rootNode } =
      await buildBaseFixture();
    // Rebase the branch/turn heads onto rootNode, which does not depend on
    // grandchildNode, so deleting grandchildNode below isolates the
    // run.createdTurnNodesCbor check from the branch-head/turn-reference
    // checks the earlier tests already cover.
    state.branches.set(branch.branchId, {
      ...branch,
      headTurnNodeHash: rootNode.hash,
    });
    state.turns.set(turn.turnId, {
      ...turn,
      headTurnNodeHash: rootNode.hash,
    });
    state.turnNodes.delete(grandchildNode.hash);

    throws(
      () => assertReclamationSurvivorInvariants(state),
      (error: unknown) =>
        error instanceof TuvrenPersistenceError &&
        error.code === "sqlite_backend_missing_turn_node_reference"
    );
  });

  test("rejects a staged result whose run a defective sweep deleted", async () => {
    const { state, run } = await buildBaseFixture();
    state.runs.delete(run.runId);

    throws(
      () => assertReclamationSurvivorInvariants(state),
      (error: unknown) =>
        error instanceof TuvrenPersistenceError &&
        error.code === "sqlite_backend_missing_run_reference"
    );
  });

  test("rejects a turn-tree path whose resolved object a defective sweep deleted", async () => {
    const { state, object } = await buildBaseFixture();
    // Remove every reference to `object` other than the turn-tree path's own
    // single_hash, so this test isolates that specific resolution instead of
    // re-triggering the consumedStagedResultsCbor / stagedResult checks that
    // also reference the same object hash in the base fixture.
    for (const turnNode of state.turnNodes.values()) {
      turnNode.consumedStagedResultsCbor = encodeDeterministicKernelRecord([]);
    }
    state.stagedResults.clear();
    state.objects.delete(object.hash);

    throws(
      () => assertReclamationSurvivorInvariants(state),
      (error: unknown) =>
        error instanceof TuvrenPersistenceError &&
        error.code === "sqlite_backend_missing_object_reference"
    );
  });
});
