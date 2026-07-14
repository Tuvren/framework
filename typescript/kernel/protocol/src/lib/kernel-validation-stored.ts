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

// biome-ignore-all lint/performance/noBarrelFile: This focused contract subpath intentionally combines stored validators with delegated turn-tree validators.

import type { KernelRecord } from "@tuvren/core";
import { hashTurnNodeIdentity } from "./kernel-identity.js";
import type {
  PathDefinition,
  RunStatus,
  StagedResultStatus,
  StoredBranch,
  StoredObserveAnnotation,
  StoredRun,
  StoredStagedResult,
  StoredThread,
  StoredTurn,
  StoredTurnNode,
} from "./kernel-types.js";
import {
  assertMonotonicTimestamps,
  assertStagedResultArray,
} from "./kernel-validation-records.js";
import {
  assertRunStatus,
  assertStagedResultStatus,
} from "./kernel-validation-runtime.js";
import {
  assertAllowedObjectKeys,
  assertArray,
  assertDecodedKernelRecord,
  assertEpochMs,
  assertHashString,
  assertHashStringArray,
  assertKernelObject,
  assertKernelRecord,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertNullableHashString,
  assertNullableString,
  assertOptionalFieldIsOmittedWhenUndefined,
  assertPlainObject,
  assertUint8Array,
  tryAssert,
  validationError,
} from "./kernel-validation-shared.js";

export {
  assertStoredObject,
  assertStoredObjectIdentity,
  assertStoredOrderedPathChunk,
  assertStoredOrderedPathChunkIdentity,
  assertStoredSchema,
  assertStoredTurnTree,
  assertStoredTurnTreeIdentity,
  assertStoredTurnTreePath,
  isStoredObject,
  isStoredOrderedPathChunk,
  isStoredSchema,
  isStoredTurnTree,
  isStoredTurnTreePath,
} from "./kernel-validation-stored-turn-tree.js";

/**
 * True when `value` is a structurally valid {@link StoredTurnNode}.
 */
export function isStoredTurnNode(value: unknown): value is StoredTurnNode {
  return tryAssert(value, assertStoredTurnNode);
}

/**
 * Asserts a structurally valid {@link StoredTurnNode} (kernel spec §3.3),
 * including that `consumedStagedResultsCbor` decodes as canonical deterministic
 * CBOR into a staged-result array with unique `taskId`s. Does not recompute the
 * identity hash; use {@link assertStoredTurnNodeIdentity} for that.
 */
export function assertStoredTurnNode(
  value: unknown,
  label = "value"
): asserts value is StoredTurnNode {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    [
      "consumedStagedResultsCbor",
      "createdAtMs",
      "eventHash",
      "hash",
      "previousTurnNodeHash",
      "schemaId",
      "turnTreeHash",
    ],
    label
  );
  const consumedStagedResultsCbor = objectValue.consumedStagedResultsCbor;

  assertHashString(objectValue.hash, `${label}.hash`);
  assertNullableHashString(
    objectValue.previousTurnNodeHash,
    `${label}.previousTurnNodeHash`
  );
  assertHashString(objectValue.turnTreeHash, `${label}.turnTreeHash`);
  assertUint8Array(
    consumedStagedResultsCbor,
    `${label}.consumedStagedResultsCbor`
  );
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertNullableHashString(objectValue.eventHash, `${label}.eventHash`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  assertDecodedKernelRecord(
    consumedStagedResultsCbor,
    assertStagedResultArray,
    `${label}.consumedStagedResultsCbor`
  );
}

/**
 * Asserts a structurally valid {@link StoredTurnNode} whose `hash` also equals
 * the recomputed canonical TurnNode identity digest over the decoded record
 * fields (`hashTurnNodeIdentity`, kernel spec §3.3).
 *
 * @throws TuvrenValidationError With code `invalid_stored_turn_node_hash` when
 *   the stored hash does not match the canonical identity hash.
 */
export async function assertStoredTurnNodeIdentity(
  value: unknown,
  label = "value"
): Promise<void> {
  assertStoredTurnNode(value, label);

  const consumedStagedResults = assertDecodedKernelRecord(
    value.consumedStagedResultsCbor,
    assertStagedResultArray,
    `${label}.consumedStagedResultsCbor`
  );
  const expectedHash = await hashTurnNodeIdentity({
    consumedStagedResults,
    eventHash: value.eventHash,
    previousTurnNodeHash: value.previousTurnNodeHash,
    schemaId: value.schemaId,
    turnTreeHash: value.turnTreeHash,
  });

  if (value.hash !== expectedHash) {
    throw validationError(
      `${label}.hash must match the canonical TurnNode identity hash`,
      "invalid_stored_turn_node_hash",
      {
        expectedHash,
        hash: value.hash,
      }
    );
  }
}

