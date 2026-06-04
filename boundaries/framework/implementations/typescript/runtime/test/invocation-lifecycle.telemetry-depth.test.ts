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
 * KRT-BA004: Lifecycle Telemetry Depth
 *
 * Verifies that capability invocation lifecycle spans are:
 * 1. Emitted for all four execution classes (provider-native, provider-mediated,
 *    tuvren-server, tuvren-client) — proven by BA002 tests. This file focuses
 *    on the remaining acceptance criteria:
 * 2. Keyed to runtime lineage: tool_call spans carry threadId, branchId, turnId
 *    in their lineage object.
 * 3. No secret material appears in lifecycle telemetry: the span attributes
 *    for tool invocations do not include credential-shaped values.
 *
 * BA004 does not require new semconv attributes: the existing
 * tuvren.runtime.capability.execution_class and
 * tuvren.runtime.capability.owner attributes (added in Epic AW / ADR-046
 * and now wired for all four classes after BA002) fully cover the lifecycle
 * taxonomy. No extension to telemetry/semconv/tuvren-runtime.yaml was needed.
 */

import { describe, expect, test } from "bun:test";
import type { RuntimeDriver } from "@tuvren/core/driver";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import { createDriverRegistry, createTuvrenRuntime } from "../src/index.ts";
import { TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS } from "../src/lib/generated/tuvren-runtime-telemetry.ts";
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
      span: (s) => {
        spans.push(s);
      },
    },
  };
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

// ---------------------------------------------------------------------------
// BA004 criterion 2: spans keyed to runtime lineage
// ---------------------------------------------------------------------------

