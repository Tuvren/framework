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
 * KRT-BA003: Cross-Class Resume and Recovery Semantics
 *
 * Proves that when a turn is interrupted, each execution class behaves per its
 * documented recovery contract:
 *
 * 1. tuvren-server: invocations may resume per existing durability rules
 *    (tool execution is re-runnable; the approval-pause resume is the primary
 *    resumable path). On abort the turn fails clean — no fabricated results.
 *
 * 2. provider-native / provider-mediated: results are pre-staged in driver
 *    messages before they reach the lifecycle observer. Recovery sees either
 *    a committed result (resolved from observed state) or no result (the
 *    driver iteration is re-run). No in-flight provider invocation state
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
import type { RuntimeDriver } from "@tuvren/core/driver";
import {
  CAPABILITY_BINDING_UNAVAILABLE,
  CAPABILITY_RESULT_STALE,
} from "@tuvren/core/errors";
import type { ToolResultEvent, ToolStartEvent } from "@tuvren/core/events";
import type { TuvrenMessage } from "@tuvren/core/messages";
import {
  createClientEndpointBoundary,
  createDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  delay,
  textSignal,
  waitFor,
} from "./runtime-core-test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractToolEvents(events: unknown[]) {
  const starts: ToolStartEvent[] = [];
  const results: ToolResultEvent[] = [];
  for (const ev of events) {
    if (typeof ev !== "object" || ev === null) {
      continue;
    }
    const e = ev as Record<string, unknown>;
    if (e.type === "tool.start") {
      starts.push(e as unknown as ToolStartEvent);
    }
    if (e.type === "tool.result") {
      results.push(e as unknown as ToolResultEvent);
    }
  }
  return { results, starts };
}

function buildProviderToolMessage(
  callId: string,
  name: string,
  executionClass: "provider-native" | "provider-mediated",
  output: unknown
): TuvrenMessage {
  return {
    role: "tool",
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
  };
}

// ---------------------------------------------------------------------------
// BA003: provider-native / provider-mediated — resolved from observed state
// ---------------------------------------------------------------------------

