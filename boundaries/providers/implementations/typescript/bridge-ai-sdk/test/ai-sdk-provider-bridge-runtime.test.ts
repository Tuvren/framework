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
import type { ProviderV3 } from "@ai-sdk/provider";
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
import {
  collectAsyncIterable,
  createGenerateResult,
  createMockModel,
  createUsage,
  streamFromParts,
} from "./ai-sdk-provider-bridge-test-helpers.ts";

describe("provider-bridge-ai-sdk runtime", () => {
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
