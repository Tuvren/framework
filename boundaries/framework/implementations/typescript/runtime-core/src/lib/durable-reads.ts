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

import {
  TuvrenLineageError,
  TuvrenPersistenceError,
  TuvrenValidationError,
} from "@tuvren/core-types";
import {
  decodeDeterministicKernelRecord,
  type RuntimeKernel as KrakenKernel,
} from "@tuvren/kernel-protocol";
import {
  assertContextManifest,
  assertTuvrenMessage,
  type BranchMessagesCursor,
  type BranchSummary,
  type ListThreadsCursor,
  type ThreadSummary,
  type TurnHistoryCursor,
  type TurnSnapshot,
  type TuvrenMessage,
} from "@tuvren/runtime-api";

// ── Internal cursor payload shapes (TechSpec §3.8) ──────────────────────────

interface ListThreadsCursorPayload {
  v: 1;
  kind: "list-threads";
  lastThreadId: string;
  lastCreatedAtMs: number;
  filter?: { schemaId?: string };
}

interface TurnHistoryCursorPayload {
  v: 1;
  kind: "turn-history";
  branchId: string;
  lastTurnNodeHash: string;
}

interface BranchMessagesCursorPayload {
  v: 1;
  kind: "branch-messages";
  branchId: string;
  positionFromOldest: number;
  branchHeadAtCursorIssuance: string;
}

// ── Cursor encode/decode helpers (KRT-AO002) ─────────────────────────────────

function encodeCursor<T>(payload: T): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursorRaw(token: string): unknown {
  // Buffer.from(token, "base64url") does not throw on invalid input; it
  // silently emits garbage bytes. JSON.parse then catches the malformed result.
  const raw = Buffer.from(token, "base64url").toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new TuvrenValidationError("cursor is not valid base64url or JSON", {
      code: "invalid_durable_read_cursor",
    });
  }
}

function decodeListThreadsCursor(
  token: ListThreadsCursor
): ListThreadsCursorPayload {
  const parsed = decodeCursorRaw(token);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as ListThreadsCursorPayload).v !== 1 ||
    (parsed as ListThreadsCursorPayload).kind !== "list-threads" ||
    typeof (parsed as ListThreadsCursorPayload).lastThreadId !== "string" ||
    typeof (parsed as ListThreadsCursorPayload).lastCreatedAtMs !== "number"
  ) {
    throw new TuvrenValidationError(
      "list-threads cursor payload has unexpected shape",
      { code: "invalid_durable_read_cursor" }
    );
  }
  return parsed as ListThreadsCursorPayload;
}

function decodeTurnHistoryCursor(
  token: TurnHistoryCursor
): TurnHistoryCursorPayload {
  const parsed = decodeCursorRaw(token);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as TurnHistoryCursorPayload).v !== 1 ||
    (parsed as TurnHistoryCursorPayload).kind !== "turn-history" ||
    typeof (parsed as TurnHistoryCursorPayload).branchId !== "string" ||
    typeof (parsed as TurnHistoryCursorPayload).lastTurnNodeHash !== "string"
  ) {
    throw new TuvrenValidationError(
      "turn-history cursor payload has unexpected shape",
      { code: "invalid_durable_read_cursor" }
    );
  }
  return parsed as TurnHistoryCursorPayload;
}

function decodeBranchMessagesCursor(
  token: BranchMessagesCursor
): BranchMessagesCursorPayload {
  const parsed = decodeCursorRaw(token);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as BranchMessagesCursorPayload).v !== 1 ||
    (parsed as BranchMessagesCursorPayload).kind !== "branch-messages" ||
    typeof (parsed as BranchMessagesCursorPayload).branchId !== "string" ||
    typeof (parsed as BranchMessagesCursorPayload).positionFromOldest !==
      "number" ||
    typeof (parsed as BranchMessagesCursorPayload).branchHeadAtCursorIssuance !==
      "string"
  ) {
    throw new TuvrenValidationError(
      "branch-messages cursor payload has unexpected shape",
      { code: "invalid_durable_read_cursor" }
    );
  }
  return parsed as BranchMessagesCursorPayload;
}

// ── listThreads (KRT-AO003) ──────────────────────────────────────────────────

