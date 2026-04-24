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

import type { EpochMs, HashString } from "@tuvren/core-types";
import { isHashString, TuvrenValidationError } from "@tuvren/core-types";
import {
  hasDistinctApprovalRequestCallIds,
  isApprovalDecision,
  isContentPart,
  isPendingToolCall,
  isToolResultPart,
} from "./runtime-content-approval-predicates.js";
import {
  isContextManifest,
  isOptionalContextManifestProperty,
} from "./runtime-context-manifest-predicates.js";
import {
  hasApprovalDecisionCoverage,
  hasCanonicalEpochMsTimestampAndValidSource,
  hasOnlyAllowedKeys,
  hasUniqueApprovalDecisionCallIds,
  isKrakenToolSchema,
  isNonEmptyArray,
  isNonEmptyStringProperty,
  isNonNegativeSafeIntegerProperty,
  isOptionalApprovalPolicy,
  isOptionalBooleanProperty,
  isOptionalHashStringProperty,
  isOptionalNonEmptyStringProperty,
  isOptionalProviderUsage,
  isOptionalSerializableRecordProperty,
  isOptionalStringProperty,
  isOptionalTimeoutProperty,
  isPlainObject,
  isSerializableContractValue,
  isStringProperty,
  isTuvrenErrorProjection,
  matchesStreamEventVariant,
  safePredicate,
} from "./runtime-contract-predicates.js";

const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const PROVIDER_STREAM_CHUNK_TYPES = new Set([
  "text_delta",
  "reasoning_delta",
  "reasoning_done",
  "structured_delta",
  "structured_done",
  "tool_call_start",
  "tool_call_args_delta",
  "tool_call_done",
  "finish",
  "error",
]);
const FINISH_REASONS = new Set([
  "stop",
  "tool_call",
  "length",
  "error",
  "content_filter",
]);
const STREAM_EVENT_TYPES = new Set([
  "turn.start",
  "turn.end",
  "iteration.start",
  "iteration.end",
  "message.start",
  "text.delta",
  "text.done",
  "reasoning.delta",
  "reasoning.done",
  "file.done",
  "structured.delta",
  "structured.done",
  "tool_call.start",
  "tool_call.args_delta",
  "tool_call.done",
  "message.done",
  "tool.start",
  "tool.result",
  "approval.requested",
  "approval.resolved",
  "steering.incorporated",
  "state.snapshot",
  "state.checkpoint",
  "error",
  "custom",
]);
const TURN_END_STATUSES = new Set(["completed", "paused", "failed"]);
const EXECUTION_PHASES = new Set(["running", "paused", "completed", "failed"]);
const SYSTEM_MESSAGE_KEYS = new Set(["role", "content"]);
const USER_MESSAGE_KEYS = new Set(["role", "parts"]);
const ASSISTANT_MESSAGE_KEYS = new Set(["role", "parts", "providerMetadata"]);
const TOOL_MESSAGE_KEYS = new Set(["role", "parts"]);
const PROVIDER_TEXT_DELTA_KEYS = new Set(["type", "text"]);
const PROVIDER_REASONING_DELTA_KEYS = new Set(["type", "text", "signature"]);
const PROVIDER_REASONING_DONE_KEYS = new Set(["type"]);
const PROVIDER_STRUCTURED_DELTA_KEYS = new Set(["type", "delta"]);
const PROVIDER_STRUCTURED_DONE_KEYS = new Set(["type", "data", "name"]);
const PROVIDER_TOOL_CALL_START_KEYS = new Set([
  "type",
  "providerCallId",
  "name",
]);
const PROVIDER_TOOL_CALL_ARGS_DELTA_KEYS = new Set([
  "type",
  "providerCallId",
  "delta",
]);
const PROVIDER_TOOL_CALL_DONE_KEYS = new Set([
  "type",
  "providerCallId",
  "name",
  "input",
]);
const PROVIDER_FINISH_KEYS = new Set([
  "type",
  "finishReason",
  "usage",
  "providerMetadata",
]);
const PROVIDER_ERROR_KEYS = new Set(["type", "error"]);
const TOOL_DEFINITION_KEYS = new Set([
  "approval",
  "description",
  "execute",
  "inputSchema",
  "metadata",
  "name",
  "timeout",
]);
const EXECUTION_STATUS_KEYS = new Set([
  "phase",
  "iterationCount",
  "activeAgent",
  "approval",
  "manifest",
  "pauseReason",
]);
const APPROVAL_REQUEST_KEYS = new Set(["toolCalls", "completedResults"]);
const APPROVAL_RESPONSE_KEYS = new Set(["decisions"]);
const KRAKEN_MODEL_RESPONSE_KEYS = new Set([
  "finishReason",
  "parts",
  "providerMetadata",
  "usage",
]);

export type TuvrenJsonValue =
  | null
  | boolean
  | number
  | string
  | TuvrenJsonValue[]
  | { [key: string]: TuvrenJsonValue };
export type TuvrenJsonSchema = { [key: string]: TuvrenJsonValue } | boolean;
export type ApprovalDecisionType =
  | "approve"
  | "edit"
  | "reject"
  | (string & {});
