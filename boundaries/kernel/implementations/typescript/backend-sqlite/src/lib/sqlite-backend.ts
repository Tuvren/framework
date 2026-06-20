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
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, format, parse } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertScope,
  DEFAULT_SCOPE,
  type EpochMs,
  type Scope,
} from "@tuvren/core";
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
  type ReclamationSummary,
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
import { reclaimBackendState } from "./sqlite-reclamation.js";
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
/**
 * The on-disk artifacts a WAL-mode SQLite database leaves behind: the database
 * file itself and its write-ahead-log / shared-memory sidecars. `purgeScope`
 * removes all three so dropping a Scope partition leaves nothing on disk.
 */
const SQLITE_PARTITION_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
const FAULT_INJECTION_CONTROL = Symbol(
  "tuvren.kernel.testkit.fault-injection-control"
);

interface MutableRepositories extends KrakenBackendTx {
  readonly now: () => number;
}

interface BackendFaultHooks {
  afterCommitBeforeAck?(): Promise<void>;
  beforeCommit?(): Promise<void>;
  midCommit?(commit: () => Promise<void>): Promise<void>;
}

interface BackendFaultInjectionControl {
  setFaultHooks(hooks: BackendFaultHooks | null): void;
  supportsFaultPoint(point: string): boolean;
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
  /**
   * Host-supplied partition identity bound at construction (ADR-048).
   *
   * Isolation is realized as file-per-scope (ADR-049): the default Scope maps to
   * `databasePath` verbatim — so existing single-scope databases keep working
   * unchanged — while any other Scope derives a deterministic sibling file from
   * the same base path. Two backends sharing a `databasePath` but bound to
   * different Scopes therefore address independent `(scope, hash)` spaces and can
   * never observe each other's objects, lineage, or enumerations. When omitted,
   * the backend binds the default Scope. Must be a non-empty string.
   */
  scope?: Scope;
}

const SQLITE_BACKEND_CAPABILITIES: BackendCapability = {
  "maintenance.reclamation": true,
  "thread.enumeration": true,
};

const RECLAMATION_DELETE_BATCH_SIZE = 500;

class SqliteBackend implements KrakenBackend {
  readonly [FAULT_INJECTION_CONTROL]: BackendFaultInjectionControl = {
    setFaultHooks: (hooks) => {
      this.faultState.hooks = hooks;
    },
    supportsFaultPoint: (point) =>
      point === "before-commit" ||
      point === "mid-commit" ||
      point === "after-commit-before-ack",
  };

