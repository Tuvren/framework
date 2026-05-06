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

import type { KernelRecord } from "@tuvren/core-types";
import { hashTurnNodeIdentity } from "./kernel-identity.js";
import type {
  BranchHeadListEntry,
  BranchRecord,
  RecoveryState,
  RunRecord,
  RunStatus,
  SetHeadResult,
  StagedResult,
  StagedResultStatus,
  StepContext,
  StepDeclaration,
  ThreadCreateResult,
  ThreadRecord,
  TurnNode,
  TurnRecord,
} from "./kernel-types.js";
import {
  assertRunStatus,
  assertStagedResultStatus,
  assertStepDeclaration,
  assertTurnTreeSchema,
} from "./kernel-validation-runtime.js";
import {
  assertAllowedObjectKeys,
  assertArray,
  assertEpochMs,
  assertHashString,
  assertHashStringArray,
  assertKernelRecord,
  assertKernelRecordArray,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertNullableHashString,
  assertNullableString,
  assertOptionalFieldIsOmittedWhenUndefined,
  assertPlainObject,
  tryAssert,
  validationError,
} from "./kernel-validation-shared.js";

export function isTurnNode(value: unknown): value is TurnNode {
  return tryAssert(value, assertTurnNode);
}

export function assertTurnNode(
  value: unknown,
  label = "value"
): asserts value is TurnNode {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    [
      "consumedStagedResults",
      "eventHash",
      "hash",
      "previousTurnNodeHash",
      "schemaId",
      "turnTreeHash",
    ],
    label
  );

  assertHashString(objectValue.hash, `${label}.hash`);
  assertNullableHashString(
    objectValue.previousTurnNodeHash,
    `${label}.previousTurnNodeHash`
  );
  assertHashString(objectValue.turnTreeHash, `${label}.turnTreeHash`);
  assertStagedResultArray(
    objectValue.consumedStagedResults,
    `${label}.consumedStagedResults`
  );
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertNullableHashString(objectValue.eventHash, `${label}.eventHash`);
}

export async function assertTurnNodeIdentity(
  value: unknown,
  label = "value"
): Promise<void> {
  assertTurnNode(value, label);

  const expectedHash = await hashTurnNodeIdentity(value);

  if (value.hash !== expectedHash) {
    throw validationError(
      `${label}.hash must match the canonical TurnNode identity hash`,
      "invalid_turn_node_hash",
      {
        expectedHash,
        hash: value.hash,
      }
    );
  }
}

export function isThreadRecord(value: unknown): value is ThreadRecord {
  return tryAssert(value, assertThreadRecord);
}

export function assertThreadRecord(
  value: unknown,
  label = "value"
): asserts value is ThreadRecord {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["rootTurnNodeHash", "schemaId", "threadId"],
    label
  );

  assertNonEmptyString(objectValue.threadId, `${label}.threadId`);
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertHashString(objectValue.rootTurnNodeHash, `${label}.rootTurnNodeHash`);
}

export function isBranchRecord(value: unknown): value is BranchRecord {
  return tryAssert(value, assertBranchRecord);
}

export function assertBranchRecord(
  value: unknown,
  label = "value"
): asserts value is BranchRecord {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["branchId", "headTurnNodeHash", "threadId"],
    label
  );

  assertNonEmptyString(objectValue.branchId, `${label}.branchId`);
  assertNonEmptyString(objectValue.threadId, `${label}.threadId`);
  assertHashString(objectValue.headTurnNodeHash, `${label}.headTurnNodeHash`);
}

export function isBranchHeadListEntry(
  value: unknown
): value is BranchHeadListEntry {
  return tryAssert(value, assertBranchHeadListEntry);
}

export function assertBranchHeadListEntry(
  value: unknown,
  label = "value"
): asserts value is BranchHeadListEntry {
  const tupleValue = assertArray(value, label);

  if (tupleValue.length !== 2) {
    throw validationError(
      `${label} must be a [branchId, headTurnNodeHash] tuple`,
      "invalid_branch_head_list_entry",
      { value }
    );
  }

  assertNonEmptyString(tupleValue[0], `${label}[0]`);
  assertHashString(tupleValue[1], `${label}[1]`);
}

