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
// @tuvren/runtime is the internal engine (ADR-057): its package root exposes the
// engine factories, NOT the curated host-facing surface. The host-facing
// re-exports (createTuvren, TuvrenError, NoopTelemetrySink, telemetry-semconv,
// createRuntimeKernel, …) now live on @tuvren/sdk / @tuvren/core / the leaf
// packages; the smoke assertion for those belongs to the sdk surface, not here.
import {
  createBindingResolver,
  createCapabilityPolicyEngine,
  createCapabilityRegistry,
  createGrpcRuntimeKernel,
  createOrchestrationRuntime,
  createRunnerRegistry,
  createToolRegistry,
  createTuvrenRuntime,
  DEFAULT_AGENT_SCHEMA_ID,
} from "@tuvren/runtime";

describe("runtime package exports", () => {
  test("expose the internal engine factories", () => {
    expect(typeof createTuvrenRuntime).toBe("function");
    expect(typeof createOrchestrationRuntime).toBe("function");
    expect(typeof createRunnerRegistry).toBe("function");
    expect(typeof createGrpcRuntimeKernel).toBe("function");
    expect(typeof createBindingResolver).toBe("function");
    expect(typeof createCapabilityRegistry).toBe("function");
    expect(typeof createCapabilityPolicyEngine).toBe("function");
    expect(typeof createToolRegistry).toBe("function");
    expect(DEFAULT_AGENT_SCHEMA_ID.length > 0).toBe(true);
  });

  test("do not re-export the host-facing curated surface (ADR-057)", async () => {
    const runtime = (await import("@tuvren/runtime")) as Record<
      string,
      unknown
    >;
    // These moved to @tuvren/sdk / @tuvren/core / leaf packages; the internal
    // engine must not carry them any longer, so hosts cannot reach the curated
    // surface through the engine package.
    expect(runtime.createTuvren).toBeUndefined();
    expect(runtime.TuvrenError).toBeUndefined();
    expect(runtime.NoopTelemetrySink).toBeUndefined();
    expect(runtime.createMemoryBackend).toBeUndefined();
    expect(runtime.createRuntimeKernel).toBeUndefined();
  });
});
