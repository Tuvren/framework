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

import {
  assertActiveRunHeadAlignment,
  assertBackwardBranchMoveIsArchived,
  assertRunCreatedTurnNodesAreCanonical,
  assertRunCreatedTurnNodeWithinTurnSpan,
  assertRunStartTurnNodeWithinTurnSpan,
  assertTurnNodeBelongsToThread,
  assertTurnNodeDescendsFrom,
  assertTurnParentLink,
  classifyTurnNodeRelationship,
  decodeRunCreatedTurnNodeHashes,
  decodeTurnNodeConsumedStagedResultObjectHashes,
} from "./memory-backend-lineage.js";
import {
  ensureBranchExists,
  ensureObjectExists,
  ensureRunExists,
  ensureThreadExists,
  ensureTurnExists,
  ensureTurnNodeExists,
  ensureTurnTreeExists,
  persistenceError,
} from "./memory-backend-record-utils.js";
import { assertTurnTreeManifestMatchesStoredPaths } from "./memory-backend-turn-tree.js";
import type { BackendState } from "./memory-backend-types.js";

export function createEmptyState(): BackendState {
  return {
    branches: new Map(),
    observeAnnotations: new Map(),
    objects: new Map(),
    orderedPathChunks: new Map(),
    runs: new Map(),
    schemas: new Map(),
    stagedResults: new Map(),
    threads: new Map(),
    turnNodes: new Map(),
    turnTreePaths: new Map(),
    turnTrees: new Map(),
    turns: new Map(),
  };
}

export function validateCommittedState(
  state: BackendState,
  baseState: BackendState
): void {
  validateThreadInvariants(state);
  validateBranchInvariants(state, baseState);
  validateTurnNodeInvariants(state);
  validateTurnInvariants(state);
  validateRunInvariants(state);
  validateTurnTreePathInvariants(state);
}

function validateThreadInvariants(state: BackendState): void {
  const rootTurnNodeOwners = new Map<string, string>();

  for (const thread of state.threads.values()) {
    const rootTurnNode = ensureTurnNodeExists(
      state,
      thread.rootTurnNodeHash,
      "thread.rootTurnNodeHash"
    );

    if (rootTurnNode.schemaId !== thread.schemaId) {
      throw persistenceError(
        "stored threads must use the schema of their root turn node",
        "memory_backend_thread_schema_mismatch",
        {
          rootTurnNodeHash: thread.rootTurnNodeHash,
          threadId: thread.threadId,
          threadSchemaId: thread.schemaId,
          turnNodeSchemaId: rootTurnNode.schemaId,
        }
      );
    }

    if (rootTurnNode.previousTurnNodeHash !== null) {
      throw persistenceError(
        "stored thread roots must be genesis turn nodes",
        "memory_backend_thread_root_not_genesis",
        {
          previousTurnNodeHash: rootTurnNode.previousTurnNodeHash,
          rootTurnNodeHash: rootTurnNode.hash,
          threadId: thread.threadId,
        }
      );
    }

    const existingOwnerThreadId = rootTurnNodeOwners.get(
      thread.rootTurnNodeHash
    );
    if (
      existingOwnerThreadId !== undefined &&
      existingOwnerThreadId !== thread.threadId
    ) {
      throw persistenceError(
        "stored thread roots must be unique across threads",
        "memory_backend_thread_root_not_unique",
        {
          existingOwnerThreadId,
          rootTurnNodeHash: thread.rootTurnNodeHash,
          threadId: thread.threadId,
        }
      );
    }

    rootTurnNodeOwners.set(thread.rootTurnNodeHash, thread.threadId);
  }
}

