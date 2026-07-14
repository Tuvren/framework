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
  assertHashString,
  type EpochMs,
  TuvrenPersistenceError,
} from "@tuvren/core";
import type {
  StoredBranch,
  StoredObject,
  StoredObserveAnnotation,
  StoredOrderedPathChunk,
  StoredRun,
  StoredSchema,
  StoredStagedResult,
  StoredThread,
  StoredTurn,
  StoredTurnNode,
  StoredTurnTree,
  StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import type { BackendState } from "./backend-invariant-state.js";

/** Configuration for {@link createBackendInvariantRecordUtils}. */
export interface BackendInvariantRecordUtilsConfig {
  /**
   * The backend-owned error-code prefix (e.g. `"memory"`, `"sqlite"`,
   * `"postgres"`). Every persistence error this module raises is coded
   * `${errorPrefix}_backend_<reason>`, matching each backend's pre-extraction
   * hardcoded literal byte-for-byte when given that backend's own prefix.
   */
  errorPrefix: string;
}

/**
 * The record-utils invariant surface `createBackendInvariantRecordUtils`
 * builds. Declared explicitly (rather than inferred) so downstream
 * declaration emit across the workspace's TS project-reference graph stays
 * portable: an inferred return type here would force every consumer's
 * generated `.d.ts` to describe an anonymous structural type instead of
 * referencing this named one.
 */
export interface BackendInvariantRecordUtils {
  areBytesEqual(left: Uint8Array, right: Uint8Array): boolean;
  areStoredObjectsEqual(left: StoredObject, right: StoredObject): boolean;
  areStoredOrderedPathChunksEqual(
    left: StoredOrderedPathChunk,
    right: StoredOrderedPathChunk
  ): boolean;
  areStoredSchemasEqual(left: StoredSchema, right: StoredSchema): boolean;
  areStoredStagedResultsEqual(
    left: StoredStagedResult,
    right: StoredStagedResult
  ): boolean;
  areStoredThreadsEqual(left: StoredThread, right: StoredThread): boolean;
  areStoredTurnNodesEqual(left: StoredTurnNode, right: StoredTurnNode): boolean;
  areStoredTurnTreePathsEqual(
    left: StoredTurnTreePath,
    right: StoredTurnTreePath
  ): boolean;
  areStoredTurnTreesEqual(left: StoredTurnTree, right: StoredTurnTree): boolean;
  assertImmutableBytes(
    previousValue: Uint8Array,
    nextValue: Uint8Array,
    label: string,
    fieldCode: string
  ): void;
  assertImmutableField<T>(
    previousValue: T,
    nextValue: T,
    label: string,
    fieldCode: string
  ): void;
  assertImmutableOptionalField<T>(
    previousValue: T | undefined,
    nextValue: T | undefined,
    label: string,
    fieldCode: string
  ): void;
  assertRunStatusTransition(
    previousStatus: StoredRun["status"],
    nextStatus: StoredRun["status"]
  ): void;
  cloneBytes(bytes: Uint8Array): Uint8Array;
  cloneStoredBranch(record: StoredBranch): StoredBranch;
  cloneStoredObject(record: StoredObject): StoredObject;
  cloneStoredObserveAnnotation(
    record: StoredObserveAnnotation
  ): StoredObserveAnnotation;
  cloneStoredOrderedPathChunk(
    record: StoredOrderedPathChunk
  ): StoredOrderedPathChunk;
  cloneStoredRun(record: StoredRun): StoredRun;
  cloneStoredSchema(record: StoredSchema): StoredSchema;
  cloneStoredStagedResult(record: StoredStagedResult): StoredStagedResult;
  cloneStoredThread(record: StoredThread): StoredThread;
  cloneStoredTurn(record: StoredTurn): StoredTurn;
  cloneStoredTurnNode(record: StoredTurnNode): StoredTurnNode;
  cloneStoredTurnTree(record: StoredTurnTree): StoredTurnTree;
  cloneStoredTurnTreePath(record: StoredTurnTreePath): StoredTurnTreePath;
  compareByTimestampAndKey(
    leftTimestamp: number,
    rightTimestamp: number,
    leftKey: string,
    rightKey: string
  ): number;
  compareStoredBranch(left: StoredBranch, right: StoredBranch): number;
  compareStoredObserveAnnotation(
    left: StoredObserveAnnotation,
    right: StoredObserveAnnotation
  ): number;
  compareStoredRun(left: StoredRun, right: StoredRun): number;
  compareStoredStagedResult(
    left: StoredStagedResult,
    right: StoredStagedResult
  ): number;
  compareStoredTurn(left: StoredTurn, right: StoredTurn): number;
  ensureBranchExists(
    state: BackendState,
    branchId: string,
    label: string
  ): StoredBranch;
  ensureImmutableRecordMatch<T>(
    existing: T,
    incoming: T,
    areEqual: (left: T, right: T) => boolean,
    label: string
  ): void;
  ensureObjectExists(
    state: BackendState,
    hash: string,
    label: string
  ): StoredObject;
  ensureOrderedPathChunkExists(
    state: BackendState,
    chunkHash: string,
    label: string
  ): StoredOrderedPathChunk;
  ensureRunExists(state: BackendState, runId: string, label: string): StoredRun;
  ensureSchemaRecordExists(
    state: BackendState,
    schemaId: string,
    label: string
  ): StoredSchema;
  ensureThreadExists(
    state: BackendState,
    threadId: string,
    label: string
  ): StoredThread;
  ensureTurnExists(
    state: BackendState,
    turnId: string,
    label: string
  ): StoredTurn;
  ensureTurnNodeExists(
    state: BackendState,
    hash: string,
    label: string
  ): StoredTurnNode;
  ensureTurnTreeExists(
    state: BackendState,
    hash: string,
    label: string
  ): StoredTurnTree;
  isExpiredLeasedRunningRun(run: StoredRun, nowMs: EpochMs): boolean;
  persistenceError(
    message: string,
    errorCode: string,
    details?: unknown
  ): TuvrenPersistenceError;
  putImmutableRecord<T>(
    records: Map<string, T>,
    key: string,
    record: T,
    cloneRecord: (record: T) => T,
    areEqual: (left: T, right: T) => boolean,
    label: string
  ): void;
  validateHashString(hash: string): string;
}

/**
 * Builds the record-utils invariant surface (immutability assertions,
 * existence checks, clone/equality/compare helpers, and the shared
 * persistence-error constructor) shared by the memory, SQLite, and
 * PostgreSQL backends. The only backend-specific behavior is the error-code
 * prefix baked into `${errorPrefix}_backend_<reason>` codes; every other
 * behavior is identical across backends.
 */
export function createBackendInvariantRecordUtils(
  config: BackendInvariantRecordUtilsConfig
): BackendInvariantRecordUtils {
  function code(suffix: string): string {
    return `${config.errorPrefix}_backend_${suffix}`;
  }

  function persistenceError(
    message: string,
    errorCode: string,
    details?: unknown
  ): TuvrenPersistenceError {
    return new TuvrenPersistenceError(message, {
      code: errorCode,
      details,
    });
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
      // A paused run can still fail during resume reconciliation or approval
      // handling; Epic V relies on both local and remote kernels accepting that
      // terminal transition consistently.
      (previousStatus === "paused" && nextStatus === "failed");

    if (!isLegalTransition) {
      throw persistenceError(
        "stored runs must not use illegal status transitions",
        code("run_status_transition_illegal"),
        {
          nextStatus,
          previousStatus,
        }
      );
    }
  }

  function assertImmutableField<T>(
    previousValue: T,
    nextValue: T,
    label: string,
    fieldCode: string
  ): void {
    if (previousValue !== nextValue) {
      throw persistenceError(`${label} must remain immutable`, fieldCode, {
        nextValue,
        previousValue,
      });
    }
  }

  function assertImmutableOptionalField<T>(
    previousValue: T | undefined,
    nextValue: T | undefined,
    label: string,
    fieldCode: string
  ): void {
    if (previousValue !== nextValue) {
      throw persistenceError(`${label} must remain immutable`, fieldCode, {
        nextValue,
        previousValue,
      });
    }
  }

  function assertImmutableBytes(
    previousValue: Uint8Array,
    nextValue: Uint8Array,
    label: string,
    fieldCode: string
  ): void {
    if (!areBytesEqual(previousValue, nextValue)) {
      throw persistenceError(`${label} must remain immutable`, fieldCode, {
        label,
      });
    }
  }

  function validateHashString(hash: string): string {
    assertHashString(hash, "hash");
    return hash;
  }

  function putImmutableRecord<T>(
    records: Map<string, T>,
    key: string,
    record: T,
    cloneRecord: (record: T) => T,
    areEqual: (left: T, right: T) => boolean,
    label: string
  ): void {
    const existing = records.get(key);

    if (existing !== undefined) {
      ensureImmutableRecordMatch(existing, record, areEqual, label);
      return;
    }

    records.set(key, cloneRecord(record));
  }

  function ensureImmutableRecordMatch<T>(
    existing: T,
    incoming: T,
    areEqual: (left: T, right: T) => boolean,
    label: string
  ): void {
    if (!areEqual(existing, incoming)) {
      throw persistenceError(
        `${label} writes must be idempotent for the same identity key`,
        code("immutable_record_conflict"),
        { label }
      );
    }
  }

  function ensureObjectExists(
    state: BackendState,
    hash: string,
    label: string
  ): StoredObject {
    const record = state.objects.get(hash);

    if (record === undefined) {
      throw persistenceError(
        `${label} must reference an existing object`,
        code("missing_object_reference"),
        {
          hash,
          label,
        }
      );
    }

    return record;
  }

  function ensureSchemaRecordExists(
    state: BackendState,
    schemaId: string,
    label: string
  ): StoredSchema {
    const record = state.schemas.get(schemaId);

    if (record === undefined) {
      throw persistenceError(
        `${label} must reference an existing schema`,
        code("missing_schema_reference"),
        {
          label,
          schemaId,
        }
      );
    }

    return record;
  }

  function ensureTurnTreeExists(
    state: BackendState,
    hash: string,
    label: string
  ): StoredTurnTree {
    const record = state.turnTrees.get(hash);

    if (record === undefined) {
      throw persistenceError(
        `${label} must reference an existing turn tree`,
        code("missing_turn_tree_reference"),
        { hash, label }
      );
    }

    return record;
  }

  function ensureOrderedPathChunkExists(
    state: BackendState,
    chunkHash: string,
    label: string
  ): StoredOrderedPathChunk {
    const record = state.orderedPathChunks.get(chunkHash);

    if (record === undefined) {
      throw persistenceError(
        `${label} must reference an existing ordered path chunk`,
        code("missing_ordered_path_chunk_reference"),
        { chunkHash, label }
      );
    }

    return record;
  }

  function ensureTurnNodeExists(
    state: BackendState,
    hash: string,
    label: string
  ): StoredTurnNode {
    const record = state.turnNodes.get(hash);

    if (record === undefined) {
      throw persistenceError(
        `${label} must reference an existing turn node`,
        code("missing_turn_node_reference"),
        { hash, label }
      );
    }

    return record;
  }

  function ensureThreadExists(
    state: BackendState,
    threadId: string,
    label: string
  ): StoredThread {
    const record = state.threads.get(threadId);

    if (record === undefined) {
      throw persistenceError(
        `${label} must reference an existing thread`,
        code("missing_thread_reference"),
        { label, threadId }
      );
    }

    return record;
  }

  function ensureBranchExists(
    state: BackendState,
    branchId: string,
    label: string
  ): StoredBranch {
    const record = state.branches.get(branchId);

    if (record === undefined) {
      throw persistenceError(
        `${label} must reference an existing branch`,
        code("missing_branch_reference"),
        { branchId, label }
      );
    }

    return record;
  }

  function ensureTurnExists(
    state: BackendState,
    turnId: string,
    label: string
  ): StoredTurn {
    const record = state.turns.get(turnId);

    if (record === undefined) {
      throw persistenceError(
        `${label} must reference an existing turn`,
        code("missing_turn_reference"),
        { label, turnId }
      );
    }

    return record;
  }

  function ensureRunExists(
    state: BackendState,
    runId: string,
    label: string
  ): StoredRun {
    const record = state.runs.get(runId);

    if (record === undefined) {
      throw persistenceError(
        `${label} must reference an existing run`,
        code("missing_run_reference"),
        { label, runId }
      );
    }

    return record;
  }

  function cloneStoredObject(record: StoredObject): StoredObject {
    return {
      ...record,
      bytes: cloneBytes(record.bytes),
    };
  }

  function cloneStoredSchema(record: StoredSchema): StoredSchema {
    return {
      ...record,
      schemaCbor: cloneBytes(record.schemaCbor),
    };
  }

  function cloneStoredTurnTree(record: StoredTurnTree): StoredTurnTree {
    return {
      ...record,
      manifestCbor: cloneBytes(record.manifestCbor),
    };
  }

  function cloneStoredOrderedPathChunk(
    record: StoredOrderedPathChunk
  ): StoredOrderedPathChunk {
    return {
      ...record,
      itemsCbor: cloneBytes(record.itemsCbor),
    };
  }

  function cloneStoredTurnNode(record: StoredTurnNode): StoredTurnNode {
    return {
      ...record,
      consumedStagedResultsCbor: cloneBytes(record.consumedStagedResultsCbor),
    };
  }

  function cloneStoredRun(record: StoredRun): StoredRun {
    return {
      ...record,
      createdTurnNodesCbor: cloneBytes(record.createdTurnNodesCbor),
      stepSequenceCbor: cloneBytes(record.stepSequenceCbor),
      ...(record.pendingSignalsCbor === undefined
        ? {}
        : { pendingSignalsCbor: cloneBytes(record.pendingSignalsCbor) }),
    };
  }

  function cloneStoredObserveAnnotation(
    record: StoredObserveAnnotation
  ): StoredObserveAnnotation {
    return {
      ...record,
      annotationCbor: cloneBytes(record.annotationCbor),
    };
  }

  function cloneStoredStagedResult(
    record: StoredStagedResult
  ): StoredStagedResult {
    if (record.status === "interrupted") {
      return {
        ...record,
        interruptPayloadCbor: cloneBytes(record.interruptPayloadCbor),
      };
    }

    return { ...record };
  }

  function cloneStoredThread(record: StoredThread): StoredThread {
    return { ...record };
  }

  function cloneStoredBranch(record: StoredBranch): StoredBranch {
    return { ...record };
  }

  function cloneStoredTurn(record: StoredTurn): StoredTurn {
    return { ...record };
  }

  function cloneStoredTurnTreePath(
    record: StoredTurnTreePath
  ): StoredTurnTreePath {
    if (record.collectionKind === "single") {
      return { ...record };
    }

    if (record.orderedEncoding === "flat") {
      return {
        ...record,
        orderedInlineCbor: cloneBytes(record.orderedInlineCbor),
      };
    }

    return {
      ...record,
      orderedChunkListCbor: cloneBytes(record.orderedChunkListCbor),
    };
  }

  function isExpiredLeasedRunningRun(run: StoredRun, nowMs: EpochMs): boolean {
    return (
      run.status === "running" &&
      run.executionOwnerId !== undefined &&
      run.fencingToken !== undefined &&
      run.leaseExpiresAtMs !== undefined &&
      run.leaseExpiresAtMs <= nowMs
    );
  }

  return {
    areBytesEqual,
    areStoredObjectsEqual,
    areStoredOrderedPathChunksEqual,
    areStoredSchemasEqual,
    areStoredStagedResultsEqual,
    areStoredThreadsEqual,
    areStoredTurnNodesEqual,
    areStoredTurnTreePathsEqual,
    areStoredTurnTreesEqual,
    assertImmutableBytes,
    assertImmutableField,
    assertImmutableOptionalField,
    assertRunStatusTransition,
    cloneBytes,
    cloneStoredBranch,
    cloneStoredObject,
    cloneStoredObserveAnnotation,
    cloneStoredOrderedPathChunk,
    cloneStoredRun,
    cloneStoredSchema,
    cloneStoredStagedResult,
    cloneStoredThread,
    cloneStoredTurn,
    cloneStoredTurnNode,
    cloneStoredTurnTree,
    cloneStoredTurnTreePath,
    compareByTimestampAndKey,
    compareStoredBranch,
    compareStoredObserveAnnotation,
    compareStoredRun,
    compareStoredStagedResult,
    compareStoredTurn,
    ensureBranchExists,
    ensureImmutableRecordMatch,
    ensureObjectExists,
    ensureOrderedPathChunkExists,
    ensureRunExists,
    ensureSchemaRecordExists,
    ensureThreadExists,
    ensureTurnExists,
    ensureTurnNodeExists,
    ensureTurnTreeExists,
    isExpiredLeasedRunningRun,
    persistenceError,
    putImmutableRecord,
    validateHashString,
  };
}

/** Copies a byte array so a caller mutating the result cannot corrupt stored state. */
export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

/**
 * Default administrative expiry horizon (ms) for a leaseless running run with
 * no recent activity — see isExpiredLeaselessRunningRun.
 */
export const LEASELESS_RUN_EXPIRY_MS = 86_400_000; // 24h

/**
 * A leaseless running run (no executionOwnerId/fencingToken/leaseExpiresAtMs
 * at all) whose updatedAtMs has not advanced in at least
 * leaselessRunExpiryMs is treated as abandoned by a crashed/disconnected
 * creator. Unlike isExpiredLeasedRunningRun, this is judged on last-activity
 * time (updatedAtMs), not an explicit expiry field, since a leaseless run has
 * no such field. Only "running" is eligible — a "paused" run is an orderly,
 * intentional state and never auto-expires this way.
 */
export function isExpiredLeaselessRunningRun(
  run: StoredRun,
  nowMs: EpochMs,
  leaselessRunExpiryMs: number = LEASELESS_RUN_EXPIRY_MS
): boolean {
  return (
    run.status === "running" &&
    run.executionOwnerId === undefined &&
    run.fencingToken === undefined &&
    run.leaseExpiresAtMs === undefined &&
    nowMs - run.updatedAtMs >= leaselessRunExpiryMs
  );
}

// Equality helpers below compare a stored record's full field set
// (byte-for-byte for any CBOR payload), letting a backend's
// ensureImmutableRecordMatch tell a legitimate idempotent rewrite of a
// content-addressed record apart from a genuine mutation attempt.

export function areStoredObjectsEqual(
  left: StoredObject,
  right: StoredObject
): boolean {
  return (
    left.hash === right.hash &&
    left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.bytes, right.bytes)
  );
}

