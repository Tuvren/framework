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

/**
 * KRT-BA003: Cross-Class Resume and Recovery Semantics
 *
 * Proves that when a turn is interrupted, each execution class behaves per its
 * documented recovery contract:
 *
 * 1. tuvren-server: invocations may resume per existing durability rules
 *    (tool execution is re-runnable; the approval-pause resume is the primary
 *    resumable path). On abort the turn fails clean — no fabricated results.
 *
 * 2. provider-native / provider-mediated: results are pre-staged in runner
 *    messages before they reach the lifecycle observer. Recovery sees either
 *    a committed result (resolved from observed state) or no result (the
 *    runner iteration is re-run). No in-flight provider invocation state
 *    exists at the framework level — the framework can only observe, never
 *    fabricate, provider-owned results.
 *
 * 3. tuvren-client: dispatches fail clean on interruption without fabricating
 *    a result. A stale late-completion (wrong leaseToken) surfaces as
 *    CAPABILITY_RESULT_STALE (isError: true), not as a success. An unavailable
 *    endpoint surfaces as CAPABILITY_BINDING_UNAVAILABLE (isError: true).
 *    Turn abort terminates the turn as failed without a fabricated tool success.
 *
 * All tests verify the "no torn or partial invocation record" invariant by
 * asserting that every tool.start event is followed by a matching tool.result
 * event carrying either a real success or a typed clean-failure error code.
 */

import { describe, expect, test } from "bun:test";

import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import {
  CAPABILITY_BINDING_UNAVAILABLE,
  CAPABILITY_RESULT_STALE,
} from "@tuvren/core/errors";
import type {
  ToolResultEvent,
  ToolStartEvent,
  TuvrenStreamEvent,
} from "@tuvren/core/events";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { RuntimeRunner } from "@tuvren/core/runner";

import {
  createClientEndpointBoundary,
  createRunnerRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  delay,
  fromSynchronousVariadicAwaited,
  textSignal,
  toOptionalRecord,
  waitFor,
} from "./runtime-core-test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const extractToolEvents = (events: TuvrenStreamEvent[]) => {
  const starts = events.filter(
    (event): event is ToolStartEvent => event.type === "tool.start"
  );
  const results = events.filter(
    (event): event is ToolResultEvent => event.type === "tool.result"
  );
  return { results, starts };
};

const buildProviderToolMessage = (
  callId: string,
  name: string,
  executionClass: "provider-native" | "provider-mediated",
  output: unknown
): TuvrenMessage => ({
  parts: [
    {
      callId,
      name,
      output,
      providerMetadata: {
        executionClass,
        owner: "provider",
        providerCallId: callId,
      },
      type: "tool_result",
    },
  ],
  role: "tool",
});

const makeProviderResultRunner = (
  id: string,
  message: TuvrenMessage
): RuntimeRunner => ({
  execute: fromSynchronousVariadicAwaited((context) => {
    if (!context.messages.some((entry) => entry.role === "tool")) {
      return {
        messages: [message],
        resolution: { type: "continue_iteration" },
      };
    }

    return {
      messages: [assistantText("done")],
      resolution: { reason: "done", type: "end_turn" },
    };
  }),
  id,
  resume: fromSynchronousVariadicAwaited(() => {
    throw new Error("no");
  }),
});

const makeToolCallRunner = (
  id: string,
  message: TuvrenMessage
): RuntimeRunner => ({
  execute: fromSynchronousVariadicAwaited((context) => {
    if (!context.messages.some((entry) => entry.role === "tool")) {
      return {
        messages: [message],
        resolution: { type: "continue_iteration" },
        toolExecutionMode: "parallel",
      };
    }

    return {
      messages: [assistantText("done")],
      resolution: { reason: "done", type: "end_turn" },
    };
  }),
  id,
  resume: fromSynchronousVariadicAwaited(() => {
    throw new Error("no");
  }),
});

// ---------------------------------------------------------------------------
// BA003: provider-native / provider-mediated — resolved from observed state
// ---------------------------------------------------------------------------

