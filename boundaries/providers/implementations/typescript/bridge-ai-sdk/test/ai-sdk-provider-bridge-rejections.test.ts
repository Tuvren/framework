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

// biome-ignore-all lint/suspicious/useAwait: Mock AI SDK model hooks intentionally preserve async provider signatures in rejection tests.

import { describe, expect, test } from "bun:test";
import { TuvrenProviderError } from "@tuvren/core-types";
import { verifyProviderRejects } from "@tuvren/provider-testkit";
import { createAiSdkProviderBridge } from "../src/index.ts";
import {
  collectAsyncIterable,
  createGenerateResult,
  createMockModel,
  createUsage,
  streamFromParts,
} from "./ai-sdk-provider-bridge-test-helpers.ts";

describe("provider-bridge-ai-sdk rejections", () => {
  test("rejects strict structured-output requests in the bridge baseline", async () => {
    let generateCalls = 0;
    let streamCalls = 0;
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          generateCalls += 1;
          return createGenerateResult();
        },
        async doStream() {
          streamCalls += 1;
          return {
            stream: streamFromParts([]),
          };
        },
      }),
    });

    const generateError = await verifyProviderRejects({
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

    const streamError = await verifyProviderRejects({
      expectedMessage: "StructuredOutputRequest.strict is not supported",
      run: async () => {
        for await (const _ of bridge.stream({
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
        })) {
          // Intentionally drain the stream to surface the rejection.
        }
      },
    });

    expect(generateError).toMatchObject({
      code: "invalid_ai_sdk_bridge_config",
      details: {
        reason: "native_strict_structured_output_unsupported",
      },
    });
    expect(streamError).toMatchObject({
      code: "invalid_ai_sdk_bridge_config",
      details: {
        reason: "native_strict_structured_output_unsupported",
      },
    });
    expect(generateCalls).toBe(0);
    expect(streamCalls).toBe(0);
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

    const error = await verifyProviderRejects({
      expectedMessage:
        'AI SDK stream part "tool-approval-request" is out of scope',
      run: async () => {
        await collectAsyncIterable(
          bridge.stream({
            messages: [
              {
                parts: [{ text: "Hello", type: "text" }],
                role: "user",
              },
            ],
          })
        );
      },
    });

    expect(error).toMatchObject({
      code: "unsupported_ai_sdk_stream_part",
      details: {
        reason: "provider_owned_tool_approval_unsupported",
      },
    });
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

    const error = await verifyProviderRejects({
      expectedMessage:
        "provider-owned tool execution is out of scope for the baseline AI SDK bridge",
      run: async () => {
        await collectAsyncIterable(
          bridge.stream({
            messages: [
              {
                parts: [{ text: "Hello", type: "text" }],
                role: "user",
              },
            ],
          })
        );
      },
    });

    expect(error).toMatchObject({
      code: "unsupported_ai_sdk_content",
      details: {
        reason: "provider_owned_tool_execution_unsupported",
      },
    });
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
});
