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
import { areBytesEqual, ensureTurnNodeExists } from "./sqlite-state-utils.js";

export type TurnNodeRelationship = "backward" | "forward" | "lateral" | "same";

export function assertRunUpdateIsLegal(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  assertImmutableField(
    existingRun.branchId,
    nextRun.branchId,
    "record.branchId",
    "sqlite_backend_run_branch_immutable"
  );
  assertImmutableField(
    existingRun.turnId,
    nextRun.turnId,
    "record.turnId",
    "sqlite_backend_run_turn_immutable"
  );
  assertImmutableField(
    existingRun.schemaId,
    nextRun.schemaId,
    "record.schemaId",
    "sqlite_backend_run_schema_immutable"
  );
  assertImmutableField(
    existingRun.startTurnNodeHash,
    nextRun.startTurnNodeHash,
    "record.startTurnNodeHash",
    "sqlite_backend_run_start_immutable"
  );
  assertImmutableField(
    existingRun.createdAtMs,
    nextRun.createdAtMs,
    "record.createdAtMs",
    "sqlite_backend_run_created_at_immutable"
  );
  assertImmutableBytes(
    existingRun.stepSequenceCbor,
    nextRun.stepSequenceCbor,
    "record.stepSequenceCbor",
    "sqlite_backend_run_step_sequence_immutable"
  );
  assertMonotonicUpdatedAtMs(
    existingRun.updatedAtMs,
    nextRun.updatedAtMs,
    "record.updatedAtMs",
    "sqlite_backend_run_updated_at_regressed"
  );

  if (
    existingRun.status === "running" ||
    (existingRun.status === "paused" && nextRun.status === "failed")
  ) {
    assertMonotonicRunStepIndex(existingRun, nextRun);
    assertAppendOnlyRunCreatedTurnNodes(existingRun, nextRun);
  } else {
    assertImmutableField(
      existingRun.currentStepIndex,
      nextRun.currentStepIndex,
      "record.currentStepIndex",
      "sqlite_backend_run_step_index_immutable_after_halt"
    );
    assertImmutableBytes(
      existingRun.createdTurnNodesCbor,
      nextRun.createdTurnNodesCbor,
      "record.createdTurnNodesCbor",
      "sqlite_backend_run_created_turn_nodes_immutable_after_halt"
    );
  }

  assertRunLeaseUpdateIsLegal(existingRun, nextRun);
  assertRunStatusTransition(existingRun.status, nextRun.status);
}

function assertRunLeaseUpdateIsLegal(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  assertExecutionOwnerUpdateIsLegal(existingRun, nextRun);
  assertFencingTokenUpdateIsLegal(existingRun, nextRun);
  assertLeaseExpiryUpdateIsLegal(existingRun, nextRun);
  assertPreemptionReasonUpdateIsLegal(existingRun, nextRun);
}

function assertExecutionOwnerUpdateIsLegal(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  if (
    existingRun.executionOwnerId !== undefined &&
    nextRun.status === "running"
  ) {
    assertImmutableField(
      existingRun.executionOwnerId,
      nextRun.executionOwnerId,
      "record.executionOwnerId",
      "sqlite_backend_run_execution_owner_immutable"
    );
    return;
  }

  if (
    existingRun.executionOwnerId === undefined &&
    nextRun.executionOwnerId !== undefined
  ) {
    throw persistenceError(
      "stored runs must not gain execution ownership after creation",
      "sqlite_backend_run_execution_owner_late_set",
      { runId: existingRun.runId }
    );
  }
}

function assertFencingTokenUpdateIsLegal(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  if (existingRun.status !== "running" || nextRun.status !== "running") {
    return;
  }

  if (existingRun.fencingToken !== undefined) {
    if (nextRun.fencingToken === undefined) {
      throw persistenceError(
        "stored running leased runs must retain a fencing token",
        "sqlite_backend_run_fencing_token_missing",
        { runId: existingRun.runId }
      );
    }

    if (existingRun.fencingToken === nextRun.fencingToken) {
      throw persistenceError(
        "stored running leased runs must rotate fencing tokens on renewal",
        "sqlite_backend_run_fencing_token_not_rotated",
        { runId: existingRun.runId }
      );
    }

    return;
  }

  if (nextRun.fencingToken !== undefined) {
    throw persistenceError(
      "stored runs must not gain a fencing token after creation",
      "sqlite_backend_run_fencing_token_late_set",
      { runId: existingRun.runId }
    );
  }
}

function assertLeaseExpiryUpdateIsLegal(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  if (
    existingRun.leaseExpiresAtMs !== undefined &&
    nextRun.leaseExpiresAtMs === undefined &&
    nextRun.status === "running"
  ) {
    throw persistenceError(
      "stored running leased runs must retain a lease expiry",
      "sqlite_backend_run_lease_expiry_missing",
      { runId: existingRun.runId }
    );
  }
}

