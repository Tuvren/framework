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

import { describe, expect, test } from "bun:test";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  ProviderV3,
} from "@ai-sdk/provider";
import { TuvrenProviderError } from "@tuvren/core-types";
import { createReActDriver } from "@tuvren/driver-react";
import {
  assertProviderChunkTypes,
  assertProviderFinishChunk,
  assertProviderStructuredDoneChunk,
  verifyProviderGenerate,
  verifyProviderRejects,
  verifyProviderStream,
} from "@tuvren/provider-testkit";
import {
  createDriverRegistry,
  createTuvrenRuntimeCore,
} from "@tuvren/runtime-core";
import { createFakeKernelHarness } from "../../../../../framework/implementations/typescript/runtime-core/test/fake-kernel.ts";
import {
  createAiSdkProviderBridge,
  createAiSdkProviderBridgeFromProvider,
} from "../src/index.ts";

describe("provider-bridge-ai-sdk", () => {
  test("maps prompt config into LanguageModelV3 call options and synthesizes structured generate output", async () => {
    let capturedOptions: LanguageModelV3CallOptions | undefined;
    const bridge = createAiSdkProviderBridge({
      defaultHeaders: {
        authorization: "Bearer test",
      },
      defaultProviderOptions: {
        openai: {
          textVerbosity: "low",
        },
      },
      model: createMockModel({
        async doGenerate(options) {
          await Promise.resolve();
          capturedOptions = options;
          return createGenerateResult({
            content: [
              {
                providerMetadata: {
                  anthropic: {
                    signature: "sig-result",
                  },
                },
                text: "thinking",
                type: "reasoning",
              },
              {
                providerMetadata: {
                  openai: {
                    encryptedContent: "enc-structured",
                  },
                },
                text: '{"answer":"ready"}',
                type: "text",
              },
            ],
            providerMetadata: {
              openai: {
                requestId: "req-1",
              },
            },
            response: {
              headers: {
                "x-request-id": "req-1",
              },
              id: "resp-1",
              modelId: "mock-model",
              timestamp: new Date("2026-01-01T00:00:00.000Z"),
            },
            usage: createUsage(11, 5),
            warnings: [
              {
                feature: "topK",
                type: "unsupported",
              },
            ],
          });
        },
      }),
    });

    const response = await verifyProviderGenerate({
      provider: bridge,
      prompt: {
        config: {
          model: "mock-model",
          provider: "mock-provider",
          settings: {
            headers: {
              "x-trace-id": "trace-1",
            },
            maxOutputTokens: 128,
            providerOptions: {
              openai: {
                reasoningEffort: "low",
              },
            },
            toolChoice: "required",
          },
        },
        messages: [
          {
            content: "You are helpful",
            role: "system",
          },
          {
            parts: [
              { text: "Search the docs", type: "text" },
              {
                data: "ZmlsZQ==",
                mediaType: "text/plain",
                type: "file",
              },
            ],
            role: "user",
          },
          {
            providerMetadata: {
              aiSdkBridge: {
                requestBody: {
                  replayed: false,
                },
              },
              openai: {
                responseId: "resp-history",
              },
            },
            parts: [
              {
                providerMetadata: {
                  openai: {
                    encryptedContent: "enc-history",
                  },
                },
                text: "Previously answered",
                type: "text",
              },
              {
                providerMetadata: {
                  anthropic: {
                    signature: "sig-history",
                  },
                },
                redacted: false,
                text: "considering options",
                type: "reasoning",
              },
              {
                callId: "call-1",
                input: {
                  query: "docs",
                },
                name: "search",
                type: "tool_call",
              },
            ],
            role: "assistant",
          },
          {
            parts: [
              {
                callId: "call-1",
                name: "search",
                output: {
                  docs: ["bridge"],
                },
                type: "tool_result",
              },
            ],
            role: "tool",
          },
        ],
        responseFormat: {
          name: "answer",
          schema: {
            properties: {
              answer: {
                type: "string",
              },
            },
            required: ["answer"],
            type: "object",
          },
        },
        tools: [
          {
            description: "Search docs",
            inputSchema: {
              properties: {
                query: {
                  type: "string",
                },
              },
              required: ["query"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
    });

    expect(capturedOptions).toEqual(
      expect.objectContaining({
        headers: {
          authorization: "Bearer test",
          "x-trace-id": "trace-1",
        },
        maxOutputTokens: 128,
        providerOptions: {
          openai: {
            reasoningEffort: "low",
            textVerbosity: "low",
          },
        },
        responseFormat: {
          name: "answer",
          schema: {
            properties: {
              answer: {
                type: "string",
              },
            },
            required: ["answer"],
            type: "object",
          },
          type: "json",
        },
        toolChoice: {
          type: "required",
        },
        tools: [
          {
            description: "Search docs",
            inputSchema: {
              properties: {
                query: {
                  type: "string",
                },
              },
              required: ["query"],
              type: "object",
            },
            name: "search",
            type: "function",
          },
        ],
      })
    );
    expect(capturedOptions?.prompt).toEqual([
      {
        content: "You are helpful",
        role: "system",
      },
      {
        content: [
          {
            text: "Search the docs",
            type: "text",
          },
          {
            data: "ZmlsZQ==",
            mediaType: "text/plain",
            type: "file",
          },
        ],
        role: "user",
      },
      {
        content: [
          {
            text: "Previously answered",
            type: "text",
          },
          {
            providerOptions: {
              anthropic: {
                signature: "sig-history",
              },
            },
            text: "considering options",
            type: "reasoning",
          },
          {
            input: {
              query: "docs",
            },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "json",
              value: {
                docs: ["bridge"],
              },
            },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);
    expect(response).toEqual({
      finishReason: "stop",
      parts: [
        {
          providerMetadata: {
            anthropic: {
              signature: "sig-result",
            },
          },
          redacted: false,
          text: "thinking",
          type: "reasoning",
        },
        {
          data: {
            answer: "ready",
          },
          name: "answer",
          providerMetadata: {
            openai: {
              encryptedContent: "enc-structured",
            },
          },
          type: "structured",
        },
      ],
      providerMetadata: {
        aiSdkBridge: {
          rawUsage: {
            inputTokens: {
              cacheRead: 1,
              cacheWrite: 0,
              noCache: 10,
              total: 11,
            },
            outputTokens: {
              reasoning: 2,
              text: 3,
              total: 5,
            },
            raw: {
              provider: "mock-provider",
            },
          },
          requestBody: undefined,
          response: {
            body: undefined,
            headers: {
              "x-request-id": "req-1",
            },
            id: "resp-1",
            modelId: "mock-model",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
          sources: [],
          warnings: [
            {
              feature: "topK",
              type: "unsupported",
            },
          ],
        },
        openai: {
          requestId: "req-1",
        },
      },
      usage: {
        inputTokens: 11,
        outputTokens: 5,
      },
    });
  });

  test("maps stream parts into provider chunks and synthesizes structured output from JSON text", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            request: {
              body: {
                streamed: true,
              },
            },
            response: {
              headers: {
                "x-stream-id": "stream-1",
              },
            },
            stream: streamFromParts([
              {
                type: "stream-start",
                warnings: [
                  {
                    message: "compatibility mode",
                    type: "other",
                  },
                ],
              },
              {
                id: "message-1",
                type: "text-start",
              },
              {
                delta: '{"answer":"ready"}',
                id: "message-1",
                type: "text-delta",
              },
              {
                id: "message-1",
                type: "text-end",
              },
              {
                id: "resp-1",
                modelId: "mock-model",
                timestamp: new Date("2026-01-02T00:00:00.000Z"),
                type: "response-metadata",
              },
              {
                finishReason: {
                  raw: "stop",
                  unified: "stop",
                },
                providerMetadata: {
                  anthropic: {
                    requestId: "stream-req",
                  },
                },
                type: "finish",
                usage: createUsage(7, 2),
              },
            ]),
          };
        },
      }),
    });

    const chunks = await verifyProviderStream({
      provider: bridge,
      prompt: {
        messages: [
          {
            parts: [{ text: "Return json", type: "text" }],
            role: "user",
          },
        ],
        responseFormat: {
          name: "answer",
          schema: {
            properties: {
              answer: {
                type: "string",
              },
            },
            required: ["answer"],
            type: "object",
          },
        },
      },
    });

    assertProviderChunkTypes(chunks, [
      "structured_delta",
      "structured_done",
      "finish",
    ]);
    expect(assertProviderStructuredDoneChunk(chunks, "answer").data).toEqual({
      answer: "ready",
    });
    expect(assertProviderFinishChunk(chunks, "stop").usage).toEqual({
      inputTokens: 7,
      outputTokens: 2,
    });

    expect(chunks).toEqual([
      {
        delta: '{"answer":"ready"}',
        type: "structured_delta",
      },
      {
        data: {
          answer: "ready",
        },
        name: "answer",
        type: "structured_done",
      },
      {
        finishReason: "stop",
        providerMetadata: {
          aiSdkBridge: {
            rawParts: [],
            rawUsage: {
              inputTokens: {
                cacheRead: 1,
                cacheWrite: 0,
                noCache: 6,
                total: 7,
              },
              outputTokens: {
                reasoning: 0,
                text: 2,
                total: 2,
              },
              raw: {
                provider: "mock-provider",
              },
            },
            requestBody: {
              streamed: true,
            },
            response: {
              headers: {
                "x-stream-id": "stream-1",
              },
              metadata: {
                id: "resp-1",
                modelId: "mock-model",
                timestamp: "2026-01-02T00:00:00.000Z",
              },
            },
            sources: [],
            streamPartMetadata: [
              {
                providerMetadata: {
                  anthropic: {
                    requestId: "stream-req",
                  },
                },
                type: "finish",
              },
            ],
            warnings: [
              {
                message: "compatibility mode",
                type: "other",
              },
            ],
          },
          anthropic: {
            requestId: "stream-req",
          },
        },
        type: "finish",
        usage: {
          inputTokens: 7,
          outputTokens: 2,
        },
      },
    ]);
  });

  test("preserves generated text provider metadata on canonical text parts", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          await Promise.resolve();
          return createGenerateResult({
            content: [
              {
                providerMetadata: {
                  openai: {
                    encryptedContent: "enc-text",
                  },
                },
                text: "hello",
                type: "text",
              },
            ],
          });
        },
      }),
    });

    const response = await bridge.generate({
      messages: [
        {
          parts: [{ text: "Hello", type: "text" }],
          role: "user",
        },
      ],
    });

    expect(response.parts).toEqual([
      {
        providerMetadata: {
          openai: {
            encryptedContent: "enc-text",
          },
        },
        text: "hello",
        type: "text",
      },
    ]);
  });

  test("normalizes flat durable reasoning signatures for assistant replay", async () => {
    let capturedOptions: LanguageModelV3CallOptions | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate(options) {
          await Promise.resolve();
          capturedOptions = options;
          return createGenerateResult();
        },
      }),
    });

    await bridge.generate({
      messages: [
        {
          parts: [
            {
              providerMetadata: {
                signature: "sig-1",
              },
              redacted: false,
              text: "Thinking",
              type: "reasoning",
            },
          ],
          role: "assistant",
        },
        {
          parts: [{ text: "Continue", type: "text" }],
          role: "user",
        },
      ],
    });

    expect(capturedOptions?.prompt).toEqual([
      {
        content: [
          {
            providerOptions: {
              anthropic: {
                signature: "sig-1",
              },
            },
            text: "Thinking",
            type: "reasoning",
          },
        ],
        role: "assistant",
      },
      {
        content: [{ text: "Continue", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("replays OpenAI reasoning encrypted content on assistant reasoning parts", async () => {
    let capturedOptions: LanguageModelV3CallOptions | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate(options) {
          await Promise.resolve();
          capturedOptions = options;
          return createGenerateResult();
        },
        provider: "openai",
      }),
    });

    await bridge.generate({
      messages: [
        {
          parts: [
            {
              providerMetadata: {
                openai: {
                  reasoningEncryptedContent: "enc-1",
                },
              },
              redacted: false,
              text: "Thinking",
              type: "reasoning",
            },
          ],
          role: "assistant",
        },
        {
          parts: [{ text: "Continue", type: "text" }],
          role: "user",
        },
      ],
    });

    expect(capturedOptions?.prompt).toEqual([
      {
        content: [
          {
            providerOptions: {
              openai: {
                reasoningEncryptedContent: "enc-1",
              },
            },
            text: "Thinking",
            type: "reasoning",
          },
        ],
        role: "assistant",
      },
      {
        content: [{ text: "Continue", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("replays Google reasoning thought signatures on assistant reasoning parts", async () => {
    let capturedOptions: LanguageModelV3CallOptions | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate(options) {
          await Promise.resolve();
          capturedOptions = options;
          return createGenerateResult();
        },
        provider: "google",
      }),
    });

    await bridge.generate({
      messages: [
        {
          parts: [
            {
              providerMetadata: {
                google: {
                  thoughtSignature: "thought-1",
                },
              },
              redacted: false,
              text: "Thinking",
              type: "reasoning",
            },
          ],
          role: "assistant",
        },
        {
          parts: [{ text: "Continue", type: "text" }],
          role: "user",
        },
      ],
    });

    expect(capturedOptions?.prompt).toEqual([
      {
        content: [
          {
            providerOptions: {
              google: {
                thoughtSignature: "thought-1",
              },
            },
            text: "Thinking",
            type: "reasoning",
          },
        ],
        role: "assistant",
      },
      {
        content: [{ text: "Continue", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("replays Google thought signatures on assistant tool call parts", async () => {
    let capturedOptions: LanguageModelV3CallOptions | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate(options) {
          await Promise.resolve();
          capturedOptions = options;
          return createGenerateResult();
        },
        provider: "google",
      }),
    });

    await bridge.generate({
      messages: [
        {
          parts: [
            {
              callId: "call-1",
              input: {
                query: "docs",
              },
              name: "search",
              providerMetadata: {
                google: {
                  thoughtSignature: "thought-tool-1",
                },
              },
              type: "tool_call",
            },
          ],
          role: "assistant",
        },
        {
          parts: [{ text: "Continue", type: "text" }],
          role: "user",
        },
      ],
    });

    expect(capturedOptions?.prompt).toEqual([
      {
        content: [
          {
            input: {
              query: "docs",
            },
            providerOptions: {
              google: {
                thoughtSignature: "thought-tool-1",
              },
            },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [{ text: "Continue", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("propagates Google tool call thought signatures across parallel assistant tool calls", async () => {
    let capturedOptions: LanguageModelV3CallOptions | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate(options) {
          await Promise.resolve();
          capturedOptions = options;
          return createGenerateResult();
        },
        provider: "google",
      }),
    });

    await bridge.generate({
      messages: [
        {
          parts: [
            {
              callId: "call-1",
              input: {
                query: "docs",
              },
              name: "search",
              providerMetadata: {
                google: {
                  thoughtSignature: "parallel-thought-1",
                },
              },
              type: "tool_call",
            },
            {
              callId: "call-2",
              input: {
                to: "ops@example.com",
              },
              name: "email",
              type: "tool_call",
            },
          ],
          role: "assistant",
        },
        {
          parts: [{ text: "Continue", type: "text" }],
          role: "user",
        },
      ],
    });

    expect(capturedOptions?.prompt).toEqual([
      {
        content: [
          {
            input: {
              query: "docs",
            },
            providerOptions: {
              google: {
                thoughtSignature: "parallel-thought-1",
              },
            },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-call",
          },
          {
            input: {
              to: "ops@example.com",
            },
            providerOptions: {
              google: {
                thoughtSignature: "parallel-thought-1",
              },
            },
            toolCallId: "call-2",
            toolName: "email",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [{ text: "Continue", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("does not replay output-only assistant metadata into provider options", async () => {
    let capturedOptions: LanguageModelV3CallOptions | undefined;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate(options) {
          await Promise.resolve();
          capturedOptions = options;
          return createGenerateResult();
        },
      }),
    });

    await bridge.generate({
      messages: [
        {
          providerMetadata: {
            aiSdkBridge: {
              requestBody: {
                replayed: false,
              },
            },
            mockProvider: {
              requestId: "req-1",
            },
          },
          parts: [
            {
              providerMetadata: {
                mockProvider: {
                  requestId: "part-1",
                },
              },
              text: "hello",
              type: "text",
            },
            {
              providerMetadata: {
                signature: "sig-2",
              },
              redacted: false,
              text: "thinking",
              type: "reasoning",
            },
          ],
          role: "assistant",
        },
        {
          parts: [{ text: "Continue", type: "text" }],
          role: "user",
        },
      ],
    });

    expect(capturedOptions?.prompt).toEqual([
      {
        content: [
          {
            text: "hello",
            type: "text",
          },
          {
            providerOptions: {
              anthropic: {
                signature: "sig-2",
              },
            },
            text: "thinking",
            type: "reasoning",
          },
        ],
        role: "assistant",
      },
      {
        content: [{ text: "Continue", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("allows tool-call-only generate turns when structured output is requested", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          await Promise.resolve();
          return createGenerateResult({
            content: [
              {
                input: '{"query":"docs"}',
                toolCallId: "call-1",
                toolName: "search",
                type: "tool-call",
              },
            ],
            finishReason: {
              raw: "tool-calls",
              unified: "tool-calls",
            },
          });
        },
      }),
    });

    const response = await bridge.generate({
      messages: [
        {
          parts: [{ text: "Search", type: "text" }],
          role: "user",
        },
      ],
      responseFormat: {
        name: "answer",
        schema: {
          properties: {
            answer: {
              type: "string",
            },
          },
          required: ["answer"],
          type: "object",
        },
      },
    });

    expect(response).toEqual(
      expect.objectContaining({
        finishReason: "tool_call",
        parts: [
          expect.objectContaining({
            callId: expect.any(String),
            input: {
              query: "docs",
            },
            name: "search",
            providerMetadata: {
              providerCallId: "call-1",
            },
            type: "tool_call",
          }),
        ],
      })
    );
  });

  test("normalizes generated tool-call finish reasons when a provider reports stop", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          await Promise.resolve();
          return createGenerateResult({
            content: [
              {
                input: '{"query":"docs"}',
                toolCallId: "call-1",
                toolName: "search",
                type: "tool-call",
              },
            ],
            finishReason: {
              raw: "STOP",
              unified: "stop",
            },
          });
        },
        provider: "google",
      }),
    });

    const response = await bridge.generate({
      messages: [
        {
          parts: [{ text: "Search", type: "text" }],
          role: "user",
        },
      ],
    });

    expect(response.finishReason).toBe("tool_call");
  });

  test("marks generated Anthropic redacted thinking as redacted reasoning", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          await Promise.resolve();
          return createGenerateResult({
            content: [
              {
                providerMetadata: {
                  anthropic: {
                    redactedData: "redacted-thinking",
                  },
                },
                text: "",
                type: "reasoning",
              },
            ],
          });
        },
      }),
    });

    const response = await bridge.generate({
      messages: [
        {
          parts: [{ text: "Think", type: "text" }],
          role: "user",
        },
      ],
    });

    expect(response.parts).toEqual([
      {
        providerMetadata: {
          anthropic: {
            redactedData: "redacted-thinking",
          },
        },
        redacted: true,
        text: "",
        type: "reasoning",
      },
    ]);
  });

  test("allows tool-call-only streamed turns when structured output is requested", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "call-1",
                providerMetadata: {
                  google: {
                    thoughtSignature: "tool-thought-1",
                  },
                },
                toolName: "search",
                type: "tool-input-start",
              },
              {
                delta: '{"query":"docs"}',
                id: "call-1",
                type: "tool-input-delta",
              },
              {
                id: "call-1",
                type: "tool-input-end",
              },
              {
                finishReason: {
                  raw: "tool-calls",
                  unified: "tool-calls",
                },
                type: "finish",
                usage: createUsage(4, 2),
              },
            ]),
          };
        },
      }),
    });

    const chunks = await collectAsyncIterable(
      bridge.stream({
        messages: [
          {
            parts: [{ text: "Search", type: "text" }],
            role: "user",
          },
        ],
        responseFormat: {
          name: "answer",
          schema: {
            properties: {
              answer: {
                type: "string",
              },
            },
            required: ["answer"],
            type: "object",
          },
        },
      })
    );

    expect(chunks.slice(0, 3)).toEqual([
      {
        name: "search",
        providerCallId: "call-1",
        type: "tool_call_start",
      },
      {
        delta: '{"query":"docs"}',
        providerCallId: "call-1",
        type: "tool_call_args_delta",
      },
      {
        input: {
          query: "docs",
        },
        name: "search",
        providerCallId: "call-1",
        providerMetadata: {
          google: {
            thoughtSignature: "tool-thought-1",
          },
        },
        type: "tool_call_done",
      },
    ]);
    expect(chunks[3]).toMatchObject({
      finishReason: "tool_call",
      providerMetadata: {
        aiSdkBridge: {
          rawParts: [],
          rawUsage: {
            inputTokens: {
              cacheRead: 1,
              cacheWrite: 0,
              noCache: 3,
              total: 4,
            },
            outputTokens: {
              reasoning: 0,
              text: 2,
              total: 2,
            },
            raw: {
              provider: "mock-provider",
            },
          },
          response: {},
          sources: [],
          streamPartMetadata: [
            {
              id: "call-1",
              providerMetadata: {
                google: {
                  thoughtSignature: "tool-thought-1",
                },
              },
              type: "tool-input-start",
            },
          ],
          warnings: [],
        },
      },
      type: "finish",
      usage: {
        inputTokens: 4,
        outputTokens: 2,
      },
    });
  });

  test("normalizes streamed Gemini function-call finish reasons from provider fallbacks", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "call-1",
                toolName: "search",
                type: "tool-input-start",
              },
              {
                delta: '{"query":"docs"}',
                id: "call-1",
                type: "tool-input-delta",
              },
              {
                id: "call-1",
                type: "tool-input-end",
              },
              {
                finishReason: {
                  raw: "FUNCTION_CALL",
                  unified: "other",
                },
                type: "finish",
                usage: createUsage(3, 1),
              },
            ]),
          };
        },
        provider: "google",
      }),
    });

    const chunks = await collectAsyncIterable(
      bridge.stream({
        messages: [
          {
            parts: [{ text: "Search", type: "text" }],
            role: "user",
          },
        ],
      })
    );

    expect(assertProviderFinishChunk(chunks, "tool_call").usage).toEqual({
      inputTokens: 3,
      outputTokens: 1,
    });
  });

  test("preserves incremental tool-call metadata when the closing tool-call omits it", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "call-1",
                providerMetadata: {
                  google: {
                    thoughtSignature: "tool-thought-1",
                  },
                },
                toolName: "search",
                type: "tool-input-start",
              },
              {
                delta: '{"query":"docs"}',
                id: "call-1",
                type: "tool-input-delta",
              },
              {
                input: '{"query":"docs"}',
                toolCallId: "call-1",
                toolName: "search",
                type: "tool-call",
              },
              {
                finishReason: {
                  raw: "FUNCTION_CALL",
                  unified: "other",
                },
                type: "finish",
                usage: createUsage(3, 1),
              },
            ]),
          };
        },
        provider: "google",
      }),
    });

    const chunks = await collectAsyncIterable(
      bridge.stream({
        messages: [
          {
            parts: [{ text: "Search", type: "text" }],
            role: "user",
          },
        ],
      })
    );

    expect(chunks.slice(0, 3)).toEqual([
      {
        name: "search",
        providerCallId: "call-1",
        type: "tool_call_start",
      },
      {
        delta: '{"query":"docs"}',
        providerCallId: "call-1",
        type: "tool_call_args_delta",
      },
      {
        input: {
          query: "docs",
        },
        name: "search",
        providerCallId: "call-1",
        providerMetadata: {
          google: {
            thoughtSignature: "tool-thought-1",
          },
        },
        type: "tool_call_done",
      },
    ]);
    expect(assertProviderFinishChunk(chunks, "tool_call").usage).toEqual({
      inputTokens: 3,
      outputTokens: 1,
    });
  });

  test("merges late tool-call metadata after tool-input-end before emitting done", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "call-1",
                toolName: "search",
                type: "tool-input-start",
              },
              {
                delta: '{"query":"docs"}',
                id: "call-1",
                type: "tool-input-delta",
              },
              {
                id: "call-1",
                type: "tool-input-end",
              },
              {
                input: '{"query":"docs"}',
                providerMetadata: {
                  google: {
                    thoughtSignature: "tool-thought-2",
                  },
                },
                toolCallId: "call-1",
                toolName: "search",
                type: "tool-call",
              },
              {
                finishReason: {
                  raw: "FUNCTION_CALL",
                  unified: "other",
                },
                type: "finish",
                usage: createUsage(3, 1),
              },
            ]),
          };
        },
        provider: "google",
      }),
    });

    const chunks = await collectAsyncIterable(
      bridge.stream({
        messages: [
          {
            parts: [{ text: "Search", type: "text" }],
            role: "user",
          },
        ],
      })
    );

    expect(chunks.slice(0, 3)).toEqual([
      {
        name: "search",
        providerCallId: "call-1",
        type: "tool_call_start",
      },
      {
        delta: '{"query":"docs"}',
        providerCallId: "call-1",
        type: "tool_call_args_delta",
      },
      {
        input: {
          query: "docs",
        },
        name: "search",
        providerCallId: "call-1",
        providerMetadata: {
          google: {
            thoughtSignature: "tool-thought-2",
          },
        },
        type: "tool_call_done",
      },
    ]);
    expect(chunks[3]).toMatchObject({
      finishReason: "tool_call",
      providerMetadata: {
        aiSdkBridge: {
          streamPartMetadata: [
            {
              toolCallId: "call-1",
              type: "tool-call",
            },
          ],
        },
      },
      type: "finish",
    });
  });

  test("does not normalize malformed function-call errors into tool-call finishes", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "call-1",
                toolName: "search",
                type: "tool-input-start",
              },
              {
                delta: '{"query":',
                id: "call-1",
                type: "tool-input-delta",
              },
              {
                finishReason: {
                  raw: "MALFORMED_FUNCTION_CALL",
                  unified: "error",
                },
                type: "finish",
                usage: createUsage(3, 1),
              },
            ]),
          };
        },
        provider: "google",
      }),
    });

    await expect(
      collectAsyncIterable(
        bridge.stream({
          messages: [
            {
              parts: [{ text: "Search", type: "text" }],
              role: "user",
            },
          ],
        })
      )
    ).rejects.toThrow(TuvrenProviderError);
  });

  test("preserves streamed Google reasoning thought signatures in reasoning chunks", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "reasoning-1",
                providerMetadata: {
                  google: {
                    thoughtSignature: "thought-2",
                  },
                },
                type: "reasoning-start",
              },
              {
                delta: "Reasoning",
                id: "reasoning-1",
                providerMetadata: {
                  google: {
                    thoughtSignature: "thought-2",
                  },
                },
                type: "reasoning-delta",
              },
              {
                id: "reasoning-1",
                type: "reasoning-end",
              },
              {
                finishReason: {
                  raw: "stop",
                  unified: "stop",
                },
                type: "finish",
                usage: createUsage(3, 2),
              },
            ]),
          };
        },
        provider: "google",
      }),
    });

    const chunks = await collectAsyncIterable(
      bridge.stream({
        messages: [
          {
            parts: [{ text: "Think", type: "text" }],
            role: "user",
          },
        ],
      })
    );

    expect(chunks).toEqual([
      {
        signature: "thought-2",
        text: "Reasoning",
        type: "reasoning_delta",
      },
      {
        type: "reasoning_done",
      },
      {
        finishReason: "stop",
        providerMetadata: {
          aiSdkBridge: {
            rawParts: [],
            rawUsage: {
              inputTokens: {
                cacheRead: 1,
                cacheWrite: 0,
                noCache: 2,
                total: 3,
              },
              outputTokens: {
                reasoning: 0,
                text: 2,
                total: 2,
              },
              raw: {
                provider: "mock-provider",
              },
            },
            requestBody: undefined,
            response: {
              headers: undefined,
              metadata: undefined,
            },
            sources: [],
            streamPartMetadata: [
              {
                id: "reasoning-1",
                providerMetadata: {
                  google: {
                    thoughtSignature: "thought-2",
                  },
                },
                type: "reasoning-start",
              },
              {
                id: "reasoning-1",
                providerMetadata: {
                  google: {
                    thoughtSignature: "thought-2",
                  },
                },
                type: "reasoning-delta",
              },
            ],
            warnings: [],
          },
        },
        type: "finish",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
        },
      },
    ]);
  });

  test("rejects strict structured-output requests in the bridge baseline", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel(),
    });

    await verifyProviderRejects({
      expectedMessage: "StructuredOutputRequest.strict is not supported",
      run: async () => {
        await bridge.generate({
          messages: [
            {
              parts: [{ text: "Hello", type: "text" }],
              role: "user",
            },
          ],
          responseFormat: {
            name: "answer",
            schema: {
              properties: {
                answer: {
                  type: "string",
                },
              },
              required: ["answer"],
              type: "object",
            },
            strict: true,
          },
        });
      },
    });
  });

  test("rejects unsupported provider-owned tool results in the baseline bridge", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          await Promise.resolve();
          return createGenerateResult({
            content: [
              {
                result: {
                  status: "done",
                },
                toolCallId: "tool-1",
                toolName: "search",
                type: "tool-result",
              },
            ],
          });
        },
      }),
    });

    await expect(
      bridge.generate({
        messages: [
          {
            parts: [{ text: "Run a tool", type: "text" }],
            role: "user",
          },
        ],
      })
    ).rejects.toBeInstanceOf(TuvrenProviderError);
  });

  test("rejects non-JSON default provider options", () => {
    expect(() =>
      createAiSdkProviderBridge({
        defaultProviderOptions: {
          openai: {
            requestedAt: Number.NaN,
          },
        },
        model: createMockModel(),
      })
    ).toThrow("AI SDK bridge JSON object values must be JSON-serializable");
  });

  test("rejects mismatched prompt providers", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel(),
    });

    await expect(
      bridge.generate({
        config: {
          provider: "different-provider",
        },
        messages: [
          {
            parts: [{ text: "Hello", type: "text" }],
            role: "user",
          },
        ],
      })
    ).rejects.toThrow(
      "TuvrenPrompt.config.provider does not match the bound AI SDK provider"
    );
  });

  test("rejects streamed file parts in the baseline bridge", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                data: "Zm9v",
                mediaType: "text/plain",
                type: "file",
              },
            ]),
          };
        },
      }),
    });

    await expect(
      collectAsyncIterable(
        bridge.stream({
          messages: [
            {
              parts: [{ text: "Hello", type: "text" }],
              role: "user",
            },
          ],
        })
      )
    ).rejects.toThrow('AI SDK stream part "file" is out of scope');
  });

  test("rejects streamed provider tool results in the baseline bridge", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                result: {
                  ok: true,
                },
                toolCallId: "call-1",
                toolName: "search",
                type: "tool-result",
              },
            ]),
          };
        },
      }),
    });

    await expect(
      collectAsyncIterable(
        bridge.stream({
          messages: [
            {
              parts: [{ text: "Hello", type: "text" }],
              role: "user",
            },
          ],
        })
      )
    ).rejects.toThrow('AI SDK stream part "tool-result" is out of scope');
  });

  test("rejects streamed provider approval requests in the baseline bridge", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                approvalId: "approval-1",
                toolCallId: "call-1",
                type: "tool-approval-request",
              },
            ]),
          };
        },
      }),
    });

    await expect(
      collectAsyncIterable(
        bridge.stream({
          messages: [
            {
              parts: [{ text: "Hello", type: "text" }],
              role: "user",
            },
          ],
        })
      )
    ).rejects.toThrow(
      'AI SDK stream part "tool-approval-request" is out of scope'
    );
  });

  test("rejects streamed finishes before tool calls complete", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "call-1",
                toolName: "search",
                type: "tool-input-start",
              },
              {
                finishReason: {
                  raw: "tool-calls",
                  unified: "tool-calls",
                },
                type: "finish",
                usage: createUsage(3, 1),
              },
            ]),
          };
        },
      }),
    });

    await expect(
      collectAsyncIterable(
        bridge.stream({
          messages: [
            {
              parts: [{ text: "Hello", type: "text" }],
              role: "user",
            },
          ],
        })
      )
    ).rejects.toThrow("AI SDK stream finished before tool call completed");
  });

  test("rejects provider-executed streamed tool inputs in the baseline bridge", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "call-1",
                providerExecuted: true,
                toolName: "search",
                type: "tool-input-start",
              },
            ]),
          };
        },
      }),
    });

    await expect(
      collectAsyncIterable(
        bridge.stream({
          messages: [
            {
              parts: [{ text: "Hello", type: "text" }],
              role: "user",
            },
          ],
        })
      )
    ).rejects.toThrow(
      "provider-owned tool execution is out of scope for the baseline AI SDK bridge"
    );
  });

  test("rejects dynamic streamed tool inputs in the baseline bridge", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                dynamic: true,
                id: "call-1",
                toolName: "search",
                type: "tool-input-start",
              },
            ]),
          };
        },
      }),
    });

    await expect(
      collectAsyncIterable(
        bridge.stream({
          messages: [
            {
              parts: [{ text: "Hello", type: "text" }],
              role: "user",
            },
          ],
        })
      )
    ).rejects.toThrow(
      "provider-owned tool execution is out of scope for the baseline AI SDK bridge"
    );
  });

  test("rejects mismatched incremental and complete streamed tool call identifiers", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "input-1",
                toolName: "search",
                type: "tool-input-start",
              },
              {
                delta: '{"query":"docs"}',
                id: "input-1",
                type: "tool-input-delta",
              },
              {
                id: "input-1",
                type: "tool-input-end",
              },
              {
                input: '{"query":"docs"}',
                toolCallId: "call-1",
                toolName: "search",
                type: "tool-call",
              },
            ]),
          };
        },
      }),
    });

    await expect(
      collectAsyncIterable(
        bridge.stream({
          messages: [
            {
              parts: [{ text: "Hello", type: "text" }],
              role: "user",
            },
          ],
        })
      )
    ).rejects.toThrow(
      "AI SDK stream emitted a complete tool-call with a mismatched incremental tool-input id"
    );
  });

  test("rejects same-id complete streamed tool calls that conflict with buffered incremental input", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "call-1",
                toolName: "search",
                type: "tool-input-start",
              },
              {
                delta: '{"query":"draft"}',
                id: "call-1",
                type: "tool-input-delta",
              },
              {
                id: "call-1",
                type: "tool-input-end",
              },
              {
                input: '{"query":"final"}',
                toolCallId: "call-1",
                toolName: "search",
                type: "tool-call",
              },
            ]),
          };
        },
      }),
    });

    await expect(
      collectAsyncIterable(
        bridge.stream({
          messages: [
            {
              parts: [{ text: "Hello", type: "text" }],
              role: "user",
            },
          ],
        })
      )
    ).rejects.toThrow(
      "AI SDK stream emitted a complete tool-call that conflicts with the incremental tool-input state"
    );
  });

  test("creates a bridge from ProviderV3 model lookup", async () => {
    const model = createMockModel({
      async doGenerate() {
        await Promise.resolve();
        return createGenerateResult({
          content: [
            {
              text: "from provider lookup",
              type: "text",
            },
          ],
        });
      },
    });
    const provider: ProviderV3 = {
      embeddingModel() {
        throw new Error("embeddingModel should not be called");
      },
      imageModel() {
        throw new Error("imageModel should not be called");
      },
      languageModel(modelId: string) {
        expect(modelId).toBe("mock-model");
        return model;
      },
      specificationVersion: "v3",
    };

    const bridge = createAiSdkProviderBridgeFromProvider({
      modelId: "mock-model",
      provider,
    });
    const response = await bridge.generate({
      messages: [
        {
          parts: [{ text: "Hello", type: "text" }],
          role: "user",
        },
      ],
    });

    expect(response.parts).toEqual([
      {
        text: "from provider lookup",
        type: "text",
      },
    ]);
  });

  test("runs through ReAct and runtime-core as a concrete TuvrenProvider", async () => {
    const harness = createFakeKernelHarness();
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "assistant-1",
                type: "text-start",
              },
              {
                delta: "Hello from bridge",
                id: "assistant-1",
                type: "text-delta",
              },
              {
                id: "assistant-1",
                type: "text-end",
              },
              {
                finishReason: {
                  raw: "stop",
                  unified: "stop",
                },
                type: "finish",
                usage: createUsage(4, 3),
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
      },
      signal: {
        parts: [{ text: "Say hello", type: "text" }],
      },
      threadId: thread.threadId,
    });

    const events = await collectAsyncIterable(handle.events());
    const committedMessages = await harness.readBranchMessages(thread.branchId);

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "message.done",
        "message.start",
        "text.delta",
        "text.done",
        "turn.end",
        "turn.start",
      ])
    );
    expect(committedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parts: [{ text: "Hello from bridge", type: "text" }],
          role: "assistant",
        }),
      ])
    );
  });

  test("preserves streamed reasoning signatures on canonical assistant history", async () => {
    const harness = createFakeKernelHarness();
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "reasoning-1",
                type: "reasoning-start",
              },
              {
                delta: "Thinking",
                id: "reasoning-1",
                providerMetadata: {
                  anthropic: {
                    signature: "sig-stream",
                  },
                },
                type: "reasoning-delta",
              },
              {
                id: "reasoning-1",
                type: "reasoning-end",
              },
              {
                finishReason: {
                  raw: "stop",
                  unified: "stop",
                },
                type: "finish",
                usage: createUsage(4, 3),
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
      },
      signal: {
        parts: [{ text: "Think", type: "text" }],
      },
      threadId: thread.threadId,
    });

    await collectAsyncIterable(handle.events());
    const committedMessages = await harness.readBranchMessages(thread.branchId);

    expect(committedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parts: [
            expect.objectContaining({
              providerMetadata: {
                anthropic: {
                  signature: "sig-stream",
                },
              },
              redacted: false,
              text: "Thinking",
              type: "reasoning",
            }),
          ],
          role: "assistant",
        }),
      ])
    );
  });

  test("preserves streamed Anthropic redacted thinking on canonical assistant history", async () => {
    const harness = createFakeKernelHarness();
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            stream: streamFromParts([
              {
                id: "reasoning-1",
                providerMetadata: {
                  anthropic: {
                    redactedData: "redacted-stream",
                  },
                },
                type: "reasoning-start",
              },
              {
                id: "reasoning-1",
                type: "reasoning-end",
              },
              {
                finishReason: {
                  raw: "stop",
                  unified: "stop",
                },
                type: "finish",
                usage: createUsage(4, 3),
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
      },
      signal: {
        parts: [{ text: "Think", type: "text" }],
      },
      threadId: thread.threadId,
    });

    await collectAsyncIterable(handle.events());
    const committedMessages = await harness.readBranchMessages(thread.branchId);

    expect(committedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parts: [
            {
              providerMetadata: {
                anthropic: {
                  redactedData: "redacted-stream",
                },
              },
              redacted: true,
              text: "",
              type: "reasoning",
            },
          ],
          role: "assistant",
        }),
      ])
    );
  });
});

