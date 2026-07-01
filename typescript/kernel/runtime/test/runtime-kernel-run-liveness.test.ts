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

describe("createRuntimeKernel run liveness", () => {
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
});
