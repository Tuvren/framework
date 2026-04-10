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

import type { EpochMs, HashString } from "@kraken/shared-core-types";
import { isHashString, KrakenValidationError } from "@kraken/shared-core-types";

const CONTENT_PART_TYPES = new Set([
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "file",
  "structured",
]);
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
const JSON_SCHEMA_TYPE_NAMES = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);
const SYSTEM_MESSAGE_KEYS = new Set(["role", "content"]);
const USER_MESSAGE_KEYS = new Set(["role", "parts"]);
const ASSISTANT_MESSAGE_KEYS = new Set(["role", "parts", "providerMetadata"]);
const TOOL_MESSAGE_KEYS = new Set(["role", "parts"]);
const TEXT_PART_KEYS = new Set(["type", "text", "providerMetadata"]);
const REASONING_PART_KEYS = new Set([
  "type",
  "text",
  "redacted",
  "providerMetadata",
]);
const TOOL_CALL_PART_KEYS = new Set([
  "type",
  "callId",
  "name",
  "input",
  "providerMetadata",
]);
const TOOL_RESULT_PART_KEYS = new Set([
  "type",
  "callId",
  "name",
  "output",
  "isError",
  "providerMetadata",
]);
const FILE_PART_KEYS = new Set([
  "type",
  "data",
  "mediaType",
  "filename",
  "providerMetadata",
]);
const STRUCTURED_PART_KEYS = new Set([
  "type",
  "data",
  "name",
  "providerMetadata",
]);
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
  "approval",
  "activeAgent",
  "manifest",
  "pauseReason",
]);
const TOOL_RESULT_MESSAGE_KEYS = new Set([
  "type",
  "callId",
  "name",
  "output",
  "isError",
  "providerMetadata",
]);
const PENDING_TOOL_CALL_KEYS = new Set([
  "callId",
  "decisions",
  "input",
  "message",
  "name",
]);
const APPROVAL_RESPONSE_KEYS = new Set(["decisions"]);
const APPROVAL_DECISION_KEYS = new Set([
  "callId",
  "editedInput",
  "message",
  "type",
]);

export type KrakenJsonValue =
  | null
  | boolean
  | number
  | string
  | KrakenJsonValue[]
  | { [key: string]: KrakenJsonValue };
export type KrakenJsonSchema = { [key: string]: KrakenJsonValue } | boolean;
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

export type ContentPart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | FilePart
  | StructuredPart;

export type KrakenMessage =
  | { role: "system"; content: string }
  | { role: "user"; parts: ContentPart[] }
  | {
      role: "assistant";
      parts: ContentPart[];
      providerMetadata?: Record<string, unknown>;
    }
  | { role: "tool"; parts: ToolResultPart[] };

export interface InputSignal {
  parts: ContentPart[];
}

export interface RenderedToolDefinition {
  description: string;
  inputSchema: KrakenJsonSchema;
  name: string;
}

export interface KrakenModelConfig {
  model?: string;
  provider?: string;
  settings?: Record<string, unknown>;
}

export interface StructuredOutputRequest {
  name?: string;
  schema: KrakenJsonSchema;
  strict?: boolean;
}

