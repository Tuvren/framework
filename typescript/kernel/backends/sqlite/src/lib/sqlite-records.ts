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
  assertStoredBranch,
  assertStoredObject,
  assertStoredObserveAnnotation,
  assertStoredRun,
  assertStoredSchema,
  assertStoredStagedResult,
  assertStoredThread,
  assertStoredTurn,
  assertStoredTurnNode,
  assertTurnTreeSchema,
  decodeDeterministicKernelRecord,
  type StoredBranch,
  type StoredObject,
  type StoredObserveAnnotation,
  type StoredOrderedPathChunk,
  type StoredRun,
  type StoredSchema,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
  type StoredTurnNode,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import type Database from "better-sqlite3";
import { persistenceError } from "./sqlite-errors.js";

export interface BackendState {
  branches: Map<string, StoredBranch>;
  objects: Map<string, StoredObject>;
  observeAnnotations: Map<string, StoredObserveAnnotation[]>;
  orderedPathChunks: Map<string, StoredOrderedPathChunk>;
  runs: Map<string, StoredRun>;
  schemas: Map<string, StoredSchema>;
  stagedResults: Map<string, Map<string, StoredStagedResult>>;
  threads: Map<string, StoredThread>;
  turnNodes: Map<string, StoredTurnNode>;
  turns: Map<string, StoredTurn>;
  turnTreePaths: Map<string, Map<string, StoredTurnTreePath>>;
  turnTrees: Map<string, StoredTurnTree>;
}

export interface TurnNodeLineageMetadata {
  depth: number;
  rootTurnNodeHash: string;
  turnNodeHash: string;
}

export interface SqliteObjectRow {
  byte_length: number;
  bytes: Uint8Array;
  created_at_ms: number;
  hash: string;
  media_type: string;
}

export interface SqliteSchemaRow {
  created_at_ms: number;
  schema_cbor: Uint8Array;
  schema_id: string;
}

export interface SqliteTurnTreeRow {
  created_at_ms: number;
  hash: string;
  manifest_cbor: Uint8Array;
  schema_id: string;
}

export interface SqliteTurnTreePathRow {
  collection_kind: "ordered" | "single";
  ordered_chunk_list_cbor: Uint8Array | null;
  ordered_count: number | null;
  ordered_encoding: "chunked" | "flat" | null;
  ordered_inline_cbor: Uint8Array | null;
  path: string;
  single_hash: string | null;
  turn_tree_hash: string;
}

export interface SqliteOrderedPathChunkRow {
  chunk_hash: string;
  created_at_ms: number;
  item_count: number;
  items_cbor: Uint8Array;
}

export interface SqliteTurnNodeRow {
  consumed_staged_results_cbor: Uint8Array;
  created_at_ms: number;
  event_hash: string | null;
  hash: string;
  previous_turn_node_hash: string | null;
  schema_id: string;
  turn_tree_hash: string;
}

export interface SqliteTurnNodeLineageRootRow {
  depth: number;
  root_turn_node_hash: string;
  turn_node_hash: string;
}

export interface SqliteTurnNodeLineageProofRow {
  depth: number;
  hash: string;
  previous_turn_node_hash: string | null;
}

export interface SqliteThreadRow {
  created_at_ms: number;
  root_turn_node_hash: string;
  schema_id: string;
  thread_id: string;
}

export interface SqliteBranchRow {
  archived_from_branch_id: string | null;
  branch_id: string;
  created_at_ms: number;
  head_turn_node_hash: string;
  thread_id: string;
  updated_at_ms: number;
}

export interface SqliteTurnRow {
  branch_id: string;
  created_at_ms: number;
  head_turn_node_hash: string;
  parent_turn_id: string | null;
  start_turn_node_hash: string;
  thread_id: string;
  turn_id: string;
  updated_at_ms: number;
}

