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

// biome-ignore-all lint/suspicious/useAwait: test drivers intentionally match async contracts
import { describe, expect, test } from "bun:test";
import type {
  Binding,
  CapabilityPolicyContext,
  ToolSurface,
} from "@tuvren/core/capabilities";
import type { RuntimeDriver } from "@tuvren/core/driver";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createCapabilityPolicyEngine,
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

function makeSurface(name: string, capabilityId: string): ToolSurface {
  return {
    name,
    description: `surface for ${capabilityId}`,
    inputSchema: { type: "object" },
    capabilityId,
  };
}

function makeBinding(
  capabilityId: string,
  endpointKind: Binding["endpoint"]["kind"] = "tuvren-in-process"
): Binding {
  return {
    capabilityId,
    executionClass: "tuvren-server",
    endpoint: { kind: endpointKind, id: "local" },
  };
}

const defaultContext: CapabilityPolicyContext = {
  providerId: "test-provider",
  modelId: "test-model",
  permissions: [],
};

// ---------------------------------------------------------------------------
// Exposure-time: denied surfaces not in model-visible set
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — exposure-time decision point", () => {
  test("all surfaces pass exposure by default with no restrictions", () => {
    const engine = createCapabilityPolicyEngine();
    const surfaces = [
      makeSurface("search", "web.search"),
      makeSurface("exec", "code.execute"),
    ];

    const decisions = engine.evaluateExposure(surfaces, defaultContext);

    expect(decisions.filter((d) => d.exposed)).toHaveLength(2);
  });

  test("denied surfaces are excluded from the model-visible set", () => {
    const engine = createCapabilityPolicyEngine({
      deniedSurfaceNames: new Set(["exec"]),
    });
    const surfaces = [
      makeSurface("search", "web.search"),
      makeSurface("exec", "code.execute"),
    ];

    const decisions = engine.evaluateExposure(surfaces, defaultContext);

    const exposed = decisions
      .filter((d) => d.exposed)
      .map((d) => d.surfaceName);
    const denied = decisions
      .filter((d) => !d.exposed)
      .map((d) => d.surfaceName);
    expect(exposed).toEqual(["search"]);
    expect(denied).toEqual(["exec"]);
  });

  test("a denied surface gets a non-empty reason", () => {
    const engine = createCapabilityPolicyEngine({
      deniedSurfaceNames: new Set(["risky"]),
    });
    const surfaces = [makeSurface("risky", "risky.cap")];

    const decisions = engine.evaluateExposure(surfaces, defaultContext);

    const denied = decisions.find((d) => d.surfaceName === "risky");
    expect(denied?.exposed).toBe(false);
    expect(typeof denied?.reason).toBe("string");
    expect((denied?.reason ?? "").length).toBeGreaterThan(0);
  });

  test("an empty surface list yields an empty decision set", () => {
    const engine = createCapabilityPolicyEngine();
    const decisions = engine.evaluateExposure([], defaultContext);
    expect(decisions).toHaveLength(0);
  });

  test("exposure decisions are returned for every surface (one per surface)", () => {
    const engine = createCapabilityPolicyEngine();
    const surfaces = [
      makeSurface("a", "cap-a"),
      makeSurface("b", "cap-b"),
      makeSurface("c", "cap-c"),
    ];

    const decisions = engine.evaluateExposure(surfaces, defaultContext);

    expect(decisions).toHaveLength(3);
    const names = decisions.map((d) => d.surfaceName);
    expect(names).toContain("a");
    expect(names).toContain("b");
    expect(names).toContain("c");
  });
});

