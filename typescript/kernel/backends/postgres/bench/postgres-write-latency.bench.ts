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

// KRT-BK007 measurement-only spike: per-write latency of the postgres
// whole-blob-per-scope persistence model (postgres-backend-persistence.ts's
// loadPersistedStateForUpdate/persistStateSnapshot decode/clone/re-encode the
// FULL scope snapshot on every transact()) as accumulated scope size grows.
// Drives the backend exclusively through its public RuntimeBackend surface
// (transact/schemas/objects) -- no production source under
// typescript/kernel/backends/postgres/src changes as part of this spike.

import { randomUUID } from "node:crypto";
import process from "node:process";
import {
  createRecordingPhaseObserver,
  type PersistencePhase,
  type PhaseSample,
} from "@tuvren/backend-shared";
import {
  createCanonicalKernelTestSchema,
  createStoredObjectRecord,
  createStoredSchemaRecord,
} from "@tuvren/kernel-testkit";
import {
  createPostgresBackend,
  destroyPostgresBackend,
  type PostgresBackendOptions,
} from "../src/index.js";

// Default sample count for the decisive large tiers (1k, 10k): the KRT-BK007
// spike ran n=5, where p95 collapses onto max; override via BENCH_SAMPLE_COUNT
// for a quicker local iteration loop.
const SAMPLE_COUNT = readSampleCountFromEnv(15);
const WARMUP_WRITES = 3;
const SCOPE_OBJECT_COUNTS = [10, 100, 1000, 10_000] as const;
const DEVENV_DATABASE_NAME = "tuvren_runtime";

interface TimingStats {
  averageNs: number;
  bestNs: number;
  medianNs: number;
  n: number;
  p95Ns: number;
}

interface PhaseStats extends TimingStats {
  phase: PersistencePhase;
}

interface WriteLatencyResult extends TimingStats {
  phases: PhaseStats[];
  scopeObjectCount: number;
}

await main();

