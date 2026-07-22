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

// Issue #108 D1 — "does the postgres backend's `max: 1` pool plus its
// in-process `transactionQueue` wrongly serialize writers bound to
// DIFFERENT scopes?" Architecturally, no: `PostgresBackend` binds exactly
// one Scope at construction (`options.scope`), and both the pool and the
// queue are per-instance state. Two backend instances on two different
// scopes therefore own entirely separate pools and queues -- there is
// nothing shared for them to contend on. This bench measures that claim
// directly through the public `RuntimeBackend` surface: N backend instances
// on N distinct scopes (one shared schema) running a fixed number of
// transact() writes CONCURRENTLY, against the same total write count run
// SERIALLY on one scope. Near-linear scaling (concurrent wall time well
// under N times the serial-equivalent single-scope share) demonstrates no
// cross-scope serialization; the only inherent serialization this backend
// has is same-scope (the row lock), which is explicitly out of scope for
// this issue to change and is already covered by
// `backend-postgres.pool-contention.test.ts`. Scope isolation's correctness
// half (a scope never observes another scope's writes) is the existing,
// thorough `backend-postgres.scope-isolation.test.ts` suite; this bench adds
// only the lightweight per-scope hash-membership check needed to prove the
// concurrent run did not cross-contaminate scopes, not a duplicate of that
// suite.

import { randomUUID } from "node:crypto";
import process from "node:process";
import type { RuntimeBackend } from "@tuvren/kernel-protocol";
import {
  createStoredObjectRecord,
  formatNs,
  percentile,
  readSampleCountFromEnv,
  type TimingStats,
} from "@tuvren/kernel-testkit";
import {
  createPostgresBackend,
  destroyPostgresBackend,
  type PostgresBackendOptions,
} from "../src/index.js";

// `createPostgresBackend` returns the narrow `RuntimeBackend` surface;
// `close`/`destroy` are concrete `PostgresBackend` members outside that
// interface, the same reason `backend-postgres.pool-contention.test.ts` and
// `backend-postgres.scope-isolation.test.ts` both declare this local cast
// type rather than widening the public return type.
interface ClosablePostgresBackend extends RuntimeBackend {
  destroy(options?: { dropSchema?: boolean }): Promise<void>;
}

async function closeBackend(backend: RuntimeBackend): Promise<void> {
  await (backend as ClosablePostgresBackend).destroy();
}

// Network-bound, real-postgres bench: each repetition allocates fresh scopes
// so per-scope object count never grows across repetitions (a growing scope
// would conflate this bench's cross-scope-parallelism question with the
// already-measured whole-blob write-latency growth curve). Override via
// BENCH_SAMPLE_COUNT; the default is intentionally smaller than the
// per-write latency benches' n=15 because each sample here is itself
// SCOPE_COUNT * WRITES_PER_SCOPE real transact() round trips, not one.
const SAMPLE_COUNT = readSampleCountFromEnv(5);
const SCOPE_COUNT = 4;
const WRITES_PER_SCOPE = 20;
const DEVENV_DATABASE_NAME = "tuvren_runtime";

interface RepetitionResult {
  concurrentNs: number;
  serialNs: number;
}

await main();

