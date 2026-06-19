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

// KRT-BE006 — Scope-Resolved Durable Identity + Durable-Read Scope Safety.
//
// The Durable-Read Surface (listThreads, listBranches, state-at-TurnNode,
// history walk, branch messages, store.has/store.get) is backend-agnostic
// framework composition over kernel structural primitives (ADR-036). This suite
// is the authoritative proof of that composition: constructed over a scope-bound
// backend, every surface operation returns only the constructing scope's state,
// and identical content under two scopes is two independent durable objects with
// no cross-scope dedup (ADR-049).
//
// The composition has no backend-specific branch, so the in-memory backend is
// the canonical substrate here (and the only one the framework's Bun test runner
// can load — better-sqlite3 is Node-only and PostgreSQL is a service backend).
// Per-substrate confinement of the durable-identity records this surface reads
// is proven across all three backends in each backend package's own
// scope-isolation suite, and cross-backend conformance lands in KRT-BE007.

import { describe, expect, test } from "bun:test";
import {
  createMemoryBackend,
  createMemoryScopeStore,
} from "@tuvren/backend-memory";
import { TuvrenLineageError, TuvrenRuntimeError } from "@tuvren/core";
import type { TuvrenMessage } from "@tuvren/core/messages";
import {
  encodeDeterministicKernelRecord,
  type RuntimeBackend,
  type RuntimeKernel,
  type StoredBranch,
  type StoredThread,
  type TurnTreeManifest,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "@tuvren/kernel-testkit";
import {
  getTurnHistory,
  getTurnState,
  listBranches,
  listThreads,
  readBranchMessages,
} from "../src/lib/durable-reads.js";

// ── Seeding ──────────────────────────────────────────────────────────────────

interface SeededScopeState {
  branchId: string;
  headTurnNodeHash: string;
  messageContent: string;
  messageHash: string;
  threadId: string;
}

interface SeedOptions {
  base: number;
  branchId: string;
  messageContent: string;
  threadId: string;
}

// Seeds a complete message-bearing branch (schema, message object, turn tree
// with a populated `messages` path, genesis turn node, thread, and branch) so
// every Durable-Read Surface operation has real state to either reveal or hide.
async function seedThreadWithMessage(
  backend: RuntimeBackend,
  options: SeedOptions
): Promise<SeededScopeState> {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, options.base);

  const message: TuvrenMessage = {
    content: options.messageContent,
    role: "system",
  };
  const messageObject = await createStoredObjectRecord(
    encodeDeterministicKernelRecord(message),
    options.base + 1
  );

  const manifest: TurnTreeManifest = {
    "context.manifest": null,
    messages: [messageObject.hash],
  };
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    manifest,
    options.base + 2
  );
  const turnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: options.base + 3,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread: StoredThread = {
    createdAtMs: options.base + 4,
    rootTurnNodeHash: turnNode.hash,
    schemaId: schema.schemaId,
    threadId: options.threadId,
  };
  const branch: StoredBranch = {
    branchId: options.branchId,
    createdAtMs: options.base + 5,
    headTurnNodeHash: turnNode.hash,
    threadId: options.threadId,
    updatedAtMs: options.base + 5,
  };

  await backend.transact(async (tx) => {
    await tx.schemas.put(schemaRecord);
    await tx.objects.put(messageObject);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, manifest)
    );
    await tx.turnNodes.put(turnNode);
    await tx.threads.put(thread);
    await tx.branches.set(branch);
  });

  return {
    branchId: options.branchId,
    headTurnNodeHash: turnNode.hash,
    messageContent: options.messageContent,
    messageHash: messageObject.hash,
    threadId: options.threadId,
  };
}

// ── Shared assertions ────────────────────────────────────────────────────────

// Proves the constructing scope observes its own complete durable-read surface.
async function assertSurfaceRevealed(
  kernel: RuntimeKernel,
  seeded: SeededScopeState
): Promise<void> {
  const threads = await listThreads(kernel);
  expect(threads.threads.map((thread) => thread.threadId)).toEqual([
    seeded.threadId,
  ]);

  const branches = await listBranches(kernel, { threadId: seeded.threadId });
  expect(branches.map((branch) => branch.branchId)).toEqual([seeded.branchId]);

  const state = await getTurnState(kernel, {
    branchId: seeded.branchId,
    threadId: seeded.threadId,
  });
  expect(state.turnNodeHash).toBe(seeded.headTurnNodeHash);

  const history: string[] = [];
  for await (const snapshot of getTurnHistory(kernel, {
    branchId: seeded.branchId,
    threadId: seeded.threadId,
  })) {
    history.push(snapshot.turnNodeHash);
  }
  expect(history).toEqual([seeded.headTurnNodeHash]);

  const messages = await readBranchMessages(kernel, {
    branchId: seeded.branchId,
  });
  expect(messages.messages).toEqual([
    { content: seeded.messageContent, role: "system" },
  ]);

  expect(await kernel.store.has(seeded.messageHash)).toBe(true);
  expect(await kernel.store.get(seeded.messageHash)).not.toBeNull();
}

