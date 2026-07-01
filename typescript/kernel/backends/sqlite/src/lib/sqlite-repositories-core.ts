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
  assertStoredBranch,
  assertStoredRun,
  assertStoredTurn,
  assertStoredTurnNode,
  assertStoredTurnTree,
  assertStoredTurnTreePath,
  type RuntimeBackendTx as KrakenBackendTx,
  type StoredBranch,
  type StoredRun,
  type StoredTurn,
  type StoredTurnNode,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import type Database from "better-sqlite3";
import { persistenceError } from "./sqlite-errors.js";
import type { TransactionWriteTracker } from "./sqlite-write-tracker.js";

interface CoreRepositoryContext {
  assertTransactionActive: () => void;
  db: Database.Database;
  now: () => number;
  writeTracker: TransactionWriteTracker;
}

interface CoreRepositoryHelpers {
  areStoredBranchesEqual?: never;
  areStoredRunsEqual?: never;
  areStoredTurnNodesEqual: (
    left: StoredTurnNode,
    right: StoredTurnNode
  ) => boolean;
  areStoredTurnTreePathsEqual: (
    left: StoredTurnTreePath,
    right: StoredTurnTreePath
  ) => boolean;
  areStoredTurnTreesEqual: (
    left: StoredTurnTree,
    right: StoredTurnTree
  ) => boolean;
  assertBranchHeadMoveIsLinearInDatabase: (
    db: Database.Database,
    previousHeadTurnNodeHash: string,
    nextHeadTurnNodeHash: string,
    label: string
  ) => void;
  assertImmutableField: <T>(
    before: T,
    after: T,
    label: string,
    code: string
  ) => void;
  assertImmutableOptionalField: <T>(
    before: T | undefined | null,
    after: T | undefined | null,
    label: string,
    code: string
  ) => void;
  assertMonotonicUpdatedAtMs: (
    before: number,
    after: number,
    label: string,
    code: string
  ) => void;
  assertRunUpdateIsLegal: (before: StoredRun, after: StoredRun) => void;
  assertStoredTurnNodeIdentity: (
    record: StoredTurnNode,
    label: string
  ) => Promise<void>;
  assertStoredTurnTreeIdentity: (
    record: StoredTurnTree,
    schema: TurnTreeSchema,
    label: string
  ) => Promise<void>;
  bufferFromBytes: (bytes: Uint8Array) => Buffer;
  cloneStoredBranch: (record: StoredBranch) => StoredBranch;
  cloneStoredRun: (record: StoredRun) => StoredRun;
  cloneStoredTurn: (record: StoredTurn) => StoredTurn;
  cloneStoredTurnNode: (record: StoredTurnNode) => StoredTurnNode;
  cloneStoredTurnTree: (record: StoredTurnTree) => StoredTurnTree;
  cloneStoredTurnTreePath: (record: StoredTurnTreePath) => StoredTurnTreePath;
  compareStoredBranch: (left: StoredBranch, right: StoredBranch) => number;
  compareStoredRun: (left: StoredRun, right: StoredRun) => number;
  compareStoredTurn: (left: StoredTurn, right: StoredTurn) => number;
  ensureBranchExistsInDatabase: (
    db: Database.Database,
    branchId: string,
    label: string
  ) => StoredBranch;
  ensureImmutableRecordMatch: <T>(
    existing: T,
    record: T,
    equals: (left: T, right: T) => boolean,
    label: string
  ) => void;
  ensureObjectExistsInDatabase: (
    db: Database.Database,
    hash: string,
    label: string
  ) => unknown;
  ensureRunExistsInDatabase?: never;
  ensureSchemaExistsInDatabase: (
    db: Database.Database,
    schemaId: string,
    label: string
  ) => unknown;
  ensureThreadExistsInDatabase: (
    db: Database.Database,
    threadId: string,
    label: string
  ) => unknown;
  ensureTurnExistsInDatabase: (
    db: Database.Database,
    turnId: string,
    label: string
  ) => StoredTurn;
  ensureTurnNodeExistsInDatabase: (
    db: Database.Database,
    hash: string,
    label: string
  ) => StoredTurnNode;
  ensureTurnTreeExistsInDatabase: (
    db: Database.Database,
    hash: string,
    label: string
  ) => StoredTurnTree;
  getSchemaForSchemaIdInDatabase: (
    db: Database.Database,
    schemaId: string,
    label: string
  ) => TurnTreeSchema;
  insertTurnNodeLineageMetadata: (
    db: Database.Database,
    record: StoredTurnNode
  ) => void;
  normalizeStoredTurnTreePathInDatabase: (
    db: Database.Database,
    record: StoredTurnTreePath,
    now: () => number
  ) => Promise<StoredTurnTreePath>;
  selectBranch: (
    db: Database.Database,
    branchId: string
  ) => StoredBranch | null;
  selectBranchesByThread: (
    db: Database.Database,
    threadId: string
  ) => StoredBranch[];
  selectExpiredRuns: (db: Database.Database, nowMs: number) => StoredRun[];
  selectRun: (db: Database.Database, runId: string) => StoredRun | null;
  selectRunsByBranch: (db: Database.Database, branchId: string) => StoredRun[];
  selectTurn: (db: Database.Database, turnId: string) => StoredTurn | null;
  selectTurnNode: (
    db: Database.Database,
    hash: string
  ) => StoredTurnNode | null;
  selectTurnsByThread: (
    db: Database.Database,
    threadId: string
  ) => StoredTurn[];
  selectTurnTree: (
    db: Database.Database,
    hash: string
  ) => StoredTurnTree | null;
  selectTurnTreePath: (
    db: Database.Database,
    turnTreeHash: string,
    path: string
  ) => StoredTurnTreePath | null;
  selectTurnTreePathsByTurnTree: (
    db: Database.Database,
    turnTreeHash: string
  ) => StoredTurnTreePath[];
}