function createMockModel(
  overrides: Partial<LanguageModelV3> & {
    doGenerate?: LanguageModelV3["doGenerate"];
    doStream?: LanguageModelV3["doStream"];
  } = {}
): LanguageModelV3 {
  return {
    async doGenerate() {
      await Promise.resolve();
      return createGenerateResult({
        content: [
          {
            text: "default",
            type: "text",
          },
        ],
      });
    },
    async doStream() {
      await Promise.resolve();
      return {
        stream: streamFromParts([
          {
            finishReason: {
              raw: "stop",
              unified: "stop",
            },
            type: "finish",
            usage: createUsage(1, 1),
          },
        ]),
      };
    },
    modelId: "mock-model",
    provider: "mock-provider",
    specificationVersion: "v3",
    supportedUrls: {},
    ...overrides,
  };
}

function createGenerateResult(
  overrides: Partial<LanguageModelV3GenerateResult> = {}
): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        text: "default",
        type: "text",
      },
    ],
    finishReason: {
      raw: "stop",
      unified: "stop",
    },
    usage: createUsage(1, 1),
    warnings: [],
    ...overrides,
  };
}

function createUsage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      cacheRead: 1,
      cacheWrite: 0,
      noCache: inputTokens - 1,
      total: inputTokens,
    },
    outputTokens: {
      reasoning: outputTokens > 2 ? 2 : 0,
      text: outputTokens > 2 ? outputTokens - 2 : outputTokens,
      total: outputTokens,
    },
    raw: {
      provider: "mock-provider",
    },
  };
}

function streamFromParts(
  parts: LanguageModelV3StreamPart[]
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }

      controller.close();
    },
  });
}

async function collectAsyncIterable<T>(
  iterable: AsyncIterable<T>
): Promise<T[]> {
  const values: T[] = [];

  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}