export function areStoredSchemasEqual(
  left: StoredSchema,
  right: StoredSchema
): boolean {
  return (
    left.schemaId === right.schemaId &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.schemaCbor, right.schemaCbor)
  );
}

export function areStoredTurnTreesEqual(
  left: StoredTurnTree,
  right: StoredTurnTree
): boolean {
  return (
    left.hash === right.hash &&
    left.schemaId === right.schemaId &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.manifestCbor, right.manifestCbor)
  );
}

export function areStoredOrderedPathChunksEqual(
  left: StoredOrderedPathChunk,
  right: StoredOrderedPathChunk
): boolean {
  return (
    left.chunkHash === right.chunkHash &&
    left.itemCount === right.itemCount &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.itemsCbor, right.itemsCbor)
  );
}

export function areStoredTurnNodesEqual(
  left: StoredTurnNode,
  right: StoredTurnNode
): boolean {
  return (
    left.hash === right.hash &&
    left.previousTurnNodeHash === right.previousTurnNodeHash &&
    left.turnTreeHash === right.turnTreeHash &&
    left.schemaId === right.schemaId &&
    left.eventHash === right.eventHash &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(
      left.consumedStagedResultsCbor,
      right.consumedStagedResultsCbor
    )
  );
}

export function areStoredThreadsEqual(
  left: StoredThread,
  right: StoredThread
): boolean {
  return (
    left.threadId === right.threadId &&
    left.createdAtMs === right.createdAtMs &&
    left.schemaId === right.schemaId &&
    left.rootTurnNodeHash === right.rootTurnNodeHash
  );
}

