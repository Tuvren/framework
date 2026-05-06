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

import { deepStrictEqual, rejects } from "node:assert/strict";
import {
  TuvrenPersistenceError,
  TuvrenValidationError,
} from "@tuvren/core-types";
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
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "./kernel-test-fixtures.js";

export function registerBackendInvariantFoundationCases(
  options: BackendConformanceSuiteOptions
): void {
  options.testApi.test(
    "preserves deterministic list ordering for branches, runs, and staged results",
    async () => {
      const backend = options.createBackend();
      const schema = createCanonicalKernelTestSchema();
      const schemaRecord = createStoredSchemaRecord(schema, 300);
      const turnTree = await createStoredTurnTreeRecord(
        schema,
        {
          "context.manifest": null,
          messages: [],
        },
        301
      );
      const turnNode = await createStoredTurnNodeRecord({
        consumedStagedResults: [],
        createdAtMs: 302,
        eventHash: null,
        previousTurnNodeHash: null,
        schemaId: schema.schemaId,
        turnTreeHash: turnTree.hash,
      });
      const lateTurnNode = await createStoredTurnNodeRecord({
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
      const objectA = await createStoredObjectRecord(new Uint8Array([1]), 309);
      const objectB = await createStoredObjectRecord(new Uint8Array([2]), 310);
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
          createCanonicalTurnTreePaths(turnTree, {
            "context.manifest": null,
            messages: [],
          })
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
          currentStepIndex: 0,
          status: "running",
        });
        await tx.runs.set(orderedRunB);
        await tx.runs.set({
          ...orderedRunA,
          currentStepIndex: 0,
          status: "running",
        });
        await tx.runs.set(orderedRunA);
        await tx.objects.put(objectA);
        await tx.objects.put(objectB);
        await tx.stagedResults.set(stagedB);
        await tx.stagedResults.set(stagedA);
      });

      await backend.transact(async (tx) => {
        deepStrictEqual(
          (await tx.branches.listByThread(thread.threadId)).map(
            (branch) => branch.branchId
          ),
          ["branch_b", "branch_a"]
        );
        deepStrictEqual(
          (await tx.runs.listByBranch(lateBranch.branchId)).map(
            (run) => run.runId
          ),
          ["run_a", "run_b"]
        );
        deepStrictEqual(
          (await tx.stagedResults.listByRun(stagedRun.runId)).map(
            (stagedResult) => stagedResult.taskId
          ),
          ["task_a", "task_b"]
        );
      });
    }
  );

  options.testApi.test(
    "rolls back grouped writes when repository validation fails mid-transaction",
    async () => {
      const backend = options.createBackend();
      const schema = createCanonicalKernelTestSchema();
      const schemaRecord = createStoredSchemaRecord(schema, 1);
      const turnTree = await createStoredTurnTreeRecord(
        schema,
        {
          "context.manifest": null,
          messages: [],
        },
        2
      );
      const duplicatePath = {
        collectionKind: "single" as const,
        path: "context.manifest",
        singleHash: null,
        turnTreeHash: turnTree.hash,
      };

      await rejects(
        backend.transact(async (tx) => {
          await tx.schemas.put(schemaRecord);
          await tx.turnTrees.put(turnTree);
          await tx.turnTreePaths.putMany([duplicatePath, duplicatePath]);
        }),
        TuvrenPersistenceError
      );

      await backend.transact(async (tx) => {
        deepStrictEqual(await tx.schemas.get(schema.schemaId), null);
        deepStrictEqual(await tx.turnTrees.get(turnTree.hash), null);
        deepStrictEqual(
          await tx.turnTreePaths.get(turnTree.hash, "context.manifest"),
          null
        );
      });
    }
  );

  options.testApi.test(
    "rejects thread and turn-node schema mismatches",
    async () => {
      const backend = options.createBackend();
      const schemaA = createCanonicalKernelTestSchema();
      const schemaB = {
        ...createCanonicalKernelTestSchema(),
        schemaId: "schema_alt",
      };
      const schemaRecordA = createStoredSchemaRecord(schemaA, 1);
      const schemaRecordB = createStoredSchemaRecord(schemaB, 2);
      const turnTreeA = await createStoredTurnTreeRecord(
        schemaA,
        { "context.manifest": null, messages: [] },
        3
      );
      const turnNodeA = await createStoredTurnNodeRecord({
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
          createCanonicalTurnTreePaths(turnTreeA, {
            "context.manifest": null,
            messages: [],
          })
        );
        await tx.turnNodes.put(turnNodeA);
      });

      await rejects(
        backend.transact(async (tx) => {
          await tx.threads.put({
            createdAtMs: 5,
            rootTurnNodeHash: turnNodeA.hash,
            schemaId: schemaB.schemaId,
            threadId: "thread_schema_mismatch",
          });
        }),
        TuvrenPersistenceError
      );

      await rejects(
        backend.transact(async (tx) => {
          await tx.turnNodes.put({
            ...turnNodeA,
            schemaId: schemaB.schemaId,
          });
        }),
        TuvrenValidationError
      );
    }
  );

  options.testApi.test(
    "rejects cross-record reference mismatches for branch, turn, and run state",
    async () => {
      const backend = options.createBackend();
      const schema = createCanonicalKernelTestSchema();
      const schemaRecord = createStoredSchemaRecord(schema, 1);
      const turnTree = await createStoredTurnTreeRecord(
        schema,
        {
          "context.manifest": null,
          messages: [],
        },
        2
      );
      const siblingTurnTree = await createStoredTurnTreeRecord(
        schema,
        {
          "context.manifest": null,
          messages: ["9".repeat(64)],
        },
        3
      );
      const turnNode = await createStoredTurnNodeRecord({
        consumedStagedResults: [],
        createdAtMs: 4,
        eventHash: null,
        previousTurnNodeHash: null,
        schemaId: schema.schemaId,
        turnTreeHash: turnTree.hash,
      });
      const siblingTurnNode = await createStoredTurnNodeRecord({
        consumedStagedResults: [],
        createdAtMs: 5,
        eventHash: null,
        previousTurnNodeHash: null,
        schemaId: schema.schemaId,
        turnTreeHash: siblingTurnTree.hash,
      });
      const threadA: StoredThread = {
        createdAtMs: 6,
        rootTurnNodeHash: turnNode.hash,
        schemaId: schema.schemaId,
        threadId: "thread_a",
      };
      const threadB: StoredThread = {
        createdAtMs: 7,
        rootTurnNodeHash: siblingTurnNode.hash,
        schemaId: schema.schemaId,
        threadId: "thread_b",
      };
      const branchA: StoredBranch = {
        branchId: "branch_a",
        createdAtMs: 8,
        headTurnNodeHash: turnNode.hash,
        threadId: threadA.threadId,
        updatedAtMs: 8,
      };
      const branchB: StoredBranch = {
        branchId: "branch_b",
        createdAtMs: 9,
        headTurnNodeHash: siblingTurnNode.hash,
        threadId: threadB.threadId,
        updatedAtMs: 9,
      };
      const turnOnA: StoredTurn = {
        branchId: branchA.branchId,
        createdAtMs: 10,
        headTurnNodeHash: turnNode.hash,
        parentTurnId: null,
        startTurnNodeHash: turnNode.hash,
        threadId: threadA.threadId,
        turnId: "turn_a",
        updatedAtMs: 10,
      };

      await backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.turnTrees.put(turnTree);
        await tx.turnTrees.put(siblingTurnTree);
        await tx.turnTreePaths.putMany(
          createCanonicalTurnTreePaths(turnTree, {
            "context.manifest": null,
            messages: [],
          })
        );
        await tx.turnTreePaths.putMany(
          createCanonicalTurnTreePaths(siblingTurnTree, {
            "context.manifest": null,
            messages: ["9".repeat(64)],
          })
        );
        await tx.turnNodes.put(turnNode);
        await tx.turnNodes.put(siblingTurnNode);
        await tx.threads.put(threadA);
        await tx.threads.put(threadB);
        await tx.branches.set(branchA);
        await tx.branches.set(branchB);
        await tx.turns.set(turnOnA);
      });

      await rejects(
        backend.transact(async (tx) => {
          await tx.turns.set({
            ...turnOnA,
            branchId: branchB.branchId,
            turnId: "turn_mismatch",
          });
        }),
        TuvrenPersistenceError
      );

      await rejects(
        backend.transact(async (tx) => {
          await tx.runs.set({
            branchId: branchB.branchId,
            createdAtMs: 11,
            createdTurnNodesCbor: encodeDeterministicKernelRecord([
              turnNode.hash,
            ]),
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
            updatedAtMs: 11,
          });
        }),
        TuvrenPersistenceError
      );
    }
  );
}
