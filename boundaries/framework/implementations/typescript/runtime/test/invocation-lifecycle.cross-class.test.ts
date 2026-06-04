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
 * KRT-BA001: Cross-Class Invocation Lifecycle State Machine
 *
 * Proves the conceptual invariant: every model-visible tool call resolves to
 * exactly one Capability invocation against exactly one ExecutionClass, and
 * flows through the uniform lifecycle (resolved → policy-admitted → dispatched
 * → completed/failed/ignored) regardless of execution class.
 *
 * Four proofs — one per execution class — plus a policy-denied control case:
 *
 * 1. tuvren-server: defineTool / execute callback path.
 * 2. provider-native: pre-staged provider tool message with executionClass
 *    "provider-native" in providerMetadata.
 * 3. provider-mediated: same mechanism with "provider-mediated".
 * 4. tuvren-client: leased client endpoint dispatch.
 * 5. Policy-denied (tuvren-server): invocation denied at invocation-time →
 *    lifecycle terminates at policy-admitted → failed (error tool.result,
 *    no tool.start event).
 *
 * All proofs verify the InvocationLifecycleState concept is observable
 * through the canonical event stream without relying on internal state.
 */

import { describe, expect, test } from "bun:test";
import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
  ClientReportedResult,
  InvocationLifecycleState,
} from "@tuvren/core/capabilities";
import type { RuntimeDriver } from "@tuvren/core/driver";
import type {
  ToolAuditEvent,
  ToolResultEvent,
  ToolStartEvent,
} from "@tuvren/core/events";
import type { TuvrenMessage } from "@tuvren/core/messages";
import {
  createCapabilityPolicyEngine,
  createClientEndpointBoundary,
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

/** Pick tool.start, tool.result, and tool.audit events from a stream. */
function extractInvocationEvents(events: unknown[]): {
  starts: ToolStartEvent[];
  results: ToolResultEvent[];
  audits: ToolAuditEvent[];
} {
  const starts: ToolStartEvent[] = [];
  const results: ToolResultEvent[] = [];
  const audits: ToolAuditEvent[] = [];
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
    if (e.type === "tool.audit") {
      audits.push(e as unknown as ToolAuditEvent);
    }
  }
  return { starts, results, audits };
}

/** Pre-staged provider tool message for provider-native / provider-mediated. */
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

/** Simple two-turn driver: first turn returns provider tool result, second ends. */
function makeProviderDriver(
  executionClass: "provider-native" | "provider-mediated"
): RuntimeDriver {
  return {
    id: `driver-${executionClass}`,
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            buildProviderToolMessage(
              `call-${executionClass}`,
              `provider_tool_${executionClass.replace("-", "_")}`,
              executionClass,
              { value: 42 }
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
      throw new Error("resume not expected");
    },
  };
}