/**
 * True when `value` is a structurally valid {@link StoredObserveAnnotation}.
 */
export function isStoredObserveAnnotation(
  value: unknown
): value is StoredObserveAnnotation {
  return tryAssert(value, assertStoredObserveAnnotation);
}

/**
 * Asserts a structurally valid {@link StoredObserveAnnotation} (kernel spec
 * §6.4): `annotationCbor` must decode as canonical deterministic CBOR into a
 * plain-object kernel record, and `turnNodeHash` may be `null`.
 */
export function assertStoredObserveAnnotation(
  value: unknown,
  label = "value"
): asserts value is StoredObserveAnnotation {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    [
      "annotationCbor",
      "annotationHash",
      "createdAtMs",
      "runId",
      "turnNodeHash",
    ],
    label
  );

  assertUint8Array(objectValue.annotationCbor, `${label}.annotationCbor`);
  assertHashString(objectValue.annotationHash, `${label}.annotationHash`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  assertNonEmptyString(objectValue.runId, `${label}.runId`);
  assertNullableHashString(objectValue.turnNodeHash, `${label}.turnNodeHash`);
  assertDecodedKernelRecord(
    objectValue.annotationCbor,
    assertKernelObject,
    `${label}.annotationCbor`
  );
}

/**
 * True when `value` is a structurally valid {@link StoredThread}.
 */
export function isStoredThread(value: unknown): value is StoredThread {
  return tryAssert(value, assertStoredThread);
}

/**
 * Asserts a structurally valid {@link StoredThread} (kernel spec §4.1).
 */
export function assertStoredThread(
  value: unknown,
  label = "value"
): asserts value is StoredThread {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["createdAtMs", "rootTurnNodeHash", "schemaId", "threadId"],
    label
  );

  assertNonEmptyString(objectValue.threadId, `${label}.threadId`);
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertHashString(objectValue.rootTurnNodeHash, `${label}.rootTurnNodeHash`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
}

/**
 * True when `value` is a structurally valid {@link StoredBranch}.
 */
export function isStoredBranch(value: unknown): value is StoredBranch {
  return tryAssert(value, assertStoredBranch);
}

/**
 * Asserts a structurally valid {@link StoredBranch} (kernel spec §4.2):
 * `archivedFromBranchId`, when present, must differ from the branch's own id,
 * and `updatedAtMs` must not precede `createdAtMs`.
 *
 * @throws TuvrenValidationError With code `invalid_branch_archive_source` when
 *   an archive branch names itself as its source.
 */
export function assertStoredBranch(
  value: unknown,
  label = "value"
): asserts value is StoredBranch {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    [
      "archivedFromBranchId",
      "branchId",
      "createdAtMs",
      "headTurnNodeHash",
      "threadId",
      "updatedAtMs",
    ],
    label
  );

  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "archivedFromBranchId",
    label
  );
  assertNonEmptyString(objectValue.branchId, `${label}.branchId`);
  assertNonEmptyString(objectValue.threadId, `${label}.threadId`);
  assertHashString(objectValue.headTurnNodeHash, `${label}.headTurnNodeHash`);

  if (objectValue.archivedFromBranchId !== undefined) {
    assertNonEmptyString(
      objectValue.archivedFromBranchId,
      `${label}.archivedFromBranchId`
    );

    if (objectValue.archivedFromBranchId === objectValue.branchId) {
      throw validationError(
        `${label}.archivedFromBranchId must differ from ${label}.branchId`,
        "invalid_branch_archive_source",
        {
          archivedFromBranchId: objectValue.archivedFromBranchId,
          branchId: objectValue.branchId,
        }
      );
    }
  }

  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  assertEpochMs(objectValue.updatedAtMs, `${label}.updatedAtMs`);
  assertMonotonicTimestamps(
    objectValue.createdAtMs,
    objectValue.updatedAtMs,
    `${label}.createdAtMs`,
    `${label}.updatedAtMs`
  );
}

/**
 * True when `value` is a structurally valid {@link StoredTurn}.
 */