async function main(): Promise<void> {
  process.stdout.write("postgres backend write-latency benchmark\n");
  process.stdout.write(
    `sample count: ${SAMPLE_COUNT} (BENCH_SAMPLE_COUNT to override)\n`
  );
  const results: WriteLatencyResult[] = [];

  for (const scopeObjectCount of SCOPE_OBJECT_COUNTS) {
    const observer = createRecordingPhaseObserver();
    const options = createBenchBackendOptions(observer);
    const backend = createPostgresBackend(options);

    try {
      const schema = createCanonicalKernelTestSchema();
      await backend.transact(async (tx) => {
        await tx.schemas.put(createStoredSchemaRecord(schema, 1));
      });

      // Bulk-seed the scope to `scopeObjectCount` objects inside ONE
      // transaction (one whole-blob write), not `scopeObjectCount`
      // sequential transact() calls. Sequential per-item writes at growing
      // size *is* the O(n^2) cost this benchmark measures the marginal end
      // of; using it to build the fixture would conflate setup cost with the
      // measured quantity.
      await backend.transact(async (tx) => {
        for (let index = 0; index < scopeObjectCount; index += 1) {
          const record = await createStoredObjectRecord(
            seededObjectBytes(scopeObjectCount, index),
            10_000 + index
          );
          await tx.objects.put(record);
        }
      });

      const result = await measureMarginalWriteLatency(
        backend,
        scopeObjectCount,
        observer
      );
      results.push(result);
      process.stdout.write(
        `scope at ${result.scopeObjectCount} objects (n=${result.n}): best ${formatNs(
          result.bestNs
        )}, median ${formatNs(result.medianNs)}, p95 ${formatNs(
          result.p95Ns
        )}, avg ${formatNs(result.averageNs)}\n`
      );
      process.stdout.write(formatPhaseTable(result.phases));
    } finally {
      await destroyPostgresBackend(options);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "postgres-write-latency",
        generatedAt: new Date().toISOString(),
        results,
      },
      null,
      2
    )}\n`
  );
}

async function measureMarginalWriteLatency(
  backend: ReturnType<typeof createPostgresBackend>,
  scopeObjectCount: number,
  observer: ReturnType<typeof createRecordingPhaseObserver>
): Promise<WriteLatencyResult> {
  let writeCounter = 0;

  const writeOnce = async (): Promise<number> => {
    const index = writeCounter;
    writeCounter += 1;
    const record = await createStoredObjectRecord(
      seededObjectBytes(scopeObjectCount, 1_000_000 + index),
      20_000 + index
    );
    const startedAt = process.hrtime.bigint();
    await backend.transact(async (tx) => {
      await tx.objects.put(record);
    });
    return Number(process.hrtime.bigint() - startedAt);
  };

  for (let index = 0; index < WARMUP_WRITES; index += 1) {
    await writeOnce();
  }

  // Only attribute phases for the measured samples below, not the warmup
  // writes above -- so the phase table lines up 1:1 with the reported
  // latency sample count.
  observer.reset();

  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    samples.push(await writeOnce());
  }

  const sortedSamples = [...samples].sort((left, right) => left - right);

  return {
    averageNs:
      samples.reduce((total, sample) => total + sample, 0) / samples.length,
    bestNs: Math.min(...samples),
    medianNs: percentile(sortedSamples, 0.5),
    n: samples.length,
    p95Ns: percentile(sortedSamples, 0.95),
    phases: summarizePhases(observer.samples),
    scopeObjectCount,
  };
}

function createBenchBackendOptions(
  phaseObserver: ReturnType<typeof createRecordingPhaseObserver>
): PostgresBackendOptions {
  const host = process.env.PGHOST;
  const portValue = process.env.PGPORT;
  const username = process.env.PGUSER ?? process.env.USER;

  if (host === undefined || host.length === 0) {
    throw new Error(
      "PGHOST is missing. Load the repo environment with direnv and start PostgreSQL with `bun run services:up` before running this benchmark."
    );
  }

  if (portValue === undefined || portValue.length === 0) {
    throw new Error(
      "PGPORT is missing. Load the repo environment with direnv and start PostgreSQL with `bun run services:up` before running this benchmark."
    );
  }

  if (username === undefined || username.length === 0) {
    throw new Error(
      "PGUSER/USER is missing. This benchmark requires a local database user."
    );
  }

  const port = Number.parseInt(portValue, 10);

  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error(
      `PGPORT must be a positive integer, received "${portValue}"`
    );
  }

  return {
    database: DEVENV_DATABASE_NAME,
    host,
    phaseObserver,
    port,
    schemaName: `bench_${randomUUID().replaceAll("-", "_")}`,
    username,
  };
}

/** Reads `BENCH_SAMPLE_COUNT` from the environment, falling back to `fallback`. */
function readSampleCountFromEnv(fallback: number): number {
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

/** Groups recorded phase samples by phase and computes best/median/p95/avg/n per phase. */
function summarizePhases(samples: readonly PhaseSample[]): PhaseStats[] {
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

/** Renders a phase-attribution table for stdout, one row per observed phase. */
function formatPhaseTable(phases: readonly PhaseStats[]): string {
  if (phases.length === 0) {
    return "  (no phase samples recorded)\n";
  }

  const rows = phases.map(
    (phase) =>
      `  ${phase.phase.padEnd(10)} n=${phase.n} best ${formatNs(
        phase.bestNs
      )} median ${formatNs(phase.medianNs)} p95 ${formatNs(
        phase.p95Ns
      )} avg ${formatNs(phase.averageNs)}\n`
  );
  return rows.join("");
}

function seededObjectBytes(scopeObjectCount: number, index: number) {
  return new Uint8Array([
    scopeObjectCount % 251,
    index % 251,
    Math.floor(index / 251) % 251,
    Math.floor(index / 63_001) % 251,
  ]);
}

function percentile(sortedSamples: readonly number[], rank: number): number {
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

function formatNs(value: number): string {
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
