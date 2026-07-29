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
  createTurnNodeLineageIndex,
  resolveTurnNodeLineagePosition,
} from "@tuvren/backend-shared";
import type { Scope } from "@tuvren/core";
import type { StoredTurnTreePath } from "@tuvren/kernel-protocol";
import type { ParameterOrJSON } from "postgres";
import { persistenceError } from "./postgres-errors.js";
import type { BackendState } from "./postgres-records.js";
import type { RelationalTableName } from "./postgres-schema.js";
import type { DbSql } from "./postgres-sql.js";
import { qualifyIdentifier } from "./postgres-sql.js";
import {
  keyObserveAnnotation,
  OBSERVE_ANNOTATION_KEY_SEPARATOR,
} from "./postgres-state-utils.js";

/**
 * Ceiling on bind parameters per generated multi-row `INSERT`, kept well
 * under the PostgreSQL extended-protocol maximum of 65535 so statement size
 * never becomes the failure mode. Rows are chunked to fit under it.
 */
const MAX_PARAMETERS_PER_STATEMENT = 20_000;

/**
 * Inserts every family row from a decoded {@link BackendState} into the
 * relational tables for one Scope, using batched multi-row `INSERT`s so the
 * open-time blob→row explode costs round trips proportional to record
 * families, not records. Used only by the open-time migration (legacy
 * `backend_postgres_snapshots`), whose target tables were created moments
 * earlier in the same transaction — so the inserts are deliberately strict:
 * a key conflict can only mean a genuine anomaly (e.g. a duplicate
 * record-key derivation) and must abort the migration transaction rather
 * than silently drop a row (ADR-067 decision 5: no committed logical state
 * may be lost).
 *
 * Foreign keys are DEFERRABLE INITIALLY DEFERRED, so insert order is
 * still kept topologically tidy for readability rather than necessity.
 * Lineage-root metadata is recomputed from the turn-node parent chain.
 *
 * Peak resident memory here is a small constant multiple of the largest
 * single Scope's decoded state, not one copy of it: the decoded
 * {@link BackendState} coexists with its materialized per-family row
 * arrays and, within {@link insertRowsInBatches}, per-chunk parameter
 * arrays, all held at once before a chunk's statement is issued.
 */
