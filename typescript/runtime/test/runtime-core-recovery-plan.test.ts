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

import { DEFAULT_SCOPE, TuvrenRecoveryError } from "@tuvren/core";
import type { KernelRecord } from "@tuvren/core";
import { ENVELOPE_MAGIC, IDENTITY_PAYLOAD_CODEC } from "@tuvren/core/lifecycle";
import type { PayloadCodec } from "@tuvren/core/lifecycle";
import type { TuvrenMessage } from "@tuvren/core/messages";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import type { RecoveryState, StagedResult } from "@tuvren/kernel-protocol";

import { createEmptyContextManifest } from "../src/lib/context-manifest.ts";
import { encryptMessageRecord } from "../src/lib/payload-codec-seam.ts";
import type { HeadState } from "../src/lib/runtime-core-loop.ts";
import { deriveInterruptedIterationRecoveryPlan } from "../src/lib/runtime-core-recovery-plan.ts";
import type { InterruptedIterationRecoveryPlan } from "../src/lib/runtime-core-recovery-plan.ts";
import {
  createFakeKernelHarness,
  createFakeRunLivenessKernelHarness,
} from "./fake-kernel.ts";
import {
  assistantToolCalls,
  toOptionalRecord,
} from "./runtime-core-test-helpers.ts";

const TURN_ID = "turn_interrupted_iteration";
const STALE_RUN_ID = "run_interrupted_iteration";
const TOOL_CALLS = requireAssistantMessage(
  assistantToolCalls([
    { callId: "call_one", input: { value: 1 }, name: "lookup" },
    { callId: "call_two", input: { value: 2 }, name: "lookup" },
    { callId: "call_three", input: { value: 3 }, name: "lookup" },
  ])
);

