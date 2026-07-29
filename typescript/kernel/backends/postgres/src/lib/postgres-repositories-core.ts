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
import { persistenceError } from "./postgres-errors.js";
import type { DbSql } from "./postgres-sql.js";
import {
  assertPostgresStorableText,
  qualifyIdentifier,
} from "./postgres-sql.js";
import type { TransactionWriteTracker } from "./postgres-write-tracker.js";

/**
 * Per-transaction dependencies shared by every repository this module
 * builds: the open connection/transaction, schema and scope partition keys,
 * the guard that rejects use after the transaction ends, a clock for
 * timestamps, and the write tracker that records touched keys for
 * pre-commit validation.
 */
interface CoreRepositoryContext {
  assertTransactionActive: () => void;
  now: () => number;
  schemaName: string;
  scope: string;
  sql: DbSql;
  writeTracker: TransactionWriteTracker;
}

/**
 * Backend-owned lookup, comparison, cloning, and invariant-assertion
 * functions injected into {@link createCoreRepositories}. Keeping them
 * injected rather than imported directly lets this module stay a pure
 * mapping from `RuntimeBackendTx` methods to SQL statements.
 */
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
    sql: DbSql,
    schemaName: string,
    scope: string,
    previousHeadTurnNodeHash: string,
    nextHeadTurnNodeHash: string,
    label: string
  ) => Promise<void>;
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
    sql: DbSql,
    schemaName: string,
    scope: string,
    branchId: string,
    label: string
  ) => Promise<StoredBranch>;
  ensureImmutableRecordMatch: <T>(
    existing: T,
    record: T,
    equals: (left: T, right: T) => boolean,
    label: string
  ) => void;
  ensureObjectExistsInDatabase: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    hash: string,
    label: string
  ) => Promise<unknown>;
  ensureRunExistsInDatabase?: never;
  ensureSchemaExistsInDatabase: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    schemaId: string,
    label: string
  ) => Promise<unknown>;
  ensureThreadExistsInDatabase: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    threadId: string,
    label: string
  ) => Promise<unknown>;
  ensureTurnExistsInDatabase: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    turnId: string,
    label: string
  ) => Promise<StoredTurn>;
  ensureTurnNodeExistsInDatabase: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    hash: string,
    label: string
  ) => Promise<StoredTurnNode>;
  ensureTurnTreeExistsInDatabase: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    hash: string,
    label: string
  ) => Promise<StoredTurnTree>;
  getSchemaForSchemaIdInDatabase: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    schemaId: string,
    label: string
  ) => Promise<TurnTreeSchema>;
  insertTurnNodeLineageMetadata: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    record: StoredTurnNode
  ) => Promise<void>;
  normalizeStoredTurnTreePathInDatabase: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    record: StoredTurnTreePath,
    now: () => number
  ) => Promise<StoredTurnTreePath>;
  selectBranch: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    branchId: string
  ) => Promise<StoredBranch | null>;
  selectBranchesByThread: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    threadId: string
  ) => Promise<StoredBranch[]>;
  selectExpiredRuns: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    nowMs: number
  ) => Promise<StoredRun[]>;
  selectRun: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    runId: string
  ) => Promise<StoredRun | null>;
  selectRunsByBranch: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    branchId: string
  ) => Promise<StoredRun[]>;
  selectTurn: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    turnId: string
  ) => Promise<StoredTurn | null>;
  selectTurnNode: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    hash: string
  ) => Promise<StoredTurnNode | null>;
  selectTurnsByThread: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    threadId: string
  ) => Promise<StoredTurn[]>;
  selectTurnTree: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    hash: string
  ) => Promise<StoredTurnTree | null>;
  selectTurnTreePath: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    turnTreeHash: string,
    path: string
  ) => Promise<StoredTurnTreePath | null>;
  selectTurnTreePathsByTurnTree: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    turnTreeHash: string
  ) => Promise<StoredTurnTreePath[]>;
}

/**
 * Builds the `branches`, `runs`, `turnNodes`, `turnTreePaths`, `turnTrees`,
 * and `turns` repositories of a `RuntimeBackendTx`, backed by direct SQL
 * against the transaction's connection for one scope partition.
 */
export function createCoreRepositories(
  context: CoreRepositoryContext,
  helpers: CoreRepositoryHelpers
): Pick<
  KrakenBackendTx,
  "branches" | "runs" | "turnNodes" | "turnTreePaths" | "turnTrees" | "turns"
