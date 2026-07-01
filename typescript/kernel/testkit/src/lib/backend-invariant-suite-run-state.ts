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

import { rejects } from "node:assert/strict";
import { TuvrenPersistenceError } from "@tuvren/core";
import {
  encodeDeterministicKernelRecord,
  type StoredBranch,
  type StoredRun,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
} from "@tuvren/kernel-protocol";
import { registerBackendInvariantFoundationCases } from "./backend-invariant-suite-foundation.js";
import type { BackendConformanceSuiteOptions } from "./backend-test-suite-types.js";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "./kernel-test-fixtures.js";

export function registerBackendInvariantRunStateCases(
  options: BackendConformanceSuiteOptions
): void {
  registerBackendInvariantFoundationCases(options);

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
}