  private readonly db: Database.Database;
  private readonly faultState: { hooks: BackendFaultHooks | null } = {
    hooks: null,
  };
  private readonly now: () => number;
  /**
   * The concrete per-Scope database file backing this backend (file-per-scope
   * isolation, ADR-049). Retained so `purgeScope` can drop the partition by
   * removing exactly this Scope's file and its WAL/SHM sidecars.
   */
  private readonly scopedDatabasePath: string;
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(options: SqliteBackendOptions) {
    this.now = options.now ?? Date.now;
    const scope = options.scope ?? DEFAULT_SCOPE;
    assertScope(scope);
    this.scopedDatabasePath = resolveScopedDatabasePath(
      normalizePersistentDatabasePath(options.databasePath),
      scope
    );
    this.db = openConfiguredDatabase(this.scopedDatabasePath);
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

  close(): Promise<void> {
    // Idempotent: `purgeScope` already closes the handle when it drops the
    // partition file, and host disposal may still call `close` afterward.
    if (this.db.open) {
      this.db.close();
    }
    return Promise.resolve();
  }

  purgeScope(): Promise<void> {
    if (this.transactionContext.getStore() === true) {
      throw persistenceError(
        "sqlite backend scope purge must not run inside a transaction",
        "sqlite_backend_nested_transaction"
      );
    }

    // Full tenant offboarding (§9.4): the Scope is realized as its own database
    // file (file-per-scope, ADR-049), so dropping the partition is closing the
    // handle and removing that file plus its WAL/SHM sidecars. Other Scopes live
    // in sibling files and are untouched. The backend is unusable afterward,
    // exactly like `close`.
    return this.queueConnectionWork(() => {
      if (this.db.open) {
        this.db.close();
      }
      for (const suffix of SQLITE_PARTITION_FILE_SUFFIXES) {
        rmSync(`${this.scopedDatabasePath}${suffix}`, { force: true });
      }
      return Promise.resolve();
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
          await this.faultState.hooks?.beforeCommit?.();

          let committed = false;
          const commit = (): Promise<void> => {
            if (committed) {
              throw new Error(
                "sqlite backend commit hook attempted double commit"
              );
            }

            this.db.exec("COMMIT");
            committed = true;
            return Promise.resolve();
          };

          if (this.faultState.hooks?.midCommit === undefined) {
            await commit();
          } else {
            await this.faultState.hooks.midCommit(commit);

            if (!committed) {
              throw new Error(
                "sqlite backend mid-commit hook must call commit exactly once"
              );
            }
          }

          await this.faultState.hooks?.afterCommitBeforeAck?.();
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

  reclaim(): Promise<ReclamationSummary> {
    if (this.transactionContext.getStore() === true) {
      throw persistenceError(
        "sqlite backend reclamation must not run inside a transaction",
        "sqlite_backend_nested_transaction"
      );
    }

    return this.queueConnectionWork(async () => {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        // Defer foreign-key enforcement to COMMIT so the unreachable closure can
        // be deleted in any table order; the post-delete `loadValidatedState`
        // re-asserts referential integrity before the deferred checks run.
        this.db.pragma("defer_foreign_keys = ON");

        const state = await loadValidatedState(this.db);
        const survivorKeysBefore = captureReclamationKeys(state);
        // Reachability and the grace window are derived from the loaded state's
        // own active runs (§9.4); reclaimBackendState mutates the in-memory
        // projection so the surviving key sets reveal exactly what to delete.
        const summary = reclaimBackendState(state);
        applyReclamationDeletions(this.db, survivorKeysBefore, state);

        await loadValidatedState(this.db);
        this.db.exec("COMMIT");
        return summary;
      } catch (error: unknown) {
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
): KrakenBackend & { close(): Promise<void> } {
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

function openConfiguredDatabase(scopedDatabasePath: string): Database.Database {
  try {
    ensureDatabaseDirectory(scopedDatabasePath);
    const db = new Database(scopedDatabasePath, {
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    configureDatabase(db);
    return db;
  } catch (error: unknown) {
    throw normalizeBackendError(error);
  }
}

/**
 * Derives the concrete per-Scope database file from the host-supplied base path
 * (ADR-048 construction-bound Scope; ADR-049 scope-per-file isolation). The
 * default Scope maps to the base path verbatim so existing single-scope
 * databases keep working unchanged; any other Scope derives a deterministic
 * sibling file, so two backends sharing a base path but bound to different
 * Scopes address independent `(scope, hash)` spaces on separate connections and
 * never observe each other's rows.
 */
function resolveScopedDatabasePath(
  normalizedDatabasePath: string,
  scope: Scope
): string {
  if (scope === DEFAULT_SCOPE) {
    return normalizedDatabasePath;
  }

  const parsed = parse(normalizedDatabasePath);
  return format({
    dir: parsed.dir,
    ext: parsed.ext,
    name: `${parsed.name}.scope-${scopeFileSlug(scope)}`,
  });
}

/**
 * Produces a filesystem-safe, deterministic, collision-resistant filename
 * component for an opaque host Scope by hashing it. Reopening the same Scope
 * resolves to the same file, so a scoped database persists across the
 * per-request backends a host reconstructs for a tenant.
 *
 * The 32-hex-char (128-bit) truncation is a deliberate collision budget: it is
 * far beyond any realistic number of distinct scopes per host while keeping the
 * derived filename short. Do not shorten it without reassessing that budget.
 */
function scopeFileSlug(scope: Scope): string {
  return createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 32);
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

interface ReclamationSurvivorKeys {
  branches: Set<string>;
  objects: Set<string>;
  orderedPathChunks: Set<string>;
  runs: Set<string>;
  turnNodes: Set<string>;
  turns: Set<string>;
  turnTrees: Set<string>;
}

function captureReclamationKeys(state: BackendState): ReclamationSurvivorKeys {
  return {
    branches: new Set(state.branches.keys()),
    objects: new Set(state.objects.keys()),
    orderedPathChunks: new Set(state.orderedPathChunks.keys()),
    runs: new Set(state.runs.keys()),
    turnNodes: new Set(state.turnNodes.keys()),
    turns: new Set(state.turns.keys()),
    turnTrees: new Set(state.turnTrees.keys()),
  };
}

/** Keys present before the sweep but absent from the swept draft. */
function reclaimedKeys(
  before: Set<string>,
  survivors: Map<string, unknown>
): string[] {
  const removed: string[] = [];
  for (const key of before) {
    if (!survivors.has(key)) {
      removed.push(key);
    }
  }
  return removed;
}

/**
 * Deletes the rows the in-memory sweep removed. Child tables (including the
 * derived `turn_node_lineage_roots` index and run-scoped staging/annotations)
 * are deleted alongside their parents; with deferred foreign keys the order is
 * not load-bearing, but children are still listed first for clarity.
 */
function applyReclamationDeletions(
  db: Database.Database,
  before: ReclamationSurvivorKeys,
  survivors: BackendState
): void {
  const deletedRunIds = reclaimedKeys(before.runs, survivors.runs);
  const deletedTurnIds = reclaimedKeys(before.turns, survivors.turns);
  const deletedBranchIds = reclaimedKeys(before.branches, survivors.branches);
  const deletedTurnTreeHashes = reclaimedKeys(
    before.turnTrees,
    survivors.turnTrees
  );
  const deletedTurnNodeHashes = reclaimedKeys(
    before.turnNodes,
    survivors.turnNodes
  );
  const deletedChunkHashes = reclaimedKeys(
    before.orderedPathChunks,
    survivors.orderedPathChunks
  );
  const deletedObjectHashes = reclaimedKeys(before.objects, survivors.objects);

  deleteByColumn(db, "staged_results", "run_id", deletedRunIds);
  deleteByColumn(db, "observe_annotations", "run_id", deletedRunIds);
  deleteByColumn(db, "runs", "run_id", deletedRunIds);
  deleteByColumn(db, "turns", "turn_id", deletedTurnIds);
  deleteByColumn(db, "branches", "branch_id", deletedBranchIds);
  deleteByColumn(
    db,
    "turn_tree_paths",
    "turn_tree_hash",
    deletedTurnTreeHashes
  );
  deleteByColumn(db, "turn_trees", "hash", deletedTurnTreeHashes);
  deleteByColumn(
    db,
    "turn_node_lineage_roots",
    "turn_node_hash",
    deletedTurnNodeHashes
  );
  deleteByColumn(db, "turn_nodes", "hash", deletedTurnNodeHashes);
  deleteByColumn(db, "ordered_path_chunks", "chunk_hash", deletedChunkHashes);
  deleteByColumn(db, "objects", "hash", deletedObjectHashes);
}

/**
 * Deletes rows whose primary-key column matches one of `keys`, batched under the
 * SQLite bound-parameter ceiling. `table` and `column` are fixed internal
 * identifiers supplied by `applyReclamationDeletions`, never caller input.
 */
function deleteByColumn(
  db: Database.Database,
  table: string,
  column: string,
  keys: string[]
): void {
  for (
    let index = 0;
    index < keys.length;
    index += RECLAMATION_DELETE_BATCH_SIZE
  ) {
    const batch = keys.slice(index, index + RECLAMATION_DELETE_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(
      ...batch
    );
  }
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
