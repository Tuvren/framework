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
import {
  assertProviderChunkTypes,
  assertProviderFinishChunk,
  createStaticTuvrenProvider,
  providerTestkitFixtures,
  verifyProviderGenerate,
  verifyProviderRejects,
  verifyProviderStream,
} from "../src/index.ts";

const CANCELLED_MESSAGE = /cancelled/;

describe("@tuvren/provider-testkit", () => {
  test("verifies provider generate and stream behavior through provider-api contracts", async () => {
    const provider = createStaticTuvrenProvider();

    const response = await verifyProviderGenerate({
      prompt: providerTestkitFixtures.prompt,
      provider,
    });
    const chunks = await verifyProviderStream({
      prompt: providerTestkitFixtures.prompt,
      provider,
    });

    expect(response.parts).toEqual([{ text: "ready", type: "text" }]);
    assertProviderChunkTypes(chunks, ["text_delta", "finish"]);
    expect(assertProviderFinishChunk(chunks, "stop").usage).toEqual({
      inputTokens: 4,
      outputTokens: 1,
    });
  });

  test("asserts expected provider rejection messages", async () => {
    const failure = new Error("provider cancelled request");
    const provider = createStaticTuvrenProvider({
      generateError: failure,
    });

    const error = await verifyProviderRejects({
      expectedMessage: CANCELLED_MESSAGE,
      run: async () => {
        await provider.generate(providerTestkitFixtures.prompt);
      },
    });

    expect(error).toBe(failure);
  });
});
