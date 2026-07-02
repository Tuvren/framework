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

/**
 * KRT-BG004 — No-retry-on-authority-loss + client-result-as-proposal (ADR-052).
 *
 * Acceptance criteria (Gherkin):
 *   Given a worker loses its run lease while a nonRetryable invocation is in flight
 *   When recovery proceeds
 *   Then the in-flight nonRetryable invocation is not retried under the dead owner
 *   And a client-reported result arriving under a stale fencing token is rejected
 *   and does not mutate committed history
 *
 * These tests drive a real leased runtime whose lease renewal fails (simulating
 * preemption by a peer worker), proving that the dead owner neither re-runs the
 * in-flight invocation nor commits its late completion. The client side is
 * covered by the run-authority gate on the synthetic Tuvren-client tool: a
 * client-reported result returning after the run lost write authority is
 * rejected as a stale proposal rather than surfaced as a committed success.
 * A companion integration test drives a real client dispatch through a leased
 * runtime whose lease is lost mid-dispatch and asserts the rejected proposal
 * never mutates committed history (the commit-under-valid-authority staging
 * gate refuses to stage a result produced after authority loss).
 *
 * The end-to-end two-worker clock-skew proof (a peer recovers and the side
 * effect still occurs at most once via the idempotency identity) is owned by
 * KRT-BG005 conformance; these tests prove the local dead-owner invariants the
 * framework is responsible for.
 */

import { describe, expect, test } from "bun:test";
import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import type { RuntimeDriver } from "@tuvren/core/driver";
import { CAPABILITY_RESULT_STALE } from "@tuvren/core/errors";
import type { ToolResultPart } from "@tuvren/core/messages";
import type {
  ToolExecutionContext,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createClientEndpointBoundary } from "../src/lib/client-endpoint-boundary.ts";
import { buildClientEndpointTools } from "../src/lib/tool-registry.ts";
import {
  createFakeKernelHarness,
  createFakeRunLivenessKernelHarness,
} from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  extractToolMessages,
  textSignal,
  waitForAbort,
} from "./runtime-core-test-helpers.ts";

// ---------------------------------------------------------------------------
// Shared helpers — a driver that issues exactly one tool call, then ends.
// ---------------------------------------------------------------------------

function makeDriver(toolName: string): RuntimeDriver {
  return {
    id: "bg004-driver",
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            assistantToolCalls([
              { callId: "call-bg004", input: {}, name: toolName },
            ]),
          ],
          resolution: { type: "continue_iteration" },
          toolExecutionMode: "parallel",
        };
      }
      return {
        messages: [assistantText("done")],
        resolution: { reason: "done", type: "end_turn" },
      };
    },
    async resume() {
      throw new Error("resume not expected");
    },
  };
}

/**
 * Run a single in-flight tool under a leased runtime whose lease renewal always
 * throws, so the lease loop loses authority and aborts the handle while the tool
 * is still executing (it waits on the abort signal before returning).
 */
async function runWithLeaseLoss(
  tool: TuvrenToolDefinition,
  toolStarted: Promise<void>
) {
  const harness = createFakeKernelHarness();
  const livenessHarness = createFakeRunLivenessKernelHarness(harness, {
    onRenewLease: async () => {
      throw new Error("lease preempted by a peer worker");
    },
  });
  const runtime = createTuvrenRuntime({
    defaultDriverId: "bg004-driver",
    driverRegistry: createBaseDriverRegistry([makeDriver(tool.name)]),
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
    config: { name: "primary", tools: [tool] },
    signal: textSignal("bg004 lease-loss"),
    threadId: thread.threadId,
  });

  // Failure on lost authority surfaces as a rejected event stream; swallow it so
  // the assertions can inspect durable state.
  const eventsPromise = collectEvents(handle.events()).catch(() => undefined);
  await toolStarted;
  await eventsPromise;

  return { branchId: thread.branchId, harness };
}

