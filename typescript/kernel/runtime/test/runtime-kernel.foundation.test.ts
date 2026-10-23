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
import { createRuntimeKernel } from "@tuvren/kernel-runtime";

import {
  rejectionOf,
  createThreadFixture,
  TEST_SCHEMA,
} from "./runtime-kernel-test-helpers.ts";

describe("createRuntimeKernel foundation", () => {
  test("schema.register rejects duplicate schema ids even for identical payloads", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });

    expect(await kernel.schema.register(TEST_SCHEMA)).toBe(
      TEST_SCHEMA.schemaId
    );
    const rejectedError1 = await rejectionOf(
      kernel.schema.register(TEST_SCHEMA)
    );
    expect(rejectedError1.message).toContain(
      `schema "${TEST_SCHEMA.schemaId}" is already registered`
    );
  });

  test("run.completeStep advances a final step past the sequence", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_final_step",
      threadId: "thread_final_step",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_final_step",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    await fixture.kernel.run.create(
      "run_final_step",
      turn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [{ deterministic: true, id: "only", sideEffects: false }]
    );

    await fixture.kernel.run.beginStep("run_final_step", "only");
    await fixture.kernel.run.completeStep("run_final_step", "only");

    const rejectedError2 = await rejectionOf(
      fixture.kernel.run.beginStep("run_final_step", "only")
    );
    expect(rejectedError2.message).toContain('unexpected step "only"');

    const recovery = await fixture.kernel.run.recover("run_final_step");
    expect(recovery.lastCompletedStepId).toBe("only");
  });

  test("thread.create rejects duplicate thread and initial branch ids without side effects", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_thread_uniqueness",
      now: () => 1,
      threadId: "thread_uniqueness",
    });

    const rejectedError3 = await rejectionOf(
      fixture.kernel.thread.create(
        fixture.threadId,
        fixture.schemaId,
        "branch_shadow"
      )
    );
    expect(rejectedError3.message).toContain(
      'thread "thread_uniqueness" already exists'
    );

    expect(await fixture.kernel.branch.list(fixture.threadId)).toEqual([
      [fixture.branchId, fixture.rootTurnNodeHash],
    ]);

    const rejectedError4 = await rejectionOf(
      fixture.kernel.thread.create(
        "thread_branch_collision",
        fixture.schemaId,
        fixture.branchId
      )
    );
    expect(rejectedError4.message).toContain(
      'branch "branch_thread_uniqueness" already exists'
    );
    expect(
      await fixture.kernel.thread.get("thread_branch_collision")
    ).toBeNull();
  });

  test("branch.create rejects duplicate branch ids before writing", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_create_uniqueness",
      now: () => 1,
      threadId: "thread_branch_create_uniqueness",
    });

    const rejectedError5 = await rejectionOf(
      fixture.kernel.branch.create(
        fixture.branchId,
        fixture.threadId,
        fixture.rootTurnNodeHash
      )
    );
    expect(rejectedError5.message).toContain(
      'branch "branch_create_uniqueness" already exists'
    );

    expect(await fixture.kernel.branch.list(fixture.threadId)).toEqual([
      [fixture.branchId, fixture.rootTurnNodeHash],
    ]);
  });

  test("turn.create rejects duplicate turn ids before writing", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_turn_uniqueness",
      now: () => 1,
      threadId: "thread_turn_uniqueness",
    });

    const turn = await fixture.kernel.turn.create(
      "turn_uniqueness",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );

    const rejectedError6 = await rejectionOf(
      fixture.kernel.turn.create(
        turn.turnId,
        fixture.threadId,
        fixture.branchId,
        null,
        fixture.rootTurnNodeHash
      )
    );
    expect(rejectedError6.message).toContain(
      'turn "turn_uniqueness" already exists'
    );

    expect(await fixture.kernel.turn.get(turn.turnId)).toEqual(turn);
  });

  test("run.create rejects duplicate run ids before validation", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_run_uniqueness",
      now: () => 1,
      threadId: "thread_run_uniqueness",
    });

    const turn = await fixture.kernel.turn.create(
      "turn_run_uniqueness",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );

    await fixture.kernel.run.create(
      "run_uniqueness",
      turn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [{ deterministic: true, id: "start", sideEffects: false }]
    );

    const rejectedError7 = await rejectionOf(
      fixture.kernel.run.create(
        "run_uniqueness",
        turn.turnId,
        fixture.branchId,
        fixture.schemaId,
        fixture.rootTurnNodeHash,
        [{ deterministic: true, id: "start", sideEffects: false }]
      )
    );
    expect(rejectedError7.message).toContain(
      'run "run_uniqueness" already exists'
    );
  });
});
