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
import { describe, expect, test } from "bun:test";
import type { RuntimeDriver } from "@tuvren/core/driver";
import type { ToolResultEvent, ToolStartEvent } from "@tuvren/core/events";
import { isTuvrenStreamEvent } from "@tuvren/core/events";
import type {
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  createDriverRegistry as createBaseDriverRegistry,
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

function makeDriver(toolName: string): RuntimeDriver {
  return {
    id: "fake",
    async execute(context) {
      const toolMessages = context.messages.filter((m) => m.role === "tool");
      if (toolMessages.length === 0) {
        return {
          messages: [
            assistantToolCalls([
              { callId: "call-1", input: { q: "test" }, name: toolName },
            ]),
          ],
          resolution: { type: "continue_iteration" },
          toolExecutionMode: "parallel",
        };
      }
      return {
        messages: [assistantText("done")],
        resolution: { reason: "complete", type: "end_turn" },
      };
    },
    async resume() {
      throw new Error("resume not expected");
    },
  };
}

function makeTool(name: string): TuvrenToolDefinition {
  return {
    description: `test tool ${name}`,
    execute: async (input) => ({ result: input }),
    inputSchema: { properties: { q: { type: "string" } }, type: "object" },
    name,
  };
}

async function runToolTurn(toolName: string) {
  const harness = createFakeKernelHarness();
  const runtime = createTuvrenRuntime({
    defaultDriverId: "fake",
    driverRegistry: createBaseDriverRegistry([makeDriver(toolName)]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary", tools: [makeTool(toolName)] },
    signal: textSignal("run"),
    threadId: thread.threadId,
  });
  return collectEvents(handle.events());
}

// ---------------------------------------------------------------------------
// Attribution on canonical events (AW006)
// ---------------------------------------------------------------------------

describe("Capability attribution — canonical events (AW006)", () => {
  test("tool.start event carries attribution with executionClass tuvren-server", async () => {
    const events = await runToolTurn("search");
    const toolStart = events.find(
      (e): e is ToolStartEvent => e.type === "tool.start"
    );

    expect(toolStart).toBeDefined();
    expect(toolStart?.attribution).toBeDefined();
    expect(toolStart?.attribution?.executionClass).toBe("tuvren-server");
  });

  test("tool.start event attribution.owner is tuvren for a defineTool tool", async () => {
    const events = await runToolTurn("calculator");
    const toolStart = events.find(
      (e): e is ToolStartEvent => e.type === "tool.start"
    );

    expect(toolStart?.attribution?.owner).toBe("tuvren");
  });

  test("tool.result event carries attribution with executionClass tuvren-server", async () => {
    const events = await runToolTurn("lookup");
    const toolResult = events.find(
      (e): e is ToolResultEvent => e.type === "tool.result"
    );

    expect(toolResult).toBeDefined();
    expect(toolResult?.attribution?.executionClass).toBe("tuvren-server");
    expect(toolResult?.attribution?.owner).toBe("tuvren");
  });

  test("attribution is additive — existing event fields are unaffected", async () => {
    const events = await runToolTurn("echo");
    const toolStart = events.find(
      (e): e is ToolStartEvent => e.type === "tool.start"
    );
    const toolResult = events.find(
      (e): e is ToolResultEvent => e.type === "tool.result"
    );

    // Existing fields must still be present
    expect(toolStart?.callId).toBe("call-1");
    expect(toolStart?.name).toBe("echo");
    expect(typeof toolStart?.timestamp).toBe("number");
    expect(toolResult?.callId).toBe("call-1");
    expect(toolResult?.name).toBe("echo");
  });

  test("tuvren-server observation declares full lifecycle control", async () => {
    const events = await runToolTurn("verify");
    const toolStart = events.find(
      (e): e is ToolStartEvent => e.type === "tool.start"
    );
    const obs = toolStart?.attribution?.observation;

    expect(obs?.executionClass).toBe("tuvren-server");
    expect(obs?.canObserveIntermediate).toBe(true);
    expect(obs?.canPersistResult).toBe(true);
    expect(obs?.canResume).toBe(true);
    expect(obs?.canCancel).toBe(true);
    expect(obs?.canRetry).toBe(true);
    expect(obs?.canAudit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Attribution in telemetry (AW006 — telemetry half)
// ---------------------------------------------------------------------------

describe("Capability attribution — telemetry spans (AW006)", () => {
  test("tool_call span carries execution_class and owner capability attributes", async () => {
    const spans: TelemetrySpan[] = [];
    const sink: TuvrenTelemetrySink = {
      event: () => {
        // Not asserting event-level telemetry in this test
      },
      span: (span) => {
        spans.push(span);
      },
    };

    const harness = createFakeKernelHarness();
    const toolName = "attrib-tool";
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createBaseDriverRegistry([makeDriver(toolName)]),
      kernel: harness.kernel,
      telemetry: sink,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary", tools: [makeTool(toolName)] },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());

    const toolCallSpan = spans.find((s) => s.kind === "tool_call");
    expect(toolCallSpan).toBeDefined();
    expect(
      toolCallSpan?.attributes["tuvren.runtime.capability.execution_class"]
    ).toBe("tuvren-server");
    expect(toolCallSpan?.attributes["tuvren.runtime.capability.owner"]).toBe(
      "tuvren"
    );
  });
});

// ---------------------------------------------------------------------------
// Attribution stream-event guard (AW006 — additive field contract)
// ---------------------------------------------------------------------------

describe("Capability attribution — stream-event guard contract", () => {
  const toolStartBase = {
    callId: "c1",
    input: {},
    name: "tool-x",
    timestamp: 1000,
    type: "tool.start",
  };

  const validAttribution = {
    capabilityId: "tool.x",
    executionClass: "tuvren-server",
    observation: {
      canAudit: true,
      canCancel: true,
      canObserveIntermediate: true,
      canPersistResult: true,
      canResume: true,
      canRetry: true,
      executionClass: "tuvren-server",
    },
    owner: "tuvren",
  };

  test("tool.start without attribution passes the guard (attribution is optional)", () => {
    expect(isTuvrenStreamEvent(toolStartBase)).toBe(true);
  });

  test("tool.start with valid attribution passes the guard", () => {
    expect(
      isTuvrenStreamEvent({ ...toolStartBase, attribution: validAttribution })
    ).toBe(true);
  });

  test("tool.start with out-of-range executionClass is rejected by the guard", () => {
    expect(
      isTuvrenStreamEvent({
        ...toolStartBase,
        attribution: { ...validAttribution, executionClass: "unknown-class" },
      })
    ).toBe(false);
  });

  test("tool.start with out-of-range owner is rejected by the guard", () => {
    expect(
      isTuvrenStreamEvent({
        ...toolStartBase,
        attribution: { ...validAttribution, owner: "platform" },
      })
    ).toBe(false);
  });

  test("tool.start with null attribution is rejected by the guard", () => {
    expect(isTuvrenStreamEvent({ ...toolStartBase, attribution: null })).toBe(
      false
    );
  });

  test("tool.result with valid attribution passes the guard", () => {
    expect(
      isTuvrenStreamEvent({
        callId: "c1",
        isError: false,
        name: "tool-x",
        output: { ok: true },
        timestamp: 1000,
        type: "tool.result",
        attribution: validAttribution,
      })
    ).toBe(true);
  });
});
