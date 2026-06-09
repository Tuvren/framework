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
export type { MemoryBackendOptions } from "@tuvren/backend-memory";
export { createMemoryBackend } from "@tuvren/backend-memory";
export type { PostgresBackendOptions } from "@tuvren/backend-postgres";
export {
  createPostgresBackend,
  destroyPostgresBackend,
} from "@tuvren/backend-postgres";
export type { SqliteBackendOptions } from "@tuvren/backend-sqlite";
export { createSqliteBackend } from "@tuvren/backend-sqlite";
export type {
  EpochMs,
  HashString,
  KernelRecord,
  TuvrenErrorCode,
  TuvrenErrorOptions,
} from "@tuvren/core";
export {
  assertHashString,
  TuvrenError,
  TuvrenLineageError,
  TuvrenPersistenceError,
  TuvrenProviderError,
  TuvrenRecoveryError,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core";
export type {
  CustomEvent,
  ErrorEvent,
  EventSource,
  IterationEndEvent,
  IterationStartEvent,
  MessageDoneEvent,
  MessageStartEvent,
  StateCheckpointEvent,
  SteeringIncorporatedEvent,
  TurnEndEvent,
  TurnStartEvent,
  TuvrenStreamEvent,
} from "@tuvren/core/events";
export { assertTuvrenStreamEvent } from "@tuvren/core/events";
export type {
  AgentConfig,
  ContextManifest,
  ExecutionHandle,
  ExecutionStatus,
  InputSignal,
  LoopPolicy,
  OrchestrationHandle,
  OrchestrationRuntime,
  RuntimeResolution,
  TuvrenRuntime,
} from "@tuvren/core/execution";
export { assertExecutionStatus } from "@tuvren/core/execution";
export type { TuvrenExtension } from "@tuvren/core/extensions";
export type {
  ContentPart,
  FilePart,
  ReasoningPart,
  StructuredPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  TuvrenJsonSchema,
  TuvrenMessage,
  TuvrenModelConfig,
} from "@tuvren/core/messages";
export { assertTuvrenMessage } from "@tuvren/core/messages";
export type {
  ProviderStreamChunk,
  ProviderUsage,
  StructuredOutputRequest,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/core/provider";
export { assertTuvrenModelResponse } from "@tuvren/core/provider";
export type {
  TelemetryEvent,
  TelemetryEventKind,
  TelemetryLineage,
  TelemetrySpan,
  TelemetrySpanKind,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
export { NoopTelemetrySink } from "@tuvren/core/telemetry";
export type {
  ApprovalRequest,
  ApprovalResponse,
  FlexibleSchema,
  LazySchema,
  PendingToolCall,
  Schema,
  StandardSchema,
  ToolExecutionResult,
  TuvrenToolDefinition,
  ZodSchema,
} from "@tuvren/core/tools";
export {
  asSchema,
  assertApprovalRequest,
  assertApprovalResponse,
  assertTuvrenToolDefinition,
  defineTool,
  jsonSchema,
  schemaSymbol,
  standardSchema,
  zodSchema,
} from "@tuvren/core/tools";
export type { ReActDriverOptions } from "@tuvren/driver-react";
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
export type { McpToolSource } from "@tuvren/mcp-client";
export { createMcpToolSource } from "@tuvren/mcp-client";
export type { BindingResolver } from "./lib/binding-resolver.js";
export { createBindingResolver } from "./lib/binding-resolver.js";
export type {
  CapabilityPolicyEngineOptions,
  PolicyDimension,
} from "./lib/capability-policy-engine.js";
export { createCapabilityPolicyEngine } from "./lib/capability-policy-engine.js";
export type { CapabilityRegistry } from "./lib/capability-registry.js";
export { createCapabilityRegistry } from "./lib/capability-registry.js";
export { createClientEndpointBoundary } from "./lib/client-endpoint-boundary.js";
export {
  createContextManifest,
  createEmptyContextManifest,
  updateContextManifest,
} from "./lib/context-manifest.js";
export type {
  BackendKind,
  CreateTuvrenOptions,
  DriverKind,
  TuvrenInstance,
} from "./lib/create-tuvren.js";
export { createTuvren } from "./lib/create-tuvren.js";
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
  createTuvrenRuntime,
  DEFAULT_AGENT_SCHEMA,
  DEFAULT_AGENT_SCHEMA_ID,
  DEFAULT_MANIFEST_EXTENSION_STATE_WARNING_BUDGET_BYTES,
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
} from "./lib/runtime-core.js";
export type { ExecutionSessionRequest } from "./lib/runtime-execution-types.js";
export type { GrpcRuntimeKernelOptions } from "./lib/runtime-kernel-grpc.js";
export { createGrpcRuntimeKernel } from "./lib/runtime-kernel-grpc.js";
export { createToolRegistry } from "./lib/tool-registry.js";