export interface SqliteRunRow {
  branch_id: string;
  created_at_ms: number;
  created_turn_nodes_cbor: Uint8Array;
  current_step_index: number;
  execution_owner_id: string | null;
  fencing_token: string | null;
  last_step_annotations_cbor: Uint8Array | null;
  lease_expires_at_ms: number | null;
  pending_signals_cbor: Uint8Array | null;
  preemption_reason: string | null;
  run_id: string;
  schema_id: string;
  start_turn_node_hash: string;
  status: StoredRun["status"];
  step_sequence_cbor: Uint8Array;
  turn_id: string;
  updated_at_ms: number;
}

export interface SqliteObserveAnnotationRow {
  annotation_cbor: Uint8Array;
  annotation_hash: string;
  created_at_ms: number;
  record_key: string;
  run_id: string;
  turn_node_hash: string | null;
}

export interface SqliteStagedResultRow {
  created_at_ms: number;
  interrupt_payload_cbor: Uint8Array | null;
  object_hash: string;
  object_type: string;
  run_id: string;
  status: StoredStagedResult["status"];
  task_id: string;
}

export function createEmptyState(): BackendState {
  return {
    branches: new Map(),
    observeAnnotations: new Map(),
    objects: new Map(),
    orderedPathChunks: new Map(),
    runs: new Map(),
    schemas: new Map(),
    stagedResults: new Map(),
    threads: new Map(),
    turnNodes: new Map(),
    turnTreePaths: new Map(),
    turnTrees: new Map(),
    turns: new Map(),
  };
}

