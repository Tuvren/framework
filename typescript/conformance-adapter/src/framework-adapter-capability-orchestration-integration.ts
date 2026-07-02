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

/**
 * Conformance adapter operation for the capability-orchestration-integration
 * check set (KRT-BC001). Exercises all four execution classes in one check
 * set and verifies that exposure-time and invocation-time policy apply with
 * per-class observation limits honored simultaneously.
 *
 * Adapter rules: no assertion logic, no pass/fail grading, no evidence
 * field names that imply semantic verdicts. Raw observational data only.
 */

import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  createBindingResolver,
  createCapabilityPolicyEngine,
  createClientEndpointBoundary,
  createDriverRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";
import {
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createStaticDriver,
  DRIVER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findEvents(events: unknown[], type: string) {
  return events.filter(
    (e) => (e as Record<string, unknown>).type === type
  ) as Record<string, unknown>[];
}

function extractAttr(event: Record<string, unknown> | undefined) {
  const attr = event?.attribution as Record<string, unknown> | undefined;
  const obs = attr?.observation as Record<string, unknown> | undefined;
  return {
    executionClass: attr?.executionClass as string | undefined,
    observation: {
      canAudit: obs?.canAudit as boolean | undefined,
      canPersistResult: obs?.canPersistResult as boolean | undefined,
    },
  };
}

function buildProviderMsg(
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
        output: { conformanceValue: executionClass },
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

function makeSingleCallDriver(toolName: string) {
  return createStaticDriver(async (ctx) => {
    await Promise.resolve();
    if (!ctx.messages.some((m) => m.role === "tool")) {
      return {
        messages: [
          assistantToolCalls([
            { callId: `bc001-call-${toolName}`, input: {}, name: toolName },
          ]),
        ],
        resolution: { type: "continue_iteration" as const },
        toolExecutionMode: "parallel" as const,
      };
    }
    return {
      messages: [assistantText("bc001 done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });
}

function makeProviderDriver(
  executionClass: "provider-native" | "provider-mediated",
  toolName: string
) {
  return createStaticDriver(async (ctx) => {
    await Promise.resolve();
    if (!ctx.messages.some((m) => m.role === "tool")) {
      return {
        messages: [
          buildProviderMsg(
            `bc001-call-${executionClass}`,
            toolName,
            executionClass
          ),
        ],
        resolution: { type: "continue_iteration" as const },
      };
    }
    return {
      messages: [assistantText("bc001 provider done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });
}

// ---------------------------------------------------------------------------
// Operation: runtime.capability-orchestration.integration
//
// Exercises KRT-BC001: one conformance check set covering all four execution
// classes, MCP-as-binding endpoint classification, exposure-time and
// invocation-time policy application, and per-class observation limits.
// ---------------------------------------------------------------------------

export async function runCapabilityOrchestrationIntegration(): Promise<AdapterProjection> {
  // === 1. tuvren-server ===
  const SERVER_TOOL = "bc001.integration.server";
  const serverHarness = createConformanceKernelHarness();
  const serverRuntime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([makeSingleCallDriver(SERVER_TOOL)]),
    kernel: serverHarness.kernel,
  });
  const serverThread = await serverRuntime.createThread({});
  const serverHandle = serverRuntime.executeTurn({
    branchId: serverThread.branchId,
    config: {
      name: AGENT_NAME,
      tools: [
        {
          name: SERVER_TOOL,
          description: "bc001 tuvren-server capability",
          inputSchema: { type: "object" },
          execute: async () => ({ ok: true }),
        },
      ],
    },
    signal: textSignal("bc001 tuvren-server"),
    threadId: serverThread.threadId,
  });
  const serverEvents = await collectValues(serverHandle.events());
  const serverStarts = findEvents(serverEvents, "tool.start");
  const serverResults = findEvents(serverEvents, "tool.result");
  const serverAttr = extractAttr(serverStarts[0]);

  // === 2. provider-native ===
  const PN_TOOL = "bc001.integration.provider_native";
  const pnHarness = createConformanceKernelHarness();
  const pnRuntime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([
      makeProviderDriver("provider-native", PN_TOOL),
    ]),
    kernel: pnHarness.kernel,
  });
  const pnThread = await pnRuntime.createThread({});
  const pnHandle = pnRuntime.executeTurn({
    branchId: pnThread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("bc001 provider-native"),
    threadId: pnThread.threadId,
  });
  const pnEvents = await collectValues(pnHandle.events());
  const pnStarts = findEvents(pnEvents, "tool.start");
  const pnResults = findEvents(pnEvents, "tool.result");
  const pnAttr = extractAttr(pnStarts[0]);

  // === 3. provider-mediated ===
  const PM_TOOL = "bc001.integration.provider_mediated";
  const pmHarness = createConformanceKernelHarness();
  const pmRuntime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([
      makeProviderDriver("provider-mediated", PM_TOOL),
    ]),
    kernel: pmHarness.kernel,
  });
  const pmThread = await pmRuntime.createThread({});
  const pmHandle = pmRuntime.executeTurn({
    branchId: pmThread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("bc001 provider-mediated"),
    threadId: pmThread.threadId,
  });
  const pmEvents = await collectValues(pmHandle.events());
  const pmStarts = findEvents(pmEvents, "tool.start");
  const pmResults = findEvents(pmEvents, "tool.result");
  const pmAttr = extractAttr(pmStarts[0]);

  // === 4. tuvren-client ===
  const CLIENT_CAP = "bc001.integration.client";
  const clientEndpoint: AttachedClientEndpoint = {
    endpointId: "ep-bc001-client",
    advertisedCapabilities: [
      {
        capabilityId: CLIENT_CAP,
        description: "bc001 tuvren-client capability",
        inputSchema: { type: "object" },
      },
    ],
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      return Promise.resolve({
        callId: envelope.callId,
        content: { ok: true },
        leaseToken: envelope.leaseToken,
      });
    },
  };
  const clientBoundary = createClientEndpointBoundary([clientEndpoint]);
  const clientHarness = createConformanceKernelHarness();
  const clientRuntime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([makeSingleCallDriver(CLIENT_CAP)]),
    kernel: clientHarness.kernel,
  });
  const clientThread = await clientRuntime.createThread({});
  const clientHandle = clientRuntime.executeTurn({
    branchId: clientThread.branchId,
    config: {
      name: AGENT_NAME,
      clientEndpoints: [clientEndpoint],
      clientEndpointBoundary: clientBoundary,
    },
    signal: textSignal("bc001 tuvren-client"),
    threadId: clientThread.threadId,
  });
  const clientEvents = await collectValues(clientHandle.events());
  const clientStarts = findEvents(clientEvents, "tool.start");
  const clientResults = findEvents(clientEvents, "tool.result");
  const clientAttr = extractAttr(clientStarts[0]);

  // === 5. MCP-as-binding: resolve endpoint kind via BindingResolver ===
  const resolver = createBindingResolver();
  const mcpTool: TuvrenToolDefinition = {
    name: "bc001-mcp-tool",
    description: "bc001 mcp-server binding",
    inputSchema: { type: "object" },
    execute() {
      return {};
    },
    metadata: { mcp: { serverName: "bc001-mcp-server" } },
  };
  const mcpBinding = resolver.resolveFromToolDefinition(mcpTool);

  // === 6. Policy: exposure-time (standalone API) + invocation-time (wired turn) ===
  const WITHHELD_SURFACE = "bc001-withheld";
  const DENIED_CAP = "bc001-denied";

  const policyEngine = createCapabilityPolicyEngine({
    deniedCapabilityIds: new Set([DENIED_CAP]),
    deniedSurfaceNames: new Set([WITHHELD_SURFACE]),
  });

  // Exposure-time: evaluate policy API directly to capture withheld decision
  const exposureCtx = {
    modelId: "bc001-model",
    permissions: [] as string[],
    providerId: "bc001-provider",
  };
  const exposureDecisions = policyEngine.evaluateExposure(
    [
      {
        capabilityId: "bc001-withheld-cap",
        description: "bc001 withheld surface",
        inputSchema: { type: "object" },
        name: WITHHELD_SURFACE,
      },
    ],
    exposureCtx
  );
  const withheldDecision = exposureDecisions.find(
    (d) => d.surfaceName === WITHHELD_SURFACE
  );

  // Invocation-time: wired turn where driver calls the denied capability
  const policyHarness = createConformanceKernelHarness();
  const policyRuntime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([makeSingleCallDriver(DENIED_CAP)]),
    kernel: policyHarness.kernel,
  });
  const policyThread = await policyRuntime.createThread({});
  const policyHandle = policyRuntime.executeTurn({
    branchId: policyThread.branchId,
    config: {
      name: AGENT_NAME,
      capabilityPolicyEngine: policyEngine,
      tools: [
        {
          name: DENIED_CAP,
          description: "bc001 invocation-denied capability",
          inputSchema: { type: "object" },
          execute: async () => ({ ok: true }),
        },
      ],
    },
    signal: textSignal("bc001 policy invocation"),
    threadId: policyThread.threadId,
  });
  const policyEvents = await collectValues(policyHandle.events());
  const deniedResults = findEvents(policyEvents, "tool.result").filter(
    (e) => e.name === DENIED_CAP
  );
  const deniedResultEvent = deniedResults[0] as
    | Record<string, unknown>
    | undefined;

  return {
    result: {
      integration: {
        tuvrenServer: {
          toolStartCount: serverStarts.length,
          toolResultCount: serverResults.length,
          executionClass: serverAttr.executionClass,
          observation: {
            canAudit: serverAttr.observation.canAudit,
            canPersistResult: serverAttr.observation.canPersistResult,
          },
          mcpEndpointKind: mcpBinding.endpoint.kind,
        },
        providerNative: {
          toolStartCount: pnStarts.length,
          toolResultCount: pnResults.length,
          executionClass: pnAttr.executionClass,
          observation: {
            canAudit: pnAttr.observation.canAudit,
            canPersistResult: pnAttr.observation.canPersistResult,
          },
        },
        providerMediated: {
          toolStartCount: pmStarts.length,
          toolResultCount: pmResults.length,
          executionClass: pmAttr.executionClass,
          observation: {
            canAudit: pmAttr.observation.canAudit,
            canPersistResult: pmAttr.observation.canPersistResult,
          },
        },
        tuvrenClient: {
          toolStartCount: clientStarts.length,
          toolResultCount: clientResults.length,
          executionClass: clientAttr.executionClass,
          observation: {
            canAudit: clientAttr.observation.canAudit,
            canPersistResult: clientAttr.observation.canPersistResult,
          },
        },
        policy: {
          // false when exposure-time policy correctly withholds the surface
          withheldToolReachedModel: withheldDecision?.exposed ?? true,
          // true when invocation-time denial produces isError on tool.result
          deniedToolResultIsError: deniedResultEvent?.isError === true,
        },
      },
    },
  };
}
