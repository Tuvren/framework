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

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EpochMs } from "@tuvren/core-types";
import {
  assertStoredObjectIdentity,
  assertStoredOrderedPathChunkIdentity,
  assertStoredTurnNodeIdentity,
  assertStoredTurnTreeIdentity,
  assertStoredTurnTreePath,
  type BackendCapability,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  type RuntimeBackend as KrakenBackend,
  type RuntimeBackendTx as KrakenBackendTx,
  type StoredOrderedPathChunk,
  type StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import Database from "better-sqlite3";
import {
  assertBranchHeadMoveIsLinearInDatabase,
  insertTurnNodeLineageMetadata,
} from "./sqlite-db-lineage.js";
import {
  getErrorMessage,
  normalizeBackendError,
  persistenceError,
} from "./sqlite-errors.js";
import {
  assertBackwardBranchMoveIsArchived,
  assertChunkedTurnTreePathChunkLayout,
  assertTurnParentLink,
  ensureImmutableRecordMatch,
} from "./sqlite-integrity-assertions.js";
import {
  ensureBranchExistsInDatabase,
  ensureObjectExistsInDatabase,
  ensureRunExistsInDatabase,
  ensureSchemaExistsInDatabase,
  ensureThreadExistsInDatabase,
  ensureTurnExistsInDatabase,
  ensureTurnNodeExistsInDatabase,
  ensureTurnTreeExistsInDatabase,
  getSchemaForSchemaIdInDatabase,
  getSchemaForTurnTreeInDatabase,
  selectBranch,
  selectBranchesByThread,
  selectExpiredRuns,
  selectObject,
  selectObserveAnnotationsByRun,
  selectOrderedPathChunk,
  selectRun,
  selectRunsByBranch,
  selectSchema,
  selectStagedResult,
  selectStagedResultsByRun,
  selectThread,
  selectTurn,
  selectTurnNode,
  selectTurnsByThread,
  selectTurnTree,
  selectTurnTreePath,
  selectTurnTreePathsByTurnTree,
} from "./sqlite-lookups.js";
import {
  type BackendState,
  decodeHashStringArray,
  loadState,
} from "./sqlite-records.js";
import { createCoreRepositories } from "./sqlite-repositories-core.js";
import { createSupportRepositories } from "./sqlite-repositories-support.js";
import {
  assertActiveRunHeadAlignment,
  assertImmutableField,
  assertImmutableOptionalField,
  assertMonotonicUpdatedAtMs,
  assertRunCreatedTurnNodesAreCanonical,
  assertRunCreatedTurnNodeWithinTurnSpan,
  assertRunStartTurnNodeWithinTurnSpan,
  assertRunUpdateIsLegal,
  classifyTurnNodeRelationship,
  decodeRunCreatedTurnNodeHashes,
  decodeTurnNodeConsumedStagedResultObjectHashes,
  validateHashString,
} from "./sqlite-run-invariants.js";
import {
  listMigrationFiles,
  resolveMigrationDirectory,
  SQLITE_TRANSIENT_MEMORY_PATH,
} from "./sqlite-schema.js";
import {
  areStoredObjectsEqual,
  areStoredOrderedPathChunksEqual,
  areStoredSchemasEqual,
  areStoredStagedResultsEqual,
  areStoredThreadsEqual,
  areStoredTurnNodesEqual,
  areStoredTurnTreePathsEqual,
  areStoredTurnTreesEqual,
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
  compareStoredBranch,
  compareStoredObserveAnnotation,
  compareStoredRun,
  compareStoredStagedResult,
  compareStoredTurn,
  nextObserveAnnotationRecordKey,
} from "./sqlite-state-utils.js";
import {
  validateCommittedState,
  validateLoadedState,
} from "./sqlite-state-validation.js";
import {
  validateTransactionWriteSet,
  validateTurnNodeLineageRootIndex,
} from "./sqlite-transaction-validation.js";
import {
  loadAppliedMigrationNames,
  validateMigrationState,
} from "./sqlite-validation.js";
import { TransactionWriteTracker } from "./sqlite-write-tracker.js";

const ORDERED_PATH_CHUNK_THRESHOLD = 32;
const ORDERED_PATH_CHUNK_SIZE = 32;
const SQLITE_BUSY_TIMEOUT_MS = 5000;

interface MutableRepositories extends KrakenBackendTx {
  readonly now: () => number;
}

export interface SqliteBackendOptions {
  /**
   * Filesystem-backed SQLite database path.
   *
   * Supports plain filesystem paths and `file:` URIs that resolve to
   * filesystem locations. Temporary or in-memory database paths are rejected
   * because this package is the persistent backend baseline for Epic F.
   */
  databasePath: string;
  /**
   * Optional clock used for migration bookkeeping and tests.
   *
   * When omitted, the backend uses `Date.now`.
   */
  now?: () => EpochMs;
}

const SQLITE_BACKEND_CAPABILITIES: BackendCapability = {
  "thread.enumeration": true,
};

class SqliteBackend implements KrakenBackend {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(options: SqliteBackendOptions) {
    this.now = options.now ?? Date.now;
    this.db = openConfiguredDatabase(options.databasePath);
    runMigrations(this.db, this.now);
  }

  capabilities(): BackendCapability {
    return SQLITE_BACKEND_CAPABILITIES;
  }

  private async queueConnectionWork<T>(work: () => Promise<T>): Promise<T> {
    const priorTransaction = this.transactionQueue;
    let releaseQueue: (() => void) | undefined;

    this.transactionQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await priorTransaction;

    try {
      return await work();
    } finally {
      releaseQueue?.();
    }
  }

  health(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.queueConnectionWork(async () => {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        await loadValidatedState(this.db);
        this.db.exec("ROLLBACK");
        return { ok: true as const };
      } catch (error: unknown) {
        if (this.db.inTransaction) {
          this.db.exec("ROLLBACK");
        }

        return {
          ok: false as const,
          reason: getErrorMessage(normalizeBackendError(error)),
        };
      }
    });
  }

  transact<T>(work: (tx: KrakenBackendTx) => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore() === true) {
      throw persistenceError(
        "sqlite backend transactions must not be nested",
        "sqlite_backend_nested_transaction"
      );
    }

    return this.queueConnectionWork(async () => {
      let active = false;
      try {
        this.db.exec("BEGIN IMMEDIATE");
        const writeTracker = new TransactionWriteTracker();
        active = true;
        const repositories = createRepositories(
          this.db,
          this.now,
          () => active && this.transactionContext.getStore() === true,
          writeTracker
        );

        try {
          const result = await this.transactionContext.run(true, () =>
            work(repositories)
          );
          active = false;
          validateTransactionWriteSet(this.db, writeTracker);
          this.db.exec("COMMIT");
          return result;
        } catch (error: unknown) {
          active = false;
          if (this.db.inTransaction) {
            this.db.exec("ROLLBACK");
          }
          throw normalizeBackendError(error);
        }
      } catch (error: unknown) {
        active = false;
        if (this.db.inTransaction) {
          this.db.exec("ROLLBACK");
        }
        throw normalizeBackendError(error);
      }
    });
  }
}

