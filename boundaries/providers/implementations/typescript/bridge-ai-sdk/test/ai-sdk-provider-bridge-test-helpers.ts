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
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

export function createMockModel(
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

export function createGenerateResult(
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

export function createUsage(inputTokens: number, outputTokens: number) {
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

export function streamFromParts(
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

export async function collectAsyncIterable<T>(
  iterable: AsyncIterable<T>
): Promise<T[]> {
  const values: T[] = [];

  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}
