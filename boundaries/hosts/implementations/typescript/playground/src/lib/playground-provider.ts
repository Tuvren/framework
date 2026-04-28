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

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { createAiSdkProviderBridge } from "@tuvren/provider-bridge-ai-sdk";
import type {
  ProviderStreamChunk,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/runtime-api";
import type {
  PlaygroundProviderMode,
  PlaygroundScenarioName,
} from "./playground-types.js";

export function createPlaygroundProvider(input: {
  mode: PlaygroundProviderMode;
  scenario: PlaygroundScenarioName;
}): TuvrenProvider {
  if (input.mode === "ai-sdk-mock") {
    return createAiSdkProviderBridge({
      id: "playground:ai-sdk-mock",
      model: createMockLanguageModel(input.scenario),
    });
  }

  return createFixtureProvider(input.scenario);
}

function createFixtureProvider(
  scenario: PlaygroundScenarioName
): TuvrenProvider {
  return {
    generate(prompt) {
      return Promise.resolve(createFixtureResponse(prompt, scenario));
    },
    id: `playground:fixture:${scenario}`,
    stream(prompt) {
      return streamFixtureChunks(prompt, scenario);
    },
  };
}

async function* streamFixtureChunks(
  prompt: TuvrenPrompt,
  scenario: PlaygroundScenarioName
): AsyncIterable<ProviderStreamChunk> {
  await Promise.resolve();

  if (scenario === "steering") {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  const response = createFixtureResponse(prompt, scenario);

  for (const part of response.parts) {
    switch (part.type) {
      case "text":
        yield { text: part.text, type: "text_delta" };
        break;
      case "structured":
        yield {
          delta: JSON.stringify(part.data),
          type: "structured_delta",
        };
        yield {
          data: part.data,
          name: part.name,
          type: "structured_done",
        };
        break;
      case "tool_call":
        yield {
          name: part.name,
          providerCallId: part.callId,
          type: "tool_call_start",
        };
        yield {
          delta: JSON.stringify(part.input),
          providerCallId: part.callId,
          type: "tool_call_args_delta",
        };
        yield {
          input: part.input,
          name: part.name,
          providerCallId: part.callId,
          type: "tool_call_done",
        };
        break;
      default:
        break;
    }
  }

  yield {
    finishReason: response.finishReason,
    providerMetadata: response.providerMetadata,
    type: "finish",
    usage: response.usage,
  };
}

function createFixtureResponse(
  prompt: TuvrenPrompt,
  scenario: PlaygroundScenarioName
): TuvrenModelResponse {
  if (prompt.messages.some((message) => message.role === "tool")) {
    return {
      finishReason: "stop",
      parts: [
        {
          text: `Observed ${countRole(prompt, "tool")} tool result messages.`,
          type: "text",
        },
      ],
      usage: {
        inputTokens: 12,
        outputTokens: 7,
      },
    };
  }

  if (hasUserText(prompt, "Injected steering")) {
    return {
      finishReason: "stop",
      parts: [{ text: "Steering incorporated.", type: "text" }],
      usage: {
        inputTokens: 10,
        outputTokens: 4,
      },
    };
  }

  switch (scenario) {
    case "approval":
      return {
        finishReason: "tool_call",
        parts: [
          {
            callId: "call-search",
            input: { query: "latest status" },
            name: "search",
            type: "tool_call",
          },
          {
            callId: "call-email",
            input: { subject: "Status update", to: "ops@example.com" },
            name: "email",
            type: "tool_call",
          },
        ],
      };
    case "structured":
      return {
        finishReason: "stop",
        parts: [
          {
            data: { scenario, status: "ready" },
            name: "playground_summary",
            type: "structured",
          },
        ],
        providerMetadata: {
          playground: { mode: "fixture" },
        },
      };
    case "tools":
      return {
        finishReason: "tool_call",
        parts: [
          {
            callId: "call-search",
            input: { query: "docs" },
            name: "search",
            type: "tool_call",
          },
        ],
      };
    case "metadata":
      return {
        finishReason: "stop",
        parts: [
          {
            providerMetadata: {
              fixture: { traceId: "fixture-trace-1" },
            },
            text: "Provider metadata preserved.",
            type: "text",
          },
        ],
        providerMetadata: {
          playground: {
            requestId: "fixture-request-1",
          },
        },
        usage: {
          inputTokens: 8,
          outputTokens: 5,
        },
      };
    case "cancel":
      return {
        finishReason: "stop",
        parts: [{ text: "Waiting before cancellation.", type: "text" }],
      };
    case "branching":
    case "reload":
    case "streaming":
      return {
        finishReason: "stop",
        parts: [{ text: `Playground ${scenario} complete.`, type: "text" }],
        usage: {
          inputTokens: 9,
          outputTokens: 6,
        },
      };
    default:
      return {
        finishReason: "stop",
        parts: [{ text: "Playground complete.", type: "text" }],
      };
  }
}

function createMockLanguageModel(
  scenario: PlaygroundScenarioName
): LanguageModelV3 {
  return {
    doGenerate() {
      return Promise.resolve(createGenerateResult(scenario));
    },
    doStream(options: LanguageModelV3CallOptions) {
      const result = createGenerateResult(scenario, options);
      return Promise.resolve({
        stream: streamAiSdkParts(result),
      });
    },
    modelId: "playground-mock-model",
    provider: "playground-mock-provider",
    specificationVersion: "v3",
    supportedUrls: {},
  };
}

function createGenerateResult(
  scenario: PlaygroundScenarioName,
  _options?: LanguageModelV3CallOptions
): LanguageModelV3GenerateResult {
  const text =
    scenario === "metadata"
      ? "AI SDK mock metadata preserved."
      : `AI SDK mock ${scenario} complete.`;

  return {
    content: [
      {
        providerMetadata: {
          playground: {
            scenario,
          },
        },
        text,
        type: "text",
      },
    ],
    finishReason: {
      raw: "stop",
      unified: "stop",
    },
    response: {
      headers: {
        "x-playground": "ai-sdk-mock",
      },
      id: "playground-response",
      modelId: "playground-mock-model",
      timestamp: new Date(0),
    },
    usage: {
      inputTokens: {
        cacheRead: 0,
        cacheWrite: 0,
        noCache: 11,
        total: 11,
      },
      outputTokens: {
        reasoning: 0,
        text: 5,
        total: 5,
      },
      raw: {
        playground: {
          scenario,
        },
      },
    },
    warnings: [],
  };
}

function streamAiSdkParts(
  result: LanguageModelV3GenerateResult
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({
        type: "stream-start",
        warnings: result.warnings,
      });

      for (const part of result.content) {
        if (part.type === "text") {
          controller.enqueue({
            id: "text-1",
            type: "text-start",
          });
          controller.enqueue({
            delta: part.text,
            id: "text-1",
            providerMetadata: part.providerMetadata,
            type: "text-delta",
          });
          controller.enqueue({
            id: "text-1",
            type: "text-end",
          });
        }
      }

      controller.enqueue({
        id: result.response?.id,
        modelId: result.response?.modelId,
        timestamp: result.response?.timestamp,
        type: "response-metadata",
      });
      controller.enqueue({
        finishReason: result.finishReason,
        providerMetadata: {
          playground: {
            response: "streamed",
          },
        },
        type: "finish",
        usage: result.usage,
      });
      controller.close();
    },
  });
}

function countRole(prompt: TuvrenPrompt, role: "tool"): number {
  return prompt.messages.filter((message) => message.role === role).length;
}

function hasUserText(prompt: TuvrenPrompt, text: string): boolean {
  return prompt.messages.some(
    (message) =>
      message.role === "user" &&
      message.parts.some((part) => part.type === "text" && part.text === text)
  );
}
