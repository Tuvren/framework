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

// Contract-surface coverage for the payload-codec vocabulary that stays in
// @tuvren/core. The identity and AES-256-GCM codec implementations (and their
// behavioral tests) live in @tuvren/sdk.

import { describe, expect, test } from "bun:test";
import {
  type ErasedPayload,
  isErasedPayload,
} from "../src/lib/payload-codec.js";

describe("isErasedPayload", () => {
  test("narrows a typed erased marker", () => {
    const erased: ErasedPayload = {
      keyRef: "tenant.acme",
      kind: "erased",
      reason: "key_unavailable",
    };
    expect(isErasedPayload(erased)).toBe(true);
    expect(isErasedPayload({ role: "user", parts: [] })).toBe(false);
    expect(isErasedPayload(null)).toBe(false);
    expect(isErasedPayload({ kind: "erased" })).toBe(false);
  });
});
