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
  type StoredThread,
  type StoredTurn,
} from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema as createSchema,
  createStoredSchemaRecord as createStoredSchema,
  createStoredTurnNodeRecord as createStoredTurnNode,
  createStoredTurnTreeRecord as createStoredTurnTree,
} from "@tuvren/kernel-testkit";
import { createCanonicalTurnTreePaths } from "./backend-memory-test-helpers.js";

describe("@tuvren/backend-memory rollback", () => {
  test("allows replacement runs to be created before a paused run is failed within one transaction", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const turnTree = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [] },
      2
    );
    const turnNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 3,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 4,
      rootTurnNodeHash: turnNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_replacement_run_order",
    };
    const branch: StoredBranch = {
      branchId: "branch_replacement_run_order",
      createdAtMs: 5,
      headTurnNodeHash: turnNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 5,
    };
    const turn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 6,
      headTurnNodeHash: turnNode.hash,
      parentTurnId: null,
      startTurnNodeHash: turnNode.hash,
      threadId: thread.threadId,
      turnId: "turn_replacement_run_order",
      updatedAtMs: 6,
    };
    const pausedRun: StoredRun = {
      branchId: branch.branchId,
      createdAtMs: 7,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 0,
      runId: "run_replacement_old",
      schemaId: schema.schemaId,
      startTurnNodeHash: turnNode.hash,
      status: "paused",
      stepSequenceCbor: encodeDeterministicKernelRecord([
        {
          deterministic: false,
          id: "model_call",
          sideEffects: false,
        },
      ]),
      turnId: turn.turnId,
      updatedAtMs: 7,
    };
    const replacementRun: StoredRun = {
      branchId: branch.branchId,
      createdAtMs: 8,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 0,
      runId: "run_replacement_new",
      schemaId: schema.schemaId,
      startTurnNodeHash: turnNode.hash,
      status: "running",
      stepSequenceCbor: encodeDeterministicKernelRecord([
        {
          deterministic: false,
          id: "tool_execution",
          sideEffects: true,
        },
      ]),
      turnId: turn.turnId,
      updatedAtMs: 8,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(turnNode);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
      await tx.turns.set(turn);
      await tx.runs.set({
        ...pausedRun,
        status: "running",
      });
      await tx.runs.set(pausedRun);
    });

    await backend.transact(async (tx) => {
      await tx.runs.set(replacementRun);
      await tx.runs.set({
        ...pausedRun,
        status: "failed",
        updatedAtMs: 8,
      });
    });

    await backend.transact(async (tx) => {
      expect(await tx.runs.get(pausedRun.runId)).toEqual({
        ...pausedRun,
        status: "failed",
        updatedAtMs: 8,
      });
      expect(await tx.runs.get(replacementRun.runId)).toEqual(replacementRun);
    });
  });

  test("allows child turns to be written before their parent in the same transaction", async () => {
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
      threadId: "thread_turn_parent_order",
    };
    const branch: StoredBranch = {
      branchId: "branch_turn_parent_order",
      createdAtMs: 7,
      headTurnNodeHash: nodeB.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };
    const parentTurn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 8,
      headTurnNodeHash: nodeA.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_parent_order_parent",
      updatedAtMs: 8,
    };
    const childTurn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 9,
      headTurnNodeHash: nodeB.hash,
      parentTurnId: parentTurn.turnId,
      startTurnNodeHash: nodeA.hash,
      threadId: thread.threadId,
      turnId: "turn_parent_order_child",
      updatedAtMs: 9,
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
      await tx.turns.set(childTurn);
      await tx.turns.set(parentTurn);
    });

    await backend.transact(async (tx) => {
      expect(await tx.turns.get(parentTurn.turnId)).toEqual(parentTurn);
      expect(await tx.turns.get(childTurn.turnId)).toEqual(childTurn);
    });
  });

  test("allows archive branches to be written after the source branch rewind in the same transaction", async () => {
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
    const middleNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const headNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: middleNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_archive_write_order",
    };
    const branch: StoredBranch = {
      branchId: "branch_archive_write_order",
      createdAtMs: 7,
      headTurnNodeHash: headNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };
    const archiveBranch: StoredBranch = {
      archivedFromBranchId: branch.branchId,
      branchId: "branch_archive_write_order_archive",
      createdAtMs: 8,
      headTurnNodeHash: headNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 8,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(rootNode);
      await tx.turnNodes.put(middleNode);
      await tx.turnNodes.put(headNode);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
    });

    await backend.transact(async (tx) => {
      await tx.branches.set({
        ...branch,
        headTurnNodeHash: middleNode.hash,
        updatedAtMs: 8,
      });
      await tx.branches.set(archiveBranch);
    });

    await backend.transact(async (tx) => {
      expect(await tx.branches.get(branch.branchId)).toEqual({
        ...branch,
        headTurnNodeHash: middleNode.hash,
        updatedAtMs: 8,
      });
      expect(await tx.branches.get(archiveBranch.branchId)).toEqual(
        archiveBranch
      );
    });
  });

  test("rejects backward rollback transactions that leave a newly created active run on the archived segment", async () => {
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
    const middleNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const headNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: middleNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_backward_new_run",
    };
    const branch: StoredBranch = {
      branchId: "branch_backward_new_run",
      createdAtMs: 7,
      headTurnNodeHash: headNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };
    const turn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 8,
      headTurnNodeHash: headNode.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_backward_new_run",
      updatedAtMs: 8,
    };
    const newActiveRun: StoredRun = {
      branchId: branch.branchId,
      createdAtMs: 9,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 0,
      runId: "run_backward_new_run",
      schemaId: schema.schemaId,
      startTurnNodeHash: headNode.hash,
      status: "running",
      stepSequenceCbor: encodeDeterministicKernelRecord([
        {
          deterministic: false,
          id: "model_call",
          sideEffects: false,
        },
      ]),
      turnId: turn.turnId,
      updatedAtMs: 9,
    };
    const archiveBranch: StoredBranch = {
      archivedFromBranchId: branch.branchId,
      branchId: "branch_backward_new_run_archive",
      createdAtMs: 10,
      headTurnNodeHash: headNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 10,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(rootNode);
      await tx.turnNodes.put(middleNode);
      await tx.turnNodes.put(headNode);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
      await tx.turns.set(turn);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.runs.set(newActiveRun);
        await tx.branches.set(archiveBranch);
        await tx.branches.set({
          ...branch,
          headTurnNodeHash: middleNode.hash,
          updatedAtMs: 10,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects threads that reuse another thread's root turn node", async () => {
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

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.turnTrees.put(turnTree);
        await tx.turnTreePaths.putMany(
          createCanonicalTurnTreePaths(turnTree, [])
        );
        await tx.turnNodes.put(rootNode);
        await tx.threads.put({
          createdAtMs: 4,
          rootTurnNodeHash: rootNode.hash,
          schemaId: schema.schemaId,
          threadId: "thread_duplicate_root_a",
        });
        await tx.threads.put({
          createdAtMs: 5,
          rootTurnNodeHash: rootNode.hash,
          schemaId: schema.schemaId,
          threadId: "thread_duplicate_root_b",
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects runs whose created turn nodes are not lineage ordered", async () => {
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
    const middleNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const headNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: middleNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_created_nodes_order",
    };
    const branch: StoredBranch = {
      branchId: "branch_created_nodes_order",
      createdAtMs: 7,
      headTurnNodeHash: headNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };
    const turn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 8,
      headTurnNodeHash: headNode.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_created_nodes_order",
      updatedAtMs: 8,
    };

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.turnTrees.put(turnTree);
        await tx.turnTreePaths.putMany(
          createCanonicalTurnTreePaths(turnTree, [])
        );
        await tx.turnNodes.put(rootNode);
        await tx.turnNodes.put(middleNode);
        await tx.turnNodes.put(headNode);
        await tx.threads.put(thread);
        await tx.branches.set(branch);
        await tx.turns.set(turn);
        await tx.runs.set({
          branchId: branch.branchId,
          createdAtMs: 9,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            headNode.hash,
            middleNode.hash,
          ]),
          currentStepIndex: 0,
          runId: "run_created_nodes_order",
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
          updatedAtMs: 9,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects runs whose created turn nodes repeat hashes", async () => {
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
    const headNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 5,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_created_nodes_duplicate",
    };
    const branch: StoredBranch = {
      branchId: "branch_created_nodes_duplicate",
      createdAtMs: 6,
      headTurnNodeHash: headNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 6,
    };
    const turn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 7,
      headTurnNodeHash: headNode.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_created_nodes_duplicate",
      updatedAtMs: 7,
    };

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.turnTrees.put(turnTree);
        await tx.turnTreePaths.putMany(
          createCanonicalTurnTreePaths(turnTree, [])
        );
        await tx.turnNodes.put(rootNode);
        await tx.turnNodes.put(headNode);
        await tx.threads.put(thread);
        await tx.branches.set(branch);
        await tx.turns.set(turn);
        await tx.runs.set({
          branchId: branch.branchId,
          createdAtMs: 8,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            headNode.hash,
            headNode.hash,
          ]),
          currentStepIndex: 0,
          runId: "run_created_nodes_duplicate",
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
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects runs whose created turn node ledger skips intermediate nodes", async () => {
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
    const middleNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const headNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: middleNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_created_nodes_subset",
    };
    const branch: StoredBranch = {
      branchId: "branch_created_nodes_subset",
      createdAtMs: 7,
      headTurnNodeHash: headNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };
    const turn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 8,
      headTurnNodeHash: headNode.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_created_nodes_subset",
      updatedAtMs: 8,
    };

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.turnTrees.put(turnTree);
        await tx.turnTreePaths.putMany(
          createCanonicalTurnTreePaths(turnTree, [])
        );
        await tx.turnNodes.put(rootNode);
        await tx.turnNodes.put(middleNode);
        await tx.turnNodes.put(headNode);
        await tx.threads.put(thread);
        await tx.branches.set(branch);
        await tx.turns.set(turn);
        await tx.runs.set({
          branchId: branch.branchId,
          createdAtMs: 9,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            headNode.hash,
          ]),
          currentStepIndex: 0,
          runId: "run_created_nodes_subset",
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
          updatedAtMs: 9,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });
});
