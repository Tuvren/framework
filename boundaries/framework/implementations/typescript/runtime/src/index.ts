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

// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional curated host-facing SDK surface.
export type {
  EpochMs,
  HashString,
  KernelRecord,
  TuvrenErrorCode,
  TuvrenErrorOptions,
} from "@tuvren/core-types";
export {
  assertHashString,
  TuvrenError,
  TuvrenLineageError,
  TuvrenPersistenceError,
  TuvrenProviderError,
  TuvrenRecoveryError,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core-types";
export type {
  ReActDriverOptions,
  ReActDriverProviderCallMode,
  ReActDriverProviderCallModeResolver,
  ReActDriverToolExecutionModeResolver,
} from "@tuvren/driver-react";
export { createReActDriver, REACT_DRIVER_ID } from "@tuvren/driver-react";
export type {
  RuntimeBackend,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
export {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
} from "@tuvren/kernel-protocol";
export type { RuntimeKernelOptions } from "@tuvren/kernel-runtime";
export { createRuntimeKernel } from "@tuvren/kernel-runtime";
export type {
  AgentConfig,
  ApprovalRequest,
  ApprovalResponse,
  ContentPart,
  ContextManifest,
  CustomEvent,
  ErrorEvent,
  EventSource,
  ExecutionHandle,
  ExecutionStatus,
  FilePart,
  InputSignal,
  IterationEndEvent,
  IterationStartEvent,
  LoopPolicy,
  MessageDoneEvent,
  MessageStartEvent,
  OrchestrationHandle,
  PendingToolCall,
  ProviderStreamChunk,
  ProviderUsage,
  ReasoningPart,
  RuntimeResolution,
  StateCheckpointEvent,
  SteeringIncorporatedEvent,
  StructuredOutputRequest,
  StructuredPart,
  TextPart,
  ToolCallPart,
  ToolExecutionResult,
  ToolResultPart,
  TurnEndEvent,
  TurnStartEvent,
  TuvrenJsonSchema,
  TuvrenMessage,
  TuvrenModelConfig,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
  TuvrenRuntime,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
} from "@tuvren/runtime-api";
export {
  assertApprovalRequest,
  assertApprovalResponse,
  assertExecutionStatus,
  assertTuvrenMessage,
  assertTuvrenModelResponse,
  assertTuvrenStreamEvent,
  assertTuvrenToolDefinition,
} from "@tuvren/runtime-api";
export type {
  ExecutionSessionRequest,
  GrpcRuntimeKernelOptions,
  RuntimeCoreOptions,
  RuntimeRunLivenessOptions,
  RuntimeWarning,
  TuvrenRuntimeTelemetryAttributeDefinition,
  TuvrenRuntimeTelemetryAttributeKey,
} from "@tuvren/runtime-core";
export {
  createContextManifest,
  createDriverRegistry,
  createEmptyContextManifest,
  createGrpcRuntimeKernel,
  createToolRegistry,
  createTuvrenRuntimeCore,
  DEFAULT_AGENT_SCHEMA,
  DEFAULT_AGENT_SCHEMA_ID,
  DEFAULT_MANIFEST_EXTENSION_STATE_WARNING_BUDGET_BYTES,
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS,
  TUVREN_RUNTIME_TELEMETRY_ATTRIBUTES,
  TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL,
  updateContextManifest,
} from "@tuvren/runtime-core";
