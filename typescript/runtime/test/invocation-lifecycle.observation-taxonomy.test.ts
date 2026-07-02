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
 * KRT-BA002: Observation/Event Taxonomy Depth
 *
 * Proves that:
 * 1. Provider-native invocations are fully distinguished from Tuvren-owned
 *    invocations: owner:"provider" vs owner:"tuvren" on both tool.start and
 *    tool.result events across all four execution classes.
 * 2. Resume, cancel, retry, and audit affordances are exposed only for the
 *    classes that grant them (per-class observation limits enforced).
 * 3. The taxonomy is consistent across the canonical event stream AND
 *    operational telemetry: tool_call spans carry matching execution_class
 *    and owner attributes for all four classes.
 * 4. tool.audit events are NOT emitted for any class where canAudit is false
 *    (provider-native, provider-mediated, tuvren-client).
 *
 * The telemetry-consistency tests (criteria 3) are the primary new coverage
 * for BA002; event-stream-only assertions for BA001 already cover criteria 1-2.
 */

import { describe, expect, test } from "bun:test";
import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import type { RuntimeDriver } from "@tuvren/core/driver";
import type {
  ToolAuditEvent,
  ToolResultEvent,
  ToolStartEvent,
} from "@tuvren/core/events";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
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
  textSignal,
} from "./runtime-core-test-helpers.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createTelemetryCapture(): {
  spans: TelemetrySpan[];
  sink: TuvrenTelemetrySink;
} {
  const spans: TelemetrySpan[] = [];
  return {
    spans,
    sink: {
      event: (_e) => {
        /* noop */
      },
      span: (span) => {
        spans.push(span);
      },
    },
  };
}

function extractEventsByType(events: unknown[]) {
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
  return { audits, results, starts };
}

