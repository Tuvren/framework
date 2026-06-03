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
 * Conformance adapter operations for the Tuvren-client execution class
 * check set (KRT-AZ006). Each operation returns structured evidence that
 * the shared conformance runner asserts against the tuvren-client-execution-class
 * plan's checks.
 *
 * Adapter rules: no assertion logic, no pass/fail grading, no evidence
 * field names that imply semantic verdicts. Raw observational data only.
 */

import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import {
  createBindingResolver,
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
// Shared helpers
// ---------------------------------------------------------------------------

function makeSingleCallDriver(toolName: string) {
  return createStaticDriver(async (context) => {
    await Promise.resolve();
    if (!context.messages.some((m) => m.role === "tool")) {
      return {
        messages: [
          assistantToolCalls([
            { callId: "az-call-1", input: {}, name: toolName },
          ]),
        ],
        resolution: { type: "continue_iteration" as const },
        toolExecutionMode: "parallel" as const,
      };
    }
    return {
      messages: [assistantText("az006 done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });
}

function makeOkEndpoint(
  endpointId: string,
  capabilityId: string,
  content: unknown
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      {
        capabilityId,
        description: `${capabilityId} conformance cap`,
        inputSchema: { type: "object" },
      },
    ],
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      return Promise.resolve({
        callId: envelope.callId,
        content,
        leaseToken: envelope.leaseToken,
      });
    },
  };
}

function makeClientMcpEndpoint(
  endpointId: string,
  capabilityId: string,
  mcpServerName: string,
  content: unknown
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      {
        capabilityId,
        description: `${capabilityId} client-mcp cap`,
        inputSchema: { type: "object" },
        mcpServerName,
      },
    ],
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      return Promise.resolve({
        callId: envelope.callId,
        content,
        leaseToken: envelope.leaseToken,
      });
    },
  };
}

function makeStaleEndpoint(
  endpointId: string,
  capabilityId: string
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      {
        capabilityId,
        description: `${capabilityId} stale cap`,
        inputSchema: { type: "object" },
      },
    ],
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      return Promise.resolve({
        callId: envelope.callId,
        content: { staleContent: true },
        leaseToken: "stale-token-for-conformance", // will never match the envelope token
      });
    },
  };
}

async function runTurn(
  toolName: string,
  endpoints: AttachedClientEndpoint[],
  clientEndpointBoundary?: import("@tuvren/core/capabilities").ClientEndpointBoundary
) {
  const harness = createConformanceKernelHarness();
  const driver = makeSingleCallDriver(toolName);
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      name: AGENT_NAME,
      clientEndpoints: endpoints,
      ...(clientEndpointBoundary === undefined
        ? {}
        : { clientEndpointBoundary }),
    },
    signal: textSignal("az006 conformance"),
    threadId: thread.threadId,
  });
  const events = await collectValues(handle.events());
  const result = await handle.awaitResult();
  return { events, result };
}