export function createCoreRepositories(
  context: CoreRepositoryContext,
  helpers: CoreRepositoryHelpers
): Pick<
  KrakenBackendTx,
  "branches" | "runs" | "turnNodes" | "turnTreePaths" | "turnTrees" | "turns"
> {
  const { assertTransactionActive, db, now, writeTracker } = context;

  return {
    branches: {
      get(branchId) {
        assertTransactionActive();
        const record = helpers.selectBranch(db, branchId);
        return Promise.resolve(
          record === null ? null : helpers.cloneStoredBranch(record)
        );
      },
      listByThread(threadId) {
        assertTransactionActive();
        const branches = helpers.selectBranchesByThread(db, threadId);
        branches.sort(helpers.compareStoredBranch);
        return Promise.resolve(branches.map(helpers.cloneStoredBranch));
      },
      set(record) {
        assertTransactionActive();
        assertStoredBranch(record, "record");
        helpers.ensureThreadExistsInDatabase(
          db,
          record.threadId,
          "record.threadId"
        );
        helpers.ensureTurnNodeExistsInDatabase(
          db,
          record.headTurnNodeHash,
          "record.headTurnNodeHash"
        );
        if (record.archivedFromBranchId !== undefined) {
          helpers.ensureBranchExistsInDatabase(
            db,
            record.archivedFromBranchId,
            "record.archivedFromBranchId"
          );
          writeTracker.captureBranchBaseline(db, record.archivedFromBranchId);
        }

        const existingBranch = helpers.selectBranch(db, record.branchId);
        if (existingBranch !== null) {
          helpers.assertImmutableField(
            existingBranch.threadId,
            record.threadId,
            "record.threadId",
            "sqlite_backend_branch_thread_immutable"
          );
          helpers.assertImmutableField(
            existingBranch.createdAtMs,
            record.createdAtMs,
            "record.createdAtMs",
            "sqlite_backend_branch_created_at_immutable"
          );
          helpers.assertImmutableOptionalField(
            existingBranch.archivedFromBranchId,
            record.archivedFromBranchId,
            "record.archivedFromBranchId",
            "sqlite_backend_branch_archive_source_immutable"
          );
          helpers.assertMonotonicUpdatedAtMs(
            existingBranch.updatedAtMs,
            record.updatedAtMs,
            "record.updatedAtMs",
            "sqlite_backend_branch_updated_at_regressed"
          );
          helpers.assertBranchHeadMoveIsLinearInDatabase(
            db,
            existingBranch.headTurnNodeHash,
            record.headTurnNodeHash,
            "record.headTurnNodeHash"
          );
        }

        db.prepare(
          `
            INSERT INTO branches (
              branch_id,
              thread_id,
              head_turn_node_hash,
              archived_from_branch_id,
              created_at_ms,
              updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(branch_id) DO UPDATE SET
              head_turn_node_hash = excluded.head_turn_node_hash,
              updated_at_ms = excluded.updated_at_ms
          `
        ).run(
          record.branchId,
          record.threadId,
          record.headTurnNodeHash,
          record.archivedFromBranchId ?? null,
          record.createdAtMs,
          record.updatedAtMs
        );
        writeTracker.recordBranchSet(existingBranch, record);

        return Promise.resolve();
      },
    },
    runs: {
      get(runId) {
        assertTransactionActive();
        const record = helpers.selectRun(db, runId);
        return Promise.resolve(
          record === null ? null : helpers.cloneStoredRun(record)
        );
      },
      listByBranch(branchId) {
        assertTransactionActive();
        const runs = helpers.selectRunsByBranch(db, branchId);
        runs.sort(helpers.compareStoredRun);
        return Promise.resolve(runs.map(helpers.cloneStoredRun));
      },
      listExpired(nowMs) {
        assertTransactionActive();
        const runs = helpers.selectExpiredRuns(db, nowMs);
        runs.sort(helpers.compareStoredRun);
        return Promise.resolve(runs.map(helpers.cloneStoredRun));
      },
      set(record) {
        assertTransactionActive();
        assertStoredRun(record, "record");
        const branch = helpers.ensureBranchExistsInDatabase(
          db,
          record.branchId,
          "record.branchId"
        );
        helpers.ensureTurnExistsInDatabase(db, record.turnId, "record.turnId");
        helpers.ensureSchemaExistsInDatabase(
          db,
          record.schemaId,
          "record.schemaId"
        );
        helpers.ensureTurnNodeExistsInDatabase(
          db,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );

        const existingRun = helpers.selectRun(db, record.runId);
        if (existingRun !== null) {
          helpers.assertRunUpdateIsLegal(existingRun, record);
        } else if (record.status !== "running") {
          throw persistenceError(
            "new runs must start in running status",
            "sqlite_backend_invalid_initial_run_status",
            { runId: record.runId, status: record.status }
          );
        } else if (branch.headTurnNodeHash !== record.startTurnNodeHash) {
          throw persistenceError(
            "stored runs must start from the current branch head when first created",
            "sqlite_backend_run_start_turn_node_mismatch",
            {
              branchHeadTurnNodeHash: branch.headTurnNodeHash,
              runId: record.runId,
              startTurnNodeHash: record.startTurnNodeHash,
            }
          );
        }

        db.prepare(
          `
            INSERT INTO runs (
              run_id,
              turn_id,
              branch_id,
              schema_id,
              start_turn_node_hash,
              status,
              current_step_index,
              step_sequence_cbor,
              created_turn_nodes_cbor,
              created_at_ms,
              updated_at_ms,
              pending_signals_cbor,
              last_step_annotations_cbor,
              execution_owner_id,
              lease_expires_at_ms,
              fencing_token,
              preemption_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
              status = excluded.status,
              current_step_index = excluded.current_step_index,
              created_turn_nodes_cbor = excluded.created_turn_nodes_cbor,
              updated_at_ms = excluded.updated_at_ms,
              pending_signals_cbor = excluded.pending_signals_cbor,
              last_step_annotations_cbor = NULL,
              execution_owner_id = excluded.execution_owner_id,
              lease_expires_at_ms = excluded.lease_expires_at_ms,
              fencing_token = excluded.fencing_token,
              preemption_reason = excluded.preemption_reason
          `
        ).run(
          record.runId,
          record.turnId,
          record.branchId,
          record.schemaId,
          record.startTurnNodeHash,
          record.status,
          record.currentStepIndex,
          helpers.bufferFromBytes(record.stepSequenceCbor),
          helpers.bufferFromBytes(record.createdTurnNodesCbor),
          record.createdAtMs,
          record.updatedAtMs,
          record.pendingSignalsCbor === undefined
            ? null
            : helpers.bufferFromBytes(record.pendingSignalsCbor),
          record.executionOwnerId ?? null,
          record.leaseExpiresAtMs ?? null,
          record.fencingToken ?? null,
          record.preemptionReason ?? null
        );
        writeTracker.recordRunSet(existingRun, record);

        return Promise.resolve();
      },
    },
    turnNodes: {
      get(hash) {
        assertTransactionActive();
        const record = helpers.selectTurnNode(db, hash);
        return Promise.resolve(
          record === null ? null : helpers.cloneStoredTurnNode(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        assertStoredTurnNode(record, "record");
        await helpers.assertStoredTurnNodeIdentity(record, "record");
        helpers.ensureTurnTreeExistsInDatabase(
          db,
          record.turnTreeHash,
          "record.turnTreeHash"
        );
        if (record.previousTurnNodeHash !== null) {
          helpers.ensureTurnNodeExistsInDatabase(
            db,
            record.previousTurnNodeHash,
            "record.previousTurnNodeHash"
          );
        }
        if (record.eventHash !== null) {
          helpers.ensureObjectExistsInDatabase(
            db,
            record.eventHash,
            "record.eventHash"
          );
        }
        const existing = helpers.selectTurnNode(db, record.hash);

        if (existing !== null) {
          helpers.ensureImmutableRecordMatch(
            existing,
            record,
            helpers.areStoredTurnNodesEqual,
            "stored turn node"
          );
          return;
        }

        db.prepare(
          `
            INSERT INTO turn_nodes (
              hash,
              previous_turn_node_hash,
              turn_tree_hash,
              consumed_staged_results_cbor,
              schema_id,
              event_hash,
              created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          record.hash,
          record.previousTurnNodeHash,
          record.turnTreeHash,
          helpers.bufferFromBytes(record.consumedStagedResultsCbor),
          record.schemaId,
          record.eventHash,
          record.createdAtMs
        );
        helpers.insertTurnNodeLineageMetadata(db, record);
        writeTracker.recordTurnNodePut(record);
      },
    },
    turnTreePaths: {
      get(turnTreeHash, path) {
        assertTransactionActive();
        const record = helpers.selectTurnTreePath(db, turnTreeHash, path);
        return Promise.resolve(
          record === null ? null : helpers.cloneStoredTurnTreePath(record)
        );
      },
      listByTurnTree(turnTreeHash) {
        assertTransactionActive();
        const records = helpers.selectTurnTreePathsByTurnTree(db, turnTreeHash);
        records.sort((left, right) => left.path.localeCompare(right.path));
        return Promise.resolve(records.map(helpers.cloneStoredTurnTreePath));
      },
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Batch persistence intentionally validates duplicate keys, schema compatibility, normalization, immutability, and insert encoding in one transaction-local path.
      async putMany(records) {
        assertTransactionActive();
        const seenCompositeKeys = new Set<string>();

        for (const record of records) {
          const compositeKey = `${record.turnTreeHash}:${record.path}`;
          if (seenCompositeKeys.has(compositeKey)) {
            throw persistenceError(
              "turn tree path batches must not contain duplicate keys",
              "sqlite_backend_duplicate_turn_tree_path_batch_entry",
              { compositeKey }
            );
          }

          seenCompositeKeys.add(compositeKey);

          const turnTree = helpers.ensureTurnTreeExistsInDatabase(
            db,
            record.turnTreeHash,
            "record.turnTreeHash"
          );
          const schema = helpers.getSchemaForSchemaIdInDatabase(
            db,
            turnTree.schemaId,
            "turnTree.schemaId"
          );
          assertStoredTurnTreePath(record, schema, "record");

          const normalizedRecord =
            await helpers.normalizeStoredTurnTreePathInDatabase(
              db,
              record,
              now
            );
          const existing = helpers.selectTurnTreePath(
            db,
            normalizedRecord.turnTreeHash,
            normalizedRecord.path
          );

          if (existing !== null) {
            helpers.ensureImmutableRecordMatch(
              existing,
              normalizedRecord,
              helpers.areStoredTurnTreePathsEqual,
              "stored turn tree path"
            );
            continue;
          }

          db.prepare(
            `
              INSERT INTO turn_tree_paths (
                turn_tree_hash,
                path,
                collection_kind,
                single_hash,
                ordered_encoding,
                ordered_count,
                ordered_inline_cbor,
                ordered_chunk_list_cbor
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `
          ).run(
            normalizedRecord.turnTreeHash,
            normalizedRecord.path,
            normalizedRecord.collectionKind,
            normalizedRecord.collectionKind === "single"
              ? normalizedRecord.singleHash
              : null,
            normalizedRecord.collectionKind === "ordered"
              ? normalizedRecord.orderedEncoding
              : null,
            normalizedRecord.collectionKind === "ordered"
              ? normalizedRecord.orderedCount
              : null,
            normalizedRecord.collectionKind === "ordered" &&
              normalizedRecord.orderedEncoding === "flat"
              ? helpers.bufferFromBytes(normalizedRecord.orderedInlineCbor)
              : null,
            normalizedRecord.collectionKind === "ordered" &&
              normalizedRecord.orderedEncoding === "chunked"
              ? helpers.bufferFromBytes(normalizedRecord.orderedChunkListCbor)
              : null
          );
          writeTracker.recordTurnTreePathWrite(record.turnTreeHash);
        }
      },
    },
    turnTrees: {
      get(hash) {
        assertTransactionActive();
        const record = helpers.selectTurnTree(db, hash);
        return Promise.resolve(
          record === null ? null : helpers.cloneStoredTurnTree(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        const schema = helpers.getSchemaForSchemaIdInDatabase(
          db,
          record.schemaId,
          "record.schemaId"
        );
        assertStoredTurnTree(record, schema, "record");
        await helpers.assertStoredTurnTreeIdentity(record, schema, "record");
        const existing = helpers.selectTurnTree(db, record.hash);

        if (existing !== null) {
          helpers.ensureImmutableRecordMatch(
            existing,
            record,
            helpers.areStoredTurnTreesEqual,
            "stored turn tree"
          );
          return;
        }

        db.prepare(
          `
            INSERT INTO turn_trees (
              hash,
              schema_id,
              manifest_cbor,
              created_at_ms
            ) VALUES (?, ?, ?, ?)
          `
        ).run(
          record.hash,
          record.schemaId,
          helpers.bufferFromBytes(record.manifestCbor),
          record.createdAtMs
        );
        writeTracker.recordTurnTreePut(record);
      },
    },
    turns: {
      get(turnId) {
        assertTransactionActive();
        const record = helpers.selectTurn(db, turnId);
        return Promise.resolve(
          record === null ? null : helpers.cloneStoredTurn(record)
        );
      },
      listByThread(threadId) {
        assertTransactionActive();
        const turns = helpers.selectTurnsByThread(db, threadId);
        turns.sort(helpers.compareStoredTurn);
        return Promise.resolve(turns.map(helpers.cloneStoredTurn));
      },
      set(record) {
        assertTransactionActive();
        assertStoredTurn(record, "record");
        helpers.ensureThreadExistsInDatabase(
          db,
          record.threadId,
          "record.threadId"
        );
        helpers.ensureBranchExistsInDatabase(
          db,
          record.branchId,
          "record.branchId"
        );
        helpers.ensureTurnNodeExistsInDatabase(
          db,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );
        helpers.ensureTurnNodeExistsInDatabase(
          db,
          record.headTurnNodeHash,
          "record.headTurnNodeHash"
        );
        if (record.parentTurnId !== null) {
          helpers.ensureTurnExistsInDatabase(
            db,
            record.parentTurnId,
            "record.parentTurnId"
          );
        }

        const existingTurn = helpers.selectTurn(db, record.turnId);
        if (existingTurn !== null) {
          helpers.assertImmutableField(
            existingTurn.branchId,
            record.branchId,
            "record.branchId",
            "sqlite_backend_turn_branch_immutable"
          );
          helpers.assertImmutableField(
            existingTurn.threadId,
            record.threadId,
            "record.threadId",
            "sqlite_backend_turn_thread_immutable"
          );
          helpers.assertImmutableField(
            existingTurn.startTurnNodeHash,
            record.startTurnNodeHash,
            "record.startTurnNodeHash",
            "sqlite_backend_turn_start_immutable"
          );
          helpers.assertImmutableOptionalField(
            existingTurn.parentTurnId,
            record.parentTurnId,
            "record.parentTurnId",
            "sqlite_backend_turn_parent_immutable"
          );
          helpers.assertImmutableField(
            existingTurn.createdAtMs,
            record.createdAtMs,
            "record.createdAtMs",
            "sqlite_backend_turn_created_at_immutable"
          );
          helpers.assertMonotonicUpdatedAtMs(
            existingTurn.updatedAtMs,
            record.updatedAtMs,
            "record.updatedAtMs",
            "sqlite_backend_turn_updated_at_regressed"
          );
        }

        db.prepare(
          `
            INSERT INTO turns (
              turn_id,
              thread_id,
              branch_id,
              parent_turn_id,
              start_turn_node_hash,
              head_turn_node_hash,
              created_at_ms,
              updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(turn_id) DO UPDATE SET
              head_turn_node_hash = excluded.head_turn_node_hash,
              updated_at_ms = excluded.updated_at_ms
          `
        ).run(
          record.turnId,
          record.threadId,
          record.branchId,
          record.parentTurnId,
          record.startTurnNodeHash,
          record.headTurnNodeHash,
          record.createdAtMs,
          record.updatedAtMs
        );
        writeTracker.recordTurnSet(existingTurn, record);

        return Promise.resolve();
      },
    },
  };
}
