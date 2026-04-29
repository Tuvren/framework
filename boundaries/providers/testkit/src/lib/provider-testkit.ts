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
  ProviderStreamChunk,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/provider-api";
import {
  assertProviderStreamChunk,
  assertTuvrenModelResponse,
} from "@tuvren/provider-api";
import { providerTestkitFixtures as loadedProviderTestkitFixtures } from "./provider-conformance-fixtures.js";

export interface ProviderGenerateVerification {
  check?: (response: TuvrenModelResponse) => Promise<void> | void;
  label?: string;
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
}

export interface ProviderStreamVerification {
  check?: (chunks: readonly ProviderStreamChunk[]) => Promise<void> | void;
  label?: string;
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
}

export interface ProviderRejectionVerification {
  expectedMessage?: RegExp | string;
  label?: string;
  run: () => Promise<unknown> | unknown;
}

export interface StaticProviderOptions {
  generateError?: Error;
  id?: string;
  response?: TuvrenModelResponse;
  streamChunks?: readonly ProviderStreamChunk[];
  streamError?: Error;
}

export interface ProviderTestkitFixtureSet {
  prompt: TuvrenPrompt;
  response: TuvrenModelResponse;
  structuredPrompt: TuvrenPrompt;
  toolPrompt: TuvrenPrompt;
}

export const providerTestkitFixtures: ProviderTestkitFixtureSet =
  loadedProviderTestkitFixtures;

export async function verifyProviderGenerate(
  verification: ProviderGenerateVerification
): Promise<TuvrenModelResponse> {
  const response = await verification.provider.generate(verification.prompt);
  assertTuvrenModelResponse(
    response,
    `${verification.label ?? verification.provider.id} generate response`
  );
  await verification.check?.(response);
  return response;
}

export async function verifyProviderStream(
  verification: ProviderStreamVerification
): Promise<ProviderStreamChunk[]> {
  const chunks = await collectProviderStream(
    verification.provider.stream(verification.prompt),
    verification.label ?? verification.provider.id
  );
  await verification.check?.(chunks);
  return chunks;
}

export async function verifyProviderRejects(
  verification: ProviderRejectionVerification
): Promise<Error> {
  try {
    await verification.run();
  } catch (error: unknown) {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));

    if (verification.expectedMessage !== undefined) {
      assertMessageMatches(
        normalizedError.message,
        verification.expectedMessage,
        verification.label ?? "provider rejection"
      );
    }

    return normalizedError;
  }

  throw new Error(`${verification.label ?? "provider operation"} did not fail`);
}

export async function collectProviderStream(
  stream: AsyncIterable<ProviderStreamChunk>,
  label = "provider stream"
): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = [];
  let index = 0;

  for await (const chunk of stream) {
    assertProviderStreamChunk(chunk, `${label} chunk ${index}`);
    chunks.push(cloneProviderStreamChunk(chunk));
    index += 1;
  }

  return chunks;
}

export function assertProviderChunkTypes(
  chunks: readonly ProviderStreamChunk[],
  expectedTypes: readonly ProviderStreamChunk["type"][],
  label = "provider stream"
): void {
  const actualTypes = chunks.map((chunk) => chunk.type);

  if (!arraysAreEqual(actualTypes, expectedTypes)) {
    throw new Error(
      `${label} emitted chunk types ${JSON.stringify(
        actualTypes
      )}; expected ${JSON.stringify(expectedTypes)}`
    );
  }
}

export function assertProviderFinishChunk(
  chunks: readonly ProviderStreamChunk[],
  expected: Extract<ProviderStreamChunk, { type: "finish" }>["finishReason"],
  label = "provider stream"
): Extract<ProviderStreamChunk, { type: "finish" }> {
  const finishChunk = chunks.find(
    (chunk): chunk is Extract<ProviderStreamChunk, { type: "finish" }> =>
      chunk.type === "finish"
  );

  if (finishChunk === undefined) {
    throw new Error(`${label} did not emit a finish chunk`);
  }

  if (finishChunk.finishReason !== expected) {
    throw new Error(
      `${label} finished with ${finishChunk.finishReason}; expected ${expected}`
    );
  }

  return finishChunk;
}

export function assertProviderStructuredDoneChunk(
  chunks: readonly ProviderStreamChunk[],
  expectedName: string,
  label = "provider stream"
): Extract<ProviderStreamChunk, { type: "structured_done" }> {
  const structuredDoneChunk = chunks.find(
    (
      chunk
    ): chunk is Extract<ProviderStreamChunk, { type: "structured_done" }> =>
      chunk.type === "structured_done"
  );

  if (structuredDoneChunk === undefined) {
    throw new Error(`${label} did not emit a structured_done chunk`);
  }

  if (structuredDoneChunk.name !== expectedName) {
    throw new Error(
      `${label} structured_done name was ${String(
        structuredDoneChunk.name
      )}; expected ${expectedName}`
    );
  }

  return structuredDoneChunk;
}

export function createStaticTuvrenProvider(
  options: StaticProviderOptions = {}
): TuvrenProvider {
  const response = options.response ?? providerTestkitFixtures.response;
  const streamChunks = options.streamChunks ?? [
    { text: "ready", type: "text_delta" },
    {
      finishReason: "stop",
      usage: {
        inputTokens: 4,
        outputTokens: 1,
      },
      type: "finish",
    },
  ];

  return {
    generate() {
      if (options.generateError !== undefined) {
        return Promise.reject(options.generateError);
      }

      return Promise.resolve(cloneModelResponse(response));
    },
    id: options.id ?? "static-provider",
    stream() {
      return createStaticProviderStream(streamChunks, options.streamError);
    },
  };
}

function createStaticProviderStream(
  streamChunks: readonly ProviderStreamChunk[],
  streamError: Error | undefined
): AsyncIterable<ProviderStreamChunk> {
  return {
    [Symbol.asyncIterator]() {
      let nextIndex = 0;

      return {
        next() {
          if (streamError !== undefined) {
            return Promise.reject(streamError);
          }

          if (nextIndex >= streamChunks.length) {
            return Promise.resolve({ done: true, value: undefined });
          }

          const value = cloneProviderStreamChunk(streamChunks[nextIndex]);
          nextIndex += 1;

          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

function assertMessageMatches(
  actualMessage: string,
  expectedMessage: RegExp | string,
  label: string
): void {
  if (typeof expectedMessage === "string") {
    if (!actualMessage.includes(expectedMessage)) {
      throw new Error(
        `${label} error message ${JSON.stringify(
          actualMessage
        )} did not include ${JSON.stringify(expectedMessage)}`
      );
    }

    return;
  }

  if (!expectedMessage.test(actualMessage)) {
    throw new Error(
      `${label} error message ${JSON.stringify(
        actualMessage
      )} did not match ${String(expectedMessage)}`
    );
  }
}

function arraysAreEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function cloneModelResponse(
  response: TuvrenModelResponse
): TuvrenModelResponse {
  const cloned = structuredClone(response);
  assertTuvrenModelResponse(cloned, "cloned provider response");
  return cloned;
}

function cloneProviderStreamChunk(
  chunk: ProviderStreamChunk
): ProviderStreamChunk {
  const cloned = structuredClone(chunk);
  assertProviderStreamChunk(cloned, "cloned provider stream chunk");
  return cloned;
}
