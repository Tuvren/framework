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

// Issue #108 M4 review debt: a permanent diagnostic for the "why A1 is
// refuted" claim in the M4 report section of
// `.constitution/reports/108-git-faithful-blob-persistence.md` -- that the
// per-family clone+sort step `encodeSnapshot` runs on every `transact()`
// (`Array.from(map.values(), cloneStoredObject).sort(compare)`) is only a
// small fraction of `encode`'s total cost, not the dominant term. M4 ran
// this measurement with an ad-hoc, uncommitted script; this commits it as a
// reproducible target so the ~4-8% attribution in the report can be
// re-measured on demand instead of taken on faith. No PostgreSQL connection
// is needed: this isolates exactly the in-memory clone+sort step, bypassing
// CBOR encoding and the database entirely.

import process from "node:process";
import type { StoredObject } from "@tuvren/kernel-protocol";
import {
  createStoredObjectRecord,
  formatNs,
  percentile,
  readSampleCountFromEnv,
} from "@tuvren/kernel-testkit";

const SAMPLE_COUNT = readSampleCountFromEnv(15);
const WARMUP_ITERATIONS = 2;
const FAMILY_SIZE = readFamilySizeFromEnv(10_000);

await main();

async function main(): Promise<void> {
  process.stdout.write(
    "postgres backend encode-family (clone+sort) micro-benchmark\n"
  );
  process.stdout.write(
    `sample count: ${SAMPLE_COUNT} (BENCH_SAMPLE_COUNT to override); family size: ${FAMILY_SIZE} (BENCH_FAMILY_SIZE to override)\n`
  );

  const family = await seedObjectFamily(FAMILY_SIZE);

  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    cloneAndSortFamily(family);
  }

  const samples: number[] = [];
  for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
    const startedAt = process.hrtime.bigint();
    cloneAndSortFamily(family);
    samples.push(Number(process.hrtime.bigint() - startedAt));
  }

  const sortedSamples = [...samples].sort((left, right) => left - right);
  const result = {
    averageNs:
      samples.reduce((total, sample) => total + sample, 0) / samples.length,
    bestNs: Math.min(...samples),
    familySize: FAMILY_SIZE,
    medianNs: percentile(sortedSamples, 0.5),
    n: samples.length,
    p95Ns: percentile(sortedSamples, 0.95),
  };

  process.stdout.write(
    `family at ${result.familySize} objects (n=${result.n}): best ${formatNs(
      result.bestNs
    )} median ${formatNs(result.medianNs)} p95 ${formatNs(
      result.p95Ns
    )} avg ${formatNs(result.averageNs)}\n`
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "postgres-encode-family",
        generatedAt: new Date().toISOString(),
        result,
      },
      null,
      2
    )}\n`
  );
}

/** Clones and sorts every object in `family`, mirroring `encodeSnapshot`'s per-family step for `objects`. */
function cloneAndSortFamily(family: ReadonlyMap<string, StoredObject>): void {
  Array.from(family.values(), cloneStoredObjectForBench).sort(
    compareStoredObjectForBench
  );
}

/**
 * Mirrors `postgres-backend-persistence.ts`'s (private, unexported)
 * `cloneStoredObject`/`compareStoredObject` shape used inside
 * `encodeSnapshot`, so this isolates the identical clone+sort cost that
 * function pays per family without depending on its private internals.
 */
function cloneStoredObjectForBench(record: StoredObject): StoredObject {
  return {
    byteLength: record.byteLength,
    bytes: Uint8Array.from(record.bytes),
    createdAtMs: record.createdAtMs,
    hash: record.hash,
    mediaType: record.mediaType,
  };
}

function compareStoredObjectForBench(
  left: StoredObject,
  right: StoredObject
): number {
  return left.hash.localeCompare(right.hash);
}

async function seedObjectFamily(
  familySize: number
): Promise<Map<string, StoredObject>> {
  const family = new Map<string, StoredObject>();

  for (let index = 0; index < familySize; index += 1) {
    const record = await createStoredObjectRecord(
      new Uint8Array([
        index % 251,
        Math.floor(index / 251) % 251,
        Math.floor(index / 63_001) % 251,
      ]),
      10_000 + index
    );
    family.set(record.hash, record);
  }

  return family;
}

/**
 * Reads a `BENCH_FAMILY_SIZE` override from the environment, falling back to
 * `fallback`.
 */
function readFamilySizeFromEnv(fallback: number): number {
  const raw = process.env.BENCH_FAMILY_SIZE;

  if (raw === undefined || raw.length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `BENCH_FAMILY_SIZE must be a positive integer, received "${raw}"`
    );
  }

  return parsed;
}
