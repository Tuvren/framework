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

// KRT-BK007 measurement-only spike: wall-clock cost of health() (one full
// loadValidatedState() load per call) and reclaim() (loadValidatedState()
// called TWICE inside one writer-blocking transaction -- once to capture
// survivor keys before the sweep, once to re-validate referential integrity
// after it) as database size grows. Drives the backend exclusively through
// its public RuntimeBackend surface -- no production source under
// typescript/kernel/backends/sqlite/src changes as part of this spike.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  createRecordingPhaseObserver,
  type RecordingPhaseObserver,
} from "@tuvren/backend-shared";
import type {
  RuntimeBackend,
  StoredBranch,
  StoredThread,
  StoredTurn,
} from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
  formatNs,
  formatPhaseTable,
  type PhaseStats,
  percentile,
  readSampleCountFromEnv,
  summarizePhases,
  type TimingStats,
} from "@tuvren/kernel-testkit";
import { createSqliteBackend } from "../src/index.js";

// Default sample count for the decisive large tiers (1k, 10k): the KRT-BK007
// spike ran n=5, where p95 collapses onto max. The 10k tier is slow enough
// (pre-optimization: ~9s/sample health(), ~16s/sample reclaim()) that a full
// n=15 run at every tier can take minutes; override via BENCH_SAMPLE_COUNT for
// a quicker local loop, and BENCH_DATABASE_SIZES (comma-separated) to run one
// tier at a time.
const SAMPLE_COUNT = readSampleCountFromEnv(15);
const WARMUP_ITERATIONS = 2;
// Turn node chain length; an equal count of orphaned (unreferenced) objects
// is seeded alongside it so reclaim() has real, size-independent sweep work
// to do at every database size (see reseedOrphanGarbage).
const DATABASE_SIZES = readDatabaseSizesFromEnv([10, 100, 1000, 10_000]);
// Reseeded before every reclaim() sample so each sample's actual delete work
// is constant across database sizes -- isolating the load cost as the
// size-dependent variable rather than conflating it with sweep volume.
const ORPHAN_GARBAGE_PER_RECLAIM_SAMPLE = 25;

interface OperationResult extends TimingStats {
  phases: PhaseStats[];
}

interface LoadCostResult extends Record<string, unknown> {
  databaseSize: number;
  health: OperationResult;
  lastReclaimReleasedObjectCount: number;
  reclaim: OperationResult;
}

await main();

