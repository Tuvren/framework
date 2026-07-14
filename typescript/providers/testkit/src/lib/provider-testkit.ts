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

/** Inputs for {@link verifyProviderGenerate}: the provider/prompt to call, plus an optional response assertion. */
export interface ProviderGenerateVerification {
  /** Optional additional assertion run against the validated response. */
  check?: (response: TuvrenModelResponse) => Promise<void> | void;
  /** Label used in assertion failure messages; defaults to `provider.id`. */
  label?: string;
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
}

/** Inputs for {@link verifyProviderStream}: the provider/prompt to call, plus an optional chunk-list assertion. */
export interface ProviderStreamVerification {
  /** Optional additional assertion run against the collected, validated chunk list. */
  check?: (chunks: readonly ProviderStreamChunk[]) => Promise<void> | void;
  /** Label used in assertion failure messages; defaults to `provider.id`. */
  label?: string;
  prompt: TuvrenPrompt;
  provider: TuvrenProvider;
}

/** Inputs for {@link verifyProviderRejects}: the operation to run and how its rejection should be checked. */
export interface ProviderRejectionVerification {
  /** When set, the rejection's `message` must include this substring or match this pattern. */
  expectedMessage?: RegExp | string;
  /** Label used in assertion failure messages. */
  label?: string;
  /** The operation expected to reject. */
  run: () => Promise<unknown> | unknown;
}

/** Canned behavior for {@link createStaticTuvrenProvider}'s `generate`/`stream` methods. */
export interface StaticProviderOptions {
  /** When set, `generate()` rejects with this error instead of resolving. */
  generateError?: Error;
  /** Provider id; defaults to `"static-provider"`. */
  id?: string;
  /** Response `generate()` resolves with; defaults to {@link providerTestkitFixtures}`.response`. */
  response?: TuvrenModelResponse;
  /** Chunks `stream()` yields; defaults to a minimal text-then-finish sequence. */
  streamChunks?: readonly ProviderStreamChunk[];
  /** When set, the stream's first `next()` call rejects with this error instead of yielding. */
  streamError?: Error;
}

/**
 * Shared fixture prompts/response used across provider conformance tests
 * (mirrors {@link providerTestkitFixtures} from the schema-validated loader in
 * `provider-conformance-fixtures.ts`).
 */
export interface ProviderTestkitFixtureSet {
  prompt: TuvrenPrompt;
  response: TuvrenModelResponse;
  structuredPrompt: TuvrenPrompt;
  toolPrompt: TuvrenPrompt;
}

/**
 * The schema-validated fixture set (prompts, response) shared by provider
 * conformance tests, loaded once at module init via
 * `provider-conformance-fixtures.ts`.
 */
export const providerTestkitFixtures: ProviderTestkitFixtureSet =
  loadedProviderTestkitFixtures;

/**
 * Calls `provider.generate(prompt)`, asserts the result is a well-formed
 * `TuvrenModelResponse`, then runs the optional `check` callback.
 *
 * @throws Error (from the assertion helper) when the response is malformed.
 */
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

/**
 * Calls `provider.stream(prompt)`, collects and validates every chunk via
 * {@link collectProviderStream}, then runs the optional `check` callback.
 */
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

/**
 * Runs `verification.run()` and asserts it rejects, optionally checking the
 * rejection message against `expectedMessage`.
 *
 * @throws Error when `run()` resolves instead of rejecting, or when the
 *   rejection message does not match `expectedMessage`.
 */
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

/**
 * Drains an async chunk stream into an array, asserting each chunk is a
 * well-formed `ProviderStreamChunk` (§3.2) as it arrives and defensively
 * cloning it.
 *
 * @throws Error (from the assertion helper) when a chunk is malformed.
 */
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

/**
 * Asserts a chunk list's `type` sequence exactly matches `expectedTypes`, in
 * order and length.
 *
 * @throws Error when the sequences differ.
 */
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

/**
 * Finds the stream's `finish` chunk and asserts its `finishReason` matches
 * `expected`.
 *
 * @throws Error when no `finish` chunk was emitted, or its reason differs.
 */
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

/**
 * Finds the stream's `structured_done` chunk and asserts its `name` matches
 * `expectedName`.
 *
 * @throws Error when no `structured_done` chunk was emitted, or its name differs.
 */
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

/**
 * Builds a minimal in-memory `TuvrenProvider` for tests: `generate()`
 * resolves a cloned canned response (or rejects `generateError`), and
 * `stream()` replays a cloned canned chunk sequence (or rejects
 * `streamError` on its first pull).
 */
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

/** Builds a one-shot async iterable that replays cloned `streamChunks`, or rejects `streamError` immediately if set. */
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

/**
 * Asserts a message includes a substring (string `expectedMessage`) or
 * matches a pattern (`RegExp`).
 *
 * @throws Error when the message does not satisfy `expectedMessage`.
 */
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

/** True when two string arrays have the same length and elements in the same order. */
function arraysAreEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

/** Structurally clones and re-validates a `TuvrenModelResponse` so callers cannot mutate the shared fixture/canned value. */
function cloneModelResponse(
  response: TuvrenModelResponse
): TuvrenModelResponse {
  const cloned = structuredClone(response);
  assertTuvrenModelResponse(cloned, "cloned provider response");
  return cloned;
}

/** Structurally clones and re-validates a `ProviderStreamChunk` so callers cannot mutate the shared canned value. */
function cloneProviderStreamChunk(
  chunk: ProviderStreamChunk
): ProviderStreamChunk {
  const cloned = structuredClone(chunk);
  assertProviderStreamChunk(cloned, "cloned provider stream chunk");
  return cloned;
}