async function main(): Promise<void> {
  process.stdout.write("postgres backend cross-scope throughput benchmark\n");
  process.stdout.write(
    `sample count: ${SAMPLE_COUNT} (BENCH_SAMPLE_COUNT to override), ${SCOPE_COUNT} scopes x ${WRITES_PER_SCOPE} writes per repetition\n`
  );

  const schemaName = `bench_cross_scope_${randomUUID().replaceAll("-", "_")}`;
  const results: RepetitionResult[] = [];

  try {
    for (let repetition = 0; repetition < SAMPLE_COUNT; repetition += 1) {
      results.push(await runRepetition(schemaName, repetition));
    }
  } finally {
    await destroyPostgresBackend(createBenchBackendOptions(schemaName));
  }

  const concurrentSamples = results.map((result) => result.concurrentNs);
  const serialSamples = results.map((result) => result.serialNs);
  const concurrentStats = summarize(concurrentSamples);
  const serialStats = summarize(serialSamples);
  const scalingFactorBest = concurrentStats.bestNs / serialStats.bestNs;
  const scalingFactorMedian = concurrentStats.medianNs / serialStats.medianNs;

  process.stdout.write(
    `concurrent (${SCOPE_COUNT} scopes in parallel, ${WRITES_PER_SCOPE} writes each): best ${formatNs(
      concurrentStats.bestNs
    )}, median ${formatNs(concurrentStats.medianNs)}, p95 ${formatNs(
      concurrentStats.p95Ns
    )}, avg ${formatNs(concurrentStats.averageNs)}\n`
  );
  process.stdout.write(
    `serial (1 scope, ${SCOPE_COUNT * WRITES_PER_SCOPE} writes sequentially): best ${formatNs(
      serialStats.bestNs
    )}, median ${formatNs(serialStats.medianNs)}, p95 ${formatNs(
      serialStats.p95Ns
    )}, avg ${formatNs(serialStats.averageNs)}\n`
  );
  process.stdout.write(
    `scaling factor (concurrent / serial): best ${scalingFactorBest.toFixed(
      3
    )}, median ${scalingFactorMedian.toFixed(3)} (near 1/${SCOPE_COUNT}=${(
      1 / SCOPE_COUNT
    ).toFixed(
      3
    )} indicates no cross-scope serialization; near 1 would indicate full serialization)\n`
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "postgres-cross-scope-throughput",
        concurrentStats,
        generatedAt: new Date().toISOString(),
        scalingFactorBest,
        scalingFactorMedian,
        scopeCount: SCOPE_COUNT,
        serialStats,
        writesPerScope: WRITES_PER_SCOPE,
      },
      null,
      2
    )}\n`
  );
}

async function runRepetition(
  schemaName: string,
  repetition: number
): Promise<RepetitionResult> {
  const concurrentScopeNames = Array.from(
    { length: SCOPE_COUNT },
    (_unused, index) => `cross-scope-concurrent-${repetition}-${index}`
  );
  const serialScopeName = `cross-scope-serial-${repetition}`;

  const concurrentBackends = concurrentScopeNames.map((scope) =>
    createPostgresBackend(createBenchBackendOptions(schemaName, scope))
  );
  const serialBackend = createPostgresBackend(
    createBenchBackendOptions(schemaName, serialScopeName)
  );

  // Pre-initialize every backend (schema/table provisioning, the per-scope
  // snapshot row) OUTSIDE the timed window, the same discipline
  // `backend-postgres.pool-contention.test.ts` uses -- otherwise cold-start
  // schema initialization on the first backend would masquerade as
  // cross-scope contention.
  for (const backend of [...concurrentBackends, serialBackend]) {
    await backend.health();
  }

  const expectedHashesByScope: string[][] = concurrentScopeNames.map(() => []);

  const startedConcurrentAt = process.hrtime.bigint();
  await Promise.all(
    concurrentBackends.map(async (backend, scopeIndex) => {
      for (let writeIndex = 0; writeIndex < WRITES_PER_SCOPE; writeIndex += 1) {
        const record = await createStoredObjectRecord(
          seededObjectBytes(repetition, scopeIndex, writeIndex),
          1000 + writeIndex
        );
        expectedHashesByScope[scopeIndex]?.push(record.hash);
        await backend.transact(async (tx) => {
          await tx.objects.put(record);
        });
      }
    })
  );
  const concurrentNs = Number(process.hrtime.bigint() - startedConcurrentAt);

  const startedSerialAt = process.hrtime.bigint();
  for (
    let writeIndex = 0;
    writeIndex < SCOPE_COUNT * WRITES_PER_SCOPE;
    writeIndex += 1
  ) {
    const record = await createStoredObjectRecord(
      seededObjectBytes(repetition, SCOPE_COUNT, writeIndex),
      1000 + writeIndex
    );
    await serialBackend.transact(async (tx) => {
      await tx.objects.put(record);
    });
  }
  const serialNs = Number(process.hrtime.bigint() - startedSerialAt);

  // Scope-isolation sanity check for this repetition's concurrent run: each
  // scope must see exactly its own writes and none of its siblings'.
  await assertScopeIsolation(concurrentBackends, expectedHashesByScope);

  for (const backend of [...concurrentBackends, serialBackend]) {
    await closeBackend(backend);
  }

  return { concurrentNs, serialNs };
}

async function assertScopeIsolation(
  backends: ReturnType<typeof createPostgresBackend>[],
  expectedHashesByScope: string[][]
): Promise<void> {
  for (const [scopeIndex, backend] of backends.entries()) {
    const ownHashes = expectedHashesByScope[scopeIndex] ?? [];
    const siblingHashes = expectedHashesByScope
      .filter((_unused, otherIndex) => otherIndex !== scopeIndex)
      .flat();

    await backend.transact(async (tx) => {
      for (const hash of ownHashes) {
        if (!(await tx.objects.has(hash))) {
          throw new Error(
            `expected scope ${scopeIndex} to contain its own write ${hash}`
          );
        }
      }
      for (const hash of siblingHashes) {
        if (await tx.objects.has(hash)) {
          throw new Error(
            `expected scope ${scopeIndex} to be isolated from sibling scope write ${hash}`
          );
        }
      }
    });
  }
}

function summarize(samples: readonly number[]): TimingStats {
  const sorted = [...samples].sort((left, right) => left - right);

  return {
    averageNs:
      samples.reduce((total, sample) => total + sample, 0) / samples.length,
    bestNs: Math.min(...samples),
    medianNs: percentile(sorted, 0.5),
    n: samples.length,
    p95Ns: percentile(sorted, 0.95),
  };
}

function createBenchBackendOptions(
  schemaName: string,
  scope?: string
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
    port,
    schemaName,
    scope,
    username,
  };
}

function seededObjectBytes(
  repetition: number,
  scopeIndex: number,
  writeIndex: number
): Uint8Array {
  return new Uint8Array([
    repetition % 251,
    scopeIndex % 251,
    writeIndex % 251,
    Math.floor(writeIndex / 251) % 251,
  ]);
}
