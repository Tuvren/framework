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

import type { KernelRecord } from "@tuvren/core";
import type { InputSignal } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { RuntimeRunner } from "@tuvren/core/runner";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";

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
