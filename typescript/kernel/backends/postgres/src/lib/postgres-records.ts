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

import { persistenceError } from "./postgres-errors.js";
import type { DbSql } from "./postgres-sql.js";
import { qualifyIdentifier } from "./postgres-sql.js";

/**
 * In-memory projection of the complete persisted state, keyed by each record
 * family's identity. Built by {@link loadState} for validation, health
 * probes, and the reclamation sweep; structurally identical to the memory
 * backend's `BackendState` so the shared invariant/reclamation logic applies
 * unchanged.
 */
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

/**
 * Decoded `turn_node_lineage_roots` entry: a turn node's thread-root hash and
 * its depth from that root, maintained on insert so lineage-membership checks
 * avoid per-query ancestry walks.
 */
export interface TurnNodeLineageMetadata {
  depth: number;
  rootTurnNodeHash: string;
  turnNodeHash: string;
}

// Raw table-row shapes as returned by the `postgres` package (snake_case
// columns, BYTEA as byte arrays, NULLable columns as `| null`). Scope is a
// partition key and is not part of these row shapes when selected via
// `SELECT *` consumers may still receive it; decoders ignore it. Each row
// type pairs with a `decode<Family>Row` function that converts it to the
// validated Stored* protocol record.

/** Postgres BIGINT (and INTEGER) columns arrive as number | string | bigint. */
type PgInt = number | string | bigint;

/** Raw `objects` table row. */
export interface PostgresObjectRow {
  byte_length: PgInt;
  bytes: Uint8Array;
  created_at_ms: PgInt;
  hash: string;
  media_type: string;
}

/** Raw `schemas` table row. */
export interface PostgresSchemaRow {
  created_at_ms: PgInt;
  schema_cbor: Uint8Array;
  schema_id: string;
}

/** Raw `turn_trees` table row. */
export interface PostgresTurnTreeRow {
  created_at_ms: PgInt;
  hash: string;
  manifest_cbor: Uint8Array;
  schema_id: string;
}

/** Raw `turn_tree_paths` table row (single/ordered variant columns). */
export interface PostgresTurnTreePathRow {
  collection_kind: "ordered" | "single";
  ordered_chunk_list_cbor: Uint8Array | null;
  ordered_count: PgInt | null;
  ordered_encoding: "chunked" | "flat" | null;
  ordered_inline_cbor: Uint8Array | null;
  path: string;
  single_hash: string | null;
  turn_tree_hash: string;
}

/** Raw `ordered_path_chunks` table row. */
export interface PostgresOrderedPathChunkRow {
  chunk_hash: string;
  created_at_ms: PgInt;
  item_count: PgInt;
  items_cbor: Uint8Array;
}

/** Raw `turn_nodes` table row. */
export interface PostgresTurnNodeRow {
  consumed_staged_results_cbor: Uint8Array;
  created_at_ms: PgInt;
  event_hash: string | null;
  hash: string;
  previous_turn_node_hash: string | null;
  schema_id: string;
  turn_tree_hash: string;
}

/** Raw `turn_node_lineage_roots` table row. */
export interface PostgresTurnNodeLineageRootRow {
  depth: PgInt;
  root_turn_node_hash: string;
  turn_node_hash: string;
}

/** Row shape of the recursive lineage-proof CTE used by targeted validation. */
export interface PostgresTurnNodeLineageProofRow {
  depth: PgInt;
  hash: string;
  previous_turn_node_hash: string | null;
}

/** Raw `threads` table row. */
export interface PostgresThreadRow {
  created_at_ms: PgInt;
  root_turn_node_hash: string;
  schema_id: string;
  thread_id: string;
}

/** Raw `branches` table row. */
export interface PostgresBranchRow {
  archived_from_branch_id: string | null;
  branch_id: string;
  created_at_ms: PgInt;
  head_turn_node_hash: string;
  thread_id: string;
  updated_at_ms: PgInt;
}