export type HandoffContextMode =
  | "preserve_trace"
  | "last_output_only"
  | (string & {});

export interface TextPart {
  providerMetadata?: Record<string, unknown>;
  text: string;
  type: "text";
}

export interface ReasoningPart {
  providerMetadata?: Record<string, unknown>;
  redacted: boolean;
  text: string;
  type: "reasoning";
}

export interface ToolCallPart {
  callId: string;
  input: unknown;
  name: string;
  providerMetadata?: Record<string, unknown>;
  type: "tool_call";
}

export interface ToolResultPart {
  callId: string;
  isError?: boolean;
  name: string;
  output: unknown;
  providerMetadata?: Record<string, unknown>;
  type: "tool_result";
}

export interface FilePart {
  data: string | Uint8Array;
  filename?: string;
  mediaType: string;
  providerMetadata?: Record<string, unknown>;
  type: "file";
}

export interface StructuredPart {
  data: unknown;
  name?: string;
  providerMetadata?: Record<string, unknown>;
  type: "structured";
}

type NonEmptyArray<T> = [T, ...T[]];

export type ContentPart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | FilePart
  | StructuredPart;

export type TuvrenMessage =
  | { role: "system"; content: string }
  | { role: "user"; parts: NonEmptyArray<ContentPart> }
  | {
      role: "assistant";
      parts: NonEmptyArray<ContentPart>;
      providerMetadata?: Record<string, unknown>;
    }
  | { role: "tool"; parts: NonEmptyArray<ToolResultPart> };

export interface InputSignal {
  parts: NonEmptyArray<ContentPart>;
}

export interface RenderedToolDefinition {
  description: string;
  inputSchema: TuvrenJsonSchema;
  name: string;
}

export interface TuvrenModelConfig {
  model?: string;
  provider?: string;
  settings?: Record<string, unknown>;
}

export interface StructuredOutputRequest {
  name?: string;
  schema: TuvrenJsonSchema;
  strict?: boolean;
}

export interface TuvrenPrompt {
  config?: TuvrenModelConfig;
  messages: TuvrenMessage[];
  responseFormat?: StructuredOutputRequest;
  tools?: RenderedToolDefinition[];
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ProviderStreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string; signature?: string }
  | { type: "reasoning_done" }
  | { type: "structured_delta"; delta: string }
  | { type: "structured_done"; data: unknown; name?: string }
  | { type: "tool_call_start"; providerCallId: string; name: string }
  | { type: "tool_call_args_delta"; providerCallId: string; delta: string }
  | {
      type: "tool_call_done";
      providerCallId: string;
      name: string;
      input: unknown;
    }
  | {
      type: "finish";
      finishReason:
        | "stop"
        | "tool_call"
        | "length"
        | "error"
        | "content_filter";
      usage?: ProviderUsage;
      providerMetadata?: Record<string, unknown>;
    }
  | { type: "error"; error: unknown };

export interface TuvrenModelResponse {
  finishReason: "stop" | "tool_call" | "length" | "error" | "content_filter";
  parts: ContentPart[];
  providerMetadata?: Record<string, unknown>;
  usage?: ProviderUsage;
}

export function isTuvrenModelResponse(
  value: unknown
): value is TuvrenModelResponse {
  return safePredicate(
    () =>
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, KRAKEN_MODEL_RESPONSE_KEYS) &&
      isStringProperty(value, "finishReason") &&
      FINISH_REASONS.has(value.finishReason) &&
      Array.isArray(value.parts) &&
      value.parts.every(isContentPart) &&
      isOptionalProviderUsage(value, "usage") &&
      isOptionalSerializableRecordProperty(value, "providerMetadata")
  );
}