export function isStoredTurn(value: unknown): value is StoredTurn {
  return tryAssert(value, assertStoredTurn);
}

/**
 * Asserts a structurally valid {@link StoredTurn} (kernel spec §5.3), including
 * monotonic `createdAtMs` / `updatedAtMs` timestamps.
 */
export function assertStoredTurn(
  value: unknown,
  label = "value"
): asserts value is StoredTurn {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    [
      "branchId",
      "createdAtMs",
      "headTurnNodeHash",
      "parentTurnId",
      "startTurnNodeHash",
      "threadId",
      "turnId",
      "updatedAtMs",
    ],
    label
  );

  assertNonEmptyString(objectValue.turnId, `${label}.turnId`);
  assertNonEmptyString(objectValue.threadId, `${label}.threadId`);
  assertNonEmptyString(objectValue.branchId, `${label}.branchId`);
  assertNullableString(objectValue.parentTurnId, `${label}.parentTurnId`);
  assertHashString(objectValue.startTurnNodeHash, `${label}.startTurnNodeHash`);
  assertHashString(objectValue.headTurnNodeHash, `${label}.headTurnNodeHash`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  assertEpochMs(objectValue.updatedAtMs, `${label}.updatedAtMs`);
  assertMonotonicTimestamps(
    objectValue.createdAtMs,
    objectValue.updatedAtMs,
    `${label}.createdAtMs`,
    `${label}.updatedAtMs`
  );
}

/**
 * True when `value` is a structurally valid {@link StoredRun}.
 */
export function isStoredRun(value: unknown): value is StoredRun {
  return tryAssert(value, assertStoredRun);
}

/**
 * Asserts a structurally valid {@link StoredRun} (kernel spec §5.2), the stored
 * counterpart of `assertRunRecord` in kernel-validation-records.ts:
 *
 * - `stepSequenceCbor` and `createdTurnNodesCbor` (and `pendingSignalsCbor`
 *   when present) must decode as canonical deterministic CBOR into their
 *   declared shapes.
 * - `currentStepIndex` never exceeds the decoded step count; a `"running"` run
 *   needs a non-empty step sequence, and a `"completed"` run must have
 *   exhausted every declared step.
 * - Lease fields are all-or-nothing and only legal while `"running"`;
 *   `preemptionReason` only on `"failed"` runs (§5.2, "Run Execution Leases").
 * - Timestamps must be monotonic (`updatedAtMs >= createdAtMs`).
 */
export function assertStoredRun(
  value: unknown,
  label = "value"
): asserts value is StoredRun {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    [
      "branchId",
      "createdAtMs",
      "createdTurnNodesCbor",
      "currentStepIndex",
      "executionOwnerId",
      "fencingToken",
      "leaseExpiresAtMs",
      "pendingSignalsCbor",
      "preemptionReason",
      "runId",
      "schemaId",
      "startTurnNodeHash",
      "status",
      "stepSequenceCbor",
      "turnId",
      "updatedAtMs",
    ],
    label
  );
  const currentStepIndex = objectValue.currentStepIndex;
  const stepSequenceCbor = objectValue.stepSequenceCbor;
  const createdTurnNodesCbor = objectValue.createdTurnNodesCbor;

  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "executionOwnerId",
    label
  );
  assertOptionalFieldIsOmittedWhenUndefined(objectValue, "fencingToken", label);
  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "leaseExpiresAtMs",
    label
  );
  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "pendingSignalsCbor",
    label
  );
  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "preemptionReason",
    label
  );
  assertNonEmptyString(objectValue.runId, `${label}.runId`);
  assertNonEmptyString(objectValue.turnId, `${label}.turnId`);
  assertNonEmptyString(objectValue.branchId, `${label}.branchId`);
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertHashString(objectValue.startTurnNodeHash, `${label}.startTurnNodeHash`);
  assertRunStatus(objectValue.status, `${label}.status`);
  assertNonNegativeInteger(currentStepIndex, `${label}.currentStepIndex`);
  assertUint8Array(stepSequenceCbor, `${label}.stepSequenceCbor`);
  assertUint8Array(createdTurnNodesCbor, `${label}.createdTurnNodesCbor`);

  if (objectValue.pendingSignalsCbor !== undefined) {
    assertUint8Array(
      objectValue.pendingSignalsCbor,
      `${label}.pendingSignalsCbor`
    );
  }
  assertOptionalRunLivenessFields(
    objectValue.status,
    objectValue.executionOwnerId,
    objectValue.fencingToken,
    objectValue.leaseExpiresAtMs,
    objectValue.preemptionReason,
    label
  );
  const stepSequence = assertDecodedKernelRecord(
    stepSequenceCbor,
    assertStepDeclarationArray,
    `${label}.stepSequenceCbor`
  );
  assertDecodedKernelRecord(
    createdTurnNodesCbor,
    assertHashStringArray,
    `${label}.createdTurnNodesCbor`
  );
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  assertEpochMs(objectValue.updatedAtMs, `${label}.updatedAtMs`);
  assertMonotonicTimestamps(
    objectValue.createdAtMs,
    objectValue.updatedAtMs,
    `${label}.createdAtMs`,
    `${label}.updatedAtMs`
  );

  if (currentStepIndex > stepSequence.length) {
    throw validationError(
      `${label}.currentStepIndex must not exceed the decoded step count in ${label}.stepSequenceCbor`,
      "invalid_run_step_index",
      {
        currentStepIndex,
        stepCount: stepSequence.length,
      }
    );
  }

  assertRunningRunHasNextStep(
    objectValue.status,
    currentStepIndex,
    stepSequence.length,
    `${label}.status`,
    `${label}.currentStepIndex`,
    `${label}.stepSequenceCbor`
  );
  assertCompletedRunExhaustsSteps(
    objectValue.status,
    currentStepIndex,
    stepSequence.length,
    `${label}.status`,
    `${label}.currentStepIndex`,
    `${label}.stepSequenceCbor`
  );
}