export async function listThreads(
  kernel: KrakenKernel,
  options?: {
    limit?: number;
    cursor?: ListThreadsCursor;
    filter?: { schemaId?: string };
  }
): Promise<{ threads: ThreadSummary[]; nextCursor?: ListThreadsCursor }> {
  let cursorPayload: ListThreadsCursorPayload | undefined;

  if (options?.cursor !== undefined) {
    cursorPayload = decodeListThreadsCursor(options.cursor);

    const cursorFilter = cursorPayload.filter;
    const requestFilter = options.filter;
    const cursorSchemaId = cursorFilter?.schemaId;
    const requestSchemaId = requestFilter?.schemaId;

    if (cursorSchemaId !== requestSchemaId) {
      throw new TuvrenValidationError(
        "listThreads cursor filter does not match the current filter options",
        { code: "durable_read_cursor_filter_mismatch" }
      );
    }
  }

  let kernelResult: {
    threads: { createdAtMs: number; rootTurnNodeHash: string; schemaId: string; threadId: string }[];
    nextCursor?: string;
  };

  // kernel_capability_unsupported propagates naturally — no catch needed.
  kernelResult = await kernel.thread.list({
    limit: options?.limit,
    cursor: cursorPayload
      ? encodeCursor({
          v: 1 as const,
          kind: "list-threads" as const,
          lastThreadId: cursorPayload.lastThreadId,
          lastCreatedAtMs: cursorPayload.lastCreatedAtMs,
          filter: cursorPayload.filter,
        })
      : undefined,
    filter: options?.filter,
  });

  const threads: ThreadSummary[] = kernelResult.threads.map((t) => ({
    createdAtMs: t.createdAtMs,
    rootTurnNodeHash: t.rootTurnNodeHash,
    schemaId: t.schemaId,
    threadId: t.threadId,
  }));

  if (kernelResult.nextCursor === undefined || threads.length === 0) {
    return { threads };
  }

  const last = threads[threads.length - 1];
  const nextCursorPayload: ListThreadsCursorPayload = {
    v: 1,
    kind: "list-threads",
    lastThreadId: last.threadId,
    lastCreatedAtMs: last.createdAtMs,
    filter: options?.filter,
  };

  return { threads, nextCursor: encodeCursor(nextCursorPayload) };
}

// ── listBranches (KRT-AO003) ─────────────────────────────────────────────────

export async function listBranches(
  kernel: KrakenKernel,
  input: { threadId: string }
): Promise<BranchSummary[]> {
  const entries = await kernel.branch.list(input.threadId);
  return entries.map(([branchId, headTurnNodeHash]) => ({
    branchId,
    threadId: input.threadId,
    headTurnNodeHash,
  }));
}

// ── Shared helper: build TurnSnapshot from a turn node hash ──────────────────

async function buildTurnSnapshot(
  kernel: KrakenKernel,
  turnNodeHash: string
): Promise<TurnSnapshot> {
  const node = await kernel.node.get(turnNodeHash);

  if (node === null) {
    throw new TuvrenLineageError(
      `turn node "${turnNodeHash}" does not exist`,
      { code: "missing_turn_node" }
    );
  }

  const manifest = await kernel.tree.manifest(node.turnTreeHash);

  // Decode ContextManifest from the stored blob if the path exists.
  let contextManifest: TurnSnapshot["manifest"] = null;
  const contextManifestValue = manifest["context.manifest"];
  if (typeof contextManifestValue === "string") {
    const bytes = await kernel.store.get(contextManifestValue);
    if (bytes === null) {
      throw new TuvrenPersistenceError(
        `context manifest object "${contextManifestValue}" is referenced in the turn tree but missing from the store`,
        { code: "kernel_store_object_missing" }
      );
    }
    const decoded = decodeDeterministicKernelRecord(bytes);
    assertContextManifest(decoded, `manifest at "${contextManifestValue}"`);
    contextManifest = decoded;
  }

  // paths: all entries from the TurnTree manifest.
  const paths: Record<string, string[] | string | null> = {};
  for (const [path, value] of Object.entries(manifest)) {
    paths[path] = value;
  }

  return {
    turnNodeHash: node.hash,
    previousTurnNodeHash: node.previousTurnNodeHash,
    turnTreeHash: node.turnTreeHash,
    schemaId: node.schemaId,
    eventHash: node.eventHash,
    manifest: contextManifest,
    paths,
  };
}

// ── getTurnState (KRT-AO004) ─────────────────────────────────────────────────

