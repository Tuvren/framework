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

import type { KernelObject, KernelRecord } from "@tuvren/core-types";
import {
  assertEpochMs as assertSharedEpochMs,
  assertHashString as assertSharedHashString,
  assertKernelRecord as assertSharedKernelRecord,
  isEpochMs,
  isHashString,
  TuvrenValidationError,
} from "@tuvren/core-types";
import {
  decodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  hashTurnTreeIdentity,
} from "./kernel-identity.js";
import type {
  BranchHeadListEntry,
  BranchRecord,
  ComposedVerdict,
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
  Verdict,
  VerdictDisposition,
} from "./kernel-types.js";

const PATH_COLLECTION_KINDS = ["ordered", "single"] as const;
const STAGED_RESULT_STATUSES = ["completed", "failed", "interrupted"] as const;
const RUN_STATUSES = ["running", "paused", "completed", "failed"] as const;
const RUN_COMPLETION_STATUSES = ["paused", "completed", "failed"] as const;
const ORDERED_ENCODINGS = ["flat", "chunked"] as const;
const VERDICT_DISPOSITIONS = ["HardFail", "SoftFail", "EndTurn"] as const;

interface StoredTurnTreePathCandidate {
  collectionKind: PathCollectionKind;
  orderedChunkListCbor?: Uint8Array;
  orderedCount?: number;
  orderedEncoding?: "flat" | "chunked";
  orderedInlineCbor?: Uint8Array;
  path: string;
  singleHash?: string | null;
  turnTreeHash: string;
}

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
  assertAllowedObjectKeys(
    objectValue,
    ["incorporationRules", "paths", "schemaId"],
    label
  );

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
  label?: string
): asserts value is TurnTreeManifest;
export function assertTurnTreeManifest(
  value: unknown,
  schema: TurnTreeSchema,
  label?: string
): asserts value is TurnTreeManifest;
export function assertTurnTreeManifest(
  value: unknown,
  schemaOrLabel?: string | TurnTreeSchema,
  label = "value"
): asserts value is TurnTreeManifest {
  const { schema, resolvedLabel } = resolveSchemaAndLabel(
    schemaOrLabel,
    label,
    "schema"
  );
  const manifest = assertTurnTreePathMap(value, resolvedLabel);

  if (schema !== undefined) {
    assertTurnTreePathMapMatchesSchema(manifest, schema, resolvedLabel, true);
  }
}

export function assertTurnTreeChangeSet(
  value: unknown,
  schema: TurnTreeSchema,
  label = "value"
): asserts value is TurnTreeChangeSet {
  assertTurnTreeSchema(schema, "schema");
  const changeSet = assertTurnTreePathMap(value, label);
  assertTurnTreePathMapMatchesSchema(changeSet, schema, label, false);
}

export function isStepDeclaration(value: unknown): value is StepDeclaration {
  return tryAssert(value, assertStepDeclaration);
}

export function assertStepDeclaration(
  value: unknown,
  label = "value"
): asserts value is StepDeclaration {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["deterministic", "id", "metadata", "sideEffects"],
    label
  );

  assertOptionalFieldIsOmittedWhenUndefined(objectValue, "metadata", label);
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
  assertAllowedObjectKeys(objectValue, ["annotations", "signals"], label);

  assertKernelObjectArray(objectValue.annotations, `${label}.annotations`);
  assertKernelRecordArray(objectValue.signals, `${label}.signals`);
}

export function isVerdictDisposition(
  value: unknown
): value is VerdictDisposition {
  return isStringLiteral(value, VERDICT_DISPOSITIONS);
}

export function assertVerdictDisposition(
  value: unknown,
  label = "value"
): asserts value is VerdictDisposition {
  if (!isVerdictDisposition(value)) {
    throw validationError(
      `${label} must be one of ${VERDICT_DISPOSITIONS.join(", ")}`,
      "invalid_verdict_disposition",
      { value }
    );
  }
}

export function isVerdict(value: unknown): value is Verdict {
  return tryAssert(value, assertVerdict);
}

