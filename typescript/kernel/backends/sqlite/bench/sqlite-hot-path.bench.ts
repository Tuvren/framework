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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createRecordingPhaseObserver } from "@tuvren/backend-shared";
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
} from "@tuvren/kernel-testkit";
import { createSqliteBackend } from "../src/index.js";

// Override via BENCH_SAMPLE_COUNT; see postgres-write-latency.bench.ts /
// sqlite-load-cost.bench.ts for the n=5 -> p95≈max rationale. transact() on
// this backend was not phase-instrumented in M1 (issue #108): SQLite's write
// path is already row-granular, not a full-blob rewrite, so it has no
// decode/validate-committed/encode seam to attribute. The B2-closure
// milestone (see the report's "B2" section) adds a single
// "validate-write-set" phase around transact()'s pre-commit
// validateTransactionWriteSet call, so the phase table below now reports
// exactly that one phase per case instead of being empty -- it measures the
// write-path validate share this milestone's B2 closure cites.
const SAMPLE_COUNT = readSampleCountFromEnv(15);
const WARMUP_ITERATIONS = 3;
const HOT_PATH_HISTORY_SIZES = [0, 100, 500, 1000] as const;

interface BenchmarkCase {
  historySize: number;
  iterations: number;
  name: string;
  prepare?(iterations: number): Promise<void>;
  run(iterations: number): Promise<void>;
}

interface BenchmarkResult {
  averageNs: number;
  bestNs: number;
  historySize: number;
  iterations: number;
  medianNs: number;
  name: string;
  p95Ns: number;
  phases: PhaseStats[];
}

interface SeededHistory {
  headTurnNodeHash: string;
  historySize: number;
  midTurnNodeHash: string;
  rootTurnNodeHash: string;
  threadId: string;
}

await main();

