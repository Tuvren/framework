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

import type { StoredRun } from "@tuvren/kernel-protocol";
import { decodeRunCreatedTurnNodeHashes } from "./memory-backend-lineage.js";
import {
  assertImmutableBytes,
  assertImmutableField,
  assertRunStatusTransition,
  persistenceError,
} from "./memory-backend-record-utils.js";

export function assertRunUpdateIsLegal(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  assertImmutableField(
    existingRun.branchId,
    nextRun.branchId,
    "record.branchId",
    "postgres_backend_run_branch_immutable"
  );
  assertImmutableField(
    existingRun.turnId,
    nextRun.turnId,
    "record.turnId",
    "postgres_backend_run_turn_immutable"
  );
  assertImmutableField(
    existingRun.schemaId,
    nextRun.schemaId,
    "record.schemaId",
    "postgres_backend_run_schema_immutable"
  );
  assertImmutableField(
    existingRun.startTurnNodeHash,
    nextRun.startTurnNodeHash,
    "record.startTurnNodeHash",
    "postgres_backend_run_start_immutable"
  );
  assertImmutableField(
    existingRun.createdAtMs,
    nextRun.createdAtMs,
    "record.createdAtMs",
    "postgres_backend_run_created_at_immutable"
  );
  assertImmutableBytes(
    existingRun.stepSequenceCbor,
    nextRun.stepSequenceCbor,
    "record.stepSequenceCbor",
    "postgres_backend_run_step_sequence_immutable"
  );
  assertMonotonicUpdatedAtMs(
    existingRun.updatedAtMs,
    nextRun.updatedAtMs,
    "record.updatedAtMs",
    "postgres_backend_run_updated_at_regressed"
  );

  if (
    existingRun.status === "running" ||
    (existingRun.status === "paused" && nextRun.status === "failed")
  ) {
    // Approval resume can surface a terminal failure after a paused run has
    // already durably recorded prior checkpoints. Keep the append-only and
    // monotonic checks active for that final transition instead of treating it
    // like a fully immutable halted record.
    assertMonotonicRunStepIndex(existingRun, nextRun);
    assertAppendOnlyRunCreatedTurnNodes(existingRun, nextRun);
  } else {
    assertImmutableField(
      existingRun.currentStepIndex,
      nextRun.currentStepIndex,
      "record.currentStepIndex",
      "postgres_backend_run_step_index_immutable_after_halt"
    );
    assertImmutableBytes(
      existingRun.createdTurnNodesCbor,
      nextRun.createdTurnNodesCbor,
      "record.createdTurnNodesCbor",
      "postgres_backend_run_created_turn_nodes_immutable_after_halt"
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
      "postgres_backend_run_execution_owner_immutable"
    );
    return;
  }

  if (
    existingRun.executionOwnerId === undefined &&
    nextRun.executionOwnerId !== undefined
  ) {
    throw persistenceError(
      "stored runs must not gain execution ownership after creation",
      "postgres_backend_run_execution_owner_late_set",
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
        "postgres_backend_run_fencing_token_missing",
        { runId: existingRun.runId }
      );
    }

    if (existingRun.fencingToken === nextRun.fencingToken) {
      throw persistenceError(
        "stored running leased runs must rotate fencing tokens on renewal",
        "postgres_backend_run_fencing_token_not_rotated",
        { runId: existingRun.runId }
      );
    }

    return;
  }

  if (nextRun.fencingToken !== undefined) {
    throw persistenceError(
      "stored runs must not gain a fencing token after creation",
      "postgres_backend_run_fencing_token_late_set",
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
      "postgres_backend_run_lease_expiry_missing",
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
      "postgres_backend_run_preemption_reason_immutable"
    );
    return;
  }

  if (nextRun.preemptionReason !== undefined && nextRun.status !== "failed") {
    throw persistenceError(
      "stored runs must only record preemptionReason on failed runs",
      "postgres_backend_run_preemption_reason_invalid_status",
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
      "postgres_backend_run_step_index_regressed",
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
      "postgres_backend_run_created_turn_nodes_not_append_only",
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
        "postgres_backend_run_created_turn_nodes_not_append_only",
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