export function isTurnRecord(value: unknown): value is TurnRecord {
  return tryAssert(value, assertTurnRecord);
}

export function assertTurnRecord(
  value: unknown,
  label = "value"
): asserts value is TurnRecord {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    [
      "branchId",
      "headTurnNodeHash",
      "parentTurnId",
      "startTurnNodeHash",
      "threadId",
      "turnId",
    ],
    label
  );

  assertNonEmptyString(objectValue.turnId, `${label}.turnId`);
  assertNonEmptyString(objectValue.threadId, `${label}.threadId`);
  assertNonEmptyString(objectValue.branchId, `${label}.branchId`);
  assertNullableString(objectValue.parentTurnId, `${label}.parentTurnId`);
  assertHashString(objectValue.startTurnNodeHash, `${label}.startTurnNodeHash`);
  assertHashString(objectValue.headTurnNodeHash, `${label}.headTurnNodeHash`);
}

export function isRunRecord(value: unknown): value is RunRecord {
  return tryAssert(value, assertRunRecord);
}

export function assertRunRecord(
  value: unknown,
  label = "value"
): asserts value is RunRecord {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    [
      "branchId",
      "createdTurnNodes",
      "currentStepIndex",
      "executionOwnerId",
      "fencingToken",
      "leaseExpiresAtMs",
      "preemptionReason",
      "runId",
      "schemaId",
      "startTurnNodeHash",
      "status",
      "stepSequence",
      "turnId",
    ],
    label
  );
  const currentStepIndex = objectValue.currentStepIndex;
  const stepSequence = objectValue.stepSequence;

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
  assertStepDeclarationArray(stepSequence, `${label}.stepSequence`);
  assertHashStringArray(
    objectValue.createdTurnNodes,
    `${label}.createdTurnNodes`
  );
  assertOptionalRunLivenessFields(
    objectValue.status,
    objectValue.executionOwnerId,
    objectValue.fencingToken,
    objectValue.leaseExpiresAtMs,
    objectValue.preemptionReason,
    label
  );

  if (currentStepIndex > stepSequence.length) {
    throw validationError(
      `${label}.currentStepIndex must not exceed ${label}.stepSequence.length`,
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
    `${label}.stepSequence`
  );
  assertCompletedRunExhaustsSteps(
    objectValue.status,
    currentStepIndex,
    stepSequence.length,
    `${label}.status`,
    `${label}.currentStepIndex`,
    `${label}.stepSequence`
  );
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

export function isStagedResult(value: unknown): value is StagedResult {
  return tryAssert(value, assertStagedResult);
}

export function assertStagedResult(
  value: unknown,
  label = "value"
): asserts value is StagedResult {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    [
      "interruptPayload",
      "objectHash",
      "objectType",
      "status",
      "taskId",
      "timestamp",
    ],
    label
  );

  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "interruptPayload",
    label
  );
  assertNonEmptyString(objectValue.taskId, `${label}.taskId`);
  assertHashString(objectValue.objectHash, `${label}.objectHash`);
  assertNonEmptyString(objectValue.objectType, `${label}.objectType`);
  assertStagedResultStatus(objectValue.status, `${label}.status`);
  assertEpochMs(objectValue.timestamp, `${label}.timestamp`);

  if (objectValue.interruptPayload !== undefined) {
    assertKernelRecord(
      objectValue.interruptPayload,
      `${label}.interruptPayload`
    );
  }

  assertInterruptPayloadConsistency(
    objectValue.status,
    objectValue.interruptPayload,
    `${label}.interruptPayload`
  );
}

export function isStepContext(value: unknown): value is StepContext {
  return tryAssert(value, assertStepContext);
}

