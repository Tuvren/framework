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
 * KRT-AY003 + KRT-AY005: Provider-attribution event recording and
 * continuation-state secret isolation.
 *
 * Acceptance criteria:
 * - Pre-staged provider tool messages emit tool.start + tool.result events
 *   with attribution.owner === "provider" and correct executionClass.
 * - Observation flags (canAudit, canCancel, canRetry, canResume) are false for
 *   both provider-native and provider-mediated classes.
 * - No tool.audit event is emitted for provider-owned invocations.
 * - providerContinuity carried in providerMetadata never surfaces in any
 *   emitted event payload.
 */

import { describe, expect, test } from "bun:test";
import type { RuntimeDriver } from "@tuvren/core/driver";
import type { TuvrenMessage } from "@tuvren/core/messages";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  collectEvents,
  textSignal,
} from "./runtime-core-test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProviderToolMessage(opts: {
  callId: string;
  executionClass: "provider-native" | "provider-mediated";
  name: string;
  output: unknown;
  /** Optional extra keys to include in providerMetadata (e.g. continuity). */
  extraMeta?: Record<string, unknown>;
}): TuvrenMessage {
  return {
    role: "tool",
    parts: [
      {
        callId: opts.callId,
        name: opts.name,
        output: opts.output,
        providerMetadata: {
          ...(opts.extraMeta ?? {}),
          executionClass: opts.executionClass,
          owner: "provider",
          providerCallId: opts.callId,
        },
        type: "tool_result",
      },
    ],
  };
}

