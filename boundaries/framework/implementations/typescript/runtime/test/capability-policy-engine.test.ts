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
import type { PolicyDimension } from "../src/index.ts";
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
// Wired exposure-time filtering (applyExposureFilter integration)
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — wired exposure-time filtering", () => {
  const filteredToolName = "filtered-surface";
  const permittedToolName = "permitted-surface";

  async function runExposureFilteredTurn(): Promise<{
    driverToolNames: string[];
  }> {
    const harness = createFakeKernelHarness();
    const capturedNames: string[] = [];

    const engine = createCapabilityPolicyEngine({
      deniedSurfaceNames: new Set([filteredToolName]),
    });

    const driver: RuntimeDriver = {
      id: "exposure-filter-driver",
      async execute(context) {
        for (const t of context.toolRegistry.list()) {
          capturedNames.push(t.name);
        }
        return {
          messages: [assistantText("done")],
          resolution: { reason: "done", type: "end_turn" },
        };
      },
      async resume() {
        throw new Error("unexpected");
      },
    };

    const runtime = createTuvrenRuntime({
      defaultDriverId: "exposure-filter-driver",
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
            description: "denied surface",
            execute() {
              return { ok: true };
            },
            inputSchema: { type: "object" },
            name: filteredToolName,
          },
          {
            description: "permitted surface",
            execute() {
              return { ok: true };
            },
            inputSchema: { type: "object" },
            name: permittedToolName,
          },
        ],
      },
      signal: textSignal("exposure filter test"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());
    return { driverToolNames: capturedNames };
  }

  test("withheld surface is absent from driver tool registry", async () => {
    const { driverToolNames } = await runExposureFilteredTurn();
    expect(driverToolNames).not.toContain(filteredToolName);
  });

  test("permitted surface remains visible in driver tool registry", async () => {
    const { driverToolNames } = await runExposureFilteredTurn();
    expect(driverToolNames).toContain(permittedToolName);
  });
});

