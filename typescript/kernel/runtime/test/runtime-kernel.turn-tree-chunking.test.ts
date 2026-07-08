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
import { hashKernelRecord, type RuntimeBackend } from "@tuvren/kernel-protocol";
import type { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createThreadFixture } from "./runtime-kernel-test-helpers.ts";

const THRESHOLD = 32;

async function seededHashes(count: number, seed: string): Promise<string[]> {
  const hashes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    hashes.push(await hashKernelRecord(`${seed}-${index}`));
  }
  return hashes;
}

async function incorporateOneMessage(
  kernel: ReturnType<typeof createRuntimeKernel>,
  treeHash: string,
  objectHash: string,
  taskId: string
): Promise<string> {
  return await kernel.tree.incorporate(treeHash, [
    {
      objectHash,
      objectType: "message",
      status: "completed",
      taskId,
      timestamp: 1,
    },
  ]);
}

async function growMessagesOneAtATime(
  kernel: ReturnType<typeof createRuntimeKernel>,
  startTreeHash: string,
  hashes: string[]
): Promise<string> {
  let treeHash = startTreeHash;

  for (const [index, hash] of hashes.entries()) {
    treeHash = await incorporateOneMessage(
      kernel,
      treeHash,
      hash,
      `task_${index}`
    );
  }

  return treeHash;
}

async function rootTurnTreeHashOf(
  kernel: ReturnType<typeof createRuntimeKernel>,
  rootTurnNodeHash: string
): Promise<string> {
  const rootNode = await kernel.node.get(rootTurnNodeHash);

  if (rootNode === null) {
    throw new Error("expected the fixture's root turn node to exist");
  }

  return rootNode.turnTreeHash;
}

/**
 * Wraps a RuntimeBackend so every RuntimeBackendTx.orderedPathChunks.put call
 * is counted. RuntimeBackend implementations (MemoryBackend, SqliteBackend,
 * PostgresBackend) are plain classes that define capabilities/health/transact
 * on the prototype, not as own properties, so `{ ...inner }` would silently
 * drop those methods. Only capabilities/health/transact are exercised by the
 * write paths under test, and both are optional on RuntimeBackend, so this
 * wrapper only forwards what it needs instead of spreading `inner`.
 */
function withCountingOrderedPathChunkPuts(inner: RuntimeBackend): {
  backend: RuntimeBackend;
  putCount: () => number;
} {
  let count = 0;
  const backend: RuntimeBackend = {
    capabilities: () => inner.capabilities(),
    health: () => inner.health(),
    transact: (work) =>
      inner.transact((tx) =>
        work({
          ...tx,
          orderedPathChunks: {
            ...tx.orderedPathChunks,
            put: (record) => {
              count += 1;
              return tx.orderedPathChunks.put(record);
            },
          },
        })
      ),
  };
  return { backend, putCount: () => count };
}

