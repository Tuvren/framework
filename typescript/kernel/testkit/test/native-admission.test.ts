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

import { describe, test } from "bun:test";
import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import process from "node:process";

import {
  percentile,
  readSampleCountFromEnv,
  summarizePhases,
} from "../src/lib/bench-phase-stats.js";
import {
  createCanonicalTurnTreePaths,
  delay,
} from "../src/lib/kernel-test-fixtures.js";

describe("kernel testkit native admission preservation", () => {
  test("preserves decimal-prefix sample counts and first validation failures", () => {
    const previous = process.env.BENCH_SAMPLE_COUNT;
    try {
      for (const [raw, expected] of [
        ["42x", 42],
        ["1e2", 1],
        ["+3", 3],
        ["1.9", 1],
        [" 5 ", 5],
        ["\uFEFF2tail", 2],
        ["00034x", 34],
        ["1_000", 1],
      ] as const) {
        process.env.BENCH_SAMPLE_COUNT = raw;
        strictEqual(readSampleCountFromEnv(17), expected);
      }
      for (const raw of [
        "0x20",
        " ",
        "-3",
        "9007199254740992",
        "+0",
        "-0",
        "-1x",
        "NaN",
        "Infinity",
      ]) {
        process.env.BENCH_SAMPLE_COUNT = raw;
        throws(() => readSampleCountFromEnv(17), {
          message: `BENCH_SAMPLE_COUNT must be a positive integer, received "${raw}"`,
        });
      }
      process.env.BENCH_SAMPLE_COUNT = "";
      strictEqual(readSampleCountFromEnv(17), 17);
      delete process.env.BENCH_SAMPLE_COUNT;
      strictEqual(readSampleCountFromEnv(17), 17);
    } finally {
      if (previous === undefined) {
        delete process.env.BENCH_SAMPLE_COUNT;
      } else {
        process.env.BENCH_SAMPLE_COUNT = previous;
      }
    }
  });

  test("preserves phase sorting, input order, empty summaries and percentile errors", () => {
    const samples = [
      { durationNs: 3, phase: "load" },
      { durationNs: 9, phase: "write" },
      { durationNs: 1, phase: "load" },
      { durationNs: 2, phase: "load" },
    ] as const;
    const original = structuredClone(samples);
    deepStrictEqual(summarizePhases(samples), [
      { averageNs: 2, bestNs: 1, medianNs: 2, n: 3, p95Ns: 3, phase: "load" },
      { averageNs: 9, bestNs: 9, medianNs: 9, n: 1, p95Ns: 9, phase: "write" },
    ]);
    deepStrictEqual(samples, original);
    deepStrictEqual(summarizePhases([]), []);
    throws(() => percentile([], 0.5), {
      message: "expected benchmark samples",
    });
  });

  test("preserves canonical manifest validation order", () => {
    const tree = {
      createdAtMs: 1,
      hash: "fixture",
      manifestCbor: new Uint8Array(),
      schemaId: "fixture",
    };
    throws(
      () =>
        createCanonicalTurnTreePaths(tree, {
          "context.manifest": [],
          messages: null,
        }),
      {
        message:
          "manifest.messages must be an ordered hash array for the canonical kernel test schema",
      }
    );
    throws(
      () =>
        createCanonicalTurnTreePaths(tree, {
          "context.manifest": [],
          messages: [],
        }),
      {
        message:
          'manifest["context.manifest"] must be a hash string or null for the canonical kernel test schema',
      }
    );
  });

  test("delay waits for its timer before completing", async () => {
    const calls: string[] = [];
    const waiting = delay(0);
    calls.push("called");
    const observeCompletion = async (): Promise<void> => {
      await waiting;
      calls.push("completed");
    };
    const completion = observeCompletion();
    // A timer stays pending through this checkpoint, unlike an immediate result.
    const checkpoint = Promise.withResolvers<null>();
    queueMicrotask(() => {
      checkpoint.resolve(null);
    });
    await checkpoint.promise;
    deepStrictEqual(calls, ["called"]);
    await completion;
    deepStrictEqual(calls, ["called", "completed"]);
  });
});
