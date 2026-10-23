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

import {
  rejectionOf,
  createThreadFixture,
} from "./runtime-kernel-test-helpers.ts";

describe("createRuntimeKernel run liveness", () => {
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

    const rejectedError1 = await rejectionOf(
      fixture.kernel.runLiveness.renewLease(
        leasedRun.runId,
        "owner-alpha",
        leasedRun.fencingToken ?? "",
        75
      )
    );
    expect(rejectedError1.message).toContain("fencing token");

    const resolvedValue2 = await fixture.kernel.runLiveness.renewLease(
      leasedRun.runId,
      "owner-alpha",
      stepResult.lease?.fencingToken ?? "",
      75
    );
    expect(typeof resolvedValue2.fencingToken).toBe("string");
    expect(resolvedValue2.leaseExpiresAtMs).toBe(75);
  });
});
