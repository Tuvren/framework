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

// biome-ignore-all lint/performance/noBarrelFile: This package subpath is the intentional focused contract surface.
export {
  assertContextManifest,
  assertExecutionStatus,
  assertTuvrenMessage,
  isExecutionStatus,
  isTuvrenMessage,
} from "../lib/runtime-contract-guards.js";
// Execution handles, runtime interface, orchestration types, context/policy, and
// durable-read cursor types. Extension lifecycle types are also here for
// backward compat with @tuvren/runtime-api/execution consumers.
export type {
  AfterIterationContext,
  AfterIterationHandler,
  AgentConfig,
  AroundModelContext,
  AroundModelHandler,
  AroundModelResult,
  BranchMessagesCursor,
  BranchSummary,
  CapabilityPolicyContextInputs,
  ContextEngineeringContext,
  ContextEngineeringHelpers,
  ContextEngineeringPlan,
  ContextManifest,
  ContextManifestCounters,
  ContextManifestNameCounters,
  ContextPolicy,
  ContextPolicyResult,
  ExecutionBoundExceededDetails,
  ExecutionBoundKind,
  ExecutionBounds,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  ExtensionContext,
  HandoffContextBuilder,
  HandoffContextMode,
  HandoffContextPlan,
  HandoffSourceContext,
  InputSignal,
  InterceptContext,
  InterceptHandler,
  InterceptResult,
  IterationDecision,
  ListThreadsCursor,
  LoopPolicy,
  OrchestrationHandle,
  OrchestrationResult,
  OrchestrationRuntime,
  ReclamationSummary,
  RuntimeMaintenance,
  RuntimeResolution,
  ServerExecutionConfig,
  ServerExecutionRateLimitConfig,
  SystemPromptContext,
  SystemPromptFn,
  ThreadSummary,
  TurnHistoryCursor,
  TurnSnapshot,
  TuvrenExtension,
  TuvrenMessage,
  TuvrenRuntime,
} from "../lib/runtime-contract-shapes.js";