/** Simple tuvren-server driver that calls one defineTool tool. */
function makeTuvrenServerDriver(toolName: string): RuntimeDriver {
  return {
    id: "driver-tuvren-server",
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            assistantToolCalls([
              { callId: "call-server", input: { x: 1 }, name: toolName },
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

/** Simple tuvren-client driver that calls one client endpoint capability. */
function makeTuvrenClientDriver(capabilityId: string): RuntimeDriver {
  return {
    id: "driver-tuvren-client",
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            assistantToolCalls([
              { callId: "call-client", input: { q: "hi" }, name: capabilityId },
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

/** A mock client endpoint that immediately returns a fixed result. */
function makeOkEndpoint(
  endpointId: string,
  capabilityId: string
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      {
        capabilityId,
        description: "test client capability",
        inputSchema: { type: "object" },
      },
    ],
    async dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      return {
        callId: envelope.callId,
        content: { result: "client-ok" },
        leaseToken: envelope.leaseToken,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// BA001: Lifecycle invariant proof — tuvren-server
// ---------------------------------------------------------------------------

describe("BA001 invocation lifecycle — tuvren-server", () => {
  test("produces tool.start → tool.result with tuvren-server attribution", async () => {
    const harness = createFakeKernelHarness();
    const toolName = "ba001_server_tool";
    const runtime = createTuvrenRuntime({
      defaultDriverId: "driver-tuvren-server",
      driverRegistry: createDriverRegistry([makeTuvrenServerDriver(toolName)]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "agent",
        tools: [
          {
            name: toolName,
            description: "tuvren-server test tool",
            inputSchema: {
              type: "object",
              properties: { x: { type: "number" } },
            },
            execute: async (input) => ({
              doubled: (input as Record<string, number>).x * 2,
            }),
          },
        ],
      },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const { starts, results, audits } = extractInvocationEvents(events);

    // Uniform lifecycle: exactly one dispatched + one terminal event pair
    expect(starts).toHaveLength(1);
    expect(results).toHaveLength(1);

    const start = starts[0];
    const result = results[0];

    // Attribution present — invariant: executionClass is always known
    expect(start.attribution).toBeDefined();
    expect(result.attribution).toBeDefined();

    // tuvren-server class
    expect(start.attribution?.executionClass).toBe("tuvren-server");
    expect(result.attribution?.executionClass).toBe("tuvren-server");

    // tuvren-server is owned by tuvren
    expect(start.attribution?.owner).toBe("tuvren");
    expect(result.attribution?.owner).toBe("tuvren");

    // tuvren-server observation: full lifecycle control
    const obs = start.attribution?.observation;
    expect(obs?.canAudit).toBe(true);
    expect(obs?.canCancel).toBe(true);
    expect(obs?.canResume).toBe(true);
    expect(obs?.canRetry).toBe(true);
    expect(obs?.canPersistResult).toBe(true);

    // callId is consistent across start and result (same invocation)
    expect(start.callId).toBe(result.callId);

    // tuvren-server emits audit events (canAudit: true)
    expect(audits.length).toBeGreaterThan(0);
    for (const audit of audits) {
      expect(audit.executionClass).toBe("tuvren-server");
    }
  });

  test("policy-denied invocation: lifecycle terminates before dispatch — no tool.start", async () => {
    const harness = createFakeKernelHarness();
    const toolName = "ba001_denied_tool";
    const denyEngine = createCapabilityPolicyEngine({
      deniedCapabilityIds: new Set([toolName]),
    });
    const runtime = createTuvrenRuntime({
      defaultDriverId: "driver-tuvren-server",
      driverRegistry: createDriverRegistry([makeTuvrenServerDriver(toolName)]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "agent",
        capabilityPolicyEngine: denyEngine,
        tools: [
          {
            name: toolName,
            description: "to-be-denied tool",
            inputSchema: { type: "object" },
            execute: async () => ({ result: "should not reach" }),
          },
        ],
      },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const { starts, results } = extractInvocationEvents(events);

    // Policy-denied: lifecycle terminates at policy-admitted → failed
    // No tool.start event (invocation never dispatched)
    expect(starts).toHaveLength(0);

    // One tool.result with isError: true (failed lifecycle terminal state)
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BA001: Lifecycle invariant proof — provider-native
// ---------------------------------------------------------------------------

describe("BA001 invocation lifecycle — provider-native", () => {
  test("produces tool.start → tool.result with provider-native attribution", async () => {
    const harness = createFakeKernelHarness();
    const driver = makeProviderDriver("provider-native");
    const runtime = createTuvrenRuntime({
      defaultDriverId: "driver-provider-native",
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
    const { starts, results, audits } = extractInvocationEvents(events);

    // Uniform lifecycle: exactly one dispatched + one terminal event pair
    expect(starts).toHaveLength(1);
    expect(results).toHaveLength(1);

    const start = starts[0];
    const result = results[0];

    // Attribution present — invariant holds for provider class too
    expect(start.attribution).toBeDefined();
    expect(result.attribution).toBeDefined();

    // provider-native class and owner
    expect(start.attribution?.executionClass).toBe("provider-native");
    expect(result.attribution?.executionClass).toBe("provider-native");
    expect(start.attribution?.owner).toBe("provider");
    expect(result.attribution?.owner).toBe("provider");

    // provider-native observation: no lifecycle control from Tuvren
    const obs = start.attribution?.observation;
    expect(obs?.canAudit).toBe(false);
    expect(obs?.canCancel).toBe(false);
    expect(obs?.canResume).toBe(false);
    expect(obs?.canRetry).toBe(false);
    expect(obs?.canPersistResult).toBe(true);

    // callId consistent across start and result
    expect(start.callId).toBe(result.callId);

    // No tool.audit for provider-native (canAudit: false)
    expect(audits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BA001: Lifecycle invariant proof — provider-mediated
// ---------------------------------------------------------------------------

describe("BA001 invocation lifecycle — provider-mediated", () => {
  test("produces tool.start → tool.result with provider-mediated attribution", async () => {
    const harness = createFakeKernelHarness();
    const driver = makeProviderDriver("provider-mediated");
    const runtime = createTuvrenRuntime({
      defaultDriverId: "driver-provider-mediated",
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
    const { starts, results, audits } = extractInvocationEvents(events);

    expect(starts).toHaveLength(1);
    expect(results).toHaveLength(1);

    expect(starts[0].attribution?.executionClass).toBe("provider-mediated");
    expect(starts[0].attribution?.owner).toBe("provider");
    expect(results[0].attribution?.executionClass).toBe("provider-mediated");
    expect(results[0].attribution?.owner).toBe("provider");

    const obs = starts[0].attribution?.observation;
    expect(obs?.canAudit).toBe(false);
    expect(obs?.canCancel).toBe(false);
    expect(obs?.canResume).toBe(false);
    expect(obs?.canRetry).toBe(false);
    expect(obs?.canPersistResult).toBe(true);

    expect(starts[0].callId).toBe(results[0].callId);

    // No tool.audit for provider-mediated (canAudit: false)
    expect(audits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BA001: Lifecycle invariant proof — tuvren-client
// ---------------------------------------------------------------------------

describe("BA001 invocation lifecycle — tuvren-client", () => {
  test("produces tool.start → tool.result with tuvren-client attribution", async () => {
    const harness = createFakeKernelHarness();
    const capabilityId = "ba001.client.cap";
    const endpoint = makeOkEndpoint("ep-ba001", capabilityId);
    const boundary = createClientEndpointBoundary([endpoint]);

    const runtime = createTuvrenRuntime({
      defaultDriverId: "driver-tuvren-client",
      driverRegistry: createDriverRegistry([
        makeTuvrenClientDriver(capabilityId),
      ]),
      kernel: harness.kernel,
    });
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
    const { starts, results, audits } = extractInvocationEvents(events);

    // Uniform lifecycle: exactly one dispatched + one terminal event pair
    expect(starts).toHaveLength(1);
    expect(results).toHaveLength(1);

    const start = starts[0];
    const result = results[0];

    // Attribution present — invariant: executionClass is known
    expect(start.attribution).toBeDefined();
    expect(result.attribution).toBeDefined();

    // tuvren-client class
    expect(start.attribution?.executionClass).toBe("tuvren-client");
    expect(result.attribution?.executionClass).toBe("tuvren-client");

    // tuvren-client: Tuvren orchestrates, client executes — owner is tuvren
    expect(start.attribution?.owner).toBe("tuvren");
    expect(result.attribution?.owner).toBe("tuvren");

    // tuvren-client observation: partial — no audit/cancel/retry/resume from runtime
    const obs = start.attribution?.observation;
    expect(obs?.canAudit).toBe(false);
    expect(obs?.canCancel).toBe(false);
    expect(obs?.canResume).toBe(false);
    expect(obs?.canRetry).toBe(false);
    expect(obs?.canPersistResult).toBe(true);

    expect(start.callId).toBe(result.callId);

    // No tool.audit for tuvren-client (canAudit: false)
    expect(audits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BA001: InvocationLifecycleState type is exported from @tuvren/core/capabilities
// ---------------------------------------------------------------------------

/**
 * Exhaustiveness helper: the compiler enforces that every InvocationLifecycleState
 * member is handled. If a member is added or removed from the union this switch
 * will fail to compile (missing case or unreachable `never`), making the test
 * below a genuine contract regression check rather than a tautology.
 */
function assertLifecycleExhaustive(state: InvocationLifecycleState): string {
  switch (state) {
    case "resolved":
      return "resolved";
    case "policy-admitted":
      return "policy-admitted";
    case "dispatched":
      return "dispatched";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "ignored":
      return "ignored";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

describe("BA001 InvocationLifecycleState type contract", () => {
  test("all six lifecycle phases are exported and exhaustively enumerable", () => {
    const phases: InvocationLifecycleState[] = [
      "resolved",
      "policy-admitted",
      "dispatched",
      "completed",
      "failed",
      "ignored",
    ];
    // Compiler-enforced: assertLifecycleExhaustive fails to compile if any
    // phase is added, removed, or renamed in the union.
    for (const phase of phases) {
      expect(assertLifecycleExhaustive(phase)).toBe(phase);
    }
    expect(phases).toHaveLength(6);
  });
});