function validateBranchInvariants(
  state: BackendState,
  baseState: BackendState
): void {
  for (const branch of state.branches.values()) {
    const thread = ensureThreadExists(
      state,
      branch.threadId,
      "branch.threadId"
    );

    assertTurnNodeBelongsToThread(
      state,
      branch.headTurnNodeHash,
      thread,
      "branch.headTurnNodeHash"
    );

    if (branch.archivedFromBranchId === undefined) {
      continue;
    }

    const sourceBranch = ensureBranchExists(
      state,
      branch.archivedFromBranchId,
      "branch.archivedFromBranchId"
    );

    if (sourceBranch.threadId !== branch.threadId) {
      throw persistenceError(
        "stored branches must archive only from branches in the same thread",
        "memory_backend_branch_archive_thread_mismatch",
        {
          archivedFromBranchId: sourceBranch.branchId,
          branchId: branch.branchId,
          branchThreadId: branch.threadId,
          sourceThreadId: sourceBranch.threadId,
        }
      );
    }

    const existingBranch = baseState.branches.get(branch.branchId);
    const sourceBranchBeforeTransaction = baseState.branches.get(
      branch.archivedFromBranchId
    );

    if (
      existingBranch === undefined &&
      sourceBranchBeforeTransaction === undefined
    ) {
      throw persistenceError(
        "new archive branches must reference a source branch that existed before the transaction",
        "memory_backend_branch_archive_source_missing_before_transaction",
        {
          archivedFromBranchId: branch.archivedFromBranchId,
          branchId: branch.branchId,
        }
      );
    }

    if (
      existingBranch === undefined &&
      sourceBranchBeforeTransaction !== undefined &&
      branch.headTurnNodeHash !== sourceBranchBeforeTransaction.headTurnNodeHash
    ) {
      throw persistenceError(
        "new archive branches must preserve the pre-rollback source branch head",
        "memory_backend_branch_archive_head_mismatch",
        {
          archivedFromBranchId: branch.archivedFromBranchId,
          archiveHeadTurnNodeHash: branch.headTurnNodeHash,
          sourceHeadTurnNodeHash:
            sourceBranchBeforeTransaction.headTurnNodeHash,
        }
      );
    }

    if (
      existingBranch === undefined &&
      sourceBranchBeforeTransaction !== undefined &&
      classifyTurnNodeRelationship(
        state,
        sourceBranchBeforeTransaction.headTurnNodeHash,
        sourceBranch.headTurnNodeHash
      ) !== "backward"
    ) {
      throw persistenceError(
        "new archive branches must be paired with a backward move on their source branch",
        "memory_backend_branch_archive_without_backward_move",
        {
          archivedFromBranchId: branch.archivedFromBranchId,
          branchId: branch.branchId,
          sourceBranchHeadTurnNodeHash: sourceBranch.headTurnNodeHash,
          sourceBranchPreviousHeadTurnNodeHash:
            sourceBranchBeforeTransaction.headTurnNodeHash,
        }
      );
    }
  }

  for (const branch of state.branches.values()) {
    const previousBranch = baseState.branches.get(branch.branchId);

    if (previousBranch === undefined) {
      continue;
    }

    const headMoveDirection = classifyTurnNodeRelationship(
      state,
      previousBranch.headTurnNodeHash,
      branch.headTurnNodeHash
    );

    if (headMoveDirection !== "backward") {
      continue;
    }

    assertBackwardBranchMoveIsArchived(
      state,
      baseState,
      previousBranch,
      branch
    );
  }
}

function validateTurnNodeInvariants(state: BackendState): void {
  for (const turnNode of state.turnNodes.values()) {
    const turnTree = ensureTurnTreeExists(
      state,
      turnNode.turnTreeHash,
      "turnNode.turnTreeHash"
    );

    if (turnTree.schemaId !== turnNode.schemaId) {
      throw persistenceError(
        "stored turn nodes must use the schema of their referenced turn tree",
        "memory_backend_turn_node_schema_mismatch",
        {
          turnNodeHash: turnNode.hash,
          turnNodeSchemaId: turnNode.schemaId,
          turnTreeHash: turnTree.hash,
          turnTreeSchemaId: turnTree.schemaId,
        }
      );
    }

    for (const objectHash of decodeTurnNodeConsumedStagedResultObjectHashes(
      turnNode
    )) {
      ensureObjectExists(
        state,
        objectHash,
        "turnNode.consumedStagedResultsCbor"
      );
    }
  }
}

function validateTurnInvariants(state: BackendState): void {
  for (const turn of state.turns.values()) {
    const thread = ensureThreadExists(state, turn.threadId, "turn.threadId");
    const branch = ensureBranchExists(state, turn.branchId, "turn.branchId");

    if (branch.threadId !== thread.threadId) {
      throw persistenceError(
        "stored turns must reference a branch on the same thread",
        "memory_backend_turn_branch_thread_mismatch",
        {
          branchId: branch.branchId,
          branchThreadId: branch.threadId,
          threadId: thread.threadId,
          turnId: turn.turnId,
        }
      );
    }

    assertTurnNodeBelongsToThread(
      state,
      turn.startTurnNodeHash,
      thread,
      "turn.startTurnNodeHash"
    );
    assertTurnNodeBelongsToThread(
      state,
      turn.headTurnNodeHash,
      thread,
      "turn.headTurnNodeHash"
    );
    assertTurnNodeDescendsFrom(
      state,
      turn.headTurnNodeHash,
      turn.startTurnNodeHash,
      "turn.headTurnNodeHash"
    );

    assertTurnParentLink(state, turn, "turn.parentTurnId");
  }
}

