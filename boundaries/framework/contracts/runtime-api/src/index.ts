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

// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public contract surface.
export type {
  EpochMs,
  HashString,
  KernelRecord,
} from "@kraken/shared-core-types";
export { KrakenValidationError } from "@kraken/shared-core-types";
export type {
  AfterIterationContext,
  AfterIterationHandler,
  AgentConfig,
  ApprovalDecision,
  ApprovalDecisionType,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResponse,
  AroundModelContext,
  AroundModelHandler,
  AroundModelResult,
  AroundToolContext,
  AroundToolHandler,
  AroundToolResult,
  AroundToolSpec,
  ContentPart,
  ContextEngineeringContext,
  ContextEngineeringHelpers,
  ContextEngineeringPlan,
  ContextManifest,
  ContextManifestCounters,
  ContextManifestNameCounters,
  ContextPolicy,
  ContextPolicyResult,
  CustomEvent,
  CustomSchema,
  DriverAttributedEventSource,
  EventSource,
  ExecuteFunction,
  ExecutionHandle,
  ExecutionStatus,
  ExtensionContext,
  FilePart,
  HandoffContextBuilder,
  HandoffContextMode,
  HandoffContextPlan,
  HandoffSourceContext,
  InputSignal,
  InterceptContext,
  InterceptHandler,
  InterceptResult,
  IterationDecision,
  KrakenErrorProjection,
  KrakenExtension,
  KrakenJsonSchema,
  KrakenMessage,
  KrakenModelConfig,
  KrakenModelResponse,
  KrakenPrompt,
  KrakenRuntime,
  KrakenStreamEvent,
  KrakenToolDefinition,
  KrakenToolResultBatch,
  LoopPolicy,
  PendingToolCall,
  ProviderStreamChunk,
  ProviderUsage,
  ReasoningPart,
  RenderedToolDefinition,
  RuntimeModelProvider,
  RuntimeResolution,
  RuntimeStatusRecord,
  StateCheckpointEvent,
  StateSnapshotEvent,
  StructuredOutputRequest,
  StructuredPart,
  SystemPromptContext,
  SystemPromptFn,
  TextPart,
  ToolCallPart,
  ToolDispatchContext,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
  ToolResultPart,
  ValidationErrorPayload,
  ValidationResult,
} from "./lib/runtime-contracts.js";
export {
  assertApprovalRequest,
  assertApprovalResponse,
  assertExecutionStatus,
  assertKrakenMessage,
  assertKrakenStreamEvent,
  assertKrakenToolDefinition,
  assertProviderStreamChunk,
  isApprovalRequest,
  isApprovalResponse,
  isExecutionStatus,
  isKrakenMessage,
  isKrakenStreamEvent,
  isKrakenToolDefinition,
  isProviderStreamChunk,
} from "./lib/runtime-contracts.js";