function committedToolOutputValue(
  messages: Awaited<ReturnType<FakeReadBranchMessages>>,
  value: unknown
): boolean {
  return extractToolMessages(messages).some((m) =>
    m.parts.some(
      (p) =>
        typeof p.output === "object" &&
        p.output !== null &&
        "value" in (p.output as Record<string, unknown>) &&
        (p.output as Record<string, unknown>).value === value
    )
  );
}
type FakeReadBranchMessages = ReturnType<
  typeof createFakeKernelHarness
>["readBranchMessages"];

/** True when any committed tool message carries a client success ({committed:true}). */
function committedClientSuccess(
  messages: Awaited<ReturnType<FakeReadBranchMessages>>
): boolean {
  return extractToolMessages(messages).some((m) =>
    m.parts.some(
      (p) =>
        typeof p.output === "object" &&
        p.output !== null &&
        (p.output as Record<string, unknown>).committed === true
    )
  );
}

/**
 * Drive a real client-endpoint dispatch through a leased runtime whose lease is
 * lost while the dispatch is in flight. The endpoint holds its reported result
 * open until the lease loop aborts the run handle (released on the next
 * macrotask after the abort), so the result returns into an already-dead-owner
 * context and exercises the full tool-execution + staging path — not just the
 * gate in isolation.
 */
async function runClientDispatchWithLeaseLoss(
  capabilityId: string,
  onDispatch: () => void
) {
  const harness = createFakeKernelHarness();
  let releaseDispatch: (() => void) | undefined;
  const dispatchHeld = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });

  const endpoint: AttachedClientEndpoint = {
    advertisedCapabilities: [
      {
        capabilityId,
        description: "side-effecting client capability",
        inputSchema: { type: "object" },
      },
    ],
    endpointId: "bg004-endpoint",
    async dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      onDispatch();
      // Hold the in-flight dispatch open until the run loses its lease, so the
      // reported result returns into an already-aborted (dead-owner) context.
      await dispatchHeld;
      return {
        callId: envelope.callId,
        content: { committed: true },
        leaseToken: envelope.leaseToken,
      };
    },
  };

  const livenessHarness = createFakeRunLivenessKernelHarness(harness, {
    onRenewLease: async () => {
      // Release the held dispatch on a macrotask so it resolves into an aborted
      // context and the run-authority gate fires. This is ordered, not raced: the
      // event loop drains all microtasks before any macrotask, and this rejection
      // propagates synchronously through the lease loop's catch into
      // handle.abortWithError (a microtask chain), so the abort always lands
      // first. If that abort is ever deferred behind a macrotask/await boundary,
      // replace this with an explicit await-on-abort handshake.
      setTimeout(() => releaseDispatch?.(), 0);
      throw new Error("lease preempted by a peer worker");
    },
  });
  const runtime = createTuvrenRuntime({
    defaultDriverId: "bg004-driver",
    driverRegistry: createBaseDriverRegistry([makeDriver(capabilityId)]),
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
    config: { clientEndpoints: [endpoint], name: "primary" },
    signal: textSignal("bg004 client lease-loss"),
    threadId: thread.threadId,
  });

  await collectEvents(handle.events()).catch(() => undefined);

  return { branchId: thread.branchId, harness };
}

// ---------------------------------------------------------------------------
// No retry / no commit under the dead owner
// ---------------------------------------------------------------------------

