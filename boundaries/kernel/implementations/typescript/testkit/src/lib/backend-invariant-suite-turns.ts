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
import { TuvrenPersistenceError } from "@tuvren/core-types";
import {
  encodeDeterministicKernelRecord,
  type StoredBranch,
  type StoredRun,
  type StoredThread,
  type StoredTurn,
} from "@tuvren/kernel-protocol";
import { createArchiveRollbackFixtures } from "./backend-invariant-suite-archive.js";
import type { BackendConformanceSuiteOptions } from "./backend-test-suite-types.js";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createHashFromIndex,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "./kernel-test-fixtures.js";

export function registerBackendInvariantTurnCases(
  options: BackendConformanceSuiteOptions
): void {
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
      const { schemaRecord, turnTree } = await createArchiveRollbackFixtures();

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
}
