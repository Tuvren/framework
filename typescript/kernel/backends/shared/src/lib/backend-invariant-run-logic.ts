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
import {
  type BackendInvariantRecordUtilsConfig,
  createBackendInvariantRecordUtils,
} from "./backend-invariant-record-utils.js";

/**
 * Configuration for {@link createBackendInvariantRunLogic}: the record-utils
 * error-prefix config plus the one backend-owned decoder the run-legality
 * checks need.
 */
export interface BackendInvariantRunLogicConfig
  extends BackendInvariantRecordUtilsConfig {
  /**
   * Decodes a stored run's `createdTurnNodesCbor` into its append-only turn
   * node hash lineage. This stays backend-owned (each backend has its own
   * lineage-decoding module) and is injected here rather than imported,
   * because this shared module has no access to any single backend's
   * lineage file.
   */
  decodeRunCreatedTurnNodeHashes(run: StoredRun): string[];
}

/**
 * The run-transition-legality invariant surface
 * `createBackendInvariantRunLogic` builds. Declared explicitly (rather than
 * inferred) for the same declaration-emit portability reason as
 * `BackendInvariantRecordUtils`.
 */
export interface BackendInvariantRunLogic {
  /**
   * Asserts that a record's `updatedAtMs` never moves backwards across an
   * update.
   *
   * @param previousUpdatedAtMs - The stored record's current `updatedAtMs`.
   * @param nextUpdatedAtMs - The candidate replacement's `updatedAtMs`.
   * @param label - Human-readable field label used in the error message
   *   (e.g. `"record.updatedAtMs"`).
   * @param updatedAtCode - Fully-formed backend-prefixed error code raised
   *   on regression.
   * @throws TuvrenPersistenceError when `nextUpdatedAtMs` is less than
   *   `previousUpdatedAtMs`.
   */
  assertMonotonicUpdatedAtMs(
    previousUpdatedAtMs: number,
    nextUpdatedAtMs: number,
    label: string,
    updatedAtCode: string
  ): void;
  /**
   * Asserts that replacing `existingRun` with `nextRun` is a legal stored-run
   * transition: identity/lineage fields stay immutable, `updatedAtMs` and
   * `currentStepIndex` are monotonic, `createdTurnNodesCbor` is append-only
   * while the run can still progress, lease fields (execution owner, fencing
   * token, lease expiry, preemption reason) follow the lease lifecycle rules,
   * and the status change is a legal run-status transition.
   *
   * @throws TuvrenPersistenceError with a backend-prefixed
   *   `<prefix>_backend_run_*` code identifying the first violated invariant.
   */
  assertRunUpdateIsLegal(existingRun: StoredRun, nextRun: StoredRun): void;
}

/**
 * Builds the run-transition-legality invariant surface shared by the memory
 * and PostgreSQL backends: `assertRunUpdateIsLegal` and its private
 * sub-assertions. The only backend-specific behavior is the error-code
 * prefix (delegated to the record-utils factory built from the same config)
 * and the injected `decodeRunCreatedTurnNodeHashes` dependency.
 */
