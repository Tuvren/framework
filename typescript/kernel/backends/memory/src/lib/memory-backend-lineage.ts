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
  createBackendInvariantTurnNodeLineage,
  createTurnNodeLineageIndex,
  type TurnNodeLineageIndex,
} from "@tuvren/backend-shared";
import type {
  StoredBranch,
  StoredRun,
  StoredThread,
  StoredTurn,
  StoredTurnNode,
} from "@tuvren/kernel-protocol";
import { decodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import {
  ensureTurnExists,
  ensureTurnNodeExists,
  persistenceError,
  validateHashString,
} from "./memory-backend-record-utils.js";
import {
  decodeHashStringArray,
  listTurnsByThread,
} from "./memory-backend-turn-tree.js";
import type { BackendState } from "./memory-backend-types.js";

// Issue #108 M2: the ancestor walk `assertTurnNodeBelongsToThread` and
// `assertTurnNodeDescendsFrom` perform is shared, memoized algorithm now
// lives in `@tuvren/backend-shared` (`createBackendInvariantTurnNodeLineage`)
// so a validation pass touching many turn nodes (e.g.
// `validateCommittedState` re-checking every turn/run in a large committed
// state) amortizes to O(n) total instead of O(depth) per call. The
// `*Indexed` exports below take the shared per-pass `TurnNodeLineageIndex`
// explicitly; the plain exports are unchanged-signature wrappers for the
// single ad hoc call sites in memory-backend.ts that validate one write at a
// time and have no per-pass index to share.
const turnNodeLineage = createBackendInvariantTurnNodeLineage({
  errorPrefix: "memory",
});

/**
 * Asserts that a turn node reaches the thread's root turn node by lineage —
 * i.e. the node genuinely belongs to the thread rather than merely existing
 * in the store. Reuses `index`'s memoized positions across every call
 * sharing it in the same validation pass.
 *
 * @throws TuvrenPersistenceError `memory_backend_thread_lineage_mismatch`
 *   when the walk reaches a different root than `thread.rootTurnNodeHash`,
 *   or `memory_backend_cyclic_turn_node_lineage` on a lineage cycle.
 */
export function assertTurnNodeBelongsToThreadIndexed(
  state: BackendState,
  turnNodeHash: string,
  thread: StoredThread,
  label: string,
  index: TurnNodeLineageIndex
): void {
  turnNodeLineage.assertTurnNodeBelongsToThread(
    state,
    turnNodeHash,
    thread,
    label,
    index
  );
}

/** {@link assertTurnNodeBelongsToThreadIndexed} for a single ad hoc check with nothing to amortize across. */
export function assertTurnNodeBelongsToThread(
  state: BackendState,
  turnNodeHash: string,
  thread: StoredThread,
  label: string
): void {
  assertTurnNodeBelongsToThreadIndexed(
    state,
    turnNodeHash,
    thread,
    label,
    createTurnNodeLineageIndex()
  );
}

/**
 * Asserts that `descendantTurnNodeHash` is the ancestor itself or a
 * descendant of it along the `previousTurnNodeHash` chain. Used to keep turn
 * heads append-only: a turn's new head must extend its previous head.
 * Reuses `index`'s memoized positions across every call sharing it in the
 * same validation pass.
 *
 * @throws TuvrenPersistenceError `memory_backend_turn_node_not_descendant`
 *   when the ancestor is not on the descendant's lineage, or
 *   `memory_backend_cyclic_turn_node_lineage` on a lineage cycle.
 */
export function assertTurnNodeDescendsFromIndexed(
  state: BackendState,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string,
  label: string,
  index: TurnNodeLineageIndex
): void {
  turnNodeLineage.assertTurnNodeDescendsFrom(
    state,
    descendantTurnNodeHash,
    ancestorTurnNodeHash,
    label,
    index
  );
}

/** {@link assertTurnNodeDescendsFromIndexed} for a single ad hoc check with nothing to amortize across. */
export function assertTurnNodeDescendsFrom(
  state: BackendState,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string,
  label: string
): void {
  assertTurnNodeDescendsFromIndexed(
    state,
    descendantTurnNodeHash,
    ancestorTurnNodeHash,
    label,
    createTurnNodeLineageIndex()
  );
}

/**
 * Asserts that a branch head move stays on one lineage line: the new head
 * must be the same node, a descendant (forward move), or an ancestor
 * (backward move, e.g. a rewind) of the current head. Lateral jumps onto an
 * unrelated lineage are rejected.
 *
 * @throws TuvrenPersistenceError `memory_backend_branch_head_lateral_move`.
 */
export function assertBranchHeadMoveIsLinear(
  state: BackendState,
  previousHeadTurnNodeHash: string,
  nextHeadTurnNodeHash: string,
  label: string
): void {
  const relationship = classifyTurnNodeRelationship(
    state,
    previousHeadTurnNodeHash,
    nextHeadTurnNodeHash
  );

  if (relationship === "lateral") {
    throw persistenceError(
      `${label} must remain on the same thread lineage as the current branch head`,
      "memory_backend_branch_head_lateral_move",
      {
        nextHeadTurnNodeHash,
        previousHeadTurnNodeHash,
      }
    );
  }
}

/**
 * Asserts that a run's start turn node lies within its turn's span: at or
 * after the turn's start node and at or before the turn's head node on the
 * same lineage.
 *
 * @throws TuvrenPersistenceError `memory_backend_run_turn_span_mismatch`.
 */
export function assertRunStartTurnNodeWithinTurnSpan(
  state: BackendState,
  turn: StoredTurn,
  startTurnNodeHash: string,
  label: string
): void {
  const relationshipToTurnStart = classifyTurnNodeRelationship(
    state,
    turn.startTurnNodeHash,
    startTurnNodeHash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} must lie within the referenced turn span`,
      "memory_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = classifyTurnNodeRelationship(
    state,
    startTurnNodeHash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} must not move past the referenced turn head`,
      "memory_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

/**
 * Asserts that a turn node recorded in a run's `createdTurnNodesCbor` lineage
 * lies within the run's turn span (between the turn's start node and head
 * node, inclusive).
 *
 * @throws TuvrenPersistenceError
 *   `memory_backend_run_created_turn_node_outside_turn_span`.
 */
export function assertRunCreatedTurnNodeWithinTurnSpan(
  state: BackendState,
  turn: StoredTurn,
  createdTurnNode: StoredTurnNode,
  label: string
): void {
  const relationshipToTurnStart = classifyTurnNodeRelationship(
    state,
    turn.startTurnNodeHash,
    createdTurnNode.hash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must remain within the referenced turn span`,
      "memory_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = classifyTurnNodeRelationship(
    state,
    createdTurnNode.hash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must not move beyond the referenced turn head`,
      "memory_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

/**
 * Asserts that a run's `createdTurnNodesCbor` decodes to a canonical lineage:
 * unique hashes forming a contiguous `previousTurnNodeHash` chain that starts
 * immediately after the run's start turn node.
 *
 * @throws TuvrenPersistenceError
 *   `memory_backend_run_created_turn_nodes_duplicate` or
 *   `memory_backend_run_created_turn_nodes_not_contiguous`.
 */
export function assertRunCreatedTurnNodesAreCanonical(
  state: BackendState,
  run: StoredRun
): void {
  const createdTurnNodeHashes = decodeRunCreatedTurnNodeHashes(run);
  const seenTurnNodeHashes = new Set<string>();
  let previousTurnNodeHash = run.startTurnNodeHash;

  for (const [index, turnNodeHash] of createdTurnNodeHashes.entries()) {
    if (seenTurnNodeHashes.has(turnNodeHash)) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor unique",
        "memory_backend_run_created_turn_nodes_duplicate",
        {
          duplicateTurnNodeHash: turnNodeHash,
          index,
          runId: run.runId,
        }
      );
    }

    const createdTurnNode = ensureTurnNodeExists(
      state,
      turnNodeHash,
      "run.createdTurnNodesCbor"
    );
    const isImmediateNextTurnNode =
      createdTurnNode.previousTurnNodeHash === previousTurnNodeHash;

    if (!isImmediateNextTurnNode) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor as a canonical contiguous lineage",
        "memory_backend_run_created_turn_nodes_not_contiguous",
        {
          createdTurnNodePreviousTurnNodeHash:
            createdTurnNode.previousTurnNodeHash,
          index,
          previousTurnNodeHash,
          runId: run.runId,
          turnNodeHash,
        }
      );
    }

    seenTurnNodeHashes.add(turnNodeHash);
    previousTurnNodeHash = turnNodeHash;
  }
}