export interface KrakenPrompt {
  config?: KrakenModelConfig;
  messages: KrakenMessage[];
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

export interface KrakenModelResponse {
  finishReason: "stop" | "tool_call" | "length" | "error" | "content_filter";
  parts: ContentPart[];
  providerMetadata?: Record<string, unknown>;
  usage?: ProviderUsage;
}

export interface RuntimeModelProvider {
  generate(prompt: KrakenPrompt): Promise<KrakenModelResponse>;
  readonly id: string;
  stream(prompt: KrakenPrompt): AsyncIterable<ProviderStreamChunk>;
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
  loadMessage(hash: HashString): KrakenMessage | null;
  storeMessage(message: KrakenMessage): HashString;
  storeMessages(messages: KrakenMessage[]): HashString[];
}

export interface ContextEngineeringContext {
  helpers: ContextEngineeringHelpers;
  manifest: ContextManifest;
  messageHashes: HashString[];
  messages: KrakenMessage[];
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
  manifest: ContextManifest;
  messages: KrakenMessage[];
  sourceAgent: AgentConfig;
  targetAgent: AgentConfig;
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

export interface KrakenErrorProjection {
  code?: string;
  details?: unknown;
  message: string;
}

export interface ValidationErrorPayload {
  details?: unknown;
  message: string;
}

export type KrakenStreamEvent =
  | {
      type: "turn.start";
      turnId: string;
      threadId: string;
      resumedFrom?: HashString;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "turn.end";
      turnId: string;
      status: "completed" | "paused" | "failed";
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "iteration.start" | "iteration.end";
      iterationCount: number;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "message.start";
      messageId: string;
      role: "assistant";
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "text.delta";
      messageId: string;
      delta: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "text.done";
      messageId: string;
      text: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "reasoning.delta";
      messageId: string;
      delta: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "reasoning.done";
      messageId: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "structured.delta";
      messageId: string;
      delta: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "structured.done";
      messageId: string;
      data: unknown;
      name?: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "tool_call.start";
      messageId: string;
      callId: string;
      name: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "tool_call.args_delta";
      callId: string;
      delta: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "tool_call.done";
      callId: string;
      name: string;
      input: unknown;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "message.done";
      messageId: string;
      finishReason:
        | "stop"
        | "tool_call"
        | "length"
        | "error"
        | "content_filter";
      usage?: ProviderUsage;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "tool.start";
      callId: string;
      name: string;
      input: unknown;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "tool.result";
      callId: string;
      name: string;
      output: unknown;
      isError?: boolean;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "approval.requested";
      request: ApprovalRequest;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "approval.resolved";
      response: ApprovalResponse;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "steering.incorporated";
      messageId: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | StateSnapshotEvent
  | StateCheckpointEvent
  | {
      type: "error";
      error: KrakenErrorProjection;
      fatal: boolean;
      timestamp: EpochMs;
      source?: EventSource;
    }
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
  toJSONSchema(): KrakenJsonSchema;
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
  forward?: (event: KrakenStreamEvent, source: EventSource) => void;
  metadata?: Record<string, unknown>;
  name: string;
  signal?: AbortSignal;
}

export type ExecuteFunction = (
  input: unknown,
  context: ToolExecutionContext
) => Promise<unknown> | unknown;

export interface KrakenToolDefinition {
  approval?: ApprovalPolicy;
  description: string;
  execute: ExecuteFunction;
  inputSchema: KrakenJsonSchema | CustomSchema;
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

export type KrakenToolResultBatch =
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

export type ToolExecutionResult = KrakenToolResultBatch;

export interface ToolRegistry {
  get(name: string): KrakenToolDefinition | undefined;
  has(name: string): boolean;
  list(): KrakenToolDefinition[];
  register(tool: KrakenToolDefinition): void;
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
    response: KrakenModelResponse,
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
  messages: KrakenMessage[];
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
  response: KrakenModelResponse;
  toolResults?: ToolResultPart[];
}

export type AfterIterationHandler = (
  context: AfterIterationContext
) => InterceptResult | undefined | Promise<InterceptResult | undefined>;

export interface AroundModelContext extends ExtensionContext {
  config: KrakenModelConfig;
  messages: KrakenMessage[];
  prompt: KrakenPrompt;
  tools: RenderedToolDefinition[];
}

export type AroundModelResult =
  | KrakenModelResponse
  | {
      response: KrakenModelResponse;
      state?: Record<string, unknown>;
    };

export type AroundModelHandler = (
  context: AroundModelContext,
  next: (context?: AroundModelContext) => Promise<KrakenModelResponse>
) => Promise<AroundModelResult> | AroundModelResult;

export interface AroundToolContext extends ExtensionContext {
  approvalDecision?: ApprovalDecision;
  callId: string;
  forward(event: KrakenStreamEvent, source: EventSource): void;
  input: unknown;
  tool: KrakenToolDefinition;
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

export interface KrakenExtension {
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
  tools?: KrakenToolDefinition[];
}

export interface AgentConfig {
  contextPolicy?: ContextPolicy;
  extensions?: KrakenExtension[];
  loopPolicy?: LoopPolicy;
  maxIterations?: number;
  model?: string | RuntimeModelProvider;
  name: string;
  responseFormat?: StructuredOutputRequest;
  systemPrompt?: string;
  tools?: KrakenToolDefinition[];
}

export interface RuntimeStatusRecord {
  activeAgent?: string;
  currentModel?: string;
  currentProvider?: string;
  iterationCount?: number;
  partial?: boolean;
  pauseReason?: string;
  resumptionSchema?: unknown;
  state: "running" | "paused" | "completed" | "failed";
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
  events(): AsyncIterable<KrakenStreamEvent>;
  resolveApproval(response: ApprovalResponse): ExecutionHandle;
  status(): ExecutionStatus;
  steer(signal: InputSignal): void;
}

export interface KrakenRuntime {
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
    tools?: KrakenToolDefinition[];
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

export function isKrakenMessage(value: unknown): value is KrakenMessage {
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

export function assertKrakenMessage(
  value: unknown,
  label = "value"
): asserts value is KrakenMessage {
  if (!isKrakenMessage(value)) {
    throw new KrakenValidationError(`${label} must be a valid KrakenMessage`, {
      code: "invalid_kraken_message",
      details: value,
    });
  }
}

export function isApprovalRequest(value: unknown): value is ApprovalRequest {
  return safePredicate(() => {
    if (
      !(
        isPlainObject(value) &&
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
    throw new KrakenValidationError(
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
    throw new KrakenValidationError(
      `${label} must be a valid ProviderStreamChunk`,
      { code: "invalid_provider_stream_chunk", details: value }
    );
  }
}

export function isKrakenStreamEvent(
  value: unknown
): value is KrakenStreamEvent {
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

    if (!hasEpochMsTimestamp(value)) {
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
          isKrakenErrorProjection(value.error) &&
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

export function assertKrakenStreamEvent(
  value: unknown,
  label = "value"
): asserts value is KrakenStreamEvent {
  if (!isKrakenStreamEvent(value)) {
    throw new KrakenValidationError(
      `${label} must be a valid KrakenStreamEvent`,
      { code: "invalid_stream_event", details: value }
    );
  }
}

export function isKrakenToolDefinition(
  value: unknown
): value is KrakenToolDefinition {
  return safePredicate(
    () =>
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, TOOL_DEFINITION_KEYS) &&
      isNonEmptyStringProperty(value, "name") &&
      typeof value.description === "string" &&
      typeof value.execute === "function" &&
      isKrakenToolSchema(value.inputSchema) &&
      isOptionalApprovalPolicy(value, "approval") &&
      isOptionalPlainObjectProperty(value, "metadata") &&
      isOptionalTimeoutProperty(value, "timeout")
  );
}

export function assertKrakenToolDefinition(
  value: unknown,
  label = "value"
): asserts value is KrakenToolDefinition {
  if (!isKrakenToolDefinition(value)) {
    throw new KrakenValidationError(
      `${label} must be a valid KrakenToolDefinition`,
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
        isOptionalContextManifest(value, "manifest") &&
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
    throw new KrakenValidationError(
      `${label} must be a valid ExecutionStatus`,
      { code: "invalid_execution_status", details: value }
    );
  }
}

function isContentPart(value: unknown): value is ContentPart {
  if (
    !(
      isPlainObject(value) &&
      isStringProperty(value, "type") &&
      CONTENT_PART_TYPES.has(value.type)
    )
  ) {
    return false;
  }

  switch (value.type) {
    case "text":
      return (
        hasOnlyAllowedKeys(value, TEXT_PART_KEYS) &&
        typeof value.text === "string" &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    case "reasoning":
      return (
        hasOnlyAllowedKeys(value, REASONING_PART_KEYS) &&
        typeof value.text === "string" &&
        typeof value.redacted === "boolean" &&
        (value.redacted || value.text.length > 0) &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    case "tool_call":
      return (
        hasOnlyAllowedKeys(value, TOOL_CALL_PART_KEYS) &&
        isNonEmptyStringProperty(value, "callId") &&
        isNonEmptyStringProperty(value, "name") &&
        "input" in value &&
        isSerializableContractValue(value.input) &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    case "tool_result":
      return (
        hasOnlyAllowedKeys(value, TOOL_RESULT_PART_KEYS) &&
        isNonEmptyStringProperty(value, "callId") &&
        isNonEmptyStringProperty(value, "name") &&
        "output" in value &&
        isSerializableContractValue(value.output) &&
        isOptionalBooleanProperty(value, "isError") &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    case "file":
      return (
        hasOnlyAllowedKeys(value, FILE_PART_KEYS) &&
        (typeof value.data === "string" || value.data instanceof Uint8Array) &&
        isNonEmptyStringProperty(value, "mediaType") &&
        isOptionalStringProperty(value, "filename") &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    case "structured":
      return (
        hasOnlyAllowedKeys(value, STRUCTURED_PART_KEYS) &&
        "data" in value &&
        isSerializableContractValue(value.data) &&
        isOptionalStringProperty(value, "name") &&
        isOptionalSerializableRecordProperty(value, "providerMetadata")
      );
    default:
      return false;
  }
}

function isToolResultPart(value: unknown): value is ToolResultPart {
  return (
    isPlainObject(value) &&
    hasOnlyAllowedKeys(value, TOOL_RESULT_MESSAGE_KEYS) &&
    value.type === "tool_result" &&
    isNonEmptyStringProperty(value, "callId") &&
    isNonEmptyStringProperty(value, "name") &&
    "output" in value &&
    isSerializableContractValue(value.output) &&
    isOptionalBooleanProperty(value, "isError") &&
    isOptionalSerializableRecordProperty(value, "providerMetadata")
  );
}

function isPendingToolCall(value: unknown): value is PendingToolCall {
  return (
    isPlainObject(value) &&
    hasOnlyAllowedKeys(value, PENDING_TOOL_CALL_KEYS) &&
    isNonEmptyStringProperty(value, "callId") &&
    isNonEmptyStringProperty(value, "name") &&
    isNonEmptyStringProperty(value, "message") &&
    "input" in value &&
    isSerializableContractValue(value.input) &&
    Array.isArray(value.decisions) &&
    value.decisions.length > 0 &&
    value.decisions.every(isNonEmptyStringValue)
  );
}

export function isApprovalResponse(value: unknown): value is ApprovalResponse {
  return safePredicate(
    () =>
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, APPROVAL_RESPONSE_KEYS) &&
      Array.isArray(value.decisions) &&
      value.decisions.length > 0 &&
      hasUniqueApprovalDecisionCallIds(value.decisions) &&
      value.decisions.every(isApprovalDecision)
  );
}

export function assertApprovalResponse(
  value: unknown,
  label = "value"
): asserts value is ApprovalResponse {
  if (!isApprovalResponse(value)) {
    throw new KrakenValidationError(
      `${label} must be a valid ApprovalResponse`,
      { code: "invalid_approval_response", details: value }
    );
  }
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  if (
    !(
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, APPROVAL_DECISION_KEYS) &&
      isNonEmptyStringProperty(value, "callId") &&
      isNonEmptyStringProperty(value, "type") &&
      isOptionalNonEmptyStringProperty(value, "message")
    )
  ) {
    return false;
  }

  if (value.type === "edit" && !("editedInput" in value)) {
    return false;
  }

  if (value.type !== "edit" && "editedInput" in value) {
    return false;
  }

  if (
    value.type === "edit" &&
    !isSerializableContractValue(value.editedInput)
  ) {
    return false;
  }

  // Approval notes are optional for all decision types, but if present they
  // should carry real explanatory text instead of an empty placeholder.
  return true;
}

function isKrakenErrorProjection(
  value: unknown
): value is KrakenErrorProjection {
  return (
    isPlainObject(value) &&
    typeof value.message === "string" &&
    isOptionalStringProperty(value, "code") &&
    isOptionalSerializableContractValueProperty(value, "details")
  );
}

function isContextManifest(value: unknown): value is ContextManifest {
  const byRole = isPlainObject(value) ? value.byRole : undefined;
  const messageCount = isPlainObject(value) ? value.messageCount : undefined;
  const lastAssistantMessageIndex = isPlainObject(value)
    ? value.lastAssistantMessageIndex
    : undefined;
  const lastUserMessageIndex = isPlainObject(value)
    ? value.lastUserMessageIndex
    : undefined;
  const toolCalls = isPlainObject(value) ? value.toolCalls : undefined;
  const toolResults = isPlainObject(value) ? value.toolResults : undefined;

  if (
    !(
      isPlainObject(value) &&
      isContextManifestCounters(byRole) &&
      isSerializableRecord(value.extensions) &&
      isNonNegativeSafeInteger(messageCount) &&
      isNonNegativeFiniteNumberProperty(value, "tokenEstimate") &&
      isContextManifestNameCounters(toolCalls) &&
      isContextManifestNameCounters(toolResults) &&
      Array.isArray(value.turnBoundaries) &&
      value.turnBoundaries.every(
        (item) => Number.isSafeInteger(item) && item >= 0
      )
    )
  ) {
    return false;
  }

  if (
    !(
      isMessageIndexValue(lastAssistantMessageIndex, messageCount) &&
      isMessageIndexValue(lastUserMessageIndex, messageCount)
    )
  ) {
    return false;
  }

  if (
    !(
      hasValidLastRoleIndex(
        byRole.assistant,
        lastAssistantMessageIndex,
        messageCount
      ) &&
      hasValidLastRoleIndex(byRole.user, lastUserMessageIndex, messageCount)
    )
  ) {
    return false;
  }

  if (
    byRole.assistant + byRole.system + byRole.tool + byRole.user !==
    messageCount
  ) {
    return false;
  }

  if (
    !(
      hasMatchingNamedCounterTotal(toolCalls) &&
      hasMatchingNamedCounterTotal(toolResults)
    )
  ) {
    return false;
  }

  if (
    !hasValidTurnBoundaries(
      value.turnBoundaries,
      messageCount,
      byRole.user,
      lastUserMessageIndex
    )
  ) {
    return false;
  }

  return true;
}

function isContextManifestCounters(
  value: unknown
): value is ContextManifestCounters {
  return (
    isPlainObject(value) &&
    isNonNegativeSafeIntegerProperty(value, "assistant") &&
    isNonNegativeSafeIntegerProperty(value, "system") &&
    isNonNegativeSafeIntegerProperty(value, "tool") &&
    isNonNegativeSafeIntegerProperty(value, "user")
  );
}

function isContextManifestNameCounters(
  value: unknown
): value is ContextManifestNameCounters {
  return (
    isPlainObject(value) &&
    isPlainObject(value.byName) &&
    Object.keys(value.byName).every(isNonEmptyStringValue) &&
    Object.values(value.byName).every(
      (count) =>
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ) &&
    isNonNegativeSafeIntegerProperty(value, "total")
  );
}

function hasValidLastRoleIndex(
  roleCount: number,
  lastIndex: number,
  messageCount: number
): boolean {
  if (roleCount === 0) {
    return lastIndex === -1;
  }

  return (
    lastIndex >= roleCount - 1 && lastIndex >= 0 && lastIndex < messageCount
  );
}

function hasMatchingNamedCounterTotal(
  counters: ContextManifestNameCounters
): boolean {
  const namedTotal = Object.values(counters.byName).reduce(
    (sum, count) => sum + count,
    0
  );
  return namedTotal === counters.total;
}

function hasOrderedTurnBoundaries(
  turnBoundaries: number[],
  messageCount: number
): boolean {
  let previousBoundary = -1;

  for (const boundary of turnBoundaries) {
    if (boundary >= messageCount || boundary <= previousBoundary) {
      return false;
    }

    previousBoundary = boundary;
  }

  return true;
}

function hasValidTurnBoundaries(
  turnBoundaries: number[],
  messageCount: number,
  userCount: number,
  lastUserMessageIndex: number
): boolean {
  if (!hasOrderedTurnBoundaries(turnBoundaries, messageCount)) {
    return false;
  }

  if (userCount === 0) {
    return turnBoundaries.length === 0;
  }

  if (!(turnBoundaries.length > 0 && turnBoundaries.length <= userCount)) {
    return false;
  }

  if (userCount === 1) {
    return (
      turnBoundaries.length === 1 && turnBoundaries[0] === lastUserMessageIndex
    );
  }

  // There must still be enough index space before the last user message to
  // fit the declared number of user-role messages, even when the first user
  // turn starts after leading system or assistant messages.
  const earliestPossibleFirstUserIndex = lastUserMessageIndex - userCount + 1;

  if (turnBoundaries[0] > earliestPossibleFirstUserIndex) {
    return false;
  }

  if (
    turnBoundaries.length === userCount &&
    turnBoundaries.at(-1) !== lastUserMessageIndex
  ) {
    return false;
  }

  const lastBoundary = turnBoundaries.at(-1);

  return (
    turnBoundaries[0] <= lastUserMessageIndex &&
    lastBoundary !== undefined &&
    lastBoundary <= lastUserMessageIndex
  );
}

function hasDistinctApprovalRequestCallIds(
  toolCalls: PendingToolCall[],
  completedResults: ToolResultPart[]
): boolean {
  const seenCallIds = new Set<string>();

  for (const toolCall of toolCalls) {
    if (seenCallIds.has(toolCall.callId)) {
      return false;
    }

    seenCallIds.add(toolCall.callId);
  }

  for (const result of completedResults) {
    if (seenCallIds.has(result.callId)) {
      return false;
    }

    seenCallIds.add(result.callId);
  }

  return true;
}

function hasEpochMsTimestamp(
  value: Record<string, unknown>
): value is Record<string, unknown> & { timestamp: EpochMs } {
  if (
    typeof value.timestamp !== "number" ||
    !Number.isSafeInteger(value.timestamp)
  ) {
    return false;
  }

  if (
    "source" in value &&
    value.source !== undefined &&
    !isEventSource(value.source)
  ) {
    return false;
  }

  return true;
}

function isOptionalBooleanProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || typeof value[key] === "boolean";
}

function isOptionalApprovalPolicy<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isApprovalPolicy(value[key]);
}

function isOptionalApprovalRequest<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isApprovalRequest(value[key]);
}

function isOptionalContextManifest<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isContextManifest(value[key]);
}

function isOptionalHashStringProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isHashString(value[key]);
}

function isOptionalPlainObjectProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isPlainObject(value[key]);
}

function isOptionalSerializableRecordProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isSerializableRecord(value[key]);
}

function isOptionalSerializableContractValueProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isSerializableContractValue(value[key]);
}

function isOptionalProviderUsage<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isProviderUsage(value[key]);
}

function isOptionalStringProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function isOptionalNonEmptyStringProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isNonEmptyStringProperty(value, key);
}

function isNonEmptyStringProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return isNonEmptyStringValue(value[key]);
}

function isNonEmptyStringValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyArray(value: unknown): value is [unknown, ...unknown[]] {
  return Array.isArray(value) && value.length > 0;
}

function isOptionalTimeoutProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isTimeoutMs(value[key]);
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return typeof value === "boolean" || typeof value === "function";
}

function isNonNegativeFiniteNumberProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  const numericValue = value[key];
  return (
    typeof numericValue === "number" &&
    Number.isFinite(numericValue) &&
    numericValue >= 0
  );
}

function isKrakenJsonSchema(value: unknown): value is KrakenJsonSchema {
  return (
    typeof value === "boolean" ||
    (isKrakenJsonObject(value, new WeakSet()) && isValidJsonSchemaObject(value))
  );
}

function isSerializableContractValue(value: unknown): value is KrakenJsonValue {
  return isKrakenJsonValue(value, new WeakSet());
}

function isSerializableRecord(
  value: unknown
): value is { [key: string]: KrakenJsonValue } {
  return isKrakenJsonObject(value, new WeakSet());
}

function isValidJsonSchemaObject(value: {
  [key: string]: KrakenJsonValue;
}): boolean {
  if ("type" in value) {
    const schemaType = value.type;

    if (!isValidJsonSchemaType(schemaType)) {
      return false;
    }
  }

  if (
    "required" in value &&
    !(
      Array.isArray(value.required) &&
      value.required.every((item) => typeof item === "string") &&
      hasUniqueStrings(value.required)
    )
  ) {
    return false;
  }

  if (
    "properties" in value &&
    !(
      isKrakenJsonObject(value.properties, new WeakSet<object>()) &&
      Object.values(value.properties).every(isKrakenJsonSchema)
    )
  ) {
    return false;
  }

  if ("items" in value && !isKrakenJsonSchema(value.items)) {
    return false;
  }

  if (
    "additionalProperties" in value &&
    !(
      typeof value.additionalProperties === "boolean" ||
      isKrakenJsonSchema(value.additionalProperties)
    )
  ) {
    return false;
  }

  if ("propertyNames" in value && !isKrakenJsonSchema(value.propertyNames)) {
    return false;
  }

  if (
    "oneOf" in value &&
    !(Array.isArray(value.oneOf) && value.oneOf.every(isKrakenJsonSchema))
  ) {
    return false;
  }

  return true;
}

function isKrakenJsonObject(
  value: unknown,
  activeParents: WeakSet<object>
): value is { [key: string]: KrakenJsonValue } {
  if (!isPlainObject(value)) {
    return false;
  }

  if (activeParents.has(value)) {
    return false;
  }

  activeParents.add(value);

  for (const key of Object.keys(value)) {
    if (!isKrakenJsonValue(value[key], activeParents)) {
      activeParents.delete(value);
      return false;
    }
  }

  activeParents.delete(value);
  return true;
}

function isKrakenJsonValue(
  value: unknown,
  activeParents: WeakSet<object>
): value is KrakenJsonValue {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) {
        if (activeParents.has(value)) {
          return false;
        }

        activeParents.add(value);

        for (const item of value) {
          if (!isKrakenJsonValue(item, activeParents)) {
            activeParents.delete(value);
            return false;
          }
        }

        activeParents.delete(value);
        return true;
      }

