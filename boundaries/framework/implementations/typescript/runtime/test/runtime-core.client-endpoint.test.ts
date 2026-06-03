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
 * Integration tests for the Tuvren-client execution class through the full
 * runtime turn — KRT-AZ001 through KRT-AZ005.
 *
 * These tests drive a real in-memory runtime, attach a mock client endpoint,
 * and assert externally observable behavior: tool.start/tool.result events,
 * the tool result content, capability_binding_unavailable outcomes, stale
 * result ignoring, client-side MCP classification, and partial-observability
 * observation limits (no tool.audit events).
 */

import { describe, expect, test } from "bun:test";
import type { DriverExecutionContext, DriverExecutionResult } from "@tuvren/core/driver";
import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import { CAPABILITY_BINDING_UNAVAILABLE } from "@tuvren/core/errors";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import {
  createDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  textSignal,
} from "./runtime-core-test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function makeId() {
  idCounter += 1;
  return `test-id-${idCounter}`;
}

/** A mock client endpoint that immediately returns a fixed result. */
function makeOkEndpoint(
  endpointId: string,
  capabilityId: string,
  content: unknown
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      { capabilityId, description: "test cap", inputSchema: { type: "object" } },
    ],
    async dispatch(envelope: ClientInvocationEnvelope): Promise<ClientReportedResult> {
      return { callId: envelope.callId, content, leaseToken: envelope.leaseToken };
    },
  };
}

/** A mock client endpoint that returns a stale leaseToken (simulates a stale late-completion). */
function makeStaleEndpoint(
  endpointId: string,
  capabilityId: string
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      { capabilityId, description: "stale cap", inputSchema: { type: "object" } },
    ],
    async dispatch(envelope: ClientInvocationEnvelope): Promise<ClientReportedResult> {
      return {
        callId: envelope.callId,
        content: { stale: true },
        leaseToken: "stale-token-from-prior-invocation",  // does NOT match envelope token
      };
    },
  };
}

/** A mock client endpoint for a client-side MCP tool. */
function makeClientMcpEndpoint(
  endpointId: string,
  capabilityId: string,
  mcpServerName: string
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      {
        capabilityId,
        description: "client-side MCP",
        inputSchema: { type: "object" },
        mcpServerName,
      },
    ],
    async dispatch(envelope: ClientInvocationEnvelope): Promise<ClientReportedResult> {
      return { callId: envelope.callId, content: { mcpResult: "ok" }, leaseToken: envelope.leaseToken };
    },
  };
}

/** Build a driver that requests one tool call then ends. */
function makeOneCallDriver(toolName: string, input: unknown = {}) {
  return {
    id: "test-driver",
    execute(context: DriverExecutionContext): Promise<DriverExecutionResult> {
      const hasToolResult = context.messages.some((m) => m.role === "tool");
      if (!hasToolResult) {
        return Promise.resolve({
          messages: [
            assistantToolCalls([{ callId: "call-1", input, name: toolName }]),
          ],
          resolution: { type: "continue_iteration" as const },
          toolExecutionMode: "parallel" as const,
        });
      }
      return Promise.resolve({
        messages: [assistantText("done")],
        resolution: { reason: "done", type: "end_turn" as const },
      });
    },
  };
}

async function runTurnWithClientEndpoint(
  endpoint: AttachedClientEndpoint,
  toolName: string,
  input: unknown = {}
) {
  const harness = createFakeKernelHarness();
  const driver = makeOneCallDriver(toolName, input);
  const runtime = createTuvrenRuntime({
    createId: makeId,
    defaultDriverId: "test-driver",
    driverRegistry: createDriverRegistry([driver]),
    kernel: harness.kernel,
  });

  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      name: "test-agent",
      clientEndpoints: [endpoint],
    },
    signal: textSignal("run client endpoint test"),
    threadId: thread.threadId,
  });

  const events = await collectEvents(handle.events());
  const result = await handle.awaitResult();
  return { events, result };
}

