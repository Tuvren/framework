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

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { createAiSdkProviderBridge } from "@tuvren/provider-bridge-ai-sdk";
import {
  type ProviderStreamChunk,
  type TuvrenModelResponse,
  type TuvrenPrompt,
  type TuvrenProvider,
  TuvrenRuntimeError,
} from "@tuvren/runtime";
import {
  DEFAULT_GEMINI_REPL_MODEL_ID,
  INVALID_REPL_CONFIG_CODE,
  isAimockProviderMode,
  resolveGoogleApiKey,
} from "./repl-config.js";
import type { ReplProviderMode, ReplScenarioName } from "./repl-types.js";

export function createReplProvider(input: {
  aimockBaseUrl?: string;
  googleApiKey?: string;
  modelId?: string;
  mode: ReplProviderMode;
  scenario: ReplScenarioName;
}): TuvrenProvider {
  if (isAimockProviderMode(input.mode)) {
    return createAimockProvider(input.mode, input.aimockBaseUrl, input.modelId);
  }

  if (input.mode === "ai-sdk-mock") {
    return createAiSdkProviderBridge({
      id: "repl:ai-sdk-mock",
      model: createMockLanguageModel(input.scenario),
    });
  }

  if (input.mode === "ai-sdk-google") {
    const apiKey = input.googleApiKey ?? resolveGoogleApiKey(process.env);

    if (apiKey === undefined) {
      throw new TuvrenRuntimeError(
        "ai-sdk-google repl provider requires GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY",
        {
          code: INVALID_REPL_CONFIG_CODE,
        }
      );
    }

    const google = createGoogleGenerativeAI({
      apiKey,
    });

    return createAiSdkProviderBridge({
      id: "repl:ai-sdk-google",
      model: google(input.modelId ?? DEFAULT_GEMINI_REPL_MODEL_ID),
    });
  }

  return createFixtureProvider(input.scenario);
}

function createAimockProvider(
  mode: Extract<ReplProviderMode, `aimock-${string}`>,
  baseUrl: string | undefined,
  modelId: string | undefined
): TuvrenProvider {
  const aimockBaseUrl = baseUrl?.trim();

  if (aimockBaseUrl === undefined || aimockBaseUrl.length === 0) {
    throw new TuvrenRuntimeError(
      `${mode} repl provider requires --aimock-base-url, TUVREN_REPL_AIMOCK_BASE_URL, or TUVREN_PLAYGROUND_AIMOCK_BASE_URL`,
      {
        code: INVALID_REPL_CONFIG_CODE,
      }
    );
  }

  switch (mode) {
    case "aimock-openai": {
      const openai = createOpenAI({
        apiKey: "mock",
        baseURL: aimockBaseUrl,
      });

      return createAiSdkProviderBridge({
        id: "repl:aimock-openai",
        model: openai.chat(modelId ?? "gpt-4o-mini"),
      });
    }
    case "aimock-anthropic": {
      const anthropic = createAnthropic({
        apiKey: "mock",
        baseURL: aimockBaseUrl,
      });

      return createAiSdkProviderBridge({
        id: "repl:aimock-anthropic",
        model: anthropic(modelId ?? "claude-3-5-haiku-latest"),
      });
    }
    case "aimock-google": {
      const google = createGoogleGenerativeAI({
        apiKey: "mock",
        baseURL: aimockBaseUrl,
      });

      return createAiSdkProviderBridge({
        id: "repl:aimock-google",
        model: google(modelId ?? DEFAULT_GEMINI_REPL_MODEL_ID),
      });
    }
    default:
      throw new TuvrenRuntimeError(
        `unsupported aimock repl provider "${mode}"`,
        {
          code: INVALID_REPL_CONFIG_CODE,
        }
      );
  }
}

function createFixtureProvider(scenario: ReplScenarioName): TuvrenProvider {
  return {
    generate(prompt) {
      return Promise.resolve(createFixtureResponse(prompt, scenario));
    },
    id: `repl:fixture:${scenario}`,
    stream(prompt) {
      return streamFixtureChunks(prompt, scenario);
    },
  };
}

async function* streamFixtureChunks(
  prompt: TuvrenPrompt,
  scenario: ReplScenarioName
): AsyncIterable<ProviderStreamChunk> {
  await Promise.resolve();

  if (scenario === "orchestration" || scenario === "steering") {
    // Keep a deterministic steering window wide enough for the full Nx verify
    // lane. A shorter delay was fast in isolation but too tight once the
    // broader workspace load and stream fanout were active.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
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
  scenario: ReplScenarioName
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
            name: "repl_summary",
            type: "structured",
          },
        ],
        providerMetadata: {
          repl: { mode: "fixture" },
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
          repl: {
            requestId: "fixture-request-1",
          },
        },
        usage: {
          inputTokens: 8,
          outputTokens: 5,
        },
      };
    case "extension":
      return {
        finishReason: "stop",
        parts: [{ text: "Extension flow complete.", type: "text" }],
        usage: {
          inputTokens: 9,
          outputTokens: 4,
        },
      };
    case "orchestration":
      return {
        finishReason: "stop",
        parts: [{ text: "Orchestration flow complete.", type: "text" }],
        usage: {
          inputTokens: 9,
          outputTokens: 4,
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
        parts: [{ text: `REPL ${scenario} complete.`, type: "text" }],
        usage: {
          inputTokens: 9,
          outputTokens: 6,
        },
      };
    default:
      return {
        finishReason: "stop",
        parts: [{ text: "REPL complete.", type: "text" }],
      };
  }
}

function createMockLanguageModel(scenario: ReplScenarioName): LanguageModelV3 {
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
    modelId: "repl-mock-model",
    provider: "repl-mock-provider",
    specificationVersion: "v3",
    supportedUrls: {},
  };
}

function createGenerateResult(
  scenario: ReplScenarioName,
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
          repl: {
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
        "x-repl": "ai-sdk-mock",
      },
      id: "repl-response",
      modelId: "repl-mock-model",
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
        repl: {
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
          repl: {
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
