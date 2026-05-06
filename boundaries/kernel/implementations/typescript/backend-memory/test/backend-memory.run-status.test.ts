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
  encodeDeterministicKernelRecord,
  type StoredBranch,
  type StoredRun,
  type StoredThread,
  type StoredTurn,
} from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema as createSchema,
  createStoredObjectRecord as createStoredObject,
  createStoredSchemaRecord as createStoredSchema,
  createStoredTurnNodeRecord as createStoredTurnNode,
  createStoredTurnTreeRecord as createStoredTurnTree,
} from "@tuvren/kernel-testkit";
import { createCanonicalTurnTreePaths } from "./backend-memory-test-helpers.js";

describe("@tuvren/backend-memory run status", () => {
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
});
