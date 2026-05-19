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
import type Database from "better-sqlite3";
import type { TransactionWriteTracker } from "./sqlite-write-tracker.js";

interface SupportRepositoryContext {
  assertTransactionActive: () => void;
  db: Database.Database;
  writeTracker: TransactionWriteTracker;
}

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
  bufferFromBytes: (bytes: Uint8Array) => Buffer;
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
    db: Database.Database,
    hash: string,
    label: string
  ) => StoredObject;
  ensureRunExistsInDatabase: (
    db: Database.Database,
    runId: string,
    label: string
  ) => StoredRun;
  ensureSchemaExistsInDatabase: (
    db: Database.Database,
    schemaId: string,
    label: string
  ) => StoredSchema;
  ensureTurnNodeExistsInDatabase: (
    db: Database.Database,
    hash: string,
    label: string
  ) => StoredTurnNode;
  insertOrderedPathChunk: (
    db: Database.Database,
    record: StoredOrderedPathChunk
  ) => void;
  nextObserveAnnotationRecordKey: (
    db: Database.Database,
    record: StoredObserveAnnotation
  ) => string;
  selectObject: (db: Database.Database, hash: string) => StoredObject | null;
  selectObserveAnnotationsByRun: (
    db: Database.Database,
    runId: string
  ) => StoredObserveAnnotation[];
  selectOrderedPathChunk: (
    db: Database.Database,
    chunkHash: string
  ) => StoredOrderedPathChunk | null;
  selectSchema: (
    db: Database.Database,
    schemaId: string
  ) => StoredSchema | null;
  selectStagedResult: (
    db: Database.Database,
    runId: string,
    taskId: string
  ) => StoredStagedResult | null;
  selectStagedResultsByRun: (
    db: Database.Database,
    runId: string
  ) => StoredStagedResult[];
  selectThread: (
    db: Database.Database,
    threadId: string
  ) => StoredThread | null;
}

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
  const { assertTransactionActive, db, writeTracker } = context;

  return {
    observeAnnotations: {
      listByRun(runId) {
        assertTransactionActive();
        const records = helpers.selectObserveAnnotationsByRun(db, runId);
        records.sort(helpers.compareStoredObserveAnnotation);
        return Promise.resolve(
          records.map(helpers.cloneStoredObserveAnnotation)
        );
      },
      set(record) {
        assertTransactionActive();
        assertStoredObserveAnnotation(record, "record");
        helpers.ensureRunExistsInDatabase(db, record.runId, "record.runId");

        if (record.turnNodeHash !== null) {
          helpers.ensureTurnNodeExistsInDatabase(
            db,
            record.turnNodeHash,
            "record.turnNodeHash"
          );
        }

        db.prepare(
          `
            INSERT INTO observe_annotations (
              record_key,
              run_id,
              annotation_hash,
              turn_node_hash,
              annotation_cbor,
              created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(record_key) DO UPDATE SET
              annotation_cbor = excluded.annotation_cbor
          `
        ).run(
          helpers.nextObserveAnnotationRecordKey(db, record),
          record.runId,
          record.annotationHash,
          record.turnNodeHash,
          helpers.bufferFromBytes(record.annotationCbor),
          record.createdAtMs
        );

        return Promise.resolve();
      },
    },
    objects: {
      get(hash) {
        assertTransactionActive();
        const record = helpers.selectObject(db, hash);
        return Promise.resolve(
          record === null ? null : helpers.cloneStoredObject(record)
        );
      },
      has(hash) {
        assertTransactionActive();
        return Promise.resolve(helpers.selectObject(db, hash) !== null);
      },
      async put(record) {
        assertTransactionActive();
        assertStoredObject(record, "record");
        await helpers.assertStoredObjectIdentity(record, "record");
        const existing = helpers.selectObject(db, record.hash);

        if (existing !== null) {
          helpers.ensureImmutableRecordMatch(
            existing,
            record,
            helpers.areStoredObjectsEqual,
            "stored object"
          );
          return;
        }

        db.prepare(
          `
            INSERT INTO objects (
              hash,
              media_type,
              bytes,
              byte_length,
              created_at_ms
            ) VALUES (?, ?, ?, ?, ?)
          `
        ).run(
          record.hash,
          record.mediaType,
          helpers.bufferFromBytes(record.bytes),
          record.byteLength,
          record.createdAtMs
        );
      },
    },
    orderedPathChunks: {
      get(chunkHash) {
        assertTransactionActive();
        const record = helpers.selectOrderedPathChunk(db, chunkHash);
        return Promise.resolve(
          record === null ? null : helpers.cloneStoredOrderedPathChunk(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        assertStoredOrderedPathChunk(record, "record");
        await helpers.assertStoredOrderedPathChunkIdentity(record, "record");
        helpers.insertOrderedPathChunk(db, record);
      },
    },
    schemas: {
      get(schemaId) {
        assertTransactionActive();
        const record = helpers.selectSchema(db, schemaId);
        return Promise.resolve(
          record === null ? null : helpers.cloneStoredSchema(record)
        );
      },
      put(record) {
        assertTransactionActive();
        assertStoredSchema(record, "record");
        const existing = helpers.selectSchema(db, record.schemaId);

        if (existing !== null) {
          helpers.ensureImmutableRecordMatch(
            existing,
            record,
            helpers.areStoredSchemasEqual,
            "stored schema"
          );
          return Promise.resolve();
        }

        db.prepare(
          `
            INSERT INTO schemas (schema_id, schema_cbor, created_at_ms)
            VALUES (?, ?, ?)
          `
        ).run(
          record.schemaId,
          helpers.bufferFromBytes(record.schemaCbor),
          record.createdAtMs
        );

        return Promise.resolve();
      },
    },
    stagedResults: {
      clearRun(runId) {
        assertTransactionActive();
        const result = db
          .prepare("DELETE FROM staged_results WHERE run_id = ?")
          .run(runId);

        if (result.changes > 0) {
          writeTracker.recordStagedResultClear(runId);
        }

        return Promise.resolve();
      },
      get(runId, taskId) {
        assertTransactionActive();
        const record = helpers.selectStagedResult(db, runId, taskId);
        return Promise.resolve(
          record === null ? null : helpers.cloneStoredStagedResult(record)
        );
      },
      listByRun(runId) {
        assertTransactionActive();
        const stagedResults = helpers.selectStagedResultsByRun(db, runId);
        stagedResults.sort(helpers.compareStoredStagedResult);
        return Promise.resolve(
          stagedResults.map(helpers.cloneStoredStagedResult)
        );
      },
      set(record) {
        assertTransactionActive();
        assertStoredStagedResult(record, "record");
        helpers.ensureRunExistsInDatabase(db, record.runId, "record.runId");
        helpers.ensureObjectExistsInDatabase(
          db,
          record.objectHash,
          "record.objectHash"
        );
        const existing = helpers.selectStagedResult(
          db,
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
          return Promise.resolve();
        }

        db.prepare(
          `
            INSERT INTO staged_results (
              run_id,
              task_id,
              object_hash,
              object_type,
              status,
              interrupt_payload_cbor,
              created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          record.runId,
          record.taskId,
          record.objectHash,
          record.objectType,
          record.status,
          record.status === "interrupted"
            ? helpers.bufferFromBytes(record.interruptPayloadCbor)
            : null,
          record.createdAtMs
        );
        writeTracker.recordStagedResultSet(record);

        return Promise.resolve();
      },
    },
    threads: {
      get(threadId) {
        assertTransactionActive();
        const record = helpers.selectThread(db, threadId);
        return Promise.resolve(
          record === null ? null : helpers.cloneStoredThread(record)
        );
      },
      put(record) {
        assertTransactionActive();
        assertStoredThread(record, "record");
        helpers.ensureSchemaExistsInDatabase(
          db,
          record.schemaId,
          "record.schemaId"
        );
        helpers.ensureTurnNodeExistsInDatabase(
          db,
          record.rootTurnNodeHash,
          "record.rootTurnNodeHash"
        );
        const existing = helpers.selectThread(db, record.threadId);

        if (existing !== null) {
          helpers.ensureImmutableRecordMatch(
            existing,
            record,
            helpers.areStoredThreadsEqual,
            "stored thread"
          );
          return Promise.resolve();
        }

        db.prepare(
          `
            INSERT INTO threads (
              thread_id,
              schema_id,
              root_turn_node_hash,
              created_at_ms
            ) VALUES (?, ?, ?, ?)
          `
        ).run(
          record.threadId,
          record.schemaId,
          record.rootTurnNodeHash,
          record.createdAtMs
        );
        writeTracker.recordThreadPut(record);

        return Promise.resolve();
      },
      list(options) {
        assertTransactionActive();
        const params: (string | number)[] = [];
        const conditions: string[] = [];

        if (options?.cursor !== undefined) {
          const { lastCreatedAtMs, lastThreadId } = options.cursor;
          conditions.push(
            "(created_at_ms > ? OR (created_at_ms = ? AND thread_id > ?))"
          );
          params.push(lastCreatedAtMs, lastCreatedAtMs, lastThreadId);
        }

        if (options?.filter?.schemaId !== undefined) {
          conditions.push("schema_id = ?");
          params.push(options.filter.schemaId);
        }

        const where =
          conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const limit = options?.limit;
        const fetchLimit = limit === undefined ? undefined : limit + 1;
        const limitClause =
          fetchLimit === undefined ? "" : `LIMIT ${fetchLimit}`;

        const rows = db
          .prepare<
            (string | number)[],
            {
              thread_id: string;
              schema_id: string;
              root_turn_node_hash: string;
              created_at_ms: number;
            }
          >(
            `SELECT thread_id, schema_id, root_turn_node_hash, created_at_ms
             FROM threads
             ${where}
             ORDER BY created_at_ms ASC, thread_id ASC
             ${limitClause}`
          )
          .all(...params);

        let threads: StoredThread[] = rows.map((row) => ({
          threadId: row.thread_id,
          schemaId: row.schema_id,
          rootTurnNodeHash: row.root_turn_node_hash,
          createdAtMs: row.created_at_ms as StoredThread["createdAtMs"],
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

        return Promise.resolve({ threads, nextCursor });
      },
    },
  };
}