export function assertStepContext(
  value: unknown,
  label = "value"
): asserts value is StepContext {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["currentTurnNodeHash", "schema", "signals", "step"],
    label
  );

  assertHashString(
    objectValue.currentTurnNodeHash,
    `${label}.currentTurnNodeHash`
  );
  assertTurnTreeSchema(objectValue.schema, `${label}.schema`);
  assertStepDeclaration(objectValue.step, `${label}.step`);
  assertKernelRecordArray(objectValue.signals, `${label}.signals`);
}

export function isRecoveryState(value: unknown): value is RecoveryState {
  return tryAssert(value, assertRecoveryState);
}

export function assertRecoveryState(
  value: unknown,
  label = "value"
): asserts value is RecoveryState {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    [
      "consumedStagedResults",
      "lastCompletedStepId",
      "lastTurnNodeHash",
      "stepSequence",
      "uncommittedStagedResults",
    ],
    label
  );
  const stepSequence = objectValue.stepSequence;
  const lastCompletedStepId = objectValue.lastCompletedStepId;

  assertHashString(objectValue.lastTurnNodeHash, `${label}.lastTurnNodeHash`);
  assertStagedResultArray(
    objectValue.consumedStagedResults,
    `${label}.consumedStagedResults`
  );
  assertStagedResultArray(
    objectValue.uncommittedStagedResults,
    `${label}.uncommittedStagedResults`
  );
  assertStepDeclarationArray(stepSequence, `${label}.stepSequence`);
  assertNullableString(lastCompletedStepId, `${label}.lastCompletedStepId`);
  assertDisjointStagedResultTaskIds(
    objectValue.consumedStagedResults,
    `${label}.consumedStagedResults`,
    objectValue.uncommittedStagedResults,
    `${label}.uncommittedStagedResults`
  );
  assertRecoveryStateCoherence(
    objectValue.consumedStagedResults,
    lastCompletedStepId,
    `${label}.consumedStagedResults`,
    `${label}.lastCompletedStepId`
  );

  if (lastCompletedStepId === null) {
    return;
  }

  if (!stepSequence.some((step) => step.id === lastCompletedStepId)) {
    throw validationError(
      `${label}.lastCompletedStepId must reference a declared stepSequence id`,
      "invalid_recovery_state_step_id",
      { lastCompletedStepId, stepIds: stepSequence.map((step) => step.id) }
    );
  }
}

export function isThreadCreateResult(
  value: unknown
): value is ThreadCreateResult {
  return tryAssert(value, assertThreadCreateResult);
}

export function assertThreadCreateResult(
  value: unknown,
  label = "value"
): asserts value is ThreadCreateResult {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["branchId", "rootTurnNodeHash", "rootTurnTreeHash", "threadId"],
    label
  );

  assertNonEmptyString(objectValue.threadId, `${label}.threadId`);
  assertNonEmptyString(objectValue.branchId, `${label}.branchId`);
  assertHashString(objectValue.rootTurnNodeHash, `${label}.rootTurnNodeHash`);
  assertHashString(objectValue.rootTurnTreeHash, `${label}.rootTurnTreeHash`);
}

export function isSetHeadResult(value: unknown): value is SetHeadResult {
  return tryAssert(value, assertSetHeadResult);
}

export function assertSetHeadResult(
  value: unknown,
  label = "value"
): asserts value is SetHeadResult {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(objectValue, ["archiveBranch", "branch"], label);

  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "archiveBranch",
    label
  );
  assertBranchRecord(objectValue.branch, `${label}.branch`);

  if (objectValue.archiveBranch !== undefined) {
    assertBranchRecord(objectValue.archiveBranch, `${label}.archiveBranch`);
    assertSetHeadArchiveCoherence(
      objectValue.branch,
      objectValue.archiveBranch,
      `${label}.branch`,
      `${label}.archiveBranch`
    );
  }
}