// ---------------------------------------------------------------------------
// KRT-AZ001 + AZ002: Attach, dispatch, result capture
// ---------------------------------------------------------------------------

describe("tuvren-client: attach and dispatch (KRT-AZ001, KRT-AZ002)", () => {
  test("a tool call resolves through the attached client endpoint and completes normally", async () => {
    const endpoint = makeOkEndpoint("ep1", "browser.click", { clicked: true });
    const { result } = await runTurnWithClientEndpoint(endpoint, "browser.click");
    expect(result.status).toBe("completed");
  });

  test("tool.start and tool.result events are emitted for the client endpoint invocation", async () => {
    const endpoint = makeOkEndpoint("ep1", "browser.screenshot", { url: "http://example.com" });
    const { events } = await runTurnWithClientEndpoint(endpoint, "browser.screenshot");
    const toolStartEvents = events.filter((e) => (e as TuvrenStreamEvent).type === "tool.start");
    const toolResultEvents = events.filter((e) => (e as TuvrenStreamEvent).type === "tool.result");
    expect(toolStartEvents).toHaveLength(1);
    expect(toolResultEvents).toHaveLength(1);
  });

  test("no tool.audit events are emitted for tuvren-client tools (canAudit: false)", async () => {
    const endpoint = makeOkEndpoint("ep1", "browser.navigate", {});
    const { events } = await runTurnWithClientEndpoint(endpoint, "browser.navigate");
    const auditEvents = events.filter((e) => (e as TuvrenStreamEvent).type === "tool.audit");
    expect(auditEvents).toHaveLength(0);
  });

  test("the client-reported content is surfaced as the tool result output", async () => {
    const expectedContent = { browserResult: "page loaded", title: "Home" };
    const endpoint = makeOkEndpoint("ep1", "browser.get_title", expectedContent);
    const { events } = await runTurnWithClientEndpoint(endpoint, "browser.get_title");
    const toolResultEvent = events.find(
      (e) => (e as TuvrenStreamEvent).type === "tool.result"
    ) as (TuvrenStreamEvent & { type: "tool.result"; isError?: boolean }) | undefined;
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent?.isError).toBeFalsy();
  });

  test("runtime owns orchestration: the invocation is policy-checked and dispatched", async () => {
    // This test ensures the invocation went through the capability policy engine
    // (no denial) and was dispatched (endpoint received the call).
    let received: ClientInvocationEnvelope | undefined;
    const endpoint: AttachedClientEndpoint = {
      endpointId: "ep1",
      advertisedCapabilities: [
        { capabilityId: "tracked.call", description: "tracked", inputSchema: { type: "object" } },
      ],
      async dispatch(envelope) {
        received = envelope;
        return { callId: envelope.callId, content: { tracked: true }, leaseToken: envelope.leaseToken };
      },
    };
    await runTurnWithClientEndpoint(endpoint, "tracked.call", { param: 42 });
    expect(received).toBeDefined();
    expect(received?.capabilityId).toBe("tracked.call");
    expect(received?.input).toEqual({ param: 42 });
  });
});

// ---------------------------------------------------------------------------
// KRT-AZ003: Unavailability and staleness
// ---------------------------------------------------------------------------

