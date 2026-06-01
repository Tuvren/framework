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

import {
  createCapabilityPolicyEngine,
  createDriverRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import {
  type AdapterProjection,
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

/**
 * Runs a single defineTool tool execution and returns evidence about the
 * CapabilityInvocationAttribution on tool.start and tool.result events.
 *
 * Used by the runtime-api-capability-orchestration check set to assert:
 * - Back-compat invariant: defineTool resolves to tuvren-server execution class
 * - Attribution is additive (existing event fields survive)
 * - Observation limits for tuvren-server are full lifecycle
 */
export async function runCapabilityOrchestrationFoundation(
  toolName: string
): Promise<AdapterProjection> {
  const harness = createConformanceKernelHarness();
  let toolCallCount = 0;

  const driver = createStaticDriver(async (context) => {
    await Promise.resolve();
    if (!context.messages.some((m) => m.role === "tool")) {
      return {
        messages: [
          assistantToolCalls([
            {
              callId: "cap-call-1",
              input: { q: "conformance" },
              name: toolName,
            },
          ]),
        ],
        resolution: { type: "continue_iteration" as const },
        toolExecutionMode: "parallel",
      };
    }
    return {
      messages: [assistantText("capability orchestration conformance done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });

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
      tools: [
        {
          description: `Conformance capability tool ${toolName}`,
          execute() {
            toolCallCount += 1;
            return { ok: true };
          },
          inputSchema: { type: "object" },
          name: toolName,
        },
      ],
    },
    signal: textSignal("capability orchestration conformance test"),
    threadId: thread.threadId,
  });

  const events = await collectValues(handle.events());

  const toolStartEvent = events.find(
    (e): e is Extract<(typeof events)[number], { type: "tool.start" }> =>
      (e as { type?: unknown }).type === "tool.start"
  );
  const toolResultEvent = events.find(
    (e): e is Extract<(typeof events)[number], { type: "tool.result" }> =>
      (e as { type?: unknown }).type === "tool.result"
  );

  const startAttribution = (
    toolStartEvent as Record<string, unknown> | undefined
  )?.attribution as Record<string, unknown> | undefined;
  const resultAttribution = (
    toolResultEvent as Record<string, unknown> | undefined
  )?.attribution as Record<string, unknown> | undefined;
  const observation = startAttribution?.observation as
    | Record<string, unknown>
    | undefined;

  const evidence = {
    capabilityOrchestration: {
      backCompat: {
        startEventCallId: (
          toolStartEvent as Record<string, unknown> | undefined
        )?.callId,
        startEventName: (toolStartEvent as Record<string, unknown> | undefined)
          ?.name,
        startEventType: (toolStartEvent as Record<string, unknown> | undefined)
          ?.type,
        startAttribution: {
          capabilityId: startAttribution?.capabilityId,
          executionClass: startAttribution?.executionClass,
          observation: {
            canAudit: observation?.canAudit,
            canCancel: observation?.canCancel,
            canObserveIntermediate: observation?.canObserveIntermediate,
            canPersistResult: observation?.canPersistResult,
            canResume: observation?.canResume,
            canRetry: observation?.canRetry,
            executionClass: observation?.executionClass,
          },
          owner: startAttribution?.owner,
        },
        resultAttribution: {
          executionClass: resultAttribution?.executionClass,
          owner: resultAttribution?.owner,
        },
        toolCallCount,
      },
    },
  };

  return { evidence, result: evidence };
}

/**
 * Exercises both Capability Policy Engine decision points:
 * 1. Policy-unit decisions (standalone engine call) for exposure/invocation.
 * 2. A real tool-execution turn with a denied capability to prove invocation
 *    denial surfaces as tool.result isError:true (the wired behavior).
 *
 * Used by the runtime-api-capability-orchestration check set to assert:
 * - Exposure-time: denied surfaces return exposed:false with a non-secret reason
 * - Invocation-time standalone: denied capabilities return admitted:false
 * - Invocation-time wired: a denied capability produces tool.result isError:true
 * - Permitted surfaces/capabilities pass through unaffected
 */
export async function runCapabilityOrchestrationPolicyDecisions(): Promise<AdapterProjection> {
  const deniedSurface = "denied-surface";
  const deniedToolName = "denied-tool";
  const permittedSurface = "permitted-surface";

  const engine = createCapabilityPolicyEngine({
    deniedCapabilityIds: new Set([deniedToolName]),
    deniedSurfaceNames: new Set([deniedSurface]),
  });

  const context = {
    modelId: "conformance-model",
    permissions: [] as string[],
    providerId: "conformance-provider",
  };

  // --- Part 1: Standalone policy-unit decisions ---
  const exposureDecisions = engine.evaluateExposure(
    [
      {
        capabilityId: deniedToolName,
        description: "Denied surface",
        inputSchema: { type: "object" },
        name: deniedSurface,
      },
      {
        capabilityId: "permitted.capability",
        description: "Permitted surface",
        inputSchema: { type: "object" },
        name: permittedSurface,
      },
    ],
    context
  );

  const deniedExposure = exposureDecisions.find(
    (d) => d.surfaceName === deniedSurface
  );
  const permittedExposure = exposureDecisions.find(
    (d) => d.surfaceName === permittedSurface
  );

  const deniedInvocationDecision = engine.evaluateInvocation(
    {
      capabilityId: deniedToolName,
      endpoint: { id: "test", kind: "tuvren-in-process" },
      executionClass: "tuvren-server",
    },
    context
  );

  const permittedInvocationDecision = engine.evaluateInvocation(
    {
      capabilityId: "permitted.capability",
      endpoint: { id: "test", kind: "tuvren-in-process" },
      executionClass: "tuvren-server",
    },
    context
  );

  // --- Part 2: Wired invocation denial → tool.result isError:true ---
  const harness = createConformanceKernelHarness();
  let deniedToolExecuted = false;

  const driver = createStaticDriver(async (ctx) => {
    await Promise.resolve();
    if (!ctx.messages.some((m) => m.role === "tool")) {
      return {
        messages: [
          assistantToolCalls([
            {
              callId: "denied-call-1",
              input: {},
              name: deniedToolName,
            },
          ]),
        ],
        resolution: { type: "continue_iteration" as const },
        toolExecutionMode: "parallel",
      };
    }
    return {
      messages: [assistantText("capability policy conformance done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });

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
      capabilityPolicyEngine: engine,
      name: AGENT_NAME,
      tools: [
        {
          description: "Denied capability tool",
          execute() {
            deniedToolExecuted = true;
            return { ok: true };
          },
          inputSchema: { type: "object" },
          name: deniedToolName,
        },
      ],
    },
    signal: textSignal("capability policy denial test"),
    threadId: thread.threadId,
  });

  const events = await collectValues(handle.events());

  const toolResultEvent = events.find(
    (e) => (e as unknown as Record<string, unknown>).type === "tool.result"
  );
  const toolResultIsError =
    (toolResultEvent as unknown as Record<string, unknown> | undefined)
      ?.isError === true;

  const evidence = {
    capabilityPolicy: {
      exposure: {
        denied: {
          exposed: deniedExposure?.exposed,
          hasReason:
            typeof deniedExposure?.reason === "string" &&
            (deniedExposure.reason ?? "").length > 0,
          surfaceName: deniedExposure?.surfaceName,
        },
        permitted: {
          exposed: permittedExposure?.exposed,
          surfaceName: permittedExposure?.surfaceName,
        },
      },
      invocation: {
        denied: {
          admitted: deniedInvocationDecision.admitted,
          capabilityId: deniedInvocationDecision.capabilityId,
          deniedToolExecuted,
          hasReason:
            typeof deniedInvocationDecision.reason === "string" &&
            (deniedInvocationDecision.reason ?? "").length > 0,
          toolResultIsError,
        },
        permitted: {
          admitted: permittedInvocationDecision.admitted,
          capabilityId: permittedInvocationDecision.capabilityId,
        },
      },
    },
  };

  return { evidence, result: evidence };
}
