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
import { TuvrenPersistenceError } from "@tuvren/core-types";
import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  type KrakenBackendTx,
  type StoredBranch,
  type StoredObject,
  type StoredRun,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeManifest,
} from "@tuvren/kernel-protocol";
import {
  createHashFromIndex,
  createHashSequence,
  createIncrementingClock as createNowClock,
  createCanonicalKernelTestSchema as createSchema,
  createCanonicalTurnTreePaths as createSharedCanonicalTurnTreePaths,
  createStoredObjectRecord as createStoredObject,
  createStoredOrderedPathChunkRecord as createStoredOrderedPathChunk,
  createStoredSchemaRecord as createStoredSchema,
  createStoredTurnNodeRecord as createStoredTurnNode,
  createStoredTurnTreeRecord as createStoredTurnTree,
  delay,
  registerBackendConformanceSuite,
  registerBackendInvariantSuite,
  registerBackendRecoverySuite,
} from "@tuvren/kernel-testkit";

registerBackendConformanceSuite({
  createBackend: () => createMemoryBackend(),
  suiteName: "@tuvren/backend-memory shared conformance",
  testApi: { describe, test },
});

registerBackendInvariantSuite({
  createBackend: () => createMemoryBackend(),
  suiteName: "@tuvren/backend-memory shared invariants",
  testApi: { describe, test },
});

registerBackendRecoverySuite({
  createBackend: () => createMemoryBackend(),
  suiteName: "@tuvren/backend-memory shared recovery",
  testApi: { describe, test },
});

