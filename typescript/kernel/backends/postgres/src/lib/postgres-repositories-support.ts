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
  assertStoredObject,
  assertStoredObserveAnnotation,
  assertStoredOrderedPathChunk,
  assertStoredSchema,
  assertStoredStagedResult,
  assertStoredThread,
  type RuntimeBackendTx as KrakenBackendTx,
  type ListThreadsCursorPayload,
  type StoredObject,
  type StoredObserveAnnotation,
  type StoredOrderedPathChunk,
  type StoredRun,
  type StoredSchema,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurnNode,
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
 * builds; mirrors the sibling core-family context in
 * postgres-repositories-core.js, minus `now` since none of these repositories
 * stamp timestamps of their own.
 */
interface SupportRepositoryContext {
  assertTransactionActive: () => void;
  schemaName: string;
  scope: string;
  sql: DbSql;
  writeTracker: TransactionWriteTracker;
}

/**
 * Backend-owned lookup, comparison, cloning, and invariant-assertion
 * functions injected into {@link createSupportRepositories}.
 */
interface SupportRepositoryHelpers {
  areStoredObjectsEqual: (left: StoredObject, right: StoredObject) => boolean;
  areStoredSchemasEqual: (left: StoredSchema, right: StoredSchema) => boolean;
  areStoredStagedResultsEqual: (
    left: StoredStagedResult,
    right: StoredStagedResult
  ) => boolean;
  areStoredThreadsEqual: (left: StoredThread, right: StoredThread) => boolean;
  assertStoredObjectIdentity: (
    record: StoredObject,
    label: string
  ) => Promise<void>;
  assertStoredOrderedPathChunkIdentity: (
    record: StoredOrderedPathChunk,
    label: string
  ) => Promise<void>;
  cloneStoredObject: (record: StoredObject) => StoredObject;
  cloneStoredObserveAnnotation: (
    record: StoredObserveAnnotation
  ) => StoredObserveAnnotation;
  cloneStoredOrderedPathChunk: (
    record: StoredOrderedPathChunk
  ) => StoredOrderedPathChunk;
  cloneStoredSchema: (record: StoredSchema) => StoredSchema;
  cloneStoredStagedResult: (record: StoredStagedResult) => StoredStagedResult;
  cloneStoredThread: (record: StoredThread) => StoredThread;
  compareStoredObserveAnnotation: (
    left: StoredObserveAnnotation,
    right: StoredObserveAnnotation
  ) => number;
  compareStoredStagedResult: (
    left: StoredStagedResult,
    right: StoredStagedResult
  ) => number;
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
  ) => Promise<StoredObject>;
  ensureRunExistsInDatabase: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    runId: string,
    label: string
  ) => Promise<StoredRun>;
  ensureSchemaExistsInDatabase: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    schemaId: string,
    label: string
  ) => Promise<StoredSchema>;
  ensureTurnNodeExistsInDatabase: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    hash: string,
    label: string
  ) => Promise<StoredTurnNode>;
  insertOrderedPathChunk: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    record: StoredOrderedPathChunk
  ) => Promise<void>;
  nextObserveAnnotationRecordKey: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    record: StoredObserveAnnotation
  ) => Promise<string>;
  selectObject: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    hash: string
  ) => Promise<StoredObject | null>;
  selectObserveAnnotationsByRun: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    runId: string
  ) => Promise<StoredObserveAnnotation[]>;
  selectOrderedPathChunk: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    chunkHash: string
  ) => Promise<StoredOrderedPathChunk | null>;
  selectSchema: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    schemaId: string
  ) => Promise<StoredSchema | null>;
  selectStagedResult: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    runId: string,
    taskId: string
  ) => Promise<StoredStagedResult | null>;
  selectStagedResultsByRun: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    runId: string
  ) => Promise<StoredStagedResult[]>;
  selectThread: (
    sql: DbSql,
    schemaName: string,
    scope: string,
    threadId: string
  ) => Promise<StoredThread | null>;
}

function assertSafeThreadListLimit(limit: number | undefined): void {
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 0)) {
    throw persistenceError(
      "threads.list options.limit must be a non-negative safe integer",
      "postgres_backend_invalid_list_limit",
      { limit }
    );
  }
}

/**
 * Builds the `observeAnnotations`, `objects`, `orderedPathChunks`,
 * `schemas`, `stagedResults`, and `threads` repositories of a
 * `RuntimeBackendTx` for one scope partition.
 */
export function createSupportRepositories(
  context: SupportRepositoryContext,
  helpers: SupportRepositoryHelpers
): Pick<
  KrakenBackendTx,
  | "observeAnnotations"
  | "objects"
  | "orderedPathChunks"
  | "schemas"
  | "stagedResults"
  | "threads"
