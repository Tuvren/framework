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

// biome-ignore-all lint/suspicious/useAwait: Mock model hooks preserve async provider signatures.

/**
 * KRT-AY006 — Concrete provider-native and provider-mediated execution class proofs.
 *
 * These are mock-backed end-to-end proofs through the full stack:
 *   LanguageModelV3 mock → AI SDK bridge → ReAct driver → Tuvren runtime
 *
 * They demonstrate the conceptual invariant: every model-visible tool call
 * resolves to a policy-checked capability invocation against a known execution
 * class, and provider-owned results never reach the Tool Execution Gateway.
 *
 * Gap note: Real live-provider testing (Anthropic code_execution, OpenAI MCP)
 * requires API keys that are not available in CI. These mock-backed proofs
 * validate the full contract path with representative fixtures per the spike
 * gap protocol documented in ay001-provider-surface-matrix.md.
 */

import { describe, expect, test } from "bun:test";
import { createReActDriver } from "@tuvren/driver-react";
import {
  createDriverRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import { createFakeKernelHarness } from "../../../../../framework/implementations/typescript/runtime/test/fake-kernel.ts";
import { createAiSdkProviderBridge } from "../src/index.ts";
import {
  collectAsyncIterable,
  createGenerateResult,
  createMockModel,
  createUsage,
  streamFromParts,
} from "./ai-sdk-provider-bridge-test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EventRecord = Record<string, unknown>;

function filterEventsByType(
  events: EventRecord[],
  type: string
): EventRecord[] {
  return events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// KRT-AY006 — Provider-native proof: Anthropic code_execution pattern
// ---------------------------------------------------------------------------

describe("KRT-AY006 — provider-native execution class proof (generate path)", () => {
  test("Anthropic code_execution result produces tool.result event with provider-native attribution", async () => {
    const harness = createFakeKernelHarness();
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          return createGenerateResult({
            content: [
              {
                result: {
                  outputs: [{ text: "The answer is 42.", type: "text" }],
                },
                toolCallId: "native-proof-generate-1",
                toolName: "code_execution",
                type: "tool-result",
              },
            ],
            finishReason: { raw: "stop", unified: "stop" },
          });
        },
      }),
    });
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "react",
      driverRegistry: createDriverRegistry([
        createReActDriver({ providerCallMode: "generate" }),
      ]),
      kernel: harness.kernel,
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
      },
      signal: { parts: [{ text: "Execute Python: print(42)", type: "text" }] },
      threadId: thread.threadId,
    });

    const events = (await collectAsyncIterable(
      handle.events()
    )) as unknown as EventRecord[];

    // Turn must complete successfully
    const turnEnd = filterEventsByType(events, "turn.end")[0] as
      | EventRecord
      | undefined;
    expect(turnEnd).toBeDefined();
    expect(turnEnd?.status).toBe("completed");

    // tool.result event with provider-native attribution
    const toolResults = filterEventsByType(
      events,
      "tool.result"
    ) as EventRecord[];
    const providerResult = toolResults.find(
      (e) =>
        typeof e.attribution === "object" &&
        e.attribution !== null &&
        (e.attribution as EventRecord).owner === "provider"
    );
    expect(providerResult).toBeDefined();

    const attr = providerResult?.attribution as EventRecord;
    expect(attr.owner).toBe("provider");
    expect(attr.executionClass).toBe("provider-native");
    expect(providerResult?.name).toBe("code_execution");
    expect(providerResult?.output).toEqual({
      outputs: [{ text: "The answer is 42.", type: "text" }],
    });

    // Observation limits: canAudit/canCancel/canRetry/canResume all false
    const obs = attr.observation as EventRecord;
    expect(obs.canAudit).toBe(false);
    expect(obs.canCancel).toBe(false);
    expect(obs.canRetry).toBe(false);
    expect(obs.canResume).toBe(false);
    expect(obs.canPersistResult).toBe(true);

    // No tool.audit event for provider-native
    expect(filterEventsByType(events, "tool.audit")).toHaveLength(0);
  });

  test("provider-native result is staged in durable branch history", async () => {
    const harness = createFakeKernelHarness();
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          return createGenerateResult({
            content: [
              {
                result: { outputs: [{ text: "done", type: "text" }] },
                toolCallId: "native-proof-history-1",
                toolName: "code_execution",
                type: "tool-result",
              },
            ],
            finishReason: { raw: "stop", unified: "stop" },
          });
        },
      }),
    });
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "react",
      driverRegistry: createDriverRegistry([
        createReActDriver({ providerCallMode: "generate" }),
      ]),
      kernel: harness.kernel,
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
      },
      signal: { parts: [{ text: "run code", type: "text" }] },
      threadId: thread.threadId,
    });

    await collectAsyncIterable(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    // Pre-staged tool message appears in durable history as a tool-role message
    const toolMessages = (messages as EventRecord[]).filter(
      (m) => m.role === "tool"
    );
    expect(toolMessages.length).toBeGreaterThan(0);
    const toolParts =
      (toolMessages[0]?.parts as EventRecord[] | undefined) ?? [];
    const part = toolParts[0] as EventRecord | undefined;
    expect(part?.name).toBe("code_execution");
    expect(part?.type).toBe("tool_result");
    const meta = part?.providerMetadata as EventRecord | undefined;
    expect(meta?.owner).toBe("provider");
    expect(meta?.executionClass).toBe("provider-native");
  });

  test("no local tool execute callback is invoked for provider-native result", async () => {
    // Verify the no-local-execution invariant: a tuvren-server tool registered
    // with the same name must not be called when the result arrives as a
    // provider-native pre-staged message.
    let localExecuteCalled = false;
    const harness = createFakeKernelHarness();
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          return createGenerateResult({
            content: [
              {
                result: { outputs: [] },
                toolCallId: "native-proof-no-local-1",
                toolName: "code_execution",
                type: "tool-result",
              },
            ],
            finishReason: { raw: "stop", unified: "stop" },
          });
        },
      }),
    });
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "react",
      driverRegistry: createDriverRegistry([
        createReActDriver({ providerCallMode: "generate" }),
      ]),
      kernel: harness.kernel,
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
        // Also register a tuvren-server tool with the same name — it must not run
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
      signal: { parts: [{ text: "run", type: "text" }] },
      threadId: thread.threadId,
    });

    await collectAsyncIterable(handle.events());
    expect(localExecuteCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KRT-AY006 — Provider-native proof: stream path
// ---------------------------------------------------------------------------

describe("KRT-AY006 — provider-native execution class proof (stream path)", () => {
  test("streamed code_execution result produces tool.result event with provider-native attribution", async () => {
    const harness = createFakeKernelHarness();
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          return {
            stream: streamFromParts([
              {
                result: { outputs: [{ text: "stream result", type: "text" }] },
                toolCallId: "native-stream-proof-1",
                toolName: "code_execution",
                type: "tool-result",
              },
              {
                finishReason: { raw: "stop", unified: "stop" },
                type: "finish",
                usage: createUsage(5, 3),
              },
            ]),
          };
        },
      }),
    });
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "react",
      driverRegistry: createDriverRegistry([createReActDriver()]),
      kernel: harness.kernel,
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
      },
      signal: { parts: [{ text: "stream run", type: "text" }] },
      threadId: thread.threadId,
    });

    const events = (await collectAsyncIterable(
      handle.events()
    )) as unknown as EventRecord[];

    const turnEnd = filterEventsByType(events, "turn.end")[0] as
      | EventRecord
      | undefined;
    expect(turnEnd?.status).toBe("completed");

    const toolResults = filterEventsByType(
      events,
      "tool.result"
    ) as EventRecord[];
    const providerResult = toolResults.find(
      (e) =>
        typeof e.attribution === "object" &&
        e.attribution !== null &&
        (e.attribution as EventRecord).owner === "provider"
    );
    expect(providerResult).toBeDefined();

    const attr = providerResult?.attribution as EventRecord;
    expect(attr.owner).toBe("provider");
    expect(attr.executionClass).toBe("provider-native");
    expect(providerResult?.name).toBe("code_execution");
    expect(filterEventsByType(events, "tool.audit")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// KRT-AY006 — Provider-mediated proof: OpenAI MCP tool pattern
// ---------------------------------------------------------------------------

describe("KRT-AY006 — provider-mediated execution class proof (generate path)", () => {
  test("OpenAI MCP tool result (dynamic:true) produces tool.result with provider-mediated attribution", async () => {
    const harness = createFakeKernelHarness();
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doGenerate() {
          return createGenerateResult({
            content: [
              {
                dynamic: true,
                result: { data: "fetched from MCP endpoint" },
                toolCallId: "mcp-proof-generate-1",
                toolName: "mcp_tool",
                type: "tool-result",
              },
            ],
            finishReason: { raw: "stop", unified: "stop" },
          });
        },
      }),
    });
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "react",
      driverRegistry: createDriverRegistry([
        createReActDriver({ providerCallMode: "generate" }),
      ]),
      kernel: harness.kernel,
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
      },
      signal: { parts: [{ text: "use MCP tool", type: "text" }] },
      threadId: thread.threadId,
    });

    const events = (await collectAsyncIterable(
      handle.events()
    )) as unknown as EventRecord[];

    const turnEnd = filterEventsByType(events, "turn.end")[0] as
      | EventRecord
      | undefined;
    expect(turnEnd).toBeDefined();
    expect(turnEnd?.status).toBe("completed");

    const toolResults = filterEventsByType(
      events,
      "tool.result"
    ) as EventRecord[];
    const providerResult = toolResults.find(
      (e) =>
        typeof e.attribution === "object" &&
        e.attribution !== null &&
        (e.attribution as EventRecord).owner === "provider"
    );
    expect(providerResult).toBeDefined();

    const attr = providerResult?.attribution as EventRecord;
    expect(attr.owner).toBe("provider");
    expect(attr.executionClass).toBe("provider-mediated");
    expect(providerResult?.name).toBe("mcp_tool");

    // Observation limits same as native: all false
    const obs = attr.observation as EventRecord;
    expect(obs.canAudit).toBe(false);
    expect(obs.canCancel).toBe(false);
    expect(obs.canRetry).toBe(false);
    expect(obs.canResume).toBe(false);

    // No tool.audit for provider-mediated
    expect(filterEventsByType(events, "tool.audit")).toHaveLength(0);
  });

  test("no local tool execute callback is invoked for provider-mediated result", async () => {
    let localExecuteCalled = false;
    const harness = createFakeKernelHarness();
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doGenerate() {
          return createGenerateResult({
            content: [
              {
                dynamic: true,
                result: { data: "from mcp" },
                toolCallId: "mcp-no-local-1",
                toolName: "mcp_tool",
                type: "tool-result",
              },
            ],
            finishReason: { raw: "stop", unified: "stop" },
          });
        },
      }),
    });
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "react",
      driverRegistry: createDriverRegistry([
        createReActDriver({ providerCallMode: "generate" }),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        model: bridge,
        name: "primary",
        providerMediatedTools: [
          {
            endpoint: "https://example.com/mcp",
            mediationType: "mcp",
            name: "mcp_tool",
          },
        ],
        // Same-named local tool must not be invoked via the Tool Execution Gateway
        tools: [
          {
            description: "local MCP handler",
            execute() {
              localExecuteCalled = true;
              return { executed: true };
            },
            inputSchema: { type: "object" },
            name: "mcp_tool",
          },
        ],
      },
      signal: { parts: [{ text: "mcp call", type: "text" }] },
      threadId: thread.threadId,
    });

    await collectAsyncIterable(handle.events());
    expect(localExecuteCalled).toBe(false);
  });

  test("MCP binding is classified as provider-mediated class in staged history", async () => {
    const harness = createFakeKernelHarness();
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doGenerate() {
          return createGenerateResult({
            content: [
              {
                dynamic: true,
                result: { value: 99 },
                toolCallId: "mcp-proof-history-1",
                toolName: "mcp_tool",
                type: "tool-result",
              },
            ],
            finishReason: { raw: "stop", unified: "stop" },
          });
        },
      }),
    });
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "react",
      driverRegistry: createDriverRegistry([
        createReActDriver({ providerCallMode: "generate" }),
      ]),
      kernel: harness.kernel,
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
      },
      signal: { parts: [{ text: "mcp call", type: "text" }] },
      threadId: thread.threadId,
    });

    await collectAsyncIterable(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    const toolMessages = (messages as EventRecord[]).filter(
      (m) => m.role === "tool"
    );
    expect(toolMessages.length).toBeGreaterThan(0);
    const parts = (toolMessages[0]?.parts as EventRecord[] | undefined) ?? [];
    const meta = parts[0]?.providerMetadata as EventRecord | undefined;
    expect(meta?.owner).toBe("provider");
    expect(meta?.executionClass).toBe("provider-mediated");
  });
});

