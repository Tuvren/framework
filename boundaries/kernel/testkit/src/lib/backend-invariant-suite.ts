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
  createHashFromIndex,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "./kernel-test-fixtures.js";

export function registerBackendInvariantSuite(
  options: BackendConformanceSuiteOptions
): void {
  const suiteName = options.suiteName ?? "Backend Invariants";

  options.testApi.describe(suiteName, () => {
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
        const objectA = await createStoredObjectRecord(
          new Uint8Array([1]),
          309
        );
        const objectB = await createStoredObjectRecord(
          new Uint8Array([2]),
          310
        );
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

    options.testApi.test(
      "rejects runs with stale branch heads, schema mismatches, duplicate active runs, and invalid initial statuses",
      async () => {
        const backend = options.createBackend();
        const schemaA = createCanonicalKernelTestSchema();
        const schemaB = {
          ...createCanonicalKernelTestSchema(),
          schemaId: "schema_run_alt",
        };
        const schemaRecordA = createStoredSchemaRecord(schemaA, 1);
        const schemaRecordB = createStoredSchemaRecord(schemaB, 2);
        const turnTree = await createStoredTurnTreeRecord(
          schemaA,
          { "context.manifest": null, messages: [] },
          3
        );
        const rootNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 4,
          eventHash: null,
          previousTurnNodeHash: null,
          schemaId: schemaA.schemaId,
          turnTreeHash: turnTree.hash,
        });
        const nextNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 5,
          eventHash: null,
          previousTurnNodeHash: rootNode.hash,
          schemaId: schemaA.schemaId,
          turnTreeHash: turnTree.hash,
        });
        const finalNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 6,
          eventHash: null,
          previousTurnNodeHash: nextNode.hash,
          schemaId: schemaA.schemaId,
          turnTreeHash: turnTree.hash,
        });
        const thread: StoredThread = {
          createdAtMs: 7,
          rootTurnNodeHash: rootNode.hash,
          schemaId: schemaA.schemaId,
          threadId: "thread_run_invariants",
        };
        const branch: StoredBranch = {
          branchId: "branch_run_invariants",
          createdAtMs: 8,
          headTurnNodeHash: finalNode.hash,
          threadId: thread.threadId,
          updatedAtMs: 8,
        };
        const turn: StoredTurn = {
          branchId: branch.branchId,
          createdAtMs: 9,
          headTurnNodeHash: finalNode.hash,
          parentTurnId: null,
          startTurnNodeHash: rootNode.hash,
          threadId: thread.threadId,
          turnId: "turn_run_invariants",
          updatedAtMs: 9,
        };

        await backend.transact(async (tx) => {
          await tx.schemas.put(schemaRecordA);
          await tx.schemas.put(schemaRecordB);
          await tx.turnTrees.put(turnTree);
          await tx.turnTreePaths.putMany(
            createCanonicalTurnTreePaths(turnTree, {
              "context.manifest": null,
              messages: [],
            })
          );
          await tx.turnNodes.put(rootNode);
          await tx.turnNodes.put(nextNode);
          await tx.turnNodes.put(finalNode);
          await tx.threads.put(thread);
          await tx.branches.set(branch);
          await tx.turns.set(turn);
        });

        await rejects(
          backend.transact(async (tx) => {
            await tx.runs.set({
              branchId: branch.branchId,
              createdAtMs: 10,
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
              updatedAtMs: 10,
            });
          }),
          TuvrenPersistenceError
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.runs.set({
              branchId: branch.branchId,
              createdAtMs: 11,
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
              updatedAtMs: 11,
            });
          }),
          TuvrenPersistenceError
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.runs.set({
              branchId: branch.branchId,
              createdAtMs: 12,
              createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
              currentStepIndex: 0,
              runId: "run_start_not_branch_head",
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
              updatedAtMs: 12,
            });
          }),
          TuvrenPersistenceError
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.runs.set({
              branchId: branch.branchId,
              createdAtMs: 13,
              createdTurnNodesCbor: encodeDeterministicKernelRecord([
                finalNode.hash,
              ]),
              currentStepIndex: 0,
              runId: "run_created_nodes_subset",
              schemaId: schemaA.schemaId,
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
              updatedAtMs: 13,
            });
          }),
          TuvrenPersistenceError
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.runs.set({
              branchId: branch.branchId,
              createdAtMs: 14,
              createdTurnNodesCbor: encodeDeterministicKernelRecord([
                finalNode.hash,
              ]),
              currentStepIndex: 0,
              runId: "run_created_nodes_include_start",
              schemaId: schemaA.schemaId,
              startTurnNodeHash: finalNode.hash,
              status: "running",
              stepSequenceCbor: encodeDeterministicKernelRecord([
                {
                  deterministic: false,
                  id: "model_call",
                  sideEffects: false,
                },
              ]),
              turnId: turn.turnId,
              updatedAtMs: 14,
            });
          }),
          TuvrenPersistenceError
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.runs.set({
              branchId: branch.branchId,
              createdAtMs: 15,
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
              updatedAtMs: 15,
            });
            await tx.runs.set({
              branchId: branch.branchId,
              createdAtMs: 16,
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
              updatedAtMs: 16,
            });
          }),
          TuvrenPersistenceError
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.runs.set({
              branchId: branch.branchId,
              createdAtMs: 17,
              createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
              currentStepIndex: 1,
              runId: "run_created_completed",
              schemaId: schemaA.schemaId,
              startTurnNodeHash: nextNode.hash,
              status: "completed",
              stepSequenceCbor: encodeDeterministicKernelRecord([
                {
                  deterministic: false,
                  id: "model_call",
                  sideEffects: false,
                },
              ]),
              turnId: turn.turnId,
              updatedAtMs: 17,
            });
          }),
          TuvrenPersistenceError
        );
      }
    );

    options.testApi.test(
      "rejects active runs that fall behind branch and turn heads",
      async () => {
        const backend = options.createBackend();
        const schema = createCanonicalKernelTestSchema();
        const schemaRecord = createStoredSchemaRecord(schema, 1);
        const turnTree = await createStoredTurnTreeRecord(
          schema,
          { "context.manifest": null, messages: [] },
          2
        );
        const rootNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 3,
          eventHash: null,
          previousTurnNodeHash: null,
          schemaId: schema.schemaId,
          turnTreeHash: turnTree.hash,
        });
        const nextNode = await createStoredTurnNodeRecord({
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
          threadId: "thread_active_run_alignment",
        };
        const branch: StoredBranch = {
          branchId: "branch_active_run_alignment",
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
          turnId: "turn_active_run_alignment",
          updatedAtMs: 7,
        };
        const run: StoredRun = {
          branchId: branch.branchId,
          createdAtMs: 8,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
          currentStepIndex: 0,
          runId: "run_active_run_alignment",
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

        await backend.transact(async (tx) => {
          await tx.schemas.put(schemaRecord);
          await tx.turnTrees.put(turnTree);
          await tx.turnTreePaths.putMany(
            createCanonicalTurnTreePaths(turnTree, {
              "context.manifest": null,
              messages: [],
            })
          );
          await tx.turnNodes.put(rootNode);
          await tx.turnNodes.put(nextNode);
          await tx.threads.put(thread);
          await tx.branches.set(branch);
          await tx.turns.set(turn);
          await tx.runs.set(run);
        });

        await rejects(
          backend.transact(async (tx) => {
            await tx.branches.set({
              ...branch,
              headTurnNodeHash: nextNode.hash,
              updatedAtMs: 9,
            });
            await tx.turns.set({
              ...turn,
              headTurnNodeHash: nextNode.hash,
              updatedAtMs: 9,
            });
          }),
          TuvrenPersistenceError
        );
      }
    );

    options.testApi.test(
      "rejects staged results for non-running runs and keeps staged results immutable per (runId, taskId)",
      async () => {
        const backend = options.createBackend();
        const schema = createCanonicalKernelTestSchema();
        const schemaRecord = createStoredSchemaRecord(schema, 1);
        const turnTree = await createStoredTurnTreeRecord(
          schema,
          { "context.manifest": null, messages: [] },
          2
        );
        const turnNode = await createStoredTurnNodeRecord({
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
          threadId: "thread_staging_status",
        };
        const branch: StoredBranch = {
          branchId: "branch_staging_status",
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
          turnId: "turn_staging_status",
          updatedAtMs: 6,
        };
        const runningRun: StoredRun = {
          branchId: branch.branchId,
          createdAtMs: 7,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
          currentStepIndex: 0,
          runId: "run_not_running",
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
        const stagedObject = await createStoredObjectRecord(
          new Uint8Array([1]),
          8
        );
        const stagedResult: StoredStagedResult = {
          createdAtMs: 9,
          objectHash: stagedObject.hash,
          objectType: "message",
          runId: runningRun.runId,
          status: "completed",
          taskId: "task_stage",
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
          await tx.threads.put(thread);
          await tx.branches.set(branch);
          await tx.turns.set(turn);
          await tx.runs.set(runningRun);
          await tx.objects.put(stagedObject);
        });

        await backend.transact(async (tx) => {
          await tx.runs.set({
            ...runningRun,
            status: "completed",
            currentStepIndex: 1,
            updatedAtMs: 10,
          });
        });

        await rejects(
          backend.transact(async (tx) => {
            await tx.stagedResults.set({
              ...stagedResult,
              taskId: "task_after_completion",
            });
          }),
          TuvrenPersistenceError
        );

        const immutableBackend = options.createBackend();

        await immutableBackend.transact(async (tx) => {
          await tx.schemas.put(schemaRecord);
          await tx.turnTrees.put(turnTree);
          await tx.turnTreePaths.putMany(
            createCanonicalTurnTreePaths(turnTree, {
              "context.manifest": null,
              messages: [],
            })
          );
          await tx.turnNodes.put(turnNode);
          await tx.threads.put(thread);
          await tx.branches.set(branch);
          await tx.turns.set(turn);
          await tx.runs.set(runningRun);
          await tx.objects.put(stagedObject);
          await tx.stagedResults.set(stagedResult);
        });

        await rejects(
          immutableBackend.transact(async (tx) => {
            await tx.stagedResults.set({
              ...stagedResult,
              createdAtMs: 10,
            });
          }),
          TuvrenPersistenceError
        );

        await rejects(
          immutableBackend.transact(async (tx) => {
            await tx.stagedResults.set({
              ...stagedResult,
              status: "failed",
            });
          }),
          TuvrenPersistenceError
        );
      }
    );

    options.testApi.test(
      "rejects turns whose parent is not the immediate predecessor and rejects ambiguous null parents",
      async () => {
        const backend = options.createBackend();
        const schema = createCanonicalKernelTestSchema();
        const schemaRecord = createStoredSchemaRecord(schema, 1);
        const turnTree = await createStoredTurnTreeRecord(
          schema,
          { "context.manifest": null, messages: [] },
          2
        );
        const siblingTurnTree = await createStoredTurnTreeRecord(
          schema,
          { "context.manifest": null, messages: ["8".repeat(64)] },
          3
        );
        const rootNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 4,
          eventHash: null,
          previousTurnNodeHash: null,
          schemaId: schema.schemaId,
          turnTreeHash: turnTree.hash,
        });
        const nextNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 5,
          eventHash: null,
          previousTurnNodeHash: rootNode.hash,
          schemaId: schema.schemaId,
          turnTreeHash: turnTree.hash,
        });
        const finalNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 6,
          eventHash: null,
          previousTurnNodeHash: nextNode.hash,
          schemaId: schema.schemaId,
          turnTreeHash: turnTree.hash,
        });
        const siblingNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 7,
          eventHash: null,
          previousTurnNodeHash: nextNode.hash,
          schemaId: schema.schemaId,
          turnTreeHash: siblingTurnTree.hash,
        });
        const tailNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 8,
          eventHash: null,
          previousTurnNodeHash: finalNode.hash,
          schemaId: schema.schemaId,
          turnTreeHash: turnTree.hash,
        });
        const thread: StoredThread = {
          createdAtMs: 9,
          rootTurnNodeHash: rootNode.hash,
          schemaId: schema.schemaId,
          threadId: "thread_parent_links",
        };
        const mainBranch: StoredBranch = {
          branchId: "branch_parent_links_main",
          createdAtMs: 10,
          headTurnNodeHash: tailNode.hash,
          threadId: thread.threadId,
          updatedAtMs: 10,
        };
        const siblingBranch: StoredBranch = {
          branchId: "branch_parent_links_sibling",
          createdAtMs: 11,
          headTurnNodeHash: siblingNode.hash,
          threadId: thread.threadId,
          updatedAtMs: 11,
        };
        const firstTurn: StoredTurn = {
          branchId: mainBranch.branchId,
          createdAtMs: 12,
          headTurnNodeHash: nextNode.hash,
          parentTurnId: null,
          startTurnNodeHash: rootNode.hash,
          threadId: thread.threadId,
          turnId: "turn_parent_first",
          updatedAtMs: 12,
        };
        const secondTurn: StoredTurn = {
          branchId: mainBranch.branchId,
          createdAtMs: 13,
          headTurnNodeHash: finalNode.hash,
          parentTurnId: firstTurn.turnId,
          startTurnNodeHash: nextNode.hash,
          threadId: thread.threadId,
          turnId: "turn_parent_second",
          updatedAtMs: 13,
        };
        const siblingTurn: StoredTurn = {
          branchId: siblingBranch.branchId,
          createdAtMs: 14,
          headTurnNodeHash: siblingNode.hash,
          parentTurnId: firstTurn.turnId,
          startTurnNodeHash: nextNode.hash,
          threadId: thread.threadId,
          turnId: "turn_parent_sibling",
          updatedAtMs: 14,
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
              messages: ["8".repeat(64)],
            })
          );
          await tx.turnNodes.put(rootNode);
          await tx.turnNodes.put(nextNode);
          await tx.turnNodes.put(finalNode);
          await tx.turnNodes.put(siblingNode);
          await tx.turnNodes.put(tailNode);
          await tx.threads.put(thread);
          await tx.branches.set(mainBranch);
          await tx.branches.set(siblingBranch);
          await tx.turns.set(firstTurn);
          await tx.turns.set(secondTurn);
        });

        await rejects(
          backend.transact(async (tx) => {
            await tx.turns.set({
              ...secondTurn,
              parentTurnId: null,
              turnId: "turn_null_parent_ambiguous",
            });
          }),
          TuvrenPersistenceError
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.turns.set({
              ...secondTurn,
              parentTurnId: "missing_turn",
              turnId: "turn_bad_parent",
            });
          }),
          TuvrenPersistenceError
        );

        await backend.transact(async (tx) => {
          await tx.turns.set(siblingTurn);
        });

        await rejects(
          backend.transact(async (tx) => {
            await tx.turns.set({
              branchId: mainBranch.branchId,
              createdAtMs: 15,
              headTurnNodeHash: tailNode.hash,
              parentTurnId: firstTurn.turnId,
              startTurnNodeHash: finalNode.hash,
              threadId: thread.threadId,
              turnId: "turn_parent_stale",
              updatedAtMs: 15,
            });
          }),
          TuvrenPersistenceError
        );
      }
    );

    options.testApi.test(
      "rejects regressing updatedAtMs on branch, turn, and run updates",
      async () => {
        const backend = options.createBackend();
        const schema = createCanonicalKernelTestSchema();
        const schemaRecord = createStoredSchemaRecord(schema, 1);
        const turnTree = await createStoredTurnTreeRecord(
          schema,
          { "context.manifest": null, messages: [] },
          2
        );
        const rootNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 3,
          eventHash: null,
          previousTurnNodeHash: null,
          schemaId: schema.schemaId,
          turnTreeHash: turnTree.hash,
        });
        const nextNode = await createStoredTurnNodeRecord({
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
          threadId: "thread_updated_at",
        };
        const branch: StoredBranch = {
          branchId: "branch_updated_at",
          createdAtMs: 6,
          headTurnNodeHash: rootNode.hash,
          threadId: thread.threadId,
          updatedAtMs: 10,
        };
        const turn: StoredTurn = {
          branchId: branch.branchId,
          createdAtMs: 7,
          headTurnNodeHash: rootNode.hash,
          parentTurnId: null,
          startTurnNodeHash: rootNode.hash,
          threadId: thread.threadId,
          turnId: "turn_updated_at",
          updatedAtMs: 10,
        };
        const run: StoredRun = {
          branchId: branch.branchId,
          createdAtMs: 8,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
          currentStepIndex: 0,
          runId: "run_updated_at",
          schemaId: schema.schemaId,
          startTurnNodeHash: rootNode.hash,
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
          updatedAtMs: 10,
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
          await tx.turnNodes.put(rootNode);
          await tx.turnNodes.put(nextNode);
          await tx.threads.put(thread);
          await tx.branches.set(branch);
          await tx.turns.set(turn);
          await tx.runs.set(run);
        });

        await rejects(
          backend.transact(async (tx) => {
            await tx.branches.set({
              ...branch,
              headTurnNodeHash: nextNode.hash,
              updatedAtMs: 9,
            });
          }),
          TuvrenPersistenceError
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.turns.set({
              ...turn,
              headTurnNodeHash: nextNode.hash,
              updatedAtMs: 9,
            });
          }),
          TuvrenPersistenceError
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.runs.set({
              ...run,
              currentStepIndex: 1,
              updatedAtMs: 9,
            });
          }),
          TuvrenPersistenceError
        );
      }
    );

    options.testApi.test("rejects forged archive branches", async () => {
      const { backend, branch, headNode, middleNode, thread } =
        await createArchiveRollbackScenario(options);

      await rejects(
        backend.transact(async (tx) => {
          await tx.branches.set({
            archivedFromBranchId: branch.branchId,
            branchId: "branch_forged_archive",
            createdAtMs: 8,
            headTurnNodeHash: middleNode.hash,
            threadId: thread.threadId,
            updatedAtMs: 8,
          });
        }),
        TuvrenPersistenceError
      );

      await rejects(
        backend.transact(async (tx) => {
          await tx.branches.set({
            archivedFromBranchId: branch.branchId,
            branchId: "branch_forged_archive_same_head",
            createdAtMs: 9,
            headTurnNodeHash: headNode.hash,
            threadId: thread.threadId,
            updatedAtMs: 9,
          });
        }),
        TuvrenPersistenceError
      );
    });

    options.testApi.test("rejects stale archival rollback state", async () => {
      const { backend, branch, headNode, middleNode, rootNode, thread } =
        await createArchiveRollbackScenario(options);

      await backend.transact(async (tx) => {
        await tx.branches.set({
          ...branch,
          headTurnNodeHash: middleNode.hash,
          updatedAtMs: 8,
        });
        await tx.branches.set({
          archivedFromBranchId: branch.branchId,
          branchId: "branch_stale_archive",
          createdAtMs: 8,
          headTurnNodeHash: headNode.hash,
          threadId: thread.threadId,
          updatedAtMs: 8,
        });
      });

      await rejects(
        backend.transact(async (tx) => {
          await tx.branches.set({
            ...branch,
            headTurnNodeHash: rootNode.hash,
            updatedAtMs: 9,
          });
        }),
        TuvrenPersistenceError
      );
    });

    options.testApi.test(
      "rejects threads whose root turn node is not genesis",
      async () => {
        const backend = options.createBackend();
        const { schema, schemaRecord, turnTree, rootNode, middleNode } =
          await createArchiveRollbackFixtures();

        await rejects(
          backend.transact(async (tx) => {
            await tx.schemas.put(schemaRecord);
            await tx.turnTrees.put(turnTree);
            await tx.turnTreePaths.putMany(
              createCanonicalTurnTreePaths(turnTree, {
                "context.manifest": null,
                messages: [],
              })
            );
            await tx.turnNodes.put(rootNode);
            await tx.turnNodes.put(middleNode);
            await tx.threads.put({
              createdAtMs: 9,
              rootTurnNodeHash: middleNode.hash,
              schemaId: schema.schemaId,
              threadId: "thread_non_genesis_root",
            });
          }),
          TuvrenPersistenceError
        );
      }
    );

    options.testApi.test(
      "rejects turn nodes whose consumed staged results reference missing objects",
      async () => {
        const backend = options.createBackend();
        const { schema, schemaRecord, turnTree } =
          await createArchiveRollbackFixtures();

        await rejects(
          backend.transact(async (tx) => {
            await tx.schemas.put(schemaRecord);
            await tx.turnTrees.put(turnTree);
            await tx.turnTreePaths.putMany(
              createCanonicalTurnTreePaths(turnTree, {
                "context.manifest": null,
                messages: [],
              })
            );
            await tx.turnNodes.put(
              await createStoredTurnNodeRecord({
                consumedStagedResults: [
                  {
                    objectHash: createHashFromIndex(999),
                    objectType: "message",
                    status: "completed",
                    taskId: "task_missing_object",
                    timestamp: 3,
                  },
                ],
                createdAtMs: 4,
                eventHash: null,
                previousTurnNodeHash: null,
                schemaId: schema.schemaId,
                turnTreeHash: turnTree.hash,
              })
            );
          }),
          TuvrenPersistenceError
        );
      }
    );

    options.testApi.test(
      "rejects mismatches between turn tree manifests and indexed path rows",
      async () => {
        const backend = options.createBackend();
        const { schema, schemaRecord } = await createArchiveRollbackFixtures();
        const turnTreeWithMessage = await createStoredTurnTreeRecord(
          schema,
          {
            "context.manifest": null,
            messages: [createHashFromIndex(10)],
          },
          2
        );

        await rejects(
          backend.transact(async (tx) => {
            await tx.schemas.put(schemaRecord);
            await tx.turnTrees.put(turnTreeWithMessage);
            await tx.turnTreePaths.putMany([
              {
                collectionKind: "ordered",
                orderedCount: 0,
                orderedEncoding: "flat",
                orderedInlineCbor: encodeDeterministicKernelRecord([]),
                path: "messages",
                turnTreeHash: turnTreeWithMessage.hash,
              },
              {
                collectionKind: "single",
                path: "context.manifest",
                singleHash: null,
                turnTreeHash: turnTreeWithMessage.hash,
              },
            ]);
          }),
          TuvrenPersistenceError
        );
      }
    );

    options.testApi.test(
      "rejects chunked path rows that reference missing chunk records",
      async () => {
        const backend = options.createBackend();
        const { schemaRecord, turnTree } =
          await createArchiveRollbackFixtures();

        await rejects(
          backend.transact(async (tx) => {
            await tx.schemas.put(schemaRecord);
            await tx.turnTrees.put(turnTree);
            await tx.turnTreePaths.putMany([
              {
                collectionKind: "single",
                path: "context.manifest",
                singleHash: null,
                turnTreeHash: turnTree.hash,
              },
              {
                collectionKind: "ordered",
                orderedChunkListCbor: encodeDeterministicKernelRecord([
                  createHashFromIndex(999),
                ]),
                orderedCount: 1,
                orderedEncoding: "chunked",
                path: "messages",
                turnTreeHash: turnTree.hash,
              },
            ]);
          }),
          TuvrenPersistenceError
        );
      }
    );
  });
}

