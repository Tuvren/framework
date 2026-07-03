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

export function isStoredTurnNode(value: unknown): value is StoredTurnNode {
  return tryAssert(value, assertStoredTurnNode);
}

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

export function isStoredObserveAnnotation(
  value: unknown
): value is StoredObserveAnnotation {
  return tryAssert(value, assertStoredObserveAnnotation);
}

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

export function isStoredThread(value: unknown): value is StoredThread {
  return tryAssert(value, assertStoredThread);
}

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

export function isStoredBranch(value: unknown): value is StoredBranch {
  return tryAssert(value, assertStoredBranch);
}

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

export function isStoredTurn(value: unknown): value is StoredTurn {
  return tryAssert(value, assertStoredTurn);
}

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

export function isStoredRun(value: unknown): value is StoredRun {
  return tryAssert(value, assertStoredRun);
}

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

export function isStoredStagedResult(
  value: unknown
): value is StoredStagedResult {
  return tryAssert(value, assertStoredStagedResult);
}

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