function buildProviderToolMessage(
  callId: string,
  name: string,
  executionClass: "provider-native" | "provider-mediated"
): TuvrenMessage {
  return {
    role: "tool",
    parts: [
      {
        callId,
        name,
        output: { value: 1 },
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

function makeProviderDriver(
  executionClass: "provider-native" | "provider-mediated"
): RuntimeDriver {
  return {
    id: `ba002-driver-${executionClass}`,
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            buildProviderToolMessage(
              `call-${executionClass}`,
              `prov_${executionClass.replace("-", "_")}`,
              executionClass
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
}

function makeServerDriver(toolName: string): RuntimeDriver {
  return {
    id: "ba002-server-driver",
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            assistantToolCalls([
              { callId: "ba002-call-server", input: {}, name: toolName },
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
}

function makeClientDriver(capabilityId: string): RuntimeDriver {
  return {
    id: "ba002-client-driver",
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            assistantToolCalls([
              { callId: "ba002-call-client", input: {}, name: capabilityId },
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
}

function makeOkEndpoint(
  endpointId: string,
  capabilityId: string
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      {
        capabilityId,
        description: "ba002 client cap",
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
}

// ---------------------------------------------------------------------------
// BA002 criterion 3: telemetry consistency for tuvren-server
// ---------------------------------------------------------------------------

describe("BA002 telemetry taxonomy — tuvren-server", () => {
  test("tool_call span carries execution_class:tuvren-server and owner:tuvren", async () => {
    const capture = createTelemetryCapture();
    const harness = createFakeKernelHarness();
    const toolName = "ba002_server_tool";
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ba002-server-driver",
      driverRegistry: createDriverRegistry([makeServerDriver(toolName)]),
      kernel: harness.kernel,
      telemetry: capture.sink,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "agent",
        tools: [
          {
            name: toolName,
            description: "server tool",
            inputSchema: { type: "object" },
            execute: async () => ({ ok: true }),
          },
        ],
      },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());

    const toolCallSpan = capture.spans.find((s) => s.kind === "tool_call");
    expect(toolCallSpan).toBeDefined();
    expect(
      toolCallSpan?.attributes["tuvren.runtime.capability.execution_class"]
    ).toBe("tuvren-server");
    expect(toolCallSpan?.attributes["tuvren.runtime.capability.owner"]).toBe(
      "tuvren"
    );

    // Event stream attribution must match the telemetry span
    const { starts } = extractEventsByType(events);
    expect(starts[0].attribution?.executionClass).toBe("tuvren-server");
    expect(starts[0].attribution?.owner).toBe("tuvren");
  });

  test("audit affordance is active: tool.audit events emitted (canAudit: true)", async () => {
    const harness = createFakeKernelHarness();
    const toolName = "ba002_audit_tool";
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ba002-server-driver",
      driverRegistry: createDriverRegistry([makeServerDriver(toolName)]),
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
            description: "audit tool",
            inputSchema: { type: "object" },
            execute: async () => ({ ok: true }),
          },
        ],
      },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const { audits } = extractEventsByType(events);

    // tuvren-server: canAudit is true — audit events must be present
    expect(audits.length).toBeGreaterThan(0);
    for (const audit of audits) {
      expect(audit.executionClass).toBe("tuvren-server");
    }
  });
});

// ---------------------------------------------------------------------------
// BA002 criterion 3: telemetry consistency for provider-native
// ---------------------------------------------------------------------------

describe("BA002 telemetry taxonomy — provider-native", () => {
  test("tool_call span carries execution_class:provider-native and owner:provider", async () => {
    const capture = createTelemetryCapture();
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ba002-driver-provider-native",
      driverRegistry: createDriverRegistry([
        makeProviderDriver("provider-native"),
      ]),
      kernel: harness.kernel,
      telemetry: capture.sink,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "agent" },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());

    const toolCallSpan = capture.spans.find((s) => s.kind === "tool_call");
    expect(toolCallSpan).toBeDefined();
    expect(
      toolCallSpan?.attributes["tuvren.runtime.capability.execution_class"]
    ).toBe("provider-native");
    expect(toolCallSpan?.attributes["tuvren.runtime.capability.owner"]).toBe(
      "provider"
    );

    // Event stream matches telemetry
    const { starts, audits } = extractEventsByType(events);
    expect(starts[0].attribution?.executionClass).toBe("provider-native");
    expect(starts[0].attribution?.owner).toBe("provider");

    // provider-native: no audit events (canAudit: false)
    expect(audits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BA002 criterion 3: telemetry consistency for provider-mediated
// ---------------------------------------------------------------------------

describe("BA002 telemetry taxonomy — provider-mediated", () => {
  test("tool_call span carries execution_class:provider-mediated and owner:provider", async () => {
    const capture = createTelemetryCapture();
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ba002-driver-provider-mediated",
      driverRegistry: createDriverRegistry([
        makeProviderDriver("provider-mediated"),
      ]),
      kernel: harness.kernel,
      telemetry: capture.sink,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "agent" },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());

    const toolCallSpan = capture.spans.find((s) => s.kind === "tool_call");
    expect(toolCallSpan).toBeDefined();
    expect(
      toolCallSpan?.attributes["tuvren.runtime.capability.execution_class"]
    ).toBe("provider-mediated");
    expect(toolCallSpan?.attributes["tuvren.runtime.capability.owner"]).toBe(
      "provider"
    );

    const { starts, audits } = extractEventsByType(events);
    expect(starts[0].attribution?.executionClass).toBe("provider-mediated");
    expect(starts[0].attribution?.owner).toBe("provider");

    // provider-mediated: no audit events (canAudit: false)
    expect(audits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BA002 criterion 3: telemetry consistency for tuvren-client
// ---------------------------------------------------------------------------

describe("BA002 telemetry taxonomy — tuvren-client", () => {
  test("tool_call span carries execution_class:tuvren-client and owner:tuvren", async () => {
    const capture = createTelemetryCapture();
    const harness = createFakeKernelHarness();
    const capabilityId = "ba002.client.cap";
    const endpoint = makeOkEndpoint("ep-ba002", capabilityId);
    const boundary = createClientEndpointBoundary([endpoint]);

    const runtime = createTuvrenRuntime({
      defaultDriverId: "ba002-client-driver",
      driverRegistry: createDriverRegistry([makeClientDriver(capabilityId)]),
      kernel: harness.kernel,
      telemetry: capture.sink,
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

    const toolCallSpan = capture.spans.find((s) => s.kind === "tool_call");
    expect(toolCallSpan).toBeDefined();
    expect(
      toolCallSpan?.attributes["tuvren.runtime.capability.execution_class"]
    ).toBe("tuvren-client");
    expect(toolCallSpan?.attributes["tuvren.runtime.capability.owner"]).toBe(
      "tuvren"
    );

    const { starts, audits } = extractEventsByType(events);
    expect(starts[0].attribution?.executionClass).toBe("tuvren-client");
    expect(starts[0].attribution?.owner).toBe("tuvren");

    // tuvren-client: no audit events (canAudit: false)
    expect(audits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BA002 criterion 1 & 2: provider-native vs tuvren-owned distinction, affordances
// (consolidated cross-class taxonomy proof for the taxonomy-depth requirement)
// ---------------------------------------------------------------------------

describe("BA002 cross-class observation limits", () => {
  test("provider-owned classes expose no resume/cancel/retry/audit affordances", async () => {
    for (const executionClass of [
      "provider-native",
      "provider-mediated",
    ] as const) {
      const harness = createFakeKernelHarness();
      const runtime = createTuvrenRuntime({
        defaultDriverId: `ba002-driver-${executionClass}`,
        driverRegistry: createDriverRegistry([
          makeProviderDriver(executionClass),
        ]),
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
      const { starts, audits } = extractEventsByType(events);

      // owner must be "provider" for both classes
      expect(starts[0].attribution?.owner).toBe("provider");

      // All observation affordances must be false for provider-owned classes
      const obs = starts[0].attribution?.observation;
      expect(obs?.canAudit).toBe(false);
      expect(obs?.canCancel).toBe(false);
      expect(obs?.canResume).toBe(false);
      expect(obs?.canRetry).toBe(false);

      // No tool.audit events for provider-owned classes
      expect(audits).toHaveLength(0);
    }
  });

  test("tuvren-server exposes full lifecycle affordances", async () => {
    const harness = createFakeKernelHarness();
    const toolName = "ba002_obs_tool";
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ba002-server-driver",
      driverRegistry: createDriverRegistry([makeServerDriver(toolName)]),
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
            description: "obs tool",
            inputSchema: { type: "object" },
            execute: async () => ({ ok: true }),
          },
        ],
      },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const { starts } = extractEventsByType(events);

    const obs = starts[0].attribution?.observation;
    expect(obs?.canAudit).toBe(true);
    expect(obs?.canCancel).toBe(true);
    expect(obs?.canResume).toBe(true);
    expect(obs?.canRetry).toBe(true);
    expect(obs?.canPersistResult).toBe(true);
  });

  test("tuvren-client has tuvren owner but restricted observation (no audit/cancel/retry/resume)", async () => {
    const harness = createFakeKernelHarness();
    const capabilityId = "ba002.obs.client.cap";
    const endpoint = makeOkEndpoint("ep-ba002-obs", capabilityId);
    const boundary = createClientEndpointBoundary([endpoint]);
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ba002-client-driver",
      driverRegistry: createDriverRegistry([makeClientDriver(capabilityId)]),
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
    const { starts, audits } = extractEventsByType(events);

    // tuvren-client: Tuvren orchestrates but client executes — owner is tuvren
    expect(starts[0].attribution?.owner).toBe("tuvren");

    // tuvren-client: partial observability — no audit/cancel/retry/resume
    const obs = starts[0].attribution?.observation;
    expect(obs?.canAudit).toBe(false);
    expect(obs?.canCancel).toBe(false);
    expect(obs?.canResume).toBe(false);
    expect(obs?.canRetry).toBe(false);
    // But results are persisted
    expect(obs?.canPersistResult).toBe(true);

    // No audit events for tuvren-client
    expect(audits).toHaveLength(0);
  });
});