function makeProviderDriver(
  executionClass: "provider-native" | "provider-mediated",
  extraMeta?: Record<string, unknown>
): RuntimeDriver {
  return {
    id: "ay003-driver",
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            buildProviderToolMessage({
              callId: "prov-call-ay003",
              executionClass,
              extraMeta,
              name: "code_execution",
              output: { outputs: [{ text: "42", type: "text" }] },
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
}

async function runWithProviderTool(
  executionClass: "provider-native" | "provider-mediated",
  extraMeta?: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const harness = createFakeKernelHarness();
  const driver = makeProviderDriver(executionClass, extraMeta);
  const runtime = createTuvrenRuntime({
    defaultDriverId: "ay003-driver",
    driverRegistry: createBaseDriverRegistry([driver]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary" },
    signal: textSignal("ay003 test"),
    threadId: thread.threadId,
  });
  const events = await collectEvents(handle.events());
  return events as unknown as Record<string, unknown>[];
}

function filterByType(
  events: Record<string, unknown>[],
  type: string
): Record<string, unknown>[] {
  return events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// KRT-AY003: provider attribution event recording
// ---------------------------------------------------------------------------

describe("KRT-AY003 — provider-native attribution events", () => {
  test("emits tool.start with owner:provider and executionClass:provider-native", async () => {
    const events = await runWithProviderTool("provider-native");
    const starts = filterByType(events, "tool.start");
    const providerStart = starts.find(
      (e) =>
        typeof e.attribution === "object" &&
        e.attribution !== null &&
        (e.attribution as Record<string, unknown>).owner === "provider"
    );

    expect(providerStart).toBeDefined();
    const attr = providerStart?.attribution as Record<string, unknown>;
    expect(attr.owner).toBe("provider");
    expect(attr.executionClass).toBe("provider-native");
    expect(providerStart?.callId).toBe("prov-call-ay003");
    expect(providerStart?.name).toBe("code_execution");
    expect(typeof providerStart?.timestamp).toBe("number");
  });

  test("emits tool.result with owner:provider and provider-native output", async () => {
    const events = await runWithProviderTool("provider-native");
    const results = filterByType(events, "tool.result");
    const providerResult = results.find(
      (e) =>
        typeof e.attribution === "object" &&
        e.attribution !== null &&
        (e.attribution as Record<string, unknown>).owner === "provider"
    );

    expect(providerResult).toBeDefined();
    const attr = providerResult?.attribution as Record<string, unknown>;
    expect(attr.owner).toBe("provider");
    expect(attr.executionClass).toBe("provider-native");
    expect(providerResult?.callId).toBe("prov-call-ay003");
    expect(providerResult?.name).toBe("code_execution");
    expect(providerResult?.output).toEqual({
      outputs: [{ text: "42", type: "text" }],
    });
  });

  test("observation flags are all false for provider-native class", async () => {
    const events = await runWithProviderTool("provider-native");
    const results = filterByType(events, "tool.result");
    const providerResult = results.find(
      (e) =>
        typeof e.attribution === "object" &&
        e.attribution !== null &&
        (e.attribution as Record<string, unknown>).owner === "provider"
    );

    expect(providerResult).toBeDefined();
    const obs = (providerResult?.attribution as Record<string, unknown>)
      .observation as Record<string, unknown>;
    expect(obs.canAudit).toBe(false);
    expect(obs.canCancel).toBe(false);
    expect(obs.canRetry).toBe(false);
    expect(obs.canResume).toBe(false);
    expect(obs.canPersistResult).toBe(true);
  });

  test("does not emit tool.audit event for provider-native invocation", async () => {
    const events = await runWithProviderTool("provider-native");
    const audits = filterByType(events, "tool.audit");
    expect(audits).toHaveLength(0);
  });
});

describe("KRT-AY003 — provider-mediated attribution events", () => {
  test("emits tool.start with owner:provider and executionClass:provider-mediated", async () => {
    const events = await runWithProviderTool("provider-mediated");
    const starts = filterByType(events, "tool.start");
    const providerStart = starts.find(
      (e) =>
        typeof e.attribution === "object" &&
        e.attribution !== null &&
        (e.attribution as Record<string, unknown>).owner === "provider"
    );

    expect(providerStart).toBeDefined();
    const attr = providerStart?.attribution as Record<string, unknown>;
    expect(attr.owner).toBe("provider");
    expect(attr.executionClass).toBe("provider-mediated");
  });

  test("emits tool.result with owner:provider and provider-mediated executionClass", async () => {
    const events = await runWithProviderTool("provider-mediated");
    const results = filterByType(events, "tool.result");
    const providerResult = results.find(
      (e) =>
        typeof e.attribution === "object" &&
        e.attribution !== null &&
        (e.attribution as Record<string, unknown>).owner === "provider"
    );

    expect(providerResult).toBeDefined();
    const attr = providerResult?.attribution as Record<string, unknown>;
    expect(attr.executionClass).toBe("provider-mediated");
    expect(attr.owner).toBe("provider");
  });

  test("does not emit tool.audit event for provider-mediated invocation", async () => {
    const events = await runWithProviderTool("provider-mediated");
    const audits = filterByType(events, "tool.audit");
    expect(audits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// KRT-AY005: continuation-state secret isolation
//
// Scope: these tests validate the event-emitter path owned by this commit.
// emitProviderToolAttributionEvents only uses explicit fields (callId, name,
// output, isError) and never spreads providerMetadata into any event payload.
//
// Durable-lineage isolation is guaranteed structurally at the bridge layer:
// continuityToProviderOptions in ai-sdk-provider-bridge.ts consumes
// TuvrenPrompt.providerContinuity into providerOptions for the next call, and
// buildPrestagedProviderToolMessage never includes providerContinuity in the
// staged tool message's providerMetadata. So in the production data flow
// providerContinuity never rides inside a staged tool-message part at all.
// ---------------------------------------------------------------------------

describe("KRT-AY005 — providerContinuity not in emitted events (event-emitter scope)", () => {
  test("providerContinuity present in providerMetadata does not appear in any emitted event", async () => {
    // Simulate a worst-case scenario where providerContinuity is present in the
    // pre-staged message's providerMetadata (production path: bridge never does
    // this). The emitter must not propagate it to any event regardless.
    const events = await runWithProviderTool("provider-native", {
      providerContinuity: {
        sessionToken: "secret-abc-123",
        continuationUrl: "https://provider.example.com/continue",
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("providerContinuity");
    expect(serialized).not.toContain("secret-abc-123");
  });

  test("providerCallId in providerMetadata does not appear in tool.start input field", async () => {
    const events = await runWithProviderTool("provider-native");
    const starts = filterByType(events, "tool.start");
    const providerStart = starts.find(
      (e) =>
        typeof e.attribution === "object" &&
        e.attribution !== null &&
        (e.attribution as Record<string, unknown>).owner === "provider"
    );
    // tool.start input is null — the "not observed" sentinel used so the event
    // passes assertTuvrenStreamEvent validation (BA002). Asserting null (not
    // undefined) locks in the exact post-BA002 contract.
    expect(providerStart?.input).toBe(null);
  });
});
