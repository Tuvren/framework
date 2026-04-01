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
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
 * implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { KernelRecord } from "@kraken/shared-core-types";
import {
  assertEpochMs,
  assertHashString,
  assertKernelRecord,
  isEpochMs,
  isHashString,
  KrakenValidationError,
} from "@kraken/shared-core-types";
import type {
  BranchRecord,
  ObserveResult,
  PathCollectionKind,
  PathDefinition,
  PathValue,
  RecoveryState,
  RunCompletionStatus,
  RunRecord,
  RunStatus,
  SetHeadResult,
  StagedResult,
  StagedResultStatus,
  StepContext,
  StepDeclaration,
  StoredBranch,
  StoredObject,
  StoredOrderedPathChunk,
  StoredRun,
  StoredSchema,
  StoredStagedResult,
  StoredThread,
  StoredTurn,
  StoredTurnNode,
  StoredTurnTree,
  StoredTurnTreePath,
  ThreadCreateResult,
  ThreadRecord,
  TurnNode,
  TurnRecord,
  TurnTreeChangeSet,
  TurnTreeManifest,
  TurnTreeSchema,
} from "./kernel-types.js";

const PATH_COLLECTION_KINDS = ["ordered", "single"] as const;
const STAGED_RESULT_STATUSES = ["completed", "failed", "interrupted"] as const;
const RUN_STATUSES = ["running", "paused", "completed", "failed"] as const;
const RUN_COMPLETION_STATUSES = ["paused", "completed", "failed"] as const;
const ORDERED_ENCODINGS = ["flat", "chunked"] as const;

export function isPathCollectionKind(
  value: unknown
): value is PathCollectionKind {
  return isStringLiteral(value, PATH_COLLECTION_KINDS);
}

export function assertPathCollectionKind(
  value: unknown,
  label = "value"
): asserts value is PathCollectionKind {
  if (!isPathCollectionKind(value)) {
    throw validationError(
      `${label} must be "ordered" or "single"`,
      "invalid_path_collection_kind",
      { value }
    );
  }
}

export function isPathValue(value: unknown): value is PathValue {
  return isHashString(value) || value === null || isHashStringArray(value);
}

export function assertPathValue(
  value: unknown,
  label = "value"
): asserts value is PathValue {
  if (!isPathValue(value)) {
    throw validationError(
      `${label} must be a HashString, HashString[], or null`,
      "invalid_path_value",
      { value }
    );
  }
}

export function assertPathValueForCollectionKind(
  value: unknown,
  collectionKind: PathCollectionKind,
  label = "value"
): asserts value is PathValue {
  assertPathCollectionKind(collectionKind, "collectionKind");

  if (collectionKind === "ordered") {
    if (!isHashStringArray(value)) {
      throw validationError(
        `${label} must be a HashString[] for an ordered path`,
        "invalid_path_value_kind",
        { collectionKind, value }
      );
    }

    return;
  }

  if (!(isHashString(value) || value === null)) {
    throw validationError(
      `${label} must be a HashString or null for a single path`,
      "invalid_path_value_kind",
      { collectionKind, value }
    );
  }
}

export function isTurnTreeSchema(value: unknown): value is TurnTreeSchema {
  return tryAssert(value, assertTurnTreeSchema);
}

export function assertTurnTreeSchema(
  value: unknown,
  label = "value"
): asserts value is TurnTreeSchema {
  const objectValue = assertPlainObject(value, label);

  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertPathDefinitions(objectValue.paths, `${label}.paths`);
  assertIncorporationRules(
    objectValue.incorporationRules,
    objectValue.paths,
    `${label}.incorporationRules`
  );
}

export function assertTurnTreeManifest(
  value: unknown,
  label = "value"
): asserts value is TurnTreeManifest {
  assertTurnTreePathMap(value, label);
}

export function assertTurnTreeChangeSet(
  value: unknown,
  label = "value"
): asserts value is TurnTreeChangeSet {
  assertTurnTreePathMap(value, label);
}