      return isKrakenJsonObject(value, activeParents);
    default:
      return false;
  }
}

function isKrakenToolSchema(
  value: unknown
): value is KrakenJsonSchema | CustomSchema {
  return isKrakenJsonSchema(value) || isCustomSchema(value);
}

function isCustomSchema(value: unknown): value is CustomSchema {
  return (
    value !== null &&
    typeof value === "object" &&
    "toJSONSchema" in value &&
    typeof value.toJSONSchema === "function" &&
    "validate" in value &&
    typeof value.validate === "function"
  );
}

function isProviderUsage(value: unknown): value is ProviderUsage {
  return (
    isPlainObject(value) &&
    isNonNegativeSafeIntegerProperty(value, "inputTokens") &&
    isNonNegativeSafeIntegerProperty(value, "outputTokens")
  );
}

function isTimeoutMs(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeIntegerProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  const propertyValue = value[key];
  return (
    typeof propertyValue === "number" &&
    Number.isSafeInteger(propertyValue) &&
    propertyValue >= 0
  );
}

function isMessageIndexValue(
  value: unknown,
  messageCount: number
): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1) {
    return false;
  }

  if (messageCount === 0) {
    return value === -1;
  }

  return value < messageCount;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasUniqueApprovalDecisionCallIds(
  decisions: ApprovalDecision[]
): boolean {
  const seenCallIds = new Set<string>();

  for (const decision of decisions) {
    if (seenCallIds.has(decision.callId)) {
      return false;
    }

    seenCallIds.add(decision.callId);
  }

  return true;
}