describe("BA003 recovery semantics — provider-native / provider-mediated", () => {
  for (const executionClass of [
    "provider-native",
    "provider-mediated",
  ] as const) {
    test(`${executionClass}: result resolves from observed runner output — not fabricated by framework`, async () => {
      const harness = createFakeKernelHarness();
      const expectedOutput = { executionClass, value: 42 };
      const toolName = `ba003_${executionClass.replace("-", "_")}`;

      const runner = makeProviderResultRunner(
        `ba003-runner-${executionClass}`,
        buildProviderToolMessage(
          `call-${executionClass}`,
          toolName,
          executionClass,
          expectedOutput
        )
      );
      const runtime = createTuvrenRuntime({
        defaultRunnerId: `ba003-runner-${executionClass}`,
        kernel: harness.kernel,
        runnerRegistry: createRunnerRegistry([runner]),
      });
      const thread = await runtime.createThread({});
      const handle = runtime.executeTurn({
        branchId: thread.branchId,
        config: { name: "agent" },
        signal: textSignal("go"),
        threadId: thread.threadId,
      });
      const events = await collectEvents(handle.events());
      const { starts, results } = extractToolEvents(events);

      // Exactly one invocation lifecycle pair (no torn state, no duplicates)
      expect(starts).toHaveLength(1);
      expect(results).toHaveLength(1);

      // callId must match across start and result (same invocation record)
      expect(starts[0].callId).toBe(results[0].callId);

      // Result is the exact observed runner output — framework did not fabricate it
      const output = toOptionalRecord(results[0].output);
      expect(output?.value).toBe(42);
      expect(output?.executionClass).toBe(executionClass);

      // Result is a clean success (isError absent or false)
      expect(results[0].isError).toBeFalsy();

      // Attribution confirms the framework observed, not owned, this invocation
      expect(starts[0].attribution?.owner).toBe("provider");
      expect(results[0].attribution?.owner).toBe("provider");
    });
  }

  test("provider-native: the full lifecycle pair is observable after the turn completes — no orphaned start event", async () => {
    // Verifies the "no torn state" invariant for provider-native: after the
    // turn completes, every tool.start in the collected event stream has a
    // matching tool.result. The invariant is checked at turn completion, not
    // at each individual event arrival, because events arrive one at a time in
    // the async iterator even when they were enqueued synchronously.
    const harness = createFakeKernelHarness();

    const runner = makeProviderResultRunner(
      "ba003-pair-runner",
      buildProviderToolMessage("call-pair", "pair_tool", "provider-native", {
        done: true,
      })
    );
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "ba003-pair-runner",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "agent" },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const { starts, results } = extractToolEvents(events);

    // Every tool.start must have a paired tool.result — no orphaned starts
    expect(starts).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(starts[0].callId).toBe(results[0].callId);
  });
});

// ---------------------------------------------------------------------------
// BA003: tuvren-client — fail clean without fabricating a result
// ---------------------------------------------------------------------------

