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

/* oxlint-disable jsdoc/check-tag-names -- Preserve the standard TypeScript @packageDocumentation tag on this public entrypoint. */

/**
 * `@tuvren/core/execution` — execution handles, the runtime interface,
 * orchestration types, context/loop policy contracts, and durable-read
 * cursor types, plus the execution-status/manifest/message guards.
 * Extension lifecycle types are also exported here for backward
 * compatibility with `@tuvren/runtime-api/execution` consumers.
 *
 * @packageDocumentation
 */

/* oxlint-enable jsdoc/check-tag-names */

export {
  assertContextManifest,
  assertExecutionStatus,
  assertTuvrenMessage,
  isExecutionStatus,
  isTuvrenMessage,
} from "../lib/runtime-contract-guards.js";
export type {
  AfterIterationContext,
  AfterIterationHandler,
  AgentConfig,
  AroundModelContext,
  AroundModelHandler,
  AroundModelResult,
  CapabilityPolicyContextInputs,
} from "../lib/runtime-contract-shapes.js";
export type {
  ContextEngineeringContext,
  ContextEngineeringHelpers,
  ContextEngineeringPlan,
  ContextManifest,
  ContextManifestCounters,
  ContextManifestNameCounters,
} from "../lib/runtime-data-contract-shapes.js";
export type {
  ContextPolicy,
  ContextPolicyResult,
  ExtensionContext,
  HandoffContextBuilder,
  HandoffContextMode,
  HandoffContextPlan,
  HandoffSourceContext,
} from "../lib/runtime-contract-shapes.js";
export type { InputSignal } from "../lib/runtime-data-contract-shapes.js";
export type {
  InterceptContext,
  InterceptHandler,
  InterceptResult,
  IterationDecision,
  LoopPolicy,
  RuntimeResolution,
  SanitizeToolResultContext,
  SanitizeToolResultHook,
  ServerExecutionConfig,
  ServerExecutionRateLimitConfig,
  SystemPromptContext,
  SystemPromptFn,
  TuvrenExtension,
} from "../lib/runtime-contract-shapes.js";
export type { TuvrenMessage } from "../lib/runtime-data-contract-shapes.js";
export type {
  BranchMessagesCursor,
  BranchSummary,
  ExecutionBoundExceededDetails,
  ExecutionBoundKind,
  ExecutionBounds,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  ListThreadsCursor,
  OrchestrationHandle,
  OrchestrationResult,
  OrchestrationRuntime,
  ReclamationSummary,
  RuntimeMaintenance,
  ThreadSummary,
  TurnHistoryCursor,
  TurnSnapshot,
  TuvrenRuntime,
} from "../lib/runtime-execution-contract-shapes.js";
