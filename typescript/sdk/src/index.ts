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

// biome-ignore-all lint/performance/noBarrelFile: This package root is the intentional SDK surface.
// @tuvren/sdk — the host-facing composition tier (ADR-057). It is the single
// curated surface a host imports alongside `@tuvren/core` and the leaf packages
// it chose: the batteries-included `createTuvren` composition entrypoint, the
// curated `@tuvren/core` re-exports a host reaches for, the host-facing
// kernel-protocol contract types (so a host can type the backend/kernel
// instances it passes in without importing `@tuvren/kernel-protocol` directly),
// and the developer helpers (schema authoring, payload codecs) extracted from
// the behavior-free `@tuvren/core` ABI package. The internal `@tuvren/runtime`
// engine is not a host-facing surface; hosts never import it directly.

// ── Curated @tuvren/core re-exports ───────────────────────────────────────────
export type {
  EpochMs,
  HashString,
  KernelRecord,
  Scope,
  TuvrenErrorCode,
  TuvrenErrorOptions,
} from "@tuvren/core";
export {
  assertHashString,
  assertScope,
  DEFAULT_SCOPE,
  isScope,
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
  ReclamationSummary,
  RuntimeMaintenance,
  RuntimeResolution,
  TuvrenRuntime,
} from "@tuvren/core/execution";
export { assertExecutionStatus } from "@tuvren/core/execution";
export type { TuvrenExtension } from "@tuvren/core/extensions";
// Data-lifecycle crypto-shredding payload codec contract (ADR-051, KRT-BF005):
// the contract lives in @tuvren/core/lifecycle; the batteries-included codec
// implementations are re-exported further below from ./lib/payload-codec.js.
export type {
  ErasedPayload,
  PayloadCodec,
  PayloadCodecContext,
  PayloadDecryptResult,
} from "@tuvren/core/lifecycle";
// The identity codec and envelope discriminant relocated to the @tuvren/core ABI
// tier (ADR-057, sdk⇄runtime cycle break); re-publish them on the sdk surface
// directly from their new home so existing @tuvren/sdk importers are unaffected.
export {
  createIdentityPayloadCodec,
  IDENTITY_PAYLOAD_CODEC,
  isErasedPayload,
  isPayloadEnvelope,
} from "@tuvren/core/lifecycle";
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
  TelemetryBufferingPolicy,
  TelemetryDestination,
  TelemetryEvent,
  TelemetryEventKind,
  TelemetryLineage,
  TelemetryOperationalSignal,
  TelemetryOperationalSignalKind,
  TelemetryRoute,
  TelemetryRouting,
  TelemetrySpan,
  TelemetrySpanKind,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
export { NoopTelemetrySink } from "@tuvren/core/telemetry";
export type {
  ApprovalRequest,
  ApprovalResponse,
  PendingToolCall,
  ToolExecutionResult,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";
export {
  assertApprovalRequest,
  assertApprovalResponse,
  assertTuvrenToolDefinition,
} from "@tuvren/core/tools";
// ── Host-facing kernel-protocol contract types ────────────────────────────────
// Re-exported so a host can type the backend/kernel instances it constructs and
// passes into `createTuvren` without importing `@tuvren/kernel-protocol`
// directly (ADR-057 §3 host import contract).
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
// ── Batteries-included composition entrypoint (ADR-040 / ADR-057) ─────────────
export {
  type CreateTuvrenOptions,
  createTuvren,
  type McpToolSource,
  type TuvrenInstance,
} from "./lib/create-tuvren.js";
// ── Developer helpers ─────────────────────────────────────────────────────────
// Payload-codec implementations (contract lives in @tuvren/core/lifecycle).
export {
  type AesGcmPayloadCodecOptions,
  createAesGcmPayloadCodec,
  type PayloadKeyring,
} from "./lib/payload-codec.js";
// Schema-authoring helpers (tool contracts live in @tuvren/core/tools).
export {
  asSchema,
  defineTool,
  type FlexibleSchema,
  jsonSchema,
  type LazySchema,
  type Schema,
  type StandardSchema,
  schemaSymbol,
  standardSchema,
  type ZodSchema,
  zodSchema,
} from "./lib/schema-authoring.js";
