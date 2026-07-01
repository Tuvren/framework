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

import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { TuvrenPersistenceError } from "@tuvren/core";
import {
  encodeDeterministicKernelRecord,
  type StoredBranch,
  type StoredRun,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
} from "@tuvren/kernel-protocol";
import type { BackendConformanceSuiteOptions } from "./backend-test-suite-types.js";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createHashFromIndex,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "./kernel-test-fixtures.js";

const BOOM_ERROR_PATTERN = /boom/u;

export function registerBackendConformanceSuite(
  options: BackendConformanceSuiteOptions
): void {
  const suiteName = options.suiteName ?? "Backend Conformance";

  options.testApi.describe(suiteName, () => {
    options.testApi.test("reports healthy status", async () => {
      const backend = options.createBackend();

      deepStrictEqual(await backend.health(), { ok: true });
    });

    options.testApi.test(
      "rolls back failed transactions without partially visible writes",
      async () => {
        const backend = options.createBackend();
        const objectRecord = await createStoredObjectRecord(
          new Uint8Array([1, 2, 3]),
          1
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.objects.put(objectRecord);
            throw new Error("boom");
          }),
          BOOM_ERROR_PATTERN
        );

        await backend.transact(async (tx) => {
          strictEqual(await tx.objects.get(objectRecord.hash), null);
        });

        await backend.transact(async (tx) => {
          await tx.objects.put(objectRecord);
        });

        await backend.transact(async (tx) => {
          const storedObject = await tx.objects.get(objectRecord.hash);
          if (storedObject === null) {
            throw new Error("expected stored object");
          }

          strictEqual(storedObject.hash, objectRecord.hash);
          strictEqual(storedObject.byteLength, objectRecord.byteLength);
        });
      }
    );

    options.testApi.test(
      "stores lineage and run-state records with deterministic list and clear helpers",
      async () => {
        const backend = options.createBackend();
        const schema = createCanonicalKernelTestSchema();
        const schemaRecord = createStoredSchemaRecord(schema, 100);
        const turnTreeRecord = await createStoredTurnTreeRecord(
          schema,
          {
            "context.manifest": null,
            messages: [],
          },
          101
        );
        const eventObject = await createStoredObjectRecord(
          new Uint8Array([9, 9, 9]),
          102
        );
        const turnNodeRecord = await createStoredTurnNodeRecord({
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
          createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
          currentStepIndex: 0,
          runId: "run_main",
          schemaId: schema.schemaId,
          startTurnNodeHash: turnNodeRecord.hash,
          status: "running",
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
        const stagedObject = await createStoredObjectRecord(
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
            createCanonicalTurnTreePaths(turnTreeRecord, {
              "context.manifest": null,
              messages: [],
            })
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
          deepStrictEqual(
            await tx.turnNodes.get(turnNodeRecord.hash),
            turnNodeRecord
          );
          deepStrictEqual(
            await tx.threads.get(threadRecord.threadId),
            threadRecord
          );
          deepStrictEqual(
            await tx.branches.listByThread(threadRecord.threadId),
            [branchRecord]
          );
          deepStrictEqual(await tx.runs.listByBranch(branchRecord.branchId), [
            runRecord,
          ]);
          deepStrictEqual(await tx.stagedResults.listByRun(runRecord.runId), [
            stagedResult,
          ]);

          await tx.stagedResults.clearRun(runRecord.runId);
          deepStrictEqual(
            await tx.stagedResults.listByRun(runRecord.runId),
            []
          );
        });
      }
    );

    options.testApi.test("accepts idempotent object writes", async () => {
      const backend = options.createBackend();
      const objectRecord = await createStoredObjectRecord(
        new Uint8Array([4, 5, 6]),
        1
      );

      await backend.transact(async (tx) => {
        await tx.objects.put(objectRecord);
        await tx.objects.put(objectRecord);
      });

      await backend.transact(async (tx) => {
        deepStrictEqual(await tx.objects.get(objectRecord.hash), objectRecord);
      });
    });

    options.testApi.test(
      "rejects branch heads and archive metadata that cross thread lineage",
      async () => {
        const backend = options.createBackend();
        const schema = createCanonicalKernelTestSchema();
        const schemaRecord = createStoredSchemaRecord(schema, 1);
        const turnTreeA = await createStoredTurnTreeRecord(
          schema,
          { "context.manifest": null, messages: [] },
          2
        );
        const turnTreeB = await createStoredTurnTreeRecord(
          schema,
          { "context.manifest": null, messages: [createHashFromIndex(1)] },
          3
        );
        const rootNodeA = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 4,
          eventHash: null,
          previousTurnNodeHash: null,
          schemaId: schema.schemaId,
          turnTreeHash: turnTreeA.hash,
        });
        const rootNodeB = await createStoredTurnNodeRecord({
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
          await tx.turnTrees.put(turnTreeB);
          await tx.turnTreePaths.putMany(
            createCanonicalTurnTreePaths(turnTreeA, {
              "context.manifest": null,
              messages: [],
            })
          );
          await tx.turnTreePaths.putMany(
            createCanonicalTurnTreePaths(turnTreeB, {
              "context.manifest": null,
              messages: [createHashFromIndex(1)],
            })
          );
          await tx.turnNodes.put(rootNodeA);
          await tx.turnNodes.put(rootNodeB);
          await tx.threads.put(threadA);
          await tx.threads.put(threadB);
          await tx.branches.set(branchB);
        });

        await rejects(
          backend.transact(async (tx) => {
            await tx.branches.set({
              branchId: "branch_cross_head",
              createdAtMs: 9,
              headTurnNodeHash: rootNodeB.hash,
              threadId: threadA.threadId,
              updatedAtMs: 9,
            });
          }),
          TuvrenPersistenceError
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.branches.set({
              archivedFromBranchId: branchB.branchId,
              branchId: "branch_cross_archive",
              createdAtMs: 10,
              headTurnNodeHash: rootNodeA.hash,
              threadId: threadA.threadId,
              updatedAtMs: 10,
            });
          }),
          TuvrenPersistenceError
        );
      }
    );
  });
}