export function areStoredStagedResultsEqual(
  left: StoredStagedResult,
  right: StoredStagedResult
): boolean {
  if (
    left.runId !== right.runId ||
    left.taskId !== right.taskId ||
    left.objectHash !== right.objectHash ||
    left.objectType !== right.objectType ||
    left.status !== right.status ||
    left.createdAtMs !== right.createdAtMs
  ) {
    return false;
  }

  if (left.status === "interrupted" && right.status === "interrupted") {
    return areBytesEqual(left.interruptPayloadCbor, right.interruptPayloadCbor);
  }

  return left.status !== "interrupted" && right.status !== "interrupted";
}

export function areStoredTurnTreePathsEqual(
  left: StoredTurnTreePath,
  right: StoredTurnTreePath
): boolean {
  if (
    left.turnTreeHash !== right.turnTreeHash ||
    left.path !== right.path ||
    left.collectionKind !== right.collectionKind
  ) {
    return false;
  }

  if (left.collectionKind === "single" && right.collectionKind === "single") {
    return left.singleHash === right.singleHash;
  }

  if (left.collectionKind === "ordered" && right.collectionKind === "ordered") {
    if (
      left.orderedEncoding !== right.orderedEncoding ||
      left.orderedCount !== right.orderedCount
    ) {
      return false;
    }

    if (left.orderedEncoding === "flat" && right.orderedEncoding === "flat") {
      return areBytesEqual(left.orderedInlineCbor, right.orderedInlineCbor);
    }

    if (
      left.orderedEncoding === "chunked" &&
      right.orderedEncoding === "chunked"
    ) {
      return areBytesEqual(
        left.orderedChunkListCbor,
        right.orderedChunkListCbor
      );
    }
  }

  return false;
}

// Comparator helpers below give every listing endpoint a stable,
// deterministic order: primarily by `createdAtMs`, falling back to the
// record's identity key to break ties between same-millisecond writes.

export function compareStoredBranch(
  left: StoredBranch,
  right: StoredBranch
): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.branchId,
    right.branchId
  );
}

export function compareStoredRun(left: StoredRun, right: StoredRun): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.runId,
    right.runId
  );
}

export function compareStoredObserveAnnotation(
  left: StoredObserveAnnotation,
  right: StoredObserveAnnotation
): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.annotationHash,
    right.annotationHash
  );
}

export function compareStoredTurn(left: StoredTurn, right: StoredTurn): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.turnId,
    right.turnId
  );
}

export function compareStoredStagedResult(
  left: StoredStagedResult,
  right: StoredStagedResult
): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.taskId,
    right.taskId
  );
}

/** Shared ordering: `leftTimestamp`/`rightTimestamp` first, then key. */
export function compareByTimestampAndKey(
  leftTimestamp: number,
  rightTimestamp: number,
  leftKey: string,
  rightKey: string
): number {
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  return leftKey.localeCompare(rightKey);
}

/** Byte-for-byte equality of two `Uint8Array`s. */
export function areBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}
