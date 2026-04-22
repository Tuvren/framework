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
  assertKrakenModelResponse,
  assertProviderStreamChunk,
  isKrakenModelResponse,
  type KrakenModelResponse,
  type ProviderStreamChunk,
} from "@kraken/provider-api";

describe("provider-api package exports", () => {
  test("resolve from the built package surface", () => {
    const chunk = {
      finishReason: "stop",
      type: "finish",
    } satisfies ProviderStreamChunk;

    expect(() => assertProviderStreamChunk(chunk)).not.toThrow();
  });

  test("export model-response validators from the facade surface", () => {
    const response = {
      finishReason: "stop",
      parts: [{ text: "ok", type: "text" }],
    } satisfies KrakenModelResponse;

    expect(isKrakenModelResponse(response)).toBe(true);
    expect(() => assertKrakenModelResponse(response)).not.toThrow();
  });
});
