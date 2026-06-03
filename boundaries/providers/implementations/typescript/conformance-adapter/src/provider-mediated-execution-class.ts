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
 * Conformance adapter operations for the provider-mediated execution class
 * check set (KRT-AY007). Returns structured evidence for the
 * provider-mediated-execution-class plan's checks.
 *
 * Adapter rules: no assertions, no pass/fail grading, raw observational data only.
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

function createMockMediatedModel(): LanguageModelV3 {
  return {
    async doGenerate() {
      await Promise.resolve();
      return {
        content: [
          {
            dynamic: true,
            result: { data: "fetched from MCP endpoint" },
            toolCallId: "ay007-mcp-call-1",
            toolName: "mcp_tool",
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
    modelId: "gpt-4o",
    provider: "openai",
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
// Operation: providers.provider-mediated.attribution
//
// Exercises the full stack with a mock OpenAI model that returns an
// openai.mcp (MCP tool) result with dynamic:true. Projects observable
// evidence for provider-mediated execution class checks.
// ---------------------------------------------------------------------------

export async function runProviderMediatedAttribution(): Promise<
  Record<string, unknown>
> {
  let localExecuteCalled = false;
  const kernel = createKernel();
  const bridge = createAiSdkProviderBridge({
    model: createMockMediatedModel(),
  });
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
      providerMediatedTools: [
        {
          endpoint: "https://my-mcp-server.example.com/mcp",
          mediationType: "mcp",
          name: "mcp_tool",
        },
      ],
      tools: [
        {
          description: "local MCP handler (must not be invoked)",
          execute() {
            localExecuteCalled = true;
            return { executed: true };
          },
          inputSchema: { type: "object" },
          name: "mcp_tool",
        },
      ],
    },
    signal: { parts: [{ text: "use MCP tool", type: "text" }] },
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

  const providerToolStart = toolStartEvents.find(
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

  const toolStartOwner =
    typeof providerToolStart?.attribution === "object" &&
    providerToolStart.attribution !== null
      ? (providerToolStart.attribution as Record<string, unknown>).owner
      : undefined;

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
      toolStartOwner,
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
      toolStartOwner,
      turnStatus: turnEndEvent?.status,
    },
  };
}
