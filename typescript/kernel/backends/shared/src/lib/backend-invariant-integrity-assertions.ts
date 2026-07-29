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
  StoredRun,
  StoredTurn,
} from "@tuvren/kernel-protocol";
import {
  type BackendInvariantRecordUtils,
  type BackendInvariantRecordUtilsConfig,
  compareStoredTurn,
  createBackendInvariantRecordUtils,
} from "./backend-invariant-record-utils.js";
import type { BackendState } from "./backend-invariant-state.js";

/** Builds a fully-formed `<prefix>_backend_<reason>` error code. */
function errorCode(errorPrefix: string, suffix: string): string {
  return `${errorPrefix}_backend_${suffix}`;
}

/**
 * Asserts a backward branch-head move (rewind) preserved history: the same
 * transaction must have created an archive branch pointing at the abandoned
 * head (`archivedFromBranchId` = the moved branch, head = the old head), and
 * every still-active run on the branch must sit at the new head — active
 * runs stranded on the abandoned segment must have been failed.
 *
 * Defined at module scope (rather than nested inside
 * {@link createBackendInvariantIntegrityAssertions}) so its independent
 * validation loops do not accrue an extra nesting-depth penalty toward
 * cognitive-complexity limits; its dependencies are passed explicitly
 * instead of closed over.
 *
 * @param state - The loaded (post-transaction) state projection to
 *   validate.
 * @param baseState - The state projection loaded before the transaction,
 *   used to recognize which archive branches this transaction created.
 * @throws The injected persistence error with code
 *   `<prefix>_backend_backward_branch_move_missing_archive` or
 *   `<prefix>_backend_backward_branch_move_active_run_not_failed`.
 */