describe("interrupted iteration recovery plan", () => {
  test("derives missing calls from a committed assistant and partial committed results", async () => {
    const fixture = await createFixture();
    const stagedResults = await stageMessages(fixture, [
      TOOL_CALLS,
      toolResult("call_one", 1),
      toolResult("call_two", 2),
    ]);
    await fixture.kernel.run.completeStep(STALE_RUN_ID, "iterate");
    const headState = await fixture.loadHeadState();

    const plan = await derivePlan(fixture, headState, {
      consumedStagedResults: stagedResults,
      lastCompletedStepId: null,
      lastTurnNodeHash: headState.branchHeadHash,
      stepSequence: iterateSteps(),
      uncommittedStagedResults: [],
    });

    expectPlan(
      plan,
      "resume_tool_batch",
      ["call_one", "call_two"],
      ["call_three"]
    );
    expect(plan.assistantMessage).toEqual(TOOL_CALLS);
  });

  test("decodes staged-but-uncommitted results through the configured payload codec and ignores task id spelling", async () => {
    const codec = createEnvelopeCodec();
    const fixture = await createFixture(codec);
    const assistant = await stageMessage(
      fixture,
      TOOL_CALLS,
      "assistant_message_for_interrupted_iteration"
    );
    const completed = await stageMessage(
      fixture,
      toolResult("call_two", 2),
      "tool_message_000001_unrelated_task_suffix"
    );
    const recoveryState = await fixture.kernel.run.recover(STALE_RUN_ID);
    const headState = await fixture.loadHeadState();

    const plan = await derivePlan(fixture, headState, {
      ...recoveryState,
      uncommittedStagedResults: [assistant, completed],
    });

    expectPlan(
      plan,
      "resume_tool_batch",
      ["call_two"],
      ["call_one", "call_three"]
    );
  });

  test("preserves model re-inference when no durable assistant message exists", async () => {
    const fixture = await createFixture();
    const headState = await fixture.loadHeadState();

    const plan = await derivePlan(fixture, headState, {
      consumedStagedResults: [],
      lastCompletedStepId: null,
      lastTurnNodeHash: headState.branchHeadHash,
      stepSequence: iterateSteps(),
      uncommittedStagedResults: [],
    });

    expectPlan(plan, "re_infer", [], []);
    expect(plan.assistantMessage).toBeUndefined();
  });

  test("does not dispatch tool calls from an interrupted staged message", async () => {
    const fixture = await createFixture();
    const [assistant] = await stageMessages(fixture, [TOOL_CALLS]);
    const headState = await fixture.loadHeadState();

    if (assistant === undefined) {
      throw new Error("expected staged assistant message");
    }

    const plan = await derivePlan(fixture, headState, {
      consumedStagedResults: [],
      lastCompletedStepId: null,
      lastTurnNodeHash: headState.branchHeadHash,
      stepSequence: iterateSteps(),
      uncommittedStagedResults: [
        {
          ...assistant,
          interruptPayload: null,
          status: "interrupted",
        },
      ],
    });

    expectPlan(plan, "re_infer", [], []);
    expect(plan.assistantMessage).toBeUndefined();
  });

  test("re-infers after an empty expired run even when the prior checkpoint completed a tool batch", async () => {
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    const thread = await livenessHarness.kernel.thread.create(
      "thread_empty_expired_iteration",
      "tuvren.agent.v1",
      "branch_empty_expired_iteration"
    );
    await livenessHarness.kernel.turn.create(
      TURN_ID,
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.run.create(
      "run_prior_completed_tool_batch",
      TURN_ID,
      thread.branchId,
      "tuvren.agent.v1",
      thread.rootTurnNodeHash,
      iterateSteps()
    );

    for (const [index, message] of [
      TOOL_CALLS,
      toolResult("call_one", 1),
      toolResult("call_two", 2),
      toolResult("call_three", 3),
    ].entries()) {
      await livenessHarness.kernel.staging.stage(
        "run_prior_completed_tool_batch",
        encodeDeterministicKernelRecord(message as unknown as KernelRecord),
        `prior_batch_${index.toString()}`,
        "message",
        "completed"
      );
    }

    const completedBatch = await livenessHarness.kernel.run.completeStep(
      "run_prior_completed_tool_batch",
      "iterate"
    );
    await livenessHarness.kernel.run.complete(
      "run_prior_completed_tool_batch",
      "completed"
    );

    if (completedBatch.turnNodeHash === undefined) {
      throw new Error("expected completed tool batch checkpoint");
    }

    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-that-crashed",
      leaseExpiresAtMs: 20,
      runId: STALE_RUN_ID,
      schemaId: "tuvren.agent.v1",
      startTurnNodeHash: completedBatch.turnNodeHash,
      steps: iterateSteps(),
      turnId: TURN_ID,
    });
    await livenessHarness.kernel.run.beginStep(STALE_RUN_ID, "iterate");

    const recoveryState =
      await livenessHarness.kernel.runLiveness.preemptExpired(
        STALE_RUN_ID,
        "replacement-worker",
        25,
        "stale_running_recovery"
      );
    const branch = await livenessHarness.kernel.branch.get(thread.branchId);

    if (branch === null) {
      throw new Error("expected recovery fixture branch");
    }

    const turnNode = await livenessHarness.kernel.node.get(
      branch.headTurnNodeHash
    );

    if (turnNode === null) {
      throw new Error("expected recovery fixture turn node");
    }

    expect(branch.headTurnNodeHash).not.toBe(completedBatch.turnNodeHash);
    expect(recoveryState.consumedStagedResults).toEqual([]);

    const manifest = await harness.readBranchManifest(thread.branchId);
    const messageHashes = Array.isArray(manifest.messages)
      ? manifest.messages
      : [];
    const fixture: Fixture = {
      codec: IDENTITY_PAYLOAD_CODEC,
      kernel: livenessHarness.kernel,
      async loadHeadState() {
        return {
          branchHeadHash: branch.headTurnNodeHash,
          manifest: createEmptyContextManifest(),
          messageHashes,
          messages: (await harness.readBranchMessages(thread.branchId)).filter(
            isMessage
          ),
          turnNode,
        };
      },
    };
    const headState = await fixture.loadHeadState();
    const plan = await derivePlan(fixture, headState, recoveryState);

    expectPlan(plan, "re_infer", [], []);
    expect(plan.assistantMessage).toBeUndefined();
  });

  test("recognizes a completed durable tool batch", async () => {
    const fixture = await createFixture();
    const stagedResults = await stageMessages(fixture, [
      TOOL_CALLS,
      toolResult("call_one", 1),
      toolResult("call_two", 2),
      toolResult("call_three", 3),
    ]);
    await fixture.kernel.run.completeStep(STALE_RUN_ID, "iterate");
    const headState = await fixture.loadHeadState();

    const plan = await derivePlan(fixture, headState, {
      consumedStagedResults: stagedResults,
      lastCompletedStepId: null,
      lastTurnNodeHash: headState.branchHeadHash,
      stepSequence: iterateSteps(),
      uncommittedStagedResults: [],
    });

    expectPlan(
      plan,
      "completed_tool_batch",
      ["call_one", "call_two", "call_three"],
      []
    );
  });

  test("fails explicitly when the interrupted assistant payload was erased", async () => {
    const codec = createEnvelopeCodec(true);
    const fixture = await createFixture(codec);
    const assistant = await stageMessage(
      fixture,
      TOOL_CALLS,
      "assistant_message_for_interrupted_iteration"
    );
    const headState = await fixture.loadHeadState();

    try {
      await derivePlan(fixture, headState, {
        consumedStagedResults: [],
        lastCompletedStepId: null,
        lastTurnNodeHash: headState.branchHeadHash,
        stepSequence: iterateSteps(),
        uncommittedStagedResults: [assistant],
      });
      throw new Error("expected interrupted recovery to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(TuvrenRecoveryError);
      expect(error).toMatchObject({
        code: "runtime_recovery_interrupted_iteration_unreadable",
      });
      const details =
        error instanceof TuvrenRecoveryError
          ? toOptionalRecord(error.details)
          : undefined;
      expect(details?.turnId).toBe(TURN_ID);
      expect(details?.staleRunId).toBe(STALE_RUN_ID);
    }
  });
});