describe("KRT-BG004 — no retry under lost run authority", () => {
  test("an in-flight nonRetryable invocation is not retried and its late completion is not committed when the lease is lost", async () => {
    const LATE_VALUE = "nonretryable-late-after-lease-loss";
    let callCount = 0;
    let releaseStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });

    const tool: TuvrenToolDefinition = {
      name: "bg004-nonretryable",
      description: "nonRetryable side-effecting tool",
      nonRetryable: true,
      inputSchema: { type: "object" },
      async execute(_input, context) {
        callCount += 1;
        releaseStarted?.();
        await waitForAbort(context.signal);
        return { value: LATE_VALUE };
      },
    };

    const { branchId, harness } = await runWithLeaseLoss(tool, toolStarted);

    // Dead owner ran the call exactly once — never re-dispatched under the lost
    // lease.
    expect(callCount).toBe(1);

    const messages = await harness.readBranchMessages(branchId);
    expect(committedToolOutputValue(messages, LATE_VALUE)).toBe(false);
  });

  test("an in-flight idempotent invocation is not retried once run authority is lost", async () => {
    let callCount = 0;
    let releaseStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });

    const tool: TuvrenToolDefinition = {
      name: "bg004-idempotent",
      description: "idempotent tool with a generous retry budget",
      idempotent: true,
      maxRetries: 2,
      inputSchema: { type: "object" },
      async execute(_input, context) {
        callCount += 1;
        releaseStarted?.();
        await waitForAbort(context.signal);
        // A retriable failure that WOULD consume the retry budget — but the
        // abort-break must abandon retries the moment authority is lost.
        throw new Error("failure surfaced under the dead owner");
      },
    };

    await runWithLeaseLoss(tool, toolStarted);

    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Client-result-as-proposal
// ---------------------------------------------------------------------------

function makeRecordingEndpoint(
  capabilityId: string,
  onDispatch: () => void
): AttachedClientEndpoint {
  return {
    endpointId: "bg004-endpoint",
    advertisedCapabilities: [
      {
        capabilityId,
        description: "side-effecting client capability",
        inputSchema: { type: "object" },
      },
    ],
    async dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      onDispatch();
      return {
        callId: envelope.callId,
        content: { committed: true },
        leaseToken: envelope.leaseToken,
      };
    },
  };
}

function makeContext(
  callId: string,
  signal: AbortSignal | undefined
): ToolExecutionContext {
  return {
    callId,
    name: "cap.side-effect",
    signal,
  };
}

describe("KRT-BG004 — client-result-as-proposal", () => {
  const capabilityId = "cap.side-effect";

  test("a client result returning after the run lost write authority is rejected as a stale proposal", async () => {
    let dispatchCount = 0;
    const endpoint = makeRecordingEndpoint(capabilityId, () => {
      dispatchCount += 1;
    });
    const boundary = createClientEndpointBoundary([endpoint]);
    const tool = buildClientEndpointTools([endpoint], boundary)[0];

    const result = (await tool.execute(
      {},
      makeContext("call-proposal", AbortSignal.abort())
    )) as ToolResultPart;

    // The side effect may have fired on the client — but the reported result is
    // a proposal that must not become committed history under the dead owner.
    expect(dispatchCount).toBe(1);
    expect(result.isError).toBe(true);
    expect((result.output as Record<string, unknown>).code).toBe(
      CAPABILITY_RESULT_STALE
    );
    // The run-authority rejection is distinguishable from a per-dispatch token
    // mismatch (which shares CAPABILITY_RESULT_STALE) by the reason field.
    expect((result.output as Record<string, unknown>).reason).toBe(
      "run_authority_lost"
    );
  });

  test("a client-reported result returning after lease loss does not mutate committed history", async () => {
    let dispatchCount = 0;
    const { branchId, harness } = await runClientDispatchWithLeaseLoss(
      capabilityId,
      () => {
        dispatchCount += 1;
      }
    );

    // The client dispatch fired its side effect exactly once...
    expect(dispatchCount).toBe(1);
    // ...but the reported result is a proposal: under the dead owner it is never
    // committed to durable history, so nothing in the branch carries the
    // client's {committed:true} success.
    const messages = await harness.readBranchMessages(branchId);
    expect(committedClientSuccess(messages)).toBe(false);
  });

  test("a client result under valid run write authority is surfaced as a committed success", async () => {
    let dispatchCount = 0;
    const endpoint = makeRecordingEndpoint(capabilityId, () => {
      dispatchCount += 1;
    });
    const boundary = createClientEndpointBoundary([endpoint]);
    const tool = buildClientEndpointTools([endpoint], boundary)[0];

    const result = (await tool.execute(
      {},
      makeContext("call-proposal", undefined)
    )) as ToolResultPart;

    expect(dispatchCount).toBe(1);
    expect(result.isError).toBe(false);
    expect((result.output as Record<string, unknown>).committed).toBe(true);
  });
});