// Proves a co-tenant scope observes none of another scope's durable-read
// surface: enumerations are empty, lineage reads reject the unknown branch, and
// the message content is not even existence-checkable.
async function assertSurfaceHidden(
  kernel: RuntimeKernel,
  seeded: SeededScopeState
): Promise<void> {
  const threads = await listThreads(kernel);
  expect(threads.threads).toEqual([]);

  // The thread itself is invisible, so enumerating its branches surfaces the
  // same "unknown thread" error a caller would get for any id that never
  // existed — it never leaks that another scope owns this thread.
  await expect(
    listBranches(kernel, { threadId: seeded.threadId })
  ).rejects.toBeInstanceOf(TuvrenRuntimeError);

  await expect(
    getTurnState(kernel, {
      branchId: seeded.branchId,
      threadId: seeded.threadId,
    })
  ).rejects.toBeInstanceOf(TuvrenLineageError);

  const history = getTurnHistory(kernel, {
    branchId: seeded.branchId,
    threadId: seeded.threadId,
  });
  await expect(history.next()).rejects.toBeInstanceOf(TuvrenLineageError);

  await expect(
    readBranchMessages(kernel, { branchId: seeded.branchId })
  ).rejects.toBeInstanceOf(TuvrenLineageError);

  expect(await kernel.store.has(seeded.messageHash)).toBe(false);
  expect(await kernel.store.get(seeded.messageHash)).toBeNull();
}

// ── Scoped kernel pair (shared substrate, distinct scopes) ───────────────────

const SCOPE_A = "tenant-a";
const SCOPE_B = "tenant-b";

interface ScopedPair {
  backendA: RuntimeBackend;
  backendB: RuntimeBackend;
  kernelA: RuntimeKernel;
  kernelB: RuntimeKernel;
}

function createScopedMemoryPair(): ScopedPair {
  const store = createMemoryScopeStore();
  const backendA = createMemoryBackend({ scope: SCOPE_A, store });
  const backendB = createMemoryBackend({ scope: SCOPE_B, store });
  return {
    backendA,
    backendB,
    kernelA: createRuntimeKernel({ backend: backendA }),
    kernelB: createRuntimeKernel({ backend: backendB }),
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("durable-read scope isolation (KRT-BE006)", () => {
  test("a co-tenant scope observes none of another scope's durable-read surface, while the constructing scope observes all of it", async () => {
    const { kernelA, kernelB, backendA } = createScopedMemoryPair();

    const seeded = await seedThreadWithMessage(backendA, {
      base: 100,
      branchId: "branch_a",
      messageContent: "scope-a-only-message",
      threadId: "thread_a",
    });

    await assertSurfaceHidden(kernelB, seeded);
    await assertSurfaceRevealed(kernelA, seeded);
  });

  test("scope-resolved durable identity: identical content is two independent objects and shared thread/branch ids resolve per scope", async () => {
    const { kernelA, kernelB, backendA, backendB } = createScopedMemoryPair();

    // Identical opaque content stored under scope A is not dedup'd into scope B:
    // the content hash matches, yet scope B cannot existence-check it until it
    // independently stores its own copy, and that store leaves scope A
    // untouched.
    const sharedBytes = new Uint8Array([7, 7, 7]);
    const recordA = await createStoredObjectRecord(sharedBytes, 1);
    await backendA.transact(async (tx) => {
      await tx.objects.put(recordA);
    });
    expect(await kernelB.store.has(recordA.hash)).toBe(false);

    const recordB = await createStoredObjectRecord(sharedBytes, 1);
    expect(recordB.hash).toBe(recordA.hash);
    await backendB.transact(async (tx) => {
      await tx.objects.put(recordB);
    });
    expect(await kernelB.store.has(recordB.hash)).toBe(true);
    expect(await kernelA.store.has(recordA.hash)).toBe(true);

    // The same logical thread/branch ids exist in both scopes but resolve to
    // independent durable objects: each scope reads only its own message.
    const seededA = await seedThreadWithMessage(backendA, {
      base: 200,
      branchId: "shared_branch",
      messageContent: "scope-a-content",
      threadId: "shared_thread",
    });
    const seededB = await seedThreadWithMessage(backendB, {
      base: 200,
      branchId: "shared_branch",
      messageContent: "scope-b-content",
      threadId: "shared_thread",
    });

    const messagesA = await readBranchMessages(kernelA, {
      branchId: "shared_branch",
    });
    const messagesB = await readBranchMessages(kernelB, {
      branchId: "shared_branch",
    });
    expect(messagesA.messages).toEqual([
      { content: "scope-a-content", role: "system" },
    ]);
    expect(messagesB.messages).toEqual([
      { content: "scope-b-content", role: "system" },
    ]);

    // Distinct content yields distinct hashes, and neither scope can
    // existence-check the other scope's message object.
    expect(seededA.messageHash).not.toBe(seededB.messageHash);
    expect(await kernelA.store.has(seededB.messageHash)).toBe(false);
    expect(await kernelB.store.has(seededA.messageHash)).toBe(false);
  });
});