/**
 * Creates the official SQLite-backed persistent kernel backend.
 *
 * The backend serializes transactions on a single connection, enforces the
 * package-local migration posture, and validates persisted state before it is
 * exposed to callers.
 */
export function createSqliteBackend(
  options: SqliteBackendOptions
): KrakenBackend {
  return new SqliteBackend(options);
}

function createRepositories(
  db: Database.Database,
  now: () => number,
  isTransactionActive: () => boolean,
  writeTracker: TransactionWriteTracker
): MutableRepositories {
  const assertTransactionActive = (): void => {
    if (!isTransactionActive()) {
      throw persistenceError(
        "sqlite backend transaction handles must not outlive their transaction",
        "sqlite_backend_inactive_transaction_handle"
      );
    }
  };

  return {
    now,
    ...createSupportRepositories(
      {
        assertTransactionActive,
        db,
        writeTracker,
      },
      {
        areStoredObjectsEqual,
        areStoredSchemasEqual,
        areStoredStagedResultsEqual,
        areStoredThreadsEqual,
        assertStoredObjectIdentity,
        assertStoredOrderedPathChunkIdentity,
        bufferFromBytes,
        cloneStoredObject,
        cloneStoredObserveAnnotation,
        cloneStoredOrderedPathChunk,
        cloneStoredSchema,
        cloneStoredStagedResult,
        cloneStoredThread,
        compareStoredObserveAnnotation,
        compareStoredStagedResult,
        ensureImmutableRecordMatch,
        ensureObjectExistsInDatabase,
        ensureRunExistsInDatabase,
        ensureSchemaExistsInDatabase,
        ensureTurnNodeExistsInDatabase,
        insertOrderedPathChunk,
        nextObserveAnnotationRecordKey,
        selectObject,
        selectObserveAnnotationsByRun,
        selectOrderedPathChunk,
        selectSchema,
        selectStagedResult,
        selectStagedResultsByRun,
        selectThread,
      }
    ),
    ...createCoreRepositories(
      {
        assertTransactionActive,
        db,
        now,
        writeTracker,
      },
      {
        areStoredTurnNodesEqual,
        areStoredTurnTreesEqual,
        areStoredTurnTreePathsEqual,
        assertBranchHeadMoveIsLinearInDatabase,
        assertImmutableField,
        assertImmutableOptionalField,
        assertMonotonicUpdatedAtMs,
        assertRunUpdateIsLegal,
        assertStoredTurnNodeIdentity,
        assertStoredTurnTreeIdentity,
        bufferFromBytes,
        cloneStoredBranch,
        cloneStoredRun,
        cloneStoredTurn,
        cloneStoredTurnNode,
        cloneStoredTurnTree,
        cloneStoredTurnTreePath,
        compareStoredBranch,
        compareStoredRun,
        compareStoredTurn,
        ensureBranchExistsInDatabase,
        ensureImmutableRecordMatch,
        ensureObjectExistsInDatabase,
        ensureSchemaExistsInDatabase,
        ensureThreadExistsInDatabase,
        ensureTurnExistsInDatabase,
        ensureTurnNodeExistsInDatabase,
        ensureTurnTreeExistsInDatabase,
        getSchemaForSchemaIdInDatabase,
        insertTurnNodeLineageMetadata,
        normalizeStoredTurnTreePathInDatabase,
        selectBranch,
        selectBranchesByThread,
        selectExpiredRuns,
        selectRun,
        selectRunsByBranch,
        selectTurn,
        selectTurnNode,
        selectTurnTree,
        selectTurnTreePath,
        selectTurnTreePathsByTurnTree,
        selectTurnsByThread,
      }
    ),
  };
}