export function assertStagedResultArray(
  value: unknown,
  label: string
): asserts value is StagedResult[] {
  const results = assertArray(value, label);
  const seenTaskIds = new Set<string>();

  for (const [index, result] of results.entries()) {
    assertStagedResult(result, `${label}[${index}]`);

    if (seenTaskIds.has(result.taskId)) {
      throw validationError(
        `${label} must not contain duplicate staged result taskIds`,
        "duplicate_staged_result_task_id",
        { taskId: result.taskId }
      );
    }

    seenTaskIds.add(result.taskId);
  }
}

export function assertMonotonicTimestamps(
  createdAtMs: number,
  updatedAtMs: number,
  createdAtMsLabel: string,
  updatedAtMsLabel: string
): void {
  if (updatedAtMs < createdAtMs) {
    throw validationError(
      `${updatedAtMsLabel} must be greater than or equal to ${createdAtMsLabel}`,
      "invalid_timestamp_order",
      { createdAtMs, updatedAtMs }
    );
  }
}

function assertStepDeclarationArray(
  value: unknown,
  label: string
): asserts value is StepDeclaration[] {
  const steps = assertArray(value, label);
  const seenIds = new Set<string>();

  for (const [index, step] of steps.entries()) {
    assertStepDeclaration(step, `${label}[${index}]`);

    if (seenIds.has(step.id)) {
      throw validationError(
        `${label} must not contain duplicate step ids`,
        "duplicate_step_id",
        { stepId: step.id }
      );
    }

    seenIds.add(step.id);
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

function assertDisjointStagedResultTaskIds(
  leftResults: StagedResult[],
  leftLabel: string,
  rightResults: StagedResult[],
  rightLabel: string
): void {
  const consumedTaskIds = new Set(leftResults.map(({ taskId }) => taskId));

  for (const result of rightResults) {
    if (consumedTaskIds.has(result.taskId)) {
      throw validationError(
        `${rightLabel} must not repeat taskIds already present in ${leftLabel}`,
        "overlapping_staged_result_task_id",
        { leftLabel, rightLabel, taskId: result.taskId }
      );
    }
  }
}

function assertRecoveryStateCoherence(
  consumedStagedResults: StagedResult[],
  lastCompletedStepId: string | null,
  consumedStagedResultsLabel: string,
  lastCompletedStepIdLabel: string
): void {
  if (lastCompletedStepId === null && consumedStagedResults.length > 0) {
    throw validationError(
      `${lastCompletedStepIdLabel} must name a completed step when ${consumedStagedResultsLabel} is non-empty`,
      "invalid_recovery_state_step_id",
      { consumedCount: consumedStagedResults.length, lastCompletedStepId }
    );
  }
}

function assertSetHeadArchiveCoherence(
  branch: BranchRecord,
  archiveBranch: BranchRecord,
  branchLabel: string,
  archiveBranchLabel: string
): void {
  if (branch.threadId !== archiveBranch.threadId) {
    throw validationError(
      `${archiveBranchLabel}.threadId must match ${branchLabel}.threadId`,
      "invalid_set_head_result",
      {
        archiveThreadId: archiveBranch.threadId,
        branchThreadId: branch.threadId,
      }
    );
  }

  if (branch.branchId === archiveBranch.branchId) {
    throw validationError(
      `${archiveBranchLabel}.branchId must differ from ${branchLabel}.branchId`,
      "invalid_set_head_result",
      { archiveBranchId: archiveBranch.branchId, branchId: branch.branchId }
    );
  }

  if (branch.headTurnNodeHash === archiveBranch.headTurnNodeHash) {
    throw validationError(
      `${archiveBranchLabel}.headTurnNodeHash must differ from ${branchLabel}.headTurnNodeHash`,
      "invalid_set_head_result",
      {
        archiveHeadTurnNodeHash: archiveBranch.headTurnNodeHash,
        branchHeadTurnNodeHash: branch.headTurnNodeHash,
      }
    );
  }
}

function assertInterruptPayloadConsistency(
  status: StagedResultStatus,
  interruptPayload: KernelRecord | undefined,
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
