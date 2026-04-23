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
  assertProviderStreamChunk,
  isProviderStreamChunk,
  type ProviderStreamChunk,
  type TuvrenProvider,
} from "../src/index.ts";

describe("provider-api", () => {
  test("re-exports the provider-neutral seam under its canonical public name", () => {
    const chunk = {
      delta: '{"status":"pending"}',
      type: "structured_delta",
    } satisfies ProviderStreamChunk;
    const provider = {
      generate: () =>
        Promise.resolve({
          finishReason: "stop",
          parts: [],
        }),
      id: "provider-1",
      async *stream() {
        await Promise.resolve();
        yield chunk;
      },
    } satisfies TuvrenProvider;

    expect(provider.id).toBe("provider-1");
    expect(isProviderStreamChunk(chunk)).toBe(true);
    expect(() => assertProviderStreamChunk(chunk)).not.toThrow();
  });
});