export function isStepDeclaration(value: unknown): value is StepDeclaration {
  return tryAssert(value, assertStepDeclaration);
}

export function assertStepDeclaration(
  value: unknown,
  label = "value"
): asserts value is StepDeclaration {
  const objectValue = assertPlainObject(value, label);

  assertNonEmptyString(objectValue.id, `${label}.id`);
  assertBoolean(objectValue.deterministic, `${label}.deterministic`);
  assertBoolean(objectValue.sideEffects, `${label}.sideEffects`);

  if (objectValue.metadata !== undefined) {
    assertKernelRecord(objectValue.metadata, `${label}.metadata`);
  }
}

export function isObserveResult(value: unknown): value is ObserveResult {
  return tryAssert(value, assertObserveResult);
}

export function assertObserveResult(
  value: unknown,
  label = "value"
): asserts value is ObserveResult {
  const objectValue = assertPlainObject(value, label);

  assertHashStringArray(objectValue.annotations, `${label}.annotations`);
  assertKernelRecordArray(objectValue.signals, `${label}.signals`);
}

export function isStagedResultStatus(
  value: unknown
): value is StagedResultStatus {
  return isStringLiteral(value, STAGED_RESULT_STATUSES);
}

export function assertStagedResultStatus(
  value: unknown,
  label = "value"
): asserts value is StagedResultStatus {
  if (!isStagedResultStatus(value)) {
    throw validationError(
      `${label} must be one of ${STAGED_RESULT_STATUSES.join(", ")}`,
      "invalid_staged_result_status",
      { value }
    );
  }
}

export function isRunStatus(value: unknown): value is RunStatus {
  return isStringLiteral(value, RUN_STATUSES);
}

export function assertRunStatus(
  value: unknown,
  label = "value"
): asserts value is RunStatus {
  if (!isRunStatus(value)) {
    throw validationError(
      `${label} must be one of ${RUN_STATUSES.join(", ")}`,
      "invalid_run_status",
      { value }
    );
  }
}

export function isRunCompletionStatus(
  value: unknown
): value is RunCompletionStatus {
  return isStringLiteral(value, RUN_COMPLETION_STATUSES);
}

export function assertRunCompletionStatus(
  value: unknown,
  label = "value"
): asserts value is RunCompletionStatus {
  if (!isRunCompletionStatus(value)) {
    throw validationError(
      `${label} must be one of ${RUN_COMPLETION_STATUSES.join(", ")}`,
      "invalid_run_completion_status",
      { value }
    );
  }
}

export function isTurnNode(value: unknown): value is TurnNode {
  return tryAssert(value, assertTurnNode);
}