export function assertTuvrenModelResponse(
  value: unknown,
  label = "value"
): asserts value is TuvrenModelResponse {
  if (!isTuvrenModelResponse(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid TuvrenModelResponse`,
      { code: "invalid_model_response", details: value }
    );
  }
}

export interface TuvrenProvider {
  generate(prompt: TuvrenPrompt): Promise<TuvrenModelResponse>;
  readonly id: string;
  stream(prompt: TuvrenPrompt): AsyncIterable<ProviderStreamChunk>;
}

export interface ContextManifestCounters {
  assistant: number;
  system: number;
  tool: number;
  user: number;
}

export interface ContextManifestNameCounters {
  byName: Record<string, number>;
  total: number;
}

export interface ContextManifest {
  byRole: ContextManifestCounters;
  extensions: Record<string, unknown>;
  lastAssistantMessageIndex: number;
  lastUserMessageIndex: number;
  messageCount: number;
  tokenEstimate: number;
  toolCalls: ContextManifestNameCounters;
  toolResults: ContextManifestNameCounters;
  turnBoundaries: number[];
}

export interface PendingToolCall {
  callId: string;
  decisions: string[];
  input: unknown;
  message: string;
  name: string;
}

export interface ApprovalRequest {
  completedResults: ToolResultPart[];
  toolCalls: PendingToolCall[];
}

export interface ApprovalDecision {
  callId: string;
  editedInput?: unknown;
  message?: string;
  type: ApprovalDecisionType;
}

export interface ApprovalResponse {
  decisions: ApprovalDecision[];
}

export interface ContextEngineeringHelpers {
  loadMessage(hash: HashString): TuvrenMessage | null;
  storeMessage(message: TuvrenMessage): HashString;
  storeMessages(messages: TuvrenMessage[]): HashString[];
}

export interface ContextEngineeringContext {
  helpers: ContextEngineeringHelpers;
  manifest: ContextManifest;
  messageHashes: HashString[];
  messages: TuvrenMessage[];
}

export interface ContextEngineeringPlan {
  action: string;
  execute(context: ContextEngineeringContext): HashString[];
}

export interface HandoffSourceContext {
  handoffIntent: {
    targetAgent: string;
    reason?: string;
    payload?: unknown;
  };
  helpers: ContextEngineeringHelpers;
  manifest: Readonly<ContextManifest>;
  messages: readonly TuvrenMessage[];
  sourceAgent: Readonly<AgentConfig>;
  targetAgent: Readonly<AgentConfig>;
}

export type HandoffContextBuilder = (
  context: HandoffSourceContext
) => HashString[];

export interface HandoffContextPlan {
  builder: HandoffContextBuilder;
  mode: HandoffContextMode;
  reason: string;
  sourceContext: HandoffSourceContext;
  targetAgent: string;
}

export type RuntimeResolution =
  | { type: "continue_iteration" }
  | { type: "end_turn"; reason: string }
  | { type: "pause"; reason: string; approval: ApprovalRequest }
  | {
      type: "handoff";
      targetAgent: string;
      contextPlan: HandoffContextPlan;
    }
  | { type: "fail"; error: Error; fatality: "hard" | "soft" };

export interface EventSource {
  agent: string;
  driver?: string;
  threadId?: string;
  workerId?: string;
}

export type DriverAttributedEventSource = EventSource;

export interface TuvrenErrorProjection {
  code?: string;
  details?: unknown;
  message: string;
}

export interface ValidationErrorPayload {
  details?: unknown;
  message: string;
}

export interface TurnStartEvent {
  resumedFrom?: HashString;
  source?: EventSource;
  threadId: string;
  timestamp: EpochMs;
  turnId: string;
  type: "turn.start";
}

export interface TurnEndEvent {
  source?: EventSource;
  status: "completed" | "paused" | "failed";
  timestamp: EpochMs;
  turnId: string;
  type: "turn.end";
}

export interface IterationStartEvent {
  iterationCount: number;
  source?: EventSource;
  timestamp: EpochMs;
  type: "iteration.start";
}

export interface IterationEndEvent {
  iterationCount: number;
  source?: EventSource;
  timestamp: EpochMs;
  type: "iteration.end";
}

export interface MessageStartEvent {
  messageId: string;
  role: "assistant";
  source?: EventSource;
  timestamp: EpochMs;
  type: "message.start";
}

export interface TextDeltaEvent {
  delta: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "text.delta";
}

export interface TextDoneEvent {
  messageId: string;
  source?: EventSource;
  text: string;
  timestamp: EpochMs;
  type: "text.done";
}

export interface ReasoningDeltaEvent {
  delta: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "reasoning.delta";
}

export interface ReasoningDoneEvent {
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "reasoning.done";
}

export interface StructuredDeltaEvent {
  delta: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "structured.delta";
}

export interface StructuredDoneEvent {
  data: unknown;
  messageId: string;
  name?: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "structured.done";
}

export interface FileDoneEvent {
  data: string | Uint8Array;
  filename?: string;
  mediaType: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "file.done";
}

export interface ToolCallStartEvent {
  callId: string;
  messageId: string;
  name: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool_call.start";
}

export interface ToolCallArgsDeltaEvent {
  callId: string;
  delta: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool_call.args_delta";
}

export interface ToolCallDoneEvent {
  callId: string;
  input: unknown;
  name: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool_call.done";
}

export interface MessageDoneEvent {
  finishReason: "stop" | "tool_call" | "length" | "error" | "content_filter";
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "message.done";
  usage?: ProviderUsage;
}

export interface ToolStartEvent {
  callId: string;
  input: unknown;
  name: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool.start";
}

export interface ToolResultEvent {
  callId: string;
  isError?: boolean;
  name: string;
  output: unknown;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool.result";
}

export interface ApprovalRequestedEvent {
  request: ApprovalRequest;
  source?: EventSource;
  timestamp: EpochMs;
  type: "approval.requested";
}

export interface ApprovalResolvedEvent {
  response: ApprovalResponse;
  source?: EventSource;
  timestamp: EpochMs;
  type: "approval.resolved";
}

export interface SteeringIncorporatedEvent {
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "steering.incorporated";
}

export interface ErrorEvent {
  error: TuvrenErrorProjection;
  fatal: boolean;
  source?: EventSource;
  timestamp: EpochMs;
  type: "error";
}

export type TuvrenStreamEvent =
  | TurnStartEvent
  | TurnEndEvent
  | IterationStartEvent
  | IterationEndEvent
  | MessageStartEvent
  | TextDeltaEvent
  | TextDoneEvent
  | ReasoningDeltaEvent
  | ReasoningDoneEvent
  | FileDoneEvent
  | StructuredDeltaEvent
  | StructuredDoneEvent
  | ToolCallStartEvent
  | ToolCallArgsDeltaEvent
  | ToolCallDoneEvent
  | MessageDoneEvent
  | ToolStartEvent
  | ToolResultEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | SteeringIncorporatedEvent
  | StateSnapshotEvent
  | StateCheckpointEvent
  | ErrorEvent
  | CustomEvent;

export interface StateSnapshotEvent {
  manifest: ContextManifest;
  source?: EventSource;
  timestamp: EpochMs;
  type: "state.snapshot";
}

export interface StateCheckpointEvent {
  iterationCount: number;
  source?: EventSource;
  timestamp: EpochMs;
  turnNodeHash: HashString;
  type: "state.checkpoint";
}

export interface CustomEvent {
  data: unknown;
  name: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "custom";
}

export type ValidationResult =
  | { valid: true; value: unknown }
  | { valid: false; error: ValidationErrorPayload };

export interface CustomSchema {
  toJSONSchema(): TuvrenJsonSchema;
  validate(input: unknown): ValidationResult;
}

export type ApprovalPolicy =
  | boolean
  | ((
      input: unknown,
      context: ToolExecutionContext
    ) => boolean | Promise<boolean>);

export interface ToolExecutionContext {
  callId: string;
  emit?: (event: { name: string; data: unknown }) => void;
  forward?: (event: TuvrenStreamEvent, source: EventSource) => void;
  metadata?: Record<string, unknown>;
  name: string;
  signal?: AbortSignal;
}

export type ExecuteFunction = (
  input: unknown,
  context: ToolExecutionContext
) => Promise<unknown> | unknown;

export interface TuvrenToolDefinition {
  approval?: ApprovalPolicy;
  description: string;
  execute: ExecuteFunction;
  inputSchema: TuvrenJsonSchema | CustomSchema;
  metadata?: Record<string, unknown>;
  name: string;
  timeout?: number;
}

export interface ToolDispatchContext {
  branchId: string;
  iterationCount: number;
  runId: string;
  stageResult(result: ToolResultPart): Promise<void>;
  turnId: string;
}

export type TuvrenToolResultBatch =
  | {
      approval: undefined;
      results: ToolResultPart[];
      state?: Record<string, unknown>;
    }
  | {
      approval: ApprovalRequest;
      results: ToolResultPart[];
      state?: Record<string, unknown>;
    };

export type ToolExecutionResult = TuvrenToolResultBatch;

export interface ToolRegistry {
  get(name: string): TuvrenToolDefinition | undefined;
  has(name: string): boolean;
  list(): TuvrenToolDefinition[];
  register(tool: TuvrenToolDefinition): void;
  toDefinitions(): RenderedToolDefinition[];
}

export interface IterationDecision {
  continue: boolean;
  executeTools: boolean;
  reason?: string;
}

export interface ContextPolicyResult {
  action: "none";
}

export interface ContextPolicy {
  evaluate(
    manifest: ContextManifest,
    iterationCount: number
  ): ContextPolicyResult | ContextEngineeringPlan;
}

export interface LoopPolicy {
  evaluate(
    response: TuvrenModelResponse,
    manifest: ContextManifest,
    iterationCount: number
  ): IterationDecision;
}

export interface SystemPromptContext {
  extensionState: Record<string, unknown>;
  iterationCount: number;
  manifest: ContextManifest;
  sharedExports: Record<string, Record<string, unknown>>;
}

export type SystemPromptFn = (
  context: SystemPromptContext
) => string | undefined;

export interface ExtensionContext {
  emit(event: { name: string; data: unknown }): void;
  extensionState: Record<string, unknown>;
  iterationCount: number;
  manifest: ContextManifest;
  sharedExports: Record<string, Record<string, unknown>>;
}

export interface InterceptContext extends ExtensionContext {
  messages: TuvrenMessage[];
  runId: string;
  turnId: string;
}

export interface InterceptResult {
  error?: Error;
  reason?: string;
  state?: Record<string, unknown>;
  verdict?: "endTurn" | "softFail" | "hardFail";
}

export type InterceptHandler = (
  context: InterceptContext
) => InterceptResult | undefined | Promise<InterceptResult | undefined>;

export interface BeforeIterationResult extends InterceptResult {
  cePlan?: ContextEngineeringPlan;
}

export type BeforeIterationHandler = (
  context: InterceptContext
) =>
  | BeforeIterationResult
  | undefined
  | Promise<BeforeIterationResult | undefined>;

export interface AfterIterationContext extends InterceptContext {
  resolution: RuntimeResolution;
  response: TuvrenModelResponse;
  toolResults?: ToolResultPart[];
}

export type AfterIterationHandler = (
  context: AfterIterationContext
) => InterceptResult | undefined | Promise<InterceptResult | undefined>;

export interface AroundModelContext extends ExtensionContext {
  config: TuvrenModelConfig;
  messages: TuvrenMessage[];
  prompt: TuvrenPrompt;
  tools: RenderedToolDefinition[];
}

export type AroundModelResult =
  | TuvrenModelResponse
  | {
      response: TuvrenModelResponse;
      state?: Record<string, unknown>;
    };

export type AroundModelHandler = (
  context: AroundModelContext,
  next: (context?: AroundModelContext) => Promise<TuvrenModelResponse>
) => Promise<AroundModelResult> | AroundModelResult;

export interface AroundToolContext extends ExtensionContext {
  approvalDecision?: ApprovalDecision;
  callId: string;
  forward(event: TuvrenStreamEvent, source: EventSource): void;
  input: unknown;
  tool: TuvrenToolDefinition;
  toolCall: ToolCallPart;
}

export type AroundToolResult =
  | ToolResultPart
  | { result: ToolResultPart; state?: Record<string, unknown> }
  | {
      verdict: "pause";
      approval: ApprovalRequest;
      state?: Record<string, unknown>;
    };

export type AroundToolHandler = (
  context: AroundToolContext,
  next: (context?: AroundToolContext) => Promise<ToolResultPart>
) => Promise<AroundToolResult> | AroundToolResult;

export type AroundToolSpec =
  | AroundToolHandler
  | { tools: string[]; handler: AroundToolHandler };

export interface TuvrenExtension {
  afterIteration?: AfterIterationHandler;
  afterTurn?: InterceptHandler;
  aroundModel?: AroundModelHandler;
  aroundTool?: AroundToolSpec;
  beforeIteration?: BeforeIterationHandler;
  beforeTurn?: InterceptHandler;
  exports?: string[];
  name: string;
  state?: Record<string, unknown>;
  systemPrompt?: string | SystemPromptFn;
  timeout?: number;
  tools?: TuvrenToolDefinition[];
}

export interface AgentConfig {
  contextPolicy?: ContextPolicy;
  extensions?: TuvrenExtension[];
  loopPolicy?: LoopPolicy;
  maxIterations?: number;
  maxParallelToolCalls?: number;
  model?: string | TuvrenProvider;
  name: string;
  responseFormat?: StructuredOutputRequest;
  systemPrompt?: string;
  tools?: TuvrenToolDefinition[];
}

export interface ExecutionStatus {
  activeAgent?: string;
  approval?: ApprovalRequest;
  iterationCount: number;
  manifest?: ContextManifest;
  pauseReason?: string;
  phase: "running" | "paused" | "completed" | "failed";
}

export interface ExecutionHandle {
  cancel(): void;
  events(): AsyncIterable<TuvrenStreamEvent>;
  resolveApproval(response: ApprovalResponse): ExecutionHandle;
  status(): ExecutionStatus;
  steer(signal: InputSignal): void;
}

export interface OrchestrationHandle extends ExecutionHandle {
  allEvents(): AsyncIterable<TuvrenStreamEvent>;
  awaitResult(): Promise<unknown>;
  resolveApproval(response: ApprovalResponse): OrchestrationHandle;
  spawn(input: { agent: string; signal: InputSignal }): OrchestrationHandle;
}

export interface OrchestrationRuntime {
  executeTurn(input: {
    agent: string;
    branchId: string;
    driverId?: string;
    parentTurnId?: string | null;
    schemaId?: string;
    signal: InputSignal;
    threadId: string;
    tools?: TuvrenToolDefinition[];
  }): OrchestrationHandle;
}

export interface TuvrenRuntime {
  createBranch(input: {
    branchId?: string;
    threadId: string;
    fromTurnNodeHash: HashString;
  }): Promise<{
    branchId: string;
    threadId: string;
    headTurnNodeHash: HashString;
  }>;
  createThread(input: {
    threadId?: string;
    schemaId?: string;
    initialBranchId?: string;
  }): Promise<{
    threadId: string;
    branchId: string;
    rootTurnNodeHash: HashString;
    rootTurnTreeHash: HashString;
  }>;
  executeTurn(input: {
    signal: InputSignal;
    threadId: string;
    branchId: string;
    schemaId?: string;
    driverId?: string;
    config: AgentConfig;
    tools?: TuvrenToolDefinition[];
    parentTurnId?: string | null;
  }): ExecutionHandle;
  getThread(threadId: string): Promise<{
    threadId: string;
    schemaId: string;
    rootTurnNodeHash: HashString;
  } | null>;
  setBranchHead(input: {
    branchId: string;
    turnNodeHash: HashString;
  }): Promise<{
    branchId: string;
    headTurnNodeHash: HashString;
    archiveBranchId?: string;
  }>;
}

export function isTuvrenMessage(value: unknown): value is TuvrenMessage {
  return safePredicate(() => {
    if (!isPlainObject(value)) {
      return false;
    }

    if (!(isStringProperty(value, "role") && MESSAGE_ROLES.has(value.role))) {
      return false;
    }

    switch (value.role) {
      case "system":
        return (
          // Durable framework messages should always carry meaningful content.
          hasOnlyAllowedKeys(value, SYSTEM_MESSAGE_KEYS) &&
          isNonEmptyStringProperty(value, "content") &&
          !("parts" in value) &&
          !("providerMetadata" in value)
        );
      case "user":
        return (
          hasOnlyAllowedKeys(value, USER_MESSAGE_KEYS) &&
          isNonEmptyArray(value.parts) &&
          value.parts.every(isContentPart)
        );
      case "assistant":
        return (
          hasOnlyAllowedKeys(value, ASSISTANT_MESSAGE_KEYS) &&
          isNonEmptyArray(value.parts) &&
          value.parts.every(isContentPart) &&
          isOptionalSerializableRecordProperty(value, "providerMetadata")
        );
      case "tool":
        return (
          hasOnlyAllowedKeys(value, TOOL_MESSAGE_KEYS) &&
          isNonEmptyArray(value.parts) &&
          value.parts.every(isToolResultPart)
        );
      default:
        return false;
    }
  });
}

export function assertTuvrenMessage(
  value: unknown,
  label = "value"
): asserts value is TuvrenMessage {
  if (!isTuvrenMessage(value)) {
    throw new TuvrenValidationError(`${label} must be a valid TuvrenMessage`, {
      code: "invalid_tuvren_message",
      details: value,
    });
  }
}

export function isApprovalRequest(value: unknown): value is ApprovalRequest {
  return safePredicate(() => {
    if (
      !(
        isPlainObject(value) &&
        hasOnlyAllowedKeys(value, APPROVAL_REQUEST_KEYS) &&
        Array.isArray(value.toolCalls) &&
        value.toolCalls.length > 0 &&
        value.toolCalls.every(isPendingToolCall) &&
        Array.isArray(value.completedResults) &&
        value.completedResults.every(isToolResultPart)
      )
    ) {
      return false;
    }

    return hasDistinctApprovalRequestCallIds(
      value.toolCalls,
      value.completedResults
    );
  });
}

export function assertApprovalRequest(
  value: unknown,
  label = "value"
): asserts value is ApprovalRequest {
  if (!isApprovalRequest(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ApprovalRequest`,
      { code: "invalid_approval_request", details: value }
    );
  }
}

