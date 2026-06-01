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
  createDriverRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import { createCapabilityPolicyEngine } from "../../runtime/src/lib/capability-policy-engine.ts";
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
 * Exercises the Capability Policy Engine's two decision points directly,
 * returning raw exposure and invocation decisions for the check set to assert.
 *
 * Used by the runtime-api-capability-orchestration check set to assert:
 * - Exposure-time: denied surfaces have exposed: false with a non-secret reason
 * - Invocation-time: denied capabilities have admitted: false with a reason
 * - Permitted surfaces/capabilities pass through unaffected
 */
export function runCapabilityOrchestrationPolicyDecisions(): AdapterProjection {
  const deniedSurface = "denied-surface";
  const deniedCapabilityId = "denied.capability";
  const permittedSurface = "permitted-surface";

  const engine = createCapabilityPolicyEngine({
    deniedCapabilityIds: new Set([deniedCapabilityId]),
    deniedSurfaceNames: new Set([deniedSurface]),
  });

  const context = {
    modelId: "conformance-model",
    permissions: [] as string[],
    providerId: "conformance-provider",
  };

  const exposureDecisions = engine.evaluateExposure(
    [
      {
        capabilityId: deniedCapabilityId,
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

  const deniedInvocation = engine.evaluateInvocation(
    {
      capabilityId: deniedCapabilityId,
      endpoint: { id: "test", kind: "tuvren-in-process" },
      executionClass: "tuvren-server",
    },
    context
  );

  const permittedInvocation = engine.evaluateInvocation(
    {
      capabilityId: "permitted.capability",
      endpoint: { id: "test", kind: "tuvren-in-process" },
      executionClass: "tuvren-server",
    },
    context
  );

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
          admitted: deniedInvocation.admitted,
          capabilityId: deniedInvocation.capabilityId,
          hasReason:
            typeof deniedInvocation.reason === "string" &&
            (deniedInvocation.reason ?? "").length > 0,
        },
        permitted: {
          admitted: permittedInvocation.admitted,
          capabilityId: permittedInvocation.capabilityId,
        },
      },
    },
  };

  return { evidence, result: evidence };
}
