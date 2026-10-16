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

// Issue #110 / ADR-0067 regression baseline: per-write latency of the
// relational Postgres backend as accumulated Scope size grows. Under the
// pre-#110 blob-per-scope model a single-object `transact()` re-encoded the
// entire Scope (~248ms warm best-case at 10k objects). The relational path
// must keep marginal single-object write latency roughly flat across the
// size ladder (network-bound floor allowed). Drives the backend exclusively
// through its public RuntimeBackend surface (transact/schemas/objects).

import { randomUUID } from "node:crypto";
import process from "node:process";

import { createRecordingPhaseObserver } from "@tuvren/backend-shared";
import {
  createCanonicalKernelTestSchema,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  formatNs,
  formatPhaseTable,
  percentile,
  readSampleCountFromEnv,
  summarizePhases,
} from "@tuvren/kernel-testkit";
import type { PhaseStats, TimingStats } from "@tuvren/kernel-testkit";

import { createPostgresBackend, destroyPostgresBackend } from "../src/index.js";
import type { PostgresBackendOptions } from "../src/index.js";

// Default sample count for the decisive large tiers (1k, 10k): the KRT-BK007
// spike ran n=5, where p95 collapses onto max; override via BENCH_SAMPLE_COUNT
// for a quicker local iteration loop.
const SAMPLE_COUNT = readSampleCountFromEnv(15);
const WARMUP_WRITES = 3;
const SCOPE_OBJECT_COUNTS = [10, 100, 1000, 10_000] as const;
const DEVENV_DATABASE_NAME = "tuvren_runtime";

interface WriteLatencyResult extends TimingStats {
  phases: PhaseStats[];
  scopeObjectCount: number;
}

const createBenchBackendOptions = (
  phaseObserver: ReturnType<typeof createRecordingPhaseObserver>
): PostgresBackendOptions => {
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

  const port = Math.trunc(Number(portValue));

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
};

const seededObjectBytes = (scopeObjectCount: number, index: number) =>
  new Uint8Array([
    scopeObjectCount % 251,
    index % 251,
    Math.floor(index / 251) % 251,
    Math.floor(index / 63_001) % 251,
  ]);

const measureMarginalWriteLatency = async (
  backend: ReturnType<typeof createPostgresBackend>,
  scopeObjectCount: number,
  observer: ReturnType<typeof createRecordingPhaseObserver>
): Promise<WriteLatencyResult> => {
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

  /* oxlint-disable no-await-in-loop -- Warmup and measured writes must remain serial so each latency sample covers one complete write. */
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
  /* oxlint-enable no-await-in-loop */

  const sortedSamples = samples.toSorted((left, right) => left - right);

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
};

const main = async (): Promise<void> => {
  process.stdout.write("postgres backend write-latency benchmark\n");
  process.stdout.write(
    `sample count: ${SAMPLE_COUNT} (BENCH_SAMPLE_COUNT to override)\n`
  );
  const results: WriteLatencyResult[] = [];

  /* oxlint-disable no-await-in-loop -- Run scope-size cases and their seed writes serially so samples and cleanup never overlap. */
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
      // transaction so setup cost does not dominate the measured marginal
      // single-object writes below.
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
  /* oxlint-enable no-await-in-loop */

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
};

await main();
