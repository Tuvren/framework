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
import { createThreadFixture } from "./runtime-kernel-test-helpers.ts";

describe("createRuntimeKernel turn lineage", () => {
  test("turn.create rejects stale same-branch parent turns in the kernel", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_turn_parent_kernel",
      threadId: "thread_turn_parent_kernel",
    });
    const bootstrapTurn = await fixture.kernel.turn.create(
      "turn_parent_bootstrap",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    await fixture.kernel.run.create(
      "run_turn_parent_seed",
      bootstrapTurn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [{ deterministic: false, id: "checkpoint", sideEffects: false }]
    );
    const checkpoint = await fixture.kernel.run.completeStep(
      "run_turn_parent_seed",
      "checkpoint"
    );

    if (checkpoint.turnNodeHash === undefined) {
      throw new Error("expected checkpoint turn node");
    }

    await fixture.kernel.turn.updateHead(
      bootstrapTurn.turnId,
      checkpoint.turnNodeHash
    );
    const mainTurn = await fixture.kernel.turn.create(
      "turn_parent_main",
      fixture.threadId,
      fixture.branchId,
      bootstrapTurn.turnId,
      checkpoint.turnNodeHash
    );
    const forkBranch = await fixture.kernel.branch.create(
      "branch_turn_parent_kernel_fork",
      fixture.threadId,
      checkpoint.turnNodeHash
    );

    const firstForkTurn = await fixture.kernel.turn.create(
      "turn_parent_first",
      fixture.threadId,
      forkBranch.branchId,
      mainTurn.turnId,
      checkpoint.turnNodeHash
    );
    const secondForkTurn = await fixture.kernel.turn.create(
      "turn_parent_second",
      fixture.threadId,
      forkBranch.branchId,
      firstForkTurn.turnId,
      checkpoint.turnNodeHash
    );

    await expect(
      fixture.kernel.turn.create(
        "turn_parent_stale",
        fixture.threadId,
        forkBranch.branchId,
        mainTurn.turnId,
        checkpoint.turnNodeHash
      )
    ).rejects.toThrow(
      'parent turn "turn_parent_main" is not the immediately previous turn on branch "branch_turn_parent_kernel_fork"'
    );

    expect(secondForkTurn.parentTurnId).toBe(firstForkTurn.turnId);
  });

  test("turn.updateHead rejects rewrites that would invalidate dependent turns", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_turn_head_dependents",
      threadId: "thread_turn_head_dependents",
    });
    const parentTurn = await fixture.kernel.turn.create(
      "turn_head_parent",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    await fixture.kernel.run.create(
      "run_turn_head_parent",
      parentTurn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [{ deterministic: false, id: "checkpoint", sideEffects: false }]
    );
    const checkpoint = await fixture.kernel.run.completeStep(
      "run_turn_head_parent",
      "checkpoint"
    );

    if (checkpoint.turnNodeHash === undefined) {
      throw new Error("expected checkpoint turn node");
    }

    await fixture.kernel.run.complete("run_turn_head_parent", "completed");
    await fixture.kernel.turn.updateHead(
      parentTurn.turnId,
      checkpoint.turnNodeHash
    );

    const forkBranch = await fixture.kernel.branch.create(
      "branch_turn_head_dependents_fork",
      fixture.threadId,
      checkpoint.turnNodeHash
    );
    await fixture.kernel.turn.create(
      "turn_head_child",
      fixture.threadId,
      forkBranch.branchId,
      parentTurn.turnId,
      checkpoint.turnNodeHash
    );

    await expect(
      fixture.kernel.turn.updateHead(
        parentTurn.turnId,
        fixture.rootTurnNodeHash
      )
    ).rejects.toThrow(
      'turn "turn_head_parent" cannot rewrite head past dependent turn "turn_head_child"'
    );
  });
});
