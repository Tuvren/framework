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
  startEventCapture,
  textSignal,
  waitForAbort,
  waitForAsync,
} from "./runtime-core-test-helpers.ts";

function hasAssistantTextMessage(
  messages: readonly unknown[],
  expectedText: string
): boolean {
  return messages.some((message) => {
    const record =
      message === null || typeof message !== "object"
        ? null
        : (message as Record<string, unknown>);

    if (record?.role !== "assistant" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord =
        part === null || typeof part !== "object"
          ? null
          : (part as Record<string, unknown>);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  });
}

function countUserTextMessages(
  messages: readonly unknown[],
  expectedText: string
): number {
  return messages.filter((message) => {
    const record =
      message === null || typeof message !== "object"
        ? null
        : (message as Record<string, unknown>);

    if (record?.role !== "user" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord =
        part === null || typeof part !== "object"
          ? null
          : (part as Record<string, unknown>);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  }).length;
}

describe("framework-runtime-core", () => {
  test("drops driver output that arrives after lease loss aborts the execution", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness, {
      async onRenewLease() {
        throw new TuvrenRuntimeError("lease fencing token is stale", {
          code: "kernel_runtime_run_lease_token_mismatch",
        });
      },
    });
    const driver = {
      async execute(context) {
        await waitForAbort(context.signal);
        await delay(20);
        return {
          messages: [assistantText("late success")],
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
        leaseDurationMs: 40,
        renewBeforeMs: 20,
      },
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Ignore cancellation and answer late"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("failed");
    expect(livenessHarness.getRenewLeaseCalls()).toBeGreaterThan(0);
    expect(
      hasAssistantTextMessage(
        await harness.readBranchMessages(thread.branchId),
        "late success"
      )
    ).toBe(false);
  });

  test("drops driver output after another owner preempts and clears the lease", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const driver = {
      async execute(context) {
        await waitForAbort(context.signal);
        await delay(20);
        return {
          messages: [assistantText("late after preemption")],
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
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Be preempted"),
      threadId: thread.threadId,
    });
    const capture = startEventCapture(handle.events());
    await waitForAsync(async () => {
      return (await harness.readBranchRuns(thread.branchId)).some(
        (run) =>
          run.status === "running" && run.stepSequence[0]?.id === "iterate"
      );
    });
    const activeRunId = (await harness.readBranchRuns(thread.branchId)).find(
      (run) => run.status === "running" && run.stepSequence[0]?.id === "iterate"
    )?.runId;

    if (activeRunId === undefined) {
      throw new Error("expected an active run to preempt");
    }

    await livenessHarness.kernel.runLiveness.preemptExpired(
      activeRunId,
      "worker-2",
      10,
      "stale_running_recovery"
    );
    await capture.done;

    expect(handle.status().phase).toBe("failed");
    expect(
      hasAssistantTextMessage(
        await harness.readBranchMessages(thread.branchId),
        "late after preemption"
      )
    ).toBe(false);
  });

  test("recovers a stale handoff_context run under the persisted target agent", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const driver = {
      async execute() {
        return {
          messages: [assistantText("Recovered handoff continued.")],
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
      resolveAgentConfig(agentName) {
        if (agentName === "reviewer") {
          return { name: "reviewer" };
        }

        if (agentName === "primary") {
          return { name: "primary" };
        }

        return undefined;
      },
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      "turn_stale_handoff_recovery",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_stale_handoff_recovery",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [
        { deterministic: false, id: "handoff_context", sideEffects: false },
      ],
      turnId: staleTurn.turnId,
    });
    await livenessHarness.kernel.staging.stage(
      "run_stale_handoff_recovery",
      encodeDeterministicKernelRecord({
        parts: [
          {
            text: "Continue the same handoff",
            type: "text",
          },
        ],
        role: "user",
      }),
      "stale_handoff_user_message",
      "message",
      "completed"
    );
    await livenessHarness.kernel.staging.stage(
      "run_stale_handoff_recovery",
      encodeDeterministicKernelRecord({
        activeAgent: "reviewer",
        state: "running",
      }),
      "stale_handoff_runtime_status",
      "runtime_status",
      "completed"
    );

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Continue the same handoff"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(handle.status().activeAgent).toBe("reviewer");
  });

  test("recovers a stale incorporate_steering run without replaying the non-durable steering", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const driver = {
      async execute(context) {
        expect(
          countUserTextMessages(context.messages, "Continue base request")
        ).toBe(1);
        expect(
          countUserTextMessages(context.messages, "Non-durable steering")
        ).toBe(0);
        return {
          messages: [assistantText("Recovered steering continued.")],
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
      "turn_stale_steering_recovery",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_stale_steering_recovery",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [
        { deterministic: false, id: "incorporate_steering", sideEffects: true },
      ],
      turnId: staleTurn.turnId,
    });
    await livenessHarness.kernel.staging.stage(
      "run_stale_steering_recovery",
      encodeDeterministicKernelRecord({
        parts: [
          {
            text: "Continue base request",
            type: "text",
          },
        ],
        role: "user",
      }),
      "stale_steering_user_message",
      "message",
      "completed"
    );

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Continue base request"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
  });

  test("completes a stale finalize_turn_status recovery from durable terminal runtime status", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const driver = {
      async execute() {
        throw new Error("execute was not expected");
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
      "turn_stale_finalize_recovery",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_stale_finalize_recovery",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [
        { deterministic: false, id: "finalize_turn_status", sideEffects: true },
      ],
      turnId: staleTurn.turnId,
    });
    await livenessHarness.kernel.staging.stage(
      "run_stale_finalize_recovery",
      encodeDeterministicKernelRecord({
        parts: [
          {
            text: "Finalize this recovered turn",
            type: "text",
          },
        ],
        role: "user",
      }),
      "stale_finalize_user_message",
      "message",
      "completed"
    );
    await livenessHarness.kernel.staging.stage(
      "run_stale_finalize_recovery",
      encodeDeterministicKernelRecord({
        activeAgent: "primary",
        state: "completed",
      }),
      "stale_finalize_runtime_status",
      "runtime_status",
      "completed"
    );

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Finalize this recovered turn"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
  });
});

function createDriverRegistry(
  drivers: Array<KrakenDriver | KrakenDriverFactory> = []
) {
  return createBaseDriverRegistry(drivers.map(wrapDriverEntry));
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
