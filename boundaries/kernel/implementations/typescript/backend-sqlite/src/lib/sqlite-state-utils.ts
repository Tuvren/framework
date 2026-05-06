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
import type Database from "better-sqlite3";
import { persistenceError } from "./sqlite-errors.js";
import {
  type BackendState,
  cloneBytes,
  cloneEncodedBytes,
} from "./sqlite-records.js";

export function ensureObjectExists(
  state: BackendState,
  hash: string,
  label: string
): StoredObject {
  const record = state.objects.get(hash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing object`,
      "sqlite_backend_missing_object_reference",
      { hash, label }
    );
  }

  return record;
}

export function ensureSchemaRecordExists(
  state: BackendState,
  schemaId: string,
  label: string
): StoredSchema {
  const record = state.schemas.get(schemaId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing schema`,
      "sqlite_backend_missing_schema_reference",
      { label, schemaId }
    );
  }

  return record;
}

export function ensureTurnTreeExists(
  state: BackendState,
  hash: string,
  label: string
): StoredTurnTree {
  const record = state.turnTrees.get(hash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing turn tree`,
      "sqlite_backend_missing_turn_tree_reference",
      { hash, label }
    );
  }

  return record;
}

export function ensureOrderedPathChunkExists(
  state: BackendState,
  chunkHash: string,
  label: string
): StoredOrderedPathChunk {
  const record = state.orderedPathChunks.get(chunkHash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing ordered path chunk`,
      "sqlite_backend_missing_ordered_path_chunk_reference",
      { chunkHash, label }
    );
  }

  return record;
}

export function ensureTurnNodeExists(
  state: BackendState,
  hash: string,
  label: string
): StoredTurnNode {
  const record = state.turnNodes.get(hash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing turn node`,
      "sqlite_backend_missing_turn_node_reference",
      { hash, label }
    );
  }

  return record;
}

export function ensureThreadExists(
  state: BackendState,
  threadId: string,
  label: string
): StoredThread {
  const record = state.threads.get(threadId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing thread`,
      "sqlite_backend_missing_thread_reference",
      { label, threadId }
    );
  }

  return record;
}

export function ensureBranchExists(
  state: BackendState,
  branchId: string,
  label: string
): StoredBranch {
  const record = state.branches.get(branchId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing branch`,
      "sqlite_backend_missing_branch_reference",
      { branchId, label }
    );
  }

  return record;
}

export function ensureTurnExists(
  state: BackendState,
  turnId: string,
  label: string
): StoredTurn {
  const record = state.turns.get(turnId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing turn`,
      "sqlite_backend_missing_turn_reference",
      { label, turnId }
    );
  }

  return record;
}

export function ensureRunExists(
  state: BackendState,
  runId: string,
  label: string
): StoredRun {
  const record = state.runs.get(runId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing run`,
      "sqlite_backend_missing_run_reference",
      { label, runId }
    );
  }

  return record;
}

export function cloneStoredObject(record: StoredObject): StoredObject {
  return {
    ...record,
    bytes: cloneBytes(record.bytes),
  };
}

export function cloneStoredSchema(record: StoredSchema): StoredSchema {
  return {
    ...record,
    schemaCbor: cloneEncodedBytes(record.schemaCbor),
  };
}

export function cloneStoredTurnTree(record: StoredTurnTree): StoredTurnTree {
  return {
    ...record,
    manifestCbor: cloneEncodedBytes(record.manifestCbor),
  };
}

export function cloneStoredOrderedPathChunk(
  record: StoredOrderedPathChunk
): StoredOrderedPathChunk {
  return {
    ...record,
    itemsCbor: cloneEncodedBytes(record.itemsCbor),
  };
}

export function cloneStoredTurnNode(record: StoredTurnNode): StoredTurnNode {
  return {
    ...record,
    consumedStagedResultsCbor: cloneEncodedBytes(
      record.consumedStagedResultsCbor
    ),
  };
}

export function cloneStoredRun(record: StoredRun): StoredRun {
  return {
    ...record,
    createdTurnNodesCbor: cloneEncodedBytes(record.createdTurnNodesCbor),
    stepSequenceCbor: cloneEncodedBytes(record.stepSequenceCbor),
    ...(record.pendingSignalsCbor === undefined
      ? {}
      : {
          pendingSignalsCbor: cloneEncodedBytes(record.pendingSignalsCbor),
        }),
  };
}

export function cloneStoredObserveAnnotation(
  record: StoredObserveAnnotation
): StoredObserveAnnotation {
  return {
    ...record,
    annotationCbor: cloneEncodedBytes(record.annotationCbor),
  };
}

export function cloneStoredStagedResult(
  record: StoredStagedResult
): StoredStagedResult {
  if (record.status === "interrupted") {
    return {
      ...record,
      interruptPayloadCbor: cloneEncodedBytes(record.interruptPayloadCbor),
    };
  }

  return { ...record };
}

export function cloneStoredThread(record: StoredThread): StoredThread {
  return { ...record };
}

export function cloneStoredBranch(record: StoredBranch): StoredBranch {
  return { ...record };
}

export function cloneStoredTurn(record: StoredTurn): StoredTurn {
  return { ...record };
}

export function keyObserveAnnotation(record: StoredObserveAnnotation): string {
  return [
    record.runId,
    String(record.createdAtMs),
    record.annotationHash,
    record.turnNodeHash ?? "",
  ].join("\0");
}

export function nextObserveAnnotationRecordKey(
  db: Database.Database,
  record: StoredObserveAnnotation
): string {
  const identityKey = keyObserveAnnotation(record);
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM observe_annotations
        WHERE run_id = ?
          AND created_at_ms = ?
          AND annotation_hash = ?
          AND (
            (turn_node_hash IS NULL AND ? IS NULL) OR
            turn_node_hash = ?
          )
      `
    )
    .get(
      record.runId,
      record.createdAtMs,
      record.annotationHash,
      record.turnNodeHash,
      record.turnNodeHash
    ) as { count: number };

  return `${identityKey}\0${row.count}`;
}

export function cloneStoredTurnTreePath(
  record: StoredTurnTreePath
): StoredTurnTreePath {
  if (record.collectionKind === "single") {
    return { ...record };
  }

  if (record.orderedEncoding === "flat") {
    return {
      ...record,
      orderedInlineCbor: cloneEncodedBytes(record.orderedInlineCbor),
    };
  }

  return {
    ...record,
    orderedChunkListCbor: cloneEncodedBytes(record.orderedChunkListCbor),
  };
}

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
    keyObserveAnnotation(left),
    keyObserveAnnotation(right)
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

function compareByTimestampAndKey(
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
