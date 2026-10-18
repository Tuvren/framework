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

// KRT-BO002 prerequisite (recovery-signal comparison).
//
// Expired-run recovery compares the incoming input signal against the last
// durable user message of the recovered turn. The deterministic kernel decoder
// materializes every stored CBOR map as an `Object.create(null)` record, while
// the live signal is composed of `Object.prototype` objects, so a comparison
// that also inspects prototypes reports a mismatch for identical JSON data and
// the runtime discards a turn it could have resumed.
//
// These cases pin the behavioural intent the six existing public recovery
// scenarios in `runtime-core.recovery.test.ts` and
// `runtime-core.stale-step-recovery.test.ts` assert end to end: equal nested
// JSON signal data matches across the durable roundtrip (reordered object keys
// included), while genuinely different content, array order, or value types
// stay a mismatch. The final case drives that same public recovery path with
// nested JSON signal data.

import { describe, expect, test } from "bun:test";

import { createMemoryBackend } from "@tuvren/backend-memory";
import type { KernelRecord } from "@tuvren/core";
import type { InputSignal } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { RuntimeRunner } from "@tuvren/core/runner";
import {
  encodeDeterministicKernelRecord,
  type RuntimeKernel,
  type RuntimeKernelRunLiveness,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";

import {
  createRunnerRegistry,
  createTuvrenRuntime,
  DEFAULT_AGENT_SCHEMA,
} from "../src/index.ts";
import {
  classifyRecoveredTurnSignalState,
  decodeKrakenMessageRecord,
  doesSignalMatchRecoveredTurn,
} from "../src/lib/runtime-core-recovery.ts";
import {
  createFakeKernelHarness,
  createFakeRunLivenessKernelHarness,
} from "./fake-kernel.ts";
import {
  assistantText,
  collectEvents,
  extractTurnId,
} from "./runtime-core-test-helpers.ts";

const RESUME_TEXT = "Resume with the same payload";
const KEYED_RECOVERY_TEXT = "Recover this keyed request";

function nestedResumeData() {
  return {
    filters: { limit: 10, tags: ["alpha", "beta"] },
    nested: { enabled: true, note: null },
    retry: 2,
  };
}

function keyReorderedResumeData() {
  return {
    retry: 2,
    nested: { note: null, enabled: true },
    filters: { tags: ["alpha", "beta"], limit: 10 },
  };
}

/** Stage `data` through the deterministic kernel roundtrip the recovery path
 * reads, exactly as a durable user message was persisted. */
function durableResumeUserMessage(data: KernelRecord): TuvrenMessage {
  return decodeKrakenMessageRecord(
    encodeDeterministicKernelRecord({
      parts: [
        { text: RESUME_TEXT, type: "text" },
        {
          data,
          name: "resume-context",
          providerMetadata: { attempt: 1, source: "test" },
          type: "structured",
        },
      ],
      role: "user",
    }),
    "recovered user message"
  );
}

/** The live inbound signal carrying the same nested JSON data. */
function resumeSignal(data: KernelRecord): InputSignal {
  return {
    parts: [
      { text: RESUME_TEXT, type: "text" },
      {
        data,
        name: "resume-context",
        providerMetadata: { attempt: 1, source: "test" },
        type: "structured",
      },
    ],
  };
}

function requireUserMessage(message: TuvrenMessage) {
  if (message.role !== "user") {
    throw new Error("the durable record must decode to a user message");
  }

  return message;
}

function keyedSignal(admissionKey: string): InputSignal {
  return {
    admissionKey,
    parts: [{ text: KEYED_RECOVERY_TEXT, type: "text" }],
  };
}

function keyedUserMessage(admissionKey: string): TuvrenMessage {
  return {
    admissionKey,
    parts: [{ text: KEYED_RECOVERY_TEXT, type: "text" }],
    role: "user",
  };
}

async function checkpointUserMessage(
  kernel: RuntimeKernel,
  input: {
    activeTurnId?: string;
    branchId: string;
    message: TuvrenMessage;
    runId: string;
    startTurnNodeHash: string;
    stepId: "incorporate_input" | "incorporate_steering";
    taskId: string;
    turnId: string;
  }
): Promise<string> {
  await kernel.run.create(
    input.runId,
    input.turnId,
    input.branchId,
    DEFAULT_AGENT_SCHEMA.schemaId,
    input.startTurnNodeHash,
    [{ deterministic: false, id: input.stepId, sideEffects: false }]
  );
  await kernel.run.beginStep(input.runId, input.stepId);
  await kernel.staging.stage(
    input.runId,
    encodeDeterministicKernelRecord(input.message as unknown as KernelRecord),
    input.taskId,
    "message",
    "completed"
  );
  let treeHash: string | undefined;

  if (input.activeTurnId !== undefined) {
    const startNode = await kernel.node.get(input.startTurnNodeHash);

    if (startNode === null) {
      throw new Error("expected checkpoint start node");
    }

    const lineageHash = await kernel.store.put(
      encodeDeterministicKernelRecord({ activeTurnId: input.activeTurnId })
    );
    const incorporatedTreeHash = await kernel.tree.incorporate(
      startNode.turnTreeHash,
      await kernel.staging.current(input.runId)
    );
    treeHash = await kernel.tree.create(
      DEFAULT_AGENT_SCHEMA.schemaId,
      { "turn.lineage": lineageHash },
      incorporatedTreeHash
    );
  }

  const checkpoint = await kernel.run.completeStep(
    input.runId,
    input.stepId,
    undefined,
    undefined,
    treeHash
  );
  await kernel.run.complete(input.runId, "completed");

  if (checkpoint.turnNodeHash === undefined) {
    throw new Error(`${input.stepId} did not create a checkpoint`);
  }

  await kernel.turn.updateHead(input.turnId, checkpoint.turnNodeHash);
  await kernel.branch.setHead(input.branchId, checkpoint.turnNodeHash);
  return checkpoint.turnNodeHash;
}

async function executeKeyedRecovery(retryKey: string) {
  const suffix = retryKey.toLowerCase();
  const harness = createFakeKernelHarness();
  const livenessHarness = createFakeRunLivenessKernelHarness(harness);
  const kernel: RuntimeKernel & RuntimeKernelRunLiveness =
    livenessHarness.kernel;
  const runner = {
    execute: () =>
      Promise.resolve({
        messages: [assistantText(`Recovery result for key ${retryKey}.`)],
        resolution: {
          reason: "done",
          type: "end_turn" as const,
        },
      }),
    id: "fake",
    resume: () => Promise.reject(new Error("resume was not expected")),
  } satisfies RuntimeRunner;
  const runtime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel,
    runLiveness: {
      executionOwnerId: `recovery-owner-${suffix}`,
      leaseDurationMs: 50,
    },
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const staleTurn = await kernel.turn.create(
    `turn_keyed_recovery_${suffix}`,
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );
  const inputCheckpoint = await checkpointUserMessage(kernel, {
    branchId: thread.branchId,
    message: keyedUserMessage("A"),
    runId: `run_keyed_input_${suffix}`,
    startTurnNodeHash: thread.rootTurnNodeHash,
    stepId: "incorporate_input",
    taskId: "input_message",
    turnId: staleTurn.turnId,
  });
  const steeringCheckpoint = await checkpointUserMessage(kernel, {
    branchId: thread.branchId,
    message: keyedUserMessage("C"),
    runId: `run_keyed_steering_${suffix}`,
    startTurnNodeHash: inputCheckpoint,
    stepId: "incorporate_steering",
    taskId: "steering_message",
    turnId: staleTurn.turnId,
  });
  await kernel.runLiveness.createLeasedRun({
    branchId: thread.branchId,
    executionOwnerId: "worker-that-crashed",
    leaseExpiresAtMs: 1,
    runId: `run_keyed_stale_${suffix}`,
    schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
    startTurnNodeHash: steeringCheckpoint,
    steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
    turnId: staleTurn.turnId,
  });

  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary" },
    signal: keyedSignal(retryKey),
    threadId: thread.threadId,
  });
  const events = await collectEvents(handle.events());

  expect(handle.status().phase).toBe("completed");
  return {
    recoveredTurnId: staleTurn.turnId,
    resultTurnId: extractTurnId(events),
  };
}