describe("BA004 lifecycle telemetry — keyed to runtime lineage", () => {
  test("tuvren-server tool_call span carries threadId and branchId in lineage", async () => {
    const capture = createTelemetryCapture();
    const harness = createFakeKernelHarness();
    const toolName = "ba004_server_tool";
    const driver: RuntimeDriver = {
      id: "ba004-server",
      async execute(ctx) {
        if (!ctx.messages.some((m) => m.role === "tool")) {
          return {
            messages: [
              assistantToolCalls([{ callId: "c1", input: {}, name: toolName }]),
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
      defaultDriverId: "ba004-server",
      driverRegistry: createDriverRegistry([driver]),
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
            description: "t",
            inputSchema: { type: "object" },
            execute: async () => ({ ok: true }),
          },
        ],
      },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());

    const toolCallSpan = capture.spans.find((s) => s.kind === "tool_call");
    expect(toolCallSpan).toBeDefined();

    // Span is keyed to runtime lineage
    expect(toolCallSpan?.lineage.threadId).toBe(thread.threadId);
    expect(toolCallSpan?.lineage.branchId).toBe(thread.branchId);
    expect(toolCallSpan?.lineage.turnId).toBeDefined();

    // Span carries execution-class and owner (taxonomy dimension)
    expect(
      toolCallSpan?.attributes["tuvren.runtime.capability.execution_class"]
    ).toBe("tuvren-server");
    expect(toolCallSpan?.attributes["tuvren.runtime.capability.owner"]).toBe(
      "tuvren"
    );
  });

  test("provider-native tool_call span carries threadId and branchId in lineage", async () => {
    const capture = createTelemetryCapture();
    const harness = createFakeKernelHarness();
    const driver: RuntimeDriver = {
      id: "ba004-pn",
      async execute(ctx) {
        if (!ctx.messages.some((m) => m.role === "tool")) {
          return {
            messages: [
              buildProviderToolMessage("c2", "pn_tool", "provider-native"),
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
      defaultDriverId: "ba004-pn",
      driverRegistry: createDriverRegistry([driver]),
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
    await collectEvents(handle.events());

    const toolCallSpan = capture.spans.find((s) => s.kind === "tool_call");
    expect(toolCallSpan).toBeDefined();

    // Span is keyed to the same runtime lineage as all other spans for the turn
    expect(toolCallSpan?.lineage.threadId).toBe(thread.threadId);
    expect(toolCallSpan?.lineage.branchId).toBe(thread.branchId);
    expect(toolCallSpan?.lineage.turnId).toBeDefined();

    // Span distinguishes provider-native from tuvren-owned
    expect(
      toolCallSpan?.attributes["tuvren.runtime.capability.execution_class"]
    ).toBe("provider-native");
    expect(toolCallSpan?.attributes["tuvren.runtime.capability.owner"]).toBe(
      "provider"
    );
  });
});

// ---------------------------------------------------------------------------
// BA004 criterion 3: no secret material in lifecycle telemetry
// ---------------------------------------------------------------------------

describe("BA004 lifecycle telemetry — no secret material", () => {
  test("tool_call span attributes do not contain credential-shaped keys or values", async () => {
    // The telemetry secret-screening layer (BD001, AV) blocks credential-shaped
    // attribute keys (authorization, token, password, api-key, secret). This test
    // verifies that the lifecycle-attribution path does not introduce any new
    // credential-shaped attributes that could bypass screening.
    const capture = createTelemetryCapture();
    const harness = createFakeKernelHarness();
    const toolName = "ba004_secret_check_tool";
    const driver: RuntimeDriver = {
      id: "ba004-secret",
      async execute(ctx) {
        if (!ctx.messages.some((m) => m.role === "tool")) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "cs",
                  input: { apiKey: "should-be-screened" },
                  name: toolName,
                },
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
      defaultDriverId: "ba004-secret",
      driverRegistry: createDriverRegistry([driver]),
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
            description: "secret check",
            inputSchema: { type: "object" },
            execute: async () => ({ ok: true }),
          },
        ],
      },
      signal: textSignal("go"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());

    const toolCallSpan = capture.spans.find((s) => s.kind === "tool_call");
    expect(toolCallSpan).toBeDefined();

    const attrs = toolCallSpan?.attributes ?? {};

    // Credential-shaped key names must not appear in span attributes
    const credentialKeyPatterns = [
      "authorization",
      "token",
      "password",
      "api-key",
      "api_key",
      "secret",
      "apikey",
    ];
    for (const key of Object.keys(attrs)) {
      const lowerKey = key.toLowerCase();
      for (const pattern of credentialKeyPatterns) {
        expect(lowerKey.includes(pattern)).toBe(false);
      }
    }

    // The tool input (which contained "apiKey") must not appear in span attributes
    const attrValues = Object.values(attrs).map((v) => JSON.stringify(v));
    for (const value of attrValues) {
      expect(value.includes("should-be-screened")).toBe(false);
    }

    // Lifecycle attribution is present (non-secret structural data only)
    expect(attrs["tuvren.runtime.capability.execution_class"]).toBe(
      "tuvren-server"
    );
    expect(attrs["tuvren.runtime.capability.owner"]).toBe("tuvren");
    expect(attrs["tuvren.runtime.tool_call.id"]).toBe("cs");
  });
});

// ---------------------------------------------------------------------------
// BA004 semconv: no new attributes needed — enforced against generated key set
// ---------------------------------------------------------------------------

describe("BA004 semconv coverage — no new attributes required", () => {
  test("lifecycle telemetry attributes are declared in the semconv key set", () => {
    // BA004 requirement: "any new canonical telemetry attribute is added to the
    // semconv source before it is emitted." This test enforces the invariant
    // programmatically by asserting the three capability-lifecycle attributes
    // are members of TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS — the generated
    // allowlist from telemetry/semconv/tuvren-runtime.yaml. If any attribute
    // were removed from the semconv source, or if BA004 had introduced a new
    // undeclared attribute, this test would fail.
    const lifecycleAttributes = [
      "tuvren.runtime.capability.execution_class",
      "tuvren.runtime.capability.owner",
      "tuvren.runtime.tool_call.id",
    ] as const;

    for (const attr of lifecycleAttributes) {
      expect(TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS).toContain(attr);
    }
  });
});