/**
 * True when `value` is a structurally valid {@link StoredStagedResult}.
 */
export function isStoredStagedResult(
  value: unknown
): value is StoredStagedResult {
  return tryAssert(value, assertStoredStagedResult);
}

/**
 * Asserts a structurally valid {@link StoredStagedResult} (kernel spec §3.4):
 * `interruptPayloadCbor` must be canonical deterministic CBOR and present
 * exactly when `status` is `"interrupted"`.
 */
export function assertStoredStagedResult(
  value: unknown,
  label = "value"
): asserts value is StoredStagedResult {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    [
      "createdAtMs",
      "interruptPayloadCbor",
      "objectHash",
      "objectType",
      "runId",
      "status",
      "taskId",
    ],
    label
  );
  const interruptPayloadCbor = objectValue.interruptPayloadCbor;

  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "interruptPayloadCbor",
    label
  );
  assertNonEmptyString(objectValue.runId, `${label}.runId`);
  assertNonEmptyString(objectValue.taskId, `${label}.taskId`);
  assertHashString(objectValue.objectHash, `${label}.objectHash`);
  assertNonEmptyString(objectValue.objectType, `${label}.objectType`);
  assertStagedResultStatus(objectValue.status, `${label}.status`);

  if (interruptPayloadCbor !== undefined) {
    assertUint8Array(interruptPayloadCbor, `${label}.interruptPayloadCbor`);
    assertDecodedKernelRecord(
      interruptPayloadCbor,
      assertKernelRecord,
      `${label}.interruptPayloadCbor`
    );
  }

  assertInterruptPayloadConsistency(
    objectValue.status,
    interruptPayloadCbor,
    `${label}.interruptPayloadCbor`
  );

  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
}

/**
 * Enforces that the interrupt payload is present exactly when `status` is
 * `"interrupted"`.
 */
function assertInterruptPayloadConsistency(
  status: StagedResultStatus,
  interruptPayload: KernelRecord | Uint8Array | undefined,
  label: string
): void {
  if (status === "interrupted") {
    if (interruptPayload === undefined) {
      throw validationError(
        `${label} is required when status is "interrupted"`,
        "invalid_interrupt_payload",
        { status }
      );
    }

    return;
  }

  if (interruptPayload !== undefined) {
    throw validationError(
      `${label} must be omitted unless status is "interrupted"`,
      "invalid_interrupt_payload",
      { status }
    );
  }
}

/**
 * Enforces the run-liveness field invariants of kernel spec §5.2 on stored
 * runs: the three lease fields travel together, only on `"running"` runs, and
 * `preemptionReason` only on `"failed"` runs. Mirrors the RunRecord validator
 * in kernel-validation-records.ts.
 */
