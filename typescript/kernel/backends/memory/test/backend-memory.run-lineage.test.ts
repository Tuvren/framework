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
  createHashFromIndex,
  createCanonicalKernelTestSchema as createSchema,
  createStoredObjectRecord as createStoredObject,
  createStoredSchemaRecord as createStoredSchema,
  createStoredTurnNodeRecord as createStoredTurnNode,
  createStoredTurnTreeRecord as createStoredTurnTree,
} from "@tuvren/kernel-testkit";
import { createCanonicalTurnTreePaths } from "./backend-memory-test-helpers.js";

describe("@tuvren/backend-memory run lineage", () => {
  test("rejects conflicting object metadata for the same byte hash", async () => {
    const backend = createMemoryBackend();
    const objectRecord = await createStoredObject(new Uint8Array([4, 5, 6]), 1);
    const sameBytesDifferentMediaType = {
      ...objectRecord,
      createdAtMs: 2,
      mediaType: "application/json",
    };

    await backend.transact(async (tx) => {
      await tx.objects.put(objectRecord);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.objects.put(sameBytesDifferentMediaType);
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects turns whose start or head lineage is illegal", async () => {
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
      { "context.manifest": null, messages: [createHashFromIndex(2)] },
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
    const childNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const siblingRoot = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 6,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: siblingTurnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 7,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_turn_lineage",
    };
    const branch: StoredBranch = {
      branchId: "branch_turn_lineage",
      createdAtMs: 8,
      headTurnNodeHash: childNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 8,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnTrees.put(siblingTurnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(siblingTurnTree, [createHashFromIndex(2)])
      );
      await tx.turnNodes.put(rootNode);
      await tx.turnNodes.put(childNode);
      await tx.turnNodes.put(siblingRoot);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.turns.set({
          branchId: branch.branchId,
          createdAtMs: 8,
          headTurnNodeHash: childNode.hash,
          parentTurnId: null,
          startTurnNodeHash: siblingRoot.hash,
          threadId: thread.threadId,
          turnId: "turn_bad_start",
          updatedAtMs: 8,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.turns.set({
          branchId: branch.branchId,
          createdAtMs: 9,
          headTurnNodeHash: siblingRoot.hash,
          parentTurnId: null,
          startTurnNodeHash: rootNode.hash,
          threadId: thread.threadId,
          turnId: "turn_bad_head",
          updatedAtMs: 9,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects runs whose start turn node falls outside the referenced turn span", async () => {
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
      threadId: "thread_run_turn_span",
    };
    const branch: StoredBranch = {
      branchId: "branch_run_turn_span",
      createdAtMs: 7,
      headTurnNodeHash: headNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };
    const oldTurn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 8,
      headTurnNodeHash: middleNode.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_old_span",
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
      await tx.turns.set(oldTurn);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.runs.set({
          branchId: branch.branchId,
          createdAtMs: 9,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
          currentStepIndex: 0,
          runId: "run_turn_span_mismatch",
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
          turnId: oldTurn.turnId,
          updatedAtMs: 9,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects runs whose created turn node list references missing nodes", async () => {
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
      threadId: "thread_created_nodes_missing",
    };
    const branch: StoredBranch = {
      branchId: "branch_created_nodes_missing",
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
      turnId: "turn_created_nodes_missing",
      updatedAtMs: 6,
    };

    await expect(
      backend.transact(async (tx) => {
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
          branchId: branch.branchId,
          createdAtMs: 7,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            createHashFromIndex(999),
          ]),
          currentStepIndex: 1,
          runId: "run_created_nodes_missing",
          schemaId: schema.schemaId,
          startTurnNodeHash: turnNode.hash,
          status: "completed",
          stepSequenceCbor: encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "model_call",
              sideEffects: false,
            },
          ]),
          turnId: turn.turnId,
          updatedAtMs: 7,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects runs whose created turn nodes cross thread lineage", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const baseTree = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [] },
      2
    );
    const siblingTree = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [createHashFromIndex(1)] },
      3
    );
    const rootNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: baseTree.hash,
    });
    const branchHead = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: baseTree.hash,
    });
    const foreignRoot = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 6,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: siblingTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 7,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_created_nodes_lineage",
    };
    const branch: StoredBranch = {
      branchId: "branch_created_nodes_lineage",
      createdAtMs: 8,
      headTurnNodeHash: branchHead.hash,
      threadId: thread.threadId,
      updatedAtMs: 8,
    };
    const turn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 9,
      headTurnNodeHash: branchHead.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_created_nodes_lineage",
      updatedAtMs: 9,
    };

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.turnTrees.put(baseTree);
        await tx.turnTrees.put(siblingTree);
        await tx.turnTreePaths.putMany(
          createCanonicalTurnTreePaths(baseTree, [])
        );
        await tx.turnTreePaths.putMany(
          createCanonicalTurnTreePaths(siblingTree, [createHashFromIndex(1)])
        );
        await tx.turnNodes.put(rootNode);
        await tx.turnNodes.put(branchHead);
        await tx.turnNodes.put(foreignRoot);
        await tx.threads.put(thread);
        await tx.branches.set(branch);
        await tx.turns.set(turn);
        await tx.runs.set({
          branchId: branch.branchId,
          createdAtMs: 10,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            foreignRoot.hash,
          ]),
          currentStepIndex: 1,
          runId: "run_created_nodes_lineage",
          schemaId: schema.schemaId,
          startTurnNodeHash: branchHead.hash,
          status: "completed",
          stepSequenceCbor: encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "model_call",
              sideEffects: false,
            },
          ]),
          turnId: turn.turnId,
          updatedAtMs: 10,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects runs whose created turn nodes move beyond the turn head", async () => {
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
    const turnHead = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const futureNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: turnHead.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_created_nodes_span",
    };
    const branch: StoredBranch = {
      branchId: "branch_created_nodes_span",
      createdAtMs: 7,
      headTurnNodeHash: futureNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };
    const turn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 8,
      headTurnNodeHash: turnHead.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_created_nodes_span",
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
        await tx.turnNodes.put(turnHead);
        await tx.turnNodes.put(futureNode);
        await tx.threads.put(thread);
        await tx.branches.set(branch);
        await tx.turns.set(turn);
        await tx.runs.set({
          branchId: branch.branchId,
          createdAtMs: 9,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            futureNode.hash,
          ]),
          currentStepIndex: 1,
          runId: "run_created_nodes_span",
          schemaId: schema.schemaId,
          startTurnNodeHash: turnHead.hash,
          status: "completed",
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

  test("keeps historical completed runs valid after branch head advances", async () => {
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
    const advancedNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: headNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_historical_runs",
    };
    const branch: StoredBranch = {
      branchId: "branch_historical_runs",
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
      turnId: "turn_historical_runs",
      updatedAtMs: 8,
    };
    const runningRun: StoredRun = {
      branchId: branch.branchId,
      createdAtMs: 9,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 0,
      runId: "run_historical_completed",
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
    const completedRun: StoredRun = {
      ...runningRun,
      currentStepIndex: 1,
      status: "completed",
      updatedAtMs: 10,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(rootNode);
      await tx.turnNodes.put(headNode);
      await tx.turnNodes.put(advancedNode);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
      await tx.turns.set(turn);
      await tx.runs.set(runningRun);
      await tx.runs.set(completedRun);
      await tx.branches.set({
        ...branch,
        headTurnNodeHash: advancedNode.hash,
        updatedAtMs: 11,
      });
    });

    await backend.transact(async (tx) => {
      expect(await tx.runs.get(completedRun.runId)).toEqual(completedRun);
      expect(await tx.branches.get(branch.branchId)).toEqual({
        ...branch,
        headTurnNodeHash: advancedNode.hash,
        updatedAtMs: 11,
      });
    });
  });
});
