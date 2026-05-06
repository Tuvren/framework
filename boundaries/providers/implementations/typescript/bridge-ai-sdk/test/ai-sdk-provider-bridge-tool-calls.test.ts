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
import { TuvrenProviderError } from "@tuvren/core-types";
import { assertProviderFinishChunk } from "@tuvren/provider-testkit";
import { createAiSdkProviderBridge } from "../src/index.ts";
import {
  collectAsyncIterable,
  createGenerateResult,
  createMockModel,
  createUsage,
  streamFromParts,
} from "./ai-sdk-provider-bridge-test-helpers.ts";

describe("provider-bridge-ai-sdk tool-call normalization", () => {
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
});
