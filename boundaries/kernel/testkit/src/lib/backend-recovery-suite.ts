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
import { TuvrenPersistenceError } from "@tuvren/core-types";
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

const CHECKPOINT_FAILURE_PATTERN = /checkpoint failed/u;

export function registerBackendRecoverySuite(
  options: BackendConformanceSuiteOptions
): void {
  const suiteName = options.suiteName ?? "Backend Recovery";

  options.testApi.describe(suiteName, () => {
    options.testApi.test(
      "supports rollback-safe pause and resume checkpoint flows on the same turn",
      async () => {
        const backend = options.createBackend();
        const schema = createCanonicalKernelTestSchema();
        const schemaRecord = createStoredSchemaRecord(schema, 1);
        const rootTurnTree = await createStoredTurnTreeRecord(
          schema,
          { "context.manifest": null, messages: [] },
          2
        );
        const rootTurnNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 3,
          eventHash: null,
          previousTurnNodeHash: null,
          schemaId: schema.schemaId,
          turnTreeHash: rootTurnTree.hash,
        });
        const thread: StoredThread = {
          createdAtMs: 4,
          rootTurnNodeHash: rootTurnNode.hash,
          schemaId: schema.schemaId,
          threadId: "thread_pause_resume",
        };
        const branch: StoredBranch = {
          branchId: "branch_pause_resume",
          createdAtMs: 5,
          headTurnNodeHash: rootTurnNode.hash,
          threadId: thread.threadId,
          updatedAtMs: 5,
        };
        const turn: StoredTurn = {
          branchId: branch.branchId,
          createdAtMs: 6,
          headTurnNodeHash: rootTurnNode.hash,
          parentTurnId: null,
          startTurnNodeHash: rootTurnNode.hash,
          threadId: thread.threadId,
          turnId: "turn_pause_resume",
          updatedAtMs: 6,
        };
        const initialRun: StoredRun = {
          branchId: branch.branchId,
          createdAtMs: 7,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
          currentStepIndex: 0,
          runId: "run_pause_initial",
          schemaId: schema.schemaId,
          startTurnNodeHash: rootTurnNode.hash,
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
        const firstObject = await createStoredObjectRecord(
          new Uint8Array([1]),
          8
        );
        const firstStagedResult: StoredStagedResult = {
          createdAtMs: 9,
          objectHash: firstObject.hash,
          objectType: "message",
          runId: initialRun.runId,
          status: "completed",
          taskId: "task_pause",
        };
        const pausedTurnTree = await createStoredTurnTreeRecord(
          schema,
          { "context.manifest": null, messages: [firstObject.hash] },
          10
        );
        const pausedTurnNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [
            {
              objectHash: firstObject.hash,
              objectType: "message",
              status: "completed",
              taskId: firstStagedResult.taskId,
              timestamp: firstStagedResult.createdAtMs,
            },
          ],
          createdAtMs: 11,
          eventHash: null,
          previousTurnNodeHash: rootTurnNode.hash,
          schemaId: schema.schemaId,
          turnTreeHash: pausedTurnTree.hash,
        });
        const pausedRun: StoredRun = {
          ...initialRun,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            pausedTurnNode.hash,
          ]),
          currentStepIndex: 1,
          status: "paused",
          updatedAtMs: 12,
        };
        const resumedRun: StoredRun = {
          branchId: branch.branchId,
          createdAtMs: 13,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
          currentStepIndex: 0,
          runId: "run_pause_resumed",
          schemaId: schema.schemaId,
          startTurnNodeHash: pausedTurnNode.hash,
          status: "running",
          stepSequenceCbor: encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "tool_execution",
              sideEffects: true,
            },
          ]),
          turnId: turn.turnId,
          updatedAtMs: 13,
        };
        const secondObject = await createStoredObjectRecord(
          new Uint8Array([2]),
          14
        );
        const secondStagedResult: StoredStagedResult = {
          createdAtMs: 15,
          objectHash: secondObject.hash,
          objectType: "message",
          runId: resumedRun.runId,
          status: "completed",
          taskId: "task_resume",
        };
        const completedTurnTree = await createStoredTurnTreeRecord(
          schema,
          {
            "context.manifest": null,
            messages: [firstObject.hash, secondObject.hash],
          },
          16
        );
        const completedTurnNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [
            {
              objectHash: secondObject.hash,
              objectType: "message",
              status: "completed",
              taskId: secondStagedResult.taskId,
              timestamp: secondStagedResult.createdAtMs,
            },
          ],
          createdAtMs: 17,
          eventHash: null,
          previousTurnNodeHash: pausedTurnNode.hash,
          schemaId: schema.schemaId,
          turnTreeHash: completedTurnTree.hash,
        });
        const completedResumedRun: StoredRun = {
          ...resumedRun,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([
            completedTurnNode.hash,
          ]),
          currentStepIndex: 1,
          status: "completed",
          updatedAtMs: 18,
        };

        await backend.transact(async (tx) => {
          await tx.schemas.put(schemaRecord);
          await tx.turnTrees.put(rootTurnTree);
          await tx.turnTreePaths.putMany(
            createCanonicalTurnTreePaths(rootTurnTree, {
              "context.manifest": null,
              messages: [],
            })
          );
          await tx.turnNodes.put(rootTurnNode);
          await tx.threads.put(thread);
          await tx.branches.set(branch);
          await tx.turns.set(turn);
          await tx.runs.set(initialRun);
          await tx.objects.put(firstObject);
          await tx.stagedResults.set(firstStagedResult);
        });

        await rejects(
          backend.transact(async (tx) => {
            await tx.turnTrees.put(pausedTurnTree);
            await tx.turnTreePaths.putMany(
              createCanonicalTurnTreePaths(pausedTurnTree, {
                "context.manifest": null,
                messages: [firstObject.hash],
              })
            );
            await tx.turnNodes.put(pausedTurnNode);
            await tx.turns.set({
              ...turn,
              headTurnNodeHash: pausedTurnNode.hash,
              updatedAtMs: 11,
            });
            throw new Error("checkpoint failed");
          }),
          CHECKPOINT_FAILURE_PATTERN
        );

        await backend.transact(async (tx) => {
          deepStrictEqual(await tx.turnTrees.get(pausedTurnTree.hash), null);
          deepStrictEqual(await tx.turnNodes.get(pausedTurnNode.hash), null);
          deepStrictEqual(await tx.branches.get(branch.branchId), branch);
          deepStrictEqual(await tx.turns.get(turn.turnId), turn);
          deepStrictEqual(await tx.runs.get(initialRun.runId), initialRun);
          deepStrictEqual(await tx.stagedResults.listByRun(initialRun.runId), [
            firstStagedResult,
          ]);
        });

        await backend.transact(async (tx) => {
          await tx.turnTrees.put(pausedTurnTree);
          await tx.turnTreePaths.putMany(
            createCanonicalTurnTreePaths(pausedTurnTree, {
              "context.manifest": null,
              messages: [firstObject.hash],
            })
          );
          await tx.turnNodes.put(pausedTurnNode);
          await tx.turns.set({
            ...turn,
            headTurnNodeHash: pausedTurnNode.hash,
            updatedAtMs: 11,
          });
          await tx.branches.set({
            ...branch,
            headTurnNodeHash: pausedTurnNode.hash,
            updatedAtMs: 11,
          });
          await tx.runs.set(pausedRun);
          await tx.stagedResults.clearRun(initialRun.runId);
        });

        await backend.transact(async (tx) => {
          await tx.runs.set({
            ...pausedRun,
            status: "failed",
            updatedAtMs: 13,
          });
          await tx.runs.set(resumedRun);
          await tx.objects.put(secondObject);
          await tx.stagedResults.set(secondStagedResult);
        });

        await backend.transact(async (tx) => {
          await tx.turnTrees.put(completedTurnTree);
          await tx.turnTreePaths.putMany(
            createCanonicalTurnTreePaths(completedTurnTree, {
              "context.manifest": null,
              messages: [firstObject.hash, secondObject.hash],
            })
          );
          await tx.turnNodes.put(completedTurnNode);
          await tx.turns.set({
            ...turn,
            headTurnNodeHash: completedTurnNode.hash,
            updatedAtMs: 17,
          });
          await tx.branches.set({
            ...branch,
            headTurnNodeHash: completedTurnNode.hash,
            updatedAtMs: 17,
          });
          await tx.runs.set(completedResumedRun);
          await tx.stagedResults.clearRun(resumedRun.runId);
        });

        await backend.transact(async (tx) => {
          deepStrictEqual(
            await tx.runs.get(resumedRun.runId),
            completedResumedRun
          );
          deepStrictEqual(
            await tx.turnNodes.get(completedTurnNode.hash),
            completedTurnNode
          );
          deepStrictEqual(
            await tx.stagedResults.listByRun(resumedRun.runId),
            []
          );
        });
      }
    );

    options.testApi.test(
      "rejects lateral branch moves and backward moves without archival rollback",
      async () => {
        const backend = options.createBackend();
        const schema = createCanonicalKernelTestSchema();
        const schemaRecord = createStoredSchemaRecord(schema, 1);
        const baseTree = await createStoredTurnTreeRecord(
          schema,
          { "context.manifest": null, messages: [] },
          2
        );
        const siblingEventObject = await createStoredObjectRecord(
          new Uint8Array([9]),
          3
        );
        const rootNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 4,
          eventHash: null,
          previousTurnNodeHash: null,
          schemaId: schema.schemaId,
          turnTreeHash: baseTree.hash,
        });
        const childNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 5,
          eventHash: null,
          previousTurnNodeHash: rootNode.hash,
          schemaId: schema.schemaId,
          turnTreeHash: baseTree.hash,
        });
        const siblingNode = await createStoredTurnNodeRecord({
          consumedStagedResults: [],
          createdAtMs: 6,
          eventHash: siblingEventObject.hash,
          previousTurnNodeHash: rootNode.hash,
          schemaId: schema.schemaId,
          turnTreeHash: baseTree.hash,
        });
        const thread: StoredThread = {
          createdAtMs: 7,
          rootTurnNodeHash: rootNode.hash,
          schemaId: schema.schemaId,
          threadId: "thread_branch_direction",
        };
        const branch: StoredBranch = {
          branchId: "branch_branch_direction",
          createdAtMs: 8,
          headTurnNodeHash: childNode.hash,
          threadId: thread.threadId,
          updatedAtMs: 8,
        };

        await backend.transact(async (tx) => {
          await tx.objects.put(siblingEventObject);
          await tx.schemas.put(schemaRecord);
          await tx.turnTrees.put(baseTree);
          await tx.turnTreePaths.putMany(
            createCanonicalTurnTreePaths(baseTree, {
              "context.manifest": null,
              messages: [],
            })
          );
          await tx.turnNodes.put(rootNode);
          await tx.turnNodes.put(childNode);
          await tx.turnNodes.put(siblingNode);
          await tx.threads.put(thread);
          await tx.branches.set(branch);
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

        await rejects(
          backend.transact(async (tx) => {
            await tx.branches.set({
              ...branch,
              headTurnNodeHash: siblingNode.hash,
              updatedAtMs: 10,
            });
          }),
          TuvrenPersistenceError
        );
      }
    );

    options.testApi.test(
      "allows backward branch moves when archival rollback semantics are preserved",
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
          threadId: "thread_backward_branch",
        };
        const branch: StoredBranch = {
          branchId: "branch_backward_branch",
          createdAtMs: 7,
          headTurnNodeHash: headNode.hash,
          threadId: thread.threadId,
          updatedAtMs: 7,
        };
        const archiveBranch: StoredBranch = {
          archivedFromBranchId: branch.branchId,
          branchId: "branch_backward_archive",
          createdAtMs: 10,
          headTurnNodeHash: headNode.hash,
          threadId: thread.threadId,
          updatedAtMs: 10,
        };
        const turn: StoredTurn = {
          branchId: branch.branchId,
          createdAtMs: 8,
          headTurnNodeHash: headNode.hash,
          parentTurnId: null,
          startTurnNodeHash: rootNode.hash,
          threadId: thread.threadId,
          turnId: "turn_backward_branch",
          updatedAtMs: 8,
        };
        const activeRun: StoredRun = {
          branchId: branch.branchId,
          createdAtMs: 9,
          createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
          currentStepIndex: 0,
          runId: "run_backward_branch",
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
          await tx.turnNodes.put(middleNode);
          await tx.turnNodes.put(headNode);
          await tx.threads.put(thread);
          await tx.branches.set(branch);
          await tx.turns.set(turn);
          await tx.runs.set(activeRun);
        });

        await backend.transact(async (tx) => {
          await tx.runs.set({
            ...activeRun,
            status: "failed",
            updatedAtMs: 10,
          });
          await tx.branches.set(archiveBranch);
          await tx.branches.set({
            ...branch,
            headTurnNodeHash: middleNode.hash,
            updatedAtMs: 10,
          });
        });

        await backend.transact(async (tx) => {
          deepStrictEqual(await tx.branches.get(branch.branchId), {
            ...branch,
            headTurnNodeHash: middleNode.hash,
            updatedAtMs: 10,
          });
          deepStrictEqual(
            await tx.branches.get(archiveBranch.branchId),
            archiveBranch
          );
          deepStrictEqual(await tx.runs.get(activeRun.runId), {
            ...activeRun,
            status: "failed",
            updatedAtMs: 10,
          });
        });
      }
    );
  });
}