export function createBackendInvariantRunLogic(
  config: BackendInvariantRunLogicConfig
): BackendInvariantRunLogic {
  const {
    assertImmutableBytes,
    assertImmutableField,
    assertRunStatusTransition,
    persistenceError,
  } = createBackendInvariantRecordUtils(config);

  function code(suffix: string): string {
    return `${config.errorPrefix}_backend_${suffix}`;
  }

  function assertRunUpdateIsLegal(
    existingRun: StoredRun,
    nextRun: StoredRun
  ): void {
    assertImmutableField(
      existingRun.branchId,
      nextRun.branchId,
      "record.branchId",
      code("run_branch_immutable")
    );
    assertImmutableField(
      existingRun.turnId,
      nextRun.turnId,
      "record.turnId",
      code("run_turn_immutable")
    );
    assertImmutableField(
      existingRun.schemaId,
      nextRun.schemaId,
      "record.schemaId",
      code("run_schema_immutable")
    );
    assertImmutableField(
      existingRun.startTurnNodeHash,
      nextRun.startTurnNodeHash,
      "record.startTurnNodeHash",
      code("run_start_immutable")
    );
    assertImmutableField(
      existingRun.createdAtMs,
      nextRun.createdAtMs,
      "record.createdAtMs",
      code("run_created_at_immutable")
    );
    assertImmutableBytes(
      existingRun.stepSequenceCbor,
      nextRun.stepSequenceCbor,
      "record.stepSequenceCbor",
      code("run_step_sequence_immutable")
    );
    assertMonotonicUpdatedAtMs(
      existingRun.updatedAtMs,
      nextRun.updatedAtMs,
      "record.updatedAtMs",
      code("run_updated_at_regressed")
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
        code("run_step_index_immutable_after_halt")
      );
      assertImmutableBytes(
        existingRun.createdTurnNodesCbor,
        nextRun.createdTurnNodesCbor,
        "record.createdTurnNodesCbor",
        code("run_created_turn_nodes_immutable_after_halt")
      );
    }

    assertRunLeaseUpdateIsLegal(existingRun, nextRun);
    assertRunStatusTransition(existingRun.status, nextRun.status);
  }

  /**
   * Lease-lifecycle legality: ownership, fencing token, lease expiry, and
   * preemption reason each follow their own set-once/rotate/retain rules.
   */
  function assertRunLeaseUpdateIsLegal(
    existingRun: StoredRun,
    nextRun: StoredRun
  ): void {
    assertExecutionOwnerUpdateIsLegal(existingRun, nextRun);
    assertFencingTokenUpdateIsLegal(existingRun, nextRun);
    assertLeaseExpiryUpdateIsLegal(existingRun, nextRun);
    assertPreemptionReasonUpdateIsLegal(existingRun, nextRun);
  }

  /**
   * `executionOwnerId` is immutable while the run stays running and must
   * never be gained after creation; a leaseless run stays leaseless.
   */
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
        code("run_execution_owner_immutable")
      );
      return;
    }

    if (
      existingRun.executionOwnerId === undefined &&
      nextRun.executionOwnerId !== undefined
    ) {
      throw persistenceError(
        "stored runs must not gain execution ownership after creation",
        code("run_execution_owner_late_set"),
        { runId: existingRun.runId }
      );
    }
  }

  /**
   * A leased run that stays running must retain a fencing token and must
   * rotate it on every renewal (same token twice means a stale writer); a
   * leaseless run must never gain one after creation.
   */
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
          code("run_fencing_token_missing"),
          { runId: existingRun.runId }
        );
      }

      if (existingRun.fencingToken === nextRun.fencingToken) {
        throw persistenceError(
          "stored running leased runs must rotate fencing tokens on renewal",
          code("run_fencing_token_not_rotated"),
          { runId: existingRun.runId }
        );
      }

      return;
    }

    if (nextRun.fencingToken !== undefined) {
      throw persistenceError(
        "stored runs must not gain a fencing token after creation",
        code("run_fencing_token_late_set"),
        { runId: existingRun.runId }
      );
    }
  }

  /** A leased run that stays running must not drop its lease expiry. */
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
        code("run_lease_expiry_missing"),
        { runId: existingRun.runId }
      );
    }
  }

  /**
   * `preemptionReason` is write-once and may only be recorded on a run that
   * is transitioning to (or already in) `failed` status.
   */
  function assertPreemptionReasonUpdateIsLegal(
    existingRun: StoredRun,
    nextRun: StoredRun
  ): void {
    if (existingRun.preemptionReason !== undefined) {
      assertImmutableField(
        existingRun.preemptionReason,
        nextRun.preemptionReason,
        "record.preemptionReason",
        code("run_preemption_reason_immutable")
      );
      return;
    }

    if (nextRun.preemptionReason !== undefined && nextRun.status !== "failed") {
      throw persistenceError(
        "stored runs must only record preemptionReason on failed runs",
        code("run_preemption_reason_invalid_status"),
        { runId: existingRun.runId, status: nextRun.status }
      );
    }
  }

  /** Asserts `currentStepIndex` never moves backwards across a run update. */
  function assertMonotonicRunStepIndex(
    existingRun: StoredRun,
    nextRun: StoredRun
  ): void {
    if (nextRun.currentStepIndex < existingRun.currentStepIndex) {
      throw persistenceError(
        "stored runs must not move currentStepIndex backwards",
        code("run_step_index_regressed"),
        {
          nextCurrentStepIndex: nextRun.currentStepIndex,
          previousCurrentStepIndex: existingRun.currentStepIndex,
          runId: existingRun.runId,
        }
      );
    }
  }

  /** Implements the {@link BackendInvariantRunLogic.assertMonotonicUpdatedAtMs} contract. */
  function assertMonotonicUpdatedAtMs(
    previousUpdatedAtMs: number,
    nextUpdatedAtMs: number,
    label: string,
    updatedAtCode: string
  ): void {
    if (nextUpdatedAtMs < previousUpdatedAtMs) {
      throw persistenceError(
        `${label} must not move backwards`,
        updatedAtCode,
        {
          nextUpdatedAtMs,
          previousUpdatedAtMs,
        }
      );
    }
  }

  /**
   * Asserts `createdTurnNodesCbor`'s decoded hash lineage only ever grows,
   * with every previously recorded hash preserved at its original index.
   */
  function assertAppendOnlyRunCreatedTurnNodes(
    existingRun: StoredRun,
    nextRun: StoredRun
  ): void {
    const existingTurnNodeHashes =
      config.decodeRunCreatedTurnNodeHashes(existingRun);
    const nextTurnNodeHashes = config.decodeRunCreatedTurnNodeHashes(nextRun);

    if (nextTurnNodeHashes.length < existingTurnNodeHashes.length) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor append-only",
        code("run_created_turn_nodes_not_append_only"),
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
          code("run_created_turn_nodes_not_append_only"),
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

  return {
    assertMonotonicUpdatedAtMs,
    assertRunUpdateIsLegal,
  };
}
