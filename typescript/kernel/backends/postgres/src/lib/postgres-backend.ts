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
import {
  NOOP_PHASE_OBSERVER,
  type PhaseObserver,
} from "@tuvren/backend-shared";
import { assertScope, DEFAULT_SCOPE, type Scope } from "@tuvren/core";
import {
  assertStoredObjectIdentity,
  assertStoredOrderedPathChunkIdentity,
  assertStoredTurnNodeIdentity,
  assertStoredTurnTreeIdentity,
  type BackendCapability,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  type RuntimeBackend as KrakenBackend,
  type RuntimeBackendTx as KrakenBackendTx,
  type ReclamationOptions,
  type ReclamationSummary,
  type StoredOrderedPathChunk,
  type StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import type { Sql } from "postgres";
import {
  createPostgresClient,
  normalizeSchemaName,
  type PostgresBackendPersistenceOptions,
} from "./postgres-backend-persistence.js";
import {
  assertBranchHeadMoveIsLinearInDatabase,
  insertTurnNodeLineageMetadata,
} from "./postgres-db-lineage.js";
import {
  getErrorMessage,
  normalizeBackendError,
  persistenceError,
} from "./postgres-errors.js";
import {
  assertBackwardBranchMoveIsArchived,
  assertChunkedTurnTreePathChunkLayout,
  assertTurnParentLink,
  ensureImmutableRecordMatch,
  ORDERED_PATH_CHUNK_SIZE,
} from "./postgres-integrity-assertions.js";
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
} from "./postgres-lookups.js";
import { reclaimBackendState } from "./postgres-reclamation.js";
import { assertReclamationSurvivorInvariants } from "./postgres-reclamation-validation.js";
import {
  type BackendState,
  decodeHashStringArray,
  loadState,
} from "./postgres-records.js";
import { createCoreRepositories } from "./postgres-repositories-core.js";
import { createSupportRepositories } from "./postgres-repositories-support.js";
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
} from "./postgres-run-invariants.js";
import { RELATIONAL_REQUIRED_TABLES } from "./postgres-schema.js";
import {
  ensurePostgresRelationalSchemaInitialized,
  validateRelationalSchemaPosture,
} from "./postgres-schema-init.js";
import type { DbSql } from "./postgres-sql.js";
import {
  assertPostgresStorableText,
  deriveAdvisoryLockKey,
  qualifyIdentifier,
  quoteIdentifier,
} from "./postgres-sql.js";
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
} from "./postgres-state-utils.js";
import {
  validateCommittedState,
  validateLoadedState,
} from "./postgres-state-validation.js";
import {
  validateTransactionWriteSet,
  validateTurnNodeLineageRootIndex,
} from "./postgres-transaction-validation.js";
import { TransactionWriteTracker } from "./postgres-write-tracker.js";

/**
 * Ordered paths with at most this many items stay inline (`flat` encoding);
 * crossing it promotes the path to `chunked` encoding.
 */
const ORDERED_PATH_CHUNK_THRESHOLD = 32;

/**
 * Keys per reclamation `DELETE ... ANY(...)` statement. Each statement binds
 * only two parameters (the scope and one text[]), so this is not a
 * bind-limit guard: it caps per-statement work so a huge sweep is many
 * modest deletes (bounded row-lock footprint, plannable array sizes)
 * instead of one giant one.
 */
const RECLAMATION_DELETE_BATCH_SIZE = 500;

/**
 * Upper bound on waiting for the same-scope advisory lock, mirroring the
 * SQLite backend's `SQLITE_BUSY_TIMEOUT_MS = 5000` bounded-wait semantics:
 * a second instance contending for the same `(schemaName, scope)` partition
 * fails with a normalized persistence error instead of blocking its only
 * pooled connection forever behind a wedged peer transaction.
 */
const SCOPE_LOCK_TIMEOUT_MS = 5000;

/** A reserved single connection from the pool, released after use. */
type ReservedSql = Sql & { release(): Promise<void> };

/** A transaction's repository surface, plus the transaction-local clock it was built with. */
interface MutableRepositories extends KrakenBackendTx {
  readonly now: () => number;
}

/**
 * Test/conformance fault-injection hooks around the commit sequence
 * (`FAULT_INJECTION_CONTROL`); see {@link BackendFaultInjectionControl}.
 */