export function assertVerdict(
  value: unknown,
  label = "value"
): asserts value is Verdict {
  const objectValue = assertPlainObject(value, label);
  const kind = objectValue.kind;

  if (kind === "proceed") {
    assertProceedVerdict(objectValue, label);
    return;
  }

  if (kind === "abort") {
    assertAbortVerdict(objectValue, label);
    return;
  }

  if (kind === "modify") {
    assertModifyVerdict(objectValue, label);
    return;
  }

  if (kind === "pause") {
    assertPauseVerdict(objectValue, label);
    return;
  }

  if (kind === "retry") {
    assertRetryVerdict(objectValue, label);
    return;
  }

  throw validationError(
    `${label}.kind must be one of proceed, abort, modify, pause, retry`,
    "invalid_verdict_kind",
    { value: kind }
  );
}

export function isComposedVerdict(value: unknown): value is ComposedVerdict {
  return tryAssert(value, assertComposedVerdict);
}

export function assertComposedVerdict(
  value: unknown,
  label = "value"
): asserts value is ComposedVerdict {
  assertVerdict(value, label);
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

export function isStoredObject(value: unknown): value is StoredObject {
  return tryAssert(value, assertStoredObject);
}

export function assertStoredObject(
  value: unknown,
  label = "value"
): asserts value is StoredObject {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["byteLength", "bytes", "createdAtMs", "hash", "mediaType"],
    label
  );

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

export async function assertStoredObjectIdentity(
  value: unknown,
  label = "value"
): Promise<void> {
  assertStoredObject(value, label);

  const expectedHash = await hashOpaqueObjectBytes(value.bytes);

  if (value.hash !== expectedHash) {
    throw validationError(
      `${label}.hash must match the SHA-256 digest of ${label}.bytes`,
      "invalid_stored_object_hash",
      {
        expectedHash,
        hash: value.hash,
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
  assertAllowedObjectKeys(
    objectValue,
    ["createdAtMs", "schemaCbor", "schemaId"],
    label
  );
  const schemaCbor = objectValue.schemaCbor;
  const schemaId = objectValue.schemaId;

  assertNonEmptyString(schemaId, `${label}.schemaId`);
  assertUint8Array(schemaCbor, `${label}.schemaCbor`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  const decodedSchema = assertDecodedKernelRecord(
    schemaCbor,
    assertTurnTreeSchema,
    `${label}.schemaCbor`
  );

  if (decodedSchema.schemaId !== schemaId) {
    throw validationError(
      `${label}.schemaId must match the decoded schemaId in ${label}.schemaCbor`,
      "invalid_stored_schema_id",
      {
        decodedSchemaId: decodedSchema.schemaId,
        schemaId,
      }
    );
  }
}

export function isStoredTurnTree(value: unknown): value is StoredTurnTree {
  return tryAssert(
    value,
    (candidate, label = "value"): asserts candidate is StoredTurnTree => {
      assertStoredTurnTreeShape(candidate, label);
    }
  );
}

export function assertStoredTurnTree(
  value: unknown,
  schema: TurnTreeSchema,
  label?: string
): asserts value is StoredTurnTree;
export function assertStoredTurnTree(
  value: unknown,
  schema: TurnTreeSchema,
  label = "value"
): asserts value is StoredTurnTree {
  assertTurnTreeSchema(schema, "schema");
  const resolvedLabel = label;
  const objectValue = assertStoredTurnTreeShape(value, resolvedLabel);
  assertAllowedObjectKeys(
    objectValue,
    ["createdAtMs", "hash", "manifestCbor", "schemaId"],
    resolvedLabel
  );
  const manifestCbor = objectValue.manifestCbor;

  if (schema.schemaId !== objectValue.schemaId) {
    throw validationError(
      `${resolvedLabel}.schemaId must match schema.schemaId`,
      "invalid_stored_turn_tree_schema_id",
      {
        expectedSchemaId: schema.schemaId,
        schemaId: objectValue.schemaId,
      }
    );
  }

  assertDecodedKernelRecord(
    manifestCbor,
    (
      decodedValue: unknown,
      manifestLabel: string
    ): asserts decodedValue is TurnTreeManifest => {
      assertTurnTreeManifest(decodedValue, schema, manifestLabel);
    },
    `${resolvedLabel}.manifestCbor`
  );
}

export async function assertStoredTurnTreeIdentity(
  value: unknown,
  schema: TurnTreeSchema,
  label?: string
): Promise<void>;
export async function assertStoredTurnTreeIdentity(
  value: unknown,
  schema: TurnTreeSchema,
  label = "value"
): Promise<void> {
  assertTurnTreeSchema(schema, "schema");
  const resolvedLabel = label;
  assertStoredTurnTree(value, schema, resolvedLabel);

  const manifest = assertDecodedKernelRecord<TurnTreeManifest>(
    value.manifestCbor,
    (decodedValue, manifestLabel) =>
      assertTurnTreeManifest(decodedValue, schema, manifestLabel),
    `${resolvedLabel}.manifestCbor`
  );
  const expectedHash = await hashTurnTreeIdentity(
    value.schemaId,
    manifest,
    schema
  );

  if (value.hash !== expectedHash) {
    throw validationError(
      `${resolvedLabel}.hash must match the deterministic hash of ${resolvedLabel}.schemaId and ${resolvedLabel}.manifestCbor`,
      "invalid_stored_turn_tree_hash",
      {
        expectedHash,
        hash: value.hash,
      }
    );
  }
}

export function isStoredTurnTreePath(
  value: unknown
): value is StoredTurnTreePath {
  return tryAssert(value, assertStoredTurnTreePath);
}

export function assertStoredTurnTreePath(
  value: unknown,
  label?: string
): asserts value is StoredTurnTreePath;
export function assertStoredTurnTreePath(
  value: unknown,
  schema: TurnTreeSchema,
  label?: string
): asserts value is StoredTurnTreePath;
export function assertStoredTurnTreePath(
  value: unknown,
  schemaOrLabel?: string | TurnTreeSchema,
  label = "value"
): asserts value is StoredTurnTreePath {
  const { schema, resolvedLabel } = resolveSchemaAndLabel(
    schemaOrLabel,
    label,
    "schema"
  );
  const objectValue = assertPlainObject(value, resolvedLabel);
  assertAllowedObjectKeys(
    objectValue,
    [
      "collectionKind",
      "orderedChunkListCbor",
      "orderedCount",
      "orderedEncoding",
      "orderedInlineCbor",
      "path",
      "singleHash",
      "turnTreeHash",
    ],
    resolvedLabel
  );
  const turnTreeHash = objectValue.turnTreeHash;
  const path = objectValue.path;
  const collectionKind = objectValue.collectionKind;
  const singleHash = objectValue.singleHash;
  const orderedEncoding = objectValue.orderedEncoding;
  const orderedCount = objectValue.orderedCount;
  const orderedInlineCbor = objectValue.orderedInlineCbor;
  const orderedChunkListCbor = objectValue.orderedChunkListCbor;

  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "singleHash",
    resolvedLabel
  );
  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "orderedEncoding",
    resolvedLabel
  );
  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "orderedCount",
    resolvedLabel
  );
  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "orderedInlineCbor",
    resolvedLabel
  );
  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "orderedChunkListCbor",
    resolvedLabel
  );
  assertHashString(turnTreeHash, `${resolvedLabel}.turnTreeHash`);
  assertSchemaPath(path, `${resolvedLabel}.path`);
  assertPathCollectionKind(collectionKind, `${resolvedLabel}.collectionKind`);

  if (singleHash !== undefined) {
    assertNullableHashString(singleHash, `${resolvedLabel}.singleHash`);
  }

  if (
    orderedEncoding !== undefined &&
    !isStringLiteral(orderedEncoding, ORDERED_ENCODINGS)
  ) {
    throw validationError(
      `${resolvedLabel}.orderedEncoding must be "flat" or "chunked"`,
      "invalid_ordered_encoding",
      { value: orderedEncoding }
    );
  }

  if (orderedCount !== undefined) {
    assertNonNegativeInteger(orderedCount, `${resolvedLabel}.orderedCount`);
  }

  if (orderedInlineCbor !== undefined) {
    assertUint8Array(orderedInlineCbor, `${resolvedLabel}.orderedInlineCbor`);
  }

  if (orderedChunkListCbor !== undefined) {
    assertUint8Array(
      orderedChunkListCbor,
      `${resolvedLabel}.orderedChunkListCbor`
    );
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
    resolvedLabel
  );

  if (schema !== undefined) {
    assertStoredTurnTreePathMatchesSchema(
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
      schema,
      resolvedLabel
    );
  }
}