export function loadState(db: Database.Database): BackendState {
  const state = createEmptyState();

  for (const row of db
    .prepare("SELECT * FROM objects")
    .all() as SqliteObjectRow[]) {
    const record = decodeObjectRow(row);
    setUniqueLoadedRecord(state.objects, record.hash, record, "object", {
      hash: record.hash,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM schemas")
    .all() as SqliteSchemaRow[]) {
    const record = decodeSchemaRow(row);
    setUniqueLoadedRecord(state.schemas, record.schemaId, record, "schema", {
      schemaId: record.schemaId,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM turn_trees")
    .all() as SqliteTurnTreeRow[]) {
    const record = decodeTurnTreeRow(row);
    setUniqueLoadedRecord(state.turnTrees, record.hash, record, "turn tree", {
      hash: record.hash,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM ordered_path_chunks")
    .all() as SqliteOrderedPathChunkRow[]) {
    const record = decodeOrderedPathChunkRow(row);
    setUniqueLoadedRecord(
      state.orderedPathChunks,
      record.chunkHash,
      record,
      "ordered path chunk",
      { chunkHash: record.chunkHash }
    );
  }

  for (const row of db
    .prepare("SELECT * FROM turn_tree_paths")
    .all() as SqliteTurnTreePathRow[]) {
    const record = decodeTurnTreePathRow(row);
    const treePaths =
      state.turnTreePaths.get(record.turnTreeHash) ??
      new Map<string, StoredTurnTreePath>();
    setUniqueLoadedRecord(treePaths, record.path, record, "turn tree path", {
      path: record.path,
      turnTreeHash: record.turnTreeHash,
    });
    state.turnTreePaths.set(record.turnTreeHash, treePaths);
  }

  for (const row of db
    .prepare("SELECT * FROM turn_nodes")
    .all() as SqliteTurnNodeRow[]) {
    const record = decodeTurnNodeRow(row);
    setUniqueLoadedRecord(state.turnNodes, record.hash, record, "turn node", {
      hash: record.hash,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM threads")
    .all() as SqliteThreadRow[]) {
    const record = decodeThreadRow(row);
    setUniqueLoadedRecord(state.threads, record.threadId, record, "thread", {
      threadId: record.threadId,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM branches")
    .all() as SqliteBranchRow[]) {
    const record = decodeBranchRow(row);
    setUniqueLoadedRecord(state.branches, record.branchId, record, "branch", {
      branchId: record.branchId,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM turns")
    .all() as SqliteTurnRow[]) {
    const record = decodeTurnRow(row);
    setUniqueLoadedRecord(state.turns, record.turnId, record, "turn", {
      turnId: record.turnId,
    });
  }

  for (const row of db.prepare("SELECT * FROM runs").all() as SqliteRunRow[]) {
    const record = decodeRunRow(row);
    setUniqueLoadedRecord(state.runs, record.runId, record, "run", {
      runId: record.runId,
    });
  }

  for (const row of db
    .prepare("SELECT * FROM observe_annotations")
    .all() as SqliteObserveAnnotationRow[]) {
    const record = decodeObserveAnnotationRow(row);
    const records = state.observeAnnotations.get(record.runId) ?? [];
    records.push(record);
    state.observeAnnotations.set(record.runId, records);
  }

  for (const row of db
    .prepare("SELECT * FROM staged_results")
    .all() as SqliteStagedResultRow[]) {
    const record = decodeStagedResultRow(row);
    const stagedResults =
      state.stagedResults.get(record.runId) ??
      new Map<string, StoredStagedResult>();
    setUniqueLoadedRecord(
      stagedResults,
      record.taskId,
      record,
      "staged result",
      { runId: record.runId, taskId: record.taskId }
    );
    state.stagedResults.set(record.runId, stagedResults);
  }

  return state;
}

export function decodeObjectRow(row: SqliteObjectRow): StoredObject {
  const record: StoredObject = {
    byteLength: row.byte_length,
    bytes: cloneBytes(toUint8Array(row.bytes)),
    createdAtMs: row.created_at_ms,
    hash: row.hash,
    mediaType: row.media_type,
  };
  assertStoredObject(record, "stored object row");
  return record;
}

export function decodeSchemaRow(row: SqliteSchemaRow): StoredSchema {
  const record: StoredSchema = {
    createdAtMs: row.created_at_ms,
    schemaCbor: cloneEncodedBytes(toUint8Array(row.schema_cbor)),
    schemaId: row.schema_id,
  };
  assertStoredSchema(record, "stored schema row");
  return record;
}

export function decodeTurnTreeRow(row: SqliteTurnTreeRow): StoredTurnTree {
  return {
    createdAtMs: row.created_at_ms,
    hash: row.hash,
    manifestCbor: cloneEncodedBytes(toUint8Array(row.manifest_cbor)),
    schemaId: row.schema_id,
  };
}

export function decodeTurnTreePathRow(
  row: SqliteTurnTreePathRow
): StoredTurnTreePath {
  if (row.collection_kind === "single") {
    return {
      collectionKind: "single",
      path: row.path,
      singleHash: row.single_hash,
      turnTreeHash: row.turn_tree_hash,
    };
  }

  if (row.collection_kind !== "ordered") {
    throw persistenceError(
      "stored turn tree path rows must decode to a valid ordered or single variant",
      "sqlite_backend_invalid_turn_tree_path_row",
      { path: row.path, turnTreeHash: row.turn_tree_hash }
    );
  }

  const orderedCount = decodeStoredNonNegativeInteger(
    row.ordered_count,
    "ordered_count",
    "sqlite_backend_invalid_turn_tree_path_row",
    { path: row.path, turnTreeHash: row.turn_tree_hash }
  );

  if (row.ordered_encoding === "flat" && row.ordered_inline_cbor !== null) {
    return {
      collectionKind: "ordered",
      orderedCount,
      orderedEncoding: "flat",
      orderedInlineCbor: cloneEncodedBytes(
        toUint8Array(row.ordered_inline_cbor)
      ),
      path: row.path,
      turnTreeHash: row.turn_tree_hash,
    };
  }

  if (
    row.ordered_encoding === "chunked" &&
    row.ordered_chunk_list_cbor !== null
  ) {
    return {
      collectionKind: "ordered",
      orderedChunkListCbor: cloneEncodedBytes(
        toUint8Array(row.ordered_chunk_list_cbor)
      ),
      orderedCount,
      orderedEncoding: "chunked",
      path: row.path,
      turnTreeHash: row.turn_tree_hash,
    };
  }

  throw persistenceError(
    "stored turn tree path rows must decode to a valid ordered or single variant",
    "sqlite_backend_invalid_turn_tree_path_row",
    { path: row.path, turnTreeHash: row.turn_tree_hash }
  );
}

export function decodeOrderedPathChunkRow(
  row: SqliteOrderedPathChunkRow
): StoredOrderedPathChunk {
  const itemsCbor = cloneEncodedBytes(toUint8Array(row.items_cbor));
  const itemHashes = decodeHashStringArray(itemsCbor, "chunk.itemsCbor");
  const itemCount = decodeStoredNonNegativeInteger(
    row.item_count,
    "item_count",
    "sqlite_backend_invalid_ordered_path_chunk_row",
    { chunkHash: row.chunk_hash }
  );

  if (itemCount !== itemHashes.length) {
    throw persistenceError(
      "stored ordered path chunk rows must keep item_count aligned with items_cbor",
      "sqlite_backend_ordered_path_chunk_item_count_mismatch",
      {
        chunkHash: row.chunk_hash,
        decodedCount: itemHashes.length,
        itemCount,
      }
    );
  }

  return {
    chunkHash: row.chunk_hash,
    createdAtMs: row.created_at_ms,
    itemCount,
    itemsCbor,
  };
}

export function decodeTurnNodeRow(row: SqliteTurnNodeRow): StoredTurnNode {
  const record: StoredTurnNode = {
    consumedStagedResultsCbor: cloneEncodedBytes(
      toUint8Array(row.consumed_staged_results_cbor)
    ),
    createdAtMs: row.created_at_ms,
    eventHash: row.event_hash,
    hash: row.hash,
    previousTurnNodeHash: row.previous_turn_node_hash,
    schemaId: row.schema_id,
    turnTreeHash: row.turn_tree_hash,
  };
  assertStoredTurnNode(record, "stored turn node row");
  return record;
}

export function decodeTurnNodeLineageMetadataRow(
  row: SqliteTurnNodeLineageRootRow
): TurnNodeLineageMetadata {
  assertHashString(row.turn_node_hash, "turn_node_hash");
  assertHashString(row.root_turn_node_hash, "root_turn_node_hash");
  const depth = decodeStoredNonNegativeInteger(
    row.depth,
    "depth",
    "sqlite_backend_invalid_turn_node_lineage_metadata_row",
    {
      rootTurnNodeHash: row.root_turn_node_hash,
      turnNodeHash: row.turn_node_hash,
    }
  );

  return {
    depth,
    rootTurnNodeHash: row.root_turn_node_hash,
    turnNodeHash: row.turn_node_hash,
  };
}

export function decodeThreadRow(row: SqliteThreadRow): StoredThread {
  const record: StoredThread = {
    createdAtMs: row.created_at_ms,
    rootTurnNodeHash: row.root_turn_node_hash,
    schemaId: row.schema_id,
    threadId: row.thread_id,
  };
  assertStoredThread(record, "stored thread row");
  return record;
}

export function decodeBranchRow(row: SqliteBranchRow): StoredBranch {
  const record: StoredBranch = {
    ...(row.archived_from_branch_id === null
      ? {}
      : { archivedFromBranchId: row.archived_from_branch_id }),
    branchId: row.branch_id,
    createdAtMs: row.created_at_ms,
    headTurnNodeHash: row.head_turn_node_hash,
    threadId: row.thread_id,
    updatedAtMs: row.updated_at_ms,
  };
  assertStoredBranch(record, "stored branch row");
  return record;
}

export function decodeTurnRow(row: SqliteTurnRow): StoredTurn {
  const record: StoredTurn = {
    branchId: row.branch_id,
    createdAtMs: row.created_at_ms,
    headTurnNodeHash: row.head_turn_node_hash,
    parentTurnId: row.parent_turn_id,
    startTurnNodeHash: row.start_turn_node_hash,
    threadId: row.thread_id,
    turnId: row.turn_id,
    updatedAtMs: row.updated_at_ms,
  };
  assertStoredTurn(record, "stored turn row");
  return record;
}

export function decodeObserveAnnotationRow(
  row: SqliteObserveAnnotationRow
): StoredObserveAnnotation {
  const record: StoredObserveAnnotation = {
    annotationCbor: cloneEncodedBytes(toUint8Array(row.annotation_cbor)),
    annotationHash: row.annotation_hash,
    createdAtMs: row.created_at_ms,
    runId: row.run_id,
    turnNodeHash: row.turn_node_hash,
  };
  assertStoredObserveAnnotation(record, "stored observe annotation row");
  return record;
}

export function decodeUnknownTurnRow(row: unknown): StoredTurn {
  const label = "stored turn query row";

  if (!isUnknownRecord(row)) {
    throw persistenceError(
      `${label} must be an object`,
      "sqlite_backend_invalid_turn_row",
      {}
    );
  }

  return decodeTurnRow({
    branch_id: readSqliteStringColumn(row, "branch_id", label),
    created_at_ms: readSqliteNumberColumn(row, "created_at_ms", label),
    head_turn_node_hash: readSqliteStringColumn(
      row,
      "head_turn_node_hash",
      label
    ),
    parent_turn_id: readSqliteNullableStringColumn(
      row,
      "parent_turn_id",
      label
    ),
    start_turn_node_hash: readSqliteStringColumn(
      row,
      "start_turn_node_hash",
      label
    ),
    thread_id: readSqliteStringColumn(row, "thread_id", label),
    turn_id: readSqliteStringColumn(row, "turn_id", label),
    updated_at_ms: readSqliteNumberColumn(row, "updated_at_ms", label),
  });
}

export function decodeRunRow(row: SqliteRunRow): StoredRun {
  const status = decodeStoredRunStatus(row.status, row.run_id);

  const record: StoredRun = {
    branchId: row.branch_id,
    createdAtMs: row.created_at_ms,
    createdTurnNodesCbor: cloneEncodedBytes(
      toUint8Array(row.created_turn_nodes_cbor)
    ),
    currentStepIndex: row.current_step_index,
    ...(row.execution_owner_id === null
      ? {}
      : {
          executionOwnerId: row.execution_owner_id,
        }),
    ...(row.fencing_token === null
      ? {}
      : {
          fencingToken: row.fencing_token,
        }),
    ...(row.lease_expires_at_ms === null
      ? {}
      : {
          leaseExpiresAtMs: row.lease_expires_at_ms,
        }),
    runId: row.run_id,
    schemaId: row.schema_id,
    startTurnNodeHash: row.start_turn_node_hash,
    status,
    stepSequenceCbor: cloneEncodedBytes(toUint8Array(row.step_sequence_cbor)),
    turnId: row.turn_id,
    updatedAtMs: row.updated_at_ms,
    ...(row.pending_signals_cbor === null
      ? {}
      : {
          pendingSignalsCbor: cloneEncodedBytes(
            toUint8Array(row.pending_signals_cbor)
          ),
        }),
    ...(row.preemption_reason === null
      ? {}
      : {
          preemptionReason: row.preemption_reason,
        }),
  };
  assertStoredRun(record, "stored run row");
  return record;
}

export function decodeStagedResultRow(
  row: SqliteStagedResultRow
): StoredStagedResult {
  if (row.status === "interrupted") {
    if (row.interrupt_payload_cbor === null) {
      throw persistenceError(
        "stored staged result rows with interrupted status must include interrupt_payload_cbor",
        "sqlite_backend_invalid_staged_result_row",
        { runId: row.run_id, status: row.status, taskId: row.task_id }
      );
    }

    const record: StoredStagedResult = {
      createdAtMs: row.created_at_ms,
      interruptPayloadCbor: cloneEncodedBytes(
        toUint8Array(row.interrupt_payload_cbor)
      ),
      objectHash: row.object_hash,
      objectType: row.object_type,
      runId: row.run_id,
      status: "interrupted",
      taskId: row.task_id,
    };
    assertStoredStagedResult(record, "stored staged result row");
    return record;
  }

  if (row.interrupt_payload_cbor !== null) {
    throw persistenceError(
      "stored staged result rows may only include interrupt_payload_cbor for interrupted status",
      "sqlite_backend_invalid_staged_result_row",
      { runId: row.run_id, status: row.status, taskId: row.task_id }
    );
  }

  if (row.status !== "completed" && row.status !== "failed") {
    throw persistenceError(
      "stored staged result rows must decode to a valid staged result status",
      "sqlite_backend_invalid_staged_result_row",
      { runId: row.run_id, status: row.status, taskId: row.task_id }
    );
  }

  const record: StoredStagedResult = {
    createdAtMs: row.created_at_ms,
    objectHash: row.object_hash,
    objectType: row.object_type,
    runId: row.run_id,
    status: row.status,
    taskId: row.task_id,
  };
  assertStoredStagedResult(record, "stored staged result row");
  return record;
}

export function decodeTurnTreeSchema(
  bytes: Uint8Array,
  label: string
): TurnTreeSchema {
  const decodedValue = decodeDeterministicKernelRecord(bytes);
  assertTurnTreeSchema(decodedValue, label);
  return decodedValue;
}

export function decodeHashStringArray(
  bytes: Uint8Array,
  label: string
): string[] {
  const decodedValue = decodeDeterministicKernelRecord(bytes);

  if (!Array.isArray(decodedValue)) {
    throw persistenceError(
      `${label} must decode to a HashString[]`,
      "sqlite_backend_invalid_hash_array_payload",
      { label }
    );
  }

  const hashes: string[] = [];

  for (const [index, item] of decodedValue.entries()) {
    assertHashString(item, `${label}[${index}]`);
    hashes.push(item);
  }

  return hashes;
}

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

export function cloneEncodedBytes(bytes: Uint8Array): Uint8Array {
  const cloned = Uint8Array.from(bytes);
  Reflect.set(
    cloned,
    "dataView",
    new DataView(cloned.buffer, cloned.byteOffset, cloned.byteLength)
  );
  return cloned;
}

function setUniqueLoadedRecord<T>(
  collection: Map<string, T>,
  key: string,
  value: T,
  label: string,
  context: Record<string, unknown>
): void {
  if (collection.has(key)) {
    throw persistenceError(
      `loaded sqlite state must not contain duplicate ${label} records`,
      "sqlite_backend_duplicate_loaded_record",
      { ...context, key, label }
    );
  }

  collection.set(key, value);
}

function readSqliteStringColumn(
  row: Record<string, unknown>,
  column: string,
  label: string
): string {
  const value = row[column];

  if (typeof value === "string") {
    return value;
  }

  throw persistenceError(
    `${label} column "${column}" must be a string`,
    "sqlite_backend_invalid_turn_row",
    { column }
  );
}

function readSqliteNullableStringColumn(
  row: Record<string, unknown>,
  column: string,
  label: string
): string | null {
  const value = row[column];

  if (value === null || typeof value === "string") {
    return value;
  }

  throw persistenceError(
    `${label} column "${column}" must be a string or null`,
    "sqlite_backend_invalid_turn_row",
    { column }
  );
}

function readSqliteNumberColumn(
  row: Record<string, unknown>,
  column: string,
  label: string
): number {
  const value = row[column];

  if (typeof value === "number") {
    return value;
  }

  throw persistenceError(
    `${label} column "${column}" must be a number`,
    "sqlite_backend_invalid_turn_row",
    { column }
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeStoredNonNegativeInteger(
  value: number | null,
  field: string,
  code: string,
  details: Record<string, unknown>
): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    throw persistenceError(
      `stored rows must keep ${field} as a non-negative safe integer`,
      code,
      details
    );
  }

  return value;
}

function decodeStoredRunStatus(
  value: unknown,
  runId: string
): StoredRun["status"] {
  if (
    value === "running" ||
    value === "paused" ||
    value === "completed" ||
    value === "failed"
  ) {
    return value;
  }

  throw persistenceError(
    "stored run rows must decode to a valid run status",
    "sqlite_backend_invalid_run_status",
    { runId, status: value }
  );
}

function toUint8Array(bytes: Uint8Array): Uint8Array {
  return Buffer.from(bytes);
}