function validateRunInvariants(state: BackendState): void {
  const activeRunCounts = new Map<string, number>();

  for (const run of state.runs.values()) {
    const branch = ensureBranchExists(state, run.branchId, "run.branchId");
    const turn = ensureTurnExists(state, run.turnId, "run.turnId");
    const startTurnNode = ensureTurnNodeExists(
      state,
      run.startTurnNodeHash,
      "run.startTurnNodeHash"
    );
    const thread = ensureThreadExists(state, turn.threadId, "turn.threadId");

    if (turn.branchId !== branch.branchId) {
      throw persistenceError(
        "stored runs must reference a turn on the same branch",
        "memory_backend_run_branch_mismatch",
        {
          branchId: branch.branchId,
          runId: run.runId,
          turnBranchId: turn.branchId,
          turnId: turn.turnId,
        }
      );
    }

    assertTurnNodeBelongsToThread(
      state,
      run.startTurnNodeHash,
      thread,
      "run.startTurnNodeHash"
    );

    if (startTurnNode.schemaId !== run.schemaId) {
      throw persistenceError(
        "stored runs must use the schema of their start turn node",
        "memory_backend_run_schema_mismatch",
        {
          runId: run.runId,
          runSchemaId: run.schemaId,
          startTurnNodeHash: startTurnNode.hash,
          turnNodeSchemaId: startTurnNode.schemaId,
        }
      );
    }

    assertRunStartTurnNodeWithinTurnSpan(
      state,
      turn,
      run.startTurnNodeHash,
      "run.startTurnNodeHash"
    );

    for (const turnNodeHash of decodeRunCreatedTurnNodeHashes(run)) {
      const createdTurnNode = ensureTurnNodeExists(
        state,
        turnNodeHash,
        "run.createdTurnNodesCbor"
      );
      assertTurnNodeBelongsToThread(
        state,
        turnNodeHash,
        thread,
        "run.createdTurnNodesCbor"
      );
      assertRunCreatedTurnNodeWithinTurnSpan(
        state,
        turn,
        createdTurnNode,
        "run.createdTurnNodesCbor"
      );
    }

    assertRunCreatedTurnNodesAreCanonical(state, run);

    if (run.status === "running" || run.status === "paused") {
      assertActiveRunHeadAlignment(run, branch, turn);
      const currentActiveCount = activeRunCounts.get(run.branchId) ?? 0;
      activeRunCounts.set(run.branchId, currentActiveCount + 1);
    }

    const stagedResultsForRun = state.stagedResults.get(run.runId);

    if (run.status !== "running" && stagedResultsForRun !== undefined) {
      throw persistenceError(
        "stored terminal or paused runs must not retain staged results",
        "memory_backend_run_has_terminal_staged_results",
        {
          runId: run.runId,
          stagedResultCount: stagedResultsForRun.size,
          status: run.status,
        }
      );
    }
  }

  for (const [branchId, activeRunCount] of activeRunCounts.entries()) {
    if (activeRunCount > 1) {
      throw persistenceError(
        "stored branches must not have more than one active run",
        "memory_backend_multiple_active_runs",
        {
          activeRunCount,
          branchId,
        }
      );
    }
  }

  for (const [runId, stagedResults] of state.stagedResults.entries()) {
    const run = ensureRunExists(state, runId, "stagedResults.runId");

    if (run.status !== "running") {
      throw persistenceError(
        "stored staged results may only exist for running runs",
        "memory_backend_staged_result_run_not_running",
        {
          runId,
          stagedResultCount: stagedResults.size,
          status: run.status,
        }
      );
    }
  }
}

function validateTurnTreePathInvariants(state: BackendState): void {
  for (const [turnTreeHash, storedPaths] of state.turnTreePaths.entries()) {
    ensureTurnTreeExists(state, turnTreeHash, "turnTreePath.turnTreeHash");

    if (storedPaths.size === 0) {
      throw persistenceError(
        "stored turn tree path collections must not be empty",
        "memory_backend_empty_turn_tree_path_collection",
        { turnTreeHash }
      );
    }
  }

  for (const turnTree of state.turnTrees.values()) {
    assertTurnTreeManifestMatchesStoredPaths(state, turnTree);
  }
}