function assertStoredTurnTreePathShape(
  value: StoredTurnTreePathCandidate,
  label: string
): void {
  if (value.collectionKind === "single") {
    assertStoredSingleTurnTreePathShape(value, label);
    return;
  }

  assertStoredOrderedTurnTreePathShape(value, label);
}

function assertStoredSingleTurnTreePathShape(
  value: StoredTurnTreePathCandidate,
  label: string
): void {
  if (value.singleHash === undefined) {
    throw validationError(
      `${label}.singleHash is required when collectionKind is "single"`,
      "invalid_stored_turn_tree_path_shape",
      { collectionKind: value.collectionKind }
    );
  }

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
  value: StoredTurnTreePathCandidate,
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
  value: StoredTurnTreePathCandidate,
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

  const orderedCount = value.orderedCount;

  if (orderedCount === undefined) {
    throw validationError(
      `${label}.orderedCount is required when orderedEncoding is "flat"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }

  assertDecodedHashStringArrayCardinality(
    value.orderedInlineCbor,
    orderedCount,
    `${label}.orderedInlineCbor`,
    `${label}.orderedCount`
  );
}

function assertStoredChunkedTurnTreePathShape(
  value: StoredTurnTreePathCandidate,
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

  const chunkHashes = assertDecodedHashStringArray(
    value.orderedChunkListCbor,
    `${label}.orderedChunkListCbor`
  );
  const orderedCount = value.orderedCount;

  if (orderedCount === undefined) {
    throw validationError(
      `${label}.orderedCount is required when orderedEncoding is "chunked"`,
      "invalid_stored_turn_tree_path_shape",
      { orderedEncoding: value.orderedEncoding }
    );
  }

  if (orderedCount === 0 && chunkHashes.length !== 0) {
    throw validationError(
      `${label}.orderedChunkListCbor must be empty when ${label}.orderedCount is 0`,
      "invalid_stored_turn_tree_path_shape",
      { chunkCount: chunkHashes.length, orderedCount }
    );
  }

  if (orderedCount === 0) {
    throw validationError(
      `${label} must use flat ordered storage when ${label}.orderedCount is 0`,
      "invalid_stored_turn_tree_path_shape",
      { orderedCount }
    );
  }

  if (orderedCount > 0 && chunkHashes.length === 0) {
    throw validationError(
      `${label}.orderedChunkListCbor must contain at least one chunk when ${label}.orderedCount is positive`,
      "invalid_stored_turn_tree_path_shape",
      { chunkCount: chunkHashes.length, orderedCount }
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
  assertAllowedObjectKeys(
    objectValue,
    ["chunkHash", "createdAtMs", "itemCount", "itemsCbor"],
    label
  );

  assertHashString(objectValue.chunkHash, `${label}.chunkHash`);
  assertNonNegativeInteger(objectValue.itemCount, `${label}.itemCount`);
  assertUint8Array(objectValue.itemsCbor, `${label}.itemsCbor`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);
  assertDecodedHashStringArrayCardinality(
    objectValue.itemsCbor,
    objectValue.itemCount,
    `${label}.itemsCbor`,
    `${label}.itemCount`
  );
}

export async function assertStoredOrderedPathChunkIdentity(
  value: unknown,
  label = "value"
): Promise<void> {
  assertStoredOrderedPathChunk(value, label);

  const items = assertDecodedHashStringArray(
    value.itemsCbor,
    `${label}.itemsCbor`
  );
  const expectedHash = await hashKernelRecord(items);

  if (value.chunkHash !== expectedHash) {
    throw validationError(
      `${label}.chunkHash must match the deterministic hash of ${label}.itemsCbor`,
      "invalid_stored_ordered_path_chunk_hash",
      {
        expectedHash,
        hash: value.chunkHash,
      }
    );
  }
}

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

  assertNonEmptyString(objectValue.runId, `${label}.runId`);
  assertNonEmptyString(objectValue.turnId, `${label}.turnId`);
  assertNonEmptyString(objectValue.branchId, `${label}.branchId`);
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertHashString(objectValue.startTurnNodeHash, `${label}.startTurnNodeHash`);
  assertRunStatus(objectValue.status, `${label}.status`);
  assertNonNegativeInteger(currentStepIndex, `${label}.currentStepIndex`);
  assertUint8Array(stepSequenceCbor, `${label}.stepSequenceCbor`);
  assertUint8Array(createdTurnNodesCbor, `${label}.createdTurnNodesCbor`);
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

function assertTurnTreePathMap(
  value: unknown,
  label: string
): Record<string, PathValue> {
  const objectValue = assertPlainObject(value, label);
  const validatedPathMap: Record<string, PathValue> = Object.create(null);

  for (const [path, pathValue] of Object.entries(objectValue)) {
    assertSchemaPath(path, `${label} path`);
    assertPathValue(pathValue, `${label}.${path}`);
    validatedPathMap[path] = pathValue;
  }

  return validatedPathMap;
}

function assertTurnTreePathMapMatchesSchema(
  value: Record<string, PathValue>,
  schema: TurnTreeSchema,
  label: string,
  requireFullManifest: boolean
): void {
  const pathDefinitions = new Map(
    schema.paths.map((definition) => [definition.path, definition.collection])
  );

  if (requireFullManifest) {
    for (const pathDefinition of schema.paths) {
      if (!Object.hasOwn(value, pathDefinition.path)) {
        throw validationError(
          `${label}.${pathDefinition.path} must be present in a full TurnTree manifest`,
          "missing_turn_tree_path",
          { path: pathDefinition.path, schemaId: schema.schemaId }
        );
      }
    }
  }

  for (const [path, pathValue] of Object.entries(value)) {
    const collectionKind = pathDefinitions.get(path);

    if (collectionKind === undefined) {
      throw validationError(
        `${label}.${path} must reference a schema-defined path`,
        "unknown_turn_tree_path",
        { path, schemaId: schema.schemaId }
      );
    }

    assertPathValueForCollectionKind(
      pathValue,
      collectionKind,
      `${label}.${path}`
    );
  }
}

function assertProceedVerdict(
  value: Record<string, unknown>,
  label: string
): void {
  assertAllowedObjectKeys(value, ["kind"], label);

  if (value.kind !== "proceed") {
    throw validationError(
      `${label}.kind must be "proceed"`,
      "invalid_verdict_kind",
      { value: value.kind }
    );
  }
}

function assertAbortVerdict(
  value: Record<string, unknown>,
  label: string
): void {
  assertAllowedObjectKeys(value, ["disposition", "kind", "reason"], label);

  if (value.kind !== "abort") {
    throw validationError(
      `${label}.kind must be "abort"`,
      "invalid_verdict_kind",
      { value: value.kind }
    );
  }

  assertVerdictDisposition(value.disposition, `${label}.disposition`);
  assertNonEmptyString(value.reason, `${label}.reason`);
}

function assertModifyVerdict(
  value: Record<string, unknown>,
  label: string
): void {
  assertAllowedObjectKeys(value, ["kind", "transform"], label);

  if (value.kind !== "modify") {
    throw validationError(
      `${label}.kind must be "modify"`,
      "invalid_verdict_kind",
      { value: value.kind }
    );
  }

  assertKernelRecord(value.transform, `${label}.transform`);
}

function assertPauseVerdict(
  value: Record<string, unknown>,
  label: string
): void {
  assertAllowedObjectKeys(value, ["kind", "reason", "resumptionSchema"], label);

  if (value.kind !== "pause") {
    throw validationError(
      `${label}.kind must be "pause"`,
      "invalid_verdict_kind",
      { value: value.kind }
    );
  }

  assertNonEmptyString(value.reason, `${label}.reason`);
  assertKernelRecord(value.resumptionSchema, `${label}.resumptionSchema`);
}

function assertRetryVerdict(
  value: Record<string, unknown>,
  label: string
): void {
  assertAllowedObjectKeys(value, ["adjustment", "kind"], label);

  if (value.kind !== "retry") {
    throw validationError(
      `${label}.kind must be "retry"`,
      "invalid_verdict_kind",
      { value: value.kind }
    );
  }

  assertKernelRecord(value.adjustment, `${label}.adjustment`);
}

function assertStoredTurnTreePathMatchesSchema(
  value: StoredTurnTreePathCandidate,
  schema: TurnTreeSchema,
  label: string
): void {
  const pathDefinition = schema.paths.find(
    (definition) => definition.path === value.path
  );

  if (pathDefinition === undefined) {
    throw validationError(
      `${label}.path must reference a schema-defined path`,
      "unknown_turn_tree_path",
      { path: value.path, schemaId: schema.schemaId }
    );
  }

  if (pathDefinition.collection !== value.collectionKind) {
    throw validationError(
      `${label}.collectionKind must match the schema collection for ${label}.path`,
      "invalid_turn_tree_path_collection_kind",
      {
        collectionKind: value.collectionKind,
        expectedCollectionKind: pathDefinition.collection,
        path: value.path,
      }
    );
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
    assertAllowedObjectKeys(
      objectValue,
      ["collection", "metadata", "path"],
      definitionLabel
    );

    assertSchemaPath(objectValue.path, `${definitionLabel}.path`);
    assertPathCollectionKind(
      objectValue.collection,
      `${definitionLabel}.collection`
    );

    assertOptionalFieldIsOmittedWhenUndefined(
      objectValue,
      "metadata",
      definitionLabel
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

function assertSchemaPath(
  value: unknown,
  label: string
): asserts value is string {
  assertNonEmptyString(value, label);

  const segments = value.split(".");

  if (segments.some((segment) => segment.length === 0)) {
    throw validationError(
      `${label} must be a dot-separated path with non-empty segments`,
      "invalid_schema_path",
      { value }
    );
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
    assertAllowedObjectKeys(
      objectValue,
      ["objectType", "targetPath"],
      ruleLabel
    );

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

  if (currentStepIndex >= stepCount) {
    throw validationError(
      `${currentStepIndexLabel} must reference an available step when ${statusLabel} is "running"`,
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

function assertStagedResultArray(
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

function assertMonotonicTimestamps(
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

function assertKernelRecordArray(
  value: unknown,
  label: string
): asserts value is KernelRecord[] {
  const items = assertArray(value, label);

  for (const [index, item] of items.entries()) {
    assertKernelRecord(item, `${label}[${index}]`);
  }
}

function assertKernelObjectArray(
  value: unknown,
  label: string
): asserts value is KernelObject[] {
  const items = assertArray(value, label);

  for (const [index, item] of items.entries()) {
    assertKernelObject(item, `${label}[${index}]`);
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

function assertKernelObject(
  value: unknown,
  label: string
): asserts value is KernelObject {
  assertPlainObject(value, label);
  assertKernelRecord(value, label);
}

function assertDecodedHashStringArray(
  value: Uint8Array,
  label: string
): string[] {
  return assertDecodedKernelRecord(value, assertHashStringArray, label);
}

function assertDecodedKernelRecord<T>(
  value: Uint8Array,
  assertion: (value: unknown, label: string) => asserts value is T,
  label: string
): T {
  let decodedValue: KernelRecord;

  try {
    decodedValue = decodeDeterministicKernelRecord(value);
  } catch (error: unknown) {
    throw validationError(
      `${label} must contain canonical deterministic CBOR`,
      "invalid_cbor_payload",
      {
        cause:
          error instanceof Error
            ? error.message
            : "unknown CBOR decode failure",
      }
    );
  }

  assertion(decodedValue, label);

  return decodedValue;
}

function assertDecodedHashStringArrayCardinality(
  value: Uint8Array,
  expectedCount: number,
  payloadLabel: string,
  countLabel: string
): void {
  const decodedItems = assertDecodedHashStringArray(value, payloadLabel);

  if (decodedItems.length !== expectedCount) {
    throw validationError(
      `${countLabel} must match the decoded item count in ${payloadLabel}`,
      "invalid_cbor_item_count",
      { actualCount: decodedItems.length, expectedCount }
    );
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

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
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

  const normalizedObject: Record<string, unknown> = Object.create(null);

  for (const [entryKey, entryValue] of Object.entries(value)) {
    normalizedObject[entryKey] = entryValue;
  }

  return normalizedObject;
}

function assertAllowedObjectKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string
): void {
  const allowedKeySet = new Set(allowedKeys);

  for (const key of Object.keys(value)) {
    if (!allowedKeySet.has(key)) {
      throw validationError(
        `${label}.${key} is not part of the contract shape`,
        "invalid_object_key",
        { allowedKeys, key }
      );
    }
  }
}

function resolveSchemaAndLabel(
  schemaOrLabel: string | TurnTreeSchema | undefined,
  label: string,
  schemaLabel: string
): {
  resolvedLabel: string;
  schema?: TurnTreeSchema;
} {
  if (schemaOrLabel === undefined) {
    return { resolvedLabel: label };
  }

  if (typeof schemaOrLabel === "string") {
    return { resolvedLabel: schemaOrLabel };
  }

  assertTurnTreeSchema(schemaOrLabel, schemaLabel);
  return {
    resolvedLabel: label,
    schema: schemaOrLabel,
  };
}

function assertStoredTurnTreeShape(
  value: unknown,
  label: string
): {
  createdAtMs: unknown;
  hash: unknown;
  manifestCbor: Uint8Array;
  schemaId: unknown;
} {
  const objectValue = assertPlainObject(value, label);

  assertAllowedObjectKeys(
    objectValue,
    ["createdAtMs", "hash", "manifestCbor", "schemaId"],
    label
  );
  assertHashString(objectValue.hash, `${label}.hash`);
  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertUint8Array(objectValue.manifestCbor, `${label}.manifestCbor`);
  assertEpochMs(objectValue.createdAtMs, `${label}.createdAtMs`);

  return {
    createdAtMs: objectValue.createdAtMs,
    hash: objectValue.hash,
    manifestCbor: objectValue.manifestCbor,
    schemaId: objectValue.schemaId,
  };
}

function assertOptionalFieldIsOmittedWhenUndefined(
  value: Record<string, unknown>,
  key: string,
  label: string
): void {
  if (Object.hasOwn(value, key) && value[key] === undefined) {
    throw validationError(
      `${label}.${key} must be omitted instead of undefined`,
      "invalid_optional_field",
      { key }
    );
  }
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

function assertHashString(
  value: unknown,
  label: string
): asserts value is string {
  try {
    assertSharedHashString(value, label);
  } catch (error: unknown) {
    throw validationError(
      error instanceof Error
        ? error.message
        : `${label} must be a lowercase 64-character SHA-256 hex digest`,
      "invalid_hash_string",
      { value }
    );
  }
}

function assertEpochMs(value: unknown, label: string): asserts value is number {
  try {
    assertSharedEpochMs(value, label);
  } catch (error: unknown) {
    throw validationError(
      error instanceof Error
        ? error.message
        : `${label} must be a non-negative safe integer epoch milliseconds value`,
      "invalid_epoch_ms",
      { value }
    );
  }
}

function assertKernelRecord(
  value: unknown,
  label = "value"
): asserts value is KernelRecord {
  try {
    assertSharedKernelRecord(value, label);
  } catch (error: unknown) {
    throw validationError(
      error instanceof Error
        ? error.message
        : `${label} must match the restricted Kraken kernel record profile`,
      "invalid_kernel_record",
      { value }
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
): TuvrenValidationError {
  return new TuvrenValidationError(message, {
    code,
    details,
  });
}