interface BackendFaultHooks {
  afterCommitBeforeAck?(): Promise<void>;
  beforeCommit?(): Promise<void>;
  midCommit?(commit: () => Promise<void>): Promise<void>;
}

/**
 * Internal fault-injection control surface exposed on the backend instance
 * under the `FAULT_INJECTION_CONTROL` symbol, for the shared kernel testkit
 * fault harness to install {@link BackendFaultHooks} and
 * discover which named fault points this backend supports.
 */
interface BackendFaultInjectionControl {
  setFaultHooks(hooks: BackendFaultHooks | null): void;
  supportsFaultPoint(point: string): boolean;
}

/** Options for {@link PostgresBackend.destroy}. */
interface PostgresBackendDestroyOptions {
  /** When `true`, drops the backend's schema entirely after closing the connection. */
  dropSchema?: boolean;
}

/** Construction options for {@link createPostgresBackend}. */
export type PostgresBackendOptions = PostgresBackendPersistenceOptions;

const POSTGRES_BACKEND_CAPABILITIES: BackendCapability = {
  "maintenance.reclamation": true,
  // Shared rendezvous for more than one execution owner: the kernel defers to
  // this backend's own per-transaction clock for run-lease stamping and expiry
  // comparison (ADR-050, kernel spec §5.2), exposed via RuntimeBackendTx.now.
  "shared-lease-clock": true,
  "thread.enumeration": true,
};
const FAULT_INJECTION_CONTROL = Symbol(
  "tuvren.kernel.testkit.fault-injection-control"
);

/**
 * `RuntimeBackend` implementation over a relational PostgreSQL schema
 * (ADR-067 / issue #110): one table per record family, one row per item,
 * Scope isolation via a `scope` column on every key (ADR-048/049). Mutating
 * operations serialize on this instance's in-process `transactionQueue` and
 * then take a reserved connection with `BEGIN`/`COMMIT`, so same-process
 * contention is ordered by the queue while multi-worker contention is
 * resolved by PostgreSQL transaction isolation and deferred foreign keys.
 */
class PostgresBackend implements KrakenBackend {
  readonly [FAULT_INJECTION_CONTROL]: BackendFaultInjectionControl = {
    setFaultHooks: (hooks) => {
      this.faultState.hooks = hooks;
    },
    supportsFaultPoint: (point) =>
      point === "before-commit" ||
      point === "mid-commit" ||
      point === "after-commit-before-ack",
  };

  private readonly connectionOptions: PostgresBackendPersistenceOptions;
  private destroyed = false;
  private readonly faultState: { hooks: BackendFaultHooks | null } = {
    hooks: null,
  };
  private initializationPromise: Promise<void> | undefined;
  private readonly phaseObserver: PhaseObserver;
  private readonly schemaName: string;
  private readonly scope: Scope;
  private readonly sql: Sql;
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionQueue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly injectedNow: (() => number) | undefined;
  private readonly scopeLockKey: bigint;

  constructor(options?: PostgresBackendOptions) {
    const resolvedOptions = options ?? {};

    this.connectionOptions = { ...resolvedOptions };
    this.schemaName = normalizeSchemaName(resolvedOptions.schemaName);
    this.scope = resolvedOptions.scope ?? DEFAULT_SCOPE;
    assertScope(this.scope);
    // assertScope only rejects an empty string; a scope carrying U+0000
    // would otherwise reach every family table's `scope` column as a
    // caller-supplied TEXT value (ADR-048/049), so it needs the same
    // boundary check every other caller-supplied identifier field gets.
    assertPostgresStorableText(this.scope, "scope");
    this.scopeLockKey = deriveAdvisoryLockKey(
      "tuvren-postgres-scope",
      this.schemaName,
      this.scope
    );
    this.sql = createPostgresClient(resolvedOptions);
    this.phaseObserver = resolvedOptions.phaseObserver ?? NOOP_PHASE_OBSERVER;
    this.now = resolvedOptions.now ?? Date.now;
    // Track whether a clock was explicitly injected so the per-transaction
    // authoritative lease clock can fall back to the PostgreSQL server clock in
    // production while staying deterministic under an injected clock (ADR-050).
    this.injectedNow = resolvedOptions.now;
  }

