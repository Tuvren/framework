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
import type {
  StoredObserveAnnotation,
  StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import { persistenceError } from "./postgres-errors.js";
import type { BackendState } from "./postgres-records.js";
import type { DbSql } from "./postgres-sql.js";
import { qualifyIdentifier } from "./postgres-sql.js";
import { keyObserveAnnotation } from "./postgres-state-utils.js";

/**
 * Inserts every family row from a decoded {@link BackendState} into the
 * relational tables for one Scope. Used by the open-time blob→row explode
 * (legacy `backend_postgres_snapshots`) and any bulk restore path.
 *
 * Foreign keys are DEFERRABLE INITIALLY DEFERRED, so insert order is
 * still kept topologically tidy for readability rather than necessity.
 * Lineage-root metadata is recomputed from the turn-node parent chain.
 */
export async function insertBackendStateRows(
  sql: DbSql,
  schemaName: string,
  scope: Scope,
  state: BackendState
): Promise<void> {
  const q = (table: string) => qualifyIdentifier(schemaName, table);
  await insertContentAddressedRows(sql, q, scope, state);
  await insertTurnTreePathRows(sql, q, scope, state);
  await insertTurnNodeAndLineageRows(sql, q, scope, state);
  await insertThreadBranchTurnRunRows(sql, q, scope, state);
  await insertStagedAndAnnotationRows(sql, q, scope, state);
}

async function insertContentAddressedRows(
  sql: DbSql,
  q: (table: string) => string,
  scope: Scope,
  state: BackendState
): Promise<void> {
  for (const record of state.objects.values()) {
    await sql.unsafe(
      `INSERT INTO ${q("objects")} (
         scope, hash, media_type, bytes, byte_length, created_at_ms
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (scope, hash) DO NOTHING`,
      [
        scope,
        record.hash,
        record.mediaType,
        record.bytes,
        record.byteLength,
        record.createdAtMs,
      ]
    );
  }

  for (const record of state.schemas.values()) {
    await sql.unsafe(
      `INSERT INTO ${q("schemas")} (
         scope, schema_id, schema_cbor, created_at_ms
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope, schema_id) DO NOTHING`,
      [scope, record.schemaId, record.schemaCbor, record.createdAtMs]
    );
  }

  for (const record of state.turnTrees.values()) {
    await sql.unsafe(
      `INSERT INTO ${q("turn_trees")} (
         scope, hash, schema_id, manifest_cbor, created_at_ms
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope, hash) DO NOTHING`,
      [
        scope,
        record.hash,
        record.schemaId,
        record.manifestCbor,
        record.createdAtMs,
      ]
    );
  }

  for (const record of state.orderedPathChunks.values()) {
    await sql.unsafe(
      `INSERT INTO ${q("ordered_path_chunks")} (
         scope, chunk_hash, item_count, items_cbor, created_at_ms
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope, chunk_hash) DO NOTHING`,
      [
        scope,
        record.chunkHash,
        record.itemCount,
        record.itemsCbor,
        record.createdAtMs,
      ]
    );
  }
}

async function insertTurnTreePathRows(
  sql: DbSql,
  q: (table: string) => string,
  scope: Scope,
  state: BackendState
): Promise<void> {
  for (const pathMap of state.turnTreePaths.values()) {
    for (const record of pathMap.values()) {
      await insertTurnTreePathRow(sql, q("turn_tree_paths"), scope, record);
    }
  }
}

async function insertTurnNodeAndLineageRows(
  sql: DbSql,
  q: (table: string) => string,
  scope: Scope,
  state: BackendState
): Promise<void> {
  for (const record of state.turnNodes.values()) {
    await sql.unsafe(
      `INSERT INTO ${q("turn_nodes")} (
         scope, hash, previous_turn_node_hash, turn_tree_hash,
         consumed_staged_results_cbor, schema_id, event_hash, created_at_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (scope, hash) DO NOTHING`,
      [
        scope,
        record.hash,
        record.previousTurnNodeHash,
        record.turnTreeHash,
        record.consumedStagedResultsCbor,
        record.schemaId,
        record.eventHash,
        record.createdAtMs,
      ]
    );
  }

  const lineageIndex = createTurnNodeLineageIndex();
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
    await sql.unsafe(
      `INSERT INTO ${q("turn_node_lineage_roots")} (
         scope, turn_node_hash, root_turn_node_hash, depth
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope, turn_node_hash) DO NOTHING`,
      [scope, turnNode.hash, position.rootTurnNodeHash, position.depth]
    );
  }
}

