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
import { createAiSdkProviderBridge } from "../src/index.ts";
import {
  createGenerateResult,
  createMockModel,
} from "./ai-sdk-provider-bridge-test-helpers.ts";

describe("provider-bridge-ai-sdk history replay", () => {
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
});