export function isProviderStreamChunk(
  value: unknown
): value is ProviderStreamChunk {
  return safePredicate(() => {
    if (
      !(
        isPlainObject(value) &&
        isStringProperty(value, "type") &&
        PROVIDER_STREAM_CHUNK_TYPES.has(value.type)
      )
    ) {
      return false;
    }

    switch (value.type) {
      case "text_delta":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_TEXT_DELTA_KEYS) &&
          typeof value.text === "string"
        );
      case "reasoning_delta":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_REASONING_DELTA_KEYS) &&
          typeof value.text === "string" &&
          isOptionalStringProperty(value, "signature")
        );
      case "reasoning_done":
        return hasOnlyAllowedKeys(value, PROVIDER_REASONING_DONE_KEYS);
      case "structured_delta":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_STRUCTURED_DELTA_KEYS) &&
          typeof value.delta === "string"
        );
      case "structured_done":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_STRUCTURED_DONE_KEYS) &&
          "data" in value &&
          isSerializableContractValue(value.data) &&
          isOptionalStringProperty(value, "name")
        );
      case "tool_call_start":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_TOOL_CALL_START_KEYS) &&
          isNonEmptyStringProperty(value, "providerCallId") &&
          isNonEmptyStringProperty(value, "name")
        );
      case "tool_call_args_delta":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_TOOL_CALL_ARGS_DELTA_KEYS) &&
          isNonEmptyStringProperty(value, "providerCallId") &&
          typeof value.delta === "string"
        );
      case "tool_call_done":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_TOOL_CALL_DONE_KEYS) &&
          isNonEmptyStringProperty(value, "providerCallId") &&
          isNonEmptyStringProperty(value, "name") &&
          "input" in value &&
          isSerializableContractValue(value.input)
        );
      case "finish":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_FINISH_KEYS) &&
          isStringProperty(value, "finishReason") &&
          FINISH_REASONS.has(value.finishReason) &&
          isOptionalProviderUsage(value, "usage") &&
          isOptionalSerializableRecordProperty(value, "providerMetadata")
        );
      case "error":
        return (
          hasOnlyAllowedKeys(value, PROVIDER_ERROR_KEYS) && "error" in value
        );
      default:
        return false;
    }
  });
}

