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

import type {
  StoredBranch,
  StoredOrderedPathChunk,
  StoredTurn,
} from "@tuvren/kernel-protocol";
import { persistenceError } from "./sqlite-errors.js";
import type { BackendState } from "./sqlite-records.js";
import { getRunActiveTurnNodeHash } from "./sqlite-run-invariants.js";
import { compareStoredTurn, ensureTurnExists } from "./sqlite-state-utils.js";

export const ORDERED_PATH_CHUNK_SIZE = 32;

export function assertTurnParentLink(
  state: BackendState,
  turn: StoredTurn,
  label: string
): void {
  const candidateTurnsAtStart = listTurnsByThread(
    state,
    turn.threadId,
    turn.turnId
  ).filter(
    (candidateTurn) => candidateTurn.headTurnNodeHash === turn.startTurnNodeHash
  );
  const sameBranchCandidateTurns = candidateTurnsAtStart.filter(
    (candidateTurn) => candidateTurn.branchId === turn.branchId
  );
  const immediatelyPreviousSameBranchTurn = sameBranchCandidateTurns.at(-1);

  if (turn.parentTurnId === null) {
    if (candidateTurnsAtStart.length === 0) {
      return;
    }

    throw persistenceError(
      `${label} must reference the previous semantic turn when one exists`,
      "sqlite_backend_turn_parent_required",
      {
        candidateParentTurnIds: candidateTurnsAtStart.map(
          (candidateTurn) => candidateTurn.turnId
        ),
        startTurnNodeHash: turn.startTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }

  const parentTurn = ensureTurnExists(state, turn.parentTurnId, label);

  if (parentTurn.threadId !== turn.threadId) {
    throw persistenceError(
      "stored turns must reference a parent turn on the same thread",
      "sqlite_backend_turn_parent_thread_mismatch",
      {
        parentThreadId: parentTurn.threadId,
        threadId: turn.threadId,
        turnId: turn.turnId,
      }
    );
  }

  if (parentTurn.headTurnNodeHash !== turn.startTurnNodeHash) {
    throw persistenceError(
      `${label} must chain contiguously into record.startTurnNodeHash`,
      "sqlite_backend_turn_parent_start_turn_node_mismatch",
      {
        parentTurnHeadTurnNodeHash: parentTurn.headTurnNodeHash,
        parentTurnId: parentTurn.turnId,
        startTurnNodeHash: turn.startTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }

  if (parentTurn.branchId !== turn.branchId) {
    return;
  }

  if (
    immediatelyPreviousSameBranchTurn === undefined ||
    immediatelyPreviousSameBranchTurn.turnId !== parentTurn.turnId
  ) {
    throw persistenceError(
      `${label} must reference the immediately previous semantic turn at record.startTurnNodeHash`,
      "sqlite_backend_turn_parent_not_immediate_predecessor",
      {
        candidateParentTurnIds: sameBranchCandidateTurns.map(
          (candidateTurn) => candidateTurn.turnId
        ),
        expectedParentTurnId: immediatelyPreviousSameBranchTurn?.turnId ?? null,
        parentTurnId: parentTurn.turnId,
        turnId: turn.turnId,
      }
    );
  }
}

export function listTurnsByThread(
  state: BackendState,
  threadId: string,
  excludedTurnId?: string
): StoredTurn[] {
  const turns: StoredTurn[] = [];

  for (const turn of state.turns.values()) {
    if (turn.threadId !== threadId || turn.turnId === excludedTurnId) {
      continue;
    }

    turns.push(turn);
  }

  turns.sort(compareStoredTurn);
  return turns;
}

export function assertBackwardBranchMoveIsArchived(
  state: BackendState,
  baseState: BackendState,
  previousBranch: StoredBranch,
  nextBranch: StoredBranch
): void {
  let archiveBranchFound = false;

  for (const branch of state.branches.values()) {
    if (branch.branchId === nextBranch.branchId) {
      continue;
    }

    const branchBeforeTransaction = baseState.branches.get(branch.branchId);

    if (
      branchBeforeTransaction === undefined &&
      branch.archivedFromBranchId === nextBranch.branchId &&
      branch.headTurnNodeHash === previousBranch.headTurnNodeHash
    ) {
      archiveBranchFound = true;
      break;
    }
  }

  if (!archiveBranchFound) {
    throw persistenceError(
      "stored backward branch moves must preserve the abandoned head as an archive branch",
      "sqlite_backend_backward_branch_move_missing_archive",
      {
        branchId: nextBranch.branchId,
        nextHeadTurnNodeHash: nextBranch.headTurnNodeHash,
        previousHeadTurnNodeHash: previousBranch.headTurnNodeHash,
      }
    );
  }

  for (const run of state.runs.values()) {
    if (
      run.branchId !== nextBranch.branchId ||
      (run.status !== "running" && run.status !== "paused")
    ) {
      continue;
    }

    const activeTurnNodeHash = getRunActiveTurnNodeHash(run);

    if (activeTurnNodeHash === nextBranch.headTurnNodeHash) {
      continue;
    }

    throw persistenceError(
      "stored backward branch moves must fail active runs from the abandoned segment",
      "sqlite_backend_backward_branch_move_active_run_not_failed",
      {
        activeTurnNodeHash,
        branchHeadTurnNodeHash: nextBranch.headTurnNodeHash,
        branchId: nextBranch.branchId,
        runId: run.runId,
        startTurnNodeHash: run.startTurnNodeHash,
        status: run.status,
      }
    );
  }
}

export function assertChunkedTurnTreePathChunkLayout(
  chunk: StoredOrderedPathChunk,
  index: number,
  totalChunks: number
): void {
  if (chunk.itemCount < 1 || chunk.itemCount > ORDERED_PATH_CHUNK_SIZE) {
    throw persistenceError(
      "ordered path chunks must contain between one and the fixed chunk size number of items",
      "sqlite_backend_ordered_path_chunk_size_invalid",
      {
        chunkHash: chunk.chunkHash,
        chunkItemCount: chunk.itemCount,
        chunkSize: ORDERED_PATH_CHUNK_SIZE,
      }
    );
  }

  if (index < totalChunks - 1 && chunk.itemCount !== ORDERED_PATH_CHUNK_SIZE) {
    throw persistenceError(
      "non-final ordered path chunks must use the fixed chunk size",
      "sqlite_backend_ordered_path_chunk_not_fixed_size",
      {
        chunkHash: chunk.chunkHash,
        chunkIndex: index,
        chunkItemCount: chunk.itemCount,
        chunkSize: ORDERED_PATH_CHUNK_SIZE,
        totalChunks,
      }
    );
  }
}

export function ensureImmutableRecordMatch<T>(
  existing: T,
  incoming: T,
  areEqual: (left: T, right: T) => boolean,
  label: string
): void {
  if (!areEqual(existing, incoming)) {
    throw persistenceError(
      `${label} writes must be idempotent for the same identity key`,
      "sqlite_backend_immutable_record_conflict",
      { label }
    );
  }
}