function hasUniqueStrings(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function isEventSource(value: unknown): value is EventSource {
  if (!(isPlainObject(value) && isNonEmptyStringProperty(value, "agent"))) {
    return false;
  }

  if (
    "driver" in value &&
    value.driver !== undefined &&
    !isNonEmptyStringProperty(value, "driver")
  ) {
    return false;
  }

  if (
    "threadId" in value &&
    value.threadId !== undefined &&
    !isNonEmptyStringProperty(value, "threadId")
  ) {
    return false;
  }

  if (
    "workerId" in value &&
    value.workerId !== undefined &&
    !isNonEmptyStringProperty(value, "workerId")
  ) {
    return false;
  }

  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object") {
      return false;
    }

    const prototype = Object.getPrototypeOf(value);

    if (!(prototype === Object.prototype || prototype === null)) {
      return false;
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      return false;
    }

    // Contract-boundary objects must be fully enumerable so they round-trip
    // through normal JSON-like serialization without hidden state.
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => descriptor.enumerable
    );
  } catch {
    return false;
  }
}

function isStringProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): value is TObject & Record<TKey, string> {
  return typeof value[key] === "string";
}

function isValidJsonSchemaType(value: unknown): boolean {
  return (
    (typeof value === "string" && JSON_SCHEMA_TYPE_NAMES.has(value)) ||
    (Array.isArray(value) &&
      value.length > 0 &&
      hasUniqueStrings(value) &&
      value.every(
        (item) => typeof item === "string" && JSON_SCHEMA_TYPE_NAMES.has(item)
      ))
  );
}

function safePredicate(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    // `is*` guards are used to probe untrusted input, so malformed accessors
    // must collapse to `false` instead of escaping as thrown errors.
    return false;
  }
}

function hasOnlyAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasOnlyStreamEventKeys(
  value: Record<string, unknown>,
  eventSpecificKeys: string[]
): boolean {
  return hasOnlyAllowedKeys(
    value,
    new Set(["type", "timestamp", "source", ...eventSpecificKeys])
  );
}

function matchesStreamEventVariant(
  value: Record<string, unknown>,
  eventSpecificKeys: string[],
  predicate: () => boolean
): boolean {
  return hasOnlyStreamEventKeys(value, eventSpecificKeys) && predicate();
}