function assertOptionalRunLivenessFields(
  status: RunStatus,
  executionOwnerId: unknown,
  fencingToken: unknown,
  leaseExpiresAtMs: unknown,
  preemptionReason: unknown,
  label: string
): void {
  const hasExecutionOwnerId = executionOwnerId !== undefined;
  const hasFencingToken = fencingToken !== undefined;
  const hasLeaseExpiresAtMs = leaseExpiresAtMs !== undefined;
  const hasLeaseFields =
    hasExecutionOwnerId || hasFencingToken || hasLeaseExpiresAtMs;

  if (hasLeaseFields) {
    if (!(hasExecutionOwnerId && hasFencingToken && hasLeaseExpiresAtMs)) {
      throw validationError(
        `${label} must provide executionOwnerId, fencingToken, and leaseExpiresAtMs together`,
        "invalid_run_liveness_fields",
        {
          executionOwnerId,
          fencingToken,
          leaseExpiresAtMs,
        }
      );
    }

    if (status !== "running") {
      throw validationError(
        `${label} must not retain lease ownership fields once the run is not running`,
        "invalid_run_liveness_status",
        {
          status,
        }
      );
    }

    assertNonEmptyString(executionOwnerId, `${label}.executionOwnerId`);
    assertNonEmptyString(fencingToken, `${label}.fencingToken`);
    assertEpochMs(leaseExpiresAtMs, `${label}.leaseExpiresAtMs`);
  }

  if (preemptionReason !== undefined) {
    if (status !== "failed") {
      throw validationError(
        `${label}.preemptionReason is only valid for failed runs`,
        "invalid_run_preemption_reason_status",
        {
          status,
        }
      );
    }

    assertNonEmptyString(preemptionReason, `${label}.preemptionReason`);
  }
}

/**
 * Validates a decoded step-sequence payload: plain step objects with contract
 * keys and unique, non-empty ids.
 */
function assertStepDeclarationArray(
  value: unknown,
  label: string
): asserts value is PathDefinition[] {
  const steps = assertArray(value, label);
  const seenIds = new Set<string>();

  for (const [index, step] of steps.entries()) {
    const stepValue = assertPlainObject(step, `${label}[${index}]`);
    assertAllowedObjectKeys(
      stepValue,
      ["deterministic", "id", "metadata", "sideEffects"],
      `${label}[${index}]`
    );
    assertOptionalFieldIsOmittedWhenUndefined(
      stepValue,
      "metadata",
      `${label}[${index}]`
    );
    assertNonEmptyString(stepValue.id, `${label}[${index}].id`);

    if (seenIds.has(stepValue.id)) {
      throw validationError(
        `${label} must not contain duplicate step ids`,
        "duplicate_step_id",
        { stepId: stepValue.id }
      );
    }

    seenIds.add(stepValue.id);
  }
}

/**
 * A `"running"` stored run must have a non-empty step sequence and an in-range
 * `currentStepIndex` (kernel spec §5.2).
 */
function assertRunningRunHasNextStep(
  status: RunStatus,
  currentStepIndex: number,
  stepCount: number,
  statusLabel: string,
  currentStepIndexLabel: string,
  stepSequenceLabel: string
): void {
  if (status !== "running") {
    return;
  }

  if (stepCount === 0) {
    throw validationError(
      `${statusLabel} cannot be "running" when ${stepSequenceLabel} is empty`,
      "invalid_run_step_index",
      { status, stepCount }
    );
  }

  if (currentStepIndex > stepCount) {
    throw validationError(
      `${currentStepIndexLabel} must not exceed the declared step count in ${stepSequenceLabel} when ${statusLabel} is "running"`,
      "invalid_run_step_index",
      { currentStepIndex, status, stepCount }
    );
  }
}

/**
 * A `"completed"` stored run must have executed every declared step:
 * `currentStepIndex` equals the decoded step count.
 */
function assertCompletedRunExhaustsSteps(
  status: RunStatus,
  currentStepIndex: number,
  stepCount: number,
  statusLabel: string,
  currentStepIndexLabel: string,
  stepSequenceLabel: string
): void {
  if (status !== "completed") {
    return;
  }

  if (currentStepIndex !== stepCount) {
    throw validationError(
      `${currentStepIndexLabel} must equal the declared step count in ${stepSequenceLabel} when ${statusLabel} is "completed"`,
      "invalid_run_step_index",
      { currentStepIndex, status, stepCount }
    );
  }
}
