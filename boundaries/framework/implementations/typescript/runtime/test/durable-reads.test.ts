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
import type {
  BranchMessagesCursor,
  ListThreadsCursor,
  TurnHistoryCursor,
} from "@tuvren/core/execution";
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

function makeKernel() {
  return createRuntimeKernel({ backend: createMemoryBackend() });
}

function makeCoreOptions(
  kernel: ReturnType<typeof makeKernel>
): RuntimeCoreOptions {
  return {
    defaultDriverId: "test-driver",
    kernel,
  };
}

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

    const page2 = await listThreads(kernel, {
      limit: 10,
      cursor: page1.nextCursor as ListThreadsCursor,
    });
    expect(page2.threads).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();

    const allIds = [
      page1.threads[0].threadId,
      page2.threads[0].threadId,
    ].sort();
    expect(allIds).toEqual(["t1", "t2"].sort());
  });

  test("decoding a malformed listThreads cursor raises invalid_durable_read_cursor", async () => {
    const kernel = makeKernel();
    await expect(
      listThreads(kernel, { cursor: "not-base64url!!!" as ListThreadsCursor })
    ).rejects.toMatchObject({ code: "invalid_durable_read_cursor" });
  });

  test("decoding a valid-base64 but wrong-kind cursor raises invalid_durable_read_cursor", async () => {
    const wrongKind = Buffer.from(
      JSON.stringify({
        v: 1,
        kind: "wrong-kind",
        lastThreadId: "x",
        lastCreatedAtMs: 1,
      })
    ).toString("base64url");
    const kernel = makeKernel();
    await expect(
      listThreads(kernel, { cursor: wrongKind as ListThreadsCursor })
    ).rejects.toMatchObject({ code: "invalid_durable_read_cursor" });
  });

  test("paging listThreads with mismatched filter raises durable_read_cursor_filter_mismatch", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
    await kernel.thread.create("t1", DEFAULT_AGENT_SCHEMA.schemaId, "b1");
    await kernel.thread.create("t2", DEFAULT_AGENT_SCHEMA.schemaId, "b2");

    const page1 = await listThreads(kernel, {
      limit: 1,
      filter: { schemaId: "tuvren.agent.v1" },
    });
    expect(page1.nextCursor).toBeDefined();

    await expect(
      listThreads(kernel, {
        cursor: page1.nextCursor as ListThreadsCursor,
        filter: { schemaId: "other.schema.v1" }, // mismatch
      })
    ).rejects.toMatchObject({ code: "durable_read_cursor_filter_mismatch" });
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
      JSON.stringify({ v: 1, kind: "list-threads" })
    ).toString("base64url");

    const gen = getTurnHistory(
      kernel,
      { threadId: thread.threadId, branchId: thread.branchId },
      { before: badCursor as TurnHistoryCursor }
    );

    await expect(gen.next()).rejects.toMatchObject({
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
        v: 1,
        kind: "branch-messages",
        branchId: thread.branchId,
        positionFromOldest: 5,
        branchHeadAtCursorIssuance: "0".repeat(64), // fake old head
      })
    ).toString("base64url");

    await expect(
      readBranchMessages(kernel, PLAINTEXT_BINDING, {
        branchId: thread.branchId,
        after: staleCursor as BranchMessagesCursor,
      })
    ).rejects.toMatchObject({ code: "durable_read_cursor_head_drift" });
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
    const ids = branches.map((b) => b.branchId).sort();
    expect(ids).toEqual(["b1", "b2"].sort());
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
      threadId: thread.threadId,
      branchId: thread.branchId,
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
      threadId: thread.threadId,
      branchId: thread.branchId,
      turnNodeHash: thread.rootTurnNodeHash,
    });

    expect(snapshot.turnNodeHash).toBe(thread.rootTurnNodeHash);
  });

  test("throws TuvrenLineageError for an unknown branchId", async () => {
    const kernel = makeKernel();
    await kernel.schema.register(DEFAULT_AGENT_SCHEMA);

    await expect(
      getTurnState(kernel, { threadId: "t1", branchId: "nonexistent" })
    ).rejects.toBeInstanceOf(TuvrenLineageError);
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
    const snapshots: import("@tuvren/runtime-api").TurnSnapshot[] = [];
    for await (const snap of getTurnHistory(
      kernel,
      { threadId: thread.threadId, branchId: thread.branchId },
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

    const snapshots: import("@tuvren/runtime-api").TurnSnapshot[] = [];
    for await (const snap of getTurnHistory(
      kernel,
      { threadId: thread.threadId, branchId: thread.branchId },
      { limit: 0 }
    )) {
      snapshots.push(snap);
    }

    expect(snapshots).toHaveLength(0);
  });

  test("throws TuvrenLineageError for an unknown branchId", async () => {
    const kernel = makeKernel();
    const gen = getTurnHistory(kernel, {
      threadId: "t1",
      branchId: "nonexistent",
    });

    await expect(gen.next()).rejects.toBeInstanceOf(TuvrenLineageError);
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
        v: 1,
        kind: "branch-messages",
        branchId: thread.branchId,
        positionFromOldest: 99,
        branchHeadAtCursorIssuance: "0".repeat(64),
      })
    ).toString("base64url");

    await expect(
      readBranchMessages(kernel, PLAINTEXT_BINDING, {
        branchId: thread.branchId,
        after: staleCursor as BranchMessagesCursor,
      })
    ).rejects.toMatchObject({ code: "durable_read_cursor_head_drift" });
  });

  test("throws TuvrenLineageError for an unknown branchId", async () => {
    const kernel = makeKernel();
    await expect(
      readBranchMessages(kernel, PLAINTEXT_BINDING, { branchId: "nonexistent" })
    ).rejects.toBeInstanceOf(TuvrenLineageError);
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
      threadId: thread.threadId,
      branchId: thread.branchId,
    });
    expect(snapshot.turnNodeHash).toBe(thread.rootTurnNodeHash);
  });

  test("getTurnHistory is accessible on the assembled runtime", async () => {
    const thread = await runtime.createThread({});
    const snapshots: import("@tuvren/runtime-api").TurnSnapshot[] = [];
    for await (const snap of runtime.getTurnHistory({
      threadId: thread.threadId,
      branchId: thread.branchId,
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