export async function getTurnState(
  kernel: KrakenKernel,
  input: {
    threadId: string;
    branchId: string;
    turnNodeHash?: string;
  }
): Promise<TurnSnapshot> {
  const branch = await kernel.branch.get(input.branchId);
  if (branch === null) {
    throw new TuvrenLineageError(
      `branch "${input.branchId}" does not exist`,
      { code: "missing_branch" }
    );
  }

  if (branch.threadId !== input.threadId) {
    throw new TuvrenLineageError(
      `branch "${input.branchId}" belongs to thread "${branch.threadId}", not "${input.threadId}"`,
      { code: "missing_branch" }
    );
  }

  if (input.turnNodeHash === undefined) {
    return buildTurnSnapshot(kernel, branch.headTurnNodeHash);
  }

  // Lineage validation: verify the requested node is on this branch's lineage.
  if (input.turnNodeHash === branch.headTurnNodeHash) {
    return buildTurnSnapshot(kernel, input.turnNodeHash);
  }

  for await (const node of kernel.node.walkBack(branch.headTurnNodeHash)) {
    if (node.hash === input.turnNodeHash) {
      return buildTurnSnapshot(kernel, input.turnNodeHash);
    }
  }

  throw new TuvrenLineageError(
    `turn node "${input.turnNodeHash}" is not on the lineage of branch "${input.branchId}"`,
    { code: "turn_node_not_on_branch_lineage" }
  );
}

// ── getTurnHistory (KRT-AO004) ────────────────────────────────────────────────
// Contract (TechSpec §5.5.3) returns AsyncIterableIterator<TurnSnapshot>,
// so there is no nextCursor field in the yielded values. Hosts that need
// paginated resumption must track the last snapshot's turnNodeHash and
// construct a new `before` cursor externally via the runtime's opaque token.
// Emitting resumable cursors from the generator itself requires a contract
// amendment; deferred to a future epic.

export async function* getTurnHistory(
  kernel: KrakenKernel,
  input: { threadId: string; branchId: string },
  options?: { limit?: number; before?: TurnHistoryCursor }
): AsyncIterableIterator<TurnSnapshot> {
  let cursorPayload: TurnHistoryCursorPayload | undefined;

  if (options?.before !== undefined) {
    cursorPayload = decodeTurnHistoryCursor(options.before);

    if (cursorPayload.branchId !== input.branchId) {
      throw new TuvrenValidationError(
        "turn-history cursor branchId does not match the requested branch",
        { code: "durable_read_cursor_filter_mismatch" }
      );
    }
  }

  let startHash: string;

  // Validate branch existence on both the initial call and cursor resume.
  const branch = await kernel.branch.get(input.branchId);
  if (branch === null) {
    throw new TuvrenLineageError(
      `branch "${input.branchId}" does not exist`,
      { code: "missing_branch" }
    );
  }

  if (branch.threadId !== input.threadId) {
    throw new TuvrenLineageError(
      `branch "${input.branchId}" belongs to thread "${branch.threadId}", not "${input.threadId}"`,
      { code: "missing_branch" }
    );
  }

  if (cursorPayload !== undefined) {
    // Resume: the cursor names the node whose predecessor is next.
    // We need the node named in the cursor to find its previousTurnNodeHash.
    const cursorNode = await kernel.node.get(cursorPayload.lastTurnNodeHash);
    if (cursorNode === null || cursorNode.previousTurnNodeHash === null) {
      return;
    }
    startHash = cursorNode.previousTurnNodeHash;
  } else {
    startHash = branch.headTurnNodeHash;
  }

  let count = 0;
  const limit = options?.limit;

  for await (const node of kernel.node.walkBack(startHash)) {
    if (limit !== undefined && count >= limit) {
      return;
    }

    const snapshot = await buildTurnSnapshot(kernel, node.hash);
    yield snapshot;
    count += 1;
  }
}

// ── readBranchMessages (KRT-AO005) ───────────────────────────────────────────

