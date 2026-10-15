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

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import type * as ProviderApi from "../src/index.ts";

const firstModules = ["../src/index.ts", "@tuvren/core/provider"] as const;
const firstModule = process.env.TUVREN_PROVIDER_API_FIRST_MODULE;

if (firstModule === undefined) {
  for (const modulePath of firstModules) {
    test(`preserves provider validation when ${modulePath} initializes first`, () => {
      const result = spawnSync(process.execPath, ["test", import.meta.path], {
        cwd: import.meta.dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          TUVREN_PROVIDER_API_FIRST_MODULE: modulePath,
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stderr).toContain("1 pass");
      expect(result.stderr).toContain("0 fail");
    });
  }
} else {
  test("retains canonical exports and error outcomes after fresh initialization", async () => {
    await import(firstModule);
    const providerApi: typeof ProviderApi = await import("../src/index.ts");
    const coreProvider: typeof ProviderApi =
      await import("@tuvren/core/provider");

    expect(Object.keys(providerApi).toSorted()).toEqual([
      "assertProviderStreamChunk",
      "assertTuvrenModelResponse",
      "isProviderStreamChunk",
      "isTuvrenModelResponse",
    ]);
    expect(providerApi.assertProviderStreamChunk).toBe(
      coreProvider.assertProviderStreamChunk
    );
    expect(providerApi.assertTuvrenModelResponse).toBe(
      coreProvider.assertTuvrenModelResponse
    );
    expect(providerApi.isProviderStreamChunk).toBe(
      coreProvider.isProviderStreamChunk
    );
    expect(providerApi.isTuvrenModelResponse).toBe(
      coreProvider.isTuvrenModelResponse
    );

    const chunk = { finishReason: "stop", type: "finish" } as const;
    expect(providerApi.isProviderStreamChunk(chunk)).toBe(true);
    providerApi.assertProviderStreamChunk(chunk);

    const invalidChunk = {
      finishReason: "unknown",
      type: "finish",
      usage: { inputTokens: -1, outputTokens: -1 },
    };
    expect(providerApi.isProviderStreamChunk(invalidChunk)).toBe(false);

    let validationError: unknown;
    try {
      providerApi.assertProviderStreamChunk(invalidChunk, "chunk");
    } catch (error: unknown) {
      validationError = error;
    }

    expect(validationError).toMatchObject({
      code: "invalid_provider_stream_chunk",
      details: invalidChunk,
      message: "chunk must be a valid ProviderStreamChunk",
      name: "TuvrenValidationError",
    });
  });
}
