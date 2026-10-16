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

// biome-ignore-all lint/suspicious/useAwait: Mock AI SDK model hooks intentionally preserve async provider signatures.

import { describe, expect, test } from "bun:test";

import { TuvrenProviderError } from "@tuvren/core";
import type {
  ProviderMediatedToolConfig,
  ProviderNativeToolDeclaration,
} from "@tuvren/core/provider";

import { createAiSdkProviderBridge } from "../src/index.ts";
import {
  collectAsyncIterable,
  createGenerateResult,
  createMockModel,
  createUsage,
  captureRejection,
  streamFromParts,
} from "./ai-sdk-provider-bridge-test-helpers.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasType = (value: unknown, type: string): boolean =>
  isRecord(value) && value.type === type;

// ---------------------------------------------------------------------------
// Provider-native tool declaration mapping (AY002)
// ---------------------------------------------------------------------------

describe("provider-bridge-ai-sdk provider-native tools", () => {
  test("maps provider-native declaration to LanguageModelV3ProviderTool in call options", async () => {
    let capturedTools: unknown[] | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        doGenerate(options) {
          capturedTools = options.tools;
          return createGenerateResult();
        },
      }),
    });

    const declaration: ProviderNativeToolDeclaration = {
      args: {},
      id: "anthropic.code_execution_20260120",
      name: "code_execution",
    };

    await bridge.generate({
      messages: [{ parts: [{ text: "run code", type: "text" }], role: "user" }],
      providerNativeTools: [declaration],
    });

    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(1);
    expect(capturedTools?.[0]).toMatchObject({
      args: {},
      id: "anthropic.code_execution_20260120",
      name: "code_execution",
      type: "provider",
    });
  });

  test("maps provider-native declaration args through to LanguageModelV3ProviderTool", async () => {
    let capturedTools: unknown[] | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        doGenerate(options) {
          capturedTools = options.tools;
          return createGenerateResult();
        },
      }),
    });

    const declaration: ProviderNativeToolDeclaration = {
      args: { domain_filter: ["example.com"] },
      id: "xai.web_search",
      name: "web_search",
    };

    await bridge.generate({
      messages: [{ parts: [{ text: "search", type: "text" }], role: "user" }],
      providerNativeTools: [declaration],
    });

    expect(capturedTools?.[0]).toMatchObject({
      args: { domain_filter: ["example.com"] },
      id: "xai.web_search",
      type: "provider",
    });
  });

  test("passes both function tools and provider-native tools in the same call", async () => {
    let capturedTools: unknown[] | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        doGenerate(options) {
          capturedTools = options.tools;
          return createGenerateResult();
        },
      }),
    });

    await bridge.generate({
      messages: [{ parts: [{ text: "go", type: "text" }], role: "user" }],
      providerNativeTools: [
        { id: "anthropic.code_execution_20260120", name: "code_execution" },
      ],
      tools: [
        {
          description: "a function tool",
          inputSchema: { type: "object" },
          name: "my_function",
        },
      ],
    });

    expect(capturedTools).toHaveLength(2);
    const fnTool = capturedTools?.find((tool) => hasType(tool, "function"));
    const providerTool = capturedTools?.find((tool) =>
      hasType(tool, "provider")
    );
    expect(fnTool).toBeDefined();
    expect(providerTool).toBeDefined();
  });

  test("accepts LanguageModelV3ToolResult for declared provider-native tool in generate", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        doGenerate() {
          return createGenerateResult({
            content: [
              {
                result: { outputs: [{ code: "print('hello')", type: "code" }] },
                toolCallId: "native-call-1",
                toolName: "code_execution",
                type: "tool-result",
              },
            ],
            finishReason: { raw: "stop", unified: "stop" },
          });
        },
      }),
    });

    const response = await bridge.generate({
      messages: [{ parts: [{ text: "run", type: "text" }], role: "user" }],
      providerNativeTools: [
        { id: "anthropic.code_execution_20260120", name: "code_execution" },
      ],
    });

    // Provider-native results appear in providerToolResults (separate from parts)
    expect(response.providerToolResults).toBeDefined();
    expect(response.providerToolResults).toHaveLength(1);
    const record = response.providerToolResults?.[0];
    expect(record?.name).toBe("code_execution");
    expect(record?.executionClass).toBe("provider-native");
    // Should NOT contaminate parts with tool_call/tool_result
    expect(
      response.parts.some(
        (p) => p.type === "tool_call" || p.type === "tool_result"
      )
    ).toBe(false);
  });

  test("still rejects undeclared provider-owned tool results (baseline protection)", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        doGenerate() {
          return createGenerateResult({
            content: [
              {
                result: { status: "done" },
                toolCallId: "provider-tool-call-1",
                toolName: "search",
                type: "tool-result",
              },
            ],
          });
        },
      }),
    });

    // No providerNativeTools declared → should still reject
    const rejection = await captureRejection(
      bridge.generate({
        messages: [{ parts: [{ text: "test", type: "text" }], role: "user" }],
      })
    );
    expect(rejection).toBeInstanceOf(TuvrenProviderError);
  });

  test("yields provider_tool_result chunk for declared provider-native tool in stream", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        doStream() {
          return {
            stream: streamFromParts([
              {
                result: { outputs: [{ text: "result" }] },
                toolCallId: "native-stream-1",
                toolName: "code_execution",
                type: "tool-result",
              },
              {
                finishReason: { raw: "stop", unified: "stop" },
                type: "finish",
                usage: createUsage(3, 2),
              },
            ]),
          };
        },
      }),
    });

    const chunks = await collectAsyncIterable(
      bridge.stream({
        messages: [{ parts: [{ text: "run", type: "text" }], role: "user" }],
        providerNativeTools: [
          { id: "anthropic.code_execution_20260120", name: "code_execution" },
        ],
      })
    );

    const providerResultChunk = chunks.find(
      (
        chunk
      ): chunk is Extract<
        (typeof chunks)[number],
        { type: "provider_tool_result" }
      > => chunk.type === "provider_tool_result"
    );
    expect(providerResultChunk).toBeDefined();
    expect(providerResultChunk?.name).toBe("code_execution");
    expect(providerResultChunk?.providerCallId).toBe("native-stream-1");
  });

  test("still rejects undeclared streamed provider tool results (baseline protection)", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        doStream() {
          return {
            stream: streamFromParts([
              {
                result: { ok: true },
                toolCallId: "call-1",
                toolName: "search",
                type: "tool-result",
              },
            ]),
          };
        },
      }),
    });

    // No providerNativeTools declared → still rejects
    const rejection = await captureRejection(
      collectAsyncIterable(
        bridge.stream({
          messages: [{ parts: [{ text: "test", type: "text" }], role: "user" }],
        })
      )
    );
    expect(rejection.message).toContain(
      'AI SDK stream part "tool-result" is out of scope'
    );
  });
});