// ---------------------------------------------------------------------------
// KRT-AY006 — Provider-mediated proof: stream path
// ---------------------------------------------------------------------------

describe("KRT-AY006 — provider-mediated execution class proof (stream path)", () => {
  test("streamed MCP tool result produces tool.result with provider-mediated attribution", async () => {
    const harness = createFakeKernelHarness();
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doStream() {
          return {
            stream: streamFromParts([
              {
                dynamic: true,
                result: { items: [] },
                toolCallId: "mcp-stream-proof-1",
                toolName: "mcp_tool",
                type: "tool-result",
              },
              {
                finishReason: { raw: "stop", unified: "stop" },
                type: "finish",
                usage: createUsage(4, 2),
              },
            ]),
          };
        },
      }),
    });
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "react",
      driverRegistry: createDriverRegistry([createReActDriver()]),
      kernel: harness.kernel,
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
      },
      signal: { parts: [{ text: "stream mcp", type: "text" }] },
      threadId: thread.threadId,
    });

    const events = (await collectAsyncIterable(
      handle.events()
    )) as unknown as EventRecord[];

    const turnEnd = filterEventsByType(events, "turn.end")[0] as
      | EventRecord
      | undefined;
    expect(turnEnd?.status).toBe("completed");

    const toolResults = filterEventsByType(
      events,
      "tool.result"
    ) as EventRecord[];
    const providerResult = toolResults.find(
      (e) =>
        typeof e.attribution === "object" &&
        e.attribution !== null &&
        (e.attribution as EventRecord).owner === "provider"
    );
    expect(providerResult).toBeDefined();

    const attr = providerResult?.attribution as EventRecord;
    expect(attr.executionClass).toBe("provider-mediated");
    expect(attr.owner).toBe("provider");
    expect(filterEventsByType(events, "tool.audit")).toHaveLength(0);
  });
});
