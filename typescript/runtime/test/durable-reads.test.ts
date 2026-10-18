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

import { beforeEach, describe, expect, test } from "bun:test";

import { createMemoryBackend } from "@tuvren/backend-memory";
import { DEFAULT_SCOPE, TuvrenLineageError } from "@tuvren/core";
import type { TurnSnapshot } from "@tuvren/core/execution";
import { IDENTITY_PAYLOAD_CODEC } from "@tuvren/core/lifecycle";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";

import {
  getTurnHistory,
  getTurnState,
  listBranches,
  listThreads,
  readBranchMessages,
} from "../src/lib/durable-reads.js";
import type { PayloadCodecBinding } from "../src/lib/payload-codec-seam.js";
import type { RuntimeCoreOptions } from "../src/lib/runtime-core.js";
import {
  createTuvrenRuntime,
  DEFAULT_AGENT_SCHEMA,
} from "../src/lib/runtime-core.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const PLAINTEXT_BINDING: PayloadCodecBinding = {
  codec: IDENTITY_PAYLOAD_CODEC,
  scope: DEFAULT_SCOPE,
};

const makeKernel = () =>
  createRuntimeKernel({ backend: createMemoryBackend() });

const makeCoreOptions = (
  kernel: ReturnType<typeof makeKernel>
): RuntimeCoreOptions => ({
  defaultRunnerId: "test-runner",
  kernel,
});

const captureError = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }

  throw new Error("expected promise to reject");
};

// ── Cursor encode/decode round-trips (KRT-AO002) ──────────────────────────────

describe("KRT-AO002 cursor encode/decode", () => {
  test("listThreads cursor round-trips list-threads payload", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    await kernel.thread.create("t1", DEFAULT_AGENT_SCHEMA.schemaId, "b1");
    await kernel.thread.create("t2", DEFAULT_AGENT_SCHEMA.schemaId, "b2");

    const page1 = await listThreads(kernel, { limit: 1 });
    expect(page1.threads).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();
    if (page1.nextCursor === undefined) {
      throw new Error("expected the first page to include a cursor");
    }

    const page2 = await listThreads(kernel, {
      cursor: page1.nextCursor,
      limit: 10,
    });
    expect(page2.threads).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();

    const allIds = [
      page1.threads[0].threadId,
      page2.threads[0].threadId,
    ].toSorted();
    expect(allIds).toEqual(["t1", "t2"].toSorted());
  });

  test("decoding a malformed listThreads cursor raises invalid_durable_read_cursor", async () => {
    const kernel = makeKernel();
    expect(
      await captureError(listThreads(kernel, { cursor: "not-base64url!!!" }))
    ).toMatchObject({ code: "invalid_durable_read_cursor" });
  });

  test("decoding a valid-base64 but wrong-kind cursor raises invalid_durable_read_cursor", async () => {
    const wrongKind = Buffer.from(
      JSON.stringify({
        kind: "wrong-kind",
        lastCreatedAtMs: 1,
        lastThreadId: "x",
        v: 1,
      })
    ).toString("base64url");
    const kernel = makeKernel();
    expect(
      await captureError(listThreads(kernel, { cursor: wrongKind }))
    ).toMatchObject({ code: "invalid_durable_read_cursor" });
  });

  test("paging listThreads with mismatched filter raises durable_read_cursor_filter_mismatch", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    await kernel.thread.create("t1", DEFAULT_AGENT_SCHEMA.schemaId, "b1");
    await kernel.thread.create("t2", DEFAULT_AGENT_SCHEMA.schemaId, "b2");

    const page1 = await listThreads(kernel, {
      filter: { schemaId: "tuvren.agent.v1" },
      limit: 1,
    });
    expect(page1.nextCursor).toBeDefined();
    if (page1.nextCursor === undefined) {
      throw new Error("expected the filtered first page to include a cursor");
    }

    expect(
      await captureError(
        listThreads(kernel, {
          cursor: page1.nextCursor,
          // Deliberately differs from the cursor's original filter.
          filter: { schemaId: "other.schema.v1" },
        })
      )
    ).toMatchObject({ code: "durable_read_cursor_filter_mismatch" });
  });

  test("turn-history cursor: decoding a malformed cursor raises invalid_durable_read_cursor", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    const thread = await kernel.thread.create(
      "t1",
      DEFAULT_AGENT_SCHEMA.schemaId,
      "b1"
    );

    const badCursor = Buffer.from(
      JSON.stringify({ kind: "list-threads", v: 1 })
    ).toString("base64url");

    const gen = getTurnHistory(
      kernel,
      { branchId: thread.branchId, threadId: thread.threadId },
      { before: badCursor }
    );

    expect(await captureError(gen.next())).toMatchObject({
      code: "invalid_durable_read_cursor",
    });
  });

  test("branch-messages cursor: head drift raises durable_read_cursor_head_drift", async () => {
    // This test uses a non-empty branch where we page, then the head moves.
    // The test ensures the drift path is exercised when the cursor position
    // references a position beyond the new head's message count.
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    const thread = await kernel.thread.create(
      "t1",
      DEFAULT_AGENT_SCHEMA.schemaId,
      "b1"
    );

    // Issue a cursor with a made-up branchHeadAtCursorIssuance that doesn't match
    // any real head, referencing position 5 (beyond any actual messages).
    const staleCursor = Buffer.from(
      JSON.stringify({
        // This head deliberately does not exist.
        branchHeadAtCursorIssuance: "0".repeat(64),
        branchId: thread.branchId,
        kind: "branch-messages",
        positionFromOldest: 5,
        v: 1,
      })
    ).toString("base64url");

    expect(
      await captureError(
        readBranchMessages(kernel, PLAINTEXT_BINDING, {
          after: staleCursor,
          branchId: thread.branchId,
        })
      )
    ).toMatchObject({ code: "durable_read_cursor_head_drift" });
  });
});

