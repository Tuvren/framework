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

// Issue #108 M5 — health()/fsck() split under the relational schema (ADR-067):
// `health()` is a lightweight liveness/coherence probe; `fsck()` runs full
// committed-state validation. Corruption is injected via direct SQL against
// family tables (not the retired snapshot_cbor blob).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createPostgresBackend } from "../src/index.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
  updateBranchHeadDirectly,
} from "./postgres-test-helpers.js";

const BRANCH_HEAD_MISALIGNMENT_ERROR_PATTERN =
  /stay aligned with the current branch head/u;

const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_postgres_health_fsck",
} satisfies TurnTreeSchema;

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres health()/fsck() split (issue #108 M5)", () => {
  test("keeps an active-run/branch-head misalignment invisible to health() but reports it through fsck()", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);

    try {
      const kernel = createRuntimeKernel({ backend });
      const schemaId = await kernel.schema.register(TEST_SCHEMA);
      const thread = await kernel.thread.create(
        "thread_health_fsck",
        schemaId,
        "branch_health_fsck"
      );
      const turn = await kernel.turn.create(
        "turn_health_fsck",
        thread.threadId,
        thread.branchId,
        null,
        thread.rootTurnNodeHash
      );
      await kernel.run.create(
        "run_health_fsck",
        turn.turnId,
        thread.branchId,
        schemaId,
        thread.rootTurnNodeHash,
        [{ deterministic: false, id: "checkpoint", sideEffects: false }]
      );
      const event = await kernel.store.put(
        new Uint8Array([1, 2, 3]),
        "application/event"
      );
      const completed = await kernel.run.completeStep(
        "run_health_fsck",
        "checkpoint",
        event
      );
      if (completed.turnNodeHash === undefined) {
        throw new Error("expected checkpoint turn node");
      }

      const baselineHealth = await backend.health();
      expect(baselineHealth.ok).toBe(true);
      const baselineFsck = await backend.fsck();
      expect(baselineFsck.ok).toBe(true);

      // Tamper directly with the relational branch row — bypassing
      // transact()'s write-set validation — so the branch head regresses to
      // the thread root while the run stays "running" with its active turn
      // node still at the checkpoint.
      await updateBranchHeadDirectly(
        options,
        thread.branchId,
        thread.rootTurnNodeHash
      );

      const health = await backend.health();
      expect(health.ok).toBe(true);

      const fsck = await backend.fsck();
      expect(fsck.ok).toBe(false);
      expect(fsck.ok === false ? fsck.reason : undefined).toMatch(
        BRANCH_HEAD_MISALIGNMENT_ERROR_PATTERN
      );
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });
});
