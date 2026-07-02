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
 * KRT-AX005: Trace and audit signals for Tuvren-server invocations.
 *
 * Acceptance criteria:
 * - Each server invocation emits lifecycle trace and audit signals keyed to
 *   runtime lineage.
 * - The CapabilityObservation for the server class reports full
 *   observe/persist/resume/cancel/retry/audit.
 * - No secret material appears in the trace or audit signals.
 */

import { describe, expect, test } from "bun:test";
import type { RuntimeDriver } from "@tuvren/core/driver";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { observationForClass } from "../src/lib/capability-attribution.ts";
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

function makeDriver(toolName: string, input: unknown = {}): RuntimeDriver {
  return {
    id: "ax005-driver",
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            assistantToolCalls([
              { callId: "call-ax005", input, name: toolName },
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

async function runWithTool(
  tool: TuvrenToolDefinition,
  config: Record<string, unknown> = {}
) {
  const harness = createFakeKernelHarness();
  const driver = makeDriver(tool.name);
  const runtime = createTuvrenRuntime({
    defaultDriverId: "ax005-driver",
    driverRegistry: createBaseDriverRegistry([driver]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary", tools: [tool], ...config },
    signal: textSignal("ax005 test"),
    threadId: thread.threadId,
  });
  return collectEvents(handle.events());
}

function findAuditEvents(events: unknown[]) {
  return events.filter(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      "type" in e &&
      (e as Record<string, unknown>).type === "tool.audit"
  ) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Lifecycle audit signals
// ---------------------------------------------------------------------------

describe("KRT-AX005 — lifecycle audit signals", () => {
  test("input_validated audit event is emitted for every tuvren-server invocation", async () => {
    const toolName = "ax005-basic";
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "basic tool",
      inputSchema: { type: "object" },
      execute() {
        return { ok: true };
      },
    };

    const events = await runWithTool(tool);
    const audits = findAuditEvents(events);
    const inputAudit = audits.find((a) => a.lifecycle === "input_validated");

    expect(inputAudit).toBeDefined();
    expect(inputAudit?.callId).toBe("call-ax005");
    expect(inputAudit?.capabilityId).toBe(toolName);
    expect(inputAudit?.executionClass).toBe("tuvren-server");
    expect(typeof inputAudit?.runId).toBe("string");
    expect(typeof inputAudit?.turnId).toBe("string");
  });

  test("input_validated audit carries validationPassed: true on success", async () => {
    const tool: TuvrenToolDefinition = {
      name: "ax005-input-pass",
      description: "valid input",
      inputSchema: { type: "object" },
      execute() {
        return {};
      },
    };

    const events = await runWithTool(tool);
    const audits = findAuditEvents(events);
    const inputAudit = audits.find((a) => a.lifecycle === "input_validated");

    expect(inputAudit?.validationPassed).toBe(true);
  });

  test("input_validated audit carries validationPassed: false on input failure", async () => {
    const tool: TuvrenToolDefinition = {
      name: "ax005-input-fail",
      description: "strict schema",
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      execute() {
        return {};
      },
    };

    const driver: RuntimeDriver = {
      id: "ax005-driver",
      async execute(context) {
        if (!context.messages.some((m) => m.role === "tool")) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-ax005",
                  input: { bad: "field" },
                  name: tool.name,
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

    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ax005-driver",
      driverRegistry: createBaseDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary", tools: [tool] },
      signal: textSignal("ax005 input fail"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const audits = findAuditEvents(events);
    const inputAudit = audits.find((a) => a.lifecycle === "input_validated");

    expect(inputAudit?.validationPassed).toBe(false);
  });

  test("output_validated audit event is emitted when outputSchema is declared", async () => {
    const tool: TuvrenToolDefinition = {
      name: "ax005-output-validated",
      description: "tool with output schema",
      inputSchema: { type: "object" },
      outputSchema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
        additionalProperties: false,
      },
      execute() {
        return { count: 3 };
      },
    };

    const events = await runWithTool(tool);
    const audits = findAuditEvents(events);
    const outputAudit = audits.find((a) => a.lifecycle === "output_validated");

    expect(outputAudit).toBeDefined();
    expect(outputAudit?.validationPassed).toBe(true);
  });

  test("retry_attempt audit event is emitted on each retry", async () => {
    let callCount = 0;
    const tool: TuvrenToolDefinition = {
      name: "ax005-retry",
      description: "idempotent tool",
      idempotent: true,
      maxRetries: 1,
      inputSchema: { type: "object" },
      execute() {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("transient");
        }
        return { ok: true };
      },
    };

    const events = await runWithTool(tool);
    const audits = findAuditEvents(events);
    const retryAudits = audits.filter((a) => a.lifecycle === "retry_attempt");

    expect(retryAudits).toHaveLength(1);
    expect(retryAudits[0]?.attempt).toBe(1);
  });

  test("rate_limited audit event is emitted when budget is exceeded", async () => {
    const harness = createFakeKernelHarness();
    const toolName = "ax005-rate-limit";
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "rate limited tool",
      inputSchema: { type: "object" },
      execute() {
        return { ok: true };
      },
    };

    const driver: RuntimeDriver = {
      id: "ax005-driver",
      async execute(context) {
        const toolMessages = context.messages.filter((m) => m.role === "tool");
        if (toolMessages.length < 2) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: `call-${toolMessages.length}`,
                  input: {},
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
      defaultDriverId: "ax005-driver",
      driverRegistry: createBaseDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [tool],
        serverExecution: { rateLimit: { maxCalls: 1, windowMs: 60_000 } },
      },
      signal: textSignal("ax005 rate limit"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const audits = findAuditEvents(events);
    const rateLimitAudit = audits.find((a) => a.lifecycle === "rate_limited");

    expect(rateLimitAudit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// No secrets in audit signals
// ---------------------------------------------------------------------------

describe("KRT-AX005 — no secrets in audit signals", () => {
  test("tool.audit event has no input, output, or metadata fields", async () => {
    const tool: TuvrenToolDefinition = {
      name: "ax005-no-secrets",
      description: "tool with sensitive metadata",
      inputSchema: { type: "object" },
      metadata: {
        apiKey: "secret-key-12345",
        endpoint: "https://internal.api",
      },
      execute() {
        return { password: "should-not-appear" };
      },
    };

    const events = await runWithTool(tool);
    const audits = findAuditEvents(events);

    for (const audit of audits) {
      expect("input" in audit).toBe(false);
      expect("output" in audit).toBe(false);
      expect("metadata" in audit).toBe(false);
      expect("password" in audit).toBe(false);
      expect("apiKey" in audit).toBe(false);
      expect("secret" in audit).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// CapabilityObservation: full lifecycle control
// ---------------------------------------------------------------------------

describe("KRT-AX005 — CapabilityObservation for tuvren-server", () => {
  test("tuvren-server observation reports full observe/persist/resume/cancel/retry/audit", () => {
    const observation = observationForClass("tuvren-server");

    expect(observation.canAudit).toBe(true);
    expect(observation.canCancel).toBe(true);
    expect(observation.canObserveIntermediate).toBe(true);
    expect(observation.canPersistResult).toBe(true);
    expect(observation.canResume).toBe(true);
    expect(observation.canRetry).toBe(true);
    expect(observation.executionClass).toBe("tuvren-server");
  });

  test("provider-native class does not claim audit capability it lacks", () => {
    const observation = observationForClass("provider-native");
    expect(observation.canAudit).toBe(false);
    expect(observation.canCancel).toBe(false);
    expect(observation.canRetry).toBe(false);
  });
});