export function assertProviderStreamChunk(
  value: unknown,
  label = "value"
): asserts value is ProviderStreamChunk {
  if (!isProviderStreamChunk(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ProviderStreamChunk`,
      { code: "invalid_provider_stream_chunk", details: value }
    );
  }
}

export function isTuvrenStreamEvent(
  value: unknown
): value is TuvrenStreamEvent {
  return safePredicate(() => {
    if (
      !(
        isPlainObject(value) &&
        isStringProperty(value, "type") &&
        STREAM_EVENT_TYPES.has(value.type)
      )
    ) {
      return false;
    }

    if (!hasCanonicalEpochMsTimestampAndValidSource(value)) {
      return false;
    }

    return hasValidStreamEventPayload(value);
  });
}

function hasValidStreamEventPayload(
  value: Record<string, unknown> & { timestamp: EpochMs; type: string }
): boolean {
  switch (value.type) {
    case "turn.start":
      return matchesStreamEventVariant(
        value,
        ["turnId", "threadId", "resumedFrom"],
        () =>
          isNonEmptyStringProperty(value, "turnId") &&
          isNonEmptyStringProperty(value, "threadId") &&
          isOptionalHashStringProperty(value, "resumedFrom")
      );
    case "turn.end":
      return matchesStreamEventVariant(
        value,
        ["turnId", "status"],
        () =>
          isNonEmptyStringProperty(value, "turnId") &&
          isStringProperty(value, "status") &&
          TURN_END_STATUSES.has(value.status)
      );
    case "iteration.start":
    case "iteration.end":
      return matchesStreamEventVariant(value, ["iterationCount"], () =>
        isNonNegativeSafeIntegerProperty(value, "iterationCount")
      );
    case "message.start":
      return matchesStreamEventVariant(
        value,
        ["messageId", "role"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          value.role === "assistant"
      );
    case "text.delta":
      return matchesStreamEventVariant(
        value,
        ["messageId", "delta"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          typeof value.delta === "string"
      );
    case "text.done":
      return matchesStreamEventVariant(
        value,
        ["messageId", "text"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          typeof value.text === "string"
      );
    case "reasoning.delta":
      return matchesStreamEventVariant(
        value,
        ["messageId", "delta"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          typeof value.delta === "string"
      );
    case "reasoning.done":
      return matchesStreamEventVariant(value, ["messageId"], () =>
        isNonEmptyStringProperty(value, "messageId")
      );
    case "file.done":
      return matchesStreamEventVariant(
        value,
        ["messageId", "data", "filename", "mediaType"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          "data" in value &&
          (typeof value.data === "string" ||
            value.data instanceof Uint8Array) &&
          isOptionalStringProperty(value, "filename") &&
          isNonEmptyStringProperty(value, "mediaType")
      );
    case "structured.delta":
      return matchesStreamEventVariant(
        value,
        ["messageId", "delta"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          typeof value.delta === "string"
      );
    case "structured.done":
      return matchesStreamEventVariant(
        value,
        ["messageId", "data", "name"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          "data" in value &&
          isSerializableContractValue(value.data) &&
          isOptionalStringProperty(value, "name")
      );
    case "tool_call.start":
      return matchesStreamEventVariant(
        value,
        ["messageId", "callId", "name"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          isNonEmptyStringProperty(value, "callId") &&
          isNonEmptyStringProperty(value, "name")
      );
    case "tool_call.args_delta":
      return matchesStreamEventVariant(
        value,
        ["callId", "delta"],
        () =>
          isNonEmptyStringProperty(value, "callId") &&
          typeof value.delta === "string"
      );
    case "tool_call.done":
      return matchesStreamEventVariant(
        value,
        ["callId", "name", "input"],
        () =>
          isNonEmptyStringProperty(value, "callId") &&
          isNonEmptyStringProperty(value, "name") &&
          "input" in value &&
          isSerializableContractValue(value.input)
      );
    case "message.done":
      return matchesStreamEventVariant(
        value,
        ["messageId", "finishReason", "usage"],
        () =>
          isNonEmptyStringProperty(value, "messageId") &&
          isStringProperty(value, "finishReason") &&
          FINISH_REASONS.has(value.finishReason) &&
          isOptionalProviderUsage(value, "usage")
      );
    case "tool.start":
      return matchesStreamEventVariant(
        value,
        ["callId", "name", "input"],
        () =>
          isNonEmptyStringProperty(value, "callId") &&
          isNonEmptyStringProperty(value, "name") &&
          "input" in value &&
          isSerializableContractValue(value.input)
      );
    case "tool.result":
      return matchesStreamEventVariant(
        value,
        ["callId", "name", "output", "isError"],
        () =>
          isNonEmptyStringProperty(value, "callId") &&
          isNonEmptyStringProperty(value, "name") &&
          "output" in value &&
          isSerializableContractValue(value.output) &&
          isOptionalBooleanProperty(value, "isError")
      );
    case "approval.requested":
      return matchesStreamEventVariant(value, ["request"], () =>
        isApprovalRequest(value.request)
      );
    case "approval.resolved":
      return matchesStreamEventVariant(value, ["response"], () =>
        isApprovalResponse(value.response)
      );
    case "steering.incorporated":
      return matchesStreamEventVariant(value, ["messageId"], () =>
        isNonEmptyStringProperty(value, "messageId")
      );
    case "state.snapshot":
      return matchesStreamEventVariant(value, ["manifest"], () =>
        isContextManifest(value.manifest)
      );
    case "state.checkpoint":
      return matchesStreamEventVariant(
        value,
        ["iterationCount", "turnNodeHash"],
        () =>
          isNonNegativeSafeIntegerProperty(value, "iterationCount") &&
          isHashString(value.turnNodeHash)
      );
    case "error":
      return matchesStreamEventVariant(
        value,
        ["error", "fatal"],
        () =>
          isTuvrenErrorProjection(value.error) &&
          typeof value.fatal === "boolean"
      );
    case "custom":
      return matchesStreamEventVariant(
        value,
        ["name", "data"],
        () =>
          isNonEmptyStringProperty(value, "name") &&
          "data" in value &&
          isSerializableContractValue(value.data)
      );
    default:
      return false;
  }
}

export function assertTuvrenStreamEvent(
  value: unknown,
  label = "value"
): asserts value is TuvrenStreamEvent {
  if (!isTuvrenStreamEvent(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid TuvrenStreamEvent`,
      { code: "invalid_stream_event", details: value }
    );
  }
}