async function executeKeyedRecoveryAfterEmptyInputPreemption() {
  let nowMs = 1;
  const backend = createMemoryBackend({ now: () => nowMs });
  const kernel = createRuntimeKernel({
    backend,
  });
  const runner = {
    execute: () =>
      Promise.resolve({
        messages: [assistantText("Completed the fresh keyed request.")],
        resolution: { reason: "done", type: "end_turn" as const },
      }),
    id: "fake",
    resume: () => Promise.reject(new Error("resume was not expected")),
  } satisfies RuntimeRunner;
  const runtime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel,
    now: () => nowMs,
    runLiveness: {
      executionOwnerId: "recovery-owner-empty-checkpoint",
      leaseDurationMs: 50,
    },
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const staleTurn = await kernel.turn.create(
    "turn_keyed_recovery_after_empty_checkpoint",
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );
  const preInputRunId = "run_keyed_recovery_before_input";
  await kernel.runLiveness.createLeasedRun({
    branchId: thread.branchId,
    executionOwnerId: "worker-crashed-before-input",
    leaseExpiresAtMs: 10,
    runId: preInputRunId,
    schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
    startTurnNodeHash: thread.rootTurnNodeHash,
    steps: [
      { deterministic: false, id: "incorporate_input", sideEffects: true },
    ],
    turnId: staleTurn.turnId,
  });
  await kernel.run.beginStep(preInputRunId, "incorporate_input");

  nowMs = 11;
  const emptyPreemption = await kernel.runLiveness.preemptExpired(
    preInputRunId,
    "recovery-owner-empty-checkpoint",
    nowMs,
    "stale_running_recovery"
  );
  const inputCheckpoint = await checkpointUserMessage(kernel, {
    activeTurnId: staleTurn.turnId,
    branchId: thread.branchId,
    message: keyedUserMessage("A"),
    runId: "run_keyed_recovery_input_after_empty_checkpoint",
    startTurnNodeHash: emptyPreemption.lastTurnNodeHash,
    stepId: "incorporate_input",
    taskId: "input_message",
    turnId: staleTurn.turnId,
  });
  const steeringCheckpoint = await checkpointUserMessage(kernel, {
    activeTurnId: staleTurn.turnId,
    branchId: thread.branchId,
    message: keyedUserMessage("C"),
    runId: "run_keyed_recovery_steering_after_empty_checkpoint",
    startTurnNodeHash: inputCheckpoint,
    stepId: "incorporate_steering",
    taskId: "steering_message",
    turnId: staleTurn.turnId,
  });

  const laterRunId = "run_keyed_recovery_after_steering";
  await kernel.runLiveness.createLeasedRun({
    branchId: thread.branchId,
    executionOwnerId: "worker-crashed-after-steering",
    leaseExpiresAtMs: 20,
    runId: laterRunId,
    schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
    startTurnNodeHash: steeringCheckpoint,
    steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
    turnId: staleTurn.turnId,
  });
  await kernel.run.beginStep(laterRunId, "iterate");
  nowMs = 21;
  const expiredBeforeRecovery = await kernel.runLiveness.listExpired(nowMs);
  expect(expiredBeforeRecovery.map((run) => run.runId)).toContain(laterRunId);
  const runBeforeRecovery = await backend.transact(async (tx) =>
    tx.runs.get(laterRunId)
  );
  expect(runBeforeRecovery?.status).toBe("running");
  const recoveredUsers = (
    await runtime.readBranchMessages({
      branchId: thread.branchId,
    })
  ).messages.filter(
    (message): message is Extract<TuvrenMessage, { role: "user" }> =>
      "role" in message && message.role === "user"
  );

  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary" },
    signal: keyedSignal("B"),
    threadId: thread.threadId,
  });
  const events = await collectEvents(handle.events());
  const runAfterRecovery = await backend.transact(async (tx) =>
    tx.runs.get(laterRunId)
  );
  expect(runAfterRecovery?.status).toBe("failed");
  expect(runAfterRecovery?.preemptionReason).toBe("stale_running_recovery");
  const freshUsers = (
    await runtime.readBranchMessages({
      branchId: thread.branchId,
    })
  ).messages.filter(
    (message): message is Extract<TuvrenMessage, { role: "user" }> =>
      "role" in message && message.role === "user"
  );

  return {
    freshUsers,
    recoveredUsers,
    recoveredTurnId: staleTurn.turnId,
    resultTurnId: extractTurnId(events),
  };
}