async function main(): Promise<void> {
  process.stdout.write("sqlite backend hot-path benchmark\n");
  const results: BenchmarkResult[] = [];

  for (const historySize of HOT_PATH_HISTORY_SIZES) {
    const tempDirectory = mkdtempSync(join(tmpdir(), "tuvren-sqlite-bench-"));

    try {
      const observer = createRecordingPhaseObserver();
      const backend = createSqliteBackend({
        databasePath: join(tempDirectory, "kraken.db"),
        phaseObserver: observer,
      });

      const seededHistory = await seedHistory(backend, historySize);

      for (const benchmarkCase of createBenchmarkCases(
        backend,
        seededHistory
      )) {
        const result = await measure(benchmarkCase, observer);
        results.push(result);
        process.stdout.write(
          `${result.name} at ${result.historySize} TurnNodes (n=${SAMPLE_COUNT}): best ${formatNs(
            result.bestNs
          )} total, ${formatNs(result.bestNs / result.iterations)}/iter; median ${formatNs(
            result.medianNs / result.iterations
          )}/iter; p95 ${formatNs(result.p95Ns / result.iterations)}/iter; avg ${formatNs(
            result.averageNs
          )} total\n`
        );
        process.stdout.write(formatPhaseTable(result.phases));
      }
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "sqlite-hot-path",
        generatedAt: new Date().toISOString(),
        results: results.map((result) => ({
          averageNs: result.averageNs,
          averagePerIterationNs: result.averageNs / result.iterations,
          bestNs: result.bestNs,
          bestPerIterationNs: result.bestNs / result.iterations,
          historySize: result.historySize,
          iterations: result.iterations,
          medianNs: result.medianNs,
          medianPerIterationNs: result.medianNs / result.iterations,
          name: result.name,
          p95Ns: result.p95Ns,
          p95PerIterationNs: result.p95Ns / result.iterations,
          phases: result.phases,
        })),
      },
      null,
      2
    )}\n`
  );
}

function createBenchmarkCases(
  backend: RuntimeBackend,
  seededHistory: SeededHistory
): BenchmarkCase[] {
  let forwardBranchCounter = 0;
  let membershipBranchCounter = 0;
  let nonRootForwardBranchCounter = 0;
  let objectWriteCounter = 0;
  let rollbackArchiveCounter = 0;
  let rollbackBranchCounter = 0;
  const rollbackBranches: Array<{
    branchId: string;
    createdAtMs: number;
  }> = [];
  const historySize = seededHistory.historySize;

  return [
    {
      historySize,
      iterations: 25,
      name: "no-op transaction",
      async run(iterations) {
        for (let index = 0; index < iterations; index += 1) {
          await backend.transact(async () => undefined);
        }
      },
    },
    {
      historySize,
      iterations: 15,
      name: "single object write transaction",
      async run(iterations) {
        for (let index = 0; index < iterations; index += 1) {
          const objectIndex = objectWriteCounter;
          objectWriteCounter += 1;
          const objectRecord = await createStoredObjectRecord(
            new Uint8Array([
              historySize % 251,
              objectIndex % 251,
              Math.floor(objectIndex / 251) % 251,
            ]),
            10_000 + historySize * 1000 + objectIndex
          );
          await backend.transact(async (tx) => {
            await tx.objects.put(objectRecord);
          });
        }
      },
    },
    {
      historySize,
      iterations: 15,
      name: "deep branch membership transaction",
      async run(iterations) {
        for (let index = 0; index < iterations; index += 1) {
          const branchIndex = membershipBranchCounter;
          membershipBranchCounter += 1;
          const createdAtMs = 20_000 + historySize * 1000 + branchIndex;

          await backend.transact(async (tx) => {
            await tx.branches.set({
              branchId: `branch_lineage_membership_${historySize}_${branchIndex}`,
              createdAtMs,
              headTurnNodeHash: seededHistory.headTurnNodeHash,
              threadId: seededHistory.threadId,
              updatedAtMs: createdAtMs,
            });
          });
        }
      },
    },
    {
      historySize,
      iterations: 10,
      name: "deep branch forward transaction",
      async run(iterations) {
        for (let index = 0; index < iterations; index += 1) {
          const branchIndex = forwardBranchCounter;
          forwardBranchCounter += 1;
          const createdAtMs = 30_000 + historySize * 1000 + branchIndex * 2;
          const branchId = `branch_lineage_forward_${historySize}_${branchIndex}`;

          await backend.transact(async (tx) => {
            await tx.branches.set({
              branchId,
              createdAtMs,
              headTurnNodeHash: seededHistory.rootTurnNodeHash,
              threadId: seededHistory.threadId,
              updatedAtMs: createdAtMs,
            });
            await tx.branches.set({
              branchId,
              createdAtMs,
              headTurnNodeHash: seededHistory.headTurnNodeHash,
              threadId: seededHistory.threadId,
              updatedAtMs: createdAtMs + 1,
            });
          });
        }
      },
    },
    {
      historySize,
      iterations: 10,
      name: "deep branch non-root forward transaction",
      async run(iterations) {
        for (let index = 0; index < iterations; index += 1) {
          const branchIndex = nonRootForwardBranchCounter;
          nonRootForwardBranchCounter += 1;
          const createdAtMs = 40_000 + historySize * 1000 + branchIndex * 2;
          const branchId = `branch_lineage_non_root_forward_${historySize}_${branchIndex}`;

          await backend.transact(async (tx) => {
            await tx.branches.set({
              branchId,
              createdAtMs,
              headTurnNodeHash: seededHistory.midTurnNodeHash,
              threadId: seededHistory.threadId,
              updatedAtMs: createdAtMs,
            });
            await tx.branches.set({
              branchId,
              createdAtMs,
              headTurnNodeHash: seededHistory.headTurnNodeHash,
              threadId: seededHistory.threadId,
              updatedAtMs: createdAtMs + 1,
            });
          });
        }
      },
    },
    {
      async prepare(iterations) {
        for (let index = 0; index < iterations; index += 1) {
          const branchIndex = rollbackBranchCounter;
          rollbackBranchCounter += 1;
          const createdAtMs = 50_000 + historySize * 1000 + branchIndex * 3;
          const branchId = `branch_lineage_non_root_rollback_${historySize}_${branchIndex}`;

          await backend.transact(async (tx) => {
            await tx.branches.set({
              branchId,
              createdAtMs,
              headTurnNodeHash: seededHistory.headTurnNodeHash,
              threadId: seededHistory.threadId,
              updatedAtMs: createdAtMs,
            });
          });
          rollbackBranches.push({ branchId, createdAtMs });
        }
      },
      historySize,
      iterations: 10,
      name: "deep branch non-root rollback transaction",
      async run(iterations) {
        for (let index = 0; index < iterations; index += 1) {
          const rollbackBranch = rollbackBranches.shift();

          if (rollbackBranch === undefined) {
            throw new Error("expected prepared rollback branch");
          }

          const archiveIndex = rollbackArchiveCounter;
          rollbackArchiveCounter += 1;
          const updatedAtMs = rollbackBranch.createdAtMs + 1;

          if (
            seededHistory.midTurnNodeHash === seededHistory.headTurnNodeHash
          ) {
            await backend.transact(async (tx) => {
              await tx.branches.set({
                branchId: rollbackBranch.branchId,
                createdAtMs: rollbackBranch.createdAtMs,
                headTurnNodeHash: seededHistory.headTurnNodeHash,
                threadId: seededHistory.threadId,
                updatedAtMs,
              });
            });
            continue;
          }

          await backend.transact(async (tx) => {
            await tx.branches.set({
              archivedFromBranchId: rollbackBranch.branchId,
              branchId: `branch_lineage_non_root_rollback_archive_${historySize}_${archiveIndex}`,
              createdAtMs: updatedAtMs,
              headTurnNodeHash: seededHistory.headTurnNodeHash,
              threadId: seededHistory.threadId,
              updatedAtMs,
            });
            await tx.branches.set({
              branchId: rollbackBranch.branchId,
              createdAtMs: rollbackBranch.createdAtMs,
              headTurnNodeHash: seededHistory.midTurnNodeHash,
              threadId: seededHistory.threadId,
              updatedAtMs,
            });
          });
        }
      },
    },
  ];
}

async function measure(
  benchmarkCase: BenchmarkCase,
  observer: ReturnType<typeof createRecordingPhaseObserver>
): Promise<BenchmarkResult> {
  const warmupIterations = Math.min(
    WARMUP_ITERATIONS,
    benchmarkCase.iterations
  );
  await benchmarkCase.prepare?.(warmupIterations);
  await benchmarkCase.run(warmupIterations);

  // Only attribute phases for the measured samples below, not the warmup
  // iterations above.
  observer.reset();

  const samples: number[] = [];

  for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
    await benchmarkCase.prepare?.(benchmarkCase.iterations);
    const startedAt = process.hrtime.bigint();
    await benchmarkCase.run(benchmarkCase.iterations);
    const elapsedNs = Number(process.hrtime.bigint() - startedAt);
    samples.push(elapsedNs);
  }

  const bestNs = Math.min(...samples);
  const sortedSamples = [...samples].sort((left, right) => left - right);
  const medianNs = percentile(sortedSamples, 0.5);
  const p95Ns = percentile(sortedSamples, 0.95);
  const averageNs =
    samples.reduce((total, sample) => total + sample, 0) / samples.length;

  return {
    averageNs,
    bestNs,
    historySize: benchmarkCase.historySize,
    iterations: benchmarkCase.iterations,
    phases: summarizePhases(observer.samples),
    medianNs,
    name: benchmarkCase.name,
    p95Ns,
  };
}

async function seedHistory(
  backend: RuntimeBackend,
  extraTurnNodeCount: number
): Promise<SeededHistory> {
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

  for (let index = 0; index < extraTurnNodeCount; index += 1) {
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
  const midTurnNode = turnNodes.at(Math.floor((turnNodes.length - 1) / 2));

  if (headTurnNode === undefined || midTurnNode === undefined) {
    throw new Error("expected seeded head turn node");
  }

  const thread: StoredThread = {
    createdAtMs: 5000,
    rootTurnNodeHash: rootTurnNode.hash,
    schemaId: schema.schemaId,
    threadId: `thread_bench_${extraTurnNodeCount}`,
  };
  const branch: StoredBranch = {
    branchId: `branch_bench_${extraTurnNodeCount}`,
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
    turnId: `turn_bench_${extraTurnNodeCount}`,
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

  return {
    headTurnNodeHash: headTurnNode.hash,
    historySize: extraTurnNodeCount,
    midTurnNodeHash: midTurnNode.hash,
    rootTurnNodeHash: rootTurnNode.hash,
    threadId: thread.threadId,
  };
}
