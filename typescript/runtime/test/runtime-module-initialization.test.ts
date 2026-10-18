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

import type * as Runtime from "../src/index.ts";

const firstModules = [
  "../src/index.ts",
  "../src/lib/binding-resolver.ts",
  "../src/lib/capability-attribution.ts",
  "../src/lib/capability-policy-engine.ts",
  "../src/lib/capability-registry.ts",
  "../src/lib/client-endpoint-boundary.ts",
  "../src/lib/context-manifest.ts",
  "../src/lib/durable-reads.ts",
  "../src/lib/execution-timeouts.ts",
  "../src/lib/extension-runtime.ts",
  "../src/lib/handoff-builders.ts",
  "../src/lib/idempotency-identity.ts",
  "../src/lib/orchestration-runtime-lazy-stream.ts",
  "../src/lib/payload-codec-seam.ts",
  "../src/lib/runtime-core-execution-controller.ts",
  "../src/lib/runtime-core-hosts-persistence.ts",
  "../src/lib/runtime-core-options.ts",
  "../src/lib/runtime-core-runner-result.ts",
  "../src/lib/runner-registry.ts",
  "../src/lib/server-rate-limiter.ts",
  "../src/lib/telemetry-secret-screening.ts",
  "../src/lib/tool-execution-errors.ts",
  "../src/lib/tool-execution-batch.ts",
  "../src/lib/tool-execution-resolution.ts",
  "../src/lib/tool-execution-single.ts",
  "../src/lib/tool-execution-staging.ts",
  "../src/lib/tool-execution-validation.ts",
  "../src/lib/tool-registry.ts",
] as const;

const firstModule = process.env.TUVREN_RUNTIME_FIRST_MODULE;

if (firstModule === undefined) {
  for (const modulePath of firstModules) {
    test(`preserves runtime behavior when ${modulePath} initializes first`, () => {
      const result = spawnSync(process.execPath, ["test", import.meta.path], {
        cwd: import.meta.dir,
        encoding: "utf-8",
        env: { ...process.env, TUVREN_RUNTIME_FIRST_MODULE: modulePath },
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
  test("retains canonical runtime results after fresh module initialization", async () => {
    const initializedModule: unknown = await import(firstModule);
    const runtime: typeof Runtime = await import("../src/index.ts");

    if (typeof initializedModule !== "object" || initializedModule === null) {
      throw new TypeError(
        "expected the initialized runtime module to be an object"
      );
    }

    expect(Object.keys(initializedModule).length).toBeGreaterThan(0);
    expect(Object.values(initializedModule)).not.toContain(undefined);
    expect(runtime.createEmptyContextManifest()).toMatchObject({
      messageCount: 0,
      tokenEstimate: 0,
      turnBoundaries: [],
    });
    expect(runtime.createCapabilityRegistry().getCapabilities()).toEqual([]);
    expect(runtime.createRunnerRegistry().list()).toEqual([]);
    expect(runtime.createToolRegistry().list()).toEqual([]);
  });
}