function assertBackwardBranchMoveIsArchivedCore(
  state: BackendState,
  baseState: BackendState,
  previousBranch: StoredBranch,
  nextBranch: StoredBranch,
  errorPrefix: string,
  getRunActiveTurnNodeHash: (run: StoredRun) => string,
  persistenceError: BackendInvariantRecordUtils["persistenceError"]
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
      errorCode(errorPrefix, "backward_branch_move_missing_archive"),
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
      errorCode(errorPrefix, "backward_branch_move_active_run_not_failed"),
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

/**
 * Configuration for {@link createBackendInvariantIntegrityAssertions}: the
 * record-utils error-prefix config plus the one backend-owned dependency this
 * surface needs.
 */
export interface BackendInvariantIntegrityAssertionsConfig
  extends BackendInvariantRecordUtilsConfig {
  /**
   * Resolves a run's active turn node: its most recently created node, or its
   * start turn node when it has created none. This stays backend-owned (each
   * backend derives it from its own `createdTurnNodesCbor` lineage decoder)
   * and is injected here rather than imported, mirroring the
   * `decodeRunCreatedTurnNodeHashes` injection precedent in
   * `backend-invariant-run-logic.ts`.
   */
  getRunActiveTurnNodeHash(run: StoredRun): string;
}

/**
 * The integrity-assertion invariant surface
 * `createBackendInvariantIntegrityAssertions` builds. Declared explicitly
 * (rather than inferred) for the same declaration-emit portability reason as
 * `BackendInvariantRecordUtils`.
 */
export interface BackendInvariantIntegrityAssertions {
  assertBackwardBranchMoveIsArchived(
    state: BackendState,
    baseState: BackendState,
    previousBranch: StoredBranch,
    nextBranch: StoredBranch
  ): void;
  assertChunkedTurnTreePathChunkLayout(
    chunk: StoredOrderedPathChunk,
    index: number,
    totalChunks: number
  ): void;
  assertTurnParentLink(
    state: BackendState,
    turn: StoredTurn,
    label: string
  ): void;
  ensureImmutableRecordMatch<T>(
    existing: T,
    incoming: T,
    areEqual: (left: T, right: T) => boolean,
    label: string
  ): void;
  listTurnsByThread(
    state: BackendState,
    threadId: string,
    excludedTurnId?: string
  ): StoredTurn[];
  /** Fixed item capacity of every non-final ordered path chunk. */
  readonly ORDERED_PATH_CHUNK_SIZE: number;
}

/**
 * Builds the integrity-assertion invariant surface shared by the SQLite and
 * PostgreSQL backends: turn-parent-link legality, backward-branch-move
 * archival, chunked ordered-path-chunk layout, and the generic
 * idempotent-rewrite guard for immutable content-addressed records. The only
 * backend-specific behavior is the error-code prefix (delegated to the
 * record-utils factory built from the same config) and the injected
 * `getRunActiveTurnNodeHash` dependency.
 */
export function createBackendInvariantIntegrityAssertions(
  config: BackendInvariantIntegrityAssertionsConfig
): BackendInvariantIntegrityAssertions {
  const { ensureImmutableRecordMatch, ensureTurnExists, persistenceError } =
    createBackendInvariantRecordUtils(config);

  function code(suffix: string): string {
    return `${config.errorPrefix}_backend_${suffix}`;
  }

  /**
   * Asserts a turn's semantic-parent link is canonical: a turn whose start
   * node is another turn's head must name a parent (`null` is only legal for
   * a turn with no predecessor at its start node); the parent must live on
   * the same thread and chain contiguously (parent head === child start);
   * and when the parent shares the branch it must be the immediately
   * previous semantic turn, not an earlier one.
   *
   * @throws The injected persistence error with code
   *   `<prefix>_backend_turn_parent_required`,
   *   `<prefix>_backend_turn_parent_thread_mismatch`,
   *   `<prefix>_backend_turn_parent_start_turn_node_mismatch`, or
   *   `<prefix>_backend_turn_parent_not_immediate_predecessor`.
   */
  function assertTurnParentLink(
    state: BackendState,
    turn: StoredTurn,
    label: string
  ): void {
    const candidateTurnsAtStart = listTurnsByThread(
      state,
      turn.threadId,
      turn.turnId
    ).filter(
      (candidateTurn) =>
        candidateTurn.headTurnNodeHash === turn.startTurnNodeHash
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
        code("turn_parent_required"),
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
        code("turn_parent_thread_mismatch"),
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
        code("turn_parent_start_turn_node_mismatch"),
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
        code("turn_parent_not_immediate_predecessor"),
        {
          candidateParentTurnIds: sameBranchCandidateTurns.map(
            (candidateTurn) => candidateTurn.turnId
          ),
          expectedParentTurnId:
            immediatelyPreviousSameBranchTurn?.turnId ?? null,
          parentTurnId: parentTurn.turnId,
          turnId: turn.turnId,
        }
      );
    }
  }

  function assertBackwardBranchMoveIsArchived(
    state: BackendState,
    baseState: BackendState,
    previousBranch: StoredBranch,
    nextBranch: StoredBranch
  ): void {
    assertBackwardBranchMoveIsArchivedCore(
      state,
      baseState,
      previousBranch,
      nextBranch,
      config.errorPrefix,
      config.getRunActiveTurnNodeHash,
      persistenceError
    );
  }

  /**
   * Asserts the canonical chunk layout of a chunked ordered path: every
   * chunk holds 1..{@link ORDERED_PATH_CHUNK_SIZE} items, and every chunk
   * except the final one is exactly full.
   *
   * @throws The injected persistence error with code
   *   `<prefix>_backend_ordered_path_chunk_size_invalid` or
   *   `<prefix>_backend_ordered_path_chunk_not_fixed_size`.
   */
  function assertChunkedTurnTreePathChunkLayout(
    chunk: StoredOrderedPathChunk,
    index: number,
    totalChunks: number
  ): void {
    if (chunk.itemCount < 1 || chunk.itemCount > ORDERED_PATH_CHUNK_SIZE) {
      throw persistenceError(
        "ordered path chunks must contain between one and the fixed chunk size number of items",
        code("ordered_path_chunk_size_invalid"),
        {
          chunkHash: chunk.chunkHash,
          chunkItemCount: chunk.itemCount,
          chunkSize: ORDERED_PATH_CHUNK_SIZE,
        }
      );
    }

    if (
      index < totalChunks - 1 &&
      chunk.itemCount !== ORDERED_PATH_CHUNK_SIZE
    ) {
      throw persistenceError(
        "non-final ordered path chunks must use the fixed chunk size",
        code("ordered_path_chunk_not_fixed_size"),
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

  return {
    assertBackwardBranchMoveIsArchived,
    assertChunkedTurnTreePathChunkLayout,
    assertTurnParentLink,
    ensureImmutableRecordMatch,
    listTurnsByThread,
    ORDERED_PATH_CHUNK_SIZE,
  };
}

/** Fixed item capacity of every non-final ordered path chunk. */
export const ORDERED_PATH_CHUNK_SIZE = 32;

/**
 * Lists a thread's turns in deterministic order (`createdAtMs`, then
 * `turnId`), optionally excluding one turn — used when validating a turn's
 * parent link against its predecessors. Pure and backend-independent (no
 * error codes to raise), so it is exported directly rather than only through
 * {@link createBackendInvariantIntegrityAssertions}.
 */
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