interface Fixture {
  codec: PayloadCodec;
  kernel: ReturnType<typeof createFakeKernelHarness>["kernel"];
  loadHeadState(): Promise<HeadState>;
}

async function createFixture(
  codec: PayloadCodec = IDENTITY_PAYLOAD_CODEC
): Promise<Fixture> {
  const harness = createFakeKernelHarness();
  const thread = await harness.kernel.thread.create(
    "thread_interrupted_iteration",
    "tuvren.agent.v1",
    "branch_interrupted_iteration"
  );
  await harness.kernel.turn.create(
    TURN_ID,
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );
  await harness.kernel.run.create(
    STALE_RUN_ID,
    TURN_ID,
    thread.branchId,
    "tuvren.agent.v1",
    thread.rootTurnNodeHash,
    iterateSteps()
  );

  return {
    codec,
    kernel: harness.kernel,
    async loadHeadState() {
      const branch = await harness.kernel.branch.get(thread.branchId);

      if (branch === null) {
        throw new Error("expected recovery fixture branch");
      }

      const turnNode = await harness.kernel.node.get(branch.headTurnNodeHash);

      if (turnNode === null) {
        throw new Error("expected recovery fixture turn node");
      }

      const manifest = await harness.readBranchManifest(thread.branchId);
      const messageHashes = Array.isArray(manifest.messages)
        ? manifest.messages
        : [];
      const messages = await harness.readBranchMessages(thread.branchId);

      return {
        branchHeadHash: branch.headTurnNodeHash,
        manifest: createEmptyContextManifest(),
        messageHashes,
        messages: messages.filter(isMessage),
        turnNode,
      };
    },
  };
}

async function stageMessages(
  fixture: Fixture,
  messages: TuvrenMessage[]
): Promise<StagedResult[]> {
  const results: StagedResult[] = [];

  for (const [index, message] of messages.entries()) {
    results.push(
      await stageMessage(fixture, message, `task_${index.toString()}`)
    );
  }

  return results;
}

async function stageMessage(
  fixture: Fixture,
  message: TuvrenMessage,
  taskId: string
): Promise<StagedResult> {
  const record = encodeDeterministicKernelRecord(
    message as unknown as KernelRecord
  );
  const encrypted = await encryptMessageRecord(
    { codec: fixture.codec, scope: DEFAULT_SCOPE },
    record
  );
  const staged = await fixture.kernel.staging.stage(
    STALE_RUN_ID,
    encrypted,
    taskId,
    "message",
    "completed"
  );
  return staged.stagedResult;
}

async function derivePlan(
  fixture: Fixture,
  recoveredHeadState: HeadState,
  recoveryState: RecoveryState
): Promise<InterruptedIterationRecoveryPlan> {
  return await deriveInterruptedIterationRecoveryPlan({
    kernel: fixture.kernel,
    payloadCodecBinding: { codec: fixture.codec, scope: DEFAULT_SCOPE },
    recoveredHeadState,
    recoveryState,
    staleRunId: STALE_RUN_ID,
    turnId: TURN_ID,
  });
}

function expectPlan(
  plan: InterruptedIterationRecoveryPlan,
  disposition: InterruptedIterationRecoveryPlan["disposition"],
  completedCallIds: string[],
  missingCallIds: string[]
): void {
  expect(plan.disposition).toBe(disposition);
  expect(plan.completedCallIds).toEqual(completedCallIds);
  expect(plan.missingToolCalls.map((call) => call.callId)).toEqual(
    missingCallIds
  );
}

function toolResult(callId: string, value: number): TuvrenMessage {
  return {
    parts: [
      {
        callId,
        name: "lookup",
        output: { value },
        type: "tool_result",
      },
    ],
    role: "tool",
  };
}

function iterateSteps(): RecoveryState["stepSequence"] {
  return [{ deterministic: false, id: "iterate", sideEffects: true }];
}

function isMessage(value: unknown): value is TuvrenMessage {
  const record = toOptionalRecord(value);
  return (
    record?.role === "system" ||
    record?.role === "user" ||
    record?.role === "assistant" ||
    record?.role === "tool"
  );
}

function createEnvelopeCodec(erased = false): PayloadCodec {
  return {
    decrypt(stored) {
      if (erased) {
        return Promise.resolve({
          keyRef: "destroyed-test-key",
          reason: "test key erased",
          status: "erased" as const,
        });
      }

      return Promise.resolve({
        plaintext: stored.slice(ENVELOPE_MAGIC.length),
        status: "available" as const,
      });
    },
    encrypt(plaintext) {
      const envelope = new Uint8Array(ENVELOPE_MAGIC.length + plaintext.length);
      envelope.set(ENVELOPE_MAGIC);
      envelope.set(plaintext, ENVELOPE_MAGIC.length);
      return Promise.resolve(envelope);
    },
    id: erased ? "test-erased-envelope" : "test-envelope",
  };
}

function requireAssistantMessage(
  message: TuvrenMessage
): Extract<TuvrenMessage, { role: "assistant" }> {
  if (message.role !== "assistant") {
    throw new Error("expected assistant message");
  }

  return message;
}
