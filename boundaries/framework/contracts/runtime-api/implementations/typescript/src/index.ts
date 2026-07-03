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
// DEPRECATED: @tuvren/runtime-api will be removed in the next minor release.
// Import directly from @tuvren/core/* subpaths instead.
console.warn(
  "[deprecated] @tuvren/runtime-api is deprecated and will be removed in the next minor release. " +
    "Import from @tuvren/core/* subpaths instead: " +
    "@tuvren/core, @tuvren/core/events, @tuvren/core/execution, @tuvren/core/extensions, " +
    "@tuvren/core/messages, @tuvren/core/provider, @tuvren/core/tools."
);

// Primitive types and error classes — @tuvren/core root
export type { EpochMs, HashString, KernelRecord } from "@tuvren/core";
export { TuvrenValidationError } from "@tuvren/core";
// Event types — @tuvren/core/events
export type {
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  CustomEvent,
  ErrorEvent,
  EventSource,
  FileDoneEvent,
  IterationEndEvent,
  IterationStartEvent,
  MessageDoneEvent,
  MessageStartEvent,
  ReasoningDeltaEvent,
  ReasoningDoneEvent,
  RunnerAttributedEventSource,
  StateCheckpointEvent,
  StateSnapshotEvent,
  SteeringIncorporatedEvent,
  StructuredDeltaEvent,
  StructuredDoneEvent,
  TextDeltaEvent,
  TextDoneEvent,
  ToolCallArgsDeltaEvent,
  ToolCallDoneEvent,
  ToolCallStartEvent,
  ToolResultEvent,
  ToolStartEvent,
  TurnEndEvent,
  TurnStartEvent,
  TuvrenErrorProjection,
  TuvrenStreamEvent,
} from "@tuvren/core/events";
export {
  assertTuvrenStreamEvent,
  isTuvrenStreamEvent,
} from "@tuvren/core/events";
// Execution/orchestration/context types — @tuvren/core/execution
export type {
  AgentConfig,
  BranchMessagesCursor,
  BranchSummary,
  ContextEngineeringContext,
  ContextEngineeringHelpers,
  ContextEngineeringPlan,
  ContextManifest,
  ContextManifestCounters,
  ContextManifestNameCounters,
  ContextPolicy,
  ContextPolicyResult,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  HandoffContextBuilder,
  HandoffContextMode,
  HandoffContextPlan,
  HandoffSourceContext,
  InputSignal,
  IterationDecision,
  ListThreadsCursor,
  LoopPolicy,
  OrchestrationHandle,
  OrchestrationResult,
  OrchestrationRuntime,
  RuntimeResolution,
  ThreadSummary,
  TurnHistoryCursor,
  TurnSnapshot,
  TuvrenRuntime,
} from "@tuvren/core/execution";
export {
  assertContextManifest,
  assertExecutionStatus,
  isExecutionStatus,
} from "@tuvren/core/execution";
// Extension lifecycle types — @tuvren/core/extensions
export type {
  AfterIterationContext,
  AfterIterationHandler,
  AroundModelContext,
  AroundModelHandler,
  AroundModelResult,
  AroundToolContext,
  AroundToolHandler,
  AroundToolResult,
  AroundToolSpec,
  ExtensionContext,
  InterceptContext,
  InterceptHandler,
  InterceptResult,
  SystemPromptContext,
  SystemPromptFn,
  TuvrenExtension,
} from "@tuvren/core/extensions";
// Message/content types — @tuvren/core/messages
export type {
  ApprovalDecisionType,
  ContentPart,
  FilePart,
  ReasoningPart,
  StructuredPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  TuvrenJsonSchema,
  TuvrenJsonValue,
  TuvrenMessage,
  TuvrenModelConfig,
} from "@tuvren/core/messages";
export { assertTuvrenMessage, isTuvrenMessage } from "@tuvren/core/messages";
// Provider types — @tuvren/core/provider
export type {
  ProviderStreamChunk,
  ProviderUsage,
  StructuredOutputRequest,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/core/provider";
export {
  assertProviderStreamChunk,
  assertTuvrenModelResponse,
  isProviderStreamChunk,
  isTuvrenModelResponse,
} from "@tuvren/core/provider";
// Tool types — @tuvren/core/tools
export type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResponse,
  CustomSchema,
  ExecuteFunction,
  PendingToolCall,
  RenderedToolDefinition,
  ToolDispatchContext,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
  TuvrenToolDefinition,
  TuvrenToolResultBatch,
  ValidationErrorPayload,
  ValidationResult,
} from "@tuvren/core/tools";
export {
  assertApprovalRequest,
  assertApprovalResponse,
  assertApprovalResponseForRequest,
  assertTuvrenToolDefinition,
  isApprovalRequest,
  isApprovalResponse,
  isApprovalResponseForRequest,
  isTuvrenToolDefinition,
} from "@tuvren/core/tools";
