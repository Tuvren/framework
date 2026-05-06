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
  type RuntimeBackendTx as KrakenBackendTx,
  type StoredBranch,
  type StoredRun,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
  type StoredTurnTreePath,
  type TurnTreeManifest,
} from "@tuvren/kernel-protocol";
import {
  createHashFromIndex,
  createHashSequence,
  createIncrementingClock as createNowClock,
  createCanonicalKernelTestSchema as createSchema,
  createStoredObjectRecord as createStoredObject,
  createStoredSchemaRecord as createStoredSchema,
  createStoredTurnNodeRecord as createStoredTurnNode,
  createStoredTurnTreeRecord as createStoredTurnTree,
  delay,
  registerBackendConformanceSuite,
  registerBackendInvariantSuite,
  registerBackendRecoverySuite,
} from "@tuvren/kernel-testkit";
import { createCanonicalTurnTreePaths } from "./backend-memory-test-helpers.js";

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
        messagesPath === undefined ||
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
});