// ---------------------------------------------------------------------------
// Provider-mediated tool declaration mapping (AY004)
// ---------------------------------------------------------------------------

describe("provider-bridge-ai-sdk provider-mediated tools", () => {
  test("maps provider-mediated MCP config to LanguageModelV3ProviderTool with server_url", async () => {
    let capturedTools: unknown[] | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        doGenerate(options) {
          capturedTools = options.tools;
          return createGenerateResult();
        },
        provider: "openai",
      }),
    });

    const config: ProviderMediatedToolConfig = {
      endpoint: "https://my-mcp-server.example.com/mcp",
      mediationType: "mcp",
      name: "mcp_tool",
    };

    await bridge.generate({
      messages: [
        { parts: [{ text: "invoke mcp", type: "text" }], role: "user" },
      ],
      providerMediatedTools: [config],
    });

    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(1);
    expect(capturedTools?.[0]).toMatchObject({
      args: { server_url: "https://my-mcp-server.example.com/mcp" },
      name: "mcp_tool",
      type: "provider",
    });
  });

  test("accepts dynamic=true LanguageModelV3ToolResult for declared provider-mediated tool in generate", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        doGenerate() {
          return createGenerateResult({
            content: [
              {
                dynamic: true,
                result: { data: "from mcp" },
                toolCallId: "mediated-call-1",
                toolName: "mcp_tool",
                type: "tool-result",
              },
            ],
            finishReason: { raw: "stop", unified: "stop" },
          });
        },
        provider: "openai",
      }),
    });

    const response = await bridge.generate({
      messages: [{ parts: [{ text: "invoke", type: "text" }], role: "user" }],
      providerMediatedTools: [
        {
          endpoint: "https://example.com/mcp",
          mediationType: "mcp",
          name: "mcp_tool",
        },
      ],
    });

    expect(response.providerToolResults).toBeDefined();
    expect(response.providerToolResults).toHaveLength(1);
    const record = response.providerToolResults?.[0];
    expect(record?.name).toBe("mcp_tool");
    expect(record?.executionClass).toBe("provider-mediated");
    expect(
      response.parts.some(
        (p) => p.type === "tool_call" || p.type === "tool_result"
      )
    ).toBe(false);
  });

  test("rejects providerMediatedTools when bound model is not an OpenAI provider", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({ provider: "anthropic" }),
    });

    const rejection = await captureRejection(
      bridge.generate({
        messages: [{ parts: [{ text: "go", type: "text" }], role: "user" }],
        providerMediatedTools: [
          {
            endpoint: "https://example.com/mcp",
            mediationType: "mcp",
            name: "mcp_tool",
          },
        ],
      })
    );
    expect(rejection.message).toContain(
      "provider-mediated tools require an OpenAI-bound model"
    );
  });

  test("yields provider_tool_result chunk with executionClass provider-mediated for declared mediated tool in stream", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        doStream() {
          return {
            stream: streamFromParts([
              {
                dynamic: true,
                result: { items: ["a", "b"] },
                toolCallId: "mediated-stream-1",
                toolName: "mcp_tool",
                type: "tool-result",
              },
              {
                finishReason: { raw: "stop", unified: "stop" },
                type: "finish",
                usage: createUsage(2, 1),
              },
            ]),
          };
        },
        provider: "openai",
      }),
    });

    const chunks = await collectAsyncIterable(
      bridge.stream({
        messages: [{ parts: [{ text: "go", type: "text" }], role: "user" }],
        providerMediatedTools: [
          {
            endpoint: "https://example.com/mcp",
            mediationType: "mcp",
            name: "mcp_tool",
          },
        ],
      })
    );

    const providerResultChunk = chunks.find(
      (
        chunk
      ): chunk is Extract<
        (typeof chunks)[number],
        { type: "provider_tool_result" }
      > => chunk.type === "provider_tool_result"
    );
    expect(providerResultChunk).toBeDefined();
    expect(providerResultChunk?.name).toBe("mcp_tool");
    const meta = providerResultChunk?.providerMetadata;
    expect(meta?.executionClass).toBe("provider-mediated");
  });
});

// ---------------------------------------------------------------------------
// Provider continuation-state passthrough (AY005)
// ---------------------------------------------------------------------------

describe("provider-bridge-ai-sdk provider continuity", () => {
  test("merges providerContinuity into providerOptions for the next call", async () => {
    let capturedProviderOptions: Record<string, unknown> | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        doGenerate(options) {
          capturedProviderOptions = options.providerOptions;
          return createGenerateResult();
        },
      }),
    });

    await bridge.generate({
      messages: [{ parts: [{ text: "continue", type: "text" }], role: "user" }],
      providerContinuity: {
        anthropic: { sessionId: "abc123" },
      },
    });

    expect(capturedProviderOptions).toBeDefined();
    const anthropicOptions = capturedProviderOptions?.anthropic;
    expect(
      isRecord(anthropicOptions) ? anthropicOptions.sessionId : undefined
    ).toBe("abc123");
  });
});
