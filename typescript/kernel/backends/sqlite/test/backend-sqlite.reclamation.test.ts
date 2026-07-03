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

import { notStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { RuntimeBackend, TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createSqliteBackend } from "../src/index.js";
import { createTempDatabasePath } from "./backend-sqlite-test-helpers.js";

const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_sqlite_reclamation",
} satisfies TurnTreeSchema;

const UNSUPPORTED_RECLAMATION_PATTERN =
  /maintenance\.reclamation is not supported by this backend/;

const openBackends: { close(): Promise<void> }[] = [];

async function createReclamationKernel() {
  let clock = 0;
  const now = () => {
    clock += 1;
    return clock;
  };
  const backend = createSqliteBackend({
    databasePath: createTempDatabasePath(),
    now,
  });
  openBackends.push(backend);
  const kernel = createRuntimeKernel({ backend, now });
  const schemaId = await kernel.schema.register(TEST_SCHEMA);
  const thread = await kernel.thread.create(
    "thread_reclaim",
    schemaId,
    "branch_reclaim"
  );
  return { kernel, schemaId, thread };
}

after(async () => {
  for (const backend of openBackends) {
    await backend.close();
  }
});

describe("createSqliteBackend maintenance.reclamation", () => {
  test("reclaims unreferenced objects and archived branches after a rollback", async () => {
    const { kernel, schemaId, thread } = await createReclamationKernel();

    const abandonedEvent = await kernel.store.put(
      new Uint8Array([7, 7, 7]),
      "application/event"
    );
    const turn = await kernel.turn.create(
      "turn_abandoned",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await kernel.run.create(
      "run_abandoned",
      turn.turnId,
      thread.branchId,
      schemaId,
      thread.rootTurnNodeHash,
      [{ deterministic: false, id: "checkpoint", sideEffects: false }]
    );
    const completed = await kernel.run.completeStep(
      "run_abandoned",
      "checkpoint",
      abandonedEvent
    );
    if (completed.turnNodeHash === undefined) {
      throw new Error("expected checkpoint turn node");
    }
    await kernel.run.complete("run_abandoned", "completed");
    const abandonedHead = completed.turnNodeHash;

    // A backward head move archives the abandoned segment into an archive branch.
    const rollback = await kernel.branch.setHead(
      thread.branchId,
      thread.rootTurnNodeHash
    );
    strictEqual(rollback.archiveBranch?.headTurnNodeHash, abandonedHead);

    const summary = await kernel.maintenance.reclaim();

    // The abandoned segment (only reachable via the archive branch) is deleted
    // from the relational store.
    strictEqual(await kernel.store.has(abandonedEvent), false);
    strictEqual(await kernel.node.get(abandonedHead), null);
    ok(summary.releasedArchivedBranchCount >= 1);
    ok(summary.releasedObjectCount >= 1);
    ok(summary.releasedTurnNodeCount >= 1);

    // The live branch (now at root) and the thread root remain intact and the
    // committed state stays referentially valid.
    const branches = await kernel.branch.list(thread.threadId);
    ok(
      branches.some(
        ([branchId, headHash]) =>
          branchId === thread.branchId && headHash === thread.rootTurnNodeHash
      )
    );
    strictEqual(
      branches.some(([branchId]) => branchId.includes("archive")),
      false
    );
    notStrictEqual(await kernel.node.get(thread.rootTurnNodeHash), null);
    const reloaded = await kernel.thread.get(thread.threadId);
    strictEqual(reloaded?.rootTurnNodeHash, thread.rootTurnNodeHash);
  });

  test("is a safe no-op when nothing is unreachable", async () => {
    const { kernel, thread } = await createReclamationKernel();

    const summary = await kernel.maintenance.reclaim();

    strictEqual(summary.releasedObjectCount, 0);
    strictEqual(summary.releasedArchivedBranchCount, 0);
    const reloaded = await kernel.thread.get(thread.threadId);
    strictEqual(reloaded?.rootTurnNodeHash, thread.rootTurnNodeHash);
  });

  test("rejects reclamation on a backend that does not advertise the capability", async () => {
    const nonReclaimingBackend: RuntimeBackend = {
      capabilities: () => ({ "thread.enumeration": true }),
      health: () => Promise.resolve({ ok: true }),
      transact: () => {
        throw new Error("transact must not be reached when reclaim is gated");
      },
    };
    const kernel = createRuntimeKernel({ backend: nonReclaimingBackend });

    await rejects(
      kernel.maintenance.reclaim(),
      UNSUPPORTED_RECLAMATION_PATTERN
    );
  });
});