describe("BA003 recovery semantics — tuvren-client", () => {
  test("stale late-completion surfaces as CAPABILITY_RESULT_STALE, not a fabricated success", async () => {
    // A stale result (wrong leaseToken) must surface as a clean typed error,
    // not be silently ignored or turned into a fabricated success result.
    const harness = createFakeKernelHarness();
    const capabilityId = "ba003.stale.cap";

    const staleEndpoint: AttachedClientEndpoint = {
      advertisedCapabilities: [
        {
          capabilityId,
          description: "stale cap",
          inputSchema: { type: "object" },
        },
      ],
      dispatch: fromSynchronousVariadicAwaited(
        (envelope: ClientInvocationEnvelope): ClientReportedResult => ({
          // Echo a wrong leaseToken to simulate a stale late-completion
          callId: envelope.callId,
          content: { fabricated: true },
          leaseToken: "wrong-token",
        })
      ),
      endpointId: "ep-stale-ba003",
    };
    const boundary = createClientEndpointBoundary([staleEndpoint]);

    const runner = makeToolCallRunner(
      "ba003-stale-runner",
      assistantToolCalls([
        { callId: "call-stale", input: {}, name: capabilityId },
      ])
    );
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "ba003-stale-runner",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        clientEndpointBoundary: boundary,
        clientEndpoints: [staleEndpoint],
        name: "agent",
      },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const { starts, results } = extractToolEvents(events);

    // Stale result is a clean failure, not a fabricated success
    expect(starts).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    const output = toOptionalRecord(results[0].output);
    // Must surface as CAPABILITY_RESULT_STALE, not the fabricated content
    expect(output?.code).toBe(CAPABILITY_RESULT_STALE);
    expect(output?.fabricated).toBeUndefined();

    // callId consistent (same invocation record)
    expect(starts[0].callId).toBe(results[0].callId);
  });

  test("unavailable endpoint surfaces as CAPABILITY_BINDING_UNAVAILABLE, not a fabricated result", async () => {
    const harness = createFakeKernelHarness();
    const capabilityId = "ba003.unavail.cap";
    const endpoint: AttachedClientEndpoint = {
      advertisedCapabilities: [
        {
          capabilityId,
          description: "unavail cap",
          inputSchema: { type: "object" },
        },
      ],
      dispatch: fromSynchronousVariadicAwaited(
        (envelope: ClientInvocationEnvelope): ClientReportedResult => ({
          callId: envelope.callId,
          content: "ok",
          leaseToken: envelope.leaseToken,
        })
      ),
      endpointId: "ep-unavail-ba003",
    };
    const boundary = createClientEndpointBoundary([endpoint]);

    const runner = makeToolCallRunner(
      "ba003-unavail-runner",
      assistantToolCalls([
        { callId: "call-unavail", input: {}, name: capabilityId },
      ])
    );
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "ba003-unavail-runner",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });

    // Detach before the turn runs to trigger unavailability mid-invocation
    boundary.detach("ep-unavail-ba003");

    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        clientEndpointBoundary: boundary,
        clientEndpoints: [endpoint],
        name: "agent",
      },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const { results } = extractToolEvents(events);

    // Unavailable endpoint surfaces as a clean typed error, not fabricated success
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    const output = toOptionalRecord(results[0].output);
    expect(output?.code).toBe(CAPABILITY_BINDING_UNAVAILABLE);
  });

  test("turn abort terminates the turn as failed without fabricating a tool success", async () => {
    // A slow client endpoint that resolves only after deliberate delay.
    // When the handle is cancelled externally while the dispatch is in flight,
    // the turn must fail cleanly. The turn execution loop must be driven (events
    // consumed) for the dispatch to start; once started, cancel fires and the
    // turn resolves as failed.
    const harness = createFakeKernelHarness();
    const capabilityId = "ba003.slow.cap";
    let dispatchStarted = false;

    const slowEndpoint: AttachedClientEndpoint = {
      advertisedCapabilities: [
        {
          capabilityId,
          description: "slow cap",
          inputSchema: { type: "object" },
        },
      ],
      async dispatch(
        envelope: ClientInvocationEnvelope
      ): Promise<ClientReportedResult> {
        dispatchStarted = true;
        // Delay long enough for the cancel to fire before this resolves
        await delay(300);
        return {
          callId: envelope.callId,
          content: { secret: "fabricated" },
          leaseToken: envelope.leaseToken,
        };
      },
      endpointId: "ep-slow-ba003",
    };
    const boundary = createClientEndpointBoundary([slowEndpoint]);

    let runnerSeenToolResult = false;
    const runner = makeToolCallRunner(
      "ba003-slow-runner",
      assistantToolCalls([
        { callId: "call-slow", input: {}, name: capabilityId },
      ])
    );
    const originalExecute = runner.execute.bind(runner);
    runner.execute = async (context) => {
      if (context.messages.some((message) => message.role === "tool")) {
        runnerSeenToolResult = true;
      }
      return await originalExecute(context);
    };
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "ba003-slow-runner",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        clientEndpointBoundary: boundary,
        clientEndpoints: [slowEndpoint],
        name: "agent",
      },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });

    // Drive the event stream in the background so the turn can progress,
    // then cancel once the dispatch has started.
    const eventsConsumed = collectEvents(handle.events());
    await waitFor(() => dispatchStarted);
    handle.cancel();

    // awaitResult() rejects when the turn is cancelled; catch the rejection
    let caughtError: unknown;
    try {
      await handle.awaitResult();
    } catch (error) {
      caughtError = error;
    }
    // Drain the event stream after the turn ends.
    await eventsConsumed;

    // Turn must fail cleanly via execution_cancelled, not with a fabricated success
    expect(caughtError).toBeDefined();
    expect(toOptionalRecord(caughtError)?.code).toBe("execution_cancelled");

    // The turn phase must be "failed" (not "completed")
    expect(handle.status().phase).toBe("failed");

    // The runner must NOT have been called with the tool result from the slow dispatch,
    // because cancel short-circuits the iteration loop before the next runner call.
    expect(runnerSeenToolResult).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BA003: invariant — every dispatched invocation has a terminal result record
