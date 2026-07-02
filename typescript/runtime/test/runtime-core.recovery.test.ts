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

// biome-ignore-all lint/suspicious/useAwait: Test drivers intentionally match the async framework driver contract.
import { describe, expect, test } from "bun:test";
import { TuvrenRuntimeError } from "@tuvren/core";
import type {
  DriverExecutionResult,
  RuntimeDriver as KrakenDriver,
  RuntimeDriverFactory as KrakenDriverFactory,
} from "@tuvren/core/driver";
import type {
  TelemetryEvent,
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import type {
  RuntimeKernel as KrakenKernel,
  RuntimeKernelRunLiveness,
} from "@tuvren/kernel-protocol";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
  DEFAULT_AGENT_SCHEMA,
} from "../src/index.ts";
import {
  createFakeKernelHarness,
  createFakeRunLivenessKernelHarness,
} from "./fake-kernel.ts";
import {
  assistantText,
  collectEvents,
  delay,
  extractTurnId,
  textSignal,
  toOptionalRecord,
} from "./runtime-core-test-helpers.ts";

function hasAssistantTextMessage(
  messages: readonly unknown[],
  expectedText: string
): boolean {
  return messages.some((message) => {
    const record = toOptionalRecord(message);

    if (record?.role !== "assistant" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord = toOptionalRecord(part);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  });
}

function countUserTextMessages(
  messages: readonly unknown[],
  expectedText: string
): number {
  return messages.filter((message) => {
    const record = toOptionalRecord(message);

    if (record?.role !== "user" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord = toOptionalRecord(part);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  }).length;
}

describe("framework-runtime-core", () => {
  test("rejects run-liveness configuration when the kernel does not implement the extension", () => {
    const harness = createFakeKernelHarness();

    expect(() =>
      createTuvrenRuntime({
        defaultDriverId: "fake",
        driverRegistry: createDriverRegistry([]),
        kernel: harness.kernel,
        runLiveness: {
          executionOwnerId: "worker-1",
          leaseDurationMs: 50,
        },
      })
    ).toThrow("kernel.run-liveness extension");
  });

  test("renews leased runs while a turn stays running", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        await delay(120);
        return {
          messages: [assistantText("Lease remained active.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    let createLeasedRunCalls = 0;
    let renewLeaseCalls = 0;
    const kernel: KrakenKernel & RuntimeKernelRunLiveness = {
      ...harness.kernel,
      runLiveness: {
        async createLeasedRun(input) {
          createLeasedRunCalls += 1;
          const run = await harness.kernel.run.create(
            input.runId,
            input.turnId,
            input.branchId,
            input.schemaId,
            input.startTurnNodeHash,
            input.steps
          );
          return {
            ...run,
            executionOwnerId: input.executionOwnerId,
            fencingToken: `token-${createLeasedRunCalls}`,
            leaseExpiresAtMs: input.leaseExpiresAtMs,
          };
        },
        async listExpired(_nowMs) {
          return [];
        },
        async preemptExpired(_runId, _preemptingOwnerId, _nowMs, _reason) {
          throw new Error("preemptExpired was not expected");
        },
        async renewLease(
          _runId,
          _executionOwnerId,
          _fencingToken,
          nextLeaseExpiresAtMs
        ) {
          renewLeaseCalls += 1;
          return {
            fencingToken: `token-renewed-${renewLeaseCalls}`,
            leaseExpiresAtMs: nextLeaseExpiresAtMs,
          };
        },
      },
    };
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 60,
        renewBeforeMs: 20,
      },
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Keep the lease alive"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(createLeasedRunCalls).toBeGreaterThan(0);
    expect(renewLeaseCalls).toBeGreaterThan(0);
  });

  test("preempts an expired leased branch run before starting replacement execution", async () => {
    const telemetry = createTelemetryCapture();
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const driver = {
      async execute(context) {
        expect(
          countUserTextMessages(context.messages, "Replace the stale run")
        ).toBe(1);
        return {
          messages: [assistantText("Replacement execution succeeded.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
      telemetry: telemetry.sink,
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      "turn_stale_leased_execution",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_stale_leased_execution",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [
        { deterministic: false, id: "incorporate_input", sideEffects: true },
      ],
      turnId: staleTurn.turnId,
    });
    await livenessHarness.kernel.staging.stage(
      "run_stale_leased_execution",
      encodeDeterministicKernelRecord({
        parts: [
          {
            text: "Replace the stale run",
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
      signal: textSignal("Replace the stale run"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(extractTurnId(events)).toBe(staleTurn.turnId);
    expect(livenessHarness.getPreemptCalls()).toBe(1);
    expect(
      (await harness.readBranchRuns(thread.branchId)).find(
        (run) => run.runId === "run_stale_leased_execution"
      )?.status
    ).toBe("failed");
    expect(telemetry.events.map((event) => event.kind)).toContain(
      "recovery.resumed"
    );
    expect(telemetry.spans.map((span) => span.kind)).toContain("recovery");
  });

  test("re-incorporates the original signal on the same turn when incorporate_input crashed before a durable user message", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const driver = {
      async execute(context) {
        expect(
          countUserTextMessages(
            context.messages,
            "Re-incorporate the original signal"
          )
        ).toBe(1);
        return {
          messages: [assistantText("Recovered input was incorporated once.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      "turn_stale_reincorporate_input",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_stale_reincorporate_input",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [
        { deterministic: false, id: "incorporate_input", sideEffects: true },
      ],
      turnId: staleTurn.turnId,
    });

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Re-incorporate the original signal"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const branchMessages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("completed");
    expect(extractTurnId(events)).toBe(staleTurn.turnId);
    expect(
      countUserTextMessages(
        branchMessages,
        "Re-incorporate the original signal"
      )
    ).toBe(1);
  });

  test("continues same-signal recovery from a recovered iterate branch head", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const driver = {
      async execute(context) {
        expect(
          countUserTextMessages(context.messages, "Retry the same request")
        ).toBe(1);
        expect(
          hasAssistantTextMessage(
            context.messages,
            "Recovered durable assistant output."
          )
        ).toBe(true);
        return {
          messages: [assistantText("Replacement iteration completed.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      "turn_stale_iterate_recovery",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_stale_iterate_recovery",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: staleTurn.turnId,
    });
    await livenessHarness.kernel.staging.stage(
      "run_stale_iterate_recovery",
      encodeDeterministicKernelRecord({
        parts: [
          {
            text: "Retry the same request",
            type: "text",
          },
        ],
        role: "user",
      }),
      "stale_iterate_user_message",
      "message",
      "completed"
    );
    await livenessHarness.kernel.staging.stage(
      "run_stale_iterate_recovery",
      encodeDeterministicKernelRecord({
        parts: [
          {
            text: "Recovered durable assistant output.",
            type: "text",
          },
        ],
        role: "assistant",
      }),
      "stale_iterate_assistant_message",
      "message",
      "completed"
    );

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Retry the same request"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(extractTurnId(events)).toBe(staleTurn.turnId);
  });

  test("stops before another driver pass when recovered iterations already reached maxIterations", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    let executeCalls = 0;
    const driver = {
      async execute() {
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
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
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
    const driver = {
      async execute(context) {
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
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
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
    const driver = {
      async execute() {
        return {
          messages: [assistantText("This turn should not start.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
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
    const originalBranchHead = (
      await livenessHarness.kernel.branch.get(threadA.branchId)
    )?.headTurnNodeHash;
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
    expect(
      (await livenessHarness.kernel.branch.get(threadA.branchId))
        ?.headTurnNodeHash
    ).toBe(originalBranchHead);
  });

  test("fails before creating a replacement turn when stale recovery loses a lease-renewal race", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const originalTurnCreate = harness.kernel.turn.create;
    let driverExecuteCalls = 0;
    let turnCreateCalls = 0;

    harness.kernel.turn.create = async (...args) => {
      turnCreateCalls += 1;
      return await originalTurnCreate(...args);
    };
    livenessHarness.kernel.runLiveness.preemptExpired = async () => {
      throw new TuvrenRuntimeError("lease is no longer expired", {
        code: "kernel_runtime_run_lease_not_expired",
      });
    };

    const driver = {
      async execute() {
        driverExecuteCalls += 1;
        return {
          messages: [assistantText("This recovery should not execute.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
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
    const originalBranchHead = (
      await livenessHarness.kernel.branch.get(thread.branchId)
    )?.headTurnNodeHash;
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
    expect(driverExecuteCalls).toBe(0);
    expect(
      (await livenessHarness.kernel.branch.get(thread.branchId))
        ?.headTurnNodeHash
    ).toBe(originalBranchHead);
    expect(
      (await harness.readBranchRuns(thread.branchId)).find(
        (run) => run.runId === "run_stale_recovery_lease_race"
      )?.status
    ).toBe("running");
  });

  test("fails before replacement execution when another owner already won stale recovery", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const originalTurnCreate = harness.kernel.turn.create;
    let driverExecuteCalls = 0;
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

    const driver = {
      async execute() {
        driverExecuteCalls += 1;
        return {
          messages: [assistantText("Competing recovery should not execute.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
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
    const originalBranchHead = (
      await livenessHarness.kernel.branch.get(thread.branchId)
    )?.headTurnNodeHash;
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
    expect(driverExecuteCalls).toBe(0);
    expect(
      (await livenessHarness.kernel.branch.get(thread.branchId))
        ?.headTurnNodeHash
    ).toBe(originalBranchHead);
    expect(
      (await harness.readBranchRuns(thread.branchId)).find(
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
function createDriverRegistry(
  drivers: Array<KrakenDriver | KrakenDriverFactory> = []
) {
  return createBaseDriverRegistry(drivers.map(wrapDriverEntry));
}

function createTelemetryCapture(): {
  events: TelemetryEvent[];
  sink: TuvrenTelemetrySink;
  spans: TelemetrySpan[];
} {
  const events: TelemetryEvent[] = [];
  const spans: TelemetrySpan[] = [];

  return {
    events,
    sink: {
      event: (event) => {
        events.push(event);
      },
      span: (span) => {
        spans.push(span);
      },
    },
    spans,
  };
}

function wrapDriverEntry(
  entry: KrakenDriver | KrakenDriverFactory
): KrakenDriver | KrakenDriverFactory {
  if (isKrakenDriverFactory(entry)) {
    return {
      create() {
        return wrapDriver(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapDriver(entry);
}

function isKrakenDriverFactory(
  entry: KrakenDriver | KrakenDriverFactory
): entry is KrakenDriverFactory {
  return "create" in entry && typeof entry.create === "function";
}

function wrapDriver(driver: KrakenDriver): KrakenDriver {
  const resume = driver.resume;

  return {
    async execute(context) {
      return normalizeDriverResult(await driver.execute(context));
    },
    id: driver.id,
    ...(resume === undefined
      ? {}
      : {
          async resume(context) {
            return normalizeDriverResult(await resume(context));
          },
        }),
  };
}

function normalizeDriverResult(
  result: DriverExecutionResult
): DriverExecutionResult {
  if (
    result.toolExecutionMode !== undefined ||
    !requestsToolExecution(result)
  ) {
    return result;
  }

  return {
    ...result,
    toolExecutionMode: "parallel",
  };
}

function requestsToolExecution(result: DriverExecutionResult): boolean {
  return (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );
}