function ensureDatabaseDirectory(databasePath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true });
}

function assertPersistentDatabasePath(databasePath: string): void {
  if (databasePath.length === 0) {
    throw persistenceError(
      "sqlite persistent backend requires a non-empty filesystem database path",
      "sqlite_backend_requires_persistent_database_path",
      { databasePath }
    );
  }

  if (databasePath === SQLITE_TRANSIENT_MEMORY_PATH) {
    throw persistenceError(
      "sqlite persistent backend requires a filesystem database path instead of :memory:",
      "sqlite_backend_requires_persistent_database_path",
      { databasePath }
    );
  }

  if (!databasePath.startsWith("file:")) {
    return;
  }

  const url = new URL(databasePath);
  if (url.searchParams.get("mode") !== "memory") {
    return;
  }

  throw persistenceError(
    "sqlite persistent backend requires a filesystem database path instead of an in-memory file URI",
    "sqlite_backend_requires_persistent_database_path",
    { databasePath }
  );
}

function normalizePersistentDatabasePath(databasePath: string): string {
  assertPersistentDatabasePath(databasePath);
  return resolveFilesystemDatabasePath(databasePath);
}

function resolveFilesystemDatabasePath(databasePath: string): string {
  if (!databasePath.startsWith("file:")) {
    return databasePath;
  }

  const [pathComponent] = databasePath.slice("file:".length).split("?", 1);

  if (pathComponent.startsWith("//")) {
    return fileURLToPath(new URL(databasePath));
  }

  return decodeURIComponent(pathComponent);
}