export async function insertBackendStateRows(
  sql: DbSql,
  schemaName: string,
  scope: Scope,
  state: BackendState
): Promise<void> {
  const insertFamily = async (
    table: RelationalTableName,
    columns: readonly string[],
    rows: unknown[][]
  ): Promise<void> => {
    await insertRowsInBatches(
      sql,
      qualifyIdentifier(schemaName, table),
      columns,
      rows
    );
  };

  await insertFamily(
    "objects",
    ["scope", "hash", "media_type", "bytes", "byte_length", "created_at_ms"],
    Array.from(state.objects.values(), (record) => [
      scope,
      record.hash,
      record.mediaType,
      record.bytes,
      record.byteLength,
      record.createdAtMs,
    ])
  );

  await insertFamily(
    "schemas",
    ["scope", "schema_id", "schema_cbor", "created_at_ms"],
    Array.from(state.schemas.values(), (record) => [
      scope,
      record.schemaId,
      record.schemaCbor,
      record.createdAtMs,
    ])
  );

  await insertFamily(
    "turn_trees",
    ["scope", "hash", "schema_id", "manifest_cbor", "created_at_ms"],
    Array.from(state.turnTrees.values(), (record) => [
      scope,
      record.hash,
      record.schemaId,
      record.manifestCbor,
      record.createdAtMs,
    ])
  );

  await insertFamily(
    "ordered_path_chunks",
    ["scope", "chunk_hash", "item_count", "items_cbor", "created_at_ms"],
    Array.from(state.orderedPathChunks.values(), (record) => [
      scope,
      record.chunkHash,
      record.itemCount,
      record.itemsCbor,
      record.createdAtMs,
    ])
  );

  const turnTreePathRows: unknown[][] = [];
  for (const pathMap of state.turnTreePaths.values()) {
    for (const record of pathMap.values()) {
      turnTreePathRows.push(turnTreePathRow(scope, record));
    }
  }
  await insertFamily(
    "turn_tree_paths",
    [
      "scope",
      "turn_tree_hash",
      "path",
      "collection_kind",
      "single_hash",
      "ordered_encoding",
      "ordered_count",
      "ordered_inline_cbor",
      "ordered_chunk_list_cbor",
    ],
    turnTreePathRows
  );

  await insertFamily(
    "turn_nodes",
    [
      "scope",
      "hash",
      "previous_turn_node_hash",
      "turn_tree_hash",
      "consumed_staged_results_cbor",
      "schema_id",
      "event_hash",
      "created_at_ms",
    ],
    Array.from(state.turnNodes.values(), (record) => [
      scope,
      record.hash,
      record.previousTurnNodeHash,
      record.turnTreeHash,
      record.consumedStagedResultsCbor,
      record.schemaId,
      record.eventHash,
      record.createdAtMs,
    ])
  );

  await insertFamily(
    "turn_node_lineage_roots",
    ["scope", "turn_node_hash", "root_turn_node_hash", "depth"],
    lineageRootRows(scope, state)
  );

  await insertFamily(
    "threads",
    ["scope", "thread_id", "schema_id", "root_turn_node_hash", "created_at_ms"],
    Array.from(state.threads.values(), (record) => [
      scope,
      record.threadId,
      record.schemaId,
      record.rootTurnNodeHash,
      record.createdAtMs,
    ])
  );

  await insertFamily(
    "branches",
    [
      "scope",
      "branch_id",
      "thread_id",
      "head_turn_node_hash",
      "archived_from_branch_id",
      "created_at_ms",
      "updated_at_ms",
    ],
    Array.from(state.branches.values(), (record) => [
      scope,
      record.branchId,
      record.threadId,
      record.headTurnNodeHash,
      record.archivedFromBranchId ?? null,
      record.createdAtMs,
      record.updatedAtMs,
    ])
  );

  await insertFamily(
    "turns",
    [
      "scope",
      "turn_id",
      "thread_id",
      "branch_id",
      "parent_turn_id",
      "start_turn_node_hash",
      "head_turn_node_hash",
      "created_at_ms",
      "updated_at_ms",
    ],
    Array.from(state.turns.values(), (record) => [
      scope,
      record.turnId,
      record.threadId,
      record.branchId,
      record.parentTurnId,
      record.startTurnNodeHash,
      record.headTurnNodeHash,
      record.createdAtMs,
      record.updatedAtMs,
    ])
  );

  await insertFamily(
    "runs",
    [
      "scope",
      "run_id",
      "turn_id",
      "branch_id",
      "schema_id",
      "start_turn_node_hash",
      "status",
      "current_step_index",
      "step_sequence_cbor",
      "created_turn_nodes_cbor",
      "created_at_ms",
      "updated_at_ms",
      "pending_signals_cbor",
      "execution_owner_id",
      "lease_expires_at_ms",
      "fencing_token",
      "preemption_reason",
    ],
    Array.from(state.runs.values(), (record) => [
      scope,
      record.runId,
      record.turnId,
      record.branchId,
      record.schemaId,
      record.startTurnNodeHash,
      record.status,
      record.currentStepIndex,
      record.stepSequenceCbor,
      record.createdTurnNodesCbor,
      record.createdAtMs,
      record.updatedAtMs,
      record.pendingSignalsCbor === undefined
        ? null
        : record.pendingSignalsCbor,
      record.executionOwnerId ?? null,
      record.leaseExpiresAtMs ?? null,
      record.fencingToken ?? null,
      record.preemptionReason ?? null,
    ])
  );

  const stagedResultRows: unknown[][] = [];
  for (const stagedByTask of state.stagedResults.values()) {
    for (const record of stagedByTask.values()) {
      stagedResultRows.push([
        scope,
        record.runId,
        record.taskId,
        record.objectHash,
        record.objectType,
        record.status,
        record.status === "interrupted" ? record.interruptPayloadCbor : null,
        record.createdAtMs,
      ]);
    }
  }
  await insertFamily(
    "staged_results",
    [
      "scope",
      "run_id",
      "task_id",
      "object_hash",
      "object_type",
      "status",
      "interrupt_payload_cbor",
      "created_at_ms",
    ],
    stagedResultRows
  );

  const annotationIdentityCounts = new Map<string, number>();
  const annotationRows: unknown[][] = [];
  for (const annotations of state.observeAnnotations.values()) {
    for (const record of annotations) {
      const identityKey = keyObserveAnnotation(record);
      const count = annotationIdentityCounts.get(identityKey) ?? 0;
      annotationIdentityCounts.set(identityKey, count + 1);
      annotationRows.push([
        scope,
        `${identityKey}${OBSERVE_ANNOTATION_KEY_SEPARATOR}${count}`,
        record.runId,
        record.annotationHash,
        record.turnNodeHash,
        record.annotationCbor,
        record.createdAtMs,
      ]);
    }
  }
  await insertFamily(
    "observe_annotations",
    [
      "scope",
      "record_key",
      "run_id",
      "annotation_hash",
      "turn_node_hash",
      "annotation_cbor",
      "created_at_ms",
    ],
    annotationRows
  );
}