function assertPreemptionReasonUpdateIsLegal(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  if (existingRun.preemptionReason !== undefined) {
    assertImmutableField(
      existingRun.preemptionReason,
      nextRun.preemptionReason,
      "record.preemptionReason",
      "sqlite_backend_run_preemption_reason_immutable"
    );
    return;
  }

  if (nextRun.preemptionReason !== undefined && nextRun.status !== "failed") {
    throw persistenceError(
      "stored runs must only record preemptionReason on failed runs",
      "sqlite_backend_run_preemption_reason_invalid_status",
      { runId: existingRun.runId, status: nextRun.status }
    );
  }
}

function assertMonotonicRunStepIndex(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  if (nextRun.currentStepIndex < existingRun.currentStepIndex) {
    throw persistenceError(
      "stored runs must not move currentStepIndex backwards",
      "sqlite_backend_run_step_index_regressed",
      {
        nextCurrentStepIndex: nextRun.currentStepIndex,
        previousCurrentStepIndex: existingRun.currentStepIndex,
        runId: existingRun.runId,
      }
    );
  }
}

export function assertMonotonicUpdatedAtMs(
  previousUpdatedAtMs: number,
  nextUpdatedAtMs: number,
  label: string,
  code: string
): void {
  if (nextUpdatedAtMs < previousUpdatedAtMs) {
    throw persistenceError(`${label} must not move backwards`, code, {
      nextUpdatedAtMs,
      previousUpdatedAtMs,
    });
  }
}

function assertAppendOnlyRunCreatedTurnNodes(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  const existingTurnNodeHashes = decodeRunCreatedTurnNodeHashes(existingRun);
  const nextTurnNodeHashes = decodeRunCreatedTurnNodeHashes(nextRun);

  if (nextTurnNodeHashes.length < existingTurnNodeHashes.length) {
    throw persistenceError(
      "stored runs must keep createdTurnNodesCbor append-only",
      "sqlite_backend_run_created_turn_nodes_not_append_only",
      {
        nextCount: nextTurnNodeHashes.length,
        previousCount: existingTurnNodeHashes.length,
        runId: existingRun.runId,
      }
    );
  }

  for (const [index, turnNodeHash] of existingTurnNodeHashes.entries()) {
    if (nextTurnNodeHashes[index] !== turnNodeHash) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor append-only",
        "sqlite_backend_run_created_turn_nodes_not_append_only",
        {
          index,
          nextTurnNodeHash: nextTurnNodeHashes[index],
          previousTurnNodeHash: turnNodeHash,
          runId: existingRun.runId,
        }
      );
    }
  }
}

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

export function decodeRunCreatedTurnNodeHashes(run: StoredRun): string[] {
  return decodeHashStringArray(
    run.createdTurnNodesCbor,
    "run.createdTurnNodesCbor"
  );
}

export function getRunActiveTurnNodeHash(run: StoredRun): string {
  const createdTurnNodeHashes = decodeRunCreatedTurnNodeHashes(run);
  return createdTurnNodeHashes.at(-1) ?? run.startTurnNodeHash;
}

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

function assertRunStatusTransition(
  previousStatus: StoredRun["status"],
  nextStatus: StoredRun["status"]
): void {
  if (previousStatus === nextStatus) {
    return;
  }

  const isLegalTransition =
    (previousStatus === "running" &&
      (nextStatus === "completed" ||
        nextStatus === "failed" ||
        nextStatus === "paused")) ||
    (previousStatus === "paused" && nextStatus === "failed");

  if (!isLegalTransition) {
    throw persistenceError(
      "stored runs must not use illegal status transitions",
      "sqlite_backend_run_status_transition_illegal",
      {
        nextStatus,
        previousStatus,
      }
    );
  }
}

export function assertImmutableField<T>(
  previousValue: T,
  nextValue: T,
  label: string,
  code: string
): void {
  if (previousValue !== nextValue) {
    throw persistenceError(`${label} must remain immutable`, code, {
      nextValue,
      previousValue,
    });
  }
}

export function assertImmutableOptionalField<T>(
  previousValue: T | undefined,
  nextValue: T | undefined,
  label: string,
  code: string
): void {
  if (previousValue !== nextValue) {
    throw persistenceError(`${label} must remain immutable`, code, {
      nextValue,
      previousValue,
    });
  }
}

export function assertImmutableBytes(
  previousValue: Uint8Array,
  nextValue: Uint8Array,
  label: string,
  code: string
): void {
  if (!areBytesEqual(previousValue, nextValue)) {
    throw persistenceError(`${label} must remain immutable`, code, {
      label,
    });
  }
}

export function validateHashString(hash: string): string {
  assertHashString(hash, "hash");
  return hash;
}
