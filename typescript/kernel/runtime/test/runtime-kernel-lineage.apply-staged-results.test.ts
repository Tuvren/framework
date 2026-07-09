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

import { describe, expect, test } from "bun:test";
import type {
  StagedResult,
  TurnTreeManifest,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { applyStagedResultsToManifest } from "../src/lib/runtime-kernel-lineage.ts";

const SCHEMA: TurnTreeSchema = {
  incorporationRules: [
    { objectType: "message", targetPath: "messages" },
    { objectType: "summary", targetPath: "context.manifest" },
  ],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_apply_staged_results_test",
};

function stagedResult(
  objectType: string,
  objectHash: string,
  timestamp: number
): StagedResult {
  return {
    objectHash,
    objectType,
    status: "completed",
    taskId: `task_${objectHash}`,
    timestamp,
  };
}

const HASH_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

describe("applyStagedResultsToManifest", () => {
  test("appends ordered-path staged results without disturbing prior entries", () => {
    const manifest: TurnTreeManifest = {
      "context.manifest": null,
      messages: [],
    };

    applyStagedResultsToManifest(SCHEMA, manifest, [
      stagedResult("message", HASH_A, 1),
    ]);
    const afterFirst = [...(manifest.messages as string[])];
    expect(afterFirst).toEqual([HASH_A]);

    applyStagedResultsToManifest(SCHEMA, manifest, [
      stagedResult("message", HASH_B, 2),
    ]);
    const afterSecond = [...(manifest.messages as string[])];

    // Strict-prefix-preserving extension: every previously staged entry
    // survives, in order, at the head of the array.
    expect(afterSecond.slice(0, afterFirst.length)).toEqual(afterFirst);
    expect(afterSecond).toEqual([HASH_A, HASH_B]);

    applyStagedResultsToManifest(SCHEMA, manifest, [
      stagedResult("message", HASH_C, 3),
    ]);
    const afterThird = [...(manifest.messages as string[])];
    expect(afterThird.slice(0, afterSecond.length)).toEqual(afterSecond);
    expect(afterThird).toEqual([HASH_A, HASH_B, HASH_C]);
  });

  test("applying multiple staged results in one call preserves submission order", () => {
    const manifest: TurnTreeManifest = {
      "context.manifest": null,
      messages: [HASH_A],
    };

    applyStagedResultsToManifest(SCHEMA, manifest, [
      stagedResult("message", HASH_B, 2),
      stagedResult("message", HASH_C, 3),
    ]);

    expect(manifest.messages).toEqual([HASH_A, HASH_B, HASH_C]);
  });

  test("never reorders or drops an existing ordered entry, regardless of staging batch size", () => {
    const manifest: TurnTreeManifest = {
      "context.manifest": null,
      messages: [],
    };
    const hashes = [HASH_A, HASH_B, HASH_C];
    let previous: string[] = [];

    for (const hash of hashes) {
      applyStagedResultsToManifest(SCHEMA, manifest, [
        stagedResult("message", hash, hashes.indexOf(hash)),
      ]);
      const current = [...(manifest.messages as string[])];
      expect(current.length).toBe(previous.length + 1);
      expect(current.slice(0, previous.length)).toEqual(previous);
      previous = current;
    }
  });

  test("single-collection paths are replaced (last-write-wins), not appended", () => {
    const manifest: TurnTreeManifest = {
      "context.manifest": null,
      messages: [],
    };

    applyStagedResultsToManifest(SCHEMA, manifest, [
      stagedResult("summary", HASH_A, 1),
    ]);
    expect(manifest["context.manifest"]).toBe(HASH_A);

    applyStagedResultsToManifest(SCHEMA, manifest, [
      stagedResult("summary", HASH_B, 2),
    ]);
    expect(manifest["context.manifest"]).toBe(HASH_B);
  });

  test("rejects a staged result whose objectType has no incorporation rule", () => {
    const manifest: TurnTreeManifest = {
      "context.manifest": null,
      messages: [],
    };

    expect(() =>
      applyStagedResultsToManifest(SCHEMA, manifest, [
        stagedResult("unmapped-type", HASH_A, 1),
      ])
    ).toThrow();
  });
});