/** Flattens one stored turn-tree path into its column value tuple. */
function turnTreePathRow(scope: string, record: StoredTurnTreePath): unknown[] {
  return [
    scope,
    record.turnTreeHash,
    record.path,
    record.collectionKind,
    record.collectionKind === "single" ? record.singleHash : null,
    record.collectionKind === "ordered" ? record.orderedEncoding : null,
    record.collectionKind === "ordered" ? record.orderedCount : null,
    record.collectionKind === "ordered" && record.orderedEncoding === "flat"
      ? record.orderedInlineCbor
      : null,
    record.collectionKind === "ordered" && record.orderedEncoding === "chunked"
      ? record.orderedChunkListCbor
      : null,
  ];
}

/**
 * Recomputes every turn node's lineage-root position from the parent chain,
 * failing the migration on a cycle or a dangling parent link.
 */
function lineageRootRows(scope: string, state: BackendState): unknown[][] {
  const lineageIndex = createTurnNodeLineageIndex();
  const rows: unknown[][] = [];

  for (const turnNode of state.turnNodes.values()) {
    const position = resolveTurnNodeLineagePosition(
      state.turnNodes,
      turnNode,
      lineageIndex,
      {
        onCycle: (): never => {
          throw persistenceError(
            "turn node lineage must not contain cycles during blob migration",
            "postgres_backend_turn_node_lineage_cycle",
            { turnNodeHash: turnNode.hash }
          );
        },
        onMissingPreviousTurnNode: (missingTurnNodeHash: string): never => {
          throw persistenceError(
            "turn node lineage requires complete parent links during blob migration",
            "postgres_backend_missing_turn_node_reference",
            {
              previousTurnNodeHash: missingTurnNodeHash,
              turnNodeHash: turnNode.hash,
            }
          );
        },
      }
    );
    rows.push([
      scope,
      turnNode.hash,
      position.rootTurnNodeHash,
      position.depth,
    ]);
  }

  return rows;
}

/**
 * Issues strict `INSERT ... VALUES (...), (...)` statements (no ON CONFLICT
 * escape hatch — see {@link insertBackendStateRows}) in chunks sized so no
 * statement exceeds {@link MAX_PARAMETERS_PER_STATEMENT} bind parameters.
 * `table` and `columns` are fixed internal identifiers, never caller input.
 * A failed chunk is re-thrown with the table and chunk position attached so
 * a migration failure names exactly which family and rows broke.
 */
async function insertRowsInBatches(
  sql: DbSql,
  table: string,
  columns: readonly string[],
  rows: unknown[][]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const chunkSize = Math.max(
    1,
    Math.floor(MAX_PARAMETERS_PER_STATEMENT / columns.length)
  );

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const parameters: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        parameters.push(value);
        return `$${parameters.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    try {
      await sql.unsafe(
        `INSERT INTO ${table} (${columns.join(", ")})
         VALUES ${tuples.join(", ")}`,
        parameters as ParameterOrJSON<never>[]
      );
    } catch (error: unknown) {
      const code =
        error instanceof Error && typeof Reflect.get(error, "code") === "string"
          ? (Reflect.get(error, "code") as string)
          : undefined;
      if (code === "22021") {
        throw persistenceError(
          `postgres backend migration cannot store a value from table "${table}": ` +
            "PostgreSQL TEXT columns cannot encode a U+0000 (NUL) code point, " +
            "and the legacy blob contains one",
          "postgres_backend_unstorable_text",
          {
            chunkOffset: offset,
            chunkRows: chunk.length,
            table,
            totalRows: rows.length,
          },
          error
        );
      }

      throw persistenceError(
        "postgres backend bulk family insert failed",
        "postgres_backend_bulk_insert_failed",
        {
          chunkOffset: offset,
          chunkRows: chunk.length,
          table,
          totalRows: rows.length,
        },
        error
      );
    }
  }
}