// ── listBranches (KRT-AO003) ─────────────────────────────────────────────────

describe("KRT-AO003 listBranches", () => {
  test("returns BranchSummary[] for a thread with one branch", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    const thread = await kernel.thread.create(
      "t1",
      DEFAULT_AGENT_SCHEMA.schemaId,
      "b1"
    );

    const branches = await listBranches(kernel, { threadId: thread.threadId });
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({
      branchId: thread.branchId,
      threadId: thread.threadId,
    });
    expect(typeof branches[0].headTurnNodeHash).toBe("string");
  });

  test("returns all branches including diverged ones", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    const thread = await kernel.thread.create(
      "t1",
      DEFAULT_AGENT_SCHEMA.schemaId,
      "b1"
    );
    await kernel.branch.create("b2", thread.threadId, thread.rootTurnNodeHash);

    const branches = await listBranches(kernel, { threadId: thread.threadId });
    expect(branches).toHaveLength(2);
    const ids = branches.map((b) => b.branchId).toSorted();
    expect(ids).toEqual(["b1", "b2"].toSorted());
  });
});

// ── getTurnState (KRT-AO004) ─────────────────────────────────────────────────

describe("KRT-AO004 getTurnState", () => {
  test("returns TurnSnapshot for the current branch head when turnNodeHash is omitted", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    const thread = await kernel.thread.create(
      "t1",
      DEFAULT_AGENT_SCHEMA.schemaId,
      "b1"
    );

    const snapshot = await getTurnState(kernel, {
      branchId: thread.branchId,
      threadId: thread.threadId,
    });

    expect(snapshot.turnNodeHash).toBe(thread.rootTurnNodeHash);
    expect(snapshot.previousTurnNodeHash).toBeNull();
    expect(typeof snapshot.turnTreeHash).toBe("string");
    expect(snapshot.schemaId).toBe(DEFAULT_AGENT_SCHEMA.schemaId);
    expect(
      snapshot.eventHash === null || typeof snapshot.eventHash === "string"
    ).toBe(true);
    expect(snapshot.manifest).toBeNull();
    expect(typeof snapshot.paths).toBe("object");
  });

  test("returns TurnSnapshot for a specific turnNodeHash", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    const thread = await kernel.thread.create(
      "t1",
      DEFAULT_AGENT_SCHEMA.schemaId,
      "b1"
    );

    const snapshot = await getTurnState(kernel, {
      branchId: thread.branchId,
      threadId: thread.threadId,
      turnNodeHash: thread.rootTurnNodeHash,
    });

    expect(snapshot.turnNodeHash).toBe(thread.rootTurnNodeHash);
  });

  test("throws TuvrenLineageError for an unknown branchId", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);

    expect(
      await captureError(
        getTurnState(kernel, { branchId: "nonexistent", threadId: "t1" })
      )
    ).toBeInstanceOf(TuvrenLineageError);
  });
});

// ── getTurnHistory (KRT-AO004) ────────────────────────────────────────────────

