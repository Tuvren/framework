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
import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  hashTurnTreeIdentity,
  type StoredBranch,
  type StoredObject,
  type StoredRun,
  type StoredSchema,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
  type StoredTurnNode,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeManifest,
  type TurnTreeSchema,
} from "@kraken/kernel-contract-protocol";
import { KrakenPersistenceError } from "@kraken/shared-core-types";
import { createMemoryBackend } from "../src/index.ts";

describe("@kraken/backend-memory", () => {
  test("reports healthy status", async () => {
    const backend = createMemoryBackend();

    await expect(backend.health()).resolves.toEqual({ ok: true });
  });

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
    const singlePath = (turnTreeHash: string): StoredTurnTreePath => ({
      collectionKind: "single",
      path: "context.manifest",
      singleHash: null,
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
        "context.manifest": null,
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
        singlePath(firstTurnTree.hash),
      ]);
      await tx.turnTreePaths.putMany([
        { ...orderedPath, turnTreeHash: secondTurnTree.hash },
        singlePath(secondTurnTree.hash),
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

  test("stores lineage and run-state records with list and clear helpers", async () => {
    const backend = createMemoryBackend({ now: createNowClock(100) });
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 100);
    const manifest: TurnTreeManifest = {
      "context.manifest": null,
      messages: [],
    };
    const turnTreeRecord = await createStoredTurnTree(schema, manifest, 101);
    const eventObject = await createStoredObject(
      new Uint8Array([9, 9, 9]),
      102
    );
    const turnNodeRecord = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 103,
      eventHash: eventObject.hash,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTreeRecord.hash,
    });
    const threadRecord: StoredThread = {
      createdAtMs: 104,
      rootTurnNodeHash: turnNodeRecord.hash,
      schemaId: schema.schemaId,
      threadId: "thread_main",
    };
    const branchRecord: StoredBranch = {
      branchId: "branch_main",
      createdAtMs: 105,
      headTurnNodeHash: turnNodeRecord.hash,
      threadId: threadRecord.threadId,
      updatedAtMs: 105,
    };
    const turnRecord: StoredTurn = {
      branchId: branchRecord.branchId,
      createdAtMs: 106,
      headTurnNodeHash: turnNodeRecord.hash,
      parentTurnId: null,
      startTurnNodeHash: turnNodeRecord.hash,
      threadId: threadRecord.threadId,
      turnId: "turn_main",
      updatedAtMs: 106,
    };
    const runRecord: StoredRun = {
      branchId: branchRecord.branchId,
      createdAtMs: 107,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([
        turnNodeRecord.hash,
      ]),
      currentStepIndex: 1,
      runId: "run_main",
      schemaId: schema.schemaId,
      startTurnNodeHash: turnNodeRecord.hash,
      status: "completed",
      stepSequenceCbor: encodeDeterministicKernelRecord([
        {
          deterministic: false,
          id: "model_call",
          sideEffects: false,
        },
      ]),
      turnId: turnRecord.turnId,
      updatedAtMs: 108,
    };
    const stagedObject = await createStoredObject(
      new Uint8Array([7, 8, 9]),
      109
    );
    const stagedResult: StoredStagedResult = {
      createdAtMs: 110,
      objectHash: stagedObject.hash,
      objectType: "message",
      runId: runRecord.runId,
      status: "completed",
      taskId: "message_1",
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTreeRecord);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTreeRecord, [])
      );
      await tx.objects.put(eventObject);
      await tx.objects.put(stagedObject);
      await tx.turnNodes.put(turnNodeRecord);
      await tx.threads.put(threadRecord);
      await tx.branches.set(branchRecord);
      await tx.turns.set(turnRecord);
      await tx.runs.set(runRecord);
      await tx.stagedResults.set(stagedResult);
    });

    await backend.transact(async (tx) => {
      expect(await tx.turnNodes.get(turnNodeRecord.hash)).toEqual(
        turnNodeRecord
      );
      expect(await tx.threads.get(threadRecord.threadId)).toEqual(threadRecord);
      expect(await tx.branches.listByThread(threadRecord.threadId)).toEqual([
        branchRecord,
      ]);
      expect(await tx.runs.listByBranch(branchRecord.branchId)).toEqual([
        runRecord,
      ]);
      expect(await tx.stagedResults.listByRun(runRecord.runId)).toEqual([
        stagedResult,
      ]);

      await tx.stagedResults.clearRun(runRecord.runId);
      expect(await tx.stagedResults.listByRun(runRecord.runId)).toEqual([]);
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
    const thread: StoredThread = {
      createdAtMs: 303,
      rootTurnNodeHash: turnNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_ordering",
    };
    const earlyBranch: StoredBranch = {
      branchId: "branch_b",
      createdAtMs: 304,
      headTurnNodeHash: turnNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 304,
    };
    const lateBranch: StoredBranch = {
      branchId: "branch_a",
      createdAtMs: 304,
      headTurnNodeHash: turnNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 305,
    };
    const turn: StoredTurn = {
      branchId: earlyBranch.branchId,
      createdAtMs: 306,
      headTurnNodeHash: turnNode.hash,
      parentTurnId: null,
      startTurnNodeHash: turnNode.hash,
      threadId: thread.threadId,
      turnId: "turn_ordering",
      updatedAtMs: 306,
    };
    const firstRun: StoredRun = {
      branchId: earlyBranch.branchId,
      createdAtMs: 307,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([turnNode.hash]),
      currentStepIndex: 1,
      runId: "run_b",
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
      updatedAtMs: 308,
    };
    const secondRun: StoredRun = {
      branchId: earlyBranch.branchId,
      createdAtMs: 307,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([turnNode.hash]),
      currentStepIndex: 1,
      runId: "run_a",
      schemaId: schema.schemaId,
      startTurnNodeHash: turnNode.hash,
      status: "completed",
      stepSequenceCbor: encodeDeterministicKernelRecord([
        {
          deterministic: false,
          id: "tool_execution",
          sideEffects: true,
        },
      ]),
      turnId: turn.turnId,
      updatedAtMs: 308,
    };
    const objectA = await createStoredObject(new Uint8Array([1]), 309);
    const objectB = await createStoredObject(new Uint8Array([2]), 310);
    const stagedB: StoredStagedResult = {
      createdAtMs: 311,
      objectHash: objectB.hash,
      objectType: "message",
      runId: firstRun.runId,
      status: "completed",
      taskId: "task_b",
    };
    const stagedA: StoredStagedResult = {
      createdAtMs: 311,
      objectHash: objectA.hash,
      objectType: "message",
      runId: firstRun.runId,
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
      await tx.threads.put(thread);
      await tx.branches.set(earlyBranch);
      await tx.branches.set(lateBranch);
      await tx.turns.set(turn);
      await tx.runs.set(firstRun);
      await tx.runs.set(secondRun);
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
      ).toEqual(["branch_a", "branch_b"]);
      expect(
        (await tx.runs.listByBranch(earlyBranch.branchId)).map(
          (run) => run.runId
        )
      ).toEqual(["run_a", "run_b"]);
      expect(
        (await tx.stagedResults.listByRun(firstRun.runId)).map(
          (stagedResult) => stagedResult.taskId
        )
      ).toEqual(["task_a", "task_b"]);
    });
  });

  test("accepts idempotent immutable writes and rejects conflicting ones", async () => {
    const backend = createMemoryBackend();
    const objectRecord = await createStoredObject(new Uint8Array([4, 5, 6]), 1);
    const conflictingObject: StoredObject = {
      ...objectRecord,
      mediaType: "application/json",
    };

    await backend.transact(async (tx) => {
      await tx.objects.put(objectRecord);
      await tx.objects.put(objectRecord);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.objects.put(conflictingObject);
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);
  });

  test("rejects branch heads and archive metadata that cross thread lineage", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const turnTreeA = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [] },
      2
    );
    const turnTreeB = await createStoredTurnTree(
      schema,
      { "context.manifest": null, messages: [createHashFromIndex(1)] },
      3
    );
    const rootNodeA = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTreeA.hash,
    });
    const rootNodeB = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: turnTreeB.hash,
    });
    const threadA: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: rootNodeA.hash,
      schemaId: schema.schemaId,
      threadId: "thread_branch_a",
    };
    const threadB: StoredThread = {
      createdAtMs: 7,
      rootTurnNodeHash: rootNodeB.hash,
      schemaId: schema.schemaId,
      threadId: "thread_branch_b",
    };
    const branchB: StoredBranch = {
      branchId: "branch_b",
      createdAtMs: 8,
      headTurnNodeHash: rootNodeB.hash,
      threadId: threadB.threadId,
      updatedAtMs: 8,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTreeA);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTreeA, [])
      );
      await tx.turnTrees.put(turnTreeB);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTreeB, [createHashFromIndex(1)])
      );
      await tx.turnNodes.put(rootNodeA);
      await tx.turnNodes.put(rootNodeB);
      await tx.threads.put(threadA);
      await tx.threads.put(threadB);
      await tx.branches.set(branchB);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.branches.set({
          branchId: "branch_cross_head",
          createdAtMs: 9,
          headTurnNodeHash: rootNodeB.hash,
          threadId: threadA.threadId,
          updatedAtMs: 9,
        });
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.branches.set({
          archivedFromBranchId: branchB.branchId,
          branchId: "branch_cross_archive",
          createdAtMs: 10,
          headTurnNodeHash: rootNodeA.hash,
          threadId: threadA.threadId,
          updatedAtMs: 10,
        });
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);
  });

  test("rolls back grouped writes when repository validation fails mid-transaction", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const turnTree = await createStoredTurnTree(
      schema,
      {
        "context.manifest": null,
        messages: [],
      },
      2
    );
    const duplicatePath: StoredTurnTreePath = {
      collectionKind: "single",
      path: "context.manifest",
      singleHash: null,
      turnTreeHash: turnTree.hash,
    };

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.turnTrees.put(turnTree);
        await tx.turnTreePaths.putMany([duplicatePath, duplicatePath]);
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);

    await backend.transact(async (tx) => {
      expect(await tx.schemas.get(schema.schemaId)).toBeNull();
      expect(await tx.turnTrees.get(turnTree.hash)).toBeNull();
      expect(
        await tx.turnTreePaths.get(turnTree.hash, "context.manifest")
      ).toBeNull();
    });
  });

  test("rejects thread and turn-node schema mismatches", async () => {
    const backend = createMemoryBackend();
    const schemaA = createSchema();
    const schemaB = {
      ...createSchema(),
      schemaId: "schema_alt",
    } satisfies TurnTreeSchema;
    const schemaRecordA = createStoredSchema(schemaA, 1);
    const schemaRecordB = createStoredSchema(schemaB, 2);
    const turnTreeA = await createStoredTurnTree(
      schemaA,
      { "context.manifest": null, messages: [] },
      3
    );
    const turnNodeA = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schemaA.schemaId,
      turnTreeHash: turnTreeA.hash,
    });

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecordA);
      await tx.schemas.put(schemaRecordB);
      await tx.turnTrees.put(turnTreeA);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTreeA, [])
      );
      await tx.turnNodes.put(turnNodeA);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.threads.put({
          createdAtMs: 5,
          rootTurnNodeHash: turnNodeA.hash,
          schemaId: schemaB.schemaId,
          threadId: "thread_schema_mismatch",
        });
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.turnNodes.put({
          ...turnNodeA,
          hash: await hashTurnNodeIdentity({
            consumedStagedResults: [],
            eventHash: null,
            previousTurnNodeHash: null,
            schemaId: schemaB.schemaId,
            turnTreeHash: turnTreeA.hash,
          }),
          schemaId: schemaB.schemaId,
        });
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);
  });

  test("rejects cross-record reference mismatches for branch, turn, and run state", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const turnTree = await createStoredTurnTree(
      schema,
      {
        "context.manifest": null,
        messages: [],
      },
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
    const threadA: StoredThread = {
      createdAtMs: 4,
      rootTurnNodeHash: turnNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_a",
    };
    const threadB: StoredThread = {
      createdAtMs: 5,
      rootTurnNodeHash: turnNode.hash,
      schemaId: schema.schemaId,
      threadId: "thread_b",
    };
    const branchA: StoredBranch = {
      branchId: "branch_a",
      createdAtMs: 6,
      headTurnNodeHash: turnNode.hash,
      threadId: threadA.threadId,
      updatedAtMs: 6,
    };
    const branchB: StoredBranch = {
      branchId: "branch_b",
      createdAtMs: 7,
      headTurnNodeHash: turnNode.hash,
      threadId: threadB.threadId,
      updatedAtMs: 7,
    };
    const turnOnA: StoredTurn = {
      branchId: branchA.branchId,
      createdAtMs: 8,
      headTurnNodeHash: turnNode.hash,
      parentTurnId: null,
      startTurnNodeHash: turnNode.hash,
      threadId: threadA.threadId,
      turnId: "turn_a",
      updatedAtMs: 8,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecord);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(turnNode);
      await tx.threads.put(threadA);
      await tx.threads.put(threadB);
      await tx.branches.set(branchA);
      await tx.branches.set(branchB);
      await tx.turns.set(turnOnA);
    });

    const mismatchedTurn: StoredTurn = {
      ...turnOnA,
      branchId: branchB.branchId,
      turnId: "turn_mismatch",
    };
    const mismatchedRun: StoredRun = {
      branchId: branchB.branchId,
      createdAtMs: 9,
      createdTurnNodesCbor: encodeDeterministicKernelRecord([turnNode.hash]),
      currentStepIndex: 1,
      runId: "run_mismatch",
      schemaId: schema.schemaId,
      startTurnNodeHash: turnNode.hash,
      status: "completed",
      stepSequenceCbor: encodeDeterministicKernelRecord([
        {
          deterministic: false,
          id: "tool_execution",
          sideEffects: true,
        },
      ]),
      turnId: turnOnA.turnId,
      updatedAtMs: 10,
    };

    await expect(
      backend.transact(async (tx) => {
        await tx.turns.set(mismatchedTurn);
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.runs.set(mismatchedRun);
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);
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
    ).rejects.toBeInstanceOf(KrakenPersistenceError);

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
    ).rejects.toBeInstanceOf(KrakenPersistenceError);
  });

  test("rejects runs with stale branch heads, schema mismatches, or duplicate active runs", async () => {
    const backend = createMemoryBackend();
    const schemaA = createSchema();
    const schemaB = {
      ...createSchema(),
      schemaId: "schema_run_alt",
    } satisfies TurnTreeSchema;
    const schemaRecordA = createStoredSchema(schemaA, 1);
    const schemaRecordB = createStoredSchema(schemaB, 2);
    const turnTree = await createStoredTurnTree(
      schemaA,
      { "context.manifest": null, messages: [] },
      3
    );
    const rootNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schemaA.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const nextNode = await createStoredTurnNode({
      consumedStagedResults: [],
      createdAtMs: 5,
      eventHash: null,
      previousTurnNodeHash: rootNode.hash,
      schemaId: schemaA.schemaId,
      turnTreeHash: turnTree.hash,
    });
    const thread: StoredThread = {
      createdAtMs: 6,
      rootTurnNodeHash: rootNode.hash,
      schemaId: schemaA.schemaId,
      threadId: "thread_run_invariants",
    };
    const branch: StoredBranch = {
      branchId: "branch_run_invariants",
      createdAtMs: 7,
      headTurnNodeHash: nextNode.hash,
      threadId: thread.threadId,
      updatedAtMs: 7,
    };
    const turn: StoredTurn = {
      branchId: branch.branchId,
      createdAtMs: 8,
      headTurnNodeHash: nextNode.hash,
      parentTurnId: null,
      startTurnNodeHash: rootNode.hash,
      threadId: thread.threadId,
      turnId: "turn_run_invariants",
      updatedAtMs: 8,
    };

    await backend.transact(async (tx) => {
      await tx.schemas.put(schemaRecordA);
      await tx.schemas.put(schemaRecordB);
      await tx.turnTrees.put(turnTree);
      await tx.turnTreePaths.putMany(
        createCanonicalTurnTreePaths(turnTree, [])
      );
      await tx.turnNodes.put(rootNode);
      await tx.turnNodes.put(nextNode);
      await tx.threads.put(thread);
      await tx.branches.set(branch);
      await tx.turns.set(turn);
    });

    await expect(
      backend.transact(async (tx) => {
        await tx.runs.set({
          branchId: branch.branchId,
          createdAtMs: 9,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            rootNode.hash,
          ]),
          currentStepIndex: 1,
          runId: "run_stale_head",
          schemaId: schemaA.schemaId,
          startTurnNodeHash: rootNode.hash,
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
    ).rejects.toBeInstanceOf(KrakenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.runs.set({
          branchId: branch.branchId,
          createdAtMs: 10,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            nextNode.hash,
          ]),
          currentStepIndex: 1,
          runId: "run_schema_mismatch",
          schemaId: schemaB.schemaId,
          startTurnNodeHash: nextNode.hash,
          status: "completed",
          stepSequenceCbor: encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "tool_execution",
              sideEffects: true,
            },
          ]),
          turnId: turn.turnId,
          updatedAtMs: 10,
        });
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);

    await expect(
      backend.transact(async (tx) => {
        await tx.runs.set({
          branchId: branch.branchId,
          createdAtMs: 11,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            nextNode.hash,
          ]),
          currentStepIndex: 0,
          runId: "run_active_a",
          schemaId: schemaA.schemaId,
          startTurnNodeHash: nextNode.hash,
          status: "running",
          stepSequenceCbor: encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "model_call",
              sideEffects: false,
            },
          ]),
          turnId: turn.turnId,
          updatedAtMs: 11,
        });
        await tx.runs.set({
          branchId: branch.branchId,
          createdAtMs: 12,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            nextNode.hash,
          ]),
          currentStepIndex: 0,
          runId: "run_active_b",
          schemaId: schemaA.schemaId,
          startTurnNodeHash: nextNode.hash,
          status: "paused",
          stepSequenceCbor: encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "model_call",
              sideEffects: false,
            },
          ]),
          turnId: turn.turnId,
          updatedAtMs: 12,
        });
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);
  });

  test("rejects mismatches between turn tree manifests and indexed path rows", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const turnTree = await createStoredTurnTree(
      schema,
      {
        "context.manifest": null,
        messages: [createHashFromIndex(10)],
      },
      2
    );
    const wrongMessagesPath: StoredTurnTreePath = {
      collectionKind: "ordered",
      orderedCount: 0,
      orderedEncoding: "flat",
      orderedInlineCbor: encodeDeterministicKernelRecord([]),
      path: "messages",
      turnTreeHash: turnTree.hash,
    };
    const singlePath: StoredTurnTreePath = {
      collectionKind: "single",
      path: "context.manifest",
      singleHash: null,
      turnTreeHash: turnTree.hash,
    };

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.turnTrees.put(turnTree);
        await tx.turnTreePaths.putMany([wrongMessagesPath, singlePath]);
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);
  });

  test("rejects chunked path rows that reference missing chunk records", async () => {
    const backend = createMemoryBackend();
    const schema = createSchema();
    const schemaRecord = createStoredSchema(schema, 1);
    const manifest: TurnTreeManifest = {
      "context.manifest": null,
      messages: [],
    };
    const turnTreeRecord = await createStoredTurnTree(schema, manifest, 2);
    const chunkedPath: StoredTurnTreePath = {
      collectionKind: "ordered",
      orderedChunkListCbor: encodeDeterministicKernelRecord([
        createHashFromIndex(999),
      ]),
      orderedCount: 1,
      orderedEncoding: "chunked",
      path: "messages",
      turnTreeHash: turnTreeRecord.hash,
    };

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.turnTrees.put(turnTreeRecord);
        await tx.turnTreePaths.putMany([
          {
            collectionKind: "single",
            path: "context.manifest",
            singleHash: null,
            turnTreeHash: turnTreeRecord.hash,
          },
          chunkedPath,
        ]);
      })
    ).rejects.toBeInstanceOf(KrakenPersistenceError);
  });
});