export function assertTurnNode(
  value: unknown,
  label = "value"
): asserts value is TurnNode {
  const objectValue = assertPlainObject(value, label);

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

  if (objectValue.createdAtMs !== undefined) {
    assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
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

  assertNonEmptyString(objectValue.threadId, `${label}.threadId`);
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertHashString(objectValue.rootTurnNodeHash, `${label}.rootTurnNodeHash`);

  if (objectValue.createdAtMs !== undefined) {
    assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  }
}

export function isBranchRecord(value: unknown): value is BranchRecord {
  return tryAssert(value, assertBranchRecord);
}

export function assertBranchRecord(
  value: unknown,
  label = "value"
): asserts value is BranchRecord {
  const objectValue = assertPlainObject(value, label);

  assertNonEmptyString(objectValue.branchId, `${label}.branchId`);
  assertNonEmptyString(objectValue.threadId, `${label}.threadId`);
  assertHashString(objectValue.headTurnNodeHash, `${label}.headTurnNodeHash`);

  if (objectValue.archivedFromBranchId !== undefined) {
    assertNonEmptyString(
      objectValue.archivedFromBranchId,
      `${label}.archivedFromBranchId`
    );
  }

  if (objectValue.createdAtMs !== undefined) {
    assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  }

  if (objectValue.updatedAtMs !== undefined) {
    assertEpochMs(objectValue.updatedAtMs, `${label}.updatedAtMs`);
  }
}

export function isTurnRecord(value: unknown): value is TurnRecord {
  return tryAssert(value, assertTurnRecord);
}

export function assertTurnRecord(
  value: unknown,
  label = "value"
): asserts value is TurnRecord {
  const objectValue = assertPlainObject(value, label);

  assertNonEmptyString(objectValue.turnId, `${label}.turnId`);
  assertNonEmptyString(objectValue.threadId, `${label}.threadId`);
  assertNonEmptyString(objectValue.branchId, `${label}.branchId`);
  assertNullableString(objectValue.parentTurnId, `${label}.parentTurnId`);
  assertHashString(objectValue.startTurnNodeHash, `${label}.startTurnNodeHash`);
  assertHashString(objectValue.headTurnNodeHash, `${label}.headTurnNodeHash`);

  if (objectValue.createdAtMs !== undefined) {
    assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  }

  if (objectValue.updatedAtMs !== undefined) {
    assertEpochMs(objectValue.updatedAtMs, `${label}.updatedAtMs`);
  }
}

export function isRunRecord(value: unknown): value is RunRecord {
  return tryAssert(value, assertRunRecord);
}

export function assertRunRecord(
  value: unknown,
  label = "value"
): asserts value is RunRecord {
  const objectValue = assertPlainObject(value, label);
  const currentStepIndex = objectValue.currentStepIndex;
  const stepSequence = objectValue.stepSequence;

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

  if (objectValue.createdAtMs !== undefined) {
    assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  }

  if (objectValue.updatedAtMs !== undefined) {
    assertEpochMs(objectValue.updatedAtMs, `${label}.updatedAtMs`);
  }
}

export function isStepContext(value: unknown): value is StepContext {
  return tryAssert(value, assertStepContext);
}

export function assertStepContext(
  value: unknown,
  label = "value"
): asserts value is StepContext {
  const objectValue = assertPlainObject(value, label);

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

  assertHashString(objectValue.lastTurnNodeHash, `${label}.lastTurnNodeHash`);
  assertStagedResultArray(
    objectValue.consumedStagedResults,
    `${label}.consumedStagedResults`
  );
  assertStagedResultArray(
    objectValue.uncommittedStagedResults,
    `${label}.uncommittedStagedResults`
  );
  assertStepDeclarationArray(objectValue.stepSequence, `${label}.stepSequence`);
  assertNullableString(
    objectValue.lastCompletedStepId,
    `${label}.lastCompletedStepId`
  );
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

  assertBranchRecord(objectValue.branch, `${label}.branch`);

  if (objectValue.archiveBranch !== undefined) {
    assertBranchRecord(objectValue.archiveBranch, `${label}.archiveBranch`);
  }
}

export function isStoredObject(value: unknown): value is StoredObject {
  return tryAssert(value, assertStoredObject);
}

export function assertStoredObject(
  value: unknown,
  label = "value"
): asserts value is StoredObject {
  const objectValue = assertPlainObject(value, label);

  assertHashString(objectValue.hash, `${label}.hash`);
  assertNonEmptyString(objectValue.mediaType, `${label}.mediaType`);
  assertUint8Array(objectValue.bytes, `${label}.bytes`);
  assertNonNegativeInteger(objectValue.byteLength, `${label}.byteLength`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);

  if (objectValue.byteLength !== objectValue.bytes.byteLength) {
    throw validationError(
      `${label}.byteLength must match ${label}.bytes.byteLength`,
      "invalid_stored_object_byte_length",
      {
        actualByteLength: objectValue.bytes.byteLength,
        byteLength: objectValue.byteLength,
      }
    );
  }
}

export function isStoredSchema(value: unknown): value is StoredSchema {
  return tryAssert(value, assertStoredSchema);
}

export function assertStoredSchema(
  value: unknown,
  label = "value"
): asserts value is StoredSchema {
  const objectValue = assertPlainObject(value, label);

  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertUint8Array(objectValue.schemaCbor, `${label}.schemaCbor`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
}

export function isStoredTurnTree(value: unknown): value is StoredTurnTree {
  return tryAssert(value, assertStoredTurnTree);
}

export function assertStoredTurnTree(
  value: unknown,
  label = "value"
): asserts value is StoredTurnTree {
  const objectValue = assertPlainObject(value, label);

  assertHashString(objectValue.hash, `${label}.hash`);
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertUint8Array(objectValue.manifestCbor, `${label}.manifestCbor`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
}

export function isStoredTurnTreePath(
  value: unknown
): value is StoredTurnTreePath {
  return tryAssert(value, assertStoredTurnTreePath);
}

export function assertStoredTurnTreePath(
  value: unknown,
  label = "value"
): asserts value is StoredTurnTreePath {
  const objectValue = assertPlainObject(value, label);
  const turnTreeHash = objectValue.turnTreeHash;
  const path = objectValue.path;
  const collectionKind = objectValue.collectionKind;
  const singleHash = objectValue.singleHash;
  const orderedEncoding = objectValue.orderedEncoding;
  const orderedCount = objectValue.orderedCount;
  const orderedInlineCbor = objectValue.orderedInlineCbor;
  const orderedChunkListCbor = objectValue.orderedChunkListCbor;

  assertHashString(turnTreeHash, `${label}.turnTreeHash`);
  assertNonEmptyString(path, `${label}.path`);
  assertPathCollectionKind(collectionKind, `${label}.collectionKind`);

  if (singleHash !== undefined) {
    assertNullableHashString(singleHash, `${label}.singleHash`);
  }

  if (
    orderedEncoding !== undefined &&
    !isStringLiteral(orderedEncoding, ORDERED_ENCODINGS)
  ) {
    throw validationError(
      `${label}.orderedEncoding must be "flat" or "chunked"`,
      "invalid_ordered_encoding",
      { value: orderedEncoding }
    );
  }

  if (orderedCount !== undefined) {
    assertNonNegativeInteger(orderedCount, `${label}.orderedCount`);
  }

  if (orderedInlineCbor !== undefined) {
    assertUint8Array(orderedInlineCbor, `${label}.orderedInlineCbor`);
  }

  if (orderedChunkListCbor !== undefined) {
    assertUint8Array(orderedChunkListCbor, `${label}.orderedChunkListCbor`);
  }

  assertStoredTurnTreePathShape(
    {
      collectionKind,
      orderedChunkListCbor,
      orderedCount,
      orderedEncoding,
      orderedInlineCbor,
      path,
      singleHash,
      turnTreeHash,
    },
    label
  );
}

function assertStoredTurnTreePathShape(
  value: StoredTurnTreePath,
  label: string
): void {
  if (value.collectionKind === "single") {
    assertStoredSingleTurnTreePathShape(value, label);
    return;
  }

  assertStoredOrderedTurnTreePathShape(value, label);
}

function assertStoredSingleTurnTreePathShape(
  value: StoredTurnTreePath,
  label: string
): void {
  if (
    value.orderedEncoding !== undefined ||
    value.orderedCount !== undefined ||
    value.orderedInlineCbor !== undefined ||
    value.orderedChunkListCbor !== undefined
  ) {
    throw validationError(
      `${label} must not include ordered-path fields when collectionKind is "single"`,
      "invalid_stored_turn_tree_path_shape",
      { collectionKind: value.collectionKind }
    );
  }
}

function assertStoredOrderedTurnTreePathShape(
  value: StoredTurnTreePath,
  label: string
): void {
  if (value.singleHash !== undefined) {
    throw validationError(
      `${label}.singleHash must be omitted when collectionKind is "ordered"`,
      "invalid_stored_turn_tree_path_shape",
      { collectionKind: value.collectionKind }
    );
  }

  if (value.orderedEncoding === undefined) {
    throw validationError(
      `${label}.orderedEncoding is required when collectionKind is "ordered"`,
      "invalid_stored_turn_tree_path_shape",
      { collectionKind: value.collectionKind }
    );
  }

  if (value.orderedCount === undefined) {
    throw validationError(
      `${label}.orderedCount is required when collectionKind is "ordered"`,
      "invalid_stored_turn_tree_path_shape",
      { collectionKind: value.collectionKind }
    );
  }

  if (value.orderedEncoding === "flat") {
    assertStoredFlatTurnTreePathShape(value, label);
    return;
  }

  assertStoredChunkedTurnTreePathShape(value, label);
}

function assertStoredFlatTurnTreePathShape(
  value: StoredTurnTreePath,
  label: string
): void {
  if (value.orderedInlineCbor === undefined) {
    throw validationError(
      `${label}.orderedInlineCbor is required when orderedEncoding is "flat"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }

  if (value.orderedChunkListCbor !== undefined) {
    throw validationError(
      `${label}.orderedChunkListCbor must be omitted when orderedEncoding is "flat"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }
}

function assertStoredChunkedTurnTreePathShape(
  value: StoredTurnTreePath,
  label: string
): void {
  if (value.orderedChunkListCbor === undefined) {
    throw validationError(
      `${label}.orderedChunkListCbor is required when orderedEncoding is "chunked"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }

  if (value.orderedInlineCbor !== undefined) {
    throw validationError(
      `${label}.orderedInlineCbor must be omitted when orderedEncoding is "chunked"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }
}

export function isStoredOrderedPathChunk(
  value: unknown
): value is StoredOrderedPathChunk {
  return tryAssert(value, assertStoredOrderedPathChunk);
}

export function assertStoredOrderedPathChunk(
  value: unknown,
  label = "value"
): asserts value is StoredOrderedPathChunk {
  const objectValue = assertPlainObject(value, label);

  assertHashString(objectValue.chunkHash, `${label}.chunkHash`);
  assertNonNegativeInteger(objectValue.itemCount, `${label}.itemCount`);
  assertUint8Array(objectValue.itemsCbor, `${label}.itemsCbor`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
}

export function isStoredTurnNode(value: unknown): value is StoredTurnNode {
  return tryAssert(value, assertStoredTurnNode);
}

export function assertStoredTurnNode(
  value: unknown,
  label = "value"
): asserts value is StoredTurnNode {
  const objectValue = assertPlainObject(value, label);

  assertHashString(objectValue.hash, `${label}.hash`);
  assertNullableHashString(
    objectValue.previousTurnNodeHash,
    `${label}.previousTurnNodeHash`
  );
  assertHashString(objectValue.turnTreeHash, `${label}.turnTreeHash`);
  assertUint8Array(
    objectValue.consumedStagedResultsCbor,
    `${label}.consumedStagedResultsCbor`
  );
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertNullableHashString(objectValue.eventHash, `${label}.eventHash`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
}

export function isStoredThread(value: unknown): value is StoredThread {
  return tryAssert(value, assertStoredThread);
}

export function assertStoredThread(
  value: unknown,
  label = "value"
): asserts value is StoredThread {
  const objectValue = assertPlainObject(value, label);

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

  assertBranchRecord(objectValue, label);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  assertEpochMs(objectValue.updatedAtMs, `${label}.updatedAtMs`);
}

export function isStoredTurn(value: unknown): value is StoredTurn {
  return tryAssert(value, assertStoredTurn);
}

export function assertStoredTurn(
  value: unknown,
  label = "value"
): asserts value is StoredTurn {
  const objectValue = assertPlainObject(value, label);

  assertTurnRecord(objectValue, label);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  assertEpochMs(objectValue.updatedAtMs, `${label}.updatedAtMs`);
}

export function isStoredRun(value: unknown): value is StoredRun {
  return tryAssert(value, assertStoredRun);
}

export function assertStoredRun(
  value: unknown,
  label = "value"
): asserts value is StoredRun {
  const objectValue = assertPlainObject(value, label);

  assertNonEmptyString(objectValue.runId, `${label}.runId`);
  assertNonEmptyString(objectValue.turnId, `${label}.turnId`);
  assertNonEmptyString(objectValue.branchId, `${label}.branchId`);
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertHashString(objectValue.startTurnNodeHash, `${label}.startTurnNodeHash`);
  assertRunStatus(objectValue.status, `${label}.status`);
  assertNonNegativeInteger(
    objectValue.currentStepIndex,
    `${label}.currentStepIndex`
  );
  assertUint8Array(objectValue.stepSequenceCbor, `${label}.stepSequenceCbor`);
  assertUint8Array(
    objectValue.createdTurnNodesCbor,
    `${label}.createdTurnNodesCbor`
  );
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  assertEpochMs(objectValue.updatedAtMs, `${label}.updatedAtMs`);
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

  assertNonEmptyString(objectValue.runId, `${label}.runId`);
  assertNonEmptyString(objectValue.taskId, `${label}.taskId`);
  assertHashString(objectValue.objectHash, `${label}.objectHash`);
  assertNonEmptyString(objectValue.objectType, `${label}.objectType`);
  assertStagedResultStatus(objectValue.status, `${label}.status`);

  if (objectValue.interruptPayloadCbor !== undefined) {
    assertUint8Array(
      objectValue.interruptPayloadCbor,
      `${label}.interruptPayloadCbor`
    );
  }

  assertInterruptPayloadConsistency(
    objectValue.status,
    objectValue.interruptPayloadCbor,
    `${label}.interruptPayloadCbor`
  );

  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
}

export function isStagedResult(value: unknown): value is StagedResult {
  return tryAssert(value, assertStagedResult);
}

export function assertStagedResult(
  value: unknown,
  label = "value"
): asserts value is StagedResult {
  const objectValue = assertPlainObject(value, label);

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

function assertTurnTreePathMap(
  value: unknown,
  label: string
): asserts value is Record<string, PathValue> {
  const objectValue = assertPlainObject(value, label);

  for (const [path, pathValue] of Object.entries(objectValue)) {
    assertNonEmptyString(path, `${label} path`);
    assertPathValue(pathValue, `${label}.${path}`);
  }
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

function assertPathDefinitions(
  value: unknown,
  label: string
): asserts value is PathDefinition[] {
  const definitions = assertArray(value, label);
  const seenPaths = new Set<string>();

  for (const [index, definition] of definitions.entries()) {
    const definitionLabel = `${label}[${index}]`;
    const objectValue = assertPlainObject(definition, definitionLabel);

    assertNonEmptyString(objectValue.path, `${definitionLabel}.path`);
    assertPathCollectionKind(
      objectValue.collection,
      `${definitionLabel}.collection`
    );

    if (objectValue.metadata !== undefined) {
      assertKernelRecord(objectValue.metadata, `${definitionLabel}.metadata`);
    }

    if (seenPaths.has(objectValue.path)) {
      throw validationError(
        `${label} must not contain duplicate schema paths`,
        "duplicate_schema_path",
        { path: objectValue.path }
      );
    }

    seenPaths.add(objectValue.path);
  }
}

function assertIncorporationRules(
  value: unknown,
  pathDefinitions: PathDefinition[],
  label: string
): void {
  const rules = assertArray(value, label);
  const seenObjectTypes = new Set<string>();
  const knownPaths = new Set(pathDefinitions.map(({ path }) => path));

  for (const [index, rule] of rules.entries()) {
    const ruleLabel = `${label}[${index}]`;
    const objectValue = assertPlainObject(rule, ruleLabel);

    assertNonEmptyString(objectValue.objectType, `${ruleLabel}.objectType`);
    assertNonEmptyString(objectValue.targetPath, `${ruleLabel}.targetPath`);

    if (!knownPaths.has(objectValue.targetPath)) {
      throw validationError(
        `${ruleLabel}.targetPath must reference a defined schema path`,
        "unknown_incorporation_target_path",
        { targetPath: objectValue.targetPath }
      );
    }

    if (seenObjectTypes.has(objectValue.objectType)) {
      throw validationError(
        `${label} must not contain duplicate objectType mappings`,
        "duplicate_incorporation_object_type",
        { objectType: objectValue.objectType }
      );
    }

    seenObjectTypes.add(objectValue.objectType);
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

function assertStagedResultArray(
  value: unknown,
  label: string
): asserts value is StagedResult[] {
  const results = assertArray(value, label);

  for (const [index, result] of results.entries()) {
    assertStagedResult(result, `${label}[${index}]`);
  }
}

function assertKernelRecordArray(
  value: unknown,
  label: string
): asserts value is KernelRecord[] {
  const items = assertArray(value, label);

  for (const [index, item] of items.entries()) {
    assertKernelRecord(item, `${label}[${index}]`);
  }
}

function assertHashStringArray(
  value: unknown,
  label: string
): asserts value is string[] {
  const items = assertArray(value, label);

  for (const [index, item] of items.entries()) {
    assertHashString(item, `${label}[${index}]`);
  }
}

function isHashStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    if (key === "length") {
      continue;
    }

    const descriptor = descriptors[key];
    const index = Number(key);

    if (
      !(
        descriptor?.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < value.length &&
        String(index) === key
      ) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      return false;
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!(Object.hasOwn(value, index) && isHashString(value[index]))) {
      return false;
    }
  }

  return true;
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw validationError(`${label} must be an array`, "invalid_array", {
      value,
    });
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw validationError(
      `${label} must be a dense data-only array`,
      "invalid_array",
      {
        value,
      }
    );
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    if (key === "length") {
      continue;
    }

    const descriptor = descriptors[key];
    const index = Number(key);

    if (
      !(
        descriptor?.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < value.length &&
        String(index) === key
      ) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      throw validationError(
        `${label} must be a dense data-only array`,
        "invalid_array",
        { value }
      );
    }
  }

  return value;
}

function assertPlainObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(`${label} must be a plain object`, "invalid_object", {
      value,
    });
  }

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    throw validationError(`${label} must be a plain object`, "invalid_object", {
      value,
    });
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw validationError(`${label} must be a plain object`, "invalid_object", {
      value,
    });
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    const descriptor = descriptors[key];

    if (
      !(descriptor?.enumerable && Object.hasOwn(descriptor, "value")) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      throw validationError(
        `${label} must be a plain object`,
        "invalid_object",
        { value }
      );
    }
  }

  return value as Record<string, unknown>;
}

function assertNonEmptyString(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw validationError(
      `${label} must be a non-empty string`,
      "invalid_string",
      { value }
    );
  }
}

function assertBoolean(
  value: unknown,
  label: string
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw validationError(`${label} must be a boolean`, "invalid_boolean", {
      value,
    });
  }
}

function assertNullableHashString(
  value: unknown,
  label: string
): asserts value is string | null {
  if (value !== null) {
    assertHashString(value, label);
  }
}

function assertNullableString(
  value: unknown,
  label: string
): asserts value is string | null {
  if (value !== null) {
    assertNonEmptyString(value, label);
  }
}

function assertUint8Array(
  value: unknown,
  label: string
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw validationError(
      `${label} must be a Uint8Array`,
      "invalid_uint8_array",
      { value }
    );
  }
}

function assertNonNegativeInteger(
  value: unknown,
  label: string
): asserts value is number {
  if (!isEpochMs(value)) {
    throw validationError(
      `${label} must be a non-negative safe integer`,
      "invalid_integer",
      { value }
    );
  }

  const integerValue: number = value;

  if (integerValue < 0) {
    throw validationError(
      `${label} must be a non-negative safe integer`,
      "invalid_integer",
      { value: integerValue }
    );
  }
}

function isStringLiteral<const T extends readonly string[]>(
  value: unknown,
  literals: T
): value is T[number] {
  return typeof value === "string" && literals.includes(value);
}

function tryAssert<T>(
  value: unknown,
  assertion: (value: unknown, label?: string) => asserts value is T
): value is T {
  try {
    assertion(value);
    return true;
  } catch {
    return false;
  }
}

function validationError(
  message: string,
  code: string,
  details?: unknown
): KrakenValidationError {
  return new KrakenValidationError(message, {
    code,
    details,
  });
}
