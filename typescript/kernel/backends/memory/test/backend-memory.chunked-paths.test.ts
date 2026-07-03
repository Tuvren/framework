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
  type StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import {
  createHashFromIndex,
  createHashSequence,
  createCanonicalKernelTestSchema as createSchema,
  createStoredOrderedPathChunkRecord as createStoredOrderedPathChunk,
  createStoredSchemaRecord as createStoredSchema,
  createStoredTurnNodeRecord as createStoredTurnNode,
  createStoredTurnTreeRecord as createStoredTurnTree,
} from "@tuvren/kernel-testkit";
import { createCanonicalTurnTreePaths } from "./backend-memory-test-helpers.js";

describe("@tuvren/backend-memory chunked paths", () => {
  test("rejects chunked ordered paths that have not crossed the promotion threshold", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const messageHash = createHashFromIndex(99);
    const turnTree = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [messageHash] },
      2
    );
    const chunkRecord = await createStoredOrderedPathChunk([messageHash], 3);
    const chunkedPath: StoredTurnTreePath = {
      collectionKind: "ordered",
      orderedChunkListCbor: encodeDeterministicKernelRecord([
        chunkRecord.chunkHash,
      ]),
      orderedCount: 1,
      orderedEncoding: "chunked",
      path: "messages",
      turnTreeHash: turnTree.hash,
    };

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.turnTrees.put(turnTree);
        await tx.orderedPathChunks.put(chunkRecord);
        await tx.turnTreePaths.putMany([
          {
            collectionKind: "single",
            path: "context.manifest",
            singleHash: null,
            turnTreeHash: turnTree.hash,
          },
          chunkedPath,
        ]);
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects chunked ordered paths whose chunks do not use the fixed storage layout", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const messageHashes = createHashSequence(40, 8000);
    const turnTree = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: messageHashes },
      2
    );
    const oversizedChunk = await createStoredOrderedPathChunk(messageHashes, 3);
    const chunkedPath: StoredTurnTreePath = {
      collectionKind: "ordered",
      orderedChunkListCbor: encodeDeterministicKernelRecord([
        oversizedChunk.chunkHash,
      ]),
      orderedCount: messageHashes.length,
      orderedEncoding: "chunked",
      path: "messages",
      turnTreeHash: turnTree.hash,
    };

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.turnTrees.put(turnTree);
        await tx.orderedPathChunks.put(oversizedChunk);
        await tx.turnTreePaths.putMany([
          {
            collectionKind: "single",
            path: "context.manifest",
            singleHash: null,
            turnTreeHash: turnTree.hash,
          },
          chunkedPath,
        ]);
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects archive branches whose source branch was created in the same transaction", async () => {
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
      threadId: "thread_archive_provenance",
    };
    const sourceBranch: StoredBranch = {
      branchId: "branch_archive_provenance_source",
      createdAtMs: 6,
      headTurnNodeHash: headNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 6,
    };
    const archiveBranch: StoredBranch = {
      archivedFromBranchId: sourceBranch.branchId,
      branchId: "branch_archive_provenance_archive",
      createdAtMs: 7,
      headTurnNodeHash: headNode.hash,
      threadId: thread.threadId,
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
        await tx.branches.set(sourceBranch);
        await tx.branches.set(archiveBranch);
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects backward rollback transactions that leave active runs on the archived segment via created turn nodes", async () => {
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
      threadId: "thread_backward_created_nodes",
    };
    const branch: StoredBranch = {
      branchId: "branch_backward_created_nodes",
      createdAtMs: 7,
      headTurnNodeHash: middleNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };
    const turn = {
      branchId: branch.branchId,
      createdAtMs: 8,
      headTurnNodeHash: headNode.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_backward_created_nodes",
      updatedAtMs: 8,
    };
    const activeRun: StoredRun = {
      branchId: branch.branchId,
      createdAtMs: 9,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([headNode.hash]),
      currentStepIndex: 0,
      runId: "run_backward_created_nodes",
      schemaId: schema.schemaId,
      startTurnNodeHash: middleNode.hash,
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
      branchId: "branch_backward_created_nodes_archive",
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
      await tx.runs.set(activeRun);
      await tx.branches.set({
        ...branch,
        headTurnNodeHash: headNode.hash,
        updatedAtMs: 9,
      });
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.branches.set(archiveBranch);
        await tx.branches.set({
          ...branch,
          updatedAtMs: 10,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });
});
