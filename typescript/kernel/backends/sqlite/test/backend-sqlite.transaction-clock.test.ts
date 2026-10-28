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

import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";

import { createSqliteBackend } from "../src/index.js";
import { createTempDatabasePath } from "./backend-sqlite-test-helpers.js";

const TEST_SCHEMA = {
  incorporationRules: [],
  paths: [{ collection: "ordered", path: "messages" }],
  schemaId: "schema_sqlite_clock",
} satisfies TurnTreeSchema;

// Node's test runner owns the returned promise.
// oxlint-disable-next-line typescript/no-floating-promises
test("SQLite continues stamping branch and checkpoint with the injected kernel clock", async () => {
  const backend = createSqliteBackend({
    databasePath: createTempDatabasePath(),
    now: () => 100,
  });
  try {
    const kernel = createRuntimeKernel({ backend, now: () => 200 });
    const schemaId = await kernel.schema.register(TEST_SCHEMA);
    const thread = await kernel.thread.create(
      "thread_clock",
      schemaId,
      "branch_clock"
    );
    const turn = await kernel.turn.create(
      "turn_clock",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await kernel.run.create(
      "run_clock",
      turn.turnId,
      thread.branchId,
      schemaId,
      thread.rootTurnNodeHash,
      [{ deterministic: false, id: "checkpoint", sideEffects: false }]
    );
    const checkpoint = await kernel.run.completeStep("run_clock", "checkpoint");
    if (checkpoint.turnNodeHash === undefined) {
      throw new Error("expected checkpoint turn node");
    }
    const stored = await backend.transact(async (tx) => ({
      branch: await tx.branches.get(thread.branchId),
      node: await tx.turnNodes.get(checkpoint.turnNodeHash ?? ""),
      turn: await tx.turns.get(turn.turnId),
    }));
    strictEqual(stored.branch?.createdAtMs, 200);
    strictEqual(stored.branch?.updatedAtMs, 200);
    strictEqual(stored.turn?.updatedAtMs, 200);
    strictEqual(stored.node?.createdAtMs, 200);
  } finally {
    await backend.close();
  }
});
