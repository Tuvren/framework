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

import { parseResolvedTelemetryRegistry } from "./telemetry-codegen.js";

describe("resolved telemetry registry parsing", () => {
  test("normalizes validated Weaver attribute fields", () => {
    const registry = parseResolvedTelemetryRegistry(
      JSON.stringify({
        groups: [
          {
            attributes: [
              {
                brief: "Stable operation name",
                examples: ["run", "resume"],
                name: "tuvren.operation.name",
                stability: "stable",
                type: "string",
              },
            ],
          },
        ],
        registry_url: "https://tuvren.dev/telemetry/registry",
      }),
      "https://tuvren.dev/telemetry/schema"
    );

    expect(registry.attributes).toEqual([
      {
        brief: "Stable operation name",
        examples: ["run", "resume"],
        key: "tuvren.operation.name",
        stability: "stable",
        type: "string",
      },
    ]);
  });

  test("rejects non-string examples at the parsed JSON boundary", () => {
    expect(() =>
      parseResolvedTelemetryRegistry(
        JSON.stringify({
          groups: [
            {
              attributes: [
                {
                  brief: "Stable operation name",
                  examples: ["run", 42],
                  name: "tuvren.operation.name",
                  stability: "stable",
                  type: "string",
                },
              ],
            },
          ],
          registry_url: "https://tuvren.dev/telemetry/registry",
        }),
        "https://tuvren.dev/telemetry/schema"
      )
    ).toThrow("resolved telemetry attribute is incomplete");
  });
});
