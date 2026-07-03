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
import type { LanguageModelV3, ProviderV3 } from "@ai-sdk/provider";
import {
  createAiSdkProviderBridge,
  createAiSdkProviderBridgeFromProvider,
} from "@tuvren/provider-bridge-ai-sdk";

describe("provider-bridge-ai-sdk package exports", () => {
  test("exports both bridge factories", () => {
    const model: LanguageModelV3 = {
      async doGenerate() {
        await Promise.resolve();
        throw new Error("not used");
      },
      async doStream() {
        await Promise.resolve();
        throw new Error("not used");
      },
      modelId: "mock-model",
      provider: "mock-provider",
      specificationVersion: "v3",
      supportedUrls: {},
    };
    const provider: ProviderV3 = {
      embeddingModel() {
        throw new Error("not used");
      },
      imageModel() {
        throw new Error("not used");
      },
      languageModel() {
        return model;
      },
      specificationVersion: "v3",
    };

    expect(
      typeof createAiSdkProviderBridge({
        model,
      }).generate
    ).toBe("function");
    expect(
      typeof createAiSdkProviderBridgeFromProvider({
        modelId: "mock-model",
        provider,
      }).stream
    ).toBe("function");
  });
});