> {
  const { assertTransactionActive, schemaName, scope, sql, writeTracker } =
    context;

  return {
    observeAnnotations: {
      async listByRun(runId) {
        assertTransactionActive();
        const records = await helpers.selectObserveAnnotationsByRun(
          sql,
          schemaName,
          scope,
          runId
        );
        records.sort(helpers.compareStoredObserveAnnotation);
        return records.map(helpers.cloneStoredObserveAnnotation);
      },
      async set(record) {
        assertTransactionActive();
        assertStoredObserveAnnotation(record, "record");
        assertPostgresStorableText(record.runId, "record.runId");
        await helpers.ensureRunExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.runId,
          "record.runId"
        );

        if (record.turnNodeHash !== null) {
          await helpers.ensureTurnNodeExistsInDatabase(
            sql,
            schemaName,
            scope,
            record.turnNodeHash,
            "record.turnNodeHash"
          );
        }

        const table = qualifyIdentifier(schemaName, "observe_annotations");
        const recordKey = await helpers.nextObserveAnnotationRecordKey(
          sql,
          schemaName,
          scope,
          record
        );
        await sql.unsafe(
          `
            INSERT INTO ${table} (
              scope,
              record_key,
              run_id,
              annotation_hash,
              turn_node_hash,
              annotation_cbor,
              created_at_ms
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
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
      },
    },
    objects: {
      async get(hash) {
        assertTransactionActive();
        const record = await helpers.selectObject(sql, schemaName, scope, hash);
        return record === null ? null : helpers.cloneStoredObject(record);
      },
      async has(hash) {
        assertTransactionActive();
        return (
          (await helpers.selectObject(sql, schemaName, scope, hash)) !== null
        );
      },
      async put(record) {
        assertTransactionActive();
        assertStoredObject(record, "record");
        assertPostgresStorableText(record.mediaType, "record.mediaType");
        await helpers.assertStoredObjectIdentity(record, "record");
        const existing = await helpers.selectObject(
          sql,
          schemaName,
          scope,
          record.hash
        );

        if (existing !== null) {
          helpers.ensureImmutableRecordMatch(
            existing,
            record,
            helpers.areStoredObjectsEqual,
            "stored object"
          );
          return;
        }

        const table = qualifyIdentifier(schemaName, "objects");
        await sql.unsafe(
          `
            INSERT INTO ${table} (
              scope,
              hash,
              media_type,
              bytes,
              byte_length,
              created_at_ms
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            scope,
            record.hash,
            record.mediaType,
            record.bytes,
            record.byteLength,
            record.createdAtMs,
          ]
        );
      },
    },
    orderedPathChunks: {
      async get(chunkHash) {
        assertTransactionActive();
        const record = await helpers.selectOrderedPathChunk(
          sql,
          schemaName,
          scope,
          chunkHash
        );
        return record === null
          ? null
          : helpers.cloneStoredOrderedPathChunk(record);
      },
      async put(record) {
        assertTransactionActive();
        assertStoredOrderedPathChunk(record, "record");
        await helpers.assertStoredOrderedPathChunkIdentity(record, "record");
        await helpers.insertOrderedPathChunk(sql, schemaName, scope, record);
      },
    },
    schemas: {
      async get(schemaId) {
        assertTransactionActive();
        const record = await helpers.selectSchema(
          sql,
          schemaName,
          scope,
          schemaId
        );
        return record === null ? null : helpers.cloneStoredSchema(record);
      },
      async put(record) {
        assertTransactionActive();
        assertStoredSchema(record, "record");
        assertPostgresStorableText(record.schemaId, "record.schemaId");
        const existing = await helpers.selectSchema(
          sql,
          schemaName,
          scope,
          record.schemaId
        );

        if (existing !== null) {
          helpers.ensureImmutableRecordMatch(
            existing,
            record,
            helpers.areStoredSchemasEqual,
            "stored schema"
          );
          return;
        }

        const table = qualifyIdentifier(schemaName, "schemas");
        await sql.unsafe(
          `
            INSERT INTO ${table} (scope, schema_id, schema_cbor, created_at_ms)
            VALUES ($1, $2, $3, $4)
          `,
          [scope, record.schemaId, record.schemaCbor, record.createdAtMs]
        );
      },
    },
    stagedResults: {
      async clearRun(runId) {
        assertTransactionActive();
        assertPostgresStorableText(runId, "runId");
        const table = qualifyIdentifier(schemaName, "staged_results");
        const result = await sql.unsafe(
          `DELETE FROM ${table} WHERE scope = $1 AND run_id = $2`,
          [scope, runId]
        );

        if (result.count > 0) {
          writeTracker.recordStagedResultClear(runId);
        }
      },
      async get(runId, taskId) {
        assertTransactionActive();
        const record = await helpers.selectStagedResult(
          sql,
          schemaName,
          scope,
          runId,
          taskId
        );
        return record === null ? null : helpers.cloneStoredStagedResult(record);
      },
      async listByRun(runId) {
        assertTransactionActive();
        const stagedResults = await helpers.selectStagedResultsByRun(
          sql,
          schemaName,
          scope,
          runId
        );
        stagedResults.sort(helpers.compareStoredStagedResult);
        return stagedResults.map(helpers.cloneStoredStagedResult);
      },
      async set(record) {
        assertTransactionActive();
        assertStoredStagedResult(record, "record");
        assertPostgresStorableText(record.runId, "record.runId");
        assertPostgresStorableText(record.taskId, "record.taskId");
        assertPostgresStorableText(record.objectType, "record.objectType");
        await helpers.ensureRunExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.runId,
          "record.runId"
        );
        await helpers.ensureObjectExistsInDatabase(
          sql,
          schemaName,
          scope,
          record.objectHash,
          "record.objectHash"
        );
        const existing = await helpers.selectStagedResult(
          sql,
          schemaName,
          scope,
          record.runId,
          record.taskId
        );

        if (existing !== null) {
          helpers.ensureImmutableRecordMatch(
            existing,
            record,
            helpers.areStoredStagedResultsEqual,
            "stored staged result"
          );
          return;
        }

        const table = qualifyIdentifier(schemaName, "staged_results");
        await sql.unsafe(
          `
            INSERT INTO ${table} (
              scope,
              run_id,
              task_id,
              object_hash,
              object_type,
              status,
              interrupt_payload_cbor,
              created_at_ms
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            scope,
            record.runId,
            record.taskId,
            record.objectHash,
            record.objectType,
            record.status,
            record.status === "interrupted"
              ? record.interruptPayloadCbor
              : null,
            record.createdAtMs,
          ]
        );
        writeTracker.recordStagedResultSet(record);
      },
    },
    threads: {
      async get(threadId) {
        assertTransactionActive();
        const record = await helpers.selectThread(
          sql,
          schemaName,
          scope,
          threadId
        );
        return record === null ? null : helpers.cloneStoredThread(record);
      },
      async put(record) {
        assertTransactionActive();
        assertStoredThread(record, "record");
        assertPostgresStorableText(record.threadId, "record.threadId");
        assertPostgresStorableText(record.schemaId, "record.schemaId");
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
          record.rootTurnNodeHash,
          "record.rootTurnNodeHash"
        );
        const existing = await helpers.selectThread(
          sql,
          schemaName,
          scope,
          record.threadId
        );

        if (existing !== null) {
          helpers.ensureImmutableRecordMatch(
            existing,
            record,
            helpers.areStoredThreadsEqual,
            "stored thread"
          );
          return;
        }

        const table = qualifyIdentifier(schemaName, "threads");
        await sql.unsafe(
          `
            INSERT INTO ${table} (
              scope,
              thread_id,
              schema_id,
              root_turn_node_hash,
              created_at_ms
            ) VALUES ($1, $2, $3, $4, $5)
          `,
          [
            scope,
            record.threadId,
            record.schemaId,
            record.rootTurnNodeHash,
            record.createdAtMs,
          ]
        );
        writeTracker.recordThreadPut(record);
      },
      async list(options) {
        assertTransactionActive();
        const params: (string | number)[] = [scope];
        const conditions: string[] = ["scope = $1"];

        if (options?.cursor !== undefined) {
          const { lastCreatedAtMs, lastThreadId } = options.cursor;
          conditions.push(
            `(created_at_ms > $${params.length + 1} OR (created_at_ms = $${params.length + 2} AND thread_id > $${params.length + 3}))`
          );
          params.push(lastCreatedAtMs, lastCreatedAtMs, lastThreadId);
        }

        if (options?.filter?.schemaId !== undefined) {
          conditions.push(`schema_id = $${params.length + 1}`);
          params.push(options.filter.schemaId);
        }

        const where = `WHERE ${conditions.join(" AND ")}`;

        const limit = options?.limit;
        assertSafeThreadListLimit(limit);

        const fetchLimit = limit === undefined ? undefined : limit + 1;
        const limitClause =
          fetchLimit === undefined ? "" : `LIMIT $${params.length + 1}`;

        if (fetchLimit !== undefined) {
          params.push(fetchLimit);
        }

        const table = qualifyIdentifier(schemaName, "threads");
        const rows = await sql.unsafe<
          Array<{
            thread_id: string;
            schema_id: string;
            root_turn_node_hash: string;
            created_at_ms: number | string | bigint;
          }>
        >(
          `SELECT thread_id, schema_id, root_turn_node_hash, created_at_ms
             FROM ${table}
             ${where}
             ORDER BY created_at_ms ASC, thread_id ASC
             ${limitClause}`,
          params
        );

        let threads: StoredThread[] = rows.map((row) => ({
          threadId: row.thread_id,
          schemaId: row.schema_id,
          rootTurnNodeHash: row.root_turn_node_hash,
          createdAtMs: Number(row.created_at_ms) as StoredThread["createdAtMs"],
        }));

        let nextCursor: ListThreadsCursorPayload | undefined;
        if (limit !== undefined && threads.length > limit) {
          threads = threads.slice(0, limit);
          const last = threads.at(-1);
          if (last !== undefined) {
            nextCursor = {
              v: 1,
              kind: "list-threads",
              lastThreadId: last.threadId,
              lastCreatedAtMs: last.createdAtMs,
              filter: options?.filter,
            };
          }
        }

        return { threads, nextCursor };
      },
    },
  };
}