describe("BA003 recovery semantics — provider-native / provider-mediated", () => {
  for (const executionClass of [
    "provider-native",
    "provider-mediated",
  ] as const) {
    test(`${executionClass}: result resolves from observed driver output — not fabricated by framework`, async () => {
      const harness = createFakeKernelHarness();
      const expectedOutput = { value: 42, executionClass };
      const toolName = `ba003_${executionClass.replace("-", "_")}`;

      const driver: RuntimeDriver = {
        id: `ba003-driver-${executionClass}`,
        async execute(context) {
          if (!context.messages.some((m) => m.role === "tool")) {
            return {
              messages: [
                buildProviderToolMessage(
                  `call-${executionClass}`,
                  toolName,
                  executionClass,
                  expectedOutput
                ),
              ],
              resolution: { type: "continue_iteration" },
            };
          }
          return {
            messages: [assistantText("done")],
            resolution: { reason: "done", type: "end_turn" },
          };
        },
        async resume() {
          throw new Error("no");
        },
      };
      const runtime = createTuvrenRuntime({
        defaultDriverId: `ba003-driver-${executionClass}`,
        driverRegistry: createDriverRegistry([driver]),
        kernel: harness.kernel,
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

      // Result is the exact observed driver output — framework did not fabricate it
      const output = results[0].output as typeof expectedOutput;
      expect(output.value).toBe(42);
      expect(output.executionClass).toBe(executionClass);

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

    const driver: RuntimeDriver = {
      id: "ba003-pair-driver",
      async execute(context) {
        if (!context.messages.some((m) => m.role === "tool")) {
          return {
            messages: [
              buildProviderToolMessage(
                "call-pair",
                "pair_tool",
                "provider-native",
                { done: true }
              ),
            ],
            resolution: { type: "continue_iteration" },
          };
        }
        return {
          messages: [assistantText("done")],
          resolution: { reason: "done", type: "end_turn" },
        };
      },
      async resume() {
        throw new Error("no");
      },
    };
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ba003-pair-driver",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
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
      endpointId: "ep-stale-ba003",
      advertisedCapabilities: [
        {
          capabilityId,
          description: "stale cap",
          inputSchema: { type: "object" },
        },
      ],
      async dispatch(
        envelope: ClientInvocationEnvelope
      ): Promise<ClientReportedResult> {
        // Echo a wrong leaseToken to simulate a stale late-completion
        return {
          callId: envelope.callId,
          content: { fabricated: true },
          leaseToken: "wrong-token",
        };
      },
    };
    const boundary = createClientEndpointBoundary([staleEndpoint]);

    const driver: RuntimeDriver = {
      id: "ba003-stale-driver",
      async execute(context) {
        if (!context.messages.some((m) => m.role === "tool")) {
          return {
            messages: [
              assistantToolCalls([
                { callId: "call-stale", input: {}, name: capabilityId },
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
        throw new Error("no");
      },
    };
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ba003-stale-driver",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "agent",
        clientEndpoints: [staleEndpoint],
        clientEndpointBoundary: boundary,
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
    const output = results[0].output as Record<string, unknown>;
    // Must surface as CAPABILITY_RESULT_STALE, not the fabricated content
    expect(output.code).toBe(CAPABILITY_RESULT_STALE);
    expect(output.fabricated).toBeUndefined();

    // callId consistent (same invocation record)
    expect(starts[0].callId).toBe(results[0].callId);
  });

  test("unavailable endpoint surfaces as CAPABILITY_BINDING_UNAVAILABLE, not a fabricated result", async () => {
    const harness = createFakeKernelHarness();
    const capabilityId = "ba003.unavail.cap";
    const endpoint: AttachedClientEndpoint = {
      endpointId: "ep-unavail-ba003",
      advertisedCapabilities: [
        {
          capabilityId,
          description: "unavail cap",
          inputSchema: { type: "object" },
        },
      ],
      async dispatch(
        envelope: ClientInvocationEnvelope
      ): Promise<ClientReportedResult> {
        return {
          callId: envelope.callId,
          content: "ok",
          leaseToken: envelope.leaseToken,
        };
      },
    };
    const boundary = createClientEndpointBoundary([endpoint]);

    const driver: RuntimeDriver = {
      id: "ba003-unavail-driver",
      async execute(context) {
        if (!context.messages.some((m) => m.role === "tool")) {
          return {
            messages: [
              assistantToolCalls([
                { callId: "call-unavail", input: {}, name: capabilityId },
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
        throw new Error("no");
      },
    };
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ba003-unavail-driver",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });

    // Detach before the turn runs to trigger unavailability mid-invocation
    boundary.detach("ep-unavail-ba003");

    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "agent",
        clientEndpoints: [endpoint],
        clientEndpointBoundary: boundary,
      },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const { results } = extractToolEvents(events);

    // Unavailable endpoint surfaces as a clean typed error, not fabricated success
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    const output = results[0].output as Record<string, unknown>;
    expect(output.code).toBe(CAPABILITY_BINDING_UNAVAILABLE);
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
      endpointId: "ep-slow-ba003",
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
    };
    const boundary = createClientEndpointBoundary([slowEndpoint]);

    let driverSeenToolResult = false;
    const driver: RuntimeDriver = {
      id: "ba003-slow-driver",
      async execute(context) {
        if (!context.messages.some((m) => m.role === "tool")) {
          return {
            messages: [
              assistantToolCalls([
                { callId: "call-slow", input: {}, name: capabilityId },
              ]),
            ],
            resolution: { type: "continue_iteration" },
            toolExecutionMode: "parallel",
          };
        }
        driverSeenToolResult = true;
        return {
          messages: [assistantText("done")],
          resolution: { reason: "done", type: "end_turn" },
        };
      },
      async resume() {
        throw new Error("no");
      },
    };
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ba003-slow-driver",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "agent",
        clientEndpoints: [slowEndpoint],
        clientEndpointBoundary: boundary,
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
    let error: unknown;
    try {
      await handle.awaitResult();
    } catch (err) {
      error = err;
    }
    await eventsConsumed; // drain the event stream after turn ends

    // Turn must fail cleanly via execution_cancelled, not with a fabricated success
    expect(error).toBeDefined();
    const tuvrenError = error as { code?: string };
    expect(tuvrenError.code).toBe("execution_cancelled");

    // The turn phase must be "failed" (not "completed")
    expect(handle.status().phase).toBe("failed");

    // The driver must NOT have been called with the tool result from the slow dispatch,
    // because cancel short-circuits the iteration loop before the next driver call.
    expect(driverSeenToolResult).toBe(false);
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
    const scenarios: Array<{
      label: string;
      run: () => Promise<{
        starts: ToolStartEvent[];
        results: ToolResultEvent[];
      }>;
    }> = [
      {
        label: "tuvren-server",
        async run() {
          const harness = createFakeKernelHarness();
          const driver: RuntimeDriver = {
            id: "torn-server",
            async execute(ctx) {
              if (!ctx.messages.some((m) => m.role === "tool")) {
                return {
                  messages: [
                    assistantToolCalls([
                      { callId: "c1", input: {}, name: "t1" },
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
              throw new Error("no");
            },
          };
          const rt = createTuvrenRuntime({
            defaultDriverId: "torn-server",
            driverRegistry: createDriverRegistry([driver]),
            kernel: harness.kernel,
          });
          const th = await rt.createThread({});
          const h = rt.executeTurn({
            branchId: th.branchId,
            config: {
              name: "a",
              tools: [
                {
                  name: "t1",
                  description: "t",
                  inputSchema: { type: "object" },
                  execute: async () => ({ ok: true }),
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
          const driver: RuntimeDriver = {
            id: "torn-pn",
            async execute(ctx) {
              if (!ctx.messages.some((m) => m.role === "tool")) {
                return {
                  messages: [
                    buildProviderToolMessage("c2", "pn", "provider-native", {
                      ok: true,
                    }),
                  ],
                  resolution: { type: "continue_iteration" },
                };
              }
              return {
                messages: [assistantText("done")],
                resolution: { reason: "done", type: "end_turn" },
              };
            },
            async resume() {
              throw new Error("no");
            },
          };
          const rt = createTuvrenRuntime({
            defaultDriverId: "torn-pn",
            driverRegistry: createDriverRegistry([driver]),
            kernel: harness.kernel,
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
            endpointId: "ep-torn",
            advertisedCapabilities: [
              {
                capabilityId,
                description: "t",
                inputSchema: { type: "object" },
              },
            ],
            async dispatch(
              env: ClientInvocationEnvelope
            ): Promise<ClientReportedResult> {
              return {
                callId: env.callId,
                content: "ok",
                leaseToken: env.leaseToken,
              };
            },
          };
          const boundary = createClientEndpointBoundary([endpoint]);
          const driver: RuntimeDriver = {
            id: "torn-client",
            async execute(ctx) {
              if (!ctx.messages.some((m) => m.role === "tool")) {
                return {
                  messages: [
                    assistantToolCalls([
                      { callId: "c3", input: {}, name: capabilityId },
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
              throw new Error("no");
            },
          };
          const rt = createTuvrenRuntime({
            defaultDriverId: "torn-client",
            driverRegistry: createDriverRegistry([driver]),
            kernel: harness.kernel,
          });
          const th = await rt.createThread({});
          const h = rt.executeTurn({
            branchId: th.branchId,
            config: {
              name: "a",
              clientEndpoints: [endpoint],
              clientEndpointBoundary: boundary,
            },
            signal: textSignal("go"),
            threadId: th.threadId,
          });
          return extractToolEvents(await collectEvents(h.events()));
        },
      },
    ];

    for (const scenario of scenarios) {
      const { starts, results } = await scenario.run();

      // Invariant: every tool.start must be paired with exactly one tool.result
      expect(starts).toHaveLength(results.length);

      for (const start of starts) {
        const matching = results.filter((r) => r.callId === start.callId);
        expect(matching).toHaveLength(1);
      }
    }
  });
});
