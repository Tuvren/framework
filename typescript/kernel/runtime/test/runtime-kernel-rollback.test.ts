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

describe("createRuntimeKernel rollback and branch movement", () => {
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
});
