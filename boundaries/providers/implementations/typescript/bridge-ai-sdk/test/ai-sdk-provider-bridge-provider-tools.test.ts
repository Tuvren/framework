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
  streamFromParts,
} from "./ai-sdk-provider-bridge-test-helpers.ts";

// ---------------------------------------------------------------------------
// Provider-native tool declaration mapping (AY002)
// ---------------------------------------------------------------------------

describe("provider-bridge-ai-sdk provider-native tools", () => {
  test("maps provider-native declaration to LanguageModelV3ProviderTool in call options", async () => {
    let capturedTools: unknown[] | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate(options) {
          capturedTools = options.tools;
          return createGenerateResult();
        },
      }),
    });

    const declaration: ProviderNativeToolDeclaration = {
      id: "anthropic.code_execution_20260120",
      name: "code_execution",
      args: {},
    };

    await bridge.generate({
      messages: [{ parts: [{ text: "run code", type: "text" }], role: "user" }],
      providerNativeTools: [declaration],
    });

    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(1);
    expect(capturedTools?.[0]).toMatchObject({
      type: "provider",
      id: "anthropic.code_execution_20260120",
      name: "code_execution",
      args: {},
    });
  });

  test("maps provider-native declaration args through to LanguageModelV3ProviderTool", async () => {
    let capturedTools: unknown[] | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate(options) {
          capturedTools = options.tools;
          return createGenerateResult();
        },
      }),
    });

    const declaration: ProviderNativeToolDeclaration = {
      id: "xai.web_search",
      name: "web_search",
      args: { domain_filter: ["example.com"] },
    };

    await bridge.generate({
      messages: [{ parts: [{ text: "search", type: "text" }], role: "user" }],
      providerNativeTools: [declaration],
    });

    expect(capturedTools?.[0]).toMatchObject({
      type: "provider",
      id: "xai.web_search",
      args: { domain_filter: ["example.com"] },
    });
  });

  test("passes both function tools and provider-native tools in the same call", async () => {
    let capturedTools: unknown[] | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate(options) {
          capturedTools = options.tools;
          return createGenerateResult();
        },
      }),
    });

    await bridge.generate({
      messages: [{ parts: [{ text: "go", type: "text" }], role: "user" }],
      tools: [
        {
          name: "my_function",
          description: "a function tool",
          inputSchema: { type: "object" },
        },
      ],
      providerNativeTools: [
        { id: "anthropic.code_execution_20260120", name: "code_execution" },
      ],
    });

    expect(capturedTools).toHaveLength(2);
    const fnTool = capturedTools?.find(
      (t: unknown) => (t as { type: string }).type === "function"
    );
    const providerTool = capturedTools?.find(
      (t: unknown) => (t as { type: string }).type === "provider"
    );
    expect(fnTool).toBeDefined();
    expect(providerTool).toBeDefined();
  });

  test("accepts LanguageModelV3ToolResult for declared provider-native tool in generate", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          return createGenerateResult({
            content: [
              {
                result: { outputs: [{ type: "code", code: "print('hello')" }] },
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
        async doGenerate() {
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
    await expect(
      bridge.generate({
        messages: [{ parts: [{ text: "test", type: "text" }], role: "user" }],
      })
    ).rejects.toBeInstanceOf(TuvrenProviderError);
  });

  test("yields provider_tool_result chunk for declared provider-native tool in stream", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
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
      (c) => c.type === "provider_tool_result"
    );
    expect(providerResultChunk).toBeDefined();
    expect((providerResultChunk as { name: string }).name).toBe(
      "code_execution"
    );
    expect(
      (providerResultChunk as { providerCallId: string }).providerCallId
    ).toBe("native-stream-1");
  });

  test("still rejects undeclared streamed provider tool results (baseline protection)", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
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
    await expect(
      collectAsyncIterable(
        bridge.stream({
          messages: [{ parts: [{ text: "test", type: "text" }], role: "user" }],
        })
      )
    ).rejects.toThrow('AI SDK stream part "tool-result" is out of scope');
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
        provider: "openai",
        async doGenerate(options) {
          capturedTools = options.tools;
          return createGenerateResult();
        },
      }),
    });

    const config: ProviderMediatedToolConfig = {
      name: "mcp_tool",
      mediationType: "mcp",
      endpoint: "https://my-mcp-server.example.com/mcp",
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
      type: "provider",
      name: "mcp_tool",
      args: { server_url: "https://my-mcp-server.example.com/mcp" },
    });
  });

  test("accepts dynamic=true LanguageModelV3ToolResult for declared provider-mediated tool in generate", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doGenerate() {
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
      }),
    });

    const response = await bridge.generate({
      messages: [{ parts: [{ text: "invoke", type: "text" }], role: "user" }],
      providerMediatedTools: [
        {
          name: "mcp_tool",
          mediationType: "mcp",
          endpoint: "https://example.com/mcp",
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

    await expect(
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
    ).rejects.toThrow("provider-mediated tools require an OpenAI-bound model");
  });

  test("yields provider_tool_result chunk with executionClass provider-mediated for declared mediated tool in stream", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doStream() {
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
      }),
    });

    const chunks = await collectAsyncIterable(
      bridge.stream({
        messages: [{ parts: [{ text: "go", type: "text" }], role: "user" }],
        providerMediatedTools: [
          {
            name: "mcp_tool",
            mediationType: "mcp",
            endpoint: "https://example.com/mcp",
          },
        ],
      })
    );

    const providerResultChunk = chunks.find(
      (c) => c.type === "provider_tool_result"
    );
    expect(providerResultChunk).toBeDefined();
    expect((providerResultChunk as { name: string }).name).toBe("mcp_tool");
    const meta = (
      providerResultChunk as { providerMetadata?: Record<string, unknown> }
    ).providerMetadata;
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
        async doGenerate(options) {
          capturedProviderOptions = options.providerOptions as
            | Record<string, unknown>
            | undefined;
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
    expect(
      (capturedProviderOptions?.anthropic as Record<string, unknown>)?.sessionId
    ).toBe("abc123");
  });
});
