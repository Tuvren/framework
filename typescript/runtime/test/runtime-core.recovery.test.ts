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

import { assertKernelRecord, DEFAULT_SCOPE } from "@tuvren/core";
import { IDENTITY_PAYLOAD_CODEC } from "@tuvren/core/lifecycle";
import type { TuvrenMessage } from "@tuvren/core/messages";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import type {
  RecoveryState,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
} from "@tuvren/kernel-protocol";

import { createTuvrenRuntime, DEFAULT_AGENT_SCHEMA } from "../src/index.ts";
import { deriveIdempotencyKey } from "../src/lib/idempotency-identity.ts";
import { encryptMessageRecord } from "../src/lib/payload-codec-seam.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import { createFakeRunLivenessKernelHarness } from "./fake-run-liveness-kernel.ts";
import { prepareExpiredToolBatch } from "./runtime-core-cold-recovery-test-helpers.ts";
import {
  countUserTextMessages,
  createRunnerRegistry,
  createTelemetryCapture,
  hasAssistantTextMessage,
  requireAssistantMessage,
  toolResultMessage,
  wrapTestRunLiveness,
} from "./runtime-core-recovery-test-helpers.ts";
import type {
  TestRunLiveness,
  TestRuntimeRunner,
} from "./runtime-core-recovery-test-helpers.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  delay,
  extractTurnId,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("rejects run-liveness configuration when the kernel does not implement the extension", () => {
    const harness = createFakeKernelHarness();

    expect(() =>
      createTuvrenRuntime({
        defaultRunnerId: "fake",
        kernel: harness.kernel,
        runLiveness: {
          executionOwnerId: "worker-1",
          leaseDurationMs: 50,
        },
        runnerRegistry: createRunnerRegistry([]),
      })
    ).toThrow("kernel.run-liveness extension");
  });

  test("renews leased runs while a turn stays running", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
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
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    let createLeasedRunCalls = 0;
    let renewLeaseCalls = 0;
    const runLiveness = {
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
      listExpired(_nowMs) {
        return [];
      },
      preemptExpired(_runId, _preemptingOwnerId, _nowMs, _reason) {
        throw new Error("preemptExpired was not expected");
      },
      renewLease(
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
    } satisfies TestRunLiveness;
    const kernel: RuntimeKernel & RuntimeKernelRunLiveness = {
      ...harness.kernel,
      runLiveness: wrapTestRunLiveness(runLiveness),
    };
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 60,
        renewBeforeMs: 20,
      },
      runnerRegistry: createRunnerRegistry([runner]),
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
    const runner = {
      execute(context) {
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
    const branchRuns = await harness.readBranchRuns(thread.branchId);
    expect(
      branchRuns.find((run) => run.runId === "run_stale_leased_execution")
        ?.status
    ).toBe("failed");
    expect(telemetry.events.map((event) => event.kind)).toContain(
      "recovery.resumed"
    );
    expect(telemetry.spans.map((span) => span.kind)).toContain("recovery");
  });

  test("re-incorporates the original signal on the same turn when incorporate_input crashed before a durable user message", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const runner = {
      execute(context) {
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
    const runner = {
      execute(context) {
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

  test("resumes only the missing durable call after a partial tool batch crash", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const originalPreemptExpired =
      livenessHarness.kernel.runLiveness.preemptExpired.bind(
        livenessHarness.kernel.runLiveness
      );
    let recoveredAtPreemption: RecoveryState | undefined;
    let branchHeadAtPreemption: string | undefined;
    const inputCheckpointCapture: { hash?: string } = {};
    let messagesAtPreemption: unknown[] = [];
    let manifestAtPreemption:
      | Awaited<ReturnType<typeof harness.readBranchManifest>>
      | undefined;
    const kernel = {
      ...livenessHarness.kernel,
      runLiveness: {
        ...livenessHarness.kernel.runLiveness,
        async preemptExpired(runId, preemptingOwnerId, nowMs, reason) {
          const uncommittedState =
            await livenessHarness.kernel.run.recover(runId);
          const recovery = await originalPreemptExpired(
            runId,
            preemptingOwnerId,
            nowMs,
            reason
          );
          recoveredAtPreemption = recovery;
          const inputCheckpoint = inputCheckpointCapture.hash;

          if (inputCheckpoint === undefined) {
            throw new Error(
              "expected input checkpoint before stale preemption"
            );
          }

          await livenessHarness.kernel.branch.setHead(
            "branch_partial_tool_batch_crash",
            inputCheckpoint
          );
          const recoveredState: RecoveryState = {
            ...recovery,
            consumedStagedResults: [],
            lastTurnNodeHash: inputCheckpoint,
            uncommittedStagedResults: uncommittedState.uncommittedStagedResults,
          };
          recoveredAtPreemption = recoveredState;
          messagesAtPreemption = await harness.readBranchMessages(
            "branch_partial_tool_batch_crash"
          );
          manifestAtPreemption = await harness.readBranchManifest(
            "branch_partial_tool_batch_crash"
          );
          const branch = await livenessHarness.kernel.branch.get(
            "branch_partial_tool_batch_crash"
          );
          branchHeadAtPreemption = branch?.headTurnNodeHash;
          return recoveredState;
        },
      },
    } satisfies RuntimeKernel & RuntimeKernelRunLiveness;
    const thread = await kernel.thread.create(
      "thread_partial_tool_batch_crash",
      DEFAULT_AGENT_SCHEMA.schemaId,
      "branch_partial_tool_batch_crash"
    );
    const staleTurn = await kernel.turn.create(
      "turn_partial_tool_batch_crash",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    const payloadBinding = {
      codec: IDENTITY_PAYLOAD_CODEC,
      scope: DEFAULT_SCOPE,
    };
    const stageMessage = async (
      runId: string,
      taskId: string,
      message: TuvrenMessage
    ) => {
      assertKernelRecord(message, "partial tool batch staged message");
      return await kernel.staging.stage(
        runId,
        await encryptMessageRecord(
          payloadBinding,
          encodeDeterministicKernelRecord(message)
        ),
        taskId,
        "message",
        "completed"
      );
    };

    await kernel.run.create(
      "run_partial_tool_batch_input",
      staleTurn.turnId,
      thread.branchId,
      DEFAULT_AGENT_SCHEMA.schemaId,
      thread.rootTurnNodeHash,
      [
        {
          deterministic: false,
          id: "incorporate_input",
          sideEffects: true,
        },
      ]
    );
    await kernel.run.beginStep(
      "run_partial_tool_batch_input",
      "incorporate_input"
    );
    await stageMessage("run_partial_tool_batch_input", "durable_user_signal", {
      parts: [{ text: "Resume the interrupted batch", type: "text" }],
      role: "user",
    });
    const inputCheckpoint = await kernel.run.completeStep(
      "run_partial_tool_batch_input",
      "incorporate_input"
    );
    await kernel.run.complete("run_partial_tool_batch_input", "completed");

    if (inputCheckpoint.turnNodeHash === undefined) {
      throw new Error("expected durable user checkpoint");
    }
    inputCheckpointCapture.hash = inputCheckpoint.turnNodeHash;

    await kernel.turn.updateHead(
      staleTurn.turnId,
      inputCheckpoint.turnNodeHash
    );
    const manifestAfterInput = await harness.readBranchManifest(
      thread.branchId
    );
    await kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-that-crashed",
      leaseExpiresAtMs: 20,
      runId: "run_partial_tool_batch_crash",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: inputCheckpoint.turnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: staleTurn.turnId,
    });
    await kernel.run.beginStep("run_partial_tool_batch_crash", "iterate");
    const originalAssistant = requireAssistantMessage(
      assistantToolCalls([
        {
          callId: "call_completed_main",
          input: { value: 1 },
          name: "lookup",
        },
        {
          callId: "call_completed_second",
          input: { value: 2 },
          name: "lookup",
        },
        {
          callId: "call_missing",
          input: { value: 3 },
          name: "charge",
        },
      ])
    );
    await stageMessage(
      "run_partial_tool_batch_crash",
      "assistant_message",
      originalAssistant
    );
    await stageMessage(
      "run_partial_tool_batch_crash",
      "tool_result_0_call_completed_main",
      toolResultMessage("call_completed_main", 1)
    );
    await stageMessage(
      "run_partial_tool_batch_crash",
      "tool_result_1_call_completed_second",
      toolResultMessage("call_completed_second", 2)
    );

    const dispatchedCallIds: string[] = [];
    const dispatchedIdempotencyKeys: string[] = [];
    let runnerCalls = 0;
    let recoveredToolCallTotal: number | undefined;
    let recoveredToolResultTotal: number | undefined;
    const runner = {
      execute() {
        runnerCalls += 1;
        return {
          messages: [assistantText("Recovered batch completed.")],
          resolution: { reason: "done", type: "end_turn" },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    let now = 19;
    now = 21;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel,
      now: () => now,
      payloadCodec: IDENTITY_PAYLOAD_CODEC,
      runLiveness: {
        executionOwnerId: "replacement-worker",
        leaseDurationMs: 50,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        contextPolicy: {
          evaluate(manifest) {
            recoveredToolCallTotal ??= manifest.toolCalls.total;
            recoveredToolResultTotal ??= manifest.toolResults.total;
            return { action: "none" };
          },
        },
        name: "primary",
        tools: [
          {
            description: "Record which durable call identity was dispatched",
            execute(_input, context) {
              dispatchedCallIds.push(context.callId);
              return { ok: true };
            },
            inputSchema: { type: "object" },
            name: "lookup",
          },
          {
            description: "Apply a non-retryable external side effect",
            execute(_input, context) {
              dispatchedCallIds.push(context.callId);

              if (context.idempotencyKey === undefined) {
                throw new Error("expected recovered dispatch idempotency key");
              }

              dispatchedIdempotencyKeys.push(context.idempotencyKey);
              return { value: 3 };
            },
            inputSchema: { type: "object" },
            name: "charge",
            nonRetryable: true,
          },
        ],
      },
      signal: textSignal("Resume the interrupted batch"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());

    if (
      recoveredAtPreemption === undefined ||
      branchHeadAtPreemption === undefined ||
      manifestAtPreemption === undefined
    ) {
      throw new Error("expected stale preemption capture");
    }

    const branchRuns = await harness.readBranchRuns(thread.branchId);
    const staleRun = branchRuns.find(
      (run) => run.runId === "run_partial_tool_batch_crash"
    );
    expect(staleRun).toMatchObject({
      preemptionReason: "stale_running_recovery",
      status: "failed",
    });
    expect(staleRun?.leaseExpiresAtMs).toBeUndefined();
    expect(livenessHarness.leasedRuns.has(staleRun?.runId ?? "")).toBe(false);
    expect(recoveredAtPreemption.lastTurnNodeHash).toBe(branchHeadAtPreemption);
    expect(recoveredAtPreemption.consumedStagedResults).toEqual([]);
    expect(
      recoveredAtPreemption.uncommittedStagedResults.map(
        (result) => result.taskId
      )
    ).toEqual([
      "assistant_message",
      "tool_result_0_call_completed_main",
      "tool_result_1_call_completed_second",
    ]);
    expect(messagesAtPreemption).toEqual([
      {
        parts: [{ text: "Resume the interrupted batch", type: "text" }],
        role: "user",
      },
    ]);
    expect(recoveredToolCallTotal).toBe(3);
    expect(recoveredToolResultTotal).toBe(2);
    expect(
      originalAssistant.parts
        .filter((part) => part.type === "tool_call")
        .map((part) => part.callId)
        .filter((callId) => !dispatchedCallIds.includes(callId))
    ).toEqual(["call_completed_main", "call_completed_second"]);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Resume the interrupted batch", type: "text" }],
        role: "user",
      },
      originalAssistant,
      toolResultMessage("call_completed_main", 1),
      toolResultMessage("call_completed_second", 2),
      {
        parts: [
          {
            callId: "call_missing",
            name: "charge",
            output: { value: 3 },
            type: "tool_result",
          },
        ],
        role: "tool",
      },
      assistantText("Recovered batch completed."),
    ]);
    expect(manifestAtPreemption["context.manifest"]).toBe(
      manifestAfterInput["context.manifest"]
    );
    expect(manifestAtPreemption["runtime.status"]).toBe(
      manifestAfterInput["runtime.status"]
    );
    expect(runnerCalls).toBe(1);
    expect(dispatchedCallIds).toEqual(["call_missing"]);
    expect(dispatchedIdempotencyKeys).toEqual([
      deriveIdempotencyKey(staleTurn.turnId, "call_missing"),
    ]);
  });

  test("dispatches nothing for a recovered batch that already has every result", async () => {
    const originalAssistant = requireAssistantMessage(
      assistantToolCalls([
        { callId: "call_already_done", input: { value: 1 }, name: "lookup" },
      ])
    );
    const fixture = await prepareExpiredToolBatch(
      "completed_recovered_batch",
      "Continue after the completed batch",
      [originalAssistant, toolResultMessage("call_already_done", 1)]
    );
    let runnerCalls = 0;
    const runner = {
      execute() {
        runnerCalls += 1;
        return {
          messages: [assistantText("Continued after completed batch.")],
          resolution: { reason: "done", type: "end_turn" },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: fixture.kernel,
      now: () => 21,
      payloadCodec: IDENTITY_PAYLOAD_CODEC,
      runLiveness: {
        executionOwnerId: "replacement-worker",
        leaseDurationMs: 50,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const handle = runtime.executeTurn({
      branchId: fixture.thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            description: "Must not run for an already fulfilled call",
            execute() {
              throw new Error("completed recovered call was dispatched again");
            },
            inputSchema: { type: "object" },
            name: "lookup",
          },
        ],
      },
      signal: textSignal("Continue after the completed batch"),
      threadId: fixture.thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(runnerCalls).toBe(1);
    expect(
      await fixture.harness.readBranchMessages(fixture.thread.branchId)
    ).toEqual([
      {
        parts: [{ text: "Continue after the completed batch", type: "text" }],
        role: "user",
      },
      originalAssistant,
      toolResultMessage("call_already_done", 1),
      assistantText("Continued after completed batch."),
    ]);
  });

  test("uses the normal approval path for a resumed missing call", async () => {
    const originalAssistant = requireAssistantMessage(
      assistantToolCalls([
        {
          callId: "call_recovered_approval",
          input: { recipient: "ops@example.com" },
          name: "notify",
        },
      ])
    );
    const fixture = await prepareExpiredToolBatch(
      "approval_recovered_batch",
      "Resume the approval call",
      [originalAssistant]
    );
    let dispatchedCallId: string | undefined;
    let dispatchedIdempotencyKey: string | undefined;
    let runnerCalls = 0;
    const runner = {
      execute() {
        runnerCalls += 1;
        return {
          messages: [assistantText("Approved recovered call completed.")],
          resolution: { reason: "done", type: "end_turn" },
        };
      },
      id: "fake",
      resume() {
        throw new Error("resume was not expected");
      },
    } satisfies TestRuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: fixture.kernel,
      now: () => 21,
      payloadCodec: IDENTITY_PAYLOAD_CODEC,
      runLiveness: {
        executionOwnerId: "replacement-worker",
        leaseDurationMs: 50,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const pausedHandle = runtime.executeTurn({
      branchId: fixture.thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Send an approved notification",
            execute(_input, context) {
              dispatchedCallId = context.callId;
              dispatchedIdempotencyKey = context.idempotencyKey;
              return { sent: true };
            },
            inputSchema: { type: "object" },
            name: "notify",
          },
        ],
      },
      signal: textSignal("Resume the approval call"),
      threadId: fixture.thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    expect(pausedHandle.status().phase).toBe("paused");
    expect(runnerCalls).toBe(0);
    expect(dispatchedCallId).toBeUndefined();

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call_recovered_approval", type: "approve" }],
    });
    await collectEvents(resumedHandle.events());

    expect(resumedHandle.status().phase).toBe("completed");
    expect(runnerCalls).toBe(1);
    expect(dispatchedCallId).toBe("call_recovered_approval");
    expect(dispatchedIdempotencyKey).toBe(
      deriveIdempotencyKey(fixture.staleTurn.turnId, "call_recovered_approval")
    );
  });
});
