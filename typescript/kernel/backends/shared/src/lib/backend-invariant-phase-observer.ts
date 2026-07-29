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

import process from "node:process";

/**
 * Named phases of the row-per-record persistence paths (issues #108/#110)
 * that a backend can attribute cost to. The SQLite and PostgreSQL backends
 * emit the same phase vocabulary since the relational Postgres redesign
 * (ADR-067) ported SQLite's row-per-table shape:
 *
 * `lock-wait` covers both waiting on the in-process transaction queue and
 * waiting on a database-level lock (SQLite's busy handler, Postgres's
 * same-scope advisory lock).
 *
 * `load` is the maintenance-path cost of reading every family table's rows
 * for the Scope into an in-memory projection (`fsck`/`reclaim` only — the
 * write path never loads whole-scope state).
 *
 * `validate-loaded`, `validate-lineage-index`, and `validate-committed`
 * (issue #108 M2) are the three distinct maintenance validation passes
 * `loadValidatedState` runs between `load` and returning: per-record
 * shape/identity re-validation, the derived turn-node-lineage-root index
 * cross-check, and the committed-state invariant suite. M1 originally
 * attributed all three as one `validate` phase, which hid where the
 * measured superlinear residual actually lived.
 *
 * `validate-reclaim-survivors` (issue #108 M6) replaces the second, full
 * `loadValidatedState` pass `reclaim()` used to run after sweeping and
 * deleting the unreachable closure: a targeted, O(survivors) check directly
 * over the already-swept in-memory projection — see the shared
 * `assertReclamationSurvivorInvariants` for the full enumeration of what
 * deletion can and cannot break and how each case is covered.
 *
 * `validate-write-set` (issue #108 B2 closure) wraps `transact()`'s
 * pre-commit call to `validateTransactionWriteSet`, the targeted,
 * delta-shaped check that re-validates only the rows a single transaction
 * actually touched (as tracked by the write tracker), not the whole
 * committed state.
 *
 * `write` covers COMMIT and bulk row deletion on the maintenance paths.
 *
 * `blob-migration` (issue #110) is postgres-specific: it wraps the one-time
 * open-time explode of legacy `backend_postgres_snapshots` blob rows into
 * relational family rows, so an operator opening a legacy database can see
 * where a slow first initialization is spending its time.
 *
 * The blob-era phases (`decode`, `encode`, `hash`, and the undifferentiated
 * `validate`) were retired with the storage models that emitted them
 * (issue #110 for Postgres; issue #108's M2 split for `validate`).
 */
export type PersistencePhase =
  | "blob-migration"
  | "load"
  | "lock-wait"
  | "validate-committed"
  | "validate-lineage-index"
  | "validate-loaded"
  | "validate-reclaim-survivors"
  | "validate-write-set"
  | "write";

/**
 * A phase-attribution seam a backend calls at construction to report where
 * persistence time goes. `startPhase` is called immediately before the named
 * phase of work begins and returns an end-callback the caller must invoke
 * exactly once immediately after that work finishes (typically from a
 * `finally` block, so a thrown error still closes the phase).
 *
 * Implementations must be safe to call on every persistence operation: the
 * {@link NOOP_PHASE_OBSERVER} default costs a single frozen function call and
 * must not allocate, so instrumentation is O(1) overhead and never changes a
 * production path's measured bytes or behavior when no observer is supplied.
 */
export interface PhaseObserver {
  startPhase(phase: PersistencePhase): () => void;
}

/** Shared frozen no-op end-callback every {@link NOOP_PHASE_OBSERVER} phase returns. */
const NOOP_PHASE_END: () => void = Object.freeze(() => undefined);

/**
 * The default {@link PhaseObserver} every instrumented backend construction
 * option falls back to. Returns the same frozen no-op callback for every
 * call, so enabling the instrumentation seam without supplying a recording
 * observer allocates nothing beyond the one shared closure.
 */
export const NOOP_PHASE_OBSERVER: PhaseObserver = Object.freeze({
  startPhase(_phase: PersistencePhase): () => void {
    return NOOP_PHASE_END;
  },
});

/** One completed phase measurement recorded by a {@link RecordingPhaseObserver}. */
export interface PhaseSample {
  readonly durationNs: number;
  readonly phase: PersistencePhase;
}

/**
 * A {@link PhaseObserver} that accumulates every phase it observes as a
 * {@link PhaseSample}, timed with `process.hrtime.bigint()`. Intended for
 * benches and tests; production callers use {@link NOOP_PHASE_OBSERVER}.
 */
export interface RecordingPhaseObserver extends PhaseObserver {
  /** Clears all recorded samples so the observer can be reused across bench tiers. */
  reset(): void;
  /** Every phase measurement recorded since construction or the last {@link reset}. */
  readonly samples: readonly PhaseSample[];
}

/**
 * Creates a fresh {@link RecordingPhaseObserver}. Each call to `startPhase`
 * captures `process.hrtime.bigint()` immediately and records the elapsed
 * nanoseconds the first time the returned end-callback is invoked; later
 * calls to the same end-callback are no-ops so a caller that defensively
 * invokes it more than once (e.g. success and `finally` paths) never
 * double-counts a phase.
 */
export function createRecordingPhaseObserver(): RecordingPhaseObserver {
  const samples: PhaseSample[] = [];

  return {
    reset(): void {
      samples.length = 0;
    },
    samples,
    startPhase(phase: PersistencePhase): () => void {
      const startedAtNs = process.hrtime.bigint();
      let ended = false;

      return () => {
        if (ended) {
          return;
        }

        ended = true;
        samples.push({
          durationNs: Number(process.hrtime.bigint() - startedAtNs),
          phase,
        });
      };
    },
  };
}