describe("KRT-AO004 getTurnHistory", () => {
  test("yields TurnSnapshot values newest-first, respecting limit", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    const thread = await kernel.thread.create(
      "t1",
      DEFAULT_AGENT_SCHEMA.schemaId,
      "b1"
    );

    // The root node has no previous — only one turn node to walk.
    const snapshots: TurnSnapshot[] = [];
    for await (const snap of getTurnHistory(
      kernel,
      { branchId: thread.branchId, threadId: thread.threadId },
      { limit: 10 }
    )) {
      snapshots.push(snap);
    }

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].turnNodeHash).toBe(thread.rootTurnNodeHash);
  });

  test("respects limit of 0 and yields nothing", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    const thread = await kernel.thread.create(
      "t1",
      DEFAULT_AGENT_SCHEMA.schemaId,
      "b1"
    );

    const snapshots: TurnSnapshot[] = [];
    for await (const snap of getTurnHistory(
      kernel,
      { branchId: thread.branchId, threadId: thread.threadId },
      { limit: 0 }
    )) {
      snapshots.push(snap);
    }

    expect(snapshots).toHaveLength(0);
  });

  test("throws TuvrenLineageError for an unknown branchId", async () => {
    const kernel = makeKernel();
    const gen = getTurnHistory(kernel, {
      branchId: "nonexistent",
      threadId: "t1",
    });

    expect(await captureError(gen.next())).toBeInstanceOf(TuvrenLineageError);
  });
});

// ── readBranchMessages (KRT-AO005) ───────────────────────────────────────────

describe("KRT-AO005 readBranchMessages", () => {
  test("returns empty messages for a fresh branch (no messages stored)", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    const thread = await kernel.thread.create(
      "t1",
      DEFAULT_AGENT_SCHEMA.schemaId,
      "b1"
    );

    const result = await readBranchMessages(kernel, PLAINTEXT_BINDING, {
      branchId: thread.branchId,
    });
    expect(result.messages).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });

  test("returns empty array for schemas without a messages path", async () => {
    const kernel = makeKernel();
    await kernel.schema.register({
      incorporationRules: [],
      paths: [{ collection: "single", path: "context.manifest" }],
      schemaId: "schema_no_messages",
    });
    const thread = await kernel.thread.create("t1", "schema_no_messages", "b1");

    const result = await readBranchMessages(kernel, PLAINTEXT_BINDING, {
      branchId: thread.branchId,
    });
    expect(result.messages).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });

  test("returns TuvrenValidationError with durable_read_cursor_head_drift on prefix divergence", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    const thread = await kernel.thread.create(
      "t1",
      DEFAULT_AGENT_SCHEMA.schemaId,
      "b1"
    );

    // Manufacture a stale cursor beyond actual message count.
    const staleCursor = Buffer.from(
      JSON.stringify({
        branchHeadAtCursorIssuance: "0".repeat(64),
        branchId: thread.branchId,
        kind: "branch-messages",
        positionFromOldest: 99,
        v: 1,
      })
    ).toString("base64url");

    expect(
      await captureError(
        readBranchMessages(kernel, PLAINTEXT_BINDING, {
          after: staleCursor,
          branchId: thread.branchId,
        })
      )
    ).toMatchObject({ code: "durable_read_cursor_head_drift" });
  });

  test("throws TuvrenLineageError for an unknown branchId", async () => {
    const kernel = makeKernel();
    expect(
      await captureError(
        readBranchMessages(kernel, PLAINTEXT_BINDING, {
          branchId: "nonexistent",
        })
      )
    ).toBeInstanceOf(TuvrenLineageError);
  });
});

// ── TuvrenRuntime wiring (five methods exposed through assembled instance) ────

describe("TuvrenRuntime durable-read surface wiring", () => {
  let kernel: ReturnType<typeof makeKernel>;
  let runtime: ReturnType<typeof createTuvrenRuntime>;

  beforeEach(async () => {
    kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    runtime = createTuvrenRuntime(makeCoreOptions(kernel));
  });

  test("listThreads is accessible on the assembled runtime", async () => {
    const result = await runtime.listThreads();
    expect(Array.isArray(result.threads)).toBe(true);
  });

  test("listBranches is accessible on the assembled runtime", async () => {
    const thread = await runtime.createThread({});
    const branches = await runtime.listBranches({ threadId: thread.threadId });
    expect(branches).toHaveLength(1);
    expect(branches[0].threadId).toBe(thread.threadId);
  });

  test("getTurnState is accessible on the assembled runtime", async () => {
    const thread = await runtime.createThread({});
    const snapshot = await runtime.getTurnState({
      branchId: thread.branchId,
      threadId: thread.threadId,
    });
    expect(snapshot.turnNodeHash).toBe(thread.rootTurnNodeHash);
  });

  test("getTurnHistory is accessible on the assembled runtime", async () => {
    const thread = await runtime.createThread({});
    const snapshots: TurnSnapshot[] = [];
    for await (const snap of runtime.getTurnHistory({
      branchId: thread.branchId,
      threadId: thread.threadId,
    })) {
      snapshots.push(snap);
    }
    expect(snapshots).toHaveLength(1);
  });

  test("readBranchMessages is accessible on the assembled runtime", async () => {
    const thread = await runtime.createThread({});
    const result = await runtime.readBranchMessages({
      branchId: thread.branchId,
    });
    expect(result.messages).toHaveLength(0);
  });
});