async function createArchiveRollbackFixtures(): Promise<{
  branch: StoredBranch;
  headNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  middleNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  rootNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  schema: ReturnType<typeof createCanonicalKernelTestSchema>;
  schemaRecord: ReturnType<typeof createStoredSchemaRecord>;
  thread: StoredThread;
  turnTree: Awaited<ReturnType<typeof createStoredTurnTreeRecord>>;
}> {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, 1);
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    { "context.manifest": null, messages: [] },
    2
  );
  const rootNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 3,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const middleNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 4,
    eventHash: null,
    previousTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const headNode = await createStoredTurnNodeRecord({
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
    threadId: "thread_archive_provenance",
  };
  const branch: StoredBranch = {
    branchId: "branch_archive_provenance",
    createdAtMs: 7,
    headTurnNodeHash: headNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 7,
  };

  return {
    branch,
    headNode,
    middleNode,
    rootNode,
    schema,
    schemaRecord,
    thread,
    turnTree,
  };
}

async function createArchiveRollbackScenario(
  options: BackendConformanceSuiteOptions
): Promise<{
  backend: ReturnType<BackendConformanceSuiteOptions["createBackend"]>;
  branch: StoredBranch;
  headNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  middleNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  rootNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  schema: ReturnType<typeof createCanonicalKernelTestSchema>;
  schemaRecord: ReturnType<typeof createStoredSchemaRecord>;
  thread: StoredThread;
  turnTree: Awaited<ReturnType<typeof createStoredTurnTreeRecord>>;
}> {
  const backend = options.createBackend();
  const fixtures = await createArchiveRollbackFixtures();

  await backend.transact(async (tx) => {
    await tx.schemas.put(fixtures.schemaRecord);
    await tx.turnTrees.put(fixtures.turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(fixtures.turnTree, {
        "context.manifest": null,
        messages: [],
      })
    );
    await tx.turnNodes.put(fixtures.rootNode);
    await tx.turnNodes.put(fixtures.middleNode);
    await tx.turnNodes.put(fixtures.headNode);
    await tx.threads.put(fixtures.thread);
    await tx.branches.set(fixtures.branch);
  });

  return {
    backend,
    ...fixtures,
  };
}