> {
  const { assertTransactionActive, now, schemaName, scope, sql, writeTracker } =
    context;

  return {
    branches: {
      async get(branchId) {
        assertTransactionActive();
        const record = await helpers.selectBranch(
          sql,
          schemaName,
          scope,
          branchId
        );
        return record === null ? null : helpers.cloneStoredBranch(record);
      },
      async listByThread(threadId) {
        assertTransactionActive();
        const branches = await helpers.selectBranchesByThread(
          sql,
          schemaName,
          scope,
          threadId
        );
        branches.sort(helpers.compareStoredBranch);
        return branches.map(helpers.cloneStoredBranch);
      },
      async set(record) {
        assertTransactionActive();
        assertStoredBranch(record, "record");
        assertPostgresStorableText(record.branchId, "record.branchId");
        assertPostgresStorableText(record.threadId, "record.threadId");
        if (record.archivedFromBranchId !== undefined) {
          assertPostgresStorableText(
            record.archivedFromBranchId,
            "record.archivedFromBranchId"
          );
        }
        await helpers.ensureThreadExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.threadId,
          "record.threadId"
        );
        await helpers.ensureTurnNodeExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.headTurnNodeHash,
          "record.headTurnNodeHash"
        );
        if (record.archivedFromBranchId !== undefined) {
          await helpers.ensureBranchExistsInDatabase(
            sql,
            schemaName,
            scope,
            record.archivedFromBranchId,
            "record.archivedFromBranchId"
          );
          await writeTracker.captureBranchBaseline(
            sql,
            schemaName,
            scope,
            record.archivedFromBranchId
          );
        }

        const existingBranch = await helpers.selectBranch(
          sql,
          schemaName,
          scope,
          record.branchId
        );
        if (existingBranch !== null) {
          helpers.assertImmutableField(
            existingBranch.threadId,
            record.threadId,
            "record.threadId",
            "postgres_backend_branch_thread_immutable"
          );
          helpers.assertImmutableField(
            existingBranch.createdAtMs,
            record.createdAtMs,
            "record.createdAtMs",
            "postgres_backend_branch_created_at_immutable"
          );
          helpers.assertImmutableOptionalField(
            existingBranch.archivedFromBranchId,
            record.archivedFromBranchId,
            "record.archivedFromBranchId",
            "postgres_backend_branch_archive_source_immutable"
          );
          helpers.assertMonotonicUpdatedAtMs(
            existingBranch.updatedAtMs,
            record.updatedAtMs,
            "record.updatedAtMs",
            "postgres_backend_branch_updated_at_regressed"
          );
          await helpers.assertBranchHeadMoveIsLinearInDatabase(
            sql,
            schemaName,
            scope,
            existingBranch.headTurnNodeHash,
            record.headTurnNodeHash,
            "record.headTurnNodeHash"
          );
        }

        const table = qualifyIdentifier(schemaName, "branches");
        await sql.unsafe(
          `
            INSERT INTO ${table} (
              scope,
              branch_id,
              thread_id,
              head_turn_node_hash,
              archived_from_branch_id,
              created_at_ms,
              updated_at_ms
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (scope, branch_id) DO UPDATE SET
              head_turn_node_hash = EXCLUDED.head_turn_node_hash,
              updated_at_ms = EXCLUDED.updated_at_ms
          `,
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
        writeTracker.recordBranchSet(existingBranch, record);
      },
    },
    runs: {
      async get(runId) {
        assertTransactionActive();
        const record = await helpers.selectRun(sql, schemaName, scope, runId);
        return record === null ? null : helpers.cloneStoredRun(record);
      },
      async listByBranch(branchId) {
        assertTransactionActive();
        const runs = await helpers.selectRunsByBranch(
          sql,
          schemaName,
          scope,
          branchId
        );
        runs.sort(helpers.compareStoredRun);
        return runs.map(helpers.cloneStoredRun);
      },
      async listExpired(nowMs) {
        assertTransactionActive();
        const runs = await helpers.selectExpiredRuns(
          sql,
          schemaName,
          scope,
          nowMs
        );
        runs.sort(helpers.compareStoredRun);
        return runs.map(helpers.cloneStoredRun);
      },
      async set(record) {
        assertTransactionActive();
        assertStoredRun(record, "record");
        assertPostgresStorableText(record.runId, "record.runId");
        assertPostgresStorableText(record.turnId, "record.turnId");
        assertPostgresStorableText(record.branchId, "record.branchId");
        assertPostgresStorableText(record.schemaId, "record.schemaId");
        if (record.executionOwnerId !== undefined) {
          assertPostgresStorableText(
            record.executionOwnerId,
            "record.executionOwnerId"
          );
        }
        if (record.fencingToken !== undefined) {
          assertPostgresStorableText(
            record.fencingToken,
            "record.fencingToken"
          );
        }
        if (record.preemptionReason !== undefined) {
          assertPostgresStorableText(
            record.preemptionReason,
            "record.preemptionReason"
          );
        }
        const branch = await helpers.ensureBranchExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.branchId,
          "record.branchId"
        );
        await helpers.ensureTurnExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.turnId,
          "record.turnId"
        );
        await helpers.ensureSchemaExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.schemaId,
          "record.schemaId"
        );
        await helpers.ensureTurnNodeExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );

        const existingRun = await helpers.selectRun(
          sql,
          schemaName,
          scope,
          record.runId
        );
        if (existingRun !== null) {
          helpers.assertRunUpdateIsLegal(existingRun, record);
        } else if (record.status !== "running") {
          throw persistenceError(
            "new runs must start in running status",
            "postgres_backend_invalid_initial_run_status",
            { runId: record.runId, status: record.status }
          );
        } else if (branch.headTurnNodeHash !== record.startTurnNodeHash) {
          throw persistenceError(
            "stored runs must start from the current branch head when first created",
            "postgres_backend_run_start_turn_node_mismatch",
            {
              branchHeadTurnNodeHash: branch.headTurnNodeHash,
              runId: record.runId,
              startTurnNodeHash: record.startTurnNodeHash,
            }
          );
        }

        const table = qualifyIdentifier(schemaName, "runs");
        await sql.unsafe(
          `
            INSERT INTO ${table} (
              scope,
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
              execution_owner_id,
              lease_expires_at_ms,
              fencing_token,
              preemption_reason
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
            )
            ON CONFLICT (scope, run_id) DO UPDATE SET
              status = EXCLUDED.status,
              current_step_index = EXCLUDED.current_step_index,
              created_turn_nodes_cbor = EXCLUDED.created_turn_nodes_cbor,
              updated_at_ms = EXCLUDED.updated_at_ms,
              pending_signals_cbor = EXCLUDED.pending_signals_cbor,
              execution_owner_id = EXCLUDED.execution_owner_id,
              lease_expires_at_ms = EXCLUDED.lease_expires_at_ms,
              fencing_token = EXCLUDED.fencing_token,
              preemption_reason = EXCLUDED.preemption_reason
          `,
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
        writeTracker.recordRunSet(existingRun, record);
      },
    },
    turnNodes: {
      async get(hash) {
        assertTransactionActive();
        const record = await helpers.selectTurnNode(
          sql,
          schemaName,
          scope,
          hash
        );
        return record === null ? null : helpers.cloneStoredTurnNode(record);
      },
      async put(record) {
        assertTransactionActive();
        assertStoredTurnNode(record, "record");
        assertPostgresStorableText(record.schemaId, "record.schemaId");
        await helpers.assertStoredTurnNodeIdentity(record, "record");
        await helpers.ensureTurnTreeExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.turnTreeHash,
          "record.turnTreeHash"
        );
        if (record.previousTurnNodeHash !== null) {
          await helpers.ensureTurnNodeExistsInDatabase(
            sql,
            schemaName,
            scope,
            record.previousTurnNodeHash,
            "record.previousTurnNodeHash"
          );
        }
        if (record.eventHash !== null) {
          await helpers.ensureObjectExistsInDatabase(
            sql,
            schemaName,
            scope,
            record.eventHash,
            "record.eventHash"
          );
        }
        const existing = await helpers.selectTurnNode(
          sql,
          schemaName,
          scope,
          record.hash
        );

        if (existing !== null) {
          helpers.ensureImmutableRecordMatch(
            existing,
            record,
            helpers.areStoredTurnNodesEqual,
            "stored turn node"
          );
          return;
        }

        const table = qualifyIdentifier(schemaName, "turn_nodes");
        await sql.unsafe(
          `
            INSERT INTO ${table} (
              scope,
              hash,
              previous_turn_node_hash,
              turn_tree_hash,
              consumed_staged_results_cbor,
              schema_id,
              event_hash,
              created_at_ms
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
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
        await helpers.insertTurnNodeLineageMetadata(
          sql,
          schemaName,
          scope,
          record
        );
        writeTracker.recordTurnNodePut(record);
      },
    },
    turnTreePaths: {
      async get(turnTreeHash, path) {
        assertTransactionActive();
        const record = await helpers.selectTurnTreePath(
          sql,
          schemaName,
          scope,
          turnTreeHash,
          path
        );
        return record === null ? null : helpers.cloneStoredTurnTreePath(record);
      },
      async listByTurnTree(turnTreeHash) {
        assertTransactionActive();
        const records = await helpers.selectTurnTreePathsByTurnTree(
          sql,
          schemaName,
          scope,
          turnTreeHash
        );
        // The query above already runs `ORDER BY path`, but this JS sort is
        // the authoritative final order: it matches the SQLite backend's
        // identical re-sort, so the two backends return identical path
        // ordering regardless of each database's SQL collation.
        records.sort((left, right) => left.path.localeCompare(right.path));
        return records.map(helpers.cloneStoredTurnTreePath);
      },
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Batch persistence intentionally validates duplicate keys, schema compatibility, normalization, immutability, and insert encoding in one transaction-local path.
      async putMany(records) {
        assertTransactionActive();
        const seenCompositeKeys = new Set<string>();
        const table = qualifyIdentifier(schemaName, "turn_tree_paths");
        // Batch-local memo (lives only for this `putMany` call): every record
        // in the batch that shares a `turnTreeHash` resolves to the same
        // turn tree and, transitively, the same schema, so fetch each
        // distinct one once instead of once per record. A record whose
        // `turnTreeHash`/`schemaId` is not yet memoized still goes through
        // `ensureTurnTreeExistsInDatabase`/`getSchemaForSchemaIdInDatabase`
        // and still throws the same missing-reference error it always did.
        const turnTreeMemo = new Map<string, StoredTurnTree>();
        const schemaMemo = new Map<string, TurnTreeSchema>();

        for (const record of records) {
          assertPostgresStorableText(record.path, "record.path");
          const compositeKey = `${record.turnTreeHash}:${record.path}`;
          if (seenCompositeKeys.has(compositeKey)) {
            throw persistenceError(
              "turn tree path batches must not contain duplicate keys",
              "postgres_backend_duplicate_turn_tree_path_batch_entry",
              { compositeKey }
            );
          }

          seenCompositeKeys.add(compositeKey);

          let turnTree = turnTreeMemo.get(record.turnTreeHash);
          if (turnTree === undefined) {
            turnTree = await helpers.ensureTurnTreeExistsInDatabase(
              sql,
              schemaName,
              scope,
              record.turnTreeHash,
              "record.turnTreeHash"
            );
            turnTreeMemo.set(record.turnTreeHash, turnTree);
          }

          let schema = schemaMemo.get(turnTree.schemaId);
          if (schema === undefined) {
            schema = await helpers.getSchemaForSchemaIdInDatabase(
              sql,
              schemaName,
              scope,
              turnTree.schemaId,
              "turnTree.schemaId"
            );
            schemaMemo.set(turnTree.schemaId, schema);
          }

          assertStoredTurnTreePath(record, schema, "record");

          const normalizedRecord =
            await helpers.normalizeStoredTurnTreePathInDatabase(
              sql,
              schemaName,
              scope,
              record,
              now
            );
          const existing = await helpers.selectTurnTreePath(
            sql,
            schemaName,
            scope,
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

          await sql.unsafe(
            `
              INSERT INTO ${table} (
                scope,
                turn_tree_hash,
                path,
                collection_kind,
                single_hash,
                ordered_encoding,
                ordered_count,
                ordered_inline_cbor,
                ordered_chunk_list_cbor
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `,
            [
              scope,
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
                ? normalizedRecord.orderedInlineCbor
                : null,
              normalizedRecord.collectionKind === "ordered" &&
              normalizedRecord.orderedEncoding === "chunked"
                ? normalizedRecord.orderedChunkListCbor
                : null,
            ]
          );
          writeTracker.recordTurnTreePathWrite(record.turnTreeHash);
        }
      },
    },
    turnTrees: {
      async get(hash) {
        assertTransactionActive();
        const record = await helpers.selectTurnTree(
          sql,
          schemaName,
          scope,
          hash
        );
        return record === null ? null : helpers.cloneStoredTurnTree(record);
      },
      async put(record) {
        assertTransactionActive();
        assertPostgresStorableText(record.schemaId, "record.schemaId");
        const schema = await helpers.getSchemaForSchemaIdInDatabase(
          sql,
          schemaName,
          scope,
          record.schemaId,
          "record.schemaId"
        );
        assertStoredTurnTree(record, schema, "record");
        await helpers.assertStoredTurnTreeIdentity(record, schema, "record");
        const existing = await helpers.selectTurnTree(
          sql,
          schemaName,
          scope,
          record.hash
        );

        if (existing !== null) {
          helpers.ensureImmutableRecordMatch(
            existing,
            record,
            helpers.areStoredTurnTreesEqual,
            "stored turn tree"
          );
          return;
        }

        const table = qualifyIdentifier(schemaName, "turn_trees");
        await sql.unsafe(
          `
            INSERT INTO ${table} (
              scope,
              hash,
              schema_id,
              manifest_cbor,
              created_at_ms
            ) VALUES ($1, $2, $3, $4, $5)
          `,
          [
            scope,
            record.hash,
            record.schemaId,
            record.manifestCbor,
            record.createdAtMs,
          ]
        );
        writeTracker.recordTurnTreePut(record);
      },
    },
    turns: {
      async get(turnId) {
        assertTransactionActive();
        const record = await helpers.selectTurn(sql, schemaName, scope, turnId);
        return record === null ? null : helpers.cloneStoredTurn(record);
      },
      async listByThread(threadId) {
        assertTransactionActive();
        const turns = await helpers.selectTurnsByThread(
          sql,
          schemaName,
          scope,
          threadId
        );
        turns.sort(helpers.compareStoredTurn);
        return turns.map(helpers.cloneStoredTurn);
      },
      async set(record) {
        assertTransactionActive();
        assertStoredTurn(record, "record");
        assertPostgresStorableText(record.turnId, "record.turnId");
        assertPostgresStorableText(record.threadId, "record.threadId");
        assertPostgresStorableText(record.branchId, "record.branchId");
        if (record.parentTurnId !== null) {
          assertPostgresStorableText(
            record.parentTurnId,
            "record.parentTurnId"
          );
        }
        await helpers.ensureThreadExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.threadId,
          "record.threadId"
        );
        await helpers.ensureBranchExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.branchId,
          "record.branchId"
        );
        await helpers.ensureTurnNodeExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );
        await helpers.ensureTurnNodeExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.headTurnNodeHash,
          "record.headTurnNodeHash"
        );
        if (record.parentTurnId !== null) {
          await helpers.ensureTurnExistsInDatabase(
            sql,
            schemaName,
            scope,
            record.parentTurnId,
            "record.parentTurnId"
          );
        }

        const existingTurn = await helpers.selectTurn(
          sql,
          schemaName,
          scope,
          record.turnId
        );
        if (existingTurn !== null) {
          helpers.assertImmutableField(
            existingTurn.branchId,
            record.branchId,
            "record.branchId",
            "postgres_backend_turn_branch_immutable"
          );
          helpers.assertImmutableField(
            existingTurn.threadId,
            record.threadId,
            "record.threadId",
            "postgres_backend_turn_thread_immutable"
          );
          helpers.assertImmutableField(
            existingTurn.startTurnNodeHash,
            record.startTurnNodeHash,
            "record.startTurnNodeHash",
            "postgres_backend_turn_start_immutable"
          );
          helpers.assertImmutableOptionalField(
            existingTurn.parentTurnId,
            record.parentTurnId,
            "record.parentTurnId",
            "postgres_backend_turn_parent_immutable"
          );
          helpers.assertImmutableField(
            existingTurn.createdAtMs,
            record.createdAtMs,
            "record.createdAtMs",
            "postgres_backend_turn_created_at_immutable"
          );
          helpers.assertMonotonicUpdatedAtMs(
            existingTurn.updatedAtMs,
            record.updatedAtMs,
            "record.updatedAtMs",
            "postgres_backend_turn_updated_at_regressed"
          );
        }

        const table = qualifyIdentifier(schemaName, "turns");
        await sql.unsafe(
          `
            INSERT INTO ${table} (
              scope,
              turn_id,
              thread_id,
              branch_id,
              parent_turn_id,
              start_turn_node_hash,
              head_turn_node_hash,
              created_at_ms,
              updated_at_ms
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (scope, turn_id) DO UPDATE SET
              head_turn_node_hash = EXCLUDED.head_turn_node_hash,
              updated_at_ms = EXCLUDED.updated_at_ms
          `,
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
        writeTracker.recordTurnSet(existingTurn, record);
      },
    },
  };
}
