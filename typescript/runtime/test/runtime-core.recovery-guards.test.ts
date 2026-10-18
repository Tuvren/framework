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

import { TuvrenRuntimeError } from "@tuvren/core";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";

import { createTuvrenRuntime, DEFAULT_AGENT_SCHEMA } from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import { createFakeRunLivenessKernelHarness } from "./fake-run-liveness-kernel.ts";
import {
  countUserTextMessages,
  createRunnerRegistry,
} from "./runtime-core-recovery-test-helpers.ts";
import type { TestRuntimeRunner } from "./runtime-core-recovery-test-helpers.ts";
import {
  assistantText,
  collectEvents,
  extractTurnId,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core recovery guards", () => {
  test("stops before another runner pass when recovered iterations already reached maxIterations", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    let executeCalls = 0;
    const runner = {
      execute() {
        executeCalls += 1;
        return {
          messages: [
            assistantText("This extra recovered iteration should not run."),
          ],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      "turn_stale_iteration_limit_recovery",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_stale_iteration_limit_recovery",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: staleTurn.turnId,
    });
    await livenessHarness.kernel.staging.stage(
      "run_stale_iteration_limit_recovery",
      encodeDeterministicKernelRecord({
        parts: [
          {
            text: "Iteration-limited recovered request",
            type: "text",
          },
        ],
        role: "user",
      }),
      "stale_iteration_limit_user_message",
      "message",
      "completed"
    );
    await livenessHarness.kernel.staging.stage(
      "run_stale_iteration_limit_recovery",
      encodeDeterministicKernelRecord({
        parts: [
          {
            text: "Recovered first iteration output.",
            type: "text",
          },
        ],
        role: "assistant",
      }),
      "stale_iteration_limit_assistant_message",
      "message",
      "completed"
    );

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        maxIterations: 1,
        name: "primary",
      },
      signal: textSignal("Iteration-limited recovered request"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(executeCalls).toBe(0);
    expect(handle.status().phase).toBe("completed");
  });

  test("starts a fresh turn when the incoming signal does not match the recovered stale turn", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const runner = {
      execute(context) {
        expect(
          countUserTextMessages(context.messages, "Original request")
        ).toBe(1);
        expect(
          countUserTextMessages(context.messages, "Different fresh request")
        ).toBe(1);
        return {
          messages: [assistantText("Fresh turn executed.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      "turn_stale_signal_mismatch",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_stale_signal_mismatch",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: staleTurn.turnId,
    });
    await livenessHarness.kernel.staging.stage(
      "run_stale_signal_mismatch",
      encodeDeterministicKernelRecord({
        parts: [
          {
            text: "Original request",
            type: "text",
          },
        ],
        role: "user",
      }),
      "stale_user_message",
      "message",
      "completed"
    );

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Different fresh request"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const branchMessages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("completed");
    expect(extractTurnId(events)).not.toBe(staleTurn.turnId);
    expect(countUserTextMessages(branchMessages, "Original request")).toBe(1);
    expect(
      countUserTextMessages(branchMessages, "Different fresh request")
    ).toBe(1);
  });

  test("rejects branch and thread mismatches before stale-run recovery can preempt", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const runner = {
      execute() {
        return {
          messages: [assistantText("This turn should not start.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const threadA = await runtime.createThread({});
    const threadB = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      "turn_cross_thread_recovery_guard",
      threadA.threadId,
      threadA.branchId,
      null,
      threadA.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: threadA.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_cross_thread_recovery_guard",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: threadA.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: staleTurn.turnId,
    });
    const originalBranch = await livenessHarness.kernel.branch.get(
      threadA.branchId
    );
    const originalBranchHead = originalBranch?.headTurnNodeHash;
    const handle = runtime.executeTurn({
      branchId: threadA.branchId,
      config: { name: "primary" },
      signal: textSignal("Cross the streams"),
      threadId: threadB.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("branch_thread_mismatch");
    expect(livenessHarness.getPreemptCalls()).toBe(0);
    const currentBranch = await livenessHarness.kernel.branch.get(
      threadA.branchId
    );
    expect(currentBranch?.headTurnNodeHash).toBe(originalBranchHead);
  });

  test("fails before creating a replacement turn when stale recovery loses a lease-renewal race", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const originalTurnCreate = harness.kernel.turn.create;
    let runnerExecuteCalls = 0;
    let turnCreateCalls = 0;

    harness.kernel.turn.create = async (...args) => {
      turnCreateCalls += 1;
      return await originalTurnCreate(...args);
    };
    livenessHarness.kernel.runLiveness.preemptExpired = () => {
      throw new TuvrenRuntimeError("lease is no longer expired", {
        code: "kernel_runtime_run_lease_not_expired",
      });
    };

    const runner = {
      execute() {
        runnerExecuteCalls += 1;
        return {
          messages: [assistantText("This recovery should not execute.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      "turn_stale_recovery_lease_race",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_stale_recovery_lease_race",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: staleTurn.turnId,
    });
    const originalBranch = await livenessHarness.kernel.branch.get(
      thread.branchId
    );
    const originalBranchHead = originalBranch?.headTurnNodeHash;
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Do not duplicate this request"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("runtime_execution_recovery_contended");
    expect(turnCreateCalls).toBe(1);
    expect(runnerExecuteCalls).toBe(0);
    const currentBranch = await livenessHarness.kernel.branch.get(
      thread.branchId
    );
    expect(currentBranch?.headTurnNodeHash).toBe(originalBranchHead);
    const branchRuns = await harness.readBranchRuns(thread.branchId);
    expect(
      branchRuns.find((run) => run.runId === "run_stale_recovery_lease_race")
        ?.status
    ).toBe("running");
  });

  test("fails before replacement execution when another owner already won stale recovery", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const originalTurnCreate = harness.kernel.turn.create;
    let runnerExecuteCalls = 0;
    let turnCreateCalls = 0;

    harness.kernel.turn.create = async (...args) => {
      turnCreateCalls += 1;
      return await originalTurnCreate(...args);
    };
    livenessHarness.kernel.runLiveness.preemptExpired = async (runId) => {
      await harness.kernel.run.complete(runId, "failed");
      throw new TuvrenRuntimeError("stale run already fenced elsewhere", {
        code: "kernel_runtime_run_not_running",
      });
    };

    const runner = {
      execute() {
        runnerExecuteCalls += 1;
        return {
          messages: [assistantText("Competing recovery should not execute.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      "turn_stale_recovery_preempted_elsewhere",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_stale_recovery_preempted_elsewhere",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: staleTurn.turnId,
    });
    const originalBranch = await livenessHarness.kernel.branch.get(
      thread.branchId
    );
    const originalBranchHead = originalBranch?.headTurnNodeHash;
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Do not recover twice"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("runtime_execution_recovery_contended");
    expect(turnCreateCalls).toBe(1);
    expect(runnerExecuteCalls).toBe(0);
    const currentBranch = await livenessHarness.kernel.branch.get(
      thread.branchId
    );
    expect(currentBranch?.headTurnNodeHash).toBe(originalBranchHead);
    const branchRuns = await harness.readBranchRuns(thread.branchId);
    expect(
      branchRuns.find(
        (run) => run.runId === "run_stale_recovery_preempted_elsewhere"
      )?.status
    ).toBe("failed");
    expect(
      countUserTextMessages(
        await harness.readBranchMessages(thread.branchId),
        "Do not recover twice"
      )
    ).toBe(0);
  });
});
