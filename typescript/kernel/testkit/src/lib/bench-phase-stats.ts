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
import type { PersistencePhase, PhaseSample } from "@tuvren/backend-shared";

// Issue #108 M2: `readSampleCountFromEnv`, `percentile`, `formatNs`,
// `summarizePhases`, and `formatPhaseTable` were copy-pasted byte-for-byte
// across the three kernel-backend benches
// (postgres-write-latency.bench.ts, sqlite-load-cost.bench.ts,
// sqlite-hot-path.bench.ts). All three already depend on this package for
// record fixtures, so this is their shared home rather than
// `@tuvren/backend-shared` (a production runtime dependency of every
// backend, not a bench-only one).

/** Best/median/p95/average timing summary over a set of duration samples. */
export interface TimingStats {
  averageNs: number;
  bestNs: number;
  medianNs: number;
  n: number;
  p95Ns: number;
}

/** A {@link TimingStats} summary for one named {@link PersistencePhase}. */
export interface PhaseStats extends TimingStats {
  phase: PersistencePhase;
}

/** Reads `BENCH_SAMPLE_COUNT` from the environment, falling back to `fallback`. */
export function readSampleCountFromEnv(fallback: number): number {
  const raw = process.env.BENCH_SAMPLE_COUNT;

  if (raw === undefined || raw.length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `BENCH_SAMPLE_COUNT must be a positive integer, received "${raw}"`
    );
  }

  return parsed;
}

/**
 * The value at `rank` (e.g. `0.5` for median, `0.95` for p95) of
 * `sortedSamples`, which callers must already have sorted ascending.
 */
export function percentile(
  sortedSamples: readonly number[],
  rank: number
): number {
  if (sortedSamples.length === 0) {
    throw new Error("expected benchmark samples");
  }

  const index = Math.min(
    sortedSamples.length - 1,
    Math.max(0, Math.ceil(sortedSamples.length * rank) - 1)
  );
  const value = sortedSamples[index];

  if (value === undefined) {
    throw new Error("expected benchmark sample at percentile index");
  }

  return value;
}

/** Formats a nanosecond duration as the largest whole unit that keeps it readable. */
export function formatNs(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(3)}s`;
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(3)}ms`;
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(3)}us`;
  }

  return `${value.toFixed(0)}ns`;
}

/** Groups recorded phase samples by phase and computes best/median/p95/avg/n per phase. */
export function summarizePhases(samples: readonly PhaseSample[]): PhaseStats[] {
  const byPhase = new Map<PersistencePhase, number[]>();

  for (const sample of samples) {
    const durations = byPhase.get(sample.phase) ?? [];
    durations.push(sample.durationNs);
    byPhase.set(sample.phase, durations);
  }

  const phaseStats: PhaseStats[] = [];

  for (const [phase, durations] of byPhase) {
    const sorted = [...durations].sort((left, right) => left - right);
    phaseStats.push({
      averageNs:
        durations.reduce((total, duration) => total + duration, 0) /
        durations.length,
      bestNs: Math.min(...durations),
      medianNs: percentile(sorted, 0.5),
      n: durations.length,
      p95Ns: percentile(sorted, 0.95),
      phase,
    });
  }

  phaseStats.sort((left, right) => left.phase.localeCompare(right.phase));
  return phaseStats;
}

/**
 * Renders a phase-attribution table for stdout, one row per observed phase,
 * each line prefixed with `indent` (callers nesting this under their own
 * header line, e.g. sqlite-load-cost's "health phases:", pass a deeper
 * indent than a top-level table).
 */
export function formatPhaseTable(
  phases: readonly PhaseStats[],
  indent = "  "
): string {
  if (phases.length === 0) {
    return `${indent}(no phase samples recorded)\n`;
  }

  const rows = phases.map(
    (phase) =>
      `${indent}${phase.phase.padEnd(10)} n=${phase.n} best ${formatNs(
        phase.bestNs
      )} median ${formatNs(phase.medianNs)} p95 ${formatNs(
        phase.p95Ns
      )} avg ${formatNs(phase.averageNs)}\n`
  );
  return rows.join("");
}