// ---------------------------------------------------------------------------
// Data-residency policy dimension (BB001)
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — data-residency dimension (BB001)", () => {
  test("surface with allowed region is exposed normally", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US", "EU"]),
    });
    const surface = {
      ...makeSurface("search", "web.search"),
      endpointRegion: "US",
    };

    const decisions = engine.evaluateExposure([surface], defaultContext);

    expect(decisions[0]?.exposed).toBe(true);
  });

  test("surface with disallowed region is withheld at exposure", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US"]),
    });
    const surface = {
      ...makeSurface("search", "web.search"),
      endpointRegion: "EU",
    };

    const decisions = engine.evaluateExposure([surface], defaultContext);

    expect(decisions[0]?.exposed).toBe(false);
    expect(typeof decisions[0]?.reason).toBe("string");
    expect((decisions[0]?.reason ?? "").length).toBeGreaterThan(0);
  });

  test("surface without region is withheld when allowedRegions is set (strict default)", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US"]),
    });
    const surface = makeSurface("search", "web.search"); // no endpointRegion

    const decisions = engine.evaluateExposure([surface], defaultContext);

    expect(decisions[0]?.exposed).toBe(false);
  });

  test("surface without region is exposed when allowMissingRegion is true", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US"]),
      allowMissingRegion: true,
    });
    const surface = makeSurface("search", "web.search"); // no endpointRegion

    const decisions = engine.evaluateExposure([surface], defaultContext);

    expect(decisions[0]?.exposed).toBe(true);
  });

  test("invocation with allowed endpoint region is admitted", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US", "EU"]),
    });
    const binding = {
      ...makeBinding("web.search"),
      endpoint: {
        id: "local",
        kind: "tuvren-in-process" as const,
        region: "US",
      },
    };

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(true);
  });

  test("invocation with disallowed endpoint region is denied with non-secret reason", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US"]),
    });
    const binding = {
      ...makeBinding("web.search"),
      endpoint: {
        id: "eu-server",
        kind: "tuvren-server" as const,
        region: "EU",
      },
    };

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(false);
    expect(typeof decision.reason).toBe("string");
    expect((decision.reason ?? "").length).toBeGreaterThan(0);
  });

  test("residency denial carries capabilityId and executionClass", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US"]),
    });
    const binding = {
      ...makeBinding("web.search"),
      endpoint: {
        id: "eu-server",
        kind: "tuvren-server" as const,
        region: "EU",
      },
    };

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.capabilityId).toBe("web.search");
    expect(decision.executionClass).toBe("tuvren-server");
  });

  test("compliant capability passes both exposure and invocation decision points", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["EU"]),
    });
    const surface = { ...makeSurface("tool", "cap"), endpointRegion: "EU" };
    const binding = {
      ...makeBinding("cap"),
      endpoint: { id: "eu", kind: "tuvren-in-process" as const, region: "EU" },
    };

    const exposureDecisions = engine.evaluateExposure(
      [surface],
      defaultContext
    );
    const invocationDecision = engine.evaluateInvocation(
      binding,
      defaultContext
    );

    expect(exposureDecisions[0]?.exposed).toBe(true);
    expect(invocationDecision.admitted).toBe(true);
  });

  test("context-level allowedRegions restrict when more restrictive than engine options", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US", "EU"]),
    });
    const contextWithRestriction = {
      ...defaultContext,
      allowedRegions: ["US"],
    };
    const binding = {
      ...makeBinding("web.search"),
      endpoint: {
        id: "eu-server",
        kind: "tuvren-server" as const,
        region: "EU",
      },
    };

    const decision = engine.evaluateInvocation(binding, contextWithRestriction);

    expect(decision.admitted).toBe(false);
  });

  test("no residency check when allowedRegions is not configured", () => {
    const engine = createCapabilityPolicyEngine(); // no allowedRegions
    const binding = {
      ...makeBinding("web.search"),
      endpoint: { id: "remote", kind: "tuvren-server" as const, region: "CN" },
    };

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Risk-classification policy dimension (BB002)
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — risk-classification dimension (BB002)", () => {
  test("low-risk surface is exposed normally with no risk config", () => {
    const engine = createCapabilityPolicyEngine();
    const surface = {
      ...makeSurface("tool", "cap"),
      riskClass: "low" as const,
    };

    const decisions = engine.evaluateExposure([surface], defaultContext);

    expect(decisions[0]?.exposed).toBe(true);
  });

  test("high-risk surface is withheld when maxAllowedRiskClass is medium", () => {
    const engine = createCapabilityPolicyEngine({
      maxAllowedRiskClass: "medium",
    });
    const surface = {
      ...makeSurface("risky", "cap"),
      riskClass: "high" as const,
    };

    const decisions = engine.evaluateExposure([surface], defaultContext);

    expect(decisions[0]?.exposed).toBe(false);
  });

  test("surface without riskClass passes regardless of maxAllowedRiskClass", () => {
    const engine = createCapabilityPolicyEngine({ maxAllowedRiskClass: "low" });
    const surface = makeSurface("tool", "cap"); // no riskClass

    const decisions = engine.evaluateExposure([surface], defaultContext);

    expect(decisions[0]?.exposed).toBe(true);
  });

  test("high-risk exposure denial carries non-secret reason", () => {
    const engine = createCapabilityPolicyEngine({ maxAllowedRiskClass: "low" });
    const surface = {
      ...makeSurface("risky", "cap"),
      riskClass: "high" as const,
    };

    const decisions = engine.evaluateExposure([surface], defaultContext);

    expect(decisions[0]?.exposed).toBe(false);
    expect(typeof decisions[0]?.reason).toBe("string");
    expect((decisions[0]?.reason ?? "").length).toBeGreaterThan(0);
  });

  test("context maxAllowedRiskClass further restricts beyond engine config", () => {
    const engine = createCapabilityPolicyEngine({
      maxAllowedRiskClass: "high",
    });
    const contextMedium = {
      ...defaultContext,
      maxAllowedRiskClass: "low" as const,
    };
    const surface = {
      ...makeSurface("risky", "cap"),
      riskClass: "medium" as const,
    };

    const decisions = engine.evaluateExposure([surface], contextMedium);

    expect(decisions[0]?.exposed).toBe(false);
  });

  test("high-risk binding sets requiresApproval when highRiskRequiresApproval is true", () => {
    const engine = createCapabilityPolicyEngine({
      highRiskRequiresApproval: true,
    });
    const binding = { ...makeBinding("cap"), riskClass: "high" as const };

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(false);
    expect(decision.requiresApproval).toBe(true);
    expect(typeof decision.reason).toBe("string");
  });

  test("low-risk binding is admitted and unaffected by highRiskRequiresApproval", () => {
    const engine = createCapabilityPolicyEngine({
      highRiskRequiresApproval: true,
    });
    const binding = { ...makeBinding("cap"), riskClass: "low" as const };

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(true);
    expect(decision.requiresApproval).toBeUndefined();
  });

  test("medium-risk binding admitted when maxAllowedRiskClass is high", () => {
    const engine = createCapabilityPolicyEngine({
      maxAllowedRiskClass: "high",
    });
    const binding = { ...makeBinding("cap"), riskClass: "medium" as const };

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(true);
  });

  test("risk dimension composes: residency denial is not overridden by risk pass", () => {
    // A low-risk surface in a disallowed region must still be withheld —
    // risk pass does not override a prior framework denial.
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US"]),
      maxAllowedRiskClass: "high",
    });
    const surface = {
      ...makeSurface("tool", "cap"),
      riskClass: "low" as const,
      endpointRegion: "EU",
    };

    const decisions = engine.evaluateExposure([surface], defaultContext);

    expect(decisions[0]?.exposed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// User-presence and active-endpoint requirement (BB003)
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — user-presence and endpoint requirement (BB003)", () => {
  test("surface with requiresActiveEndpoint is withheld when endpointAttached is false", () => {
    const engine = createCapabilityPolicyEngine();
    const surface = {
      ...makeSurface("tool", "cap"),
      requiresActiveEndpoint: true,
    };
    const noEndpointCtx = { ...defaultContext, endpointAttached: false };

    const decisions = engine.evaluateExposure([surface], noEndpointCtx);

    expect(decisions[0]?.exposed).toBe(false);
    expect(typeof decisions[0]?.reason).toBe("string");
    expect((decisions[0]?.reason ?? "").length).toBeGreaterThan(0);
  });

  test("surface with requiresActiveEndpoint is exposed when endpointAttached is true", () => {
    const engine = createCapabilityPolicyEngine();
    const surface = {
      ...makeSurface("tool", "cap"),
      requiresActiveEndpoint: true,
    };
    const withEndpointCtx = { ...defaultContext, endpointAttached: true };

    const decisions = engine.evaluateExposure([surface], withEndpointCtx);

    expect(decisions[0]?.exposed).toBe(true);
  });

  test("surface without requiresActiveEndpoint is unaffected by endpointAttached: false", () => {
    const engine = createCapabilityPolicyEngine();
    const surface = makeSurface("tool", "cap"); // no requiresActiveEndpoint
    const noEndpointCtx = { ...defaultContext, endpointAttached: false };

    const decisions = engine.evaluateExposure([surface], noEndpointCtx);

    expect(decisions[0]?.exposed).toBe(true);
  });

  test("binding with requiresUserPresence is denied when userPresent is false", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = { ...makeBinding("cap"), requiresUserPresence: true };
    const noUserCtx = { ...defaultContext, userPresent: false };

    const decision = engine.evaluateInvocation(binding, noUserCtx);

    expect(decision.admitted).toBe(false);
    expect(typeof decision.reason).toBe("string");
    expect((decision.reason ?? "").length).toBeGreaterThan(0);
  });

  test("binding with requiresUserPresence is admitted when userPresent is true", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = { ...makeBinding("cap"), requiresUserPresence: true };
    const withUserCtx = { ...defaultContext, userPresent: true };

    const decision = engine.evaluateInvocation(binding, withUserCtx);

    expect(decision.admitted).toBe(true);
  });

  test("binding without requiresUserPresence is unaffected by userPresent: false", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = makeBinding("cap"); // no requiresUserPresence
    const noUserCtx = { ...defaultContext, userPresent: false };

    const decision = engine.evaluateInvocation(binding, noUserCtx);

    expect(decision.admitted).toBe(true);
  });

  test("requirements-met capability passes both decision points", () => {
    const engine = createCapabilityPolicyEngine();
    const surface = {
      ...makeSurface("tool", "cap"),
      requiresActiveEndpoint: true,
    };
    const binding = { ...makeBinding("cap"), requiresUserPresence: true };
    const fullCtx = {
      ...defaultContext,
      endpointAttached: true,
      userPresent: true,
    };

    const exposureDecisions = engine.evaluateExposure([surface], fullCtx);
    const invocationDecision = engine.evaluateInvocation(binding, fullCtx);

    expect(exposureDecisions[0]?.exposed).toBe(true);
    expect(invocationDecision.admitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Idempotency/retry policy dimension (BB004)
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — idempotency/retry dimension (BB004)", () => {
  test("binding without idempotencyPolicy leaves policyCanRetry undefined", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = makeBinding("cap"); // no idempotencyPolicy

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(true);
    expect(decision.policyCanRetry).toBeUndefined();
  });

  test("idempotent binding annotates policyCanRetry: true on admitted decision", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = {
      ...makeBinding("cap"),
      idempotencyPolicy: "idempotent" as const,
    };

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(true);
    expect(decision.policyCanRetry).toBe(true);
  });

  test("non-idempotent binding annotates policyCanRetry: false on admitted decision", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = {
      ...makeBinding("cap"),
      idempotencyPolicy: "non-idempotent" as const,
    };

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(true);
    expect(decision.policyCanRetry).toBe(false);
  });

  test("idempotency annotation is absent on a denied decision", () => {
    const engine = createCapabilityPolicyEngine({
      deniedCapabilityIds: new Set(["cap"]),
    });
    const binding = {
      ...makeBinding("cap"),
      idempotencyPolicy: "idempotent" as const,
    };

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(false);
    // Denied decision does not carry retry annotation
    expect(decision.policyCanRetry).toBeUndefined();
  });

  test("idempotency dimension does not affect exposure decisions", () => {
    const engine = createCapabilityPolicyEngine();
    const surface = makeSurface("tool", "cap");

    const decisions = engine.evaluateExposure([surface], defaultContext);

    expect(decisions[0]?.exposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wired idempotency/retry: policyCanRetry governs attempt count (BB004)
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — wired idempotency/retry (BB004)", () => {
  const retryToolName = "retryable-op";

  async function runWithRetryPolicy(
    idempotencyPolicy: "idempotent" | "non-idempotent" | undefined,
    toolIdempotent: boolean,
    throwCount: number
  ): Promise<{ attemptCount: number; succeeded: boolean }> {
    const harness = createFakeKernelHarness();
    let attemptCount = 0;

    const _engineOptions = idempotencyPolicy === undefined ? {} : {};
    const engine = createCapabilityPolicyEngine();

    const runtime = createTuvrenRuntime({
      defaultDriverId: "retry-driver",
      driverRegistry: createBaseDriverRegistry([
        {
          id: "retry-driver",
          async execute(context) {
            if (!context.messages.some((m) => m.role === "tool")) {
              return {
                messages: [
                  assistantToolCalls([
                    { callId: "retry-call-1", input: {}, name: retryToolName },
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
            throw new Error("unexpected");
          },
        },
      ]),
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
            description: "a retryable tool",
            execute() {
              attemptCount += 1;
              if (attemptCount <= throwCount) {
                throw new Error("transient");
              }
              return { ok: true };
            },
            idempotent: toolIdempotent,
            ...(idempotencyPolicy === undefined
              ? {}
              : { metadata: { idempotencyPolicy } }),
            inputSchema: { type: "object" },
            name: retryToolName,
          },
        ],
      },
      signal: textSignal("retry test"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const toolResult = events.find(
      (e) => (e as unknown as Record<string, unknown>).type === "tool.result"
    );
    const succeeded =
      (toolResult as unknown as Record<string, unknown> | undefined)
        ?.isError !== true;

    return { attemptCount, succeeded };
  }

  test("non-idempotent policy suppresses retry even when tool.idempotent is true", async () => {
    // tool.idempotent:true would normally allow retry, but policyCanRetry:false
    // (from idempotencyPolicy:"non-idempotent") must override it.
    const { attemptCount } = await runWithRetryPolicy(
      "non-idempotent",
      true,
      1
    );
    // Only 1 attempt: policy suppresses the retry.
    expect(attemptCount).toBe(1);
  });

  test("idempotent policy enables retry for a tool that does not declare idempotent", async () => {
    // tool.idempotent not set, but policyCanRetry:true enables retry.
    const { attemptCount, succeeded } = await runWithRetryPolicy(
      "idempotent",
      false,
      1
    );
    // 2 attempts: first throws, second succeeds.
    expect(attemptCount).toBe(2);
    expect(succeeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Credential-boundary policy dimension (BB004)
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — credential-boundary dimension (BB004)", () => {
  const engineWithCred = createCapabilityPolicyEngine({
    enforceCredentialBoundary: true,
  });

  test("capability without credentialScope is admitted regardless of entitled scopes", () => {
    const binding = makeBinding("cap"); // no credentialScope

    const decision = engineWithCred.evaluateInvocation(binding, {
      ...defaultContext,
      entitledCredentialScopes: [],
    });

    expect(decision.admitted).toBe(true);
  });

  test("entitled scope in context is admitted", () => {
    const binding = { ...makeBinding("cap"), credentialScope: "files.read" };

    const decision = engineWithCred.evaluateInvocation(binding, {
      ...defaultContext,
      entitledCredentialScopes: ["files.read", "files.write"],
    });

    expect(decision.admitted).toBe(true);
  });

  test("scope not in entitledCredentialScopes is denied", () => {
    const binding = { ...makeBinding("cap"), credentialScope: "admin.access" };

    const decision = engineWithCred.evaluateInvocation(binding, {
      ...defaultContext,
      entitledCredentialScopes: ["files.read"],
    });

    expect(decision.admitted).toBe(false);
    expect(typeof decision.reason).toBe("string");
    expect((decision.reason ?? "").length).toBeGreaterThan(0);
  });

  test("empty entitledCredentialScopes with scope set results in denial", () => {
    const binding = { ...makeBinding("cap"), credentialScope: "files.read" };

    const decision = engineWithCred.evaluateInvocation(binding, {
      ...defaultContext,
      entitledCredentialScopes: [],
    });

    expect(decision.admitted).toBe(false);
  });

  test("denial reason does not expose the scope name", () => {
    const secretScope = "internal.secret.scope.name";
    const binding = { ...makeBinding("cap"), credentialScope: secretScope };

    const decision = engineWithCred.evaluateInvocation(binding, {
      ...defaultContext,
      entitledCredentialScopes: [],
    });

    expect(decision.admitted).toBe(false);
    expect(decision.reason).not.toContain(secretScope);
  });

  test("no credential check when enforceCredentialBoundary is false (default)", () => {
    const engineNoCred = createCapabilityPolicyEngine(); // default: no enforcement
    const binding = { ...makeBinding("cap"), credentialScope: "super.secret" };

    const decision = engineNoCred.evaluateInvocation(binding, {
      ...defaultContext,
      entitledCredentialScopes: [],
    });

    expect(decision.admitted).toBe(true);
  });

  test("credential denial carries admitted: false with capabilityId and executionClass", () => {
    const binding = {
      ...makeBinding("web.search"),
      credentialScope: "search.api",
    };

    const decision = engineWithCred.evaluateInvocation(binding, {
      ...defaultContext,
      entitledCredentialScopes: [],
    });

    expect(decision.admitted).toBe(false);
    expect(decision.capabilityId).toBe("web.search");
    expect(decision.executionClass).toBe("tuvren-server");
  });

  test("endpoint-level credentialScope is also enforced", () => {
    const binding = {
      ...makeBinding("cap"),
      endpoint: {
        id: "secure-endpoint",
        kind: "tuvren-server" as const,
        credentialScope: "endpoint.cred",
      },
    };

    const decision = engineWithCred.evaluateInvocation(binding, {
      ...defaultContext,
      entitledCredentialScopes: [],
    });

    expect(decision.admitted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Policy composition and precedence (BB005)
// ---------------------------------------------------------------------------

describe("CapabilityPolicyEngine — composition and precedence (BB005)", () => {
  test("deny from residency honored even when risk and presence would pass", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US"]),
      maxAllowedRiskClass: "high", // risk: pass
    });
    const binding = {
      ...makeBinding("cap"),
      endpoint: { id: "eu", kind: "tuvren-server" as const, region: "EU" },
      riskClass: "low" as const, // risk: pass
    };
    const ctx = { ...defaultContext, userPresent: true }; // presence: pass

    const decision = engine.evaluateInvocation(binding, ctx);

    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain("residency");
  });

  test("deny from risk honored even when residency and presence pass", () => {
    const engine = createCapabilityPolicyEngine({ maxAllowedRiskClass: "low" });
    const binding = {
      ...makeBinding("cap"),
      endpoint: { id: "us", kind: "tuvren-in-process" as const, region: "US" },
      riskClass: "high" as const,
    };
    // No allowedRegions → residency passes; userPresent not required → presence passes
    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain("risk");
  });

  test("deny from presence honored even when residency and risk pass", () => {
    const engine = createCapabilityPolicyEngine();
    const binding = { ...makeBinding("cap"), requiresUserPresence: true };
    const noUserCtx = { ...defaultContext, userPresent: false };

    const decision = engine.evaluateInvocation(binding, noUserCtx);

    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain("presence");
  });

  test("deny from credential-boundary honored even when all others pass", () => {
    const engine = createCapabilityPolicyEngine({
      enforceCredentialBoundary: true,
    });
    const binding = { ...makeBinding("cap"), credentialScope: "secret.scope" };
    const ctx = { ...defaultContext, entitledCredentialScopes: [] };

    const decision = engine.evaluateInvocation(binding, ctx);

    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain("credential");
  });

  test("deny from deny-list honored even after all framework dimensions pass", () => {
    const engine = createCapabilityPolicyEngine({
      deniedCapabilityIds: new Set(["cap"]),
    });
    const binding = makeBinding("cap");

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(false);
  });

  test("extension dimension denial is honored after all framework dimensions pass", () => {
    const extensionDimension: PolicyDimension = {
      checkExposure: () => null,
      checkInvocation: (binding) => ({
        admitted: false,
        capabilityId: binding.capabilityId,
        executionClass: binding.executionClass,
        reason: "extension-policy: custom denial",
      }),
    };
    const engine = createCapabilityPolicyEngine({
      dimensions: [extensionDimension],
    });
    const binding = makeBinding("cap");

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain("extension-policy");
  });

  test("extension dimension cannot override a prior framework denial", () => {
    const extensionDimension: PolicyDimension = {
      checkExposure: () => null,
      checkInvocation: () => null, // would pass
    };
    const engine = createCapabilityPolicyEngine({
      deniedCapabilityIds: new Set(["cap"]),
      dimensions: [extensionDimension],
    });
    const binding = makeBinding("cap");

    const decision = engine.evaluateInvocation(binding, defaultContext);

    // Framework deny-list denial stands; extension pass does not override it.
    expect(decision.admitted).toBe(false);
  });

  test("multiple extension dimensions compose in declared order, first denial wins", () => {
    const firstDimension: PolicyDimension = {
      checkExposure: () => null,
      checkInvocation: (binding) => ({
        admitted: false,
        capabilityId: binding.capabilityId,
        executionClass: binding.executionClass,
        reason: "first-extension denial",
      }),
    };
    const secondDimension: PolicyDimension = {
      checkExposure: () => null,
      checkInvocation: (binding) => ({
        admitted: false,
        capabilityId: binding.capabilityId,
        executionClass: binding.executionClass,
        reason: "second-extension denial",
      }),
    };
    const engine = createCapabilityPolicyEngine({
      dimensions: [firstDimension, secondDimension],
    });

    const decision = engine.evaluateInvocation(
      makeBinding("cap"),
      defaultContext
    );

    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("first-extension denial");
  });

  test("composed decision is deterministic across identical inputs", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US"]),
    });
    const binding = {
      ...makeBinding("cap"),
      endpoint: { id: "eu", kind: "tuvren-server" as const, region: "EU" },
    };

    const d1 = engine.evaluateInvocation(binding, defaultContext);
    const d2 = engine.evaluateInvocation(binding, defaultContext);

    expect(d1.admitted).toBe(d2.admitted);
    expect(d1.reason).toBe(d2.reason);
  });

  test("denial reason is non-empty on any framework denial", () => {
    const cases = [
      createCapabilityPolicyEngine({ allowedRegions: new Set(["US"]) }),
      createCapabilityPolicyEngine({ maxAllowedRiskClass: "low" }),
      createCapabilityPolicyEngine({ enforceCredentialBoundary: true }),
      createCapabilityPolicyEngine({ deniedCapabilityIds: new Set(["cap"]) }),
    ];
    const bindings = [
      {
        ...makeBinding("cap"),
        endpoint: { id: "eu", kind: "tuvren-server" as const, region: "EU" },
      },
      { ...makeBinding("cap"), riskClass: "high" as const },
      { ...makeBinding("cap"), credentialScope: "secret" },
      makeBinding("cap"),
    ];
    const contexts = [
      defaultContext,
      defaultContext,
      { ...defaultContext, entitledCredentialScopes: [] },
      defaultContext,
    ];

    for (let i = 0; i < cases.length; i++) {
      const engine = cases[i];
      const binding = bindings[i];
      const ctx = contexts[i];
      if (!(engine && binding && ctx)) {
        continue;
      }
      const decision = engine.evaluateInvocation(binding, ctx);
      expect(decision.admitted).toBe(false);
      expect(typeof decision.reason).toBe("string");
      expect((decision.reason ?? "").length).toBeGreaterThan(0);
    }
  });

  test("admitted decision has no reason field", () => {
    const engine = createCapabilityPolicyEngine();
    const decision = engine.evaluateInvocation(
      makeBinding("cap"),
      defaultContext
    );

    expect(decision.admitted).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  test("when two dimensions deny, first dimension's reason is used", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US"]), // residency → denies first
      maxAllowedRiskClass: "low", // risk → would also deny
    });
    const binding = {
      ...makeBinding("cap"),
      endpoint: { id: "eu", kind: "tuvren-server" as const, region: "EU" },
      riskClass: "high" as const,
    };

    const decision = engine.evaluateInvocation(binding, defaultContext);

    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain("residency"); // first dimension wins
  });

  test("exposure: deny from residency honored even when risk would pass", () => {
    const engine = createCapabilityPolicyEngine({
      allowedRegions: new Set(["US"]),
      maxAllowedRiskClass: "high",
    });
    const surface = {
      ...makeSurface("tool", "cap"),
      endpointRegion: "EU",
      riskClass: "low" as const,
    };

    const decisions = engine.evaluateExposure([surface], defaultContext);

    expect(decisions[0]?.exposed).toBe(false);
    expect(decisions[0]?.reason).toContain("residency");
  });
});