  /** Reports the fixed {@link POSTGRES_BACKEND_CAPABILITIES} this backend supports. */
  capabilities(): BackendCapability {
    return POSTGRES_BACKEND_CAPABILITIES;
  }

  /**
   * Lightweight liveness/coherence probe (issue #108 M5). Initializes the
   * schema if needed, validates the schema's durable posture (migration
   * ledger, family tables, indexes — the relational equivalent of the
   * SQLite backend's `validateMigrationState`), and proves this Scope's
   * partition is queryable — without loading full state.
   */
  async health(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.ensureInitialized();
      await validateRelationalSchemaPosture(this.sql, this.schemaName);
      const objectsTable = qualifyIdentifier(this.schemaName, "objects");
      await this.sql.unsafe(
        `SELECT 1 FROM ${objectsTable} WHERE scope = $1 LIMIT 1`,
        [this.scope]
      );
      return { ok: true };
    } catch (error: unknown) {
      return {
        ok: false,
        reason: getErrorMessage(normalizeBackendError(error)),
      };
    }
  }

  /**
   * Git-fsck-style maintenance validation (issue #108 M5): loads and fully
   * validates the Scope's committed relational state inside a rolled-back
   * read-only transaction. Serialized on the in-process transaction queue
   * against this instance's own writers, and run under `REPEATABLE READ` so
   * the 13 family selects all read one snapshot — a concurrent writer on
   * another instance can never yield a torn projection that reports
   * spurious corruption (the consistency the SQLite port's `BEGIN
   * IMMEDIATE` provided, achieved here without blocking those writers).
   */
  async fsck(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      return await this.withSerializedConnection(async (reserved) => {
        let inTransaction = false;

        try {
          await reserved.unsafe(
            "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY"
          );
          inTransaction = true;
          await loadValidatedState(
            reserved,
            this.schemaName,
            this.scope,
            this.phaseObserver
          );
          await reserved.unsafe("ROLLBACK");
          inTransaction = false;
          return { ok: true } as const;
        } catch (error: unknown) {
          if (inTransaction) {
            try {
              await reserved.unsafe("ROLLBACK");
            } catch {
              // Prefer the original validation error.
            }
          }
          return {
            ok: false as const,
            reason: getErrorMessage(normalizeBackendError(error)),
          };
        }
      });
    } catch (error: unknown) {
      return {
        ok: false,
        reason: getErrorMessage(normalizeBackendError(error)),
      };
    }
  }

  /** Closes the underlying connection pool. Idempotent. */
  async close(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    try {
      await this.sql.end({ timeout: 0 });
    } finally {
      this.destroyed = true;
      this.initializationPromise = undefined;
    }
  }

  /**
   * Closes the connection pool and, when `options.dropSchema` is `true`,
   * also drops this backend's entire PostgreSQL schema. Intended for
   * test/conformance teardown of throwaway schemas.
   */
  async destroy(options?: PostgresBackendDestroyOptions): Promise<void> {
    await this.close();

    if (options?.dropSchema === true) {
      await this.dropSchema();
    }
  }

  /**
   * Runs `work` inside a serialized `BEGIN`/`COMMIT` transaction against the
   * relational schema. A write tracker records every row the transaction
   * touches; after `work` resolves, the tracked write set is re-validated
   * against the database before `COMMIT`. The transaction's `now` is a single
   * authoritative timestamp captured once at the start (the injected clock
   * under test, otherwise the PostgreSQL server clock — ADR-050).
   *
   * @throws TuvrenPersistenceError `postgres_backend_nested_transaction` when
   *   called from inside another transaction on this instance.
   */
  async transact<T>(work: (tx: KrakenBackendTx) => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore() === true) {
      throw persistenceError(
        "postgres backend transactions must not be nested",
        "postgres_backend_nested_transaction"
      );
    }

    return await this.withSerializedConnection(async (reserved) => {
      let inTransaction = false;
      let active = false;

      try {
        await reserved.unsafe("BEGIN");
        inTransaction = true;
        // Same-scope multi-instance serialization (ADR-067 v1): transaction-
        // scoped advisory lock keyed by (schemaName, scope). Replaces the
        // blob-era `SELECT ... FOR UPDATE` on the single snapshot row so two
        // independent backend instances still cannot interleave writes to
        // the same Scope (plan: keep SQLite-equivalent single-writer-per-
        // scope until a later multi-writer design).
        await this.acquireScopeTransactionLock(reserved);

        // Backend-authoritative lease clock (ADR-050): capture one authoritative
        // timestamp per transaction — the injected clock when supplied
        // (tests/conformance), else the PostgreSQL server clock.
        const txNow = await this.resolveTransactionNow(reserved);
        const writeTracker = new TransactionWriteTracker();
        active = true;
        const repositories = createRepositories(
          reserved,
          this.schemaName,
          this.scope,
          () => txNow,
          () => active && this.transactionContext.getStore() === true,
          writeTracker
        );

        const result = await this.transactionContext.run(true, () =>
          work(repositories)
        );
        active = false;

        const endValidateWriteSet =
          this.phaseObserver.startPhase("validate-write-set");
        try {
          await validateTransactionWriteSet(
            reserved,
            this.schemaName,
            this.scope,
            writeTracker
          );
        } finally {
          endValidateWriteSet();
        }

        await this.faultState.hooks?.beforeCommit?.();

        let committed = false;
        const commit = async (): Promise<void> => {
          if (committed) {
            throw new Error(
              "postgres backend commit hook attempted double commit"
            );
          }

          const endCommitWrite = this.phaseObserver.startPhase("write");
          try {
            await reserved.unsafe("COMMIT");
          } finally {
            endCommitWrite();
          }
          inTransaction = false;
          committed = true;
        };

        if (this.faultState.hooks?.midCommit === undefined) {
          await commit();
        } else {
          await this.faultState.hooks.midCommit(commit);

          if (!committed) {
            throw new Error(
              "postgres backend mid-commit hook must call commit exactly once"
            );
          }
        }

        await this.faultState.hooks?.afterCommitBeforeAck?.();
        return result;
      } catch (error: unknown) {
        active = false;
        if (inTransaction) {
          try {
            await reserved.unsafe("ROLLBACK");
          } catch {
            // Prefer the original error (matching fsck): a failed ROLLBACK
            // almost always means the connection itself died, which the
            // next statement on this reserved connection will surface with
            // its own normalized error.
          }
        }
        throw normalizeBackendError(error);
      }
    });
  }

  /**
   * Runs the §9.4 reachability reclamation sweep in one serialized
   * transaction: load and validate state, sweep the in-memory projection,
   * mirror removed keys as batched row deletions (with deferred FKs), then
   * assert survivor invariants before `COMMIT`.
   *
   * @throws TuvrenPersistenceError `postgres_backend_nested_transaction` when
   *   called from inside a transaction on this instance.
   */
  async reclaim(options?: ReclamationOptions): Promise<ReclamationSummary> {
    if (this.transactionContext.getStore() === true) {
      throw persistenceError(
        "postgres backend reclamation must not run inside a transaction",
        "postgres_backend_nested_transaction"
      );
    }

    return await this.withSerializedConnection(async (reserved) => {
      let inTransaction = false;

      try {
        await reserved.unsafe("BEGIN");
        inTransaction = true;
        await this.acquireScopeTransactionLock(reserved);

        const state = await loadValidatedState(
          reserved,
          this.schemaName,
          this.scope,
          this.phaseObserver
        );
        const survivorKeysBefore = captureReclamationKeys(state);
        // Reachability and the grace horizon's pinning value are derived from
        // the loaded state's own active runs (§9.4); reclaimBackendState
        // mutates the in-memory projection so the surviving key sets reveal
        // exactly what to delete. The clock argument lets a leaseless running
        // run whose updatedAtMs has gone quiet past the administrative expiry
        // horizon (KRT-BK002, ADR-050/ADR-051) be excluded from pinning that
        // horizon.
        const summary = reclaimBackendState(
          state,
          options?.nowMs ?? this.now()
        );

        const endDeleteWrite = this.phaseObserver.startPhase("write");
        try {
          await applyReclamationDeletions(
            reserved,
            this.schemaName,
            this.scope,
            survivorKeysBefore,
            state
          );
        } finally {
          endDeleteWrite();
        }

        const endValidateSurvivors = this.phaseObserver.startPhase(
          "validate-reclaim-survivors"
        );
        try {
          assertReclamationSurvivorInvariants(state);
        } finally {
          endValidateSurvivors();
        }

        const endCommitWrite = this.phaseObserver.startPhase("write");
        try {
          await reserved.unsafe("COMMIT");
        } finally {
          endCommitWrite();
        }
        inTransaction = false;
        return summary;
      } catch (error: unknown) {
        if (inTransaction) {
          try {
            await reserved.unsafe("ROLLBACK");
          } catch {
            // Prefer the original error (matching fsck): a failed ROLLBACK
            // almost always means the connection itself died, which the
            // next statement on this reserved connection will surface with
            // its own normalized error.
          }
        }
        throw normalizeBackendError(error);
      }
    });
  }

  /**
   * Deletes every family row for this Scope (full tenant offboarding, kernel
   * spec §9.4). Other Scopes' rows in the shared schema are untouched. Does
   * not require a snapshot row — the relational model has no whole-scope
   * blob. The instance should be discarded afterward per the purgeScope
   * contract.
   *
   * @throws TuvrenPersistenceError `postgres_backend_nested_transaction` when
   *   called from inside a transaction on this instance.
   */
  async purgeScope(): Promise<void> {
    if (this.transactionContext.getStore() === true) {
      throw persistenceError(
        "postgres backend scope purge must not run inside a transaction",
        "postgres_backend_nested_transaction"
      );
    }

    await this.withSerializedConnection(async (reserved) => {
      let inTransaction = false;

      try {
        await reserved.unsafe("BEGIN");
        inTransaction = true;
        await this.acquireScopeTransactionLock(reserved);
        // The shared roster is ordered children-first; deferred FKs make
        // the order non-load-bearing. Using the roster (not a local copy)
        // means a new family table cannot be missed here and leak rows
        // across a tenant purge.
        for (const tableName of RELATIONAL_REQUIRED_TABLES) {
          const table = qualifyIdentifier(this.schemaName, tableName);
          await reserved.unsafe(`DELETE FROM ${table} WHERE scope = $1`, [
            this.scope,
          ]);
        }
        await reserved.unsafe("COMMIT");
        inTransaction = false;
      } catch (error: unknown) {
        if (inTransaction) {
          try {
            await reserved.unsafe("ROLLBACK");
          } catch {
            // Prefer the original error (matching fsck): a failed ROLLBACK
            // almost always means the connection itself died, which the
            // next statement on this reserved connection will surface with
            // its own normalized error.
          }
        }
        throw normalizeBackendError(error);
      }
    });
  }

  /**
   * Shared serialization prologue/epilogue for every operation that needs
   * exclusive use of the pool's single connection: waits its turn on the
   * in-process transaction queue (charged to `lock-wait`), reserves the
   * connection for `body`, and releases both in reverse order. Extracted so
   * `transact`, `reclaim`, `purgeScope`, and `fsck` cannot drift apart in
   * how they queue and reserve.
   */
  private async withSerializedConnection<T>(
    body: (reserved: ReservedSql) => Promise<T>
  ): Promise<T> {
    await this.ensureInitialized();

    const priorTransaction = this.transactionQueue;
    let releaseQueue: (() => void) | undefined;

    this.transactionQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    const endQueueWait = this.phaseObserver.startPhase("lock-wait");
    await priorTransaction;
    endQueueWait();

    try {
      const reserved = (await this.sql.reserve()) as ReservedSql;

      try {
        return await body(reserved);
      } finally {
        await reserved.release();
      }
    } finally {
      releaseQueue?.();
    }
  }

  /**
   * Transaction-scoped advisory lock for this instance's (schemaName, scope)
   * partition. Blocks concurrent same-scope writers across backend instances
   * until COMMIT/ROLLBACK releases the lock. The wait is bounded by
   * {@link SCOPE_LOCK_TIMEOUT_MS} via `SET LOCAL lock_timeout` (which then
   * governs the rest of the transaction too — harmless, since same-scope row
   * contention is already excluded by holding this lock). The key is a
   * bigint derived client-side from SHA-256 (see {@link deriveAdvisoryLockKey}),
   * safe to inline; the no-parameter multi-statement form keeps this on one
   * round trip.
   */
  private async acquireScopeTransactionLock(sql: DbSql): Promise<void> {
    const endLockWait = this.phaseObserver.startPhase("lock-wait");
    try {
      await sql.unsafe(
        `SET LOCAL lock_timeout = '${SCOPE_LOCK_TIMEOUT_MS}ms'; SELECT pg_advisory_xact_lock(${this.scopeLockKey})`
      );
    } finally {
      endLockWait();
    }
  }

  /**
   * Resolves the single authoritative clock reading for a transaction: the
   * injected clock when one was supplied at construction, otherwise the
   * live PostgreSQL server clock (ADR-050 shared-rendezvous clock for a
   * multi-worker deployment).
   */
  private async resolveTransactionNow(reserved: Sql): Promise<number> {
    if (this.injectedNow !== undefined) {
      return this.injectedNow();
    }

    return await readBackendClockMs(reserved);
  }

  /**
   * Lazily provisions this schema's relational tables exactly once per
   * instance, memoizing the in-flight promise so concurrent callers await
   * the same initialization. A failed attempt clears the memoized promise
   * so the next call retries instead of replaying the failure forever.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initializationPromise === undefined) {
      const initialization = ensurePostgresRelationalSchemaInitialized(
        this.sql,
        this.schemaName,
        this.now,
        this.phaseObserver
      );
      const retryableInitialization = initialization.catch((error: unknown) => {
        if (this.initializationPromise === retryableInitialization) {
          this.initializationPromise = undefined;
        }

        throw error;
      });

      this.initializationPromise = retryableInitialization;
    }

    await this.initializationPromise;
  }

  /** Drops this backend's schema via {@link destroyPostgresBackend}, using a fresh connection. */
  private async dropSchema(): Promise<void> {
    await destroyPostgresBackend(this.connectionOptions);
  }
}

