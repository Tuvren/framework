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

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { after, describe, test } from "node:test";
import { hashKernelRecord, type TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createSqliteBackend } from "../src/index.js";
import { createTempDatabasePath } from "./backend-sqlite-test-helpers.js";

// KRT-BK008 (ADR-011): proves the runtime's chunk-aware TurnTree caller
// writes (typescript/kernel/runtime's toStoredTurnTreePathChunkAware) resolve
// identically against the sqlite backend to the deterministic expected value,
// the same proof kernel-runtime/test/runtime-kernel.turn-tree-chunking.test.ts
// performs against the memory backend. This lives here rather than in
// kernel-runtime/test because @tuvren/backend-sqlite already depends on
// @tuvren/kernel-runtime for its own kernel-level tests; adding the reverse
// devDependency edge from kernel-runtime to backend-sqlite creates a real
// Nx project-graph cycle (confirmed empirically: `backend-sqlite:test -->
// kernel-runtime:build --> ... --> kernel-runtime:build`).

const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_sqlite_chunk_aware_writes",
} satisfies TurnTreeSchema;

const THRESHOLD = 32;
const openBackends: { close(): Promise<void> }[] = [];

after(async () => {
  for (const backend of openBackends) {
    await backend.close();
  }
});

async function seededHashes(count: number, seed: string): Promise<string[]> {
  const hashes: string[] = [];

  for (let index = 0; index < count; index += 1) {
    hashes.push(await hashKernelRecord(`${seed}-${index}`));
  }

  return hashes;
}

describe("createSqliteBackend chunk-aware TurnTree caller writes (KRT-BK008)", () => {
  test("resolves the expected manifest after growing an ordered path past the ADR-011 chunking threshold", async () => {
    const backend = createSqliteBackend({
      databasePath: createTempDatabasePath(),
    });
    openBackends.push(backend);
    const kernel = createRuntimeKernel({ backend, now: () => 1 });
    const schemaId = await kernel.schema.register(TEST_SCHEMA);
    const thread = await kernel.thread.create(
      "thread_chunk_aware_writes",
      schemaId,
      "branch_chunk_aware_writes"
    );
    const rootNode = await kernel.node.get(thread.rootTurnNodeHash);

    if (rootNode === null) {
      throw new Error("expected the root turn node to exist");
    }

    const hashes = await seededHashes(THRESHOLD + 6, "sqlite-chunk-parity");
    let treeHash = rootNode.turnTreeHash;

    for (const [index, hash] of hashes.entries()) {
      treeHash = await kernel.tree.incorporate(treeHash, [
        {
          objectHash: hash,
          objectType: "message",
          status: "completed",
          taskId: `task_${index}`,
          timestamp: 1,
        },
      ]);
    }

    const resolved = await kernel.tree.resolve(treeHash, "messages");
    deepStrictEqual(resolved, hashes);

    const storedPath = await backend.transact(async (tx) =>
      tx.turnTreePaths.get(treeHash, "messages")
    );
    strictEqual(storedPath?.collectionKind, "ordered");

    if (storedPath?.collectionKind === "ordered") {
      strictEqual(storedPath.orderedEncoding, "chunked");
      strictEqual(storedPath.orderedCount, hashes.length);
    }
  });

  test("collections at or below the chunking threshold keep the flat encoding unchanged", async () => {
    const backend = createSqliteBackend({
      databasePath: createTempDatabasePath(),
    });
    openBackends.push(backend);
    const kernel = createRuntimeKernel({ backend, now: () => 1 });
    const schemaId = await kernel.schema.register(TEST_SCHEMA);
    const thread = await kernel.thread.create(
      "thread_chunk_aware_writes_flat",
      schemaId,
      "branch_chunk_aware_writes_flat"
    );
    const rootNode = await kernel.node.get(thread.rootTurnNodeHash);

    if (rootNode === null) {
      throw new Error("expected the root turn node to exist");
    }

    const hashes = await seededHashes(THRESHOLD - 5, "sqlite-below-threshold");
    let treeHash = rootNode.turnTreeHash;

    for (const [index, hash] of hashes.entries()) {
      treeHash = await kernel.tree.incorporate(treeHash, [
        {
          objectHash: hash,
          objectType: "message",
          status: "completed",
          taskId: `task_${index}`,
          timestamp: 1,
        },
      ]);
    }

    const storedPath = await backend.transact(async (tx) =>
      tx.turnTreePaths.get(treeHash, "messages")
    );
    strictEqual(storedPath?.collectionKind, "ordered");

    if (storedPath?.collectionKind === "ordered") {
      strictEqual(storedPath.orderedEncoding, "flat");
      strictEqual(storedPath.orderedCount, hashes.length);
    }
  });
});