// ---------------------------------------------------------------------------
// Invocation-time: denied invocations as tool.result isError
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — invocation-time decision point", () => {
  test("a non-denied binding is admitted", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = makeBinding("web.search");

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(true);
  });

  test("a denied binding returns admitted: false", () => {
    const engine = createCapabilityPolicyEngine({
      deniedCapabilityIds: new Set(["code.execute"]),
    });
    const binding = makeBinding("code.execute");

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(false);
  });

  test("an invocation denial carries a non-secret reason", () => {
    const engine = createCapabilityPolicyEngine({
      deniedCapabilityIds: new Set(["code.execute"]),
    });
    const binding = makeBinding("code.execute");

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(false);
    expect(typeof decision.reason).toBe("string");
    expect((decision.reason ?? "").length).toBeGreaterThan(0);
  });

  test("decision includes capabilityId matching the binding", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = makeBinding("web.search");

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.capabilityId).toBe("web.search");
    expect(decision.executionClass).toBe("tuvren-server");
  });

  test("admitted: true for a non-denied binding does not assert approval is unnecessary", () => {
    // The baseline engine never sets requiresApproval; that field is reserved
    // for the approval-signal integration (AX/BB). An admitted: true decision
    // means the policy gate did not deny — callers must still route through
    // the existing approval gate in tool-execution.ts. This test documents
    // the current baseline state so a future integrator can see the intent.
    const engine = createCapabilityPolicyEngine();
    const binding = makeBinding("safe.op");

    const decision = engine.evaluateInvocation(binding, defaultContext);

    // The baseline does not produce an approval signal; the approval guarantee
    // is maintained by the existing tool-execution gate, not by this engine.
    expect(decision.admitted).toBe(true);
    expect(decision.requiresApproval).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Framework-owned: policy is above driver discretion
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — framework ownership", () => {
  test("policy engine is independent of driver-supplied context (deterministic)", () => {
    const engine = createCapabilityPolicyEngine({
      deniedSurfaceNames: new Set(["restricted"]),
    });
    const surfaces = [makeSurface("restricted", "cap.restricted")];

    // Called twice with different 'driver' contexts — result must be same
    const d1 = engine.evaluateExposure(surfaces, {
      ...defaultContext,
      modelId: "model-a",
    });
    const d2 = engine.evaluateExposure(surfaces, {
      ...defaultContext,
      modelId: "model-b",
    });

    expect(d1[0]?.exposed).toBe(false);
    expect(d2[0]?.exposed).toBe(false);
  });

  test("exposure and invocation decisions are consistent for the same capability", () => {
    const engine = createCapabilityPolicyEngine({
      deniedCapabilityIds: new Set(["dangerous"]),
      deniedSurfaceNames: new Set(["danger-surface"]),
    });
    const surface = makeSurface("danger-surface", "dangerous");
    const binding = makeBinding("dangerous");

    const exposureDecisions = engine.evaluateExposure(
      [surface],
      defaultContext
    );
    const invocationDecision = engine.evaluateInvocation(
      binding,
      defaultContext
    );

    // Both decision points independently deny the same capability
    expect(exposureDecisions[0]?.exposed).toBe(false);
    expect(invocationDecision.admitted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wired invocation-time denial: AgentConfig.capabilityPolicyEngine integration
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — wired invocation-time denial", () => {
  const deniedToolName = "denied-op";

  function makeDenialDriver(): RuntimeDriver {
    return {
      id: "denial-driver",
      async execute(context) {
        if (!context.messages.some((m) => m.role === "tool")) {
          return {
            messages: [
              assistantToolCalls([
                { callId: "deny-call-1", input: {}, name: deniedToolName },
              ]),
            ],
            resolution: { type: "continue_iteration" },
            toolExecutionMode: "parallel",
          };
        }
        return {
          messages: [assistantText("wired denial done")],
          resolution: { reason: "done", type: "end_turn" },
        };
      },
      async resume() {
        throw new Error("resume not expected");
      },
    };
  }

  async function runDeniedTurn(toolExecuted: { value: boolean }) {
    const harness = createFakeKernelHarness();
    const engine = createCapabilityPolicyEngine({
      deniedCapabilityIds: new Set([deniedToolName]),
    });
    const runtime = createTuvrenRuntime({
      defaultDriverId: "denial-driver",
      driverRegistry: createBaseDriverRegistry([makeDenialDriver()]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        capabilityPolicyEngine: engine,
        name: "primary",
        tools: [
          {
            description: "denied tool",
            execute() {
              toolExecuted.value = true;
              return { ok: true };
            },
            inputSchema: { type: "object" },
            name: deniedToolName,
          },
        ],
      },
      signal: textSignal("wired denial test"),
      threadId: thread.threadId,
    });
    return collectEvents(handle.events());
  }

  test("denied capability surfaces as tool.result with isError true", async () => {
    const toolExecuted = { value: false };
    const events = await runDeniedTurn(toolExecuted);
    const toolResult = events.find((e) => e.type === "tool.result");

    expect(toolResult).toBeDefined();
    expect((toolResult as Record<string, unknown> | undefined)?.isError).toBe(
      true
    );
  });

  test("denied capability tool body is never executed", async () => {
    const toolExecuted = { value: false };
    await runDeniedTurn(toolExecuted);

    expect(toolExecuted.value).toBe(false);
  });

  test("a permitted capability in the same turn executes normally", async () => {
    const permittedName = "permitted-op";
    const harness = createFakeKernelHarness();
    const engine = createCapabilityPolicyEngine({
      deniedCapabilityIds: new Set([deniedToolName]),
    });
    const permittedExecuted = { value: false };

    const driver: RuntimeDriver = {
      id: "mixed-driver",
      async execute(context) {
        if (!context.messages.some((m) => m.role === "tool")) {
          return {
            messages: [
              assistantToolCalls([
                { callId: "permitted-call-1", input: {}, name: permittedName },
              ]),
            ],
            resolution: { type: "continue_iteration" },
            toolExecutionMode: "parallel",
          };
        }
        return {
          messages: [assistantText("permitted done")],
          resolution: { reason: "done", type: "end_turn" },
        };
      },
      async resume() {
        throw new Error("resume not expected");
      },
    };

    const runtime = createTuvrenRuntime({
      defaultDriverId: "mixed-driver",
      driverRegistry: createBaseDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        capabilityPolicyEngine: engine,
        name: "primary",
        tools: [
          {
            description: "permitted tool",
            execute() {
              permittedExecuted.value = true;
              return { ok: true };
            },
            inputSchema: { type: "object" },
            name: permittedName,
          },
        ],
      },
      signal: textSignal("permitted tool test"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());

    expect(permittedExecuted.value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BB001: Data-Residency Policy Dimension
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — BB001 data-residency dimension", () => {
  const residencyContext: CapabilityPolicyContext = {
    ...defaultContext,
    allowedResidencies: ["us"],
  };

  const euCapabilityId = "data.eu-only";
  const usCapabilityId = "data.us-compatible";
  const noResidencyCapabilityId = "data.no-residency";

  const capabilityMetadata = new Map([
    [euCapabilityId, { requiredResidency: "eu" }],
    [usCapabilityId, { requiredResidency: "us" }],
    // no entry for noResidencyCapabilityId
  ]);

  const euSurface = makeSurface(euCapabilityId, euCapabilityId);
  const usSurface = makeSurface(usCapabilityId, usCapabilityId);
  const noResidencySurface = makeSurface(
    noResidencyCapabilityId,
    noResidencyCapabilityId
  );

  test("exposure: surface bound to disallowed residency is withheld", () => {
    const engine = createCapabilityPolicyEngine();
    const decisions = engine.evaluateExposure([euSurface], {
      ...residencyContext,
      capabilityMetadata,
    });
    expect(decisions[0]?.exposed).toBe(false);
  });

  test("exposure: surface bound to allowed residency is exposed", () => {
    const engine = createCapabilityPolicyEngine();
    const decisions = engine.evaluateExposure([usSurface], {
      ...residencyContext,
      capabilityMetadata,
    });
    expect(decisions[0]?.exposed).toBe(true);
  });

  test("exposure: surface with no residency requirement is exposed regardless of allowedResidencies", () => {
    const engine = createCapabilityPolicyEngine();
    const decisions = engine.evaluateExposure([noResidencySurface], {
      ...residencyContext,
      capabilityMetadata,
    });
    expect(decisions[0]?.exposed).toBe(true);
  });

  test("exposure: without allowedResidencies in context, all surfaces pass", () => {
    const engine = createCapabilityPolicyEngine();
    const decisions = engine.evaluateExposure([euSurface, usSurface], {
      ...defaultContext,
      capabilityMetadata,
    });
    expect(decisions.every((d) => d.exposed)).toBe(true);
  });

  test("exposure: denial carries a non-secret reason", () => {
    const engine = createCapabilityPolicyEngine();
    const decisions = engine.evaluateExposure([euSurface], {
      ...residencyContext,
      capabilityMetadata,
    });
    const denied = decisions.find((d) => !d.exposed);
    expect(typeof denied?.reason).toBe("string");
    expect((denied?.reason ?? "").length).toBeGreaterThan(0);
  });

  test("invocation: capability bound to disallowed residency is denied", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = makeBinding(euCapabilityId);
    const decision = engine.evaluateInvocation(binding, {
      ...residencyContext,
      capabilityMetadata,
    });
    expect(decision.admitted).toBe(false);
  });

  test("invocation: capability bound to allowed residency is admitted", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = makeBinding(usCapabilityId);
    const decision = engine.evaluateInvocation(binding, {
      ...residencyContext,
      capabilityMetadata,
    });
    expect(decision.admitted).toBe(true);
  });

  test("invocation: capability with no residency requirement is admitted", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = makeBinding(noResidencyCapabilityId);
    const decision = engine.evaluateInvocation(binding, {
      ...residencyContext,
      capabilityMetadata,
    });
    expect(decision.admitted).toBe(true);
  });

  test("invocation: denial carries a non-secret reason", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = makeBinding(euCapabilityId);
    const decision = engine.evaluateInvocation(binding, {
      ...residencyContext,
      capabilityMetadata,
    });
    expect(decision.admitted).toBe(false);
    expect(typeof decision.reason).toBe("string");
    expect((decision.reason ?? "").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BB001: Exposure-time wiring — denied surfaces not presented to model
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — BB001 exposure-time wiring", () => {
  test("exposure-denied surface is not visible to the driver tool registry", async () => {
    const euToolName = "eu-data-tool";
    const usToolName = "us-data-tool";
    const seenToolNames: string[] = [];

    const harness = createFakeKernelHarness();
    const engine = createCapabilityPolicyEngine();

    const driver: RuntimeDriver = {
      id: "exposure-wiring-driver",
      async execute(context) {
        // Record what tools the driver sees
        seenToolNames.push(...context.toolRegistry.list().map((t) => t.name));
        return {
          messages: [assistantText("done")],
          resolution: { reason: "done", type: "end_turn" },
        };
      },
      async resume() {
        throw new Error("resume not expected");
      },
    };

    const runtime = createTuvrenRuntime({
      defaultDriverId: "exposure-wiring-driver",
      driverRegistry: createBaseDriverRegistry([driver]),
      kernel: harness.kernel,
    });

    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        capabilityPolicyEngine: engine,
        name: "primary",
        policyContextInputs: {
          allowedResidencies: ["us"],
        },
        tools: [
          {
            description: "EU-only tool",
            execute: () => ({ ok: true }),
            inputSchema: { type: "object" },
            name: euToolName,
            requiredResidency: "eu",
          },
          {
            description: "US-compatible tool",
            execute: () => ({ ok: true }),
            inputSchema: { type: "object" },
            name: usToolName,
            requiredResidency: "us",
          },
        ],
      },
      signal: textSignal("exposure wiring test"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());

    expect(seenToolNames).not.toContain(euToolName);
    expect(seenToolNames).toContain(usToolName);
  });
});

// ---------------------------------------------------------------------------
// BB002: Risk-Classification Policy Dimension
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — BB002 risk-classification dimension", () => {
  const highRiskCapabilityId = "dangerous.delete-all";
  const mediumRiskCapabilityId = "moderate.write";
  const lowRiskCapabilityId = "safe.read";

  const capabilityMetadata = new Map([
    [highRiskCapabilityId, { riskClass: "high" as const }],
    [mediumRiskCapabilityId, { riskClass: "medium" as const }],
    [lowRiskCapabilityId, { riskClass: "low" as const }],
  ]);

  test("exposure: capability above maxExposedRiskClass is withheld", () => {
    const engine = createCapabilityPolicyEngine({
      maxExposedRiskClass: "medium",
    });
    const surface = makeSurface(highRiskCapabilityId, highRiskCapabilityId);
    const decisions = engine.evaluateExposure([surface], {
      ...defaultContext,
      capabilityMetadata,
    });
    expect(decisions[0]?.exposed).toBe(false);
  });

  test("exposure: capability at maxExposedRiskClass threshold is exposed", () => {
    const engine = createCapabilityPolicyEngine({
      maxExposedRiskClass: "high",
    });
    const surface = makeSurface(highRiskCapabilityId, highRiskCapabilityId);
    const decisions = engine.evaluateExposure([surface], {
      ...defaultContext,
      capabilityMetadata,
    });
    expect(decisions[0]?.exposed).toBe(true);
  });

  test("exposure: low-risk capability is exposed when maxExposedRiskClass is medium", () => {
    const engine = createCapabilityPolicyEngine({
      maxExposedRiskClass: "medium",
    });
    const surface = makeSurface(lowRiskCapabilityId, lowRiskCapabilityId);
    const decisions = engine.evaluateExposure([surface], {
      ...defaultContext,
      capabilityMetadata,
    });
    expect(decisions[0]?.exposed).toBe(true);
  });

  test("exposure: capability with no riskClass is unaffected by maxExposedRiskClass", () => {
    const engine = createCapabilityPolicyEngine({ maxExposedRiskClass: "low" });
    const surface = makeSurface("no-risk.tool", "no-risk.tool");
    const decisions = engine.evaluateExposure([surface], {
      ...defaultContext,
      capabilityMetadata: new Map(),
    });
    expect(decisions[0]?.exposed).toBe(true);
  });

  test("exposure: denial carries a non-secret reason", () => {
    const engine = createCapabilityPolicyEngine({ maxExposedRiskClass: "low" });
    const surface = makeSurface(highRiskCapabilityId, highRiskCapabilityId);
    const decisions = engine.evaluateExposure([surface], {
      ...defaultContext,
      capabilityMetadata,
    });
    expect(decisions[0]?.exposed).toBe(false);
    expect(typeof decisions[0]?.reason).toBe("string");
    expect((decisions[0]?.reason ?? "").length).toBeGreaterThan(0);
  });

  test("invocation: high-risk capability sets requiresApproval when threshold met", () => {
    const engine = createCapabilityPolicyEngine({
      requireApprovalForRiskClass: "high",
    });
    const binding = makeBinding(highRiskCapabilityId);
    const decision = engine.evaluateInvocation(binding, {
      ...defaultContext,
      capabilityMetadata,
    });
    expect(decision.admitted).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });

  test("invocation: medium-risk capability does not require approval when threshold is high", () => {
    const engine = createCapabilityPolicyEngine({
      requireApprovalForRiskClass: "high",
    });
    const binding = makeBinding(mediumRiskCapabilityId);
    const decision = engine.evaluateInvocation(binding, {
      ...defaultContext,
      capabilityMetadata,
    });
    expect(decision.admitted).toBe(true);
    expect(decision.requiresApproval).toBeUndefined();
  });

  test("invocation: low-risk capability is admitted without approval when threshold is medium", () => {
    const engine = createCapabilityPolicyEngine({
      requireApprovalForRiskClass: "medium",
    });
    const binding = makeBinding(lowRiskCapabilityId);
    const decision = engine.evaluateInvocation(binding, {
      ...defaultContext,
      capabilityMetadata,
    });
    expect(decision.admitted).toBe(true);
    expect(decision.requiresApproval).toBeUndefined();
  });

  test("invocation: medium meets medium threshold → requiresApproval", () => {
    const engine = createCapabilityPolicyEngine({
      requireApprovalForRiskClass: "medium",
    });
    const binding = makeBinding(mediumRiskCapabilityId);
    const decision = engine.evaluateInvocation(binding, {
      ...defaultContext,
      capabilityMetadata,
    });
    expect(decision.admitted).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });

  test("risk dimension composes with deny-list: deny takes precedence over approval signal", () => {
    const engine = createCapabilityPolicyEngine({
      deniedCapabilityIds: new Set([highRiskCapabilityId]),
      requireApprovalForRiskClass: "high",
    });
    const binding = makeBinding(highRiskCapabilityId);
    const decision = engine.evaluateInvocation(binding, {
      ...defaultContext,
      capabilityMetadata,
    });
    expect(decision.admitted).toBe(false);
    expect(decision.requiresApproval).toBeUndefined();
  });
});