/**
 * Builds a `RuntimeBackend` over the relational PostgreSQL schema for the
 * Scope named in `options.scope` (or the default Scope). Schema/table
 * provisioning is deferred to the first call that needs it.
 *
 * The return type widens `KrakenBackend` with this backend's own
 * maintenance/lifecycle surface (mirroring {@link createSqliteBackend}'s
 * `close`/`fsck` intersection, plus this backend's `destroy`) so callers
 * reach `close()`, `destroy()`, and `fsck()` without an unsound cast.
 */
export function createPostgresBackend(
  options?: PostgresBackendOptions
): KrakenBackend & {
  close(): Promise<void>;
  destroy(options?: { dropSchema?: boolean }): Promise<void>;
  fsck(): Promise<{ ok: true } | { ok: false; reason: string }>;
} {
  return new PostgresBackend(options);
}

/**
 * Drops the postgres schema named in `options.schemaName` using a fresh
 * short-lived connection. Safe to call after the backend's own pool has been
 * closed. Intended for test/conformance teardown of throwaway schemas.
 */
export async function destroyPostgresBackend(
  options: PostgresBackendOptions
): Promise<void> {
  const schemaName = normalizeSchemaName(options.schemaName);
  const cleanupClient = createPostgresClient(options);
  try {
    await cleanupClient.unsafe(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`
    );
  } finally {
    await cleanupClient.end({ timeout: 0 });
  }
}

/**
 * Builds the per-transaction repository surface over the open connection by
 * composing the core and support repository factories with their
 * Postgres-specific helper dependencies.
 */
function createRepositories(
  sql: DbSql,
  schemaName: string,
  scope: string,
  now: () => number,
  isTransactionActive: () => boolean,
  writeTracker: TransactionWriteTracker
): MutableRepositories {
  const assertTransactionActive = (): void => {
    if (!isTransactionActive()) {
      throw persistenceError(
        "postgres backend transaction handles must not outlive their transaction",
        "postgres_backend_inactive_transaction_handle"
      );
    }
  };

  return {
    now,
    ...createSupportRepositories(
      {
        assertTransactionActive,
        schemaName,
        scope,
        sql,
        writeTracker,
      },
      {
        areStoredObjectsEqual,
        areStoredSchemasEqual,
        areStoredStagedResultsEqual,
        areStoredThreadsEqual,
        assertStoredObjectIdentity,
        assertStoredOrderedPathChunkIdentity,
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
        now,
        schemaName,
        scope,
        sql,
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

/**
 * Loads the Scope's full state projection and runs the maintenance validation
 * suite used by `fsck()` and `reclaim()`: the schema's durable posture
 * (mirroring the SQLite backend's `validateMigrationState` gate — a dropped
 * required index or a collation/deferred-FK drift is caught here, not just
 * by `health()`), per-record shape/identity, the derived lineage-root index,
 * and the committed-state invariant suite.
 */
async function loadValidatedState(
  sql: DbSql,
  schemaName: string,
  scope: string,
  phaseObserver: PhaseObserver = NOOP_PHASE_OBSERVER
): Promise<BackendState> {
  await validateRelationalSchemaPosture(sql, schemaName);

  const endLoad = phaseObserver.startPhase("load");
  let state: BackendState;
  try {
    state = await loadState(sql, schemaName, scope);
  } finally {
    endLoad();
  }

  const endValidateLoaded = phaseObserver.startPhase("validate-loaded");
  try {
    await validateLoadedState(state);
  } finally {
    endValidateLoaded();
  }

  const endValidateLineageIndex = phaseObserver.startPhase(
    "validate-lineage-index"
  );
  try {
    await validateTurnNodeLineageRootIndex(sql, schemaName, scope, state);
  } finally {
    endValidateLineageIndex();
  }

  const endValidateCommitted = phaseObserver.startPhase("validate-committed");
  try {
    // Maintenance validation has no prior in-memory generation to diff
    // against, so the state is validated against itself: the transition
    // checks degrade to identity (always legal) and what remains is the
    // full standing-invariant suite, matching the SQLite maintenance paths.
    validateCommittedState(state, state, {
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
  } finally {
    endValidateCommitted();
  }

  return state;
}

/**
 * Snapshot of every reclaimable record family's keys taken before the
 * in-memory sweep, so the swept projection can be diffed into row deletions.
 */
interface ReclamationSurvivorKeys {
  branches: Set<string>;
  objects: Set<string>;
  orderedPathChunks: Set<string>;
  runs: Set<string>;
  turnNodes: Set<string>;
  turns: Set<string>;
  turnTrees: Set<string>;
}

/** Captures the pre-sweep key sets for {@link applyReclamationDeletions}. */
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
async function applyReclamationDeletions(
  sql: DbSql,
  schemaName: string,
  scope: string,
  before: ReclamationSurvivorKeys,
  survivors: BackendState
): Promise<void> {
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

  await deleteByColumn(
    sql,
    schemaName,
    scope,
    "staged_results",
    "run_id",
    deletedRunIds
  );
  await deleteByColumn(
    sql,
    schemaName,
    scope,
    "observe_annotations",
    "run_id",
    deletedRunIds
  );
  await deleteByColumn(sql, schemaName, scope, "runs", "run_id", deletedRunIds);
  await deleteByColumn(
    sql,
    schemaName,
    scope,
    "turns",
    "turn_id",
    deletedTurnIds
  );
  await deleteByColumn(
    sql,
    schemaName,
    scope,
    "branches",
    "branch_id",
    deletedBranchIds
  );
  await deleteByColumn(
    sql,
    schemaName,
    scope,
    "turn_tree_paths",
    "turn_tree_hash",
    deletedTurnTreeHashes
  );
  await deleteByColumn(
    sql,
    schemaName,
    scope,
    "turn_trees",
    "hash",
    deletedTurnTreeHashes
  );
  await deleteByColumn(
    sql,
    schemaName,
    scope,
    "turn_node_lineage_roots",
    "turn_node_hash",
    deletedTurnNodeHashes
  );
  await deleteByColumn(
    sql,
    schemaName,
    scope,
    "turn_nodes",
    "hash",
    deletedTurnNodeHashes
  );
  await deleteByColumn(
    sql,
    schemaName,
    scope,
    "ordered_path_chunks",
    "chunk_hash",
    deletedChunkHashes
  );
  await deleteByColumn(
    sql,
    schemaName,
    scope,
    "objects",
    "hash",
    deletedObjectHashes
  );
}

/**
 * Deletes rows for this Scope whose column matches one of `keys`, batched.
 * `table` and `column` are fixed internal identifiers, never caller input.
 */
async function deleteByColumn(
  sql: DbSql,
  schemaName: string,
  scope: string,
  table: string,
  column: string,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  const qualified = qualifyIdentifier(schemaName, table);

  for (
    let index = 0;
    index < keys.length;
    index += RECLAMATION_DELETE_BATCH_SIZE
  ) {
    const batch = keys.slice(index, index + RECLAMATION_DELETE_BATCH_SIZE);
    await sql.unsafe(
      `DELETE FROM ${qualified} WHERE scope = $1 AND ${quoteIdentifier(column)} = ANY($2::text[])`,
      [scope, batch]
    );
  }
}

/**
 * Normalizes an incoming turn-tree path record to its canonical stored
 * encoding, resolving chunk references against the database: `single` and
 * small ordered paths pass through; a flat ordered path above the promotion
 * threshold is rewritten to `chunked` encoding.
 */
async function normalizeStoredTurnTreePathInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
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
        "postgres_backend_chunked_turn_tree_path_below_threshold",
        {
          orderedCount: record.orderedCount,
          threshold: ORDERED_PATH_CHUNK_THRESHOLD,
        }
      );
    }

    let totalCount = 0;
    for (const [index, chunkHash] of chunkHashes.entries()) {
      const chunk = await selectOrderedPathChunk(
        sql,
        schemaName,
        scope,
        chunkHash
      );
      if (chunk === null) {
        throw persistenceError(
          "chunked turn tree paths must reference existing chunk records",
          "postgres_backend_missing_ordered_path_chunk_reference",
          { chunkHash, path: record.path, turnTreeHash: record.turnTreeHash }
        );
      }

      assertChunkedTurnTreePathChunkLayout(chunk, index, chunkHashes.length);
      totalCount += chunk.itemCount;
    }

    if (totalCount !== record.orderedCount) {
      throw persistenceError(
        "chunked turn tree paths must agree with the stored chunk cardinality",
        "postgres_backend_chunked_turn_tree_path_count_mismatch",
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
    const existingChunk = await selectOrderedPathChunk(
      sql,
      schemaName,
      scope,
      chunkHash
    );
    const chunkRecord: StoredOrderedPathChunk = {
      chunkHash,
      createdAtMs: existingChunk?.createdAtMs ?? now(),
      itemCount: chunkItems.length,
      itemsCbor,
    };

    await insertOrderedPathChunk(sql, schemaName, scope, chunkRecord);
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

/**
 * Inserts a content-addressed ordered-path chunk row, or verifies byte-level
 * equality against the existing row for the same hash (immutable put).
 */
async function insertOrderedPathChunk(
  sql: DbSql,
  schemaName: string,
  scope: string,
  record: StoredOrderedPathChunk
): Promise<void> {
  const existing = await selectOrderedPathChunk(
    sql,
    schemaName,
    scope,
    record.chunkHash
  );

  if (existing !== null) {
    ensureImmutableRecordMatch(
      existing,
      record,
      areStoredOrderedPathChunksEqual,
      "ordered path chunk"
    );
    return;
  }

  const table = qualifyIdentifier(schemaName, "ordered_path_chunks");
  await sql.unsafe(
    `
      INSERT INTO ${table} (
        scope,
        chunk_hash,
        item_count,
        items_cbor,
        created_at_ms
      ) VALUES ($1, $2, $3, $4, $5)
    `,
    [
      scope,
      record.chunkHash,
      record.itemCount,
      record.itemsCbor,
      record.createdAtMs,
    ]
  );
}

/**
 * Encodes a hash array as deterministic CBOR, validating every element first
 * so only well-formed hash strings are ever persisted.
 */
function encodeHashStringArray(hashes: string[]): Uint8Array {
  return encodeDeterministicKernelRecord(
    hashes.map((hash) => validateHashString(hash))
  );
}

/**
 * Reads the PostgreSQL server's current wall-clock time (`clock_timestamp()`)
 * as epoch milliseconds, once per transaction, for the ADR-050 shared
 * rendezvous clock.
 */
async function readBackendClockMs(reserved: Sql): Promise<number> {
  const rows = await reserved.unsafe<Array<{ now_ms: string }>>(
    "SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms"
  );
  const rawNowMs = rows[0]?.now_ms;

  if (rawNowMs === undefined) {
    throw persistenceError(
      "postgres backend could not read the server clock",
      "postgres_backend_clock_unavailable"
    );
  }

  const nowMs = Number(rawNowMs);

  if (!Number.isSafeInteger(nowMs)) {
    throw persistenceError(
      "postgres backend server clock is out of safe-integer range",
      "postgres_backend_clock_unsafe_integer",
      { rawNowMs: String(rawNowMs) }
    );
  }

  return nowMs;
}
