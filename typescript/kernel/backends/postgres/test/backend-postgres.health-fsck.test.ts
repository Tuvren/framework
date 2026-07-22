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

// Issue #108 M5 — the proof test the milestone demands: `RuntimeBackend
// .health()` is now a lightweight liveness/coherence probe (connection
// works, the Scope's snapshot row exists, its schema_version is supported)
// instead of a full decode+validate pass; the full committed-state
// validation `health()` used to run on every call moved to the new
// `fsck()` maintenance method (Git-fsck-style: occasional maintenance,
// never on every read). Commit-time validation (`validateCommittedState`
// inside every `transact()`/`reclaim()`) is unaffected either way. This
// suite proves the split behaviorally, not by argument: committed-state
// corruption that connectivity/schema-version checks cannot see is
// invisible to `health()` but caught by `fsck()`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createPostgresBackend } from "../src/index.js";
import {
  decodeSnapshot,
  encodeSnapshot,
} from "../src/lib/postgres-backend-persistence.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
  readSnapshotCbor,
  writeSnapshotCbor,
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

      // Baseline: the run is still "running" and its active turn node (the
      // last created node) is aligned with both the branch and turn head --
      // a healthy committed state, caught by neither health() nor fsck().
      const baselineHealth = await backend.health();
      expect(baselineHealth.ok).toBe(true);
      const baselineFsck = await backend.fsck();
      expect(baselineFsck.ok).toBe(true);

      // Tamper directly with the persisted snapshot bytes -- bypassing
      // transact()'s own validateCommittedState entirely, the way a raw SQL
      // edit or a bug in a different writer could -- so the branch head
      // regresses to the thread root while the run stays "running" with its
      // active turn node still at the checkpoint. Every individual record
      // is still schema-valid (decodeSnapshot's per-record asserts pass);
      // only the cross-record active-run/branch-head alignment invariant is
      // broken, exactly the class of corruption a connectivity/
      // schema-version check can never see.
      const persistedBytes = await readSnapshotCbor(options);
      const state = decodeSnapshot(persistedBytes);
      const branch = state.branches.get(thread.branchId);
      if (branch === undefined) {
        throw new Error("expected seeded branch");
      }
      state.branches.set(thread.branchId, {
        ...branch,
        headTurnNodeHash: thread.rootTurnNodeHash,
      });
      await writeSnapshotCbor(options, encodeSnapshot(state));

      // The lightweight health() probe never loads, decodes, or validates
      // committed state, so it stays "ok" even though the row now encodes
      // an invariant violation.
      const health = await backend.health();
      expect(health.ok).toBe(true);

      // fsck() is the maintenance entry point that still performs the full
      // decode+validate pass health() used to run on every call.
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
