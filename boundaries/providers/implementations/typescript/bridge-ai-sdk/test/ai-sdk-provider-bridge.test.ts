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
                text: "thinking",
                type: "reasoning",
              },
              {
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

    const response = await bridge.generate({
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
          parts: [
            {
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
          redacted: false,
          text: "thinking",
          type: "reasoning",
        },
        {
          data: {
            answer: "ready",
          },
          name: "answer",
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

    const chunks = await collectAsyncIterable(
      bridge.stream({
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
      })
    );

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
