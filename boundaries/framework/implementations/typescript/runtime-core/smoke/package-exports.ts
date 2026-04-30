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
  createGrpcRuntimeKernel,
  TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS,
  TUVREN_RUNTIME_TELEMETRY_ATTRIBUTES,
  TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL,
} from "@tuvren/runtime-core";

describe("@tuvren/runtime-core package exports", () => {
  test("exposes the generated telemetry helper from the built package surface", () => {
    expect(TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL).toBe(
      "https://tuvren.dev/schemas/telemetry/0.1.0"
    );
    expect(TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS).toContain(
      "tuvren.runtime.run.id"
    );
    expect(
      TUVREN_RUNTIME_TELEMETRY_ATTRIBUTES["tuvren.runtime.run.id"]
    ).toEqual({
      brief: "The Tuvren runtime run identifier.",
      examples: ["run_main"],
      stability: "development",
      type: "string",
    });
  });

  test("exposes the gRPC runtime kernel helper from the built package surface", () => {
    expect(typeof createGrpcRuntimeKernel).toBe("function");
  });
});
