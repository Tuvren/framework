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
import type { RuntimeKernel, TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";

const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_runtime_test",
} satisfies TurnTreeSchema;

interface RuntimeKernelFixture {
  branchId: string;
  kernel: RuntimeKernel;
  rootTurnNodeHash: string;
  schemaId: string;
  threadId: string;
}

async function createThreadFixture(
  input: { branchId?: string; now?: () => number; threadId?: string } = {}
): Promise<RuntimeKernelFixture> {
  const kernel = createRuntimeKernel({
    backend: createMemoryBackend(),
    now: input.now,
  });
  const schemaId = await kernel.schema.register(TEST_SCHEMA);
  const threadId = input.threadId ?? "thread_runtime_test";
  const branchId = input.branchId ?? "branch_runtime_test";
  const thread = await kernel.thread.create(threadId, schemaId, branchId);

  return {
    branchId: thread.branchId,
    kernel,
    rootTurnNodeHash: thread.rootTurnNodeHash,
    schemaId,
    threadId: thread.threadId,
  };
}

describe("createRuntimeKernel", () => {
  test("returns a truthy RuntimeKernel instance", () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    expect(kernel).toBeTruthy();
  });

  test("kernel has expected syscall namespaces", () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    expect(kernel.branch).toBeTruthy();
    expect(kernel.node).toBeTruthy();
    expect(kernel.run).toBeTruthy();
    expect(kernel.schema).toBeTruthy();
    expect(kernel.staging).toBeTruthy();
    expect(kernel.store).toBeTruthy();
    expect(kernel.thread).toBeTruthy();
    expect(kernel.tree).toBeTruthy();
    expect(kernel.turn).toBeTruthy();
    expect(kernel.verdicts).toBeTruthy();
  });

  test("verdicts.compose priority: abort wins over proceed", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      { kind: "proceed" },
      { disposition: "HardFail", kind: "abort", reason: "stop" },
    ]);
    expect(result.kind).toBe("abort");
  });

  test("verdicts.compose priority: abort wins over retry", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      { adjustment: {}, kind: "retry" },
      { disposition: "HardFail", kind: "abort", reason: "stop" },
    ]);
    expect(result.kind).toBe("abort");
  });

  test("verdicts.compose returns proceed when all proceed", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      { kind: "proceed" },
      { kind: "proceed" },
    ]);
    expect(result.kind).toBe("proceed");
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

    await expect(
      fixture.kernel.run.beginStep("run_final_step", "only")
    ).rejects.toThrow('unexpected step "only"');

    const recovery = await fixture.kernel.run.recover("run_final_step");
    expect(recovery.lastCompletedStepId).toBe("only");
  });

  test("thread.create rejects duplicate thread and initial branch ids without side effects", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_thread_uniqueness",
      now: () => 1,
      threadId: "thread_uniqueness",
    });

    await expect(
      fixture.kernel.thread.create(
        fixture.threadId,
        fixture.schemaId,
        "branch_shadow"
      )
    ).rejects.toThrow('thread "thread_uniqueness" already exists');

    expect(await fixture.kernel.branch.list(fixture.threadId)).toEqual([
      [fixture.branchId, fixture.rootTurnNodeHash],
    ]);

    await expect(
      fixture.kernel.thread.create(
        "thread_branch_collision",
        fixture.schemaId,
        fixture.branchId
      )
    ).rejects.toThrow('branch "branch_thread_uniqueness" already exists');
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

    await expect(
      fixture.kernel.branch.create(
        fixture.branchId,
        fixture.threadId,
        fixture.rootTurnNodeHash
      )
    ).rejects.toThrow('branch "branch_create_uniqueness" already exists');

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

    await expect(
      fixture.kernel.turn.create(
        turn.turnId,
        fixture.threadId,
        fixture.branchId,
        null,
        fixture.rootTurnNodeHash
      )
    ).rejects.toThrow('turn "turn_uniqueness" already exists');

    expect(await fixture.kernel.turn.get(turn.turnId)).toEqual(turn);
  });

  test("branch.setHead allocates an unused rollback archive branch id", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_archive_probe",
      threadId: "thread_archive_probe",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_archive_probe",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    await fixture.kernel.run.create(
      "run_archive_probe",
      turn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [{ deterministic: false, id: "checkpoint", sideEffects: false }]
    );

    const completedStep = await fixture.kernel.run.completeStep(
      "run_archive_probe",
      "checkpoint"
    );

    if (completedStep.turnNodeHash === undefined) {
      throw new Error("expected checkpoint turn node");
    }

    const collidingArchiveBranchId = `${fixture.branchId}-archive-1-${completedStep.turnNodeHash.slice(0, 16)}`;
    await fixture.kernel.branch.create(
      collidingArchiveBranchId,
      fixture.threadId,
      completedStep.turnNodeHash
    );

    const result = await fixture.kernel.branch.setHead(
      fixture.branchId,
      fixture.rootTurnNodeHash
    );

    expect(result.branch.headTurnNodeHash).toBe(fixture.rootTurnNodeHash);
    expect(result.archiveBranch?.branchId).toBe(
      `${fixture.branchId}-archive-2-${completedStep.turnNodeHash.slice(0, 16)}`
    );
    expect(result.archiveBranch?.headTurnNodeHash).toBe(
      completedStep.turnNodeHash
    );
  });

  test("run.recover reads the run last node after rollback archival", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_recover_after_rollback",
      threadId: "thread_recover_after_rollback",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_recover_after_rollback",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    await fixture.kernel.run.create(
      "run_recover_after_rollback",
      turn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [{ deterministic: true, id: "work", sideEffects: false }]
    );
    const staged = await fixture.kernel.staging.stage(
      "run_recover_after_rollback",
      new Uint8Array([1, 2, 3]),
      "task_recover_after_rollback",
      "message",
      "completed"
    );
    const completedStep = await fixture.kernel.run.completeStep(
      "run_recover_after_rollback",
      "work"
    );

    if (completedStep.turnNodeHash === undefined) {
      throw new Error("expected staged result checkpoint turn node");
    }

    const rollback = await fixture.kernel.branch.setHead(
      fixture.branchId,
      fixture.rootTurnNodeHash
    );
    const recovery = await fixture.kernel.run.recover(
      "run_recover_after_rollback"
    );

    expect(rollback.archiveBranch?.headTurnNodeHash).toBe(
      completedStep.turnNodeHash
    );
    expect(recovery.lastTurnNodeHash).toBe(completedStep.turnNodeHash);
    expect(recovery.consumedStagedResults).toEqual([staged.stagedResult]);
    expect(recovery.uncommittedStagedResults).toEqual([]);
  });
});