/** Raw `turns` table row. */
export interface PostgresTurnRow {
  branch_id: string;
  created_at_ms: PgInt;
  head_turn_node_hash: string;
  parent_turn_id: string | null;
  start_turn_node_hash: string;
  thread_id: string;
  turn_id: string;
  updated_at_ms: PgInt;
}

/** Raw `runs` table row, including nullable lease and signal columns. */
export interface PostgresRunRow {
  branch_id: string;
  created_at_ms: PgInt;
  created_turn_nodes_cbor: Uint8Array;
  current_step_index: PgInt;
  execution_owner_id: string | null;
  fencing_token: string | null;
  lease_expires_at_ms: PgInt | null;
  pending_signals_cbor: Uint8Array | null;
  preemption_reason: string | null;
  run_id: string;
  schema_id: string;
  start_turn_node_hash: string;
  status: StoredRun["status"];
  step_sequence_cbor: Uint8Array;
  turn_id: string;
  updated_at_ms: PgInt;
}

/** Raw `observe_annotations` table row. */
export interface PostgresObserveAnnotationRow {
  annotation_cbor: Uint8Array;
  annotation_hash: string;
  created_at_ms: PgInt;
  record_key: string;
  run_id: string;
  turn_node_hash: string | null;
}

/** Raw `staged_results` table row. */
export interface PostgresStagedResultRow {
  created_at_ms: PgInt;
  interrupt_payload_cbor: Uint8Array | null;
  object_hash: string;
  object_type: string;
  run_id: string;
  status: StoredStagedResult["status"];
  task_id: string;
}

/** Creates an empty state projection with every record family initialized. */
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

/**
 * Loads every persisted table for one scope into a fully decoded
 * {@link BackendState} projection. Each row passes through its family's decode
 * function (shape assertions included), and duplicate primary keys are rejected
 * with `postgres_backend_duplicate_loaded_record`.
 *
 * Scope is the partition key only — it is not projected into Stored* records.
 */