async function insertThreadBranchTurnRunRows(
  sql: DbSql,
  q: (table: string) => string,
  scope: Scope,
  state: BackendState
): Promise<void> {
  for (const record of state.threads.values()) {
    await sql.unsafe(
      `INSERT INTO ${q("threads")} (
         scope, thread_id, schema_id, root_turn_node_hash, created_at_ms
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope, thread_id) DO NOTHING`,
      [
        scope,
        record.threadId,
        record.schemaId,
        record.rootTurnNodeHash,
        record.createdAtMs,
      ]
    );
  }

  for (const record of state.branches.values()) {
    await sql.unsafe(
      `INSERT INTO ${q("branches")} (
         scope, branch_id, thread_id, head_turn_node_hash,
         archived_from_branch_id, created_at_ms, updated_at_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (scope, branch_id) DO NOTHING`,
      [
        scope,
        record.branchId,
        record.threadId,
        record.headTurnNodeHash,
        record.archivedFromBranchId ?? null,
        record.createdAtMs,
        record.updatedAtMs,
      ]
    );
  }

  for (const record of state.turns.values()) {
    await sql.unsafe(
      `INSERT INTO ${q("turns")} (
         scope, turn_id, thread_id, branch_id, parent_turn_id,
         start_turn_node_hash, head_turn_node_hash, created_at_ms, updated_at_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (scope, turn_id) DO NOTHING`,
      [
        scope,
        record.turnId,
        record.threadId,
        record.branchId,
        record.parentTurnId,
        record.startTurnNodeHash,
        record.headTurnNodeHash,
        record.createdAtMs,
        record.updatedAtMs,
      ]
    );
  }

  for (const record of state.runs.values()) {
    await sql.unsafe(
      `INSERT INTO ${q("runs")} (
         scope, run_id, turn_id, branch_id, schema_id, start_turn_node_hash,
         status, current_step_index, step_sequence_cbor, created_turn_nodes_cbor,
         created_at_ms, updated_at_ms, pending_signals_cbor,
         last_step_annotations_cbor, execution_owner_id, lease_expires_at_ms,
         fencing_token, preemption_reason
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, $14, $15, $16, $17
       )
       ON CONFLICT (scope, run_id) DO NOTHING`,
      [
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
      ]
    );
  }
}

async function insertStagedAndAnnotationRows(
  sql: DbSql,
  q: (table: string) => string,
  scope: Scope,
  state: BackendState
): Promise<void> {
  for (const stagedByTask of state.stagedResults.values()) {
    for (const record of stagedByTask.values()) {
      await sql.unsafe(
        `INSERT INTO ${q("staged_results")} (
           scope, run_id, task_id, object_hash, object_type, status,
           interrupt_payload_cbor, created_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (scope, run_id, task_id) DO NOTHING`,
        [
          scope,
          record.runId,
          record.taskId,
          record.objectHash,
          record.objectType,
          record.status,
          record.status === "interrupted" ? record.interruptPayloadCbor : null,
          record.createdAtMs,
        ]
      );
    }
  }

  const annotationIdentityCounts = new Map<string, number>();
  for (const annotations of state.observeAnnotations.values()) {
    for (const record of annotations) {
      await insertObserveAnnotationRow(
        sql,
        q("observe_annotations"),
        scope,
        record,
        annotationIdentityCounts
      );
    }
  }
}

async function insertTurnTreePathRow(
  sql: DbSql,
  table: string,
  scope: string,
  record: StoredTurnTreePath
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO ${table} (
       scope, turn_tree_hash, path, collection_kind, single_hash,
       ordered_encoding, ordered_count, ordered_inline_cbor, ordered_chunk_list_cbor
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (scope, turn_tree_hash, path) DO NOTHING`,
    [
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
      record.collectionKind === "ordered" &&
      record.orderedEncoding === "chunked"
        ? record.orderedChunkListCbor
        : null,
    ]
  );
}

async function insertObserveAnnotationRow(
  sql: DbSql,
  table: string,
  scope: string,
  record: StoredObserveAnnotation,
  identityCounts: Map<string, number>
): Promise<void> {
  const identityKey = keyObserveAnnotation(record);
  const count = identityCounts.get(identityKey) ?? 0;
  identityCounts.set(identityKey, count + 1);
  const recordKey = `${identityKey}\0${count}`;

  await sql.unsafe(
    `INSERT INTO ${table} (
       scope, record_key, run_id, annotation_hash, turn_node_hash,
       annotation_cbor, created_at_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (scope, record_key) DO NOTHING`,
    [
      scope,
      recordKey,
      record.runId,
      record.annotationHash,
      record.turnNodeHash,
      record.annotationCbor,
      record.createdAtMs,
    ]
  );
}
