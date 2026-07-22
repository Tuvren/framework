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
 * Named phases of the blob-per-scope persistence path (issue #108) that a
 * backend can attribute cost to: waiting on the in-process transaction queue
 * or a database row lock, decoding the persisted snapshot, running the
 * committed-state invariant suite, encoding a draft back to the wire format,
 * writing/committing it, and (for backends without a decode/encode split,
 * e.g. SQLite's row-per-table load) loading persisted rows into memory.
 *
 * `validate-loaded`, `validate-lineage-index`, and `validate-committed`
 * (issue #108 M2) are SQLite-specific sub-phases of what M1 attributed as a
 * single `validate` phase for that backend only: SQLite's `loadValidatedState`
 * runs three distinct validation passes between `load` and returning —
 * per-record shape/identity re-validation (`validateLoadedState`), the
 * derived turn-node-lineage-root index cross-check
 * (`validateTurnNodeLineageRootIndex`), and the committed-state invariant
 * suite (`validateCommittedState`) — and M1 left the first two
 * unattributed, which is where its measured superlinear residual actually
 * lived. Postgres has no equivalent three-way split and keeps using the
 * single `validate` phase.
 *
 * `hash` (issue #108 M3) is the postgres-backend-specific cost of SHA-256
 * hashing the loaded/about-to-be-written `snapshot_cbor` bytes for the
 * single-entry content-hash memo that lets a repeat load of byte-identical
 * bytes skip `decode` entirely. It is charged on every load (hit or miss)
 * and on every successful write, so a cache-hit load shows only `hash`
 * where a cache-miss load still shows `hash` followed by the usual
 * `decode`.
 *
 * `validate-reclaim-survivors` (issue #108 M6) is SQLite-specific: it
 * replaces the second, full `loadValidatedState` pass `reclaim()` used to
 * run after sweeping and deleting the unreachable closure. Instead of
 * reloading and fully re-validating the whole database a second time,
 * `reclaim()` now runs a targeted, O(survivors) check directly over the
 * already-swept in-memory projection — see
 * `sqlite-reclamation-validation.ts`'s `assertReclamationSurvivorInvariants`
 * for the full enumeration of what deletion can and cannot break and how
 * each case is covered.
 */
export type PersistencePhase =
  | "decode"
  | "encode"
  | "hash"
  | "load"
  | "lock-wait"
  | "validate"
  | "validate-committed"
  | "validate-lineage-index"
  | "validate-loaded"
  | "validate-reclaim-survivors"
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
