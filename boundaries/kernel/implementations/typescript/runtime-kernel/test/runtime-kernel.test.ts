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
import type {
  RuntimeBackend,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
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
  backend: RuntimeBackend;
  branchId: string;
  kernel: RuntimeKernel & RuntimeKernelRunLiveness;
  rootTurnNodeHash: string;
  schemaId: string;
  threadId: string;
}

async function createThreadFixture(
  input: { branchId?: string; now?: () => number; threadId?: string } = {}
): Promise<RuntimeKernelFixture> {
  const backend = createMemoryBackend();
  const kernel = createRuntimeKernel({
    backend,
    now: input.now,
  });
  const schemaId = await kernel.schema.register(TEST_SCHEMA);
  const threadId = input.threadId ?? "thread_runtime_test";
  const branchId = input.branchId ?? "branch_runtime_test";
  const thread = await kernel.thread.create(threadId, schemaId, branchId);

  return {
    backend,
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
    expect(kernel.runLiveness).toBeTruthy();
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

  test("verdicts.compose preserves a single modify verdict unchanged", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      {
        kind: "modify",
        transform: { phase: "single" },
      },
    ]);

    expect(result).toEqual({
      kind: "modify",
      transform: { phase: "single" },
    });
  });

  test("verdicts.compose preserves multiple modify verdicts in registration order", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      {
        kind: "modify",
        transform: { phase: "first" },
      },
      { kind: "proceed" },
      {
        kind: "modify",
        transform: { phase: "second" },
      },
    ]);

    expect(result).toEqual({
      kind: "modify",
      transform: [{ phase: "first" }, { phase: "second" }],
    });
  });

  test("verdicts.compose keeps pause ahead of composed modify verdicts", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      {
        kind: "modify",
        transform: { phase: "first" },
      },
      {
        kind: "pause",
        reason: "awaiting_approval",
        resumptionSchema: { type: "approval" },
      },
      {
        kind: "modify",
        transform: { phase: "second" },
      },
    ]);

    expect(result).toEqual({
      kind: "pause",
      reason: "awaiting_approval",
      resumptionSchema: { type: "approval" },
    });
  });

  test("schema.register rejects duplicate schema ids even for identical payloads", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });

    expect(await kernel.schema.register(TEST_SCHEMA)).toBe(
      TEST_SCHEMA.schemaId
    );
    await expect(kernel.schema.register(TEST_SCHEMA)).rejects.toThrow(
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

    await expect(
      fixture.kernel.run.create(
        "run_uniqueness",
        turn.turnId,
        fixture.branchId,
        fixture.schemaId,
        fixture.rootTurnNodeHash,
        [{ deterministic: true, id: "start", sideEffects: false }]
      )
    ).rejects.toThrow('run "run_uniqueness" already exists');
  });

  test("runLiveness.createLeasedRun returns a leased running record", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_leased_run",
      threadId: "thread_leased_run",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_leased_run",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );

    const run = await fixture.kernel.runLiveness.createLeasedRun({
      branchId: fixture.branchId,
      executionOwnerId: "owner-alpha",
      leaseExpiresAtMs: 50,
      runId: "run_leased",
      schemaId: fixture.schemaId,
      startTurnNodeHash: fixture.rootTurnNodeHash,
      steps: [{ deterministic: true, id: "iterate", sideEffects: false }],
      turnId: turn.turnId,
    });

    expect(run.status).toBe("running");
    expect(run.executionOwnerId).toBe("owner-alpha");
    expect(run.leaseExpiresAtMs).toBe(50);
    expect(run.fencingToken).toBeTruthy();
  });

  test("runLiveness.renewLease rotates the fencing token for the same owner", async () => {
    const currentNow = 10;
    const fixture = await createThreadFixture({
      branchId: "branch_lease_renew",
      now: () => currentNow,
      threadId: "thread_lease_renew",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_lease_renew",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    const run = await fixture.kernel.runLiveness.createLeasedRun({
      branchId: fixture.branchId,
      executionOwnerId: "owner-alpha",
      leaseExpiresAtMs: 50,
      runId: "run_lease_renew",
      schemaId: fixture.schemaId,
      startTurnNodeHash: fixture.rootTurnNodeHash,
      steps: [{ deterministic: true, id: "iterate", sideEffects: false }],
      turnId: turn.turnId,
    });

    const renewed = await fixture.kernel.runLiveness.renewLease(
      run.runId,
      "owner-alpha",
      run.fencingToken ?? "",
      75
    );

    expect(renewed.leaseExpiresAtMs).toBe(75);
    expect(renewed.fencingToken).not.toBe(run.fencingToken);
  });

  test("run.completeStep returns the rotated lease token for leased running runs", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_leased_complete_step",
      now: () => 10,
      threadId: "thread_leased_complete_step",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_leased_complete_step",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    const leasedRun = await fixture.kernel.runLiveness.createLeasedRun({
      branchId: fixture.branchId,
      executionOwnerId: "owner-alpha",
      leaseExpiresAtMs: 50,
      runId: "run_leased_complete_step",
      schemaId: fixture.schemaId,
      startTurnNodeHash: fixture.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: turn.turnId,
    });

    await fixture.kernel.run.beginStep(leasedRun.runId, "iterate");
    const stepResult = await fixture.kernel.run.completeStep(
      leasedRun.runId,
      "iterate"
    );

    expect(stepResult.lease?.fencingToken).toBeTruthy();
    expect(stepResult.lease?.fencingToken).not.toBe(leasedRun.fencingToken);
    expect(stepResult.lease?.leaseExpiresAtMs).toBe(50);

    await expect(
      fixture.kernel.runLiveness.renewLease(
        leasedRun.runId,
        "owner-alpha",
        leasedRun.fencingToken ?? "",
        75
      )
    ).rejects.toThrow("fencing token");

    await expect(
      fixture.kernel.runLiveness.renewLease(
        leasedRun.runId,
        "owner-alpha",
        stepResult.lease?.fencingToken ?? "",
        75
      )
    ).resolves.toEqual({
      fencingToken: expect.any(String),
      leaseExpiresAtMs: 75,
    });
  });

  test("runLiveness.listExpired excludes paused and non-expired runs", async () => {
    let currentNow = 10;
    const fixture = await createThreadFixture({
      branchId: "branch_list_expired",
      now: () => currentNow,
      threadId: "thread_list_expired",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_list_expired",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    const leasedRun = await fixture.kernel.runLiveness.createLeasedRun({
      branchId: fixture.branchId,
      executionOwnerId: "owner-alpha",
      leaseExpiresAtMs: 20,
      runId: "run_list_expired",
      schemaId: fixture.schemaId,
      startTurnNodeHash: fixture.rootTurnNodeHash,
      steps: [{ deterministic: true, id: "iterate", sideEffects: false }],
      turnId: turn.turnId,
    });

    expect(await fixture.kernel.runLiveness.listExpired(19)).toEqual([]);

    currentNow = 21;
    expect(
      (await fixture.kernel.runLiveness.listExpired(21)).map((run) => run.runId)
    ).toEqual(["run_list_expired"]);

    await fixture.kernel.run.complete(leasedRun.runId, "failed");
    expect(await fixture.kernel.runLiveness.listExpired(21)).toEqual([]);
  });

  test("runLiveness.preemptExpired checkpoints staged work and returns recovery state", async () => {
    let currentNow = 10;
    const fixture = await createThreadFixture({
      branchId: "branch_preempt_expired",
      now: () => currentNow,
      threadId: "thread_preempt_expired",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_preempt_expired",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    const leasedRun = await fixture.kernel.runLiveness.createLeasedRun({
      branchId: fixture.branchId,
      executionOwnerId: "owner-alpha",
      leaseExpiresAtMs: 20,
      runId: "run_preempt_expired",
      schemaId: fixture.schemaId,
      startTurnNodeHash: fixture.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: turn.turnId,
    });

    await fixture.kernel.run.beginStep(leasedRun.runId, "iterate");
    await fixture.kernel.staging.stage(
      leasedRun.runId,
      new TextEncoder().encode("hello"),
      "assistant_message",
      "message",
      "completed"
    );

    currentNow = 25;
    const recovery = await fixture.kernel.runLiveness.preemptExpired(
      leasedRun.runId,
      "owner-beta",
      25,
      "stale_running_recovery"
    );

    expect(recovery.lastTurnNodeHash).not.toBe(fixture.rootTurnNodeHash);
    expect(recovery.uncommittedStagedResults).toEqual([]);
    expect(recovery.consumedStagedResults).toHaveLength(1);

    const expiredAfterPreemption =
      await fixture.kernel.runLiveness.listExpired(25);
    expect(expiredAfterPreemption).toEqual([]);
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

  test("branch.setHead rejects forward moves while the branch has an active run", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_forward_active_run",
      threadId: "thread_forward_active_run",
    });
    const bootstrapTurn = await fixture.kernel.turn.create(
      "turn_forward_active_run_bootstrap",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    await fixture.kernel.run.create(
      "run_forward_active_run_bootstrap",
      bootstrapTurn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [{ deterministic: false, id: "bootstrap-step", sideEffects: false }]
    );
    const bootstrapCheckpoint = await fixture.kernel.run.completeStep(
      "run_forward_active_run_bootstrap",
      "bootstrap-step"
    );

    if (bootstrapCheckpoint.turnNodeHash === undefined) {
      throw new Error("expected bootstrap checkpoint turn node");
    }

    await fixture.kernel.run.complete(
      "run_forward_active_run_bootstrap",
      "completed"
    );
    const mainTurn = await fixture.kernel.turn.create(
      "turn_forward_active_run_main",
      fixture.threadId,
      fixture.branchId,
      bootstrapTurn.turnId,
      bootstrapCheckpoint.turnNodeHash
    );
    const forkBranch = await fixture.kernel.branch.create(
      "branch_forward_active_run_fork",
      fixture.threadId,
      bootstrapCheckpoint.turnNodeHash
    );
    const forkTurn = await fixture.kernel.turn.create(
      "turn_forward_active_run_fork",
      fixture.threadId,
      forkBranch.branchId,
      mainTurn.turnId,
      bootstrapCheckpoint.turnNodeHash
    );
    await fixture.kernel.run.create(
      "run_forward_active_run_fork",
      forkTurn.turnId,
      forkBranch.branchId,
      fixture.schemaId,
      bootstrapCheckpoint.turnNodeHash,
      [{ deterministic: false, id: "fork-step", sideEffects: false }]
    );
    const forkCheckpoint = await fixture.kernel.run.completeStep(
      "run_forward_active_run_fork",
      "fork-step"
    );

    if (forkCheckpoint.turnNodeHash === undefined) {
      throw new Error("expected fork checkpoint turn node");
    }

    await fixture.kernel.run.create(
      "run_forward_active_run",
      mainTurn.turnId,
      fixture.branchId,
      fixture.schemaId,
      bootstrapCheckpoint.turnNodeHash,
      [{ deterministic: false, id: "step", sideEffects: false }]
    );

    await expect(
      fixture.kernel.branch.setHead(
        fixture.branchId,
        forkCheckpoint.turnNodeHash
      )
    ).rejects.toThrow(
      'branch "branch_forward_active_run" cannot move head while run "run_forward_active_run" is active'
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

  test("branch.setHead clears staged results before failing abandoned active runs", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_rollback_clears_staged",
      threadId: "thread_rollback_clears_staged",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_rollback_clears_staged",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    await fixture.kernel.run.create(
      "run_rollback_clears_staged",
      turn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [
        { deterministic: false, id: "checkpoint", sideEffects: false },
        { deterministic: true, id: "active", sideEffects: false },
      ]
    );

    const checkpoint = await fixture.kernel.run.completeStep(
      "run_rollback_clears_staged",
      "checkpoint"
    );

    if (checkpoint.turnNodeHash === undefined) {
      throw new Error("expected checkpoint turn node");
    }

    await fixture.kernel.staging.stage(
      "run_rollback_clears_staged",
      new Uint8Array([4, 5, 6]),
      "task_rollback_clears_staged",
      "message",
      "completed"
    );

    const rollback = await fixture.kernel.branch.setHead(
      fixture.branchId,
      fixture.rootTurnNodeHash
    );

    expect(rollback.archiveBranch?.headTurnNodeHash).toBe(
      checkpoint.turnNodeHash
    );
    expect(
      await fixture.kernel.staging.current("run_rollback_clears_staged")
    ).toEqual([]);
    const storedRun = await fixture.backend.transact((tx) =>
      tx.runs.get("run_rollback_clears_staged")
    );
    expect(storedRun?.status).toBe("failed");
  });

  test("run.beginStep keeps pending signals durable until completion", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_pending_signal_durability",
      threadId: "thread_pending_signal_durability",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_pending_signal_durability",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    await fixture.kernel.run.create(
      "run_pending_signal_durability",
      turn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [
        { deterministic: true, id: "first", sideEffects: false },
        { deterministic: true, id: "second", sideEffects: false },
        { deterministic: true, id: "third", sideEffects: false },
      ]
    );

    await fixture.kernel.run.completeStep(
      "run_pending_signal_durability",
      "first",
      undefined,
      [{ annotations: [], signals: [{ kind: "signal", n: 1 }] }]
    );

    const first = await fixture.kernel.run.beginStep(
      "run_pending_signal_durability",
      "second"
    );
    const second = await fixture.kernel.run.beginStep(
      "run_pending_signal_durability",
      "second"
    );

    expect(first.signals).toEqual([{ kind: "signal", n: 1 }]);
    expect(second.signals).toEqual([{ kind: "signal", n: 1 }]);

    await fixture.kernel.run.completeStep(
      "run_pending_signal_durability",
      "second"
    );
    const third = await fixture.kernel.run.beginStep(
      "run_pending_signal_durability",
      "third"
    );
    expect(third.signals).toEqual([]);
  });

  test("run.completeStep persists observe annotations as append-only records", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_observe_annotations",
      threadId: "thread_observe_annotations",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_observe_annotations",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    await fixture.kernel.run.create(
      "run_observe_annotations",
      turn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [
        { deterministic: true, id: "a", sideEffects: false },
        { deterministic: true, id: "b", sideEffects: false },
      ]
    );

    await fixture.kernel.run.completeStep(
      "run_observe_annotations",
      "a",
      undefined,
      [{ annotations: [{ note: "first" }], signals: [] }]
    );
    await fixture.kernel.run.completeStep(
      "run_observe_annotations",
      "b",
      undefined,
      [{ annotations: [{ note: "second" }], signals: [] }]
    );

    const records = await fixture.backend.transact((tx) =>
      tx.observeAnnotations.listByRun("run_observe_annotations")
    );

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.runId)).toEqual([
      "run_observe_annotations",
      "run_observe_annotations",
    ]);
  });

  test("run.completeStep preserves duplicate observe annotations", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_duplicate_observe_annotations",
      now: () => 100,
      threadId: "thread_duplicate_observe_annotations",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_duplicate_observe_annotations",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    await fixture.kernel.run.create(
      "run_duplicate_observe_annotations",
      turn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [{ deterministic: true, id: "a", sideEffects: false }]
    );

    await fixture.kernel.run.completeStep(
      "run_duplicate_observe_annotations",
      "a",
      undefined,
      [
        {
          annotations: [{ note: "same" }, { note: "same" }],
          signals: [],
        },
      ]
    );

    const records = await fixture.backend.transact((tx) =>
      tx.observeAnnotations.listByRun("run_duplicate_observe_annotations")
    );

    expect(records).toHaveLength(2);
    expect(records[0]?.annotationHash).toBe(records[1]?.annotationHash);
  });

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