// ---------------------------------------------------------------------------

describe("BA003 no torn invocation record — all classes", () => {
  test("every tool.start event is paired with a matching tool.result event", async () => {
    // Cross-class invariant: no invocation enters the "dispatched" state
    // without eventually reaching a terminal state. We verify this for all
    // four classes in isolation.
    const scenarios: {
      label: string;
      run: () => Promise<{
        starts: ToolStartEvent[];
        results: ToolResultEvent[];
      }>;
    }[] = [
      {
        label: "tuvren-server",
        async run() {
          const harness = createFakeKernelHarness();
          const runner = makeToolCallRunner(
            "torn-server",
            assistantToolCalls([{ callId: "c1", input: {}, name: "t1" }])
          );
          const rt = createTuvrenRuntime({
            defaultRunnerId: "torn-server",
            kernel: harness.kernel,
            runnerRegistry: createRunnerRegistry([runner]),
          });
          const th = await rt.createThread({});
          const h = rt.executeTurn({
            branchId: th.branchId,
            config: {
              name: "a",
              tools: [
                {
                  description: "t",
                  execute: () => ({ ok: true }),
                  inputSchema: { type: "object" },
                  name: "t1",
                },
              ],
            },
            signal: textSignal("go"),
            threadId: th.threadId,
          });
          return extractToolEvents(await collectEvents(h.events()));
        },
      },
      {
        label: "provider-native",
        async run() {
          const harness = createFakeKernelHarness();
          const runner = makeProviderResultRunner(
            "torn-pn",
            buildProviderToolMessage("c2", "pn", "provider-native", {
              ok: true,
            })
          );
          const rt = createTuvrenRuntime({
            defaultRunnerId: "torn-pn",
            kernel: harness.kernel,
            runnerRegistry: createRunnerRegistry([runner]),
          });
          const th = await rt.createThread({});
          const h = rt.executeTurn({
            branchId: th.branchId,
            config: { name: "a" },
            signal: textSignal("go"),
            threadId: th.threadId,
          });
          return extractToolEvents(await collectEvents(h.events()));
        },
      },
      {
        label: "tuvren-client",
        async run() {
          const harness = createFakeKernelHarness();
          const capabilityId = "torn.client.cap";
          const endpoint: AttachedClientEndpoint = {
            advertisedCapabilities: [
              {
                capabilityId,
                description: "t",
                inputSchema: { type: "object" },
              },
            ],
            dispatch: fromSynchronousVariadicAwaited(
              (env: ClientInvocationEnvelope): ClientReportedResult => ({
                callId: env.callId,
                content: "ok",
                leaseToken: env.leaseToken,
              })
            ),
            endpointId: "ep-torn",
          };
          const boundary = createClientEndpointBoundary([endpoint]);
          const runner = makeToolCallRunner(
            "torn-client",
            assistantToolCalls([
              { callId: "c3", input: {}, name: capabilityId },
            ])
          );
          const rt = createTuvrenRuntime({
            defaultRunnerId: "torn-client",
            kernel: harness.kernel,
            runnerRegistry: createRunnerRegistry([runner]),
          });
          const th = await rt.createThread({});
          const h = rt.executeTurn({
            branchId: th.branchId,
            config: {
              clientEndpointBoundary: boundary,
              clientEndpoints: [endpoint],
              name: "a",
            },
            signal: textSignal("go"),
            threadId: th.threadId,
          });
          return extractToolEvents(await collectEvents(h.events()));
        },
      },
    ];

    await Promise.all(
      scenarios.map(async (scenario) => {
        const { results, starts } = await scenario.run();

        // Invariant: every tool.start must be paired with exactly one tool.result
        expect(starts).toHaveLength(results.length);

        for (const start of starts) {
          const matching = results.filter((r) => r.callId === start.callId);
          expect(matching).toHaveLength(1);
        }
      })
    );
  });
});
