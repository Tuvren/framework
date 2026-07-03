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
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import {
  assertProviderChunkTypes,
  assertProviderFinishChunk,
  assertProviderStructuredDoneChunk,
  verifyProviderGenerate,
  verifyProviderStream,
} from "@tuvren/provider-testkit";
import { createAiSdkProviderBridge } from "../src/index.ts";
import {
  createGenerateResult,
  createMockModel,
  createUsage,
  streamFromParts,
} from "./ai-sdk-provider-bridge-test-helpers.ts";

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
});