function createSchema(): TurnTreeSchema {
  return {
    incorporationRules: [
      {
        objectType: "message",
        targetPath: "messages",
      },
      {
        objectType: "context_manifest",
        targetPath: "context.manifest",
      },
    ],
    paths: [
      {
        collection: "ordered",
        path: "messages",
      },
      {
        collection: "single",
        path: "context.manifest",
      },
    ],
    schemaId: "schema_main",
  };
}

function createStoredSchema(
  schema: TurnTreeSchema,
  createdAtMs: number
): StoredSchema {
  return {
    createdAtMs,
    schemaCbor: encodeDeterministicKernelRecord({
      incorporationRules: schema.incorporationRules.map((rule) => ({
        objectType: rule.objectType,
        targetPath: rule.targetPath,
      })),
      paths: schema.paths.map((path) => ({
        collection: path.collection,
        path: path.path,
      })),
      schemaId: schema.schemaId,
    }),
    schemaId: schema.schemaId,
  };
}

async function createStoredObject(
  bytes: Uint8Array,
  createdAtMs: number
): Promise<StoredObject> {
  return {
    byteLength: bytes.byteLength,
    bytes: Uint8Array.from(bytes),
    createdAtMs,
    hash: await hashOpaqueObjectBytes(bytes),
    mediaType: "application/octet-stream",
  };
}