export function isTuvrenToolDefinition(
  value: unknown
): value is TuvrenToolDefinition {
  return safePredicate(
    () =>
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, TOOL_DEFINITION_KEYS) &&
      isNonEmptyStringProperty(value, "name") &&
      typeof value.description === "string" &&
      typeof value.execute === "function" &&
      isKrakenToolSchema(value.inputSchema) &&
      isOptionalApprovalPolicy(value, "approval") &&
      isOptionalSerializableRecordProperty(value, "metadata") &&
      isOptionalTimeoutProperty(value, "timeout")
  );
}

export function assertTuvrenToolDefinition(
  value: unknown,
  label = "value"
): asserts value is TuvrenToolDefinition {
  if (!isTuvrenToolDefinition(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid TuvrenToolDefinition`,
      { code: "invalid_tool_definition", details: value }
    );
  }
}

export function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return safePredicate(() => {
    if (
      !(
        isPlainObject(value) &&
        hasOnlyAllowedKeys(value, EXECUTION_STATUS_KEYS) &&
        isStringProperty(value, "phase") &&
        EXECUTION_PHASES.has(value.phase) &&
        isNonNegativeSafeIntegerProperty(value, "iterationCount") &&
        isOptionalApprovalRequest(value, "approval") &&
        isOptionalNonEmptyStringProperty(value, "activeAgent") &&
        isOptionalContextManifestProperty(value, "manifest") &&
        isOptionalNonEmptyStringProperty(value, "pauseReason")
      )
    ) {
      return false;
    }

    if (value.approval !== undefined && value.phase !== "paused") {
      return false;
    }

    if (value.pauseReason !== undefined && value.phase !== "paused") {
      return false;
    }

    // The current framework semantics only pause for tool approval, so a
    // paused status must carry both the approval payload and its reason.
    if (
      value.phase === "paused" &&
      (value.approval === undefined || value.pauseReason === undefined)
    ) {
      return false;
    }

    return true;
  });
}

export function assertExecutionStatus(
  value: unknown,
  label = "value"
): asserts value is ExecutionStatus {
  if (!isExecutionStatus(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ExecutionStatus`,
      { code: "invalid_execution_status", details: value }
    );
  }
}