describe("framework-runtime-core", () => {
  describe("durable recovery signal comparison", () => {
    test("matches equal nested JSON signal data after a durable roundtrip", () => {
      const recovered = durableResumeUserMessage(nestedResumeData());
      const signal = resumeSignal(nestedResumeData());

      expect(classifyRecoveredTurnSignalState(signal, [recovered])).toBe(
        "match"
      );
      expect(doesSignalMatchRecoveredTurn(signal, [recovered])).toBe(true);
    });

    test("matches when the live signal orders object keys differently from the durable record", () => {
      const recovered = durableResumeUserMessage(nestedResumeData());
      const signal = resumeSignal(keyReorderedResumeData());

      expect(classifyRecoveredTurnSignalState(signal, [recovered])).toBe(
        "match"
      );
    });

    test("compares equal data even though the durable decoder yields null-prototype records", () => {
      // Guards that the case above keeps exercising the durable shape: the
      // stored record is `Object.create(null)`-backed while the live signal is
      // not, which is precisely the difference the comparison must ignore.
      const recovered = requireUserMessage(
        durableResumeUserMessage(nestedResumeData())
      );
      const signal = resumeSignal(nestedResumeData());

      expect(Object.getPrototypeOf(recovered)).toBeNull();
      expect(Object.getPrototypeOf(recovered.parts[0])).toBeNull();
      expect(classifyRecoveredTurnSignalState(signal, [recovered])).toBe(
        "match"
      );
    });

    test("matches a text-only signal after a durable roundtrip", () => {
      const recovered = decodeKrakenMessageRecord(
        encodeDeterministicKernelRecord({
          parts: [{ text: RESUME_TEXT, type: "text" }],
          role: "user",
        }),
        "recovered user message"
      );
      const signal: InputSignal = {
        parts: [{ text: RESUME_TEXT, type: "text" }],
      };

      expect(classifyRecoveredTurnSignalState(signal, [recovered])).toBe(
        "match"
      );
    });

    test("reports a mismatch when nested content differs", () => {
      const recovered = durableResumeUserMessage(nestedResumeData());
      const signal = resumeSignal({ ...nestedResumeData(), retry: 3 });

      expect(classifyRecoveredTurnSignalState(signal, [recovered])).toBe(
        "mismatch"
      );
      expect(doesSignalMatchRecoveredTurn(signal, [recovered])).toBe(false);
    });

    test("reports a mismatch when a nested array is in a different order", () => {
      const recovered = durableResumeUserMessage(nestedResumeData());
      const signal = resumeSignal({
        ...nestedResumeData(),
        filters: { limit: 10, tags: ["beta", "alpha"] },
      });

      expect(classifyRecoveredTurnSignalState(signal, [recovered])).toBe(
        "mismatch"
      );
    });

    test("reports a mismatch when a nested value changes type", () => {
      const recovered = durableResumeUserMessage(nestedResumeData());
      const signal = resumeSignal({ ...nestedResumeData(), retry: "2" });

      expect(classifyRecoveredTurnSignalState(signal, [recovered])).toBe(
        "mismatch"
      );
    });

    test("reports a mismatch when the signal carries an extra key", () => {
      const recovered = durableResumeUserMessage(nestedResumeData());
      const signal = resumeSignal({ ...nestedResumeData(), extra: true });

      expect(classifyRecoveredTurnSignalState(signal, [recovered])).toBe(
        "mismatch"
      );
    });

    test("reports missing when the recovered turn has no user message", () => {
      const recovered = decodeKrakenMessageRecord(
        encodeDeterministicKernelRecord({
          parts: [{ text: "Recovered assistant output.", type: "text" }],
          role: "assistant",
        }),
        "recovered assistant message"
      );
      const signal = resumeSignal(nestedResumeData());

      expect(classifyRecoveredTurnSignalState(signal, [recovered])).toBe(
        "missing"
      );
    });

    test("does not match a keyed retry to a branch user message without turn input provenance", () => {
      const recoveredSteer = keyedUserMessage("A");

      expect(
        classifyRecoveredTurnSignalState(keyedSignal("A"), [recoveredSteer])
      ).toBe("missing");
    });

    test("matches keyed retries against the initial input instead of a later steer", () => {
      const initialInput: TuvrenMessage = {
        admissionKey: "A",
        parts: [{ text: "Original text can differ", type: "text" }],
        role: "user",
      };
      const laterSteer = keyedUserMessage("C");

      expect(
        classifyRecoveredTurnSignalState(
          keyedSignal("A"),
          [initialInput, laterSteer],
          initialInput
        )
      ).toBe("match");
      expect(
        doesSignalMatchRecoveredTurn(
          keyedSignal("A"),
          [initialInput, laterSteer],
          initialInput
        )
      ).toBe(true);
      expect(
        classifyRecoveredTurnSignalState(
          keyedSignal("B"),
          [initialInput, laterSteer],
          initialInput
        )
      ).toBe("mismatch");
      expect(
        classifyRecoveredTurnSignalState(
          keyedSignal("C"),
          [initialInput, laterSteer],
          initialInput
        )
      ).toBe("mismatch");
    });

    test("keeps the last-user parts fallback when either input lacks a key", () => {
      const keyedInitialInput = keyedUserMessage("A");
      const keylessInitialInput: TuvrenMessage = {
        parts: [{ text: "Different initial text", type: "text" }],
        role: "user",
      };
      const latestUserMessage: TuvrenMessage = {
        parts: keyedSignal("unused").parts,
        role: "user",
      };

      expect(
        classifyRecoveredTurnSignalState(
          keyedSignal("B"),
          [keylessInitialInput, latestUserMessage],
          keylessInitialInput
        )
      ).toBe("match");
      expect(
        classifyRecoveredTurnSignalState(
          { parts: keyedSignal("unused").parts },
          [keyedInitialInput, latestUserMessage],
          keyedInitialInput
        )
      ).toBe("match");
    });
  });

  test("starts a fresh turn for an equal-text retry with a different key", async () => {
    const result = await executeKeyedRecovery("B");

    expect(result.resultTurnId).not.toBe(result.recoveredTurnId);
  });

  test("reincorporates a keyed retry when the recovered turn has no initial input", async () => {
    let nowMs = 1;
    const kernel = createRuntimeKernel({
      backend: createMemoryBackend({ now: () => nowMs }),
    });
    const runner = {
      execute: () =>
        Promise.resolve({
          messages: [assistantText("Completed the keyed request.")],
          resolution: { reason: "done", type: "end_turn" as const },
        }),
      id: "fake",
      resume: () => Promise.reject(new Error("resume was not expected")),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel,
      now: () => nowMs,
      runLiveness: {
        executionOwnerId: "recovery-owner-empty-current-turn",
        leaseDurationMs: 60_000,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const completedTurn = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: keyedSignal("A"),
      threadId: thread.threadId,
    });

    const completedEvents = await collectEvents(completedTurn.events());
    const completedTurnId = extractTurnId(completedEvents);
    expect(completedTurn.status().phase).toBe("completed");

    const branch = await kernel.branch.get(thread.branchId);
    if (branch === null) {
      throw new Error("expected the branch after the completed turn");
    }
    const staleTurn = await kernel.turn.create(
      "turn_keyed_recovery_empty_current_turn",
      thread.threadId,
      thread.branchId,
      completedTurnId,
      branch.headTurnNodeHash
    );
    const staleRunId = "run_keyed_recovery_empty_current_turn";
    await kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-crashed-before-input",
      leaseExpiresAtMs: 10,
      runId: staleRunId,
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: branch.headTurnNodeHash,
      steps: [
        { deterministic: false, id: "incorporate_input", sideEffects: true },
      ],
      turnId: staleTurn.turnId,
    });
    await kernel.run.beginStep(staleRunId, "incorporate_input");

    nowMs = 11;
    const retry = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: keyedSignal("B"),
      threadId: thread.threadId,
    });
    await collectEvents(retry.events());

    expect(retry.status().phase).toBe("completed");
    expect(
      (await runtime.readBranchMessages({ branchId: thread.branchId })).messages
    ).toContainEqual({
      admissionKey: "B",
      parts: [{ text: KEYED_RECOVERY_TEXT, type: "text" }],
      role: "user",
    });
  });

  test("does not treat a first keyed steer as the recovered turn initial input", async () => {
    let nowMs = 1;
    const kernel = createRuntimeKernel({
      backend: createMemoryBackend({ now: () => nowMs }),
    });
    const runner = {
      execute: () =>
        Promise.resolve({
          messages: [assistantText("Completed the keyed request.")],
          resolution: { reason: "done", type: "end_turn" as const },
        }),
      id: "fake",
      resume: () => Promise.reject(new Error("resume was not expected")),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel,
      now: () => nowMs,
      runLiveness: {
        executionOwnerId: "recovery-owner-steer-first-current-turn",
        leaseDurationMs: 60_000,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const completedTurn = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: { parts: keyedSignal("unused").parts },
      threadId: thread.threadId,
    });
    const completedEvents = await collectEvents(completedTurn.events());
    expect(completedTurn.status().phase).toBe("completed");

    const branch = await kernel.branch.get(thread.branchId);
    if (branch === null) {
      throw new Error("expected the branch after the completed turn");
    }
    const staleTurn = await kernel.turn.create(
      "turn_keyed_recovery_steer_first_current_turn",
      thread.threadId,
      thread.branchId,
      extractTurnId(completedEvents),
      branch.headTurnNodeHash
    );
    const steeringCheckpoint = await checkpointUserMessage(kernel, {
      activeTurnId: staleTurn.turnId,
      branchId: thread.branchId,
      message: keyedUserMessage("A"),
      runId: "run_keyed_recovery_steer_first_steering",
      startTurnNodeHash: branch.headTurnNodeHash,
      stepId: "incorporate_steering",
      taskId: "steering_message",
      turnId: staleTurn.turnId,
    });
    const staleRunId = "run_keyed_recovery_steer_first";
    await kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-crashed-after-first-steer",
      leaseExpiresAtMs: 10,
      runId: staleRunId,
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: steeringCheckpoint,
      steps: [
        { deterministic: false, id: "incorporate_input", sideEffects: true },
      ],
      turnId: staleTurn.turnId,
    });
    await kernel.run.beginStep(staleRunId, "incorporate_input");

    nowMs = 11;
    const retry = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: keyedSignal("A"),
      threadId: thread.threadId,
    });
    await collectEvents(retry.events());

    expect(retry.status().phase).toBe("completed");
    const keyedUserMessages = (
      await runtime.readBranchMessages({ branchId: thread.branchId })
    ).messages.filter(
      (message): message is Extract<TuvrenMessage, { role: "user" }> =>
        "role" in message &&
        message.role === "user" &&
        "admissionKey" in message &&
        message.admissionKey === "A"
    );
    expect(keyedUserMessages).toHaveLength(2);
  });

  test("finds the original keyed input across an empty preemption checkpoint and later steering", async () => {
    const result = await executeKeyedRecoveryAfterEmptyInputPreemption();

    expect(result.resultTurnId).not.toBe(result.recoveredTurnId);
    expect(
      result.recoveredUsers.map((message) => message.admissionKey)
    ).toContain("A");
    expect(
      result.recoveredUsers.map((message) => message.admissionKey)
    ).toContain("C");
    expect(result.freshUsers.map((message) => message.admissionKey)).toContain(
      "B"
    );
  });

  test("resumes the recovered turn for a retry with its initial input key", async () => {
    const result = await executeKeyedRecovery("A");

    expect(result.resultTurnId).toBe(result.recoveredTurnId);
  });

  test("starts a fresh turn when the retry uses a later steering key", async () => {
    const result = await executeKeyedRecovery("C");

    expect(result.resultTurnId).not.toBe(result.recoveredTurnId);
  });

  test("resumes the durable turn when key-reordered nested JSON signal data matches", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const runner = {
      execute: (context) => {
        expect(
          context.messages.filter((message) => message.role === "user").length
        ).toBe(1);

        return Promise.resolve({
          messages: [assistantText("Resumed the nested JSON request.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        });
      },
      id: "fake",
      resume: () => Promise.reject(new Error("resume was not expected")),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: livenessHarness.kernel,
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      "turn_stale_nested_signal_recovery",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_stale_nested_signal_recovery",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [
        { deterministic: false, id: "incorporate_input", sideEffects: true },
      ],
      turnId: staleTurn.turnId,
    });
    await livenessHarness.kernel.staging.stage(
      "run_stale_nested_signal_recovery",
      encodeDeterministicKernelRecord({
        parts: [
          { text: RESUME_TEXT, type: "text" },
          {
            data: nestedResumeData(),
            name: "resume-context",
            providerMetadata: { attempt: 1, source: "test" },
            type: "structured",
          },
        ],
        role: "user",
      }),
      "stale_nested_user_message",
      "message",
      "completed"
    );

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: resumeSignal(keyReorderedResumeData()),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(extractTurnId(events)).toBe(staleTurn.turnId);
  });
});