async function _insertTurnTreePathBatchEntry(
  db: Database.Database,
  record: StoredTurnTreePath,
  now: () => number
): Promise<void> {
  const turnTree = ensureTurnTreeExistsInDatabase(
    db,
    record.turnTreeHash,
    "record.turnTreeHash"
  );
  const schema = getSchemaForTurnTreeInDatabase(db, turnTree);
  assertStoredTurnTreePath(record, schema, "record");

  const normalizedRecord = await normalizeStoredTurnTreePathInDatabase(
    db,
    record,
    now
  );
  const existing = selectTurnTreePath(
    db,
    normalizedRecord.turnTreeHash,
    normalizedRecord.path
  );

  if (existing !== null) {
    ensureImmutableRecordMatch(
      existing,
      normalizedRecord,
      areStoredTurnTreePathsEqual,
      "stored turn tree path"
    );
    return;
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
      ? bufferFromBytes(normalizedRecord.orderedInlineCbor)
      : null,
    normalizedRecord.collectionKind === "ordered" &&
      normalizedRecord.orderedEncoding === "chunked"
      ? bufferFromBytes(normalizedRecord.orderedChunkListCbor)
      : null
  );
}

function configureDatabase(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  const journalMode = db.pragma("journal_mode = WAL", {
    simple: true,
  });

  if (typeof journalMode !== "string" || journalMode.toLowerCase() !== "wal") {
    throw persistenceError(
      "sqlite backend requires WAL journal mode",
      "sqlite_backend_requires_wal_mode",
      { journalMode }
    );
  }
}

