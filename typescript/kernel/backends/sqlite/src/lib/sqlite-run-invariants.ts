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
  createBackendInvariantRecordUtils,
  createBackendInvariantRunLogic,
} from "@tuvren/backend-shared";
import { assertHashString } from "@tuvren/core";
import {
  decodeDeterministicKernelRecord,
  type StoredBranch,
  type StoredRun,
  type StoredTurn,
  type StoredTurnNode,
} from "@tuvren/kernel-protocol";
import { persistenceError } from "./sqlite-errors.js";
import { type BackendState, decodeHashStringArray } from "./sqlite-records.js";
import { ensureTurnNodeExists } from "./sqlite-state-utils.js";

/**
 * How two turn nodes relate along `previousTurnNodeHash` ancestry: `same`
 * (identical), `forward` (target descends from source), `backward` (source
 * descends from target), or `lateral` (neither lineage contains the other).
 */
export type TurnNodeRelationship = "backward" | "forward" | "lateral" | "same";

// This module is a thin delegate to the shared kernel-backend invariant core
// (KRT-BK001) for the run-transition-legality and immutability-primitive
// surface: `assertRunUpdateIsLegal` (and its private sub-assertions) and
// `assertImmutableField`/`assertImmutableOptionalField`/`assertImmutableBytes`
// are identical to the memory and PostgreSQL backends' copies modulo the
// `sqlite_backend_*` error-code prefix. See @tuvren/backend-shared for the
// actual implementation. `decodeRunCreatedTurnNodeHashes` stays backend-owned
// (it is not part of this extraction, and this same module still needs it
// below for sqlite-specific lineage checks) and is injected into the shared
// run-logic factory. `function` hoisting makes the later declaration in this
// module available here at call time.
const runLogic = createBackendInvariantRunLogic({
  decodeRunCreatedTurnNodeHashes,
  errorPrefix: "sqlite",
});
const recordUtils = createBackendInvariantRecordUtils({
  errorPrefix: "sqlite",
});

export const { assertMonotonicUpdatedAtMs, assertRunUpdateIsLegal } = runLogic;
export const {
  assertImmutableBytes,
  assertImmutableField,
  assertImmutableOptionalField,
} = recordUtils;

/**
 * Asserts that a run's start turn node lies within its turn's span: at or
 * after the turn's start node and at or before the turn's head node on the
 * same lineage.
 *
 * @throws TuvrenPersistenceError `sqlite_backend_run_turn_span_mismatch`.
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
      "sqlite_backend_run_turn_span_mismatch",
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
      "sqlite_backend_run_turn_span_mismatch",
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
 *   `sqlite_backend_run_created_turn_node_outside_turn_span`.
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
      "sqlite_backend_run_created_turn_node_outside_turn_span",
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
      "sqlite_backend_run_created_turn_node_outside_turn_span",
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
 *   `sqlite_backend_run_created_turn_nodes_duplicate` or
 *   `sqlite_backend_run_created_turn_nodes_not_contiguous`.
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
        "sqlite_backend_run_created_turn_nodes_duplicate",
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
        "sqlite_backend_run_created_turn_nodes_not_contiguous",
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
 * branch head and the turn head.
 *
 * @throws TuvrenPersistenceError
 *   `sqlite_backend_active_run_branch_head_mismatch` or
 *   `sqlite_backend_active_run_turn_head_mismatch`.
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
      "sqlite_backend_active_run_branch_head_mismatch",
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
      "sqlite_backend_active_run_turn_head_mismatch",
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
 * Classifies the lineage relationship from `sourceTurnNodeHash` to
 * `targetTurnNodeHash` over the loaded state projection.
 *
 * @throws TuvrenPersistenceError `sqlite_backend_cyclic_turn_node_lineage`
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

function isTurnNodeDescendantOf(
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
        "sqlite_backend_cyclic_turn_node_lineage",
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
 *   `sqlite_backend_invalid_consumed_staged_results_cbor` or
 *   `sqlite_backend_invalid_consumed_staged_result_entry`.
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
      "sqlite_backend_invalid_consumed_staged_results_cbor",
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
        "sqlite_backend_invalid_consumed_staged_result_entry",
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
        "sqlite_backend_invalid_consumed_staged_result_entry",
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

/** Asserts the value is a well-formed hash string and returns it. */
export function validateHashString(hash: string): string {
  assertHashString(hash, "hash");
  return hash;
}
