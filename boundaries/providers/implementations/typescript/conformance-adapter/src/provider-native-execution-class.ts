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
 * Conformance adapter operations for the provider-native execution class
 * check set (KRT-AY007). Returns structured evidence that the shared
 * conformance runner asserts against the provider-native-execution-class plan.
 *
 * Adapter rules: no assertions, no pass/fail grading, no evidence field names
 * that imply semantic verdicts. Raw observational data only.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createMemoryBackend } from "@tuvren/backend-memory";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createDriverRegistry, createTuvrenRuntime } from "@tuvren/runtime";
import { createReActDriver } from "../../../../../framework/implementations/typescript/drivers/react/src/index.ts";
import { createAiSdkProviderBridge } from "../../bridge-ai-sdk/src/index.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createKernel() {
  const backend = createMemoryBackend();
  return createRuntimeKernel({ backend });
}

function createMockNativeModel(): LanguageModelV3 {
  return {
    async doGenerate() {
      await Promise.resolve();
      return {
        content: [
          {
            result: {
              outputs: [{ text: "42", type: "text" }],
            },
            toolCallId: "ay007-native-call-1",
            toolName: "code_execution",
            type: "tool-result",
          },
        ],
        finishReason: { raw: "stop", unified: "stop" },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 5, total: 5 },
          outputTokens: { reasoning: 0, text: 2, total: 2 },
          raw: {},
        },
        warnings: [],
      };
    },
    doStream() {
      throw new Error("stream not used in generate mode");
    },
    modelId: "anthropic.claude-3-5-sonnet-20241022",
    provider: "anthropic",
    specificationVersion: "v3",
    supportedUrls: {},
  };
}

async function collectEventStream(
  iterable: AsyncIterable<Record<string, unknown>>
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findEventByType(
  events: Record<string, unknown>[],
  type: string
): Record<string, unknown> | undefined {
  return events.find((e) => e.type === type);
}

function filterEventsByType(
  events: Record<string, unknown>[],
  type: string
): Record<string, unknown>[] {
  return events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// Operation: providers.provider-native.attribution
//
// Exercises the full stack (bridge → react-driver generate mode → runtime)
// with a mock model that returns an Anthropic code_execution result.
// Projects observable evidence for provider-native execution class checks.
// ---------------------------------------------------------------------------

export async function runProviderNativeAttribution(): Promise<
  Record<string, unknown>
> {
  let localExecuteCalled = false;
  const kernel = createKernel();
  const bridge = createAiSdkProviderBridge({ model: createMockNativeModel() });
  const runtime = createTuvrenRuntime({
    defaultDriverId: "react",
    driverRegistry: createDriverRegistry([
      createReActDriver({ providerCallMode: "generate" }),
    ]),
    kernel,
  });

  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      model: bridge,
      name: "primary",
      providerNativeTools: [
        { id: "anthropic.code_execution_20260120", name: "code_execution" },
      ],
      tools: [
        {
          description: "local code executor",
          execute() {
            localExecuteCalled = true;
            return { executed: true };
          },
          inputSchema: { type: "object" },
          name: "code_execution",
        },
      ],
    },
    signal: { parts: [{ text: "execute Python", type: "text" }] },
    threadId: thread.threadId,
  });

  const events = await collectEventStream(
    handle.events() as AsyncIterable<Record<string, unknown>>
  );

  const turnEndEvent = findEventByType(events, "turn.end");
  const toolResultEvents = filterEventsByType(events, "tool.result");
  const toolStartEvents = filterEventsByType(events, "tool.start");
  const toolAuditEvents = filterEventsByType(events, "tool.audit");

  const providerToolResult = toolResultEvents.find(
    (e) =>
      typeof e.attribution === "object" &&
      e.attribution !== null &&
      (e.attribution as Record<string, unknown>).owner === "provider"
  );

  const attribution =
    typeof providerToolResult?.attribution === "object" &&
    providerToolResult.attribution !== null
      ? (providerToolResult.attribution as Record<string, unknown>)
      : {};

  const observation =
    typeof attribution.observation === "object" &&
    attribution.observation !== null
      ? (attribution.observation as Record<string, unknown>)
      : {};

  const providerToolStart = toolStartEvents.find(
    (e) =>
      typeof e.attribution === "object" &&
      e.attribution !== null &&
      (e.attribution as Record<string, unknown>).owner === "provider"
  );

  return {
    evidence: {
      attribution: {
        executionClass: attribution.executionClass,
        observation: {
          canAudit: observation.canAudit,
          canCancel: observation.canCancel,
          canPersistResult: observation.canPersistResult,
          canResume: observation.canResume,
          canRetry: observation.canRetry,
        },
        owner: attribution.owner,
      },
      localExecuteCalled,
      toolAuditEventCount: toolAuditEvents.length,
      toolResultEventCount: toolResultEvents.length,
      toolStartEventCount: toolStartEvents.length,
      toolStartOwner:
        typeof providerToolStart?.attribution === "object" &&
        providerToolStart.attribution !== null
          ? (providerToolStart.attribution as Record<string, unknown>).owner
          : undefined,
      turnStatus: turnEndEvent?.status,
    },
    result: {
      attribution: {
        executionClass: attribution.executionClass,
        observation: {
          canAudit: observation.canAudit,
          canCancel: observation.canCancel,
          canPersistResult: observation.canPersistResult,
          canResume: observation.canResume,
          canRetry: observation.canRetry,
        },
        owner: attribution.owner,
      },
      localExecuteCalled,
      toolAuditEventCount: toolAuditEvents.length,
      toolResultEventCount: toolResultEvents.length,
      toolStartEventCount: toolStartEvents.length,
      toolStartOwner:
        typeof providerToolStart?.attribution === "object" &&
        providerToolStart.attribution !== null
          ? (providerToolStart.attribution as Record<string, unknown>).owner
          : undefined,
      turnStatus: turnEndEvent?.status,
    },
  };
}