export async function readBranchMessages(
  kernel: KrakenKernel,
  input: {
    branchId: string;
    limit?: number;
    after?: BranchMessagesCursor;
  }
): Promise<{ messages: TuvrenMessage[]; nextCursor?: BranchMessagesCursor }> {
  let cursorPayload: BranchMessagesCursorPayload | undefined;

  if (input.after !== undefined) {
    cursorPayload = decodeBranchMessagesCursor(input.after);

    if (cursorPayload.branchId !== input.branchId) {
      throw new TuvrenValidationError(
        "branch-messages cursor branchId does not match the requested branch",
        { code: "durable_read_cursor_filter_mismatch" }
      );
    }
  }

  // Resolve current branch head.
  const branch = await kernel.branch.get(input.branchId);
  if (branch === null) {
    throw new TuvrenLineageError(
      `branch "${input.branchId}" does not exist`,
      { code: "missing_branch" }
    );
  }
  const currentHead = branch.headTurnNodeHash;

  // Get current head's turn tree hash.
  const headNode = await kernel.node.get(currentHead);
  if (headNode === null) {
    throw new TuvrenLineageError(
      `turn node "${currentHead}" does not exist`,
      { code: "missing_turn_node" }
    );
  }

  // Resolve the ordered messages path from the turn tree.
  let messageHashes: string[];
  try {
    const resolved = await kernel.tree.resolve(headNode.turnTreeHash, "messages");
    if (!Array.isArray(resolved)) {
      messageHashes = [];
    } else {
      messageHashes = resolved.filter((h): h is string => typeof h === "string");
    }
  } catch (error: unknown) {
    if (
      error instanceof TuvrenValidationError &&
      error.code === "kernel_runtime_unknown_tree_path"
    ) {
      messageHashes = [];
    } else {
      throw error;
    }
  }

  // If paging with a cursor, verify head-drift stability for the prefix.
  let startIndex = 0;
  if (cursorPayload !== undefined) {
    const position = cursorPayload.positionFromOldest;
    const recordedHead = cursorPayload.branchHeadAtCursorIssuance;

    if (currentHead !== recordedHead) {
      // Head moved — load the recorded head's message list and compare the
      // prefix hash slice up to cursor position. Content-addressed storage
      // guarantees prefix stability for the same branch, but we verify
      // explicitly so the error fires on any corruption or invalid cursor.
      let recordedMessageHashes: string[] = [];
      const recordedHeadNode = await kernel.node.get(recordedHead);
      if (recordedHeadNode !== null) {
        try {
          const resolved = await kernel.tree.resolve(recordedHeadNode.turnTreeHash, "messages");
          if (Array.isArray(resolved)) {
            recordedMessageHashes = resolved.filter((h): h is string => typeof h === "string");
          }
        } catch (error: unknown) {
          if (
            !(error instanceof TuvrenValidationError) ||
            error.code !== "kernel_runtime_unknown_tree_path"
          ) {
            throw error;
          }
          // kernel_runtime_unknown_tree_path means no messages path on the
          // recorded head — treat its prefix as empty, which will fail the
          // length check below and throw durable_read_cursor_head_drift.
        }
      }

      // A position-0 cursor claims a specific head identity; reject when the
      // head has moved even though there is no prefix to compare.
      if (position === 0) {
        throw new TuvrenValidationError(
          "branch head moved and message history has diverged from the cursor position",
          { code: "durable_read_cursor_head_drift" }
        );
      }

      const currentPrefix = messageHashes.slice(0, position);
      const recordedPrefix = recordedMessageHashes.slice(0, position);
      // Both the recorded head and the current head must supply at least
      // `position` messages, and each corresponding hash must be identical.
      if (
        recordedPrefix.length < position ||
        currentPrefix.length < position ||
        currentPrefix.some((h, i) => h !== recordedPrefix[i])
      ) {
        throw new TuvrenValidationError(
          "branch head moved and message history has diverged from the cursor position",
          { code: "durable_read_cursor_head_drift" }
        );
      }
    }
    startIndex = position;
  }

  const limit = input.limit;
  const endIndex =
    limit !== undefined
      ? Math.min(startIndex + limit, messageHashes.length)
      : messageHashes.length;

  const slicedHashes = messageHashes.slice(startIndex, endIndex);
  const messages: TuvrenMessage[] = [];

  for (const hash of slicedHashes) {
    const bytes = await kernel.store.get(hash);
    if (bytes === null) {
      throw new TuvrenPersistenceError(
        `message object "${hash}" is referenced in the branch tree but missing from the store`,
        { code: "kernel_store_object_missing" }
      );
    }
    const decoded = decodeDeterministicKernelRecord(bytes);
    assertTuvrenMessage(decoded, `message at "${hash}"`);
    messages.push(decoded);
  }

  if (endIndex >= messageHashes.length) {
    return { messages };
  }

  const nextCursorPayload: BranchMessagesCursorPayload = {
    v: 1,
    kind: "branch-messages",
    branchId: input.branchId,
    positionFromOldest: endIndex,
    branchHeadAtCursorIssuance: currentHead,
  };

  return { messages, nextCursor: encodeCursor(nextCursorPayload) };
}
