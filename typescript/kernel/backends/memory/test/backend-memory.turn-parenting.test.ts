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
import { createMemoryBackend } from "@tuvren/backend-memory";
import { TuvrenPersistenceError } from "@tuvren/core";
import {
  encodeDeterministicKernelRecord,
  type StoredBranch,
  type StoredRun,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
} from "@tuvren/kernel-protocol";
import {
  createHashFromIndex,
  createCanonicalKernelTestSchema as createSchema,
  createStoredObjectRecord as createStoredObject,
  createStoredOrderedPathChunkRecord as createStoredOrderedPathChunk,
  createStoredSchemaRecord as createStoredSchema,
  createStoredTurnNodeRecord as createStoredTurnNode,
  createStoredTurnTreeRecord as createStoredTurnTree,
} from "@tuvren/kernel-testkit";
import { createCanonicalTurnTreePaths } from "./backend-memory-test-helpers.js";

describe("@tuvren/backend-memory turn parenting", () => {
  test("rejects turns whose parent is not the immediate predecessor or contiguous start", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const turnTree = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [] },
      2
    );
    const rootNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 3,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const nodeA = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const nodeB = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: nodeA.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const nodeC = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 6,
      eventHash: null,
      previousTurnNodeHash: nodeB.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 7,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_turn_parent",
    };
    const branch: StoredBranch = {
      branchId: "branch_turn_parent",
      createdAtMs: 8,
      headTurnNodeHash: nodeC.hash,
      threadId: thread.threadId,
      updatedAtMs: 8,
    };
    const turn1: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 9,
      headTurnNodeHash: nodeA.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_parent_1",
      updatedAtMs: 9,
    };
    const turn2: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 10,
      headTurnNodeHash: nodeB.hash,
      parentTurnId: "turn_parent_1",
      startTurnNodeHash: nodeA.hash,
      threadId: thread.threadId,
      turnId: "turn_parent_2",
      updatedAtMs: 10,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(rootNode);
      await tx.turnNodes.put(nodeA);
      await tx.turnNodes.put(nodeB);
      await tx.turnNodes.put(nodeC);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
      await tx.turns.set(turn1);
      await tx.turns.set(turn2);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.turns.set({
          branchId: branch.branchId,
          createdAtMs: 11,
          headTurnNodeHash: nodeC.hash,
          parentTurnId: turn1.turnId,
          startTurnNodeHash: nodeB.hash,
          threadId: thread.threadId,
          turnId: "turn_parent_3",
          updatedAtMs: 11,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.turns.set({
          branchId: branch.branchId,
          createdAtMs: 12,
          headTurnNodeHash: nodeC.hash,
          parentTurnId: turn1.turnId,
          startTurnNodeHash: nodeC.hash,
          threadId: thread.threadId,
          turnId: "turn_parent_bad_start",
          updatedAtMs: 12,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects null parent turns when a branch-local predecessor exists", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const turnTree = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [] },
      2
    );
    const rootNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 3,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const nodeA = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const nodeB = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: nodeA.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_null_parent",
    };
    const branch: StoredBranch = {
      branchId: "branch_null_parent",
      createdAtMs: 7,
      headTurnNodeHash: nodeB.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(rootNode);
      await tx.turnNodes.put(nodeA);
      await tx.turnNodes.put(nodeB);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
      await tx.turns.set({
        branchId: branch.branchId,
        createdAtMs: 8,
        headTurnNodeHash: nodeA.hash,
        parentTurnId: null,
        startTurnNodeHash: rootNode.hash,
        threadId: thread.threadId,
        turnId: "turn_null_parent_1",
        updatedAtMs: 8,
      });
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.turns.set({
          branchId: branch.branchId,
          createdAtMs: 9,
          headTurnNodeHash: nodeB.hash,
          parentTurnId: null,
          startTurnNodeHash: nodeA.hash,
          threadId: thread.threadId,
          turnId: "turn_null_parent_2",
          updatedAtMs: 9,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("accepts fork parent links and rejects stale same-branch parent links", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const turnTree = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [] },
      2
    );
    const siblingTurnTree = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [createHashFromIndex(7000)] },
      3
    );
    const rootNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 3,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const sharedHead = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const mainNext = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 6,
      eventHash: null,
      previousTurnNodeHash: sharedHead.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const mainTail = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 8,
      eventHash: null,
      previousTurnNodeHash: mainNext.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const siblingNext = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 9,
      eventHash: null,
      previousTurnNodeHash: sharedHead.hash,
      schemaId: schema.schemaId,
      turnTreeHash: siblingTurnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 8,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_branch_parent",
    };
    const mainBranch: StoredBranch = {
      branchId: "branch_parent_main",
      createdAtMs: 9,
      headTurnNodeHash: mainNext.hash,
      threadId: thread.threadId,
      updatedAtMs: 9,
    };
    const siblingBranch: StoredBranch = {
      branchId: "branch_parent_sibling",
      createdAtMs: 10,
      headTurnNodeHash: siblingNext.hash,
      threadId: thread.threadId,
      updatedAtMs: 10,
    };
    const mainTurn1: StoredTurn = {
      branchId: mainBranch.branchId,
      createdAtMs: 11,
      headTurnNodeHash: sharedHead.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_parent_main_1",
      updatedAtMs: 11,
    };
    const siblingTurn: StoredTurn = {
      branchId: siblingBranch.branchId,
      createdAtMs: 13,
      headTurnNodeHash: siblingNext.hash,
      parentTurnId: mainTurn1.turnId,
      startTurnNodeHash: sharedHead.hash,
      threadId: thread.threadId,
      turnId: "turn_parent_sibling_2",
      updatedAtMs: 13,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTrees.put(siblingTurnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(siblingTurnTree, [
          createHashFromIndex(7000),
        ])
      );
      await tx.turnNodes.put(rootNode);
      await tx.turnNodes.put(sharedHead);
      await tx.turnNodes.put(mainNext);
      await tx.turnNodes.put(mainTail);
      await tx.turnNodes.put(siblingNext);
      await tx.threads.put(thread);
      await tx.branches.set(mainBranch);
      await tx.branches.set(siblingBranch);
      await tx.turns.set(mainTurn1);
    });

    await backend.transact(async (tx) => {
      await tx.turns.set({
        branchId: mainBranch.branchId,
        createdAtMs: 12,
        headTurnNodeHash: mainNext.hash,
        parentTurnId: mainTurn1.turnId,
        startTurnNodeHash: sharedHead.hash,
        threadId: thread.threadId,
        turnId: "turn_parent_main_2",
        updatedAtMs: 12,
      });
    });

    await backend.transact(async (tx) => {
      await tx.turns.set(siblingTurn);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.turns.set({
          branchId: mainBranch.branchId,
          createdAtMs: 14,
          headTurnNodeHash: mainTail.hash,
          parentTurnId: mainTurn1.turnId,
          startTurnNodeHash: mainNext.hash,
          threadId: thread.threadId,
          turnId: "turn_parent_main_stale",
          updatedAtMs: 14,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects metadata drift on immutable hash-addressed records", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const objectRecord = await createStoredObject(new Uint8Array([1, 2, 3]), 2);
    const turnTree = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [] },
      3
    );
    const chunkRecord = await createStoredOrderedPathChunk(
      [createHashFromIndex(1)],
      4
    );
    const rootNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const threadRecord: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_created_at_conflict",
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.objects.put(objectRecord);
      await tx.turnTrees.put(turnTree);
      await tx.orderedPathChunks.put(chunkRecord);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(rootNode);
      await tx.threads.put(threadRecord);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.objects.put({
          ...objectRecord,
          createdAtMs: 999,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put({
          ...schemaRecord,
          createdAtMs: 999,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.turnTrees.put({
          ...turnTree,
          createdAtMs: 999,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.orderedPathChunks.put({
          ...chunkRecord,
          createdAtMs: 999,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.turnNodes.put({
          ...rootNode,
          createdAtMs: 999,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.threads.put({
          ...threadRecord,
          createdAtMs: 999,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects metadata drift for staged results with the same run and task identity", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const objectRecord = await createStoredObject(new Uint8Array([1, 2, 3]), 2);
    const turnTree = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [] },
      3
    );
    const rootNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 5,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_staged_metadata",
    };
    const branch: StoredBranch = {
      branchId: "branch_staged_metadata",
      createdAtMs: 6,
      headTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 6,
    };
    const turn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 7,
      headTurnNodeHash: rootNode.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_staged_metadata",
      updatedAtMs: 7,
    };
    const run: StoredRun = {
      branchId: branch.branchId,
      createdAtMs: 8,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 0,
      runId: "run_staged_metadata",
      schemaId: schema.schemaId,
      startTurnNodeHash: rootNode.hash,
      status: "running",
      stepSequenceCbor: encodeDeterministicKernelRecord([
        {
          deterministic: false,
          id: "model_call",
          sideEffects: false,
        },
      ]),
      turnId: turn.turnId,
      updatedAtMs: 8,
    };
    const stagedResult: StoredStagedResult = {
      createdAtMs: 9,
      objectHash: objectRecord.hash,
      objectType: "message",
      runId: run.runId,
      status: "completed",
      taskId: "task_staged_metadata",
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.objects.put(objectRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(rootNode);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
      await tx.turns.set(turn);
      await tx.runs.set(run);
      await tx.stagedResults.set(stagedResult);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.stagedResults.set({
          ...stagedResult,
          createdAtMs: 999,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });
});
