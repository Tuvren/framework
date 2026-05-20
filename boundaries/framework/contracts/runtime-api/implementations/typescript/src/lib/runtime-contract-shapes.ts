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

import type { EpochMs, HashString, TuvrenError } from "@tuvren/core-types";

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
      providerMetadata?: Record<string, unknown>;
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
  providerMetadata?: Record<string, unknown>;
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

// `status` is the sole discriminant; `executionStatus.phase === status` for all terminal results.
export type ExecutionResult =
  | {
      status: "completed";
      finalAssistantMessage?: TuvrenMessage;
      executionStatus: ExecutionStatus;
    }
  | {
      status: "failed";
      error: TuvrenError;
      executionStatus: ExecutionStatus;
    };

// Type intersection (not interface extension) because TS2312 forbids interfaces
// from extending discriminated unions.
export type OrchestrationResult = ExecutionResult & {
  childResults: Record<string, ExecutionResult>;
};

export interface ExecutionHandle {
  cancel(): void;
  events(): AsyncIterable<TuvrenStreamEvent>;
  resolveApproval(response: ApprovalResponse): ExecutionHandle;
  status(): ExecutionStatus;
  steer(signal: InputSignal): void;
  awaitResult(): Promise<ExecutionResult>;
}

export interface OrchestrationHandle extends ExecutionHandle {
  allEvents(): AsyncIterable<TuvrenStreamEvent>;
  awaitResult(): Promise<OrchestrationResult>;
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

// ── Durable-Read Return Types (ADR-036) ─────────────────────────────────────

export interface ThreadSummary {
  threadId: string;
  schemaId: string;
  rootTurnNodeHash: HashString;
  createdAtMs: EpochMs;
}

export interface BranchSummary {
  branchId: string;
  threadId: string;
  headTurnNodeHash: HashString;
}

export interface TurnSnapshot {
  turnNodeHash: HashString;
  previousTurnNodeHash: HashString | null;
  turnTreeHash: HashString;
  schemaId: string;
  eventHash: HashString | null;
  manifest: ContextManifest | null;
  paths: Record<string, HashString[] | HashString | null>;
}

export type ListThreadsCursor = string;   // opaque to host; see TechSpec §3.8
export type TurnHistoryCursor = string;   // opaque to host; see TechSpec §3.8
export type BranchMessagesCursor = string; // opaque to host; see TechSpec §3.8

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

  // ── Durable-Read Surface (ADR-036) ──────────────────────────────────────
  listThreads(options?: {
    limit?: number;
    cursor?: ListThreadsCursor;
    filter?: { schemaId?: string };
  }): Promise<{ threads: ThreadSummary[]; nextCursor?: ListThreadsCursor }>;

  // listBranches is intentionally unbounded: branches per thread are bounded
  // by O(1) active divergence paths in v1 and kernel.branch.list is unpaginated.
  listBranches(input: { threadId: string }): Promise<BranchSummary[]>;

  getTurnState(input: {
    threadId: string;
    branchId: string;
    turnNodeHash?: HashString;
  }): Promise<TurnSnapshot>;

  getTurnHistory(
    input: { threadId: string; branchId: string },
    options?: { limit?: number; before?: TurnHistoryCursor },
  ): AsyncIterableIterator<TurnSnapshot>;

  readBranchMessages(input: {
    branchId: string;
    limit?: number;
    after?: BranchMessagesCursor;
  }): Promise<{ messages: TuvrenMessage[]; nextCursor?: BranchMessagesCursor }>;
}
