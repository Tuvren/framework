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
  assertStoredBranch,
  assertStoredObject,
  assertStoredObjectIdentity,
  assertStoredObserveAnnotation,
  assertStoredOrderedPathChunk,
  assertStoredOrderedPathChunkIdentity,
  assertStoredRun,
  assertStoredSchema,
  assertStoredStagedResult,
  assertStoredThread,
  assertStoredTurn,
  assertStoredTurnNode,
  assertStoredTurnNodeIdentity,
  assertStoredTurnTree,
  assertStoredTurnTreeIdentity,
  assertStoredTurnTreePath,
  type BackendCapability,
  type RuntimeBackend as KrakenBackend,
  type RuntimeBackendTx as KrakenBackendTx,
  type ListThreadsCursorPayload,
  type ReclamationOptions,
  type ReclamationSummary,
  type StoredBranch,
  type StoredRun,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import type { Sql } from "postgres";
import {
  assertBranchHeadMoveIsLinear,
  assertRunStartTurnNodeWithinTurnSpan,
  assertTurnNodeBelongsToThread,
  assertTurnNodeDescendsFrom,
  decodeTurnNodeConsumedStagedResultObjectHashes,
} from "./memory-backend-lineage.js";
import { reclaimBackendState } from "./memory-backend-reclamation.js";
import {
  areStoredObjectsEqual,
  areStoredOrderedPathChunksEqual,
  areStoredSchemasEqual,
  areStoredStagedResultsEqual,
  areStoredThreadsEqual,
  areStoredTurnNodesEqual,
  areStoredTurnTreePathsEqual,
  areStoredTurnTreesEqual,
  assertImmutableField,
  assertImmutableOptionalField,
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
  ensureBranchExists,
  ensureImmutableRecordMatch,
  ensureObjectExists,
  ensureRunExists,
  ensureSchemaRecordExists,
  ensureThreadExists,
  ensureTurnExists,
  ensureTurnNodeExists,
  ensureTurnTreeExists,
  isExpiredLeasedRunningRun,
  persistenceError,
  putImmutableRecord,
} from "./memory-backend-record-utils.js";
import {
  assertMonotonicUpdatedAtMs,
  assertRunUpdateIsLegal,
} from "./memory-backend-run-logic.js";
import { validateCommittedState } from "./memory-backend-state.js";
import {
  cloneState,
  getSchemaForSchemaId,
  getSchemaForTurnTree,
  listTurnsByThread,
  normalizeStoredTurnTreePath,
} from "./memory-backend-turn-tree.js";
import type { BackendState } from "./memory-backend-types.js";
import {
  checkPersistedStateLiveness,
  createPostgresClient,
  deletePersistedStateSnapshot,
  ensurePostgresSchemaInitialized,
  loadPersistedStateForUpdate,
  normalizeSchemaName,
  type PostgresBackendPersistenceOptions,
  persistStateSnapshot,
} from "./postgres-backend-persistence.js";
import {
  createSnapshotStateCache,
  type SnapshotCacheObserver,
  type SnapshotStateCache,
} from "./postgres-backend-snapshot-cache.js";

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
export interface PostgresBackendOptions
  extends PostgresBackendPersistenceOptions {}

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
 * `RuntimeBackend` implementation over a single PostgreSQL snapshot row per
 * Scope. Every mutating operation (`transact`, `reclaim`, `purgeScope`)
 * serializes on this instance's own in-process `transactionQueue` and then
 * takes a reserved connection with `SELECT ... FOR UPDATE` on the Scope's
 * row, so cross-process contention on the same Scope is resolved by
 * PostgreSQL row locking while same-process contention is resolved by the
 * queue.
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
  // Issue #108 M3 (A3 content-hash memoization): one single-entry cache per
  // instance, since one instance is bound to exactly one Scope's row
  // (ADR-048/ADR-049). Populated/consulted by every loadPersistedStateForUpdate
  // call and updated only after a transact()/reclaim() COMMIT actually
  // succeeds -- never from inside the transaction body -- so a rolled-back
  // draft can never become the cached committed state (see transact()/
  // reclaim()'s commit sequencing for why that placement is safe).
  private readonly snapshotCache: SnapshotStateCache =
    createSnapshotStateCache();
  private readonly snapshotCacheObserver: SnapshotCacheObserver | undefined;
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionQueue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly injectedNow: (() => number) | undefined;

  constructor(options?: PostgresBackendOptions) {
    const resolvedOptions = options ?? {};

    this.connectionOptions = { ...resolvedOptions };
    this.schemaName = normalizeSchemaName(resolvedOptions.schemaName);
    this.scope = resolvedOptions.scope ?? DEFAULT_SCOPE;
    assertScope(this.scope);
    this.sql = createPostgresClient(resolvedOptions);
    this.phaseObserver = resolvedOptions.phaseObserver ?? NOOP_PHASE_OBSERVER;
    this.snapshotCacheObserver = resolvedOptions.snapshotCacheObserver;
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
   * Scope's schema if needed, then confirms the connection can execute a
   * query and the Scope's snapshot row exists with a `schema_version` this
   * package version supports ({@link checkPersistedStateLiveness}) —
   * without loading, decoding, or validating the row's `snapshot_cbor`
   * bytes at all. Deliberately does NOT run the full committed-state
   * invariant suite: `RuntimeBackend.health()`'s contract
   * (kernel-protocol's `kernel-types.ts`) only promises "can serve
   * traffic", no conformance plan requires a full re-validation on every
   * call, and every `transact()`/`reclaim()` call already re-validates its
   * own draft against `validateCommittedState` before `COMMIT`. The full
   * decode+validate pass this method used to run on every call is still
   * available on demand via {@link fsck} — the Git-fsck analogy this split
   * is named for: `git fsck` is occasional maintenance, never run on every
   * read, but the repository's integrity guarantee does not depend on it
   * running on every read either.
   */
  async health(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.ensureInitialized();
      await checkPersistedStateLiveness(this.sql, this.schemaName, this.scope);
      return { ok: true };
    } catch (error: unknown) {
      return {
        ok: false,
        reason: readErrorMessage(error),
      };
    }
  }

  /**
   * Git-fsck-style maintenance validation (issue #108 M5): loads the
   * Scope's full committed snapshot and re-validates it against itself as
   * both draft and base state — exactly what `health()` ran on every call
   * before M5. This is now a deliberate maintenance action a host calls
   * occasionally, not part of the hot read path `health()` serves. The
   * guarantee this replaces is preserved, not weakened: every
   * `transact()`/`reclaim()` call already re-validates its own write against
   * the full committed-state invariant suite before `COMMIT` regardless of
   * whether `fsck()` is ever called; `fsck()` exists to additionally catch
   * corruption introduced outside the backend's own write path (e.g. direct
   * database tampering, or a bug in a different writer).
   */
  async fsck(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.ensureInitialized();
      await this.sql.begin(async (tx): Promise<void> => {
        const state = await loadPersistedStateForUpdate(
          tx,
          this.schemaName,
          this.scope,
          {
            cache: this.snapshotCache,
            cacheObserver: this.snapshotCacheObserver,
            phaseObserver: this.phaseObserver,
          }
        );
        const endValidate = this.phaseObserver.startPhase("validate");
        try {
          validateCommittedState(state, state);
        } finally {
          endValidate();
        }
      });
      return { ok: true };
    } catch (error: unknown) {
      return {
        ok: false,
        reason: readErrorMessage(error),
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
   * Runs `work` against a fresh copy-on-write draft of the Scope's committed
   * snapshot: loads and row-locks the snapshot, clones it into a draft,
   * exposes repositories over the draft to `work`, validates the resulting
   * draft against the full committed-state invariant suite, then persists
   * the draft and commits — so a caller never observes a partially
   * validated write. Transactions on this instance are serialized (no
   * nesting) via `transactionQueue`; the transaction's `now` is a single
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

    await this.ensureInitialized();

    const priorTransaction = this.transactionQueue;
    let releaseQueue: (() => void) | undefined;

    this.transactionQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    // The in-process queue wait is the first component of "lock-wait":
    // another transact()/reclaim()/purgeScope() call on this instance may
    // already be in flight, and this call cannot proceed until it releases
    // the queue.
    // Deliberately outside try/finally: `priorTransaction` is the queue's own
    // release promise, constructed above from a `Promise` executor that only
    // ever calls `resolve`, so it can never reject and `endQueueWait()` can
    // never be skipped by a thrown error here.
    const endQueueWait = this.phaseObserver.startPhase("lock-wait");
    await priorTransaction;
    endQueueWait();

    try {
      const reserved = (await this.sql.reserve()) as Sql & {
        release(): Promise<void>;
      };
      let inTransaction = false;

      try {
        let hasResult = false;
        let result: T | undefined;

        await reserved.unsafe("BEGIN");
        inTransaction = true;

        // Backend-authoritative lease clock (ADR-050): capture one authoritative
        // timestamp per transaction — the injected clock when supplied
        // (tests/conformance), else the PostgreSQL server clock — and use it for
        // every clock read in this transaction (repository `now`, the exposed
        // `tx.now` the kernel consults for lease stamping/expiry, and the
        // snapshot stamp).
        const txNow = await this.resolveTransactionNow(reserved);
        const baseState = await loadPersistedStateForUpdate(
          reserved,
          this.schemaName,
          this.scope,
          {
            cache: this.snapshotCache,
            cacheObserver: this.snapshotCacheObserver,
            phaseObserver: this.phaseObserver,
          }
        );
        const draftState = cloneState(baseState);
        let active = true;
        const repositories = createRepositories(
          draftState,
          () => txNow,
          () => active && this.transactionContext.getStore() === true
        );

        try {
          result = await this.transactionContext.run(true, () =>
            work(repositories)
          );
          hasResult = true;
        } finally {
          active = false;
        }

        const endTransactValidate = this.phaseObserver.startPhase("validate");
        try {
          validateCommittedState(draftState, baseState);
        } finally {
          endTransactValidate();
        }

        await this.faultState.hooks?.beforeCommit?.();

        let committed = false;
        const commit = async (): Promise<void> => {
          if (committed) {
            throw new Error(
              "postgres backend commit hook attempted double commit"
            );
          }

          const { hashHex } = await persistStateSnapshot(
            reserved,
            this.schemaName,
            this.scope,
            draftState,
            txNow,
            this.phaseObserver
          );
          const endCommitWrite = this.phaseObserver.startPhase("write");
          try {
            await reserved.unsafe("COMMIT");
          } finally {
            endCommitWrite();
          }
          inTransaction = false;
          committed = true;
          // Only now -- after the physical COMMIT has actually succeeded --
          // is `draftState` safe to treat as "the committed state for
          // `hashHex`". Populating the memo any earlier (e.g. right after
          // the UPDATE, before COMMIT) would poison it with an uncommitted
          // draft if COMMIT itself then failed and the transaction rolled
          // back; populating it here means a thrown error anywhere above
          // this line (including inside persistStateSnapshot or COMMIT
          // itself) never touches the cache at all.
          this.snapshotCache.set(hashHex, draftState);
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

        if (!hasResult) {
          throw new Error(
            "postgres backend transaction completed without a result"
          );
        }

        return result as T;
      } catch (error: unknown) {
        if (inTransaction) {
          await reserved.unsafe("ROLLBACK");
        }

        throw error;
      } finally {
        await reserved.release();
      }
    } finally {
      releaseQueue?.();
    }
  }

  /**
   * Runs the shared §9.4 reachability reclamation sweep over the Scope's
   * committed snapshot and persists the swept result: loads and row-locks
   * the snapshot, clones it into a draft, sweeps unreachable records from
   * the draft, re-validates the result, then persists and commits. Must not
   * run inside a `transact` call on this instance.
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
      const reserved = (await this.sql.reserve()) as Sql & {
        release(): Promise<void>;
      };
      let inTransaction = false;

      try {
        await reserved.unsafe("BEGIN");
        inTransaction = true;

        const baseState = await loadPersistedStateForUpdate(
          reserved,
          this.schemaName,
          this.scope,
          {
            cache: this.snapshotCache,
            cacheObserver: this.snapshotCacheObserver,
            phaseObserver: this.phaseObserver,
          }
        );
        const draftState = cloneState(baseState);
        // The snapshot backend reclaims by rewriting the scope snapshot row:
        // sweep the in-memory draft, validate the referentially-closed result,
        // and re-persist it. Reachability and the grace horizon's pinning value
        // are still derived structurally from the draft's own active runs
        // (§9.4); a clock argument is required so a leaseless running run whose
        // updatedAtMs has gone quiet past the administrative expiry horizon
        // (KRT-BK002, ADR-050/ADR-051) can be excluded from pinning that
        // horizon, judged against this wall-clock reference.
        const summary = reclaimBackendState(
          draftState,
          options?.nowMs ?? this.now()
        );
        const endReclaimValidate = this.phaseObserver.startPhase("validate");
        try {
          validateCommittedState(draftState, baseState);
        } finally {
          endReclaimValidate();
        }

        const { hashHex } = await persistStateSnapshot(
          reserved,
          this.schemaName,
          this.scope,
          draftState,
          this.now(),
          this.phaseObserver
        );
        const endCommitWrite = this.phaseObserver.startPhase("write");
        try {
          await reserved.unsafe("COMMIT");
        } finally {
          endCommitWrite();
        }
        inTransaction = false;
        // Same rule as transact()'s commit(): only populate the memo once
        // COMMIT has actually succeeded, so a rolled-back reclaim sweep can
        // never poison it.
        this.snapshotCache.set(hashHex, draftState);

        return summary;
      } catch (error: unknown) {
        if (inTransaction) {
          await reserved.unsafe("ROLLBACK");
        }

        throw error;
      } finally {
        await reserved.release();
      }
    } finally {
      releaseQueue?.();
    }
  }

  /**
   * Drops this Scope's snapshot row for full tenant offboarding (kernel spec
   * §9.4). Every other Scope's row in the shared schema is untouched. Per
   * the `RuntimeBackend.purgeScope` contract this instance is unusable
   * afterward and must be discarded; a later `transact`/`health`/`reclaim`
   * call raises `postgres_backend_missing_snapshot_row`. Must not run inside
   * a `transact` call on this instance.
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

    await this.ensureInitialized();

    const priorTransaction = this.transactionQueue;
    let releaseQueue: (() => void) | undefined;

    this.transactionQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await priorTransaction;

    try {
      // Full tenant offboarding (§9.4): under the row-level isolation model the
      // Scope owns exactly one snapshot row, so dropping the partition is
      // deleting that row. Every other Scope's row in the shared table is
      // untouched, so offboarding one tenant is invisible to the rest. This
      // instance is unusable afterward (callers discard it per the purgeScope
      // contract), exactly like the SQLite backend after it removes its file.
      await deletePersistedStateSnapshot(this.sql, this.schemaName, this.scope);
      // The row this memo describes no longer exists; drop it so a
      // (contractually unsupported, but defensive) later call never serves a
      // hit for a scope that has been purged.
      this.snapshotCache.clear();
    } finally {
      releaseQueue?.();
    }
  }

  /**
   * Resolves the single authoritative clock reading for a transaction: the
   * injected clock when one was supplied at construction, otherwise the
   * live PostgreSQL server clock (ADR-050 shared-rendezvous clock for a
   * multi-worker deployment).
   */
  private async resolveTransactionNow(reserved: Sql): Promise<number> {
    // An explicitly injected clock is treated as the authoritative backend clock
    // so tests/conformance can deterministically align or skew it against an
    // execution owner's clock. With no injection the PostgreSQL server is the
    // shared rendezvous clock for the multi-worker deployment (ADR-050).
    if (this.injectedNow !== undefined) {
      return this.injectedNow();
    }

    return await readBackendClockMs(reserved);
  }

  /**
   * Lazily provisions this Scope's schema/tables/snapshot row exactly once
   * per instance, memoizing the in-flight promise so concurrent callers
   * await the same initialization. A failed attempt clears the memoized
   * promise so the next call retries instead of replaying the failure
   * forever.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initializationPromise === undefined) {
      const initialization = ensurePostgresSchemaInitialized(
        this.sql,
        this.schemaName,
        this.now,
        this.scope
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
 * Builds a `RuntimeBackend` over a PostgreSQL snapshot row for the Scope
 * named in `options.scope` (or the default Scope). Schema/table
 * provisioning is deferred to the first call that needs it, not performed
 * eagerly here.
 */
export function createPostgresBackend(
  options?: PostgresBackendOptions
): KrakenBackend {
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
 * Builds the full `RuntimeBackendTx` repository surface over an in-memory
 * draft `BackendState`, mirroring the memory backend's own repositories:
 * every `get`/`list` clones records out of `state` before returning them,
 * every `set`/`put` validates referenced records and per-family invariants
 * before mutating `state` in place, and every method call first asserts the
 * owning transaction is still active via `isTransactionActive`.
 */
function createRepositories(
  state: BackendState,
  now: () => number,
  isTransactionActive: () => boolean
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
    branches: {
      get(branchId) {
        assertTransactionActive();
        const branch = state.branches.get(branchId);
        return Promise.resolve(
          branch === undefined ? null : cloneStoredBranch(branch)
        );
      },
      listByThread(threadId) {
        assertTransactionActive();
        const branches: StoredBranch[] = [];

        for (const branch of state.branches.values()) {
          if (branch.threadId === threadId) {
            branches.push(cloneStoredBranch(branch));
          }
        }

        branches.sort(compareStoredBranch);
        return Promise.resolve(branches);
      },
      set(record) {
        assertTransactionActive();
        assertStoredBranch(record, "record");
        const thread = ensureThreadExists(
          state,
          record.threadId,
          "record.threadId"
        );
        ensureTurnNodeExists(
          state,
          record.headTurnNodeHash,
          "record.headTurnNodeHash"
        );
        assertTurnNodeBelongsToThread(
          state,
          record.headTurnNodeHash,
          thread,
          "record.headTurnNodeHash"
        );

        const existingBranch = state.branches.get(record.branchId);

        if (record.archivedFromBranchId !== undefined) {
          const sourceBranch = ensureBranchExists(
            state,
            record.archivedFromBranchId,
            "record.archivedFromBranchId"
          );

          if (sourceBranch.threadId !== record.threadId) {
            throw persistenceError(
              "stored branches must archive only from branches in the same thread",
              "postgres_backend_branch_archive_thread_mismatch",
              {
                archivedFromBranchId: sourceBranch.branchId,
                branchId: record.branchId,
                branchThreadId: record.threadId,
                sourceThreadId: sourceBranch.threadId,
              }
            );
          }
        }

        if (existingBranch !== undefined) {
          assertImmutableField(
            existingBranch.threadId,
            record.threadId,
            "record.threadId",
            "postgres_backend_branch_thread_immutable"
          );
          assertImmutableField(
            existingBranch.createdAtMs,
            record.createdAtMs,
            "record.createdAtMs",
            "postgres_backend_branch_created_at_immutable"
          );
          assertImmutableOptionalField(
            existingBranch.archivedFromBranchId,
            record.archivedFromBranchId,
            "record.archivedFromBranchId",
            "postgres_backend_branch_archive_source_immutable"
          );
          assertMonotonicUpdatedAtMs(
            existingBranch.updatedAtMs,
            record.updatedAtMs,
            "record.updatedAtMs",
            "postgres_backend_branch_updated_at_regressed"
          );

          assertBranchHeadMoveIsLinear(
            state,
            existingBranch.headTurnNodeHash,
            record.headTurnNodeHash,
            "record.headTurnNodeHash"
          );
        }

        state.branches.set(record.branchId, cloneStoredBranch(record));
        return Promise.resolve();
      },
    },
    now,
    observeAnnotations: {
      listByRun(runId) {
        assertTransactionActive();
        const records = state.observeAnnotations.get(runId) ?? [];
        return Promise.resolve(
          records
            .map(cloneStoredObserveAnnotation)
            .sort(compareStoredObserveAnnotation)
        );
      },
      set(record) {
        assertTransactionActive();
        assertStoredObserveAnnotation(record, "record");
        ensureRunExists(state, record.runId, "record.runId");

        if (record.turnNodeHash !== null) {
          ensureTurnNodeExists(
            state,
            record.turnNodeHash,
            "record.turnNodeHash"
          );
        }

        const records = state.observeAnnotations.get(record.runId) ?? [];
        // Observe annotations are append-only evidence, so identical payloads
        // must survive as distinct records instead of being deduplicated.
        records.push(cloneStoredObserveAnnotation(record));
        state.observeAnnotations.set(record.runId, records);
        return Promise.resolve();
      },
    },
    objects: {
      get(hash) {
        assertTransactionActive();
        const record = state.objects.get(hash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredObject(record)
        );
      },
      has(hash) {
        assertTransactionActive();
        return Promise.resolve(state.objects.has(hash));
      },
      async put(record) {
        assertTransactionActive();
        assertStoredObject(record, "record");
        await assertStoredObjectIdentity(record, "record");
        putImmutableRecord(
          state.objects,
          record.hash,
          record,
          cloneStoredObject,
          areStoredObjectsEqual,
          "stored object"
        );
      },
    },
    orderedPathChunks: {
      get(chunkHash) {
        assertTransactionActive();
        const record = state.orderedPathChunks.get(chunkHash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredOrderedPathChunk(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        assertStoredOrderedPathChunk(record, "record");
        await assertStoredOrderedPathChunkIdentity(record, "record");
        putImmutableRecord(
          state.orderedPathChunks,
          record.chunkHash,
          record,
          cloneStoredOrderedPathChunk,
          areStoredOrderedPathChunksEqual,
          "ordered path chunk"
        );
      },
    },
    runs: {
      get(runId) {
        assertTransactionActive();
        const record = state.runs.get(runId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredRun(record)
        );
      },
      listByBranch(branchId) {
        assertTransactionActive();
        const runs: StoredRun[] = [];

        for (const run of state.runs.values()) {
          if (run.branchId === branchId) {
            runs.push(cloneStoredRun(run));
          }
        }

        runs.sort(compareStoredRun);
        return Promise.resolve(runs);
      },
      listExpired(nowMs) {
        assertTransactionActive();
        const runs: StoredRun[] = [];

        for (const run of state.runs.values()) {
          if (isExpiredLeasedRunningRun(run, nowMs)) {
            runs.push(cloneStoredRun(run));
          }
        }

        runs.sort(compareStoredRun);
        return Promise.resolve(runs);
      },
      set(record) {
        assertTransactionActive();
        assertStoredRun(record, "record");
        const branch = ensureBranchExists(
          state,
          record.branchId,
          "record.branchId"
        );
        const turn = ensureTurnExists(state, record.turnId, "record.turnId");
        ensureSchemaRecordExists(state, record.schemaId, "record.schemaId");
        const startTurnNode = ensureTurnNodeExists(
          state,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );
        const thread = ensureThreadExists(
          state,
          turn.threadId,
          "turn.threadId"
        );
        assertTurnNodeBelongsToThread(
          state,
          record.startTurnNodeHash,
          thread,
          "record.startTurnNodeHash"
        );

        if (turn.branchId !== branch.branchId) {
          throw persistenceError(
            "stored runs must reference a turn on the same branch",
            "postgres_backend_run_branch_mismatch",
            { branchId: branch.branchId, turnId: turn.turnId }
          );
        }

        if (startTurnNode.schemaId !== record.schemaId) {
          throw persistenceError(
            "stored runs must use the schema of their start turn node",
            "postgres_backend_run_schema_mismatch",
            {
              runId: record.runId,
              runSchemaId: record.schemaId,
              startTurnNodeHash: startTurnNode.hash,
              turnNodeSchemaId: startTurnNode.schemaId,
            }
          );
        }

        assertRunStartTurnNodeWithinTurnSpan(
          state,
          turn,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );

        const existingRun = state.runs.get(record.runId);
        if (existingRun === undefined) {
          if (record.status !== "running") {
            throw persistenceError(
              "stored runs must be created in the running state",
              "postgres_backend_run_initial_status_invalid",
              {
                runId: record.runId,
                status: record.status,
              }
            );
          }

          if (branch.headTurnNodeHash !== record.startTurnNodeHash) {
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
        } else {
          assertRunUpdateIsLegal(existingRun, record);
        }

        state.runs.set(record.runId, cloneStoredRun(record));
        return Promise.resolve();
      },
    },
    schemas: {
      get(schemaId) {
        assertTransactionActive();
        const record = state.schemas.get(schemaId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredSchema(record)
        );
      },
      put(record) {
        assertTransactionActive();
        assertStoredSchema(record, "record");
        putImmutableRecord(
          state.schemas,
          record.schemaId,
          record,
          cloneStoredSchema,
          areStoredSchemasEqual,
          "stored schema"
        );
        return Promise.resolve();
      },
    },
    stagedResults: {
      clearRun(runId) {
        assertTransactionActive();
        state.stagedResults.delete(runId);
        return Promise.resolve();
      },
      get(runId, taskId) {
        assertTransactionActive();
        const runResults = state.stagedResults.get(runId);
        const record = runResults?.get(taskId);

        return Promise.resolve(
          record === undefined ? null : cloneStoredStagedResult(record)
        );
      },
      listByRun(runId) {
        assertTransactionActive();
        const runResults = state.stagedResults.get(runId);

        if (runResults === undefined) {
          return Promise.resolve([]);
        }

        const stagedResults = Array.from(
          runResults.values(),
          cloneStoredStagedResult
        );
        stagedResults.sort(compareStoredStagedResult);
        return Promise.resolve(stagedResults);
      },
      set(record) {
        assertTransactionActive();
        assertStoredStagedResult(record, "record");
        const run = ensureRunExists(state, record.runId, "record.runId");
        ensureObjectExists(state, record.objectHash, "record.objectHash");

        if (run.status !== "running") {
          throw persistenceError(
            "stored staged results may only be attached to running runs",
            "postgres_backend_staged_result_run_not_running",
            {
              runId: run.runId,
              status: run.status,
            }
          );
        }

        const runResults =
          state.stagedResults.get(record.runId) ??
          new Map<string, StoredStagedResult>();
        const existingResult = runResults.get(record.taskId);

        if (existingResult === undefined) {
          runResults.set(record.taskId, cloneStoredStagedResult(record));
        } else {
          ensureImmutableRecordMatch(
            existingResult,
            record,
            areStoredStagedResultsEqual,
            "stored staged result"
          );
        }

        state.stagedResults.set(record.runId, runResults);
        return Promise.resolve();
      },
    },
    threads: {
      get(threadId) {
        assertTransactionActive();
        const record = state.threads.get(threadId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredThread(record)
        );
      },
      put(record) {
        assertTransactionActive();
        assertStoredThread(record, "record");
        ensureSchemaRecordExists(state, record.schemaId, "record.schemaId");
        const rootTurnNode = ensureTurnNodeExists(
          state,
          record.rootTurnNodeHash,
          "record.rootTurnNodeHash"
        );
        if (rootTurnNode.previousTurnNodeHash !== null) {
          throw persistenceError(
            "stored thread roots must be genesis turn nodes",
            "postgres_backend_thread_root_not_genesis",
            {
              previousTurnNodeHash: rootTurnNode.previousTurnNodeHash,
              rootTurnNodeHash: rootTurnNode.hash,
              threadId: record.threadId,
            }
          );
        }
        putImmutableRecord(
          state.threads,
          record.threadId,
          record,
          cloneStoredThread,
          areStoredThreadsEqual,
          "stored thread"
        );
        return Promise.resolve();
      },
      list(options) {
        assertTransactionActive();
        let threads: StoredThread[] = Array.from(
          state.threads.values(),
          cloneStoredThread
        );

        if (options?.filter?.schemaId !== undefined) {
          const { schemaId } = options.filter;
          threads = threads.filter((t) => t.schemaId === schemaId);
        }

        threads.sort((a, b) => {
          if (a.createdAtMs !== b.createdAtMs) {
            return a.createdAtMs < b.createdAtMs ? -1 : 1;
          }
          return a.threadId.localeCompare(b.threadId);
        });

        if (options?.cursor !== undefined) {
          const { lastCreatedAtMs, lastThreadId } = options.cursor;
          const idx = threads.findIndex(
            (t) =>
              t.createdAtMs > lastCreatedAtMs ||
              (t.createdAtMs === lastCreatedAtMs && t.threadId > lastThreadId)
          );
          threads = idx === -1 ? [] : threads.slice(idx);
        }

        const limit = options?.limit;
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
    turnNodes: {
      get(hash) {
        assertTransactionActive();
        const record = state.turnNodes.get(hash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurnNode(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        assertStoredTurnNode(record, "record");
        await assertStoredTurnNodeIdentity(record, "record");
        ensureTurnTreeExists(state, record.turnTreeHash, "record.turnTreeHash");
        ensureSchemaRecordExists(state, record.schemaId, "record.schemaId");

        if (record.eventHash !== null) {
          ensureObjectExists(state, record.eventHash, "record.eventHash");
        }

        for (const objectHash of decodeTurnNodeConsumedStagedResultObjectHashes(
          record
        )) {
          ensureObjectExists(
            state,
            objectHash,
            "record.consumedStagedResultsCbor"
          );
        }

        if (record.previousTurnNodeHash !== null) {
          ensureTurnNodeExists(
            state,
            record.previousTurnNodeHash,
            "record.previousTurnNodeHash"
          );
        }

        putImmutableRecord(
          state.turnNodes,
          record.hash,
          record,
          cloneStoredTurnNode,
          areStoredTurnNodesEqual,
          "stored turn node"
        );
      },
    },
    turnTreePaths: {
      get(turnTreeHash, path) {
        assertTransactionActive();
        const treePaths = state.turnTreePaths.get(turnTreeHash);
        const record = treePaths?.get(path);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurnTreePath(record)
        );
      },
      listByTurnTree(turnTreeHash) {
        assertTransactionActive();
        const treePaths = state.turnTreePaths.get(turnTreeHash);

        if (treePaths === undefined) {
          return Promise.resolve([]);
        }

        const records = Array.from(treePaths.values(), cloneStoredTurnTreePath);
        records.sort((left, right) => left.path.localeCompare(right.path));
        return Promise.resolve(records);
      },
      async putMany(records) {
        assertTransactionActive();
        const seenCompositeKeys = new Set<string>();

        for (const record of records) {
          const turnTree = ensureTurnTreeExists(
            state,
            record.turnTreeHash,
            "record.turnTreeHash"
          );
          const schema = getSchemaForTurnTree(state, turnTree);
          assertStoredTurnTreePath(record, schema, "record");

          const compositeKey = `${record.turnTreeHash}:${record.path}`;
          if (seenCompositeKeys.has(compositeKey)) {
            throw persistenceError(
              "turn tree path batches must not contain duplicate keys",
              "postgres_backend_duplicate_turn_tree_path_batch_entry",
              { compositeKey }
            );
          }

          seenCompositeKeys.add(compositeKey);

          const normalizedRecord = await normalizeStoredTurnTreePath(
            state,
            record,
            now
          );
          const treePaths =
            state.turnTreePaths.get(normalizedRecord.turnTreeHash) ??
            new Map<string, StoredTurnTreePath>();
          const existing = treePaths.get(normalizedRecord.path);

          if (existing === undefined) {
            treePaths.set(
              normalizedRecord.path,
              cloneStoredTurnTreePath(normalizedRecord)
            );
          } else {
            ensureImmutableRecordMatch(
              existing,
              normalizedRecord,
              areStoredTurnTreePathsEqual,
              "stored turn tree path"
            );
          }

          state.turnTreePaths.set(normalizedRecord.turnTreeHash, treePaths);
        }
      },
    },
    turnTrees: {
      get(hash) {
        assertTransactionActive();
        const record = state.turnTrees.get(hash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurnTree(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        const schema = getSchemaForSchemaId(
          state,
          record.schemaId,
          "record.schemaId"
        );
        assertStoredTurnTree(record, schema, "record");
        await assertStoredTurnTreeIdentity(record, schema, "record");
        putImmutableRecord(
          state.turnTrees,
          record.hash,
          record,
          cloneStoredTurnTree,
          areStoredTurnTreesEqual,
          "stored turn tree"
        );
      },
    },
    turns: {
      get(turnId) {
        assertTransactionActive();
        const record = state.turns.get(turnId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurn(record)
        );
      },
      listByThread(threadId) {
        assertTransactionActive();
        return Promise.resolve(
          listTurnsByThread(state, threadId).map(cloneStoredTurn)
        );
      },
      set(record) {
        assertTransactionActive();
        assertStoredTurn(record, "record");
        const thread = ensureThreadExists(
          state,
          record.threadId,
          "record.threadId"
        );
        const branch = ensureBranchExists(
          state,
          record.branchId,
          "record.branchId"
        );
        ensureTurnNodeExists(
          state,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );
        ensureTurnNodeExists(
          state,
          record.headTurnNodeHash,
          "record.headTurnNodeHash"
        );

        if (branch.threadId !== thread.threadId) {
          throw persistenceError(
            "stored turns must reference a branch on the same thread",
            "postgres_backend_turn_branch_thread_mismatch",
            { branchId: branch.branchId, threadId: thread.threadId }
          );
        }

        const existingTurn = state.turns.get(record.turnId);
        if (existingTurn !== undefined) {
          assertImmutableField(
            existingTurn.branchId,
            record.branchId,
            "record.branchId",
            "postgres_backend_turn_branch_immutable"
          );
          assertImmutableField(
            existingTurn.threadId,
            record.threadId,
            "record.threadId",
            "postgres_backend_turn_thread_immutable"
          );
          assertImmutableField(
            existingTurn.startTurnNodeHash,
            record.startTurnNodeHash,
            "record.startTurnNodeHash",
            "postgres_backend_turn_start_immutable"
          );
          assertImmutableOptionalField(
            existingTurn.parentTurnId,
            record.parentTurnId,
            "record.parentTurnId",
            "postgres_backend_turn_parent_immutable"
          );
          assertImmutableField(
            existingTurn.createdAtMs,
            record.createdAtMs,
            "record.createdAtMs",
            "postgres_backend_turn_created_at_immutable"
          );
          assertMonotonicUpdatedAtMs(
            existingTurn.updatedAtMs,
            record.updatedAtMs,
            "record.updatedAtMs",
            "postgres_backend_turn_updated_at_regressed"
          );
          assertTurnNodeDescendsFrom(
            state,
            record.headTurnNodeHash,
            existingTurn.headTurnNodeHash,
            "record.headTurnNodeHash"
          );
        }

        state.turns.set(record.turnId, cloneStoredTurn(record));
        return Promise.resolve();
      },
    },
  };
}

/**
 * Reads the PostgreSQL server's current wall-clock time (`clock_timestamp()`)
 * as epoch milliseconds, once per transaction, for the ADR-050 shared
 * rendezvous clock.
 *
 * @throws TuvrenPersistenceError `postgres_backend_clock_unavailable` when
 *   the query returns no row, or `postgres_backend_clock_unsafe_integer`
 *   when the value falls outside the safe-integer range.
 */
async function readBackendClockMs(reserved: Sql): Promise<number> {
  // clock_timestamp() is the actual wall-clock time at call, captured once per
  // transaction so the whole transaction shares a single authoritative instant.
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

  // ::bigint is serialized as a string by postgres.js; epoch milliseconds stay
  // well within the safe-integer range for any realistic deployment date.
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

/** Extracts a human-readable message from any thrown value. */
function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/** Double-quotes and escapes a PostgreSQL identifier for safe interpolation. */
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