export function isApprovalResponse(value: unknown): value is ApprovalResponse {
  // Standalone approval responses can only validate response-local shape.
  // Matching decision callIds back to the paused request requires request
  // context and is enforced by `isApprovalResponseForRequest`.
  return safePredicate(
    () =>
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, APPROVAL_RESPONSE_KEYS) &&
      Array.isArray(value.decisions) &&
      value.decisions.length > 0 &&
      value.decisions.every(isApprovalDecision) &&
      hasUniqueApprovalDecisionCallIds(value.decisions)
  );
}

export function isApprovalResponseForRequest(
  value: unknown,
  request: ApprovalRequest
): value is ApprovalResponse {
  // Request-aware validation binds the response back to the paused approval
  // batch: every pending tool call needs exactly one allowed operator choice.
  return safePredicate(
    () =>
      isApprovalResponse(value) &&
      hasApprovalDecisionCoverage(value.decisions, request.toolCalls)
  );
}

export function assertApprovalResponse(
  value: unknown,
  label = "value"
): asserts value is ApprovalResponse {
  if (!isApprovalResponse(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ApprovalResponse`,
      { code: "invalid_approval_response", details: value }
    );
  }
}

export function assertApprovalResponseForRequest(
  value: unknown,
  request: ApprovalRequest,
  label = "value"
): asserts value is ApprovalResponse {
  if (!isApprovalResponseForRequest(value, request)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ApprovalResponse for the active approval request`,
      { code: "invalid_approval_response", details: value }
    );
  }
}

function isOptionalApprovalRequest<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isApprovalRequest(value[key]);
}

export function assertContextManifest(
  value: unknown,
  label = "value"
): asserts value is ContextManifest {
  if (!isContextManifest(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid ContextManifest`,
      { code: "invalid_context_manifest", details: value }
    );
  }
}