async function main(): Promise<void> {
  process.stdout.write("sqlite backend load-cost benchmark\n");
  process.stdout.write(
    `sample count: ${SAMPLE_COUNT} (BENCH_SAMPLE_COUNT to override); sizes: ${DATABASE_SIZES.join(", ")} (BENCH_DATABASE_SIZES to override)\n`
  );
  const results: LoadCostResult[] = [];

  for (const databaseSize of DATABASE_SIZES) {
    const tempDirectory = mkdtempSync(
      join(tmpdir(), "tuvren-sqlite-load-cost-bench-")
    );

    try {
      const observer = createRecordingPhaseObserver();
      const backend = createSqliteBackend({
        databasePath: join(tempDirectory, "kraken.db"),
        phaseObserver: observer,
      });

      await seedChain(backend, databaseSize);
      let orphanSequence = 0;
      orphanSequence = await seedOrphanObjects(
        backend,
        databaseSize,
        orphanSequence,
        databaseSize
      );

      const health = await measureRepeated(
        WARMUP_ITERATIONS,
        SAMPLE_COUNT,
        {
          run: async () => {
            const outcome = await backend.health();
            if (!outcome.ok) {
              throw new Error(`health() reported unhealthy: ${outcome.reason}`);
            }
          },
        },
        observer
      );

      let lastReclaimReleasedObjectCount = 0;
      const reclaim = await measureRepeated(
        1,
        SAMPLE_COUNT,
        {
          prepareSample: async () => {
            orphanSequence = await seedOrphanObjects(
              backend,
              databaseSize,
              orphanSequence,
              ORPHAN_GARBAGE_PER_RECLAIM_SAMPLE
            );
          },
          run: async () => {
            if (backend.reclaim === undefined) {
              throw new Error("expected sqlite backend to implement reclaim()");
            }
            const summary = await backend.reclaim({ nowMs: Date.now() });
            lastReclaimReleasedObjectCount = summary.releasedObjectCount;
          },
        },
        observer
      );

      const result: LoadCostResult = {
        databaseSize,
        health,
        lastReclaimReleasedObjectCount,
        reclaim,
      };
      results.push(result);
      process.stdout.write(
        `database at ${databaseSize} turn nodes (n=${health.n}): health best ${formatNs(
          health.bestNs
        )} median ${formatNs(health.medianNs)} p95 ${formatNs(
          health.p95Ns
        )}; reclaim best ${formatNs(reclaim.bestNs)} median ${formatNs(
          reclaim.medianNs
        )} p95 ${formatNs(reclaim.p95Ns)} (releasedObjectCount=${lastReclaimReleasedObjectCount}); reclaim/health best ratio ${(
          reclaim.bestNs / health.bestNs
        ).toFixed(2)}x\n`
      );
      process.stdout.write("  health phases:\n");
      process.stdout.write(formatPhaseTable(health.phases, "    "));
      process.stdout.write("  reclaim phases:\n");
      process.stdout.write(formatPhaseTable(reclaim.phases, "    "));
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "sqlite-load-cost",
        generatedAt: new Date().toISOString(),
        results,
      },
      null,
      2
    )}\n`
  );
}

interface RepeatedMeasurement {
  prepareSample?(sampleIndex: number): Promise<void>;
  run(): Promise<void>;
}

async function measureRepeated(
  warmupIterations: number,
  sampleCount: number,
  measurement: RepeatedMeasurement,
  observer: RecordingPhaseObserver
): Promise<OperationResult> {
  for (let index = 0; index < warmupIterations; index += 1) {
    await measurement.prepareSample?.(-1 - index);
    await measurement.run();
  }

  // Only attribute phases for the measured samples below, not the warmup
  // iterations above, so the phase table lines up with the reported sample
  // count.
  observer.reset();

  const samples: number[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    await measurement.prepareSample?.(sampleIndex);
    const startedAt = process.hrtime.bigint();
    await measurement.run();
    samples.push(Number(process.hrtime.bigint() - startedAt));
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
  };
}

async function seedChain(
  backend: RuntimeBackend,
  turnNodeCount: number
): Promise<void> {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, 1);
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    {
      "context.manifest": null,
      messages: [],
    },
    2
  );
  const rootTurnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 3,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const turnNodes = [rootTurnNode];

  for (let index = 0; index < turnNodeCount; index += 1) {
    const previousTurnNode = turnNodes.at(-1);

    if (previousTurnNode === undefined) {
      throw new Error("expected seeded root turn node");
    }

    turnNodes.push(
      await createStoredTurnNodeRecord({
        consumedStagedResults: [],
        createdAtMs: 4 + index,
        eventHash: null,
        previousTurnNodeHash: previousTurnNode.hash,
        schemaId: schema.schemaId,
        turnTreeHash: turnTree.hash,
      })
    );
  }

  const headTurnNode = turnNodes.at(-1);

  if (headTurnNode === undefined) {
    throw new Error("expected seeded head turn node");
  }

  const thread: StoredThread = {
    createdAtMs: 5000,
    rootTurnNodeHash: rootTurnNode.hash,
    schemaId: schema.schemaId,
    threadId: `thread_bench_${turnNodeCount}`,
  };
  const branch: StoredBranch = {
    branchId: `branch_bench_${turnNodeCount}`,
    createdAtMs: 5001,
    headTurnNodeHash: headTurnNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 5001,
  };
  const turn: StoredTurn = {
    branchId: branch.branchId,
    createdAtMs: 5002,
    headTurnNodeHash: headTurnNode.hash,
    parentTurnId: null,
    startTurnNodeHash: rootTurnNode.hash,
    threadId: thread.threadId,
    turnId: `turn_bench_${turnNodeCount}`,
    updatedAtMs: 5002,
  };

  await backend.transact(async (tx) => {
    await tx.schemas.put(schemaRecord);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, {
        "context.manifest": null,
        messages: [],
      })
    );

    for (const turnNode of turnNodes) {
      await tx.turnNodes.put(turnNode);
    }

    await tx.threads.put(thread);
    await tx.branches.set(branch);
    await tx.turns.set(turn);
  });
}

/**
 * Objects with no referencing TurnNode/Turn/Branch are unreachable by
 * construction, so reclaim()'s sweep always finds exactly `count` of them
 * regardless of database size -- this is what keeps reclaim()'s real delete
 * work constant across samples and sizes (see ORPHAN_GARBAGE_PER_RECLAIM_SAMPLE).
 * `startSequence` is a globally-unique running counter (not reset per call)
 * so bytes never collide across calls, even when a prior batch's objects
 * were already swept by an intervening reclaim() and a later batch reuses
 * small index values.
 */
async function seedOrphanObjects(
  backend: RuntimeBackend,
  databaseSize: number,
  startSequence: number,
  count: number
): Promise<number> {
  await backend.transact(async (tx) => {
    for (let offset = 0; offset < count; offset += 1) {
      const sequence = startSequence + offset;
      const record = await createStoredObjectRecord(
        new Uint8Array([
          databaseSize % 251,
          sequence % 251,
          Math.floor(sequence / 251) % 251,
          Math.floor(sequence / 63_001) % 251,
        ]),
        30_000 + sequence
      );
      await tx.objects.put(record);
    }
  });

  return startSequence + count;
}

/**
 * Reads a comma-separated `BENCH_DATABASE_SIZES` override from the
 * environment (e.g. `BENCH_DATABASE_SIZES=10000` to run one decisive tier at
 * a time), falling back to `fallback`.
 */
function readDatabaseSizesFromEnv(fallback: readonly number[]): number[] {
  const raw = process.env.BENCH_DATABASE_SIZES;

  if (raw === undefined || raw.length === 0) {
    return [...fallback];
  }

  return raw.split(",").map((entry) => {
    const parsed = Number.parseInt(entry.trim(), 10);

    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(
        `BENCH_DATABASE_SIZES entries must be non-negative integers, received "${entry}"`
      );
    }

    return parsed;
  });
}