export async function loadState(
  sql: DbSql,
  schemaName: string,
  scope: string
): Promise<BackendState> {
  const state = createEmptyState();

  const selectAll = async <T>(table: string): Promise<T[]> => {
    const qualified = qualifyIdentifier(schemaName, table);
    return await sql.unsafe<T[]>(
      `SELECT * FROM ${qualified} WHERE scope = $1`,
      [scope]
    );
  };

  for (const row of await selectAll<PostgresObjectRow>("objects")) {
    const record = decodeObjectRow(row);
    setUniqueLoadedRecord(state.objects, record.hash, record, "object", {
      hash: record.hash,
    });
  }

  for (const row of await selectAll<PostgresSchemaRow>("schemas")) {
    const record = decodeSchemaRow(row);
    setUniqueLoadedRecord(state.schemas, record.schemaId, record, "schema", {
      schemaId: record.schemaId,
    });
  }

  for (const row of await selectAll<PostgresTurnTreeRow>("turn_trees")) {
    const record = decodeTurnTreeRow(row);
    setUniqueLoadedRecord(state.turnTrees, record.hash, record, "turn tree", {
      hash: record.hash,
    });
  }

  for (const row of await selectAll<PostgresOrderedPathChunkRow>(
    "ordered_path_chunks"
  )) {
    const record = decodeOrderedPathChunkRow(row);
    setUniqueLoadedRecord(
      state.orderedPathChunks,
      record.chunkHash,
      record,
      "ordered path chunk",
      { chunkHash: record.chunkHash }
    );
  }

  for (const row of await selectAll<PostgresTurnTreePathRow>(
    "turn_tree_paths"
  )) {
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

  for (const row of await selectAll<PostgresTurnNodeRow>("turn_nodes")) {
    const record = decodeTurnNodeRow(row);
    setUniqueLoadedRecord(state.turnNodes, record.hash, record, "turn node", {
      hash: record.hash,
    });
  }

  for (const row of await selectAll<PostgresThreadRow>("threads")) {
    const record = decodeThreadRow(row);
    setUniqueLoadedRecord(state.threads, record.threadId, record, "thread", {
      threadId: record.threadId,
    });
  }

  for (const row of await selectAll<PostgresBranchRow>("branches")) {
    const record = decodeBranchRow(row);
    setUniqueLoadedRecord(state.branches, record.branchId, record, "branch", {
      branchId: record.branchId,
    });
  }

  for (const row of await selectAll<PostgresTurnRow>("turns")) {
    const record = decodeTurnRow(row);
    setUniqueLoadedRecord(state.turns, record.turnId, record, "turn", {
      turnId: record.turnId,
    });
  }

  for (const row of await selectAll<PostgresRunRow>("runs")) {
    const record = decodeRunRow(row);
    setUniqueLoadedRecord(state.runs, record.runId, record, "run", {
      runId: record.runId,
    });
  }

  for (const row of await selectAll<PostgresObserveAnnotationRow>(
    "observe_annotations"
  )) {
    const record = decodeObserveAnnotationRow(row);
    const records = state.observeAnnotations.get(record.runId) ?? [];
    records.push(record);
    state.observeAnnotations.set(record.runId, records);
  }

  for (const row of await selectAll<PostgresStagedResultRow>(
    "staged_results"
  )) {
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

/** Decodes and shape-asserts an `objects` row into a `StoredObject`. */
export function decodeObjectRow(row: PostgresObjectRow): StoredObject {
  const record: StoredObject = {
    byteLength: toSafeInteger(row.byte_length, "byte_length"),
    bytes: cloneBytes(toUint8Array(row.bytes)),
    createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
    hash: row.hash,
    mediaType: row.media_type,
  };
  assertStoredObject(record, "stored object row");
  return record;
}

/** Decodes and shape-asserts a `schemas` row into a `StoredSchema`. */
export function decodeSchemaRow(row: PostgresSchemaRow): StoredSchema {
  const record: StoredSchema = {
    createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
    schemaCbor: cloneEncodedBytes(toUint8Array(row.schema_cbor)),
    schemaId: row.schema_id,
  };
  assertStoredSchema(record, "stored schema row");
  return record;
}

/** Decodes a `turn_trees` row into a `StoredTurnTree`. */
export function decodeTurnTreeRow(row: PostgresTurnTreeRow): StoredTurnTree {
  return {
    createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
    hash: row.hash,
    manifestCbor: cloneEncodedBytes(toUint8Array(row.manifest_cbor)),
    schemaId: row.schema_id,
  };
}

/**
 * Decodes a `turn_tree_paths` row into the correct `StoredTurnTreePath`
 * variant (`single`, ordered `flat`, or ordered `chunked`), rejecting rows
 * whose variant columns are inconsistent.
 *
 * @throws TuvrenPersistenceError `postgres_backend_invalid_turn_tree_path_row`.
 */
export function decodeTurnTreePathRow(
  row: PostgresTurnTreePathRow
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
      "postgres_backend_invalid_turn_tree_path_row",
      { path: row.path, turnTreeHash: row.turn_tree_hash }
    );
  }

  const orderedCount = decodeStoredNonNegativeInteger(
    row.ordered_count,
    "ordered_count",
    "postgres_backend_invalid_turn_tree_path_row",
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
    "postgres_backend_invalid_turn_tree_path_row",
    { path: row.path, turnTreeHash: row.turn_tree_hash }
  );
}

/**
 * Decodes an `ordered_path_chunks` row, verifying `item_count` matches the
 * decoded `items_cbor` cardinality.
 *
 * @throws TuvrenPersistenceError
 *   `postgres_backend_ordered_path_chunk_item_count_mismatch` or
 *   `postgres_backend_invalid_ordered_path_chunk_row`.
 */
export function decodeOrderedPathChunkRow(
  row: PostgresOrderedPathChunkRow
): StoredOrderedPathChunk {
  const itemsCbor = cloneEncodedBytes(toUint8Array(row.items_cbor));
  const itemHashes = decodeHashStringArray(itemsCbor, "chunk.itemsCbor");
  const itemCount = decodeStoredNonNegativeInteger(
    row.item_count,
    "item_count",
    "postgres_backend_invalid_ordered_path_chunk_row",
    { chunkHash: row.chunk_hash }
  );

  if (itemCount !== itemHashes.length) {
    throw persistenceError(
      "stored ordered path chunk rows must keep item_count aligned with items_cbor",
      "postgres_backend_ordered_path_chunk_item_count_mismatch",
      {
        chunkHash: row.chunk_hash,
        decodedCount: itemHashes.length,
        itemCount,
      }
    );
  }

  return {
    chunkHash: row.chunk_hash,
    createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
    itemCount,
    itemsCbor,
  };
}

/** Decodes and shape-asserts a `turn_nodes` row into a `StoredTurnNode`. */
export function decodeTurnNodeRow(row: PostgresTurnNodeRow): StoredTurnNode {
  const record: StoredTurnNode = {
    consumedStagedResultsCbor: cloneEncodedBytes(
      toUint8Array(row.consumed_staged_results_cbor)
    ),
    createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
    eventHash: row.event_hash,
    hash: row.hash,
    previousTurnNodeHash: row.previous_turn_node_hash,
    schemaId: row.schema_id,
    turnTreeHash: row.turn_tree_hash,
  };
  assertStoredTurnNode(record, "stored turn node row");
  return record;
}

/**
 * Decodes a `turn_node_lineage_roots` row, validating both hashes and the
 * non-negative depth.
 */
export function decodeTurnNodeLineageMetadataRow(
  row: PostgresTurnNodeLineageRootRow
): TurnNodeLineageMetadata {
  assertHashString(row.turn_node_hash, "turn_node_hash");
  assertHashString(row.root_turn_node_hash, "root_turn_node_hash");
  const depth = decodeStoredNonNegativeInteger(
    row.depth,
    "depth",
    "postgres_backend_invalid_turn_node_lineage_metadata_row",
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

/** Decodes and shape-asserts a `threads` row into a `StoredThread`. */
export function decodeThreadRow(row: PostgresThreadRow): StoredThread {
  const record: StoredThread = {
    createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
    rootTurnNodeHash: row.root_turn_node_hash,
    schemaId: row.schema_id,
    threadId: row.thread_id,
  };
  assertStoredThread(record, "stored thread row");
  return record;
}

/** Decodes and shape-asserts a `branches` row into a `StoredBranch`. */
export function decodeBranchRow(row: PostgresBranchRow): StoredBranch {
  const record: StoredBranch = {
    ...(row.archived_from_branch_id === null
      ? {}
      : { archivedFromBranchId: row.archived_from_branch_id }),
    branchId: row.branch_id,
    createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
    headTurnNodeHash: row.head_turn_node_hash,
    threadId: row.thread_id,
    updatedAtMs: toSafeInteger(row.updated_at_ms, "updated_at_ms"),
  };
  assertStoredBranch(record, "stored branch row");
  return record;
}

/** Decodes and shape-asserts a `turns` row into a `StoredTurn`. */
export function decodeTurnRow(row: PostgresTurnRow): StoredTurn {
  const record: StoredTurn = {
    branchId: row.branch_id,
    createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
    headTurnNodeHash: row.head_turn_node_hash,
    parentTurnId: row.parent_turn_id,
    startTurnNodeHash: row.start_turn_node_hash,
    threadId: row.thread_id,
    turnId: row.turn_id,
    updatedAtMs: toSafeInteger(row.updated_at_ms, "updated_at_ms"),
  };
  assertStoredTurn(record, "stored turn row");
  return record;
}

/** Decodes and shape-asserts an `observe_annotations` row. */
export function decodeObserveAnnotationRow(
  row: PostgresObserveAnnotationRow
): StoredObserveAnnotation {
  const record: StoredObserveAnnotation = {
    annotationCbor: cloneEncodedBytes(toUint8Array(row.annotation_cbor)),
    annotationHash: row.annotation_hash,
    createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
    runId: row.run_id,
    turnNodeHash: row.turn_node_hash,
  };
  assertStoredObserveAnnotation(record, "stored observe annotation row");
  return record;
}

/**
 * Decodes a `turns` row arriving as `unknown` (e.g. from a dynamic query),
 * validating each column's type before delegating to {@link decodeTurnRow}.
 *
 * @throws TuvrenPersistenceError `postgres_backend_invalid_turn_row`.
 */
export function decodeUnknownTurnRow(row: unknown): StoredTurn {
  const label = "stored turn query row";

  if (!isUnknownRecord(row)) {
    throw persistenceError(
      `${label} must be an object`,
      "postgres_backend_invalid_turn_row",
      {}
    );
  }

  return decodeTurnRow({
    branch_id: readPostgresStringColumn(row, "branch_id", label),
    created_at_ms: readPostgresNumberColumn(row, "created_at_ms", label),
    head_turn_node_hash: readPostgresStringColumn(
      row,
      "head_turn_node_hash",
      label
    ),
    parent_turn_id: readPostgresNullableStringColumn(
      row,
      "parent_turn_id",
      label
    ),
    start_turn_node_hash: readPostgresStringColumn(
      row,
      "start_turn_node_hash",
      label
    ),
    thread_id: readPostgresStringColumn(row, "thread_id", label),
    turn_id: readPostgresStringColumn(row, "turn_id", label),
    updated_at_ms: readPostgresNumberColumn(row, "updated_at_ms", label),
  });
}

/**
 * Decodes and shape-asserts a `runs` row into a `StoredRun`, mapping NULL
 * optional columns (lease fields, pending signals, preemption reason) to
 * absent properties.
 *
 * @throws TuvrenPersistenceError `postgres_backend_invalid_run_status`.
 */
export function decodeRunRow(row: PostgresRunRow): StoredRun {
  const status = decodeStoredRunStatus(row.status, row.run_id);

  const record: StoredRun = {
    branchId: row.branch_id,
    createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
    createdTurnNodesCbor: cloneEncodedBytes(
      toUint8Array(row.created_turn_nodes_cbor)
    ),
    currentStepIndex: toSafeInteger(
      row.current_step_index,
      "current_step_index"
    ),
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
          leaseExpiresAtMs: toSafeInteger(
            row.lease_expires_at_ms,
            "lease_expires_at_ms"
          ),
        }),
    runId: row.run_id,
    schemaId: row.schema_id,
    startTurnNodeHash: row.start_turn_node_hash,
    status,
    stepSequenceCbor: cloneEncodedBytes(toUint8Array(row.step_sequence_cbor)),
    turnId: row.turn_id,
    updatedAtMs: toSafeInteger(row.updated_at_ms, "updated_at_ms"),
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

/**
 * Decodes and shape-asserts a `staged_results` row, enforcing that
 * `interrupt_payload_cbor` is present exactly when status is `interrupted`.
 *
 * @throws TuvrenPersistenceError `postgres_backend_invalid_staged_result_row`.
 */
export function decodeStagedResultRow(
  row: PostgresStagedResultRow
): StoredStagedResult {
  if (row.status === "interrupted") {
    if (row.interrupt_payload_cbor === null) {
      throw persistenceError(
        "stored staged result rows with interrupted status must include interrupt_payload_cbor",
        "postgres_backend_invalid_staged_result_row",
        { runId: row.run_id, status: row.status, taskId: row.task_id }
      );
    }

    const record: StoredStagedResult = {
      createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
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
      "postgres_backend_invalid_staged_result_row",
      { runId: row.run_id, status: row.status, taskId: row.task_id }
    );
  }

  if (row.status !== "completed" && row.status !== "failed") {
    throw persistenceError(
      "stored staged result rows must decode to a valid staged result status",
      "postgres_backend_invalid_staged_result_row",
      { runId: row.run_id, status: row.status, taskId: row.task_id }
    );
  }

  const record: StoredStagedResult = {
    createdAtMs: toSafeInteger(row.created_at_ms, "created_at_ms"),
    objectHash: row.object_hash,
    objectType: row.object_type,
    runId: row.run_id,
    status: row.status,
    taskId: row.task_id,
  };
  assertStoredStagedResult(record, "stored staged result row");
  return record;
}

/** Decodes deterministic-CBOR bytes into a validated `TurnTreeSchema`. */
export function decodeTurnTreeSchema(
  bytes: Uint8Array,
  label: string
): TurnTreeSchema {
  const decodedValue = decodeDeterministicKernelRecord(bytes);
  assertTurnTreeSchema(decodedValue, label);
  return decodedValue;
}

/**
 * Decodes deterministic-CBOR bytes into a `HashString[]`, validating every
 * element.
 *
 * @throws TuvrenPersistenceError `postgres_backend_invalid_hash_array_payload`.
 */
export function decodeHashStringArray(
  bytes: Uint8Array,
  label: string
): string[] {
  const decodedValue = decodeDeterministicKernelRecord(bytes);

  if (!Array.isArray(decodedValue)) {
    throw persistenceError(
      `${label} must decode to a HashString[]`,
      "postgres_backend_invalid_hash_array_payload",
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

/** Copies raw bytes so callers never alias a row buffer. */
export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

/**
 * Copies CBOR bytes and re-attaches the `dataView` property the deterministic
 * decoder expects on encoded payloads.
 */
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
      `loaded postgres state must not contain duplicate ${label} records`,
      "postgres_backend_duplicate_loaded_record",
      { ...context, key, label }
    );
  }

  collection.set(key, value);
}

function readPostgresStringColumn(
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
    "postgres_backend_invalid_turn_row",
    { column }
  );
}

function readPostgresNullableStringColumn(
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
    "postgres_backend_invalid_turn_row",
    { column }
  );
}

function readPostgresNumberColumn(
  row: Record<string, unknown>,
  column: string,
  label: string
): number {
  const value = row[column];

  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    const n = Number(value);
    if (Number.isSafeInteger(n)) {
      return n;
    }
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isSafeInteger(n)) {
      return n;
    }
  }

  throw persistenceError(
    `${label} column "${column}" must be a number`,
    "postgres_backend_invalid_turn_row",
    { column }
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeStoredNonNegativeInteger(
  value: number | string | bigint | null,
  field: string,
  code: string,
  details: Record<string, unknown>
): number {
  if (value === null) {
    throw persistenceError(
      `stored rows must keep ${field} as a non-negative safe integer`,
      code,
      details
    );
  }

  const n = toSafeInteger(value, field);
  if (n < 0) {
    throw persistenceError(
      `stored rows must keep ${field} as a non-negative safe integer`,
      code,
      details
    );
  }

  return n;
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
    "postgres_backend_invalid_run_status",
    { runId, status: value }
  );
}

function toUint8Array(bytes: Uint8Array | Buffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** Coerces a Postgres BIGINT/INTEGER column to a safe JS number. */
export function toSafeInteger(
  value: number | string | bigint,
  field: string
): number {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "bigint") {
    n = Number(value);
  } else {
    n = Number(value);
  }
  if (!Number.isSafeInteger(n)) {
    throw persistenceError(
      `stored rows must keep ${field} as a non-negative safe integer`,
      "postgres_backend_invalid_numeric_column",
      { field, value: String(value) }
    );
  }
  return n;
}
