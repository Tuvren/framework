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

// biome-ignore-all lint/suspicious/useAwait: adapter operations must return Promise<AdapterProjection> per adapter contract
import {
  createCapabilityPolicyEngine,
  createDriverRegistry,
  createTuvrenRuntime,
} from "@tuvren/runtime";
import {
  type AdapterProjection,
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceKernelHarness,
  createStaticDriver,
  DRIVER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

/**
 * Asserts all exposure-time policy dimensions (BB001 residency, BB002 risk-class
 * cap, BB003 active-endpoint) using standalone engine calls.
 */
export async function runCapabilityPolicyExposureDimensions(): Promise<AdapterProjection> {
  const engine = createCapabilityPolicyEngine({
    maxExposedRiskClass: "medium",
  });

  const residencyDeniedId = "eu.data.tool";
  const residencyAllowedId = "us.data.tool";
  const riskDeniedId = "dangerous.delete";
  const endpointDeniedId = "client.browse";
  const permittedId = "safe.compute";

  const capabilityMetadata = new Map([
    [residencyDeniedId, { requiredResidency: "eu" }],
    [residencyAllowedId, { requiredResidency: "us" }],
    [riskDeniedId, { riskClass: "high" as const }],
    [endpointDeniedId, { requiresActiveEndpoint: true }],
  ]);

  const context = {
    allowedResidencies: ["us"] as readonly string[],
    capabilityMetadata,
    modelId: "conformance-model",
    permissions: [] as string[],
    providerId: "conformance-provider",
    unavailableCapabilityIds: new Set([endpointDeniedId]),
  };

  const surfaces = [
    residencyDeniedId,
    residencyAllowedId,
    riskDeniedId,
    endpointDeniedId,
    permittedId,
  ].map((id) => ({
    capabilityId: id,
    description: `test surface for ${id}`,
    inputSchema: { type: "object" as const },
    name: id,
  }));

  const decisions = engine.evaluateExposure(surfaces, context);
  const byName = new Map(decisions.map((d) => [d.surfaceName, d]));

  const evidence = {
    capabilityPolicy: {
      exposure: {
        endpointDenied: {
          exposed: byName.get(endpointDeniedId)?.exposed,
          reason: byName.get(endpointDeniedId)?.reason ?? "",
        },
        permitted: {
          exposed: byName.get(permittedId)?.exposed,
        },
        residencyAllowed: {
          exposed: byName.get(residencyAllowedId)?.exposed,
        },
        residencyDenied: {
          exposed: byName.get(residencyDeniedId)?.exposed,
          reason: byName.get(residencyDeniedId)?.reason ?? "",
        },
        riskDenied: {
          exposed: byName.get(riskDeniedId)?.exposed,
          reason: byName.get(riskDeniedId)?.reason ?? "",
        },
      },
    },
  };

  return { evidence, result: evidence };
}

/**
 * Asserts all invocation-time policy dimensions (BB001 residency, BB003 presence,
 * BB004 credential-boundary) using standalone engine calls.
 */
export async function runCapabilityPolicyInvocationDimensions(): Promise<AdapterProjection> {
  const engine = createCapabilityPolicyEngine();

  const residencyDeniedId = "eu.data.tool";
  const presenceDeniedId = "human.review";
  const credentialDeniedId = "storage.write";
  const permittedId = "safe.compute";

  const capabilityMetadata = new Map([
    [residencyDeniedId, { requiredResidency: "eu" }],
    [presenceDeniedId, { requiresUserPresence: true }],
    [credentialDeniedId, { requiredCredentialScopes: ["write"] as const }],
  ]);

  const context = {
    allowedResidencies: ["us"] as readonly string[],
    availableCredentialScopes: ["read"] as readonly string[],
    capabilityMetadata,
    modelId: "conformance-model",
    permissions: [] as string[],
    providerId: "conformance-provider",
    userPresent: false,
  };

  const makeBinding = (capabilityId: string) => ({
    capabilityId,
    endpoint: { id: "tuvren.in-process", kind: "tuvren-in-process" as const },
    executionClass: "tuvren-server" as const,
  });

  const residencyDecision = engine.evaluateInvocation(
    makeBinding(residencyDeniedId),
    context
  );
  const presenceDecision = engine.evaluateInvocation(
    makeBinding(presenceDeniedId),
    context
  );
  const credentialDecision = engine.evaluateInvocation(
    makeBinding(credentialDeniedId),
    context
  );
  const permittedDecision = engine.evaluateInvocation(
    makeBinding(permittedId),
    context
  );

  const evidence = {
    capabilityPolicy: {
      invocation: {
        credentialDenied: {
          admitted: credentialDecision.admitted,
          reason: credentialDecision.reason ?? "",
        },
        permitted: {
          admitted: permittedDecision.admitted,
        },
        presenceDenied: {
          admitted: presenceDecision.admitted,
          reason: presenceDecision.reason ?? "",
        },
        residencyDenied: {
          admitted: residencyDecision.admitted,
          reason: residencyDecision.reason ?? "",
        },
      },
    },
  };

  return { evidence, result: evidence };
}

/**
 * Asserts policy composition: multiple denying dimensions → composed non-secret
 * reason; same inputs → deterministic outcome.
 */
export async function runCapabilityPolicyComposition(): Promise<AdapterProjection> {
  const engine = createCapabilityPolicyEngine({
    maxExposedRiskClass: "medium",
  });

  const multiDenyId = "multi.deny";
  const capabilityMetadata = new Map([
    [multiDenyId, { requiredResidency: "eu", riskClass: "high" as const }],
  ]);
  const context = {
    allowedResidencies: ["us"] as readonly string[],
    capabilityMetadata,
    modelId: "conformance-model",
    permissions: [] as string[],
    providerId: "conformance-provider",
  };

  const surface = {
    capabilityId: multiDenyId,
    description: "multi-deny surface",
    inputSchema: { type: "object" as const },
    name: multiDenyId,
  };

  const d1 = engine.evaluateExposure([surface], context);
  const d2 = engine.evaluateExposure([surface], context);

  const multiDenyInvokeId = "multi.invoke.deny";
  const invocationMetadata = new Map([
    [
      multiDenyInvokeId,
      {
        requiredCredentialScopes: ["write"] as const,
        requiredResidency: "eu",
      },
    ],
  ]);
  const invocationContext = {
    allowedResidencies: ["us"] as readonly string[],
    availableCredentialScopes: [] as readonly string[],
    capabilityMetadata: invocationMetadata,
    modelId: "conformance-model",
    permissions: [] as string[],
    providerId: "conformance-provider",
  };
  const binding = {
    capabilityId: multiDenyInvokeId,
    endpoint: { id: "tuvren.in-process", kind: "tuvren-in-process" as const },
    executionClass: "tuvren-server" as const,
  };
  const inv1 = engine.evaluateInvocation(binding, invocationContext);
  const inv2 = engine.evaluateInvocation(binding, invocationContext);

  const evidence = {
    capabilityPolicy: {
      composition: {
        exposure: {
          exposed1: d1[0]?.exposed,
          exposed2: d2[0]?.exposed,
          reason: d1[0]?.reason ?? "",
        },
        invocation: {
          admitted1: inv1.admitted,
          admitted2: inv2.admitted,
          reason: inv1.reason ?? "",
        },
      },
    },
  };

  return { evidence, result: evidence };
}

/**
 * Wired proof: a capability violating the credential boundary is denied at
 * invocation time and surfaces as tool.result with isError: true.
 * The tool body must never execute.
 */
export async function runCapabilityPolicyWiredInvocationDenial(): Promise<AdapterProjection> {
  const credentialDeniedToolName = "storage.write";
  let toolExecuted = false;

  const harness = createConformanceKernelHarness();
  const engine = createCapabilityPolicyEngine();

  const driver = createStaticDriver(async (ctx) => {
    await Promise.resolve();
    if (!ctx.messages.some((m) => m.role === "tool")) {
      return {
        messages: [
          assistantToolCalls([
            {
              callId: "policy-wired-1",
              input: {},
              name: credentialDeniedToolName,
            },
          ]),
        ],
        resolution: { type: "continue_iteration" as const },
        toolExecutionMode: "parallel",
      };
    }
    return {
      messages: [assistantText("policy wired test done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });

  const runtime = createTuvrenRuntime({
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
    kernel: harness.kernel,
  });

  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      capabilityPolicyEngine: engine,
      name: AGENT_NAME,
      policyContextInputs: {
        availableCredentialScopes: ["read"], // write scope absent
      },
      tools: [
        {
          description: "Requires write credential scope",
          execute() {
            toolExecuted = true;
            return { ok: true };
          },
          inputSchema: { type: "object" },
          name: credentialDeniedToolName,
          requiredCredentialScopes: ["write"],
        },
      ],
    },
    signal: textSignal("capability policy wired denial conformance"),
    threadId: thread.threadId,
  });

  const events = await collectValues(handle.events());

  const toolResultEvent = events.find((e) => e.type === "tool.result");

  const evidence = {
    capabilityPolicy: {
      wiredDenial: {
        toolBodyNotExecuted: !toolExecuted,
        toolResultIsError:
          toolResultEvent?.type === "tool.result"
            ? toolResultEvent.isError === true
            : false,
      },
    },
  };

  return { evidence, result: evidence };
}

/**
 * Wired proof: nonRetryable: true suppresses retry even when idempotent: true.
 */
export async function runCapabilityPolicyNonretryablePolicy(): Promise<AdapterProjection> {
  const toolName = "non.retryable.op";
  let attemptCount = 0;

  const harness = createConformanceKernelHarness();

  const driver = createStaticDriver(async (ctx) => {
    await Promise.resolve();
    if (!ctx.messages.some((m) => m.role === "tool")) {
      return {
        messages: [
          assistantToolCalls([
            { callId: "nonretry-call-1", input: {}, name: toolName },
          ]),
        ],
        resolution: { type: "continue_iteration" as const },
        toolExecutionMode: "parallel",
      };
    }
    return {
      messages: [assistantText("nonretryable policy done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });

  const runtime = createTuvrenRuntime({
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
    kernel: harness.kernel,
  });

  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      name: AGENT_NAME,
      tools: [
        {
          description: "Non-retryable despite idempotent",
          execute() {
            attemptCount += 1;
            throw new Error("transient failure");
          },
          idempotent: true,
          inputSchema: { type: "object" },
          maxRetries: 3,
          name: toolName,
          nonRetryable: true,
        },
      ],
    },
    signal: textSignal("nonretryable policy conformance"),
    threadId: thread.threadId,
  });

  await collectValues(handle.events());

  const evidence = {
    capabilityPolicy: {
      nonRetryablePolicy: {
        attemptCount,
      },
    },
  };

  return { evidence, result: evidence };
}

/**
 * Wired proof: a high-risk capability with requireApprovalForRiskClass configured
 * pauses the turn awaiting approval rather than executing the tool body.
 */
export async function runCapabilityPolicyWiredRiskApproval(): Promise<AdapterProjection> {
  const highRiskToolName = "dangerous.delete";
  let toolExecuted = false;

  const harness = createConformanceKernelHarness();
  const engine = createCapabilityPolicyEngine({
    requireApprovalForRiskClass: "high",
  });

  const driver = createStaticDriver(async (ctx) => {
    await Promise.resolve();
    if (!ctx.messages.some((m) => m.role === "tool")) {
      return {
        messages: [
          assistantToolCalls([
            { callId: "risk-approval-1", input: {}, name: highRiskToolName },
          ]),
        ],
        resolution: { type: "continue_iteration" as const },
        toolExecutionMode: "parallel",
      };
    }
    return {
      messages: [assistantText("risk approval gate done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });

  const runtime = createTuvrenRuntime({
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
    kernel: harness.kernel,
  });

  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      capabilityPolicyEngine: engine,
      name: AGENT_NAME,
      tools: [
        {
          description: "High-risk tool requiring approval",
          execute() {
            toolExecuted = true;
            return { deleted: true };
          },
          inputSchema: { type: "object" },
          name: highRiskToolName,
          riskClass: "high",
        },
      ],
    },
    signal: textSignal("capability policy wired risk approval conformance"),
    threadId: thread.threadId,
  });

  await collectValues(handle.events());

  const evidence = {
    capabilityPolicy: {
      wiredRiskApproval: {
        statusPhase: handle.status().phase,
        toolBodyNotExecuted: !toolExecuted,
      },
    },
  };

  return { evidence, result: evidence };
}