function openConfiguredDatabase(databasePath: string): Database.Database {
  const normalizedDatabasePath = normalizePersistentDatabasePath(databasePath);

  try {
    ensureDatabaseDirectory(normalizedDatabasePath);
    const db = new Database(normalizedDatabasePath, {
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    configureDatabase(db);
    return db;
  } catch (error: unknown) {
    throw normalizeBackendError(error);
  }
}

function runMigrations(db: Database.Database, now: () => number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_sqlite_migrations (
      name TEXT PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    )
  `);

  const recordMigration = db.prepare(
    `
      INSERT INTO backend_sqlite_migrations (name, applied_at_ms)
      VALUES (?, ?)
    `
  );
  const applyMigration = db.transaction((fileName: string, sql: string) => {
    db.exec(sql);
    recordMigration.run(fileName, now());
  });

  const applied = new Set(loadAppliedMigrationNames(db));
  const migrationDirectory = resolveMigrationDirectory(persistenceError);
  const migrationFiles = listMigrationFiles(migrationDirectory);

  validateMigrationState(db, persistenceError);

  for (const fileName of migrationFiles) {
    if (applied.has(fileName)) {
      continue;
    }

    const sql = readFileSync(`${migrationDirectory}/${fileName}`, "utf8");
    applyMigration(fileName, sql);
  }

  validateMigrationState(db, persistenceError);
}

async function loadValidatedState(
  db: Database.Database,
  priorState?: BackendState
): Promise<BackendState> {
  validateMigrationState(db, persistenceError);
  const state = loadState(db);
  await validateLoadedState(state);
  validateTurnNodeLineageRootIndex(db, state);
  validateCommittedState(state, priorState ?? state, {
    assertActiveRunHeadAlignment,
    assertBackwardBranchMoveIsArchived,
    assertChunkedTurnTreePathChunkLayout,
    assertRunCreatedTurnNodeWithinTurnSpan,
    assertRunCreatedTurnNodesAreCanonical,
    assertRunStartTurnNodeWithinTurnSpan,
    assertTurnParentLink,
    classifyTurnNodeRelationship,
    decodeRunCreatedTurnNodeHashes,
    decodeTurnNodeConsumedStagedResultObjectHashes,
    validateHashString,
  });
  return state;
}

async function normalizeStoredTurnTreePathInDatabase(
  db: Database.Database,
  record: StoredTurnTreePath,
  now: () => number
): Promise<StoredTurnTreePath> {
  if (record.collectionKind === "single") {
    return cloneStoredTurnTreePath(record);
  }

  if (record.orderedEncoding === "chunked") {
    const chunkHashes = decodeHashStringArray(
      record.orderedChunkListCbor,
      "record.orderedChunkListCbor"
    );

    if (record.orderedCount <= ORDERED_PATH_CHUNK_THRESHOLD) {
      throw persistenceError(
        "chunked ordered turn tree paths must only be used after crossing the promotion threshold",
        "sqlite_backend_chunked_turn_tree_path_below_threshold",
        {
          orderedCount: record.orderedCount,
          threshold: ORDERED_PATH_CHUNK_THRESHOLD,
        }
      );
    }

    let totalCount = 0;
    for (const [index, chunkHash] of chunkHashes.entries()) {
      const chunk = selectOrderedPathChunk(db, chunkHash);
      if (chunk === null) {
        throw persistenceError(
          "chunked turn tree paths must reference existing chunk records",
          "sqlite_backend_missing_ordered_path_chunk_reference",
          { chunkHash, path: record.path, turnTreeHash: record.turnTreeHash }
        );
      }

      assertChunkedTurnTreePathChunkLayout(chunk, index, chunkHashes.length);
      totalCount += chunk.itemCount;
    }

    if (totalCount !== record.orderedCount) {
      throw persistenceError(
        "chunked turn tree paths must agree with the stored chunk cardinality",
        "sqlite_backend_chunked_turn_tree_path_count_mismatch",
        { orderedCount: record.orderedCount, totalCount }
      );
    }

    return cloneStoredTurnTreePath(record);
  }

  if (record.orderedCount <= ORDERED_PATH_CHUNK_THRESHOLD) {
    return cloneStoredTurnTreePath(record);
  }

  const orderedHashes = decodeHashStringArray(
    record.orderedInlineCbor,
    "record.orderedInlineCbor"
  );
  const chunkHashes: string[] = [];

  for (
    let index = 0;
    index < orderedHashes.length;
    index += ORDERED_PATH_CHUNK_SIZE
  ) {
    const chunkItems = orderedHashes.slice(
      index,
      index + ORDERED_PATH_CHUNK_SIZE
    );
    const itemsCbor = encodeHashStringArray(chunkItems);
    const chunkHash = await hashKernelRecord(chunkItems);
    const existingChunk = selectOrderedPathChunk(db, chunkHash);
    const chunkRecord: StoredOrderedPathChunk = {
      chunkHash,
      createdAtMs: existingChunk?.createdAtMs ?? now(),
      itemCount: chunkItems.length,
      itemsCbor,
    };

    insertOrderedPathChunk(db, chunkRecord);
    chunkHashes.push(chunkHash);
  }

  return {
    collectionKind: "ordered",
    orderedChunkListCbor: encodeHashStringArray(chunkHashes),
    orderedCount: record.orderedCount,
    orderedEncoding: "chunked",
    path: record.path,
    turnTreeHash: record.turnTreeHash,
  };
}

function insertOrderedPathChunk(
  db: Database.Database,
  record: StoredOrderedPathChunk
): void {
  const existing = selectOrderedPathChunk(db, record.chunkHash);

  if (existing !== null) {
    ensureImmutableRecordMatch(
      existing,
      record,
      areStoredOrderedPathChunksEqual,
      "ordered path chunk"
    );
    return;
  }

  db.prepare(
    `
      INSERT INTO ordered_path_chunks (
        chunk_hash,
        item_count,
        items_cbor,
        created_at_ms
      ) VALUES (?, ?, ?, ?)
    `
  ).run(
    record.chunkHash,
    record.itemCount,
    bufferFromBytes(record.itemsCbor),
    record.createdAtMs
  );
}

function bufferFromBytes(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

function encodeHashStringArray(hashes: string[]): Uint8Array {
  return encodeDeterministicKernelRecord(
    hashes.map((hash) => validateHashString(hash))
  );
}
