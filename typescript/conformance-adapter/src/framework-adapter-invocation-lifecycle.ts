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
 * Conformance adapter operations for the invocation-lifecycle-observation
 * check set (KRT-BA005). Each operation returns structured evidence that
 * the shared certification harness asserts against the plan's checks.
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
import {
  createCapabilityPolicyEngine,
  createClientEndpointBoundary,
  createRunnerRegistry,
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
  createStaticRunner,
  RUNNER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const findEvents = (
  events: unknown[],
  type: string
): Record<string, unknown>[] =>
  events.filter(
    (event): event is Record<string, unknown> =>
      isRecord(event) && event.type === type
  );

const readRecordField = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

const fromSynchronous = <Argument, Value>(
  operation: (argument: Argument) => Value
): ((argument: Argument) => Promise<Value>) =>
  Promise.try.bind<
    typeof Promise,
    [(argument: Argument) => Value],
    [Argument],
    Promise<Value>
  >(Promise, operation);

const buildProviderToolMessage = (
  callId: string,
  name: string,
  executionClass: "provider-native" | "provider-mediated"
): TuvrenMessage => ({
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
  role: "tool",
});

const makeProviderRunner = (
  executionClass: "provider-native" | "provider-mediated",
  toolName: string
) =>
  createStaticRunner((context) => {
    if (!context.messages.some((m) => m.role === "tool")) {
      return {
        messages: [
          buildProviderToolMessage(
            `ba005-call-${executionClass}`,
            toolName,
            executionClass
          ),
        ],
        resolution: { type: "continue_iteration" as const },
      };
    }
    return {
      messages: [assistantText("ba005 done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });

const makeSingleCallRunner = (toolName: string) =>
  createStaticRunner((context) => {
    if (!context.messages.some((m) => m.role === "tool")) {
      return {
        messages: [
          assistantToolCalls([
            { callId: "ba005-call-1", input: {}, name: toolName },
          ]),
        ],
        resolution: { type: "continue_iteration" as const },
        toolExecutionMode: "parallel" as const,
      };
    }
    return {
      messages: [assistantText("ba005 done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });

const makeOkEndpoint = (
  endpointId: string,
  capabilityId: string
): AttachedClientEndpoint => ({
  advertisedCapabilities: [
    {
      capabilityId,
      description: "ba005 cap",
      inputSchema: { type: "object" },
    },
  ],
  dispatch: fromSynchronous(
    (envelope: ClientInvocationEnvelope): ClientReportedResult => ({
      callId: envelope.callId,
      content: { ok: true },
      leaseToken: envelope.leaseToken,
    })
  ),
  endpointId,
});

const makeStaleEndpoint = (
  endpointId: string,
  capabilityId: string
): AttachedClientEndpoint => ({
  advertisedCapabilities: [
    {
      capabilityId,
      description: "ba005 stale cap",
      inputSchema: { type: "object" },
    },
  ],
  dispatch: fromSynchronous(
    (envelope: ClientInvocationEnvelope): ClientReportedResult => ({
      callId: envelope.callId,
      content: { stale: true },
      leaseToken: "wrong-token-ba005",
    })
  ),
  endpointId,
});

const extractAttribution = (event: Record<string, unknown>) => {
  const attribution = readRecordField(event, "attribution");
  const observation = readRecordField(attribution, "observation");
  return {
    canAudit: readRecordField(observation, "canAudit"),
    canCancel: readRecordField(observation, "canCancel"),
    canResume: readRecordField(observation, "canResume"),
    canRetry: readRecordField(observation, "canRetry"),
    executionClass: readRecordField(attribution, "executionClass"),
    owner: readRecordField(attribution, "owner"),
  };
};

// ---------------------------------------------------------------------------
// Operation: runtime.invocation-lifecycle.cross-class
//
// Exercises BA001–BA004 evidence across all four execution classes and the
// policy-denied + stale-late-completion clean-failure cases.
// ---------------------------------------------------------------------------

export const runInvocationLifecycleCrossClass =
  async (): Promise<AdapterProjection> => {
    // --- 1. tuvren-server ---
    const SERVER_TOOL = "ba005.lifecycle.server";
    const serverHarness = createConformanceKernelHarness();
    const serverRuntime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: serverHarness.kernel,
      runnerRegistry: createRunnerRegistry([makeSingleCallRunner(SERVER_TOOL)]),
    });
    const serverThread = await serverRuntime.createThread({});
    const serverHandle = serverRuntime.executeTurn({
      branchId: serverThread.branchId,
      config: {
        name: AGENT_NAME,
        tools: [
          {
            description: "ba005 server",
            execute: () => ({ ok: true }),
            inputSchema: { type: "object" },
            name: SERVER_TOOL,
          },
        ],
      },
      signal: textSignal("ba005 server"),
      threadId: serverThread.threadId,
    });
    const serverEvents = await collectValues(serverHandle.events());
    const serverStarts = findEvents(serverEvents, "tool.start");
    const serverResults = findEvents(serverEvents, "tool.result");
    const serverAudits = findEvents(serverEvents, "tool.audit");
    const serverAttr = extractAttribution(serverStarts[0] ?? {});

    // --- 2. provider-native ---
    const PN_TOOL = "ba005.lifecycle.provider_native";
    const pnHarness = createConformanceKernelHarness();
    const pnRuntime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: pnHarness.kernel,
      runnerRegistry: createRunnerRegistry([
        makeProviderRunner("provider-native", PN_TOOL),
      ]),
    });
    const pnThread = await pnRuntime.createThread({});
    const pnHandle = pnRuntime.executeTurn({
      branchId: pnThread.branchId,
      config: { name: AGENT_NAME },
      signal: textSignal("ba005 pn"),
      threadId: pnThread.threadId,
    });
    const pnEvents = await collectValues(pnHandle.events());
    const pnStarts = findEvents(pnEvents, "tool.start");
    const pnResults = findEvents(pnEvents, "tool.result");
    const pnAudits = findEvents(pnEvents, "tool.audit");
    const pnAttr = extractAttribution(pnStarts[0] ?? {});

    // --- 3. provider-mediated ---
    const PM_TOOL = "ba005.lifecycle.provider_mediated";
    const pmHarness = createConformanceKernelHarness();
    const pmRuntime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: pmHarness.kernel,
      runnerRegistry: createRunnerRegistry([
        makeProviderRunner("provider-mediated", PM_TOOL),
      ]),
    });
    const pmThread = await pmRuntime.createThread({});
    const pmHandle = pmRuntime.executeTurn({
      branchId: pmThread.branchId,
      config: { name: AGENT_NAME },
      signal: textSignal("ba005 pm"),
      threadId: pmThread.threadId,
    });
    const pmEvents = await collectValues(pmHandle.events());
    const pmStarts = findEvents(pmEvents, "tool.start");
    const pmResults = findEvents(pmEvents, "tool.result");
    const pmAudits = findEvents(pmEvents, "tool.audit");
    const pmAttr = extractAttribution(pmStarts[0] ?? {});

    // --- 4. tuvren-client ---
    const CLIENT_CAP = "ba005.lifecycle.client";
    const clientEndpoint = makeOkEndpoint("ep-ba005-client", CLIENT_CAP);
    const clientBoundary = createClientEndpointBoundary([clientEndpoint]);
    const clientHarness = createConformanceKernelHarness();
    const clientRuntime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: clientHarness.kernel,
      runnerRegistry: createRunnerRegistry([makeSingleCallRunner(CLIENT_CAP)]),
    });
    const clientThread = await clientRuntime.createThread({});
    const clientHandle = clientRuntime.executeTurn({
      branchId: clientThread.branchId,
      config: {
        clientEndpointBoundary: clientBoundary,
        clientEndpoints: [clientEndpoint],
        name: AGENT_NAME,
      },
      signal: textSignal("ba005 client"),
      threadId: clientThread.threadId,
    });
    const clientEvents = await collectValues(clientHandle.events());
    const clientStarts = findEvents(clientEvents, "tool.start");
    const clientResults = findEvents(clientEvents, "tool.result");
    const clientAudits = findEvents(clientEvents, "tool.audit");
    const clientAttr = extractAttribution(clientStarts[0] ?? {});

    // --- 5. policy-denied (tuvren-server) ---
    const DENIED_TOOL = "ba005.lifecycle.denied";
    const denyEngine = createCapabilityPolicyEngine({
      deniedCapabilityIds: new Set([DENIED_TOOL]),
    });
    const deniedHarness = createConformanceKernelHarness();
    const deniedRuntime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: deniedHarness.kernel,
      runnerRegistry: createRunnerRegistry([makeSingleCallRunner(DENIED_TOOL)]),
    });
    const deniedThread = await deniedRuntime.createThread({});
    const deniedHandle = deniedRuntime.executeTurn({
      branchId: deniedThread.branchId,
      config: {
        capabilityPolicyEngine: denyEngine,
        name: AGENT_NAME,
        tools: [
          {
            description: "ba005 denied",
            execute: () => ({ ok: true }),
            inputSchema: { type: "object" },
            name: DENIED_TOOL,
          },
        ],
      },
      signal: textSignal("ba005 denied"),
      threadId: deniedThread.threadId,
    });
    const deniedEvents = await collectValues(deniedHandle.events());
    const deniedStarts = findEvents(deniedEvents, "tool.start");
    const deniedResults = findEvents(deniedEvents, "tool.result");
    const [deniedResultEvent] = deniedResults;

    // --- 6. stale late-completion (tuvren-client) ---
    const STALE_CAP = "ba005.lifecycle.stale";
    const staleEndpoint = makeStaleEndpoint("ep-ba005-stale", STALE_CAP);
    const staleBoundary = createClientEndpointBoundary([staleEndpoint]);
    const staleHarness = createConformanceKernelHarness();
    const staleRuntime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: staleHarness.kernel,
      runnerRegistry: createRunnerRegistry([makeSingleCallRunner(STALE_CAP)]),
    });
    const staleThread = await staleRuntime.createThread({});
    const staleHandle = staleRuntime.executeTurn({
      branchId: staleThread.branchId,
      config: {
        clientEndpointBoundary: staleBoundary,
        clientEndpoints: [staleEndpoint],
        name: AGENT_NAME,
      },
      signal: textSignal("ba005 stale"),
      threadId: staleThread.threadId,
    });
    const staleEvents = await collectValues(staleHandle.events());
    const staleResults = findEvents(staleEvents, "tool.result");
    const [staleResultEvent] = staleResults;
    const staleOutput = readRecordField(staleResultEvent, "output");

    // --- 7. tuvren-server fail-clean: tool that throws an error → isError: true ---
    const ERROR_TOOL = "ba005.lifecycle.server.error";
    const errorHarness = createConformanceKernelHarness();
    const errorRuntime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: errorHarness.kernel,
      runnerRegistry: createRunnerRegistry([makeSingleCallRunner(ERROR_TOOL)]),
    });
    const errorThread = await errorRuntime.createThread({});
    const errorHandle = errorRuntime.executeTurn({
      branchId: errorThread.branchId,
      config: {
        name: AGENT_NAME,
        tools: [
          {
            description: "ba005 error tool",
            execute: () => {
              throw new Error("ba005 deliberate error");
            },
            inputSchema: { type: "object" },
            name: ERROR_TOOL,
          },
        ],
      },
      signal: textSignal("ba005 error"),
      threadId: errorThread.threadId,
    });
    const errorEvents = await collectValues(errorHandle.events());
    const errorStarts = findEvents(errorEvents, "tool.start");
    const errorResults = findEvents(errorEvents, "tool.result");
    const [errorResultEvent] = errorResults;

    // --- 8. tuvren-client unavailable endpoint: fail-clean without fabricating ---
    const UNAVAIL_CAP = "ba005.lifecycle.client.unavail";
    const unavailEndpoint = makeOkEndpoint("ep-ba005-unavail", UNAVAIL_CAP);
    const unavailBoundary = createClientEndpointBoundary([unavailEndpoint]);
    // Pre-detach to trigger unavailability.
    unavailBoundary.detach("ep-ba005-unavail");
    const unavailHarness = createConformanceKernelHarness();
    const unavailRuntime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: unavailHarness.kernel,
      runnerRegistry: createRunnerRegistry([makeSingleCallRunner(UNAVAIL_CAP)]),
    });
    const unavailThread = await unavailRuntime.createThread({});
    const unavailHandle = unavailRuntime.executeTurn({
      branchId: unavailThread.branchId,
      config: {
        clientEndpointBoundary: unavailBoundary,
        clientEndpoints: [unavailEndpoint],
        name: AGENT_NAME,
      },
      signal: textSignal("ba005 unavail"),
      threadId: unavailThread.threadId,
    });
    const unavailEvents = await collectValues(unavailHandle.events());
    const unavailStarts = findEvents(unavailEvents, "tool.start");
    const unavailResults = findEvents(unavailEvents, "tool.result");
    const [unavailResultEvent] = unavailResults;
    const unavailOutput = readRecordField(unavailResultEvent, "output");

    return {
      result: {
        invocationLifecycle: {
          clientUnavailableFailClean: {
            toolResultCode: readRecordField(unavailOutput, "code"),
            toolResultCount: unavailResults.length,
            toolResultIsError: readRecordField(unavailResultEvent, "isError"),
            toolStartCount: unavailStarts.length,
          },
          policyDenied: {
            resultIsError: readRecordField(deniedResultEvent, "isError"),
            toolResultCount: deniedResults.length,
            toolStartCount: deniedStarts.length,
          },
          providerMediated: {
            canAudit: pmAttr.canAudit,
            canCancel: pmAttr.canCancel,
            canResume: pmAttr.canResume,
            canRetry: pmAttr.canRetry,
            executionClass: pmAttr.executionClass,
            owner: pmAttr.owner,
            toolAuditCount: pmAudits.length,
            toolResultCount: pmResults.length,
            toolStartCount: pmStarts.length,
          },
          providerNative: {
            canAudit: pnAttr.canAudit,
            canCancel: pnAttr.canCancel,
            canResume: pnAttr.canResume,
            canRetry: pnAttr.canRetry,
            executionClass: pnAttr.executionClass,
            owner: pnAttr.owner,
            toolAuditCount: pnAudits.length,
            toolResultCount: pnResults.length,
            toolStartCount: pnStarts.length,
          },
          // BA003 fail-clean proofs: non-fabricated clean failures
          serverErrorFailClean: {
            resultIsError: readRecordField(errorResultEvent, "isError"),
            toolResultCount: errorResults.length,
            toolStartCount: errorStarts.length,
          },
          staleLateCompletion: {
            toolResultCode: readRecordField(staleOutput, "code"),
            toolResultIsError: readRecordField(staleResultEvent, "isError"),
          },
          tuvrenClient: {
            canAudit: clientAttr.canAudit,
            canCancel: clientAttr.canCancel,
            canResume: clientAttr.canResume,
            canRetry: clientAttr.canRetry,
            executionClass: clientAttr.executionClass,
            owner: clientAttr.owner,
            toolAuditCount: clientAudits.length,
            toolResultCount: clientResults.length,
            toolStartCount: clientStarts.length,
          },
          tuvrenServer: {
            canAudit: serverAttr.canAudit,
            canCancel: serverAttr.canCancel,
            canResume: serverAttr.canResume,
            canRetry: serverAttr.canRetry,
            executionClass: serverAttr.executionClass,
            owner: serverAttr.owner,
            toolAuditCount: serverAudits.length,
            toolResultCount: serverResults.length,
            toolStartCount: serverStarts.length,
          },
        },
      },
    };
  };