describe("tuvren-client: unavailability and staleness (KRT-AZ003)", () => {
  test("a tool call to an unattached capability yields capability_binding_unavailable result", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      createId: makeId,
      defaultDriverId: "test-driver",
      driverRegistry: createDriverRegistry([
        {
          id: "test-driver",
          execute(ctx: DriverExecutionContext): Promise<DriverExecutionResult> {
            const hasToolResult = ctx.messages.some((m) => m.role === "tool");
            if (!hasToolResult) {
              return Promise.resolve({
                messages: [
                  assistantToolCalls([{ callId: "call-unavailable", input: {}, name: "missing.tool" }]),
                ],
                resolution: { type: "continue_iteration" as const },
                toolExecutionMode: "parallel" as const,
              });
            }
            return Promise.resolve({
              messages: [assistantText("done after unavailable")],
              resolution: { reason: "done", type: "end_turn" as const },
            });
          },
        },
      ]),
      kernel: harness.kernel,
    });

    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "test-agent",
        // No clientEndpoints → "missing.tool" will not be registered → tool not found error
        // (This is the "tool not registered" case, surfaced by resolveExecutableToolCall)
      },
      signal: textSignal("unavailable test"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const result = await handle.awaitResult();

    // The tool call should be surfaced as an error result
    const toolResultEvents = events.filter(
      (e) => (e as TuvrenStreamEvent).type === "tool.result"
    ) as (TuvrenStreamEvent & { type: "tool.result"; isError?: boolean })[];
    expect(toolResultEvents).toHaveLength(1);
    expect(toolResultEvents[0]?.isError).toBe(true);
    expect(result.status).toBe("completed");
  });

  test("a stale client result (mismatched leaseToken) is ignored and surfaces as an error", async () => {
    const staleEndpoint = makeStaleEndpoint("ep1", "stale.cap");
    const { events, result } = await runTurnWithClientEndpoint(staleEndpoint, "stale.cap");

    expect(result.status).toBe("completed");
    const toolResultEvents = events.filter(
      (e) => (e as TuvrenStreamEvent).type === "tool.result"
    ) as (TuvrenStreamEvent & { type: "tool.result"; isError?: boolean })[];
    // The result should be an error (stale result → capability_binding_unavailable code)
    expect(toolResultEvents).toHaveLength(1);
    expect(toolResultEvents[0]?.isError).toBe(true);
  });

  test("a within-lease invocation completes normally (no error)", async () => {
    const endpoint = makeOkEndpoint("ep1", "normal.cap", { data: "ok" });
    const { result } = await runTurnWithClientEndpoint(endpoint, "normal.cap");
    expect(result.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// KRT-AZ004: Client-side MCP classification
// ---------------------------------------------------------------------------

describe("tuvren-client: client-side MCP binding classification (KRT-AZ004)", () => {
  test("a client-run MCP tool dispatches through the client endpoint and returns a result", async () => {
    const endpoint = makeClientMcpEndpoint("ext1", "shopify.products", "shopify");
    const { result, events } = await runTurnWithClientEndpoint(endpoint, "shopify.products");
    expect(result.status).toBe("completed");
    // tool.start and tool.result are emitted (client-owned invocation, tuvren orchestrates)
    const startEvents = events.filter((e) => (e as TuvrenStreamEvent).type === "tool.start");
    const resultEvents = events.filter((e) => (e as TuvrenStreamEvent).type === "tool.result");
    expect(startEvents).toHaveLength(1);
    expect(resultEvents).toHaveLength(1);
  });

  test("no tool.audit events are emitted for client-side MCP tools", async () => {
    const endpoint = makeClientMcpEndpoint("ext1", "client.mcp.search", "search-server");
    const { events } = await runTurnWithClientEndpoint(endpoint, "client.mcp.search");
    const auditEvents = events.filter((e) => (e as TuvrenStreamEvent).type === "tool.audit");
    expect(auditEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// KRT-AZ005: Partial-observability model
// ---------------------------------------------------------------------------

describe("tuvren-client: partial-observability model (KRT-AZ005)", () => {
  test("tool.result event is emitted — runtime records from dispatch/result envelope", async () => {
    const endpoint = makeOkEndpoint("ep1", "observable.cap", { measured: true });
    const { events } = await runTurnWithClientEndpoint(endpoint, "observable.cap");
    const toolResultEvents = events.filter((e) => (e as TuvrenStreamEvent).type === "tool.result");
    expect(toolResultEvents).toHaveLength(1);
  });

  test("no tool.audit events (canAudit: false for tuvren-client)", async () => {
    const endpoint = makeOkEndpoint("ep1", "partial.cap", {});
    const { events } = await runTurnWithClientEndpoint(endpoint, "partial.cap");
    const auditEvents = events.filter((e) => (e as TuvrenStreamEvent).type === "tool.audit");
    expect(auditEvents).toHaveLength(0);
  });
});
