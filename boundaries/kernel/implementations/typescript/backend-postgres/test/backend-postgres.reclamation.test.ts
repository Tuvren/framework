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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RuntimeBackend, TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createPostgresBackend } from "../src/index.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_postgres_reclamation",
} satisfies TurnTreeSchema;

interface ClosablePostgresBackend extends RuntimeBackend {
  destroy(options?: { dropSchema?: boolean }): Promise<void>;
}

function createMonotonicClock(): () => number {
  let clock = 0;
  return () => {
    clock += 1;
    return clock;
  };
}

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("createPostgresBackend maintenance.reclamation", () => {
  test("reclaims unreferenced objects and archived branches after a rollback", async () => {
    const now = createMonotonicClock();
    const backend = createPostgresBackend(
      createPostgresTestBackendOptions({ now })
    );

    try {
      const kernel = createRuntimeKernel({ backend, now });
      const schemaId = await kernel.schema.register(TEST_SCHEMA);
      const thread = await kernel.thread.create(
        "thread_reclaim",
        schemaId,
        "branch_reclaim"
      );

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

      const rollback = await kernel.branch.setHead(
        thread.branchId,
        thread.rootTurnNodeHash
      );
      expect(rollback.archiveBranch?.headTurnNodeHash).toBe(abandonedHead);

      const summary = await kernel.maintenance.reclaim();

      // The abandoned segment is dropped from the re-persisted scope snapshot.
      expect(await kernel.store.has(abandonedEvent)).toBe(false);
      expect(await kernel.node.get(abandonedHead)).toBeNull();
      expect(summary.releasedArchivedBranchCount).toBeGreaterThanOrEqual(1);
      expect(summary.releasedObjectCount).toBeGreaterThanOrEqual(1);
      expect(summary.releasedTurnNodeCount).toBeGreaterThanOrEqual(1);

      // The live branch and thread root survive; the snapshot stays valid and
      // continues to read back across a fresh load.
      const branches = await kernel.branch.list(thread.threadId);
      expect(branches).toContainEqual([
        thread.branchId,
        thread.rootTurnNodeHash,
      ]);
      expect(branches.some(([branchId]) => branchId.includes("archive"))).toBe(
        false
      );
      expect(await kernel.node.get(thread.rootTurnNodeHash)).not.toBeNull();
      const reloaded = await kernel.thread.get(thread.threadId);
      expect(reloaded?.rootTurnNodeHash).toBe(thread.rootTurnNodeHash);
      const health = await backend.health();
      expect(health.ok).toBe(true);
    } finally {
      await (backend as ClosablePostgresBackend).destroy();
    }
  });

  test("is a safe no-op when nothing is unreachable", async () => {
    const now = createMonotonicClock();
    const backend = createPostgresBackend(
      createPostgresTestBackendOptions({ now })
    );

    try {
      const kernel = createRuntimeKernel({ backend, now });
      const schemaId = await kernel.schema.register(TEST_SCHEMA);
      const thread = await kernel.thread.create(
        "thread_reclaim",
        schemaId,
        "branch_reclaim"
      );

      const summary = await kernel.maintenance.reclaim();

      // The snapshot rewrite must not churn or invalidate an unchanged scope:
      // nothing is released and the scope still reads back across a fresh load.
      expect(summary.releasedObjectCount).toBe(0);
      expect(summary.releasedArchivedBranchCount).toBe(0);
      expect(summary.releasedTurnNodeCount).toBe(0);
      const reloaded = await kernel.thread.get(thread.threadId);
      expect(reloaded?.rootTurnNodeHash).toBe(thread.rootTurnNodeHash);
      const health = await backend.health();
      expect(health.ok).toBe(true);
    } finally {
      await (backend as ClosablePostgresBackend).destroy();
    }
  });
});
