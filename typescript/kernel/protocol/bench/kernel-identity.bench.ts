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

import type { KernelRecord } from "@tuvren/core";
import {
  encodeDeterministicKernelRecord,
  hashKernelRecord,
} from "../src/index.ts";

const SAMPLE_COUNT = 5;
const WARMUP_ITERATIONS = 20;
const RECORD_FIXTURE = createKernelRecord(20, 4);
const bunRuntime = globalThis as typeof globalThis & {
  Bun: { nanoseconds(): number };
};

interface BenchmarkCase {
  iterations: number;
  name: string;
  run(iterations: number): Promise<void> | void;
}

interface BenchmarkResult {
  averageNs: number;
  bestNs: number;
  iterations: number;
  name: string;
}

const cases: BenchmarkCase[] = [
  {
    iterations: 1200,
    name: "deterministic CBOR encode canonical nested record",
    run(iterations) {
      for (let index = 0; index < iterations; index += 1) {
        encodeDeterministicKernelRecord(RECORD_FIXTURE);
      }
    },
  },
  {
    iterations: 250,
    name: "deterministic CBOR encode and SHA-256 hash",
    async run(iterations) {
      for (let index = 0; index < iterations; index += 1) {
        await hashKernelRecord(RECORD_FIXTURE);
      }
    },
  },
];

await main();

async function main(): Promise<void> {
  process.stdout.write("kernel identity benchmark\n");

  for (const benchmarkCase of cases) {
    const result = await measure(benchmarkCase);
    process.stdout.write(
      `${result.name}: best ${formatNs(result.bestNs)} total, ${formatNs(
        result.bestNs / result.iterations
      )}/iter; avg ${formatNs(result.averageNs)} total\n`
    );
  }
}

async function measure(benchmarkCase: BenchmarkCase): Promise<BenchmarkResult> {
  await benchmarkCase.run(
    Math.min(WARMUP_ITERATIONS, benchmarkCase.iterations)
  );

  const samples: number[] = [];

  for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
    const startedAt = nanoseconds();
    await benchmarkCase.run(benchmarkCase.iterations);
    samples.push(nanoseconds() - startedAt);
  }

  const bestNs = Math.min(...samples);
  const averageNs =
    samples.reduce((total, sample) => total + sample, 0) / samples.length;

  return {
    averageNs,
    bestNs,
    iterations: benchmarkCase.iterations,
    name: benchmarkCase.name,
  };
}

function createKernelRecord(width: number, depth: number): KernelRecord {
  const record: Record<string, KernelRecord> = {
    createdAtMs: 1,
    schemaId: "schema-bench",
  };

  for (let index = 0; index < width; index += 1) {
    record[`key_${String(index).padStart(3, "0")}`] = createNestedValue(
      index,
      depth
    );
  }

  return record;
}

function createNestedValue(seed: number, depth: number): KernelRecord {
  if (depth === 0) {
    return seed;
  }

  return {
    children: [
      createNestedValue(seed + 1, depth - 1),
      createNestedValue(seed + 2, depth - 1),
    ],
    enabled: seed % 2 === 0,
    label: `node-${seed}-${depth}`,
  };
}

function formatNs(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}ms`;
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}us`;
  }

  return `${value.toFixed(0)}ns`;
}

function nanoseconds(): number {
  return bunRuntime.Bun.nanoseconds();
}