/**
 * Asserts that an active (running/paused) run's active turn node — the last
 * created node, or the start node when none exist — is simultaneously the
 * branch head and the turn head, so an in-flight run can never drift from
 * the lineage position the branch and turn claim.
 *
 * @throws TuvrenPersistenceError
 *   `memory_backend_active_run_branch_head_mismatch` or
 *   `memory_backend_active_run_turn_head_mismatch`.
 */
export function assertActiveRunHeadAlignment(
  run: StoredRun,
  branch: StoredBranch,
  turn: StoredTurn
): void {
  const activeTurnNodeHash = getRunActiveTurnNodeHash(run);

  if (activeTurnNodeHash !== branch.headTurnNodeHash) {
    throw persistenceError(
      "stored active runs must stay aligned with the current branch head",
      "memory_backend_active_run_branch_head_mismatch",
      {
        activeTurnNodeHash,
        branchHeadTurnNodeHash: branch.headTurnNodeHash,
        branchId: branch.branchId,
        runId: run.runId,
        status: run.status,
      }
    );
  }

  if (activeTurnNodeHash !== turn.headTurnNodeHash) {
    throw persistenceError(
      "stored active runs must stay aligned with the current turn head",
      "memory_backend_active_run_turn_head_mismatch",
      {
        activeTurnNodeHash,
        runId: run.runId,
        status: run.status,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

/**
 * Asserts a turn's semantic-parent link is canonical: a turn whose start node
 * is another turn's head must name a parent (`null` is only legal for a turn
 * with no predecessor at its start node); the parent must live on the same
 * thread and chain contiguously (parent head === child start); and when the
 * parent shares the branch it must be the immediately previous semantic turn,
 * not an earlier one.
 *
 * @throws TuvrenPersistenceError `memory_backend_turn_parent_required`,
 *   `memory_backend_turn_parent_thread_mismatch`,
 *   `memory_backend_turn_parent_start_turn_node_mismatch`, or
 *   `memory_backend_turn_parent_not_immediate_predecessor`.
 */
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
      "memory_backend_turn_parent_required",
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
      "memory_backend_turn_parent_thread_mismatch",
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
      "memory_backend_turn_parent_start_turn_node_mismatch",
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
      "memory_backend_turn_parent_not_immediate_predecessor",
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

/**
 * Asserts a backward branch-head move (rewind) preserved history: the same
 * transaction must have created an archive branch pointing at the abandoned
 * head (`archivedFromBranchId` = the moved branch, head = the old head), and
 * every still-active run on the branch must sit at the new head — active runs
 * stranded on the abandoned segment must have been failed.
 *
 * @param state - The draft (post-transaction) state being validated.
 * @param baseState - The committed state before the transaction, used to
 *   recognize which archive branches this transaction created.
 * @throws TuvrenPersistenceError
 *   `memory_backend_backward_branch_move_missing_archive` or
 *   `memory_backend_backward_branch_move_active_run_not_failed`.
 */
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
      "memory_backend_backward_branch_move_missing_archive",
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
      "memory_backend_backward_branch_move_active_run_not_failed",
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
 * How two turn nodes relate along `previousTurnNodeHash` ancestry: `same`
 * (identical), `forward` (target descends from source), `backward` (source
 * descends from target), or `lateral` (neither lineage contains the other).
 */
export type TurnNodeRelationship = "backward" | "forward" | "lateral" | "same";

/**
 * Classifies the lineage relationship from `sourceTurnNodeHash` to
 * `targetTurnNodeHash`.
 *
 * @throws TuvrenPersistenceError `memory_backend_cyclic_turn_node_lineage`
 *   when either ancestry walk encounters a cycle.
 */
export function classifyTurnNodeRelationship(
  state: BackendState,
  sourceTurnNodeHash: string,
  targetTurnNodeHash: string
): TurnNodeRelationship {
  if (sourceTurnNodeHash === targetTurnNodeHash) {
    return "same";
  }

  if (isTurnNodeDescendantOf(state, targetTurnNodeHash, sourceTurnNodeHash)) {
    return "forward";
  }

  if (isTurnNodeDescendantOf(state, sourceTurnNodeHash, targetTurnNodeHash)) {
    return "backward";
  }

  return "lateral";
}

/**
 * Walks `previousTurnNodeHash` ancestry from the candidate descendant and
 * reports whether it reaches the candidate ancestor. A node is considered a
 * descendant of itself.
 *
 * @throws TuvrenPersistenceError `memory_backend_cyclic_turn_node_lineage`
 *   when the walk revisits a node.
 */
export function isTurnNodeDescendantOf(
  state: BackendState,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string
): boolean {
  const visitedTurnNodes = new Set<string>();
  let currentTurnNodeHash: string | null = descendantTurnNodeHash;

  while (currentTurnNodeHash !== null) {
    if (visitedTurnNodes.has(currentTurnNodeHash)) {
      throw persistenceError(
        "turn node lineage must not contain cycles",
        "memory_backend_cyclic_turn_node_lineage",
        {
          ancestorTurnNodeHash,
          descendantTurnNodeHash,
        }
      );
    }

    if (currentTurnNodeHash === ancestorTurnNodeHash) {
      return true;
    }

    visitedTurnNodes.add(currentTurnNodeHash);
    currentTurnNodeHash = ensureTurnNodeExists(
      state,
      currentTurnNodeHash,
      "turnNodeHash"
    ).previousTurnNodeHash;
  }

  return false;
}

/**
 * Decodes a run's `createdTurnNodesCbor` into its ordered, append-only list
 * of created turn node hashes.
 */
export function decodeRunCreatedTurnNodeHashes(run: StoredRun): string[] {
  return decodeHashStringArray(
    run.createdTurnNodesCbor,
    "run.createdTurnNodesCbor"
  );
}

/**
 * A run's active turn node: the most recently created node in its
 * `createdTurnNodesCbor` lineage, or its start turn node when the run has
 * not created any nodes yet.
 */
export function getRunActiveTurnNodeHash(run: StoredRun): string {
  const createdTurnNodeHashes = decodeRunCreatedTurnNodeHashes(run);
  return createdTurnNodeHashes.at(-1) ?? run.startTurnNodeHash;
}

/**
 * Decodes a turn node's `consumedStagedResultsCbor` and extracts the
 * validated `objectHash` of every staged result the node consumed.
 *
 * @throws TuvrenPersistenceError
 *   `memory_backend_invalid_consumed_staged_results_cbor` when the payload is
 *   not an array, or `memory_backend_invalid_consumed_staged_result_entry`
 *   when an entry is not an object carrying a string `objectHash`.
 */
export function decodeTurnNodeConsumedStagedResultObjectHashes(
  turnNode: StoredTurnNode
): string[] {
  const decodedValue = decodeDeterministicKernelRecord(
    turnNode.consumedStagedResultsCbor
  );

  if (!Array.isArray(decodedValue)) {
    throw persistenceError(
      "stored turn node consumedStagedResultsCbor must decode to an array",
      "memory_backend_invalid_consumed_staged_results_cbor",
      {
        turnNodeHash: turnNode.hash,
      }
    );
  }

  const objectHashes: string[] = [];

  for (const [index, value] of decodedValue.entries()) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value instanceof Uint8Array
    ) {
      throw persistenceError(
        "stored turn node consumedStagedResultsCbor entries must decode to staged result objects",
        "memory_backend_invalid_consumed_staged_result_entry",
        {
          index,
          turnNodeHash: turnNode.hash,
        }
      );
    }

    const objectHash = Reflect.get(value, "objectHash");

    if (typeof objectHash !== "string") {
      throw persistenceError(
        "stored turn node consumedStagedResultsCbor entries must include objectHash",
        "memory_backend_invalid_consumed_staged_result_entry",
        {
          index,
          turnNodeHash: turnNode.hash,
        }
      );
    }

    objectHashes.push(validateHashString(objectHash));
  }

  return objectHashes;
}
