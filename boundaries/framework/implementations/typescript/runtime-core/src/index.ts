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

// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public implementation surface.
export {
  createContextManifest,
  createEmptyContextManifest,
  updateContextManifest,
} from "./lib/context-manifest.js";
export { createDriverRegistry } from "./lib/driver-registry.js";
export type { ExtensionStateUpdate } from "./lib/extension-runtime.js";
export {
  buildSharedExports,
  collectSystemPrompts,
  runAfterIterationHooks,
  runAfterTurnHooks,
  runBeforeIterationHooks,
  runBeforeTurnHooks,
} from "./lib/extension-runtime.js";
export type {
  TuvrenRuntimeTelemetryAttributeDefinition,
  TuvrenRuntimeTelemetryAttributeKey,
} from "./lib/generated/tuvren-runtime-telemetry.js";
export {
  TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS,
  TUVREN_RUNTIME_TELEMETRY_ATTRIBUTES,
  TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL,
} from "./lib/generated/tuvren-runtime-telemetry.js";
export {
  createLastOutputOnlyHandoffContextBuilder,
  createPreserveTraceHandoffContextBuilder,
} from "./lib/handoff-builders.js";
export type { OrchestrationRuntimeOptions } from "./lib/orchestration-runtime.js";
export { createOrchestrationRuntime } from "./lib/orchestration-runtime.js";
export type {
  RuntimeCoreOptions,
  RuntimeRunLivenessOptions,
  RuntimeWarning,
} from "./lib/runtime-core.js";
export {
  createTuvrenRuntimeCore,
  DEFAULT_AGENT_SCHEMA,
  DEFAULT_AGENT_SCHEMA_ID,
  DEFAULT_MANIFEST_EXTENSION_STATE_WARNING_BUDGET_BYTES,
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
} from "./lib/runtime-core.js";
export type { ExecutionSessionRequest } from "./lib/runtime-execution-types.js";
export type { GrpcRuntimeKernelOptions } from "./lib/runtime-kernel-grpc.js";
export { createGrpcRuntimeKernel } from "./lib/runtime-kernel-grpc.js";
export { createToolRegistry } from "./lib/tool-registry.js";