describe("@tuvren/backend-memory", () => {
  test("rolls back failed transactions and clones stored bytes defensively", async () => {
    const backend = createMemoryBackend();
    const objectRecord = await createStoredObject(new Uint8Array([1, 2, 3]), 1);

    await expect(
      backend.transact(async (tx) => {
        await tx.objects.put(objectRecord);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    await backend.transact(async (tx) => {
      expect(await tx.objects.get(objectRecord.hash)).toBeNull();
    });

    await backend.transact(async (tx) => {
      await tx.objects.put(objectRecord);
    });

    objectRecord.bytes[0] = 99;

    await backend.transact(async (tx) => {
      const firstRead = await tx.objects.get(objectRecord.hash);
      if (firstRead === null) {
        throw new Error("expected stored object");
      }

      firstRead.bytes[1] = 88;
      const secondRead = await tx.objects.get(objectRecord.hash);
      if (secondRead === null) {
        throw new Error("expected stored object");
      }

      expect(Array.from(secondRead.bytes)).toEqual([1, 2, 3]);
    });
  });

  test("serializes concurrent transactions and rejects nested transactions", async () => {
    const backend = createMemoryBackend();
    const order: string[] = [];

    const firstTransaction = backend.transact(async () => {
      order.push("first:start");
      await delay(20);
      order.push("first:end");
    });
    const secondTransaction = backend.transact(() => {
      order.push("second:start");
      order.push("second:end");
      return Promise.resolve();
    });

    await Promise.all([firstTransaction, secondTransaction]);
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);

    await expect(
      backend.transact(async () => {
        await backend.transact(async () => undefined);
      })
    ).rejects.toThrow("must not be nested");
  });

  test("rejects repository handle use after the transaction ends", async () => {
    const backend = createMemoryBackend();
    const objectRecord = await createStoredObject(new Uint8Array([1]), 1);
    const escapedTransactions: KrakenBackendTx[] = [];

    await backend.transact((tx) => {
      escapedTransactions.push(tx);
      return Promise.resolve();
    });

    const txHandle = escapedTransactions[0];

    if (txHandle === undefined) {
      throw new Error("expected escaped transaction handle");
    }

    await expect(txHandle.objects.put(objectRecord)).rejects.toBeInstanceOf(
      TuvrenPersistenceError
    );

    await backend.transact(async (tx) => {
      expect(await tx.objects.get(objectRecord.hash)).toBeNull();
    });
  });

  test("stores schemas, turn trees, and path rows while promoting large ordered paths to chunked storage", async () => {
    const backend = createMemoryBackend({ now: createNowClock(10) });
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 10);
    const largeOrderedHashes = createHashSequence(33, 500);
    const manifest: TurnTreeManifest = {
      "context.manifest": null,
      messages: largeOrderedHashes,
    };
    const turnTreeRecord = await createStoredTurnTree(schema, manifest, 11);
    const singlePath: StoredTurnTreePath = {
      collectionKind: "single",
      path: "context.manifest",
      singleHash: null,
      turnTreeHash: turnTreeRecord.hash,
    };
    const orderedPath: StoredTurnTreePath = {
      collectionKind: "ordered",
      orderedCount: largeOrderedHashes.length,
      orderedEncoding: "flat",
      orderedInlineCbor: encodeDeterministicKernelRecord(largeOrderedHashes),
      path: "messages",
      turnTreeHash: turnTreeRecord.hash,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTreeRecord);
      await tx.turnTreePaths.putMany([orderedPath, singlePath]);
    });

    await backend.transact(async (tx) => {
      const paths = await tx.turnTreePaths.listByTurnTree(turnTreeRecord.hash);
      expect(paths.map((path) => path.path)).toEqual([
        "context.manifest",
        "messages",
      ]);

      const messagesPath = paths[1];
      if (
        messagesPath.collectionKind !== "ordered" ||
        messagesPath.orderedEncoding !== "chunked"
      ) {
        throw new Error("expected chunked ordered path");
      }

      const chunkHashes = decodeDeterministicKernelRecord(
        messagesPath.orderedChunkListCbor
      );
      if (!Array.isArray(chunkHashes)) {
        throw new Error("expected chunk hash list");
      }

      expect(chunkHashes).toHaveLength(2);

      let totalCount = 0;
      for (const [index, chunkHash] of chunkHashes.entries()) {
        const storedChunk = await tx.orderedPathChunks.get(String(chunkHash));
        if (storedChunk === null) {
          throw new Error(`expected stored chunk at index ${index}`);
        }

        totalCount += storedChunk.itemCount;
      }

      expect(totalCount).toBe(33);
    });
  });

  test("reuses ordered-path chunks across turn trees with the same chunk content", async () => {
    const backend = createMemoryBackend({ now: createNowClock(200) });
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 200);
    const orderedHashes = createHashSequence(33, 900);
    const orderedPath: StoredTurnTreePath = {
      collectionKind: "ordered",
      orderedCount: orderedHashes.length,
      orderedEncoding: "flat",
      orderedInlineCbor: encodeDeterministicKernelRecord(orderedHashes),
      path: "messages",
      turnTreeHash: "",
    };
    const singlePath = (
      turnTreeHash: string,
      singleHash: string | null
    ): StoredTurnTreePath => ({
      collectionKind: "single",
      path: "context.manifest",
      singleHash,
      turnTreeHash,
    });
    const firstTurnTree = await createStoredTurnTree(
      schema,
      {
        "context.manifest": null,
        messages: orderedHashes,
      },
      201
    );
    const secondTurnTree = await createStoredTurnTree(
      schema,
      {
        "context.manifest": createHashFromIndex(9010),
        messages: orderedHashes,
      },
      202
    );

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(firstTurnTree);
      await tx.turnTrees.put(secondTurnTree);
      await tx.turnTreePaths.putMany([
        { ...orderedPath, turnTreeHash: firstTurnTree.hash },
        singlePath(firstTurnTree.hash, null),
      ]);
      await tx.turnTreePaths.putMany([
        { ...orderedPath, turnTreeHash: secondTurnTree.hash },
        singlePath(secondTurnTree.hash, createHashFromIndex(9010)),
      ]);
    });

    await backend.transact(async (tx) => {
      const firstMessages = await tx.turnTreePaths.get(
        firstTurnTree.hash,
        "messages"
      );
      const secondMessages = await tx.turnTreePaths.get(
        secondTurnTree.hash,
        "messages"
      );

      if (
        firstMessages === null ||
        secondMessages === null ||
        firstMessages.collectionKind !== "ordered" ||
        secondMessages.collectionKind !== "ordered" ||
        firstMessages.orderedEncoding !== "chunked" ||
        secondMessages.orderedEncoding !== "chunked"
      ) {
        throw new Error("expected chunked message paths");
      }

      expect(
        decodeDeterministicKernelRecord(firstMessages.orderedChunkListCbor)
      ).toEqual(
        decodeDeterministicKernelRecord(secondMessages.orderedChunkListCbor)
      );
    });
  });

  test("preserves deterministic list ordering for branches, runs, and staged results", async () => {
    const backend = createMemoryBackend({ now: createNowClock(300) });
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 300);
    const turnTree = await createStoredTurnTree(
      schema,
      {
        "context.manifest": null,
        messages: [],
      },
      301
    );
    const turnNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 302,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const lateTurnNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 303,
      eventHash: null,
      previousTurnNodeHash: turnNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 304,
      rootTurnNodeHash: turnNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_ordering",
    };
    const earlyBranch: StoredBranch = {
      branchId: "branch_b",
      createdAtMs: 305,
      headTurnNodeHash: turnNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 305,
    };
    const lateBranch: StoredBranch = {
      branchId: "branch_a",
      createdAtMs: 306,
      headTurnNodeHash: lateTurnNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 306,
    };
    const stagedTurn: StoredTurn = {
      branchId: earlyBranch.branchId,
      createdAtMs: 306,
      headTurnNodeHash: turnNode.hash,
      parentTurnId: null,
      startTurnNodeHash: turnNode.hash,
      threadId: thread.threadId,
      turnId: "turn_ordering_staged",
      updatedAtMs: 306,
    };
    const orderedRunsTurn: StoredTurn = {
      branchId: lateBranch.branchId,
      createdAtMs: 306,
      headTurnNodeHash: lateTurnNode.hash,
      parentTurnId: null,
      startTurnNodeHash: lateTurnNode.hash,
      threadId: thread.threadId,
      turnId: "turn_ordering_runs",
      updatedAtMs: 307,
    };
    const stagedRun: StoredRun = {
      branchId: earlyBranch.branchId,
      createdAtMs: 307,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 0,
      runId: "run_staged",
      schemaId: schema.schemaId,
      startTurnNodeHash: turnNode.hash,
      status: "running",
      stepSequenceCbor: encodeDeterministicKernelRecord([
        {
          deterministic: false,
          id: "model_call",
          sideEffects: false,
        },
      ]),
      turnId: stagedTurn.turnId,
      updatedAtMs: 308,
    };
    const orderedRunB: StoredRun = {
      branchId: lateBranch.branchId,
      createdAtMs: 307,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 1,
      runId: "run_b",
      schemaId: schema.schemaId,
      startTurnNodeHash: lateTurnNode.hash,
      status: "completed",
      stepSequenceCbor: encodeDeterministicKernelRecord([
        {
          deterministic: false,
          id: "tool_execution",
          sideEffects: true,
        },
      ]),
      turnId: orderedRunsTurn.turnId,
      updatedAtMs: 308,
    };
    const orderedRunA: StoredRun = {
      ...orderedRunB,
      runId: "run_a",
    };
    const objectA = await createStoredObject(new Uint8Array([1]), 309);
    const objectB = await createStoredObject(new Uint8Array([2]), 310);
    const stagedB: StoredStagedResult = {
      createdAtMs: 311,
      objectHash: objectB.hash,
      objectType: "message",
      runId: stagedRun.runId,
      status: "completed",
      taskId: "task_b",
    };
    const stagedA: StoredStagedResult = {
      createdAtMs: 311,
      objectHash: objectA.hash,
      objectType: "message",
      runId: stagedRun.runId,
      status: "completed",
      taskId: "task_a",
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(turnNode);
      await tx.turnNodes.put(lateTurnNode);
      await tx.threads.put(thread);
      await tx.branches.set(earlyBranch);
      await tx.branches.set(lateBranch);
      await tx.turns.set(stagedTurn);
      await tx.turns.set(orderedRunsTurn);
      await tx.runs.set(stagedRun);
      await tx.runs.set({
        ...orderedRunB,
        status: "running",
        currentStepIndex: 0,
      });
      await tx.runs.set(orderedRunB);
      await tx.runs.set({
        ...orderedRunA,
        status: "running",
        currentStepIndex: 0,
      });
      await tx.runs.set(orderedRunA);
      await tx.objects.put(objectA);
      await tx.objects.put(objectB);
      await tx.stagedResults.set(stagedB);
      await tx.stagedResults.set(stagedA);
    });

    await backend.transact(async (tx) => {
      expect(
        (await tx.branches.listByThread(thread.threadId)).map(
          (branch) => branch.branchId
        )
      ).toEqual(["branch_b", "branch_a"]);
      expect(
        (await tx.runs.listByBranch(lateBranch.branchId)).map(
          (run) => run.runId
        )
      ).toEqual(["run_a", "run_b"]);
      expect(
        (await tx.stagedResults.listByRun(stagedRun.runId)).map(
          (stagedResult) => stagedResult.taskId
        )
      ).toEqual(["task_a", "task_b"]);
    });
  });

  test("rejects conflicting object metadata for the same byte hash", async () => {
    const backend = createMemoryBackend();
    const objectRecord = await createStoredObject(new Uint8Array([4, 5, 6]), 1);
    const sameBytesDifferentMediaType: StoredObject = {
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

  test("rejects halted run updates that change progress or created turn nodes", async () => {
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
    const createdNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const extraNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: createdNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_halted_run",
    };
    const branch: StoredBranch = {
      branchId: "branch_halted_run",
      createdAtMs: 7,
      headTurnNodeHash: createdNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };
    const turn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 8,
      headTurnNodeHash: createdNode.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_halted_run",
      updatedAtMs: 8,
    };
    const runningForFailure: StoredRun = {
      branchId: branch.branchId,
      createdAtMs: 9,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 0,
      runId: "run_halted_failed",
      schemaId: schema.schemaId,
      startTurnNodeHash: createdNode.hash,
      status: "running",
      stepSequenceCbor: encodeDeterministicKernelRecord([
        {
          deterministic: false,
          id: "model_call",
          sideEffects: false,
        },
        {
          deterministic: false,
          id: "tool_execution",
          sideEffects: true,
        },
      ]),
      turnId: turn.turnId,
      updatedAtMs: 9,
    };
    const failedRun: StoredRun = {
      ...runningForFailure,
      status: "failed",
      updatedAtMs: 10,
    };
    const pausedRun: StoredRun = {
      ...runningForFailure,
      runId: "run_halted_paused",
      status: "paused",
      updatedAtMs: 10,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(rootNode);
      await tx.turnNodes.put(createdNode);
      await tx.turnNodes.put(extraNode);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
      await tx.turns.set(turn);
      await tx.runs.set(runningForFailure);
      await tx.runs.set(failedRun);
      await tx.runs.set({
        ...runningForFailure,
        runId: pausedRun.runId,
        updatedAtMs: 9,
      });
      await tx.runs.set(pausedRun);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.runs.set({
          ...failedRun,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            createdNode.hash,
            extraNode.hash,
          ]),
          currentStepIndex: 1,
          updatedAtMs: 11,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.runs.set({
          ...pausedRun,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            createdNode.hash,
            extraNode.hash,
          ]),
          currentStepIndex: 1,
          status: "failed",
          updatedAtMs: 11,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects terminal or paused runs that still retain staged results", async () => {
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
      threadId: "thread_terminal_stage",
    };
    const branch: StoredBranch = {
      branchId: "branch_terminal_stage",
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
      turnId: "turn_terminal_stage",
      updatedAtMs: 6,
    };
    const runningRun: StoredRun = {
      branchId: branch.branchId,
      createdAtMs: 7,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 0,
      runId: "run_terminal_stage",
      schemaId: schema.schemaId,
      startTurnNodeHash: turnNode.hash,
      status: "running",
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
    const objectRecord = await createStoredObject(new Uint8Array([1, 2, 3]), 8);

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
      await tx.runs.set(runningRun);
      await tx.objects.put(objectRecord);
      await tx.stagedResults.set({
        createdAtMs: 9,
        objectHash: objectRecord.hash,
        objectType: "message",
        runId: runningRun.runId,
        status: "completed",
        taskId: "task_stage",
      });
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.runs.set({
          ...runningRun,
          currentStepIndex: 1,
          status: "completed",
          updatedAtMs: 10,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects illegal run status rewrites", async () => {
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
      threadId: "thread_run_status",
    };
    const branch: StoredBranch = {
      branchId: "branch_run_status",
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
      turnId: "turn_run_status",
      updatedAtMs: 6,
    };
    const runningCompletedRun: StoredRun = {
      branchId: branch.branchId,
      createdAtMs: 7,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 0,
      runId: "run_completed",
      schemaId: schema.schemaId,
      startTurnNodeHash: turnNode.hash,
      status: "running",
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
    const completedRun: StoredRun = {
      ...runningCompletedRun,
      currentStepIndex: 1,
      status: "completed",
      updatedAtMs: 8,
    };
    const runningPausedRun: StoredRun = {
      branchId: branch.branchId,
      createdAtMs: 9,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 0,
      runId: "run_paused",
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
      updatedAtMs: 9,
    };
    const pausedRun: StoredRun = {
      ...runningPausedRun,
      currentStepIndex: 1,
      status: "paused",
      updatedAtMs: 10,
    };

    const completedBackend = createMemoryBackend();
    await completedBackend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(turnNode);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
      await tx.turns.set(turn);
      await tx.runs.set(runningCompletedRun);
      await tx.runs.set(completedRun);
    });

    await expect(
      completedBackend.transact(async (tx) => {
        await tx.runs.set({
          ...completedRun,
          currentStepIndex: 0,
          status: "running",
          updatedAtMs: 10,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);

    const pausedBackend = createMemoryBackend();
    await pausedBackend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(turnNode);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
      await tx.turns.set(turn);
      await tx.runs.set(runningPausedRun);
      await tx.runs.set(pausedRun);
    });

    await expect(
      pausedBackend.transact(async (tx) => {
        await tx.runs.set({
          ...pausedRun,
          status: "completed",
          updatedAtMs: 11,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects run updates that rewind step progress or rewrite created turn nodes", async () => {
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
    const createdNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: turnNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const alternateCreatedNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: createdNode.hash,
      schemaId: schema.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: turnNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_run_progress",
    };
    const branch: StoredBranch = {
      branchId: "branch_run_progress",
      createdAtMs: 7,
      headTurnNodeHash: createdNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };
    const turn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 8,
      headTurnNodeHash: createdNode.hash,
      parentTurnId: null,
      startTurnNodeHash: turnNode.hash,
      threadId: thread.threadId,
      turnId: "turn_run_progress",
      updatedAtMs: 8,
    };
    const runningRun: StoredRun = {
      branchId: branch.branchId,
      createdAtMs: 9,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
      currentStepIndex: 1,
      runId: "run_progress",
      schemaId: schema.schemaId,
      startTurnNodeHash: createdNode.hash,
      status: "running",
      stepSequenceCbor: encodeDeterministicKernelRecord([
        {
          deterministic: false,
          id: "model_call",
          sideEffects: false,
        },
        {
          deterministic: false,
          id: "tool_execution",
          sideEffects: true,
        },
      ]),
      turnId: turn.turnId,
      updatedAtMs: 9,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(turnNode);
      await tx.turnNodes.put(createdNode);
      await tx.turnNodes.put(alternateCreatedNode);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
      await tx.turns.set(turn);
      await tx.runs.set(runningRun);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.runs.set({
          ...runningRun,
          currentStepIndex: 0,
          updatedAtMs: 10,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.runs.set({
          ...runningRun,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            alternateCreatedNode.hash,
          ]),
          updatedAtMs: 10,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

  test("rejects rewriting immutable turn creation fields", async () => {
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
      threadId: "thread_turn_immutability",
    };
    const branch: StoredBranch = {
      branchId: "branch_turn_immutability",
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
      turnId: "turn_immutable",
      updatedAtMs: 7,
    };

    await backend.transact(async (tx) => {
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
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.turns.set({
          ...turn,
          startTurnNodeHash: headNode.hash,
          updatedAtMs: 8,
        });
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);
  });

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

  test("rejects cross-branch parent links and stale same-branch parent links", async () => {
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

    await expect(
      backend.transact(async (tx) => {
        await tx.turns.set(siblingTurn);
      })
    ).rejects.toBeInstanceOf(TuvrenPersistenceError);

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
    const turn: StoredTurn = {
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

function createCanonicalTurnTreePaths(
  turnTree: StoredTurnTree,
  messages: string[]
): StoredTurnTreePath[] {
  return createSharedCanonicalTurnTreePaths(turnTree, {
    "context.manifest": null,
    messages,
  });
}