describe("createRuntimeKernel chunk-aware TurnTree caller writes", () => {
  test("resolved manifest values match the pre-optimization full-flat-resubmission baseline", async () => {
    const fixture = await createThreadFixture();
    const rootTurnTreeHash = await rootTurnTreeHashOf(
      fixture.kernel,
      fixture.rootTurnNodeHash
    );
    const hashes = await seededHashes(THRESHOLD + 8, "correctness");

    const grownTreeHash = await growMessagesOneAtATime(
      fixture.kernel,
      rootTurnTreeHash,
      hashes
    );

    const resolvedViaIncorporate = await fixture.kernel.tree.resolve(
      grownTreeHash,
      "messages"
    );

    // What today's (unoptimized) caller would have submitted: the full flat
    // items array in one shot, via the base-less tree.create surface.
    const unoptimizedTreeHash = await fixture.kernel.tree.create(
      fixture.schemaId,
      {
        "context.manifest": null,
        messages: hashes,
      }
    );
    const resolvedViaFlat = await fixture.kernel.tree.resolve(
      unoptimizedTreeHash,
      "messages"
    );

    expect(resolvedViaIncorporate).toEqual(hashes);
    expect(resolvedViaFlat).toEqual(hashes);
    expect(resolvedViaIncorporate).toEqual(resolvedViaFlat);

    const manifest = await fixture.kernel.tree.manifest(grownTreeHash);
    expect(manifest.messages).toEqual(hashes);

    const storedPath = await fixture.backend.transact(async (tx) =>
      tx.turnTreePaths.get(grownTreeHash, "messages")
    );
    expect(storedPath?.collectionKind).toBe("ordered");
    if (storedPath?.collectionKind === "ordered") {
      expect(storedPath.orderedEncoding).toBe("chunked");
      expect(storedPath.orderedCount).toBe(hashes.length);
    }
  });

  test("collections at or below the chunking threshold keep the flat encoding unchanged", async () => {
    const fixture = await createThreadFixture();
    const rootTurnTreeHash = await rootTurnTreeHashOf(
      fixture.kernel,
      fixture.rootTurnNodeHash
    );
    const hashes = await seededHashes(THRESHOLD - 5, "below-threshold");

    const treeHash = await growMessagesOneAtATime(
      fixture.kernel,
      rootTurnTreeHash,
      hashes
    );

    const storedPath = await fixture.backend.transact(async (tx) =>
      tx.turnTreePaths.get(treeHash, "messages")
    );
    expect(storedPath?.collectionKind).toBe("ordered");
    if (storedPath?.collectionKind === "ordered") {
      expect(storedPath.orderedEncoding).toBe("flat");
      expect(storedPath.orderedCount).toBe(hashes.length);
    }

    const resolved = await fixture.kernel.tree.resolve(treeHash, "messages");
    expect(resolved).toEqual(hashes);
  });

  test("single-item appends past the threshold trigger exactly one new orderedPathChunks.put, not a full re-chunk", async () => {
    const { backend, putCount } = withCountingOrderedPathChunkPuts(
      createMemoryBackend()
    );
    const fixture = await createThreadFixture({ backend });
    const rootTurnTreeHash = await rootTurnTreeHashOf(
      fixture.kernel,
      fixture.rootTurnNodeHash
    );

    const steadyStateAppendCount = 6;
    const totalItems = THRESHOLD + 1 + steadyStateAppendCount;
    const hashes = await seededHashes(totalItems, "proportionality");

    // The threshold crossing itself (a flat prior being promoted to chunked
    // for the first time) re-chunks the whole collection, exactly like
    // today's unoptimized behavior — this is Gherkin Scenario 2's territory,
    // not Scenario 1's. Grow past that crossing first without asserting put
    // counts, then assert the "exactly one put per append" claim only once
    // a chunked prior genuinely exists (steady state).
    const crossingCount = THRESHOLD + 1;
    let treeHash = rootTurnTreeHash;

    for (let index = 0; index < crossingCount; index += 1) {
      treeHash = await incorporateOneMessage(
        fixture.kernel,
        treeHash,
        hashes[index] as string,
        `crossing_task_${index}`
      );
    }

    const storedAfterCrossing = await backend.transact(async (tx) =>
      tx.turnTreePaths.get(treeHash, "messages")
    );
    expect(storedAfterCrossing?.collectionKind).toBe("ordered");
    if (storedAfterCrossing?.collectionKind === "ordered") {
      expect(storedAfterCrossing.orderedEncoding).toBe("chunked");
    }

    for (let index = crossingCount; index < totalItems; index += 1) {
      const before = putCount();
      treeHash = await incorporateOneMessage(
        fixture.kernel,
        treeHash,
        hashes[index] as string,
        `steady_state_task_${index}`
      );
      const after = putCount();
      expect(after - before).toBe(1);
    }

    const resolved = await fixture.kernel.tree.resolve(treeHash, "messages");
    expect(resolved).toEqual(hashes);
  });
});