async function createStoredTurnTree(
  schema: TurnTreeSchema,
  manifest: TurnTreeManifest,
  createdAtMs: number
): Promise<StoredTurnTree> {
  return {
    createdAtMs,
    hash: await hashTurnTreeIdentity(schema.schemaId, manifest, schema),
    manifestCbor: encodeDeterministicKernelRecord(manifest),
    schemaId: schema.schemaId,
  };
}

async function createStoredTurnNode(input: {
  consumedStagedResults: [];
  createdAtMs: number;
  eventHash: string | null;
  previousTurnNodeHash: string | null;
  schemaId: string;
  turnTreeHash: string;
}): Promise<StoredTurnNode> {
  return {
    consumedStagedResultsCbor: encodeDeterministicKernelRecord(
      input.consumedStagedResults
    ),
    createdAtMs: input.createdAtMs,
    eventHash: input.eventHash,
    hash: await hashTurnNodeIdentity({
      consumedStagedResults: input.consumedStagedResults,
      eventHash: input.eventHash,
      previousTurnNodeHash: input.previousTurnNodeHash,
      schemaId: input.schemaId,
      turnTreeHash: input.turnTreeHash,
    }),
    previousTurnNodeHash: input.previousTurnNodeHash,
    schemaId: input.schemaId,
    turnTreeHash: input.turnTreeHash,
  };
}

function createHashSequence(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, index) =>
    createHashFromIndex(index + offset)
  );
}

function createHashFromIndex(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function createNowClock(initialValue: number): () => number {
  let currentValue = initialValue;

  return () => {
    const nextValue = currentValue;
    currentValue += 1;
    return nextValue;
  };
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function createCanonicalTurnTreePaths(
  turnTree: StoredTurnTree,
  messages: string[]
): StoredTurnTreePath[] {
  return [
    {
      collectionKind: "single",
      path: "context.manifest",
      singleHash: null,
      turnTreeHash: turnTree.hash,
    },
    {
      collectionKind: "ordered",
      orderedCount: messages.length,
      orderedEncoding: "flat",
      orderedInlineCbor: encodeDeterministicKernelRecord(messages),
      path: "messages",
      turnTreeHash: turnTree.hash,
    },
  ];
}
