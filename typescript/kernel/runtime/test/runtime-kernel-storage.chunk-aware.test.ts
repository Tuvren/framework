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
import { createMemoryBackend } from "@tuvren/backend-memory";
import { hashKernelRecord } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import {
  toStoredTurnTreePath,
  toStoredTurnTreePathChunkAware,
} from "../src/lib/runtime-kernel-storage.ts";
import { TEST_SCHEMA } from "./runtime-kernel-test-helpers.ts";

const THRESHOLD = 32;

async function seededHashes(
  count: number,
  seed = "chunk-aware-unit"
): Promise<string[]> {
  const hashes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    hashes.push(await hashKernelRecord(`${seed}-${index}`));
  }
  return hashes;
}

describe("toStoredTurnTreePathChunkAware fallback parity with toStoredTurnTreePath", () => {
  test("single-collection paths always delegate, regardless of priorTurnTreeHash", async () => {
    const backend = createMemoryBackend();
    const treeHash = await hashKernelRecord("chunk-aware-unit-single-tree");
    const unknownPriorHash = await hashKernelRecord(
      "chunk-aware-unit-unknown-prior"
    );
    await backend.transact(async (tx) => {
      const direct = toStoredTurnTreePath(
        treeHash,
        "single",
        "context.manifest",
        "abc"
      );
      const chunkAware = await toStoredTurnTreePathChunkAware(
        tx,
        treeHash,
        "single",
        "context.manifest",
        "abc",
        unknownPriorHash,
        () => 1
      );
      expect(chunkAware).toEqual(direct);
    });
  });

  test("priorTurnTreeHash undefined always delegates to the flat encoding", async () => {
    const backend = createMemoryBackend();
    const treeHash = await hashKernelRecord(
      "chunk-aware-unit-undefined-prior-tree"
    );
    const items = await seededHashes(THRESHOLD + 5);
    await backend.transact(async (tx) => {
      const direct = toStoredTurnTreePath(
        treeHash,
        "ordered",
        "messages",
        items
      );
      const chunkAware = await toStoredTurnTreePathChunkAware(
        tx,
        treeHash,
        "ordered",
        "messages",
        items,
        undefined,
        () => 1
      );
      expect(chunkAware).toEqual(direct);
      expect(chunkAware.collectionKind).toBe("ordered");
      if (chunkAware.collectionKind === "ordered") {
        expect(chunkAware.orderedEncoding).toBe("flat");
      }
    });
  });

  test("collections at or below the threshold always delegate to the flat encoding", async () => {
    const backend = createMemoryBackend();
    const treeHash = await hashKernelRecord(
      "chunk-aware-unit-below-threshold-tree"
    );
    const priorHash = await hashKernelRecord(
      "chunk-aware-unit-below-threshold-prior"
    );
    const items = await seededHashes(THRESHOLD);
    await backend.transact(async (tx) => {
      const direct = toStoredTurnTreePath(
        treeHash,
        "ordered",
        "messages",
        items
      );
      const chunkAware = await toStoredTurnTreePathChunkAware(
        tx,
        treeHash,
        "ordered",
        "messages",
        items,
        priorHash,
        () => 1
      );
      expect(chunkAware).toEqual(direct);
      expect(chunkAware.collectionKind).toBe("ordered");
      if (chunkAware.collectionKind === "ordered") {
        expect(chunkAware.orderedEncoding).toBe("flat");
      }
    });
  });

  test("no prior record at priorTurnTreeHash+path falls back to the flat encoding", async () => {
    const backend = createMemoryBackend();
    const treeHash = await hashKernelRecord(
      "chunk-aware-unit-no-prior-record-tree"
    );
    // No tree has ever been written at this hash, so tx.turnTreePaths.get
    // must resolve to null.
    const unknownPriorHash = await hashKernelRecord(
      "chunk-aware-unit-no-prior-record-prior"
    );
    const items = await seededHashes(THRESHOLD + 1);
    await backend.transact(async (tx) => {
      const direct = toStoredTurnTreePath(
        treeHash,
        "ordered",
        "messages",
        items
      );
      const chunkAware = await toStoredTurnTreePathChunkAware(
        tx,
        treeHash,
        "ordered",
        "messages",
        items,
        unknownPriorHash,
        () => 1
      );
      expect(chunkAware).toEqual(direct);
    });
  });

  test("a prior record whose collectionKind is not ordered falls back to the flat encoding", async () => {
    const backend = createMemoryBackend();
    const kernel = createRuntimeKernel({ backend, now: () => 1 });
    const schemaId = await kernel.schema.register(TEST_SCHEMA);
    const thread = await kernel.thread.create(
      "thread_chunk_aware_unit",
      schemaId,
      "branch_chunk_aware_unit"
    );
    const items = await seededHashes(THRESHOLD + 1);

    await backend.transact(async (tx) => {
      // "context.manifest" is declared "single" by TEST_SCHEMA; the root
      // tree already has a stored single-kind record at that path.
      const direct = toStoredTurnTreePath(
        thread.rootTurnTreeHash,
        "ordered",
        "context.manifest",
        items
      );
      const chunkAware = await toStoredTurnTreePathChunkAware(
        tx,
        thread.rootTurnTreeHash,
        "ordered",
        "context.manifest",
        items,
        thread.rootTurnTreeHash,
        () => 1
      );
      expect(chunkAware).toEqual(direct);
    });
  });

  test("a prior record that is ordered but still flat falls back to the flat encoding", async () => {
    const backend = createMemoryBackend();
    const kernel = createRuntimeKernel({ backend, now: () => 1 });
    const schemaId = await kernel.schema.register(TEST_SCHEMA);
    const thread = await kernel.thread.create(
      "thread_chunk_aware_unit_flat_prior",
      schemaId,
      "branch_chunk_aware_unit_flat_prior"
    );
    const items = await seededHashes(THRESHOLD + 1);

    await backend.transact(async (tx) => {
      // The root tree's "messages" path is an empty flat array (orderedCount
      // 0), not a chunked record, so this must not be treated as an
      // append-safe chunked prior.
      const direct = toStoredTurnTreePath(
        thread.rootTurnTreeHash,
        "ordered",
        "messages",
        items
      );
      const chunkAware = await toStoredTurnTreePathChunkAware(
        tx,
        thread.rootTurnTreeHash,
        "ordered",
        "messages",
        items,
        thread.rootTurnTreeHash,
        () => 1
      );
      expect(chunkAware).toEqual(direct);
    });
  });

  test("a shrinking or non-growing value against a chunked prior falls back to the flat encoding", async () => {
    const backend = createMemoryBackend();
    const kernel = createRuntimeKernel({ backend, now: () => 1 });
    const schemaId = await kernel.schema.register(TEST_SCHEMA);
    const thread = await kernel.thread.create(
      "thread_chunk_aware_unit_shrink",
      schemaId,
      "branch_chunk_aware_unit_shrink"
    );

    // Grow "messages" past the threshold via the real public API so a
    // genuinely chunked prior record exists to test the defensive
    // items.length < prior.orderedCount guard against.
    let treeHash = thread.rootTurnTreeHash;
    const grownItems = await seededHashes(THRESHOLD + 4, "shrink-guard");
    for (const [index, hash] of grownItems.entries()) {
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

    const storedPrior = await backend.transact(async (tx) =>
      tx.turnTreePaths.get(treeHash, "messages")
    );
    expect(storedPrior?.collectionKind).toBe("ordered");
    if (storedPrior?.collectionKind === "ordered") {
      expect(storedPrior.orderedEncoding).toBe("chunked");
      expect(storedPrior.orderedCount).toBe(grownItems.length);
    }

    const shorterItems = grownItems.slice(0, grownItems.length - 1);

    await backend.transact(async (tx) => {
      const direct = toStoredTurnTreePath(
        treeHash,
        "ordered",
        "messages",
        shorterItems
      );
      const chunkAware = await toStoredTurnTreePathChunkAware(
        tx,
        treeHash,
        "ordered",
        "messages",
        shorterItems,
        treeHash,
        () => 1
      );
      expect(chunkAware).toEqual(direct);
    });
  });
});