function findAllEvents(events: unknown[], type: string) {
  return events.filter(
    (e) => (e as Record<string, unknown>).type === type
  ) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Operation: runtime.tuvren-client.lifecycle
//
// Exercises AZ001–AZ005 in one structured operation:
// - Normal attach/dispatch/result capture (AZ001, AZ002)
// - Unavailable endpoint (detach → capability_binding_unavailable) (AZ003)
// - Stale late-completion (mismatched leaseToken → stale content not surfaced) (AZ003)
// - Client-side MCP binding classification (AZ004)
// - Partial observability limits (no tool.audit events) (AZ005)
// ---------------------------------------------------------------------------

export async function runTuvrenClientLifecycle(): Promise<AdapterProjection> {
  // --- 1. Normal dispatch: attach endpoint, dispatch, capture result ---
  const NORMAL_CAP = "az006.client.normal";
  const normalEndpoint = makeOkEndpoint("ep-normal", NORMAL_CAP, {
    conformanceResult: "ok",
  });
  const normalRun = await runTurn(NORMAL_CAP, [normalEndpoint]);
  const normalResultEvents = findAllEvents(normalRun.events, "tool.result");
  const normalStartEvents = findAllEvents(normalRun.events, "tool.start");
  const normalAuditEvents = findAllEvents(normalRun.events, "tool.audit");
  const normalResultEvent = normalResultEvents[0] as
    | Record<string, unknown>
    | undefined;

  // --- 2. Unavailable endpoint: detach before turn, assert typed code ---
  const UNAVAILABLE_CAP = "az006.client.unavailable";
  const unavailableEndpoint = makeOkEndpoint(
    "ep-unavailable",
    UNAVAILABLE_CAP,
    { shouldNotReach: true }
  );
  const preDetachedBoundary = createClientEndpointBoundary([
    unavailableEndpoint,
  ]);
  preDetachedBoundary.detach("ep-unavailable");
  const unavailableRun = await runTurn(
    UNAVAILABLE_CAP,
    [unavailableEndpoint],
    preDetachedBoundary
  );
  const unavailableResultEvents = findAllEvents(
    unavailableRun.events,
    "tool.result"
  );
  const unavailableResultEvent = unavailableResultEvents[0] as
    | Record<string, unknown>
    | undefined;
  const unavailableOutput = unavailableResultEvent?.output as
    | Record<string, unknown>
    | undefined;

  // --- 3. Stale late-completion: endpoint echoes wrong leaseToken ---
  const STALE_CAP = "az006.client.stale";
  const staleEndpoint = makeStaleEndpoint("ep-stale", STALE_CAP);
  const staleRun = await runTurn(STALE_CAP, [staleEndpoint]);
  const staleResultEvents = findAllEvents(staleRun.events, "tool.result");
  const staleResultEvent = staleResultEvents[0] as
    | Record<string, unknown>
    | undefined;
  const staleOutput = staleResultEvent?.output as
    | Record<string, unknown>
    | undefined;

  // --- 4. Client-side MCP binding classification ---
  const CLIENT_MCP_CAP = "az006.client.mcp";
  const clientMcpEndpoint = makeClientMcpEndpoint(
    "ep-mcp",
    CLIENT_MCP_CAP,
    "az006-mcp-server",
    { mcpConformanceResult: "ok" }
  );
  const mcpRun = await runTurn(CLIENT_MCP_CAP, [clientMcpEndpoint]);
  const mcpResultEvents = findAllEvents(mcpRun.events, "tool.result");
  const mcpAuditEvents = findAllEvents(mcpRun.events, "tool.audit");

  // Resolve the binding for the client-side MCP capability via the binding resolver
  const resolver = createBindingResolver();
  const mcpBinding = resolver.resolveFromToolDefinition({
    name: CLIENT_MCP_CAP,
    description: "client mcp",
    inputSchema: { type: "object" },
    execute: () => Promise.resolve(undefined),
    metadata: { clientEndpointId: "ep-mcp", mcpServerName: "az006-mcp-server" },
  });

  return {
    result: {
      tuvrenClient: {
        normal: {
          status: normalRun.result.status,
          toolStartCount: normalStartEvents.length,
          toolResultCount: normalResultEvents.length,
          toolAuditCount: normalAuditEvents.length,
          toolResultIsError: normalResultEvent?.isError === true,
        },
        unavailable: {
          status: unavailableRun.result.status,
          toolResultIsError: unavailableResultEvent?.isError === true,
          toolResultOutputCode:
            typeof unavailableOutput?.code === "string"
              ? unavailableOutput.code
              : null,
        },
        stale: {
          toolResultIsError: staleResultEvent?.isError === true,
          toolResultOutputCode:
            typeof staleOutput?.code === "string" ? staleOutput.code : null,
          staleContentInResult:
            typeof staleOutput === "object" &&
            staleOutput !== null &&
            "staleContent" in staleOutput &&
            staleOutput.staleContent === true,
        },
        clientMcp: {
          status: mcpRun.result.status,
          toolResultCount: mcpResultEvents.length,
          toolAuditCount: mcpAuditEvents.length,
          bindingExecutionClass: mcpBinding.executionClass,
          bindingEndpointKind: mcpBinding.endpoint.kind,
        },
      },
    },
  };
}
