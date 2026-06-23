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

import type {
  AttachedClientEndpoint,
  CapabilityInvocationAttribution,
  CapabilityPolicyEngine,
  ClientEndpointBoundary,
  ExecutionClass,
} from "./capability-shapes.js";
import type { EpochMs, HashString } from "./kernel-records.js";
import type { ErasedPayload } from "./payload-codec.js";
import type { TuvrenError } from "./tuvren-error.js";

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

/** Provider-native tool declaration: the provider owns execution. (AY002) */
export interface ProviderNativeToolDeclaration {
  /** Provider-specific configuration arguments (non-secret) */
  args?: Record<string, unknown>;
  /** Tuvren capability ID for attribution; falls back to name if absent */
  capabilityId?: string;
  /** Provider-owned tool ID: "{provider}.{tool-name}" e.g. "anthropic.code_execution_20260120" */
  id: string;
  /** Model-facing tool name (unique among all tools in the prompt) */
  name: string;
}

/** Provider-mediated tool config: developer supplies the endpoint; provider invokes it. (AY004) */
export interface ProviderMediatedToolConfig {
  /** Tuvren capability ID for attribution; falls back to name if absent */
  capabilityId?: string;
  /** Developer-provided endpoint URL or connector reference (non-secret connection config) */
  endpoint: string;
  /** Mediation type — "mcp" is the initial supported type (provider-invoked remote MCP) */
  mediationType: "mcp";
  /** Model-facing tool name */
  name: string;
  /** Provider-specific options (e.g. headers; must not carry auth secrets inline) */
  providerOptions?: Record<string, unknown>;
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
  /**
   * Non-secret provider continuity artifacts for multi-turn operation. (AY005)
   * Must follow the provider-namespaced shape required by SharedV3ProviderOptions:
   * `{ [providerNamespace]: Record<string, unknown> }` (e.g. `{ anthropic: { sessionId } }`).
   * Flat top-level values are not supported and will throw at the bridge edge.
   */
  providerContinuity?: Record<string, unknown>;
  /** Provider-mediated tools: provider invokes developer endpoint. (AY004) */
  providerMediatedTools?: ProviderMediatedToolConfig[];
  /** Provider-native tools: provider owns execution; Tuvren enables/configures. (AY002) */
  providerNativeTools?: ProviderNativeToolDeclaration[];
  responseFormat?: StructuredOutputRequest;
  /**
   * Cooperative cancellation signal threaded into the provider call so the
   * framework-enforced execution bounds guard (ADR-043) can abort an in-flight
   * model request when `maxWallClockMs` is reached. Non-secret and
   * non-serializable: it is carried out-of-band by the TypeScript binding and
   * never appears in the JSON payload. Owned bridges must forward it to the
   * underlying provider call; a provider that ignores it may keep running, but
   * any late completion is discarded by the runtime.
   */
  signal?: AbortSignal;
  /** Function-style tools that Tuvren executes (tuvren-server class) */
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
      /** Provider-native/mediated tool result from a declared provider tool. (AY003) */
      type: "provider_tool_result";
      providerCallId: string;
      name: string;
      result: unknown;
      isError?: boolean;
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

/** Record of a single provider-native or provider-mediated invocation result. (AY002/AY004) */
export interface ProviderNativeInvocationRecord {
  callId: string;
  executionClass: "provider-native" | "provider-mediated";
  isError?: boolean;
  name: string;
  providerCallId: string;
  providerMetadata?: Record<string, unknown>;
  result: unknown;
}

export interface TuvrenModelResponse {
  finishReason: "stop" | "tool_call" | "length" | "error" | "content_filter";
  parts: ContentPart[];
  providerMetadata?: Record<string, unknown>;
  /**
   * Provider-native and provider-mediated invocation records. These are
   * separate from `parts` so they do not contaminate the model-facing content
   * flow and the framework never routes them through the Tool Execution Gateway.
   * The driver processes these into pre-staged tool results. (AY002/AY004)
   */
  providerToolResults?: ProviderNativeInvocationRecord[];
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
  /** Additive per ADR-046 AW006: execution-class and owner attribution. */
  attribution?: CapabilityInvocationAttribution;
  callId: string;
  input: unknown;
  name: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool.start";
}

export interface ToolResultEvent {
  /** Additive per ADR-046 AW006: execution-class and owner attribution. */
  attribution?: CapabilityInvocationAttribution;
  callId: string;
  isError?: boolean;
  name: string;
  output: unknown;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool.result";
}

/**
 * Lifecycle audit event for Tuvren-server invocations. Carries only structural
 * lineage keys and lifecycle identifiers — no input, output, or metadata values
 * that could contain secret material. (AX005)
 */
export interface ToolAuditEvent {
  /** Retry attempt number (1-based), present when lifecycle is retry_attempt. */
  attempt?: number;
  /** Unique call identifier matching the tool_call / tool_result pair. */
  callId: string;
  /** Stable tool name; used as the capability id for tuvren-server bindings. */
  capabilityId: string;
  executionClass: ExecutionClass;
  /**
   * Which lifecycle point this event records.
   * "cancelled" is reserved for future use when cooperative cancellation
   * emits an explicit audit signal; currently observable via handle.cancel()
   * + the existing event stream (canCancel: true in CapabilityObservation).
   */
  lifecycle:
    | "input_validated"
    | "output_validated"
    | "policy_denied"
    | "retry_attempt"
    | "rate_limited"
    | "cancelled";
  runId: string;
  source?: EventSource;
  timestamp: EpochMs;
  turnId: string;
  type: "tool.audit";
  /** Whether the validation passed, present for input_validated / output_validated. */
  validationPassed?: boolean;
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
  | ToolAuditEvent
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
  /**
   * Side-effect-once idempotency identity for this invocation (ADR-052).
   *
   * A deterministic identity derived from the run id, this call id, and the
   * active run fencing token. A tool that performs a non-idempotent external
   * side effect should thread this value into its external call so the external
   * system can deduplicate a dispatch that is retried or re-issued after a
   * preemption recovery. Present whenever the runtime builds an execution
   * context; tools that do not perform external effects may ignore it.
   */
  idempotencyKey?: string;
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
  /**
   * Whether the framework may retry this invocation on a retriable failure. (AX002)
   * When true, the entire aroundTool extension chain re-executes on each attempt,
   * not just the terminal tool.execute call. Extension authors should account for
   * this when writing aroundTool handlers with side effects.
   *
   * Thrown vs returned errors: only thrown exceptions trigger the retry loop.
   * A tool that returns { isError: true } is treated as a deliberate value and
   * is never retried, even when idempotent is true.
   */
  idempotent?: boolean;
  inputSchema: TuvrenJsonSchema | CustomSchema;
  /**
   * Maximum retry attempts when idempotent is true. Defaults to 1. (AX002)
   * Must be a non-negative integer. This value is trusted and not runtime-validated.
   * A negative value causes maxAttempts (= 1 + maxRetries) to be zero, so the
   * tool's execute is never invoked and an execution-failure result is returned.
   * Use 0 for one attempt with no retry; omit to get the default of 1 retry.
   */
  maxRetries?: number;
  metadata?: Record<string, unknown>;
  name: string;
  /**
   * When true, the framework must not retry this capability even when
   * idempotent is true. Overrides the tool-level idempotency opt-in for the
   * retry budget. BB004.
   */
  nonRetryable?: boolean;
  /**
   * Declared result shape validated against the execute return value before
   * surfacing. Violations surface as tool.result with isError true and
   * code tool_result_validation_failed. (AX001)
   *
   * Note: validation applies to the terminal execute/sandbox result only.
   * An aroundTool extension that short-circuits by returning its own result
   * without calling next() bypasses outputSchema enforcement, since extensions
   * are trusted host-side code and output-validation runs in the terminal branch.
   *
   * Retry interaction: an output-validation failure is not retried even when
   * idempotent is true. Output-contract violations are deterministic — retrying
   * the same execute function against the same schema cannot produce a different
   * structural result — so the framework surfaces the validation error immediately
   * rather than consuming the retry budget.
   */
  outputSchema?: TuvrenJsonSchema | CustomSchema;
  /**
   * Credential scopes required for this capability's invocation. The invocation
   * is denied when not all listed scopes are in the policy context's
   * availableCredentialScopes. BB004.
   */
  requiredCredentialScopes?: readonly string[];
  // ── BB001–BB004: capability policy fields ────────────────────────────────
  /**
   * Data residency zone that this tool's binding processes data in. The
   * runtime enforces that invocations are only admitted when the residency is
   * in the policy context's allowedResidencies. BB001.
   */
  requiredResidency?: string;
  /**
   * Whether explicit user presence is required at invocation time. When true
   * and the policy context's userPresent is false, the invocation is denied.
   * BB003.
   */
  requiresUserPresence?: boolean;
  /**
   * Risk classification for this capability. The runtime uses this to drive
   * exposure and invocation policy (e.g. requiring approval for high-risk
   * capabilities). BB002.
   */
  riskClass?: "low" | "medium" | "high";
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

export interface ServerExecutionRateLimitConfig {
  /**
   * Maximum invocations allowed within windowMs.
   * Must be a non-negative integer; zero immediately rejects all calls.
   * This value is trusted and not runtime-validated — a negative value would
   * behave as an unbounded budget due to the callCount >= maxCalls comparison.
   *
   * Note: an idempotent tool retry consumes exactly one budget slot for the
   * entire invocation regardless of how many retry attempts occur, because the
   * rate-limit check runs once in resolveExecutableToolCall before the retry loop.
   */
  maxCalls: number;
  /**
   * Fixed-window duration in milliseconds, measured within a single turn.
   * The rate-limit budget is scoped to one executeTurn call: a new turn always
   * starts with a fresh budget. Use maxCalls to cap per-turn invocations;
   * windowMs controls the reset interval within that turn for long-running
   * turns with tool calls spread over time.
   *
   * Note: an approval pause/resume creates a new execution session internally;
   * the budget does not persist across the pause boundary, so an approval-gated
   * turn consumes a slot on the pre-pause segment and gets a fresh budget on
   * the resumed segment.
   */
  windowMs: number;
}

export interface ServerExecutionConfig {
  /**
   * Per-turn rate limit for the Tuvren-server execution class.
   * Invocations beyond the budget within the configured window are rejected
   * with a typed tool_invocation_rate_limited result rather than executed.
   * Scope: one executeTurn call — the budget resets between turns.
   * Tenant isolation: each runtime instance has an independent budget. (AX003)
   *
   * Multi-agent handoff note: the rate limiter is created once per turn from
   * the initiating agent's serverExecution config and cached for the turn's
   * lifetime. If the active agent changes via handoff, the cached limiter is
   * not updated — the budget follows the turn's first agent regardless of
   * subsequent handoffs. Configure rate limits on the entry-point agent when
   * applying per-turn caps in multi-agent flows.
   */
  rateLimit?: ServerExecutionRateLimitConfig;
}

/**
 * Host-configurable inputs to the Capability Policy Context for the wired
 * exposure-time and invocation-time policy checks. These session-level values
 * are injected into the CapabilityPolicyContext that the runtime assembles
 * before each engine call. All fields are optional; omitted fields are absent
 * in the context (which means the corresponding policy dimension does not
 * apply). Added in Epic BB.
 */
export interface CapabilityPolicyContextInputs {
  /** Allowed data-residency zones for this agent's turns. BB001. */
  allowedResidencies?: readonly string[];
  /**
   * Credential scopes available in this agent's invocation context. BB004.
   * The runtime passes these to the engine; a capability whose
   * requiredCredentialScopes are not all present here is denied.
   */
  availableCredentialScopes?: readonly string[];
  /**
   * Whether a user is actively present in this session. BB003.
   * Capabilities that declare requiresUserPresence are denied at invocation
   * when this is explicitly false. Absent (undefined) is treated as unknown
   * and admits the invocation.
   */
  userPresent?: boolean;
}

export interface AgentConfig {
  /**
   * Optional capability policy engine per ADR-046 §4.21. When set, the
   * framework evaluates exposure-time and invocation-time policy; denied
   * invocations surface as `tool.result` with `isError: true`. When absent,
   * all invocations are admitted. Exposure filtering is active in Epic BB.
   */
  capabilityPolicyEngine?: CapabilityPolicyEngine;
  /**
   * Optional pre-built ClientEndpointBoundary for this agent.
   *
   * When set, the runtime uses this boundary directly instead of creating one
   * from `clientEndpoints`. Use this escape hatch when the host needs to
   * manage endpoint lifecycle explicitly — for example, to call `detach()` on
   * the boundary after it was constructed so that subsequent invocations yield
   * `capability_binding_unavailable` rather than dispatching. Useful for
   * conformance tests and host scenarios where endpoints become unavailable
   * after turn start. (KRT-AZ001, KRT-AZ003)
   *
   * If both `clientEndpoints` and `clientEndpointBoundary` are set,
   * `clientEndpointBoundary` takes precedence for dispatch; `clientEndpoints`
   * is still used to register the advertised capabilities in the tool registry
   * (so the model can still "see" the capabilities even if the endpoint is
   * unavailable at invocation time).
   */
  clientEndpointBoundary?: ClientEndpointBoundary;
  /**
   * Attached client endpoints for this agent. Each endpoint advertises the
   * capabilities it can execute (on behalf of the runtime, in a client
   * environment such as a browser extension, desktop app, or device agent).
   *
   * The runtime registers each advertised capability as a tuvren-client
   * binding and dispatches matching tool calls to the endpoint via an
   * invocation envelope. No client credentials or environment secrets should
   * appear in the envelope or the reported result — they stay at the client edge.
   *
   * Concrete client endpoints are host-developer deliverables. The runtime
   * only needs this interface to orchestrate, lease, and observe client-side
   * execution. (KRT-AZ001)
   */
  clientEndpoints?: AttachedClientEndpoint[];
  contextPolicy?: ContextPolicy;
  extensions?: TuvrenExtension[];
  loopPolicy?: LoopPolicy;
  maxIterations?: number;
  maxParallelToolCalls?: number;
  model?: string | TuvrenProvider;
  name: string;
  /**
   * Host-configurable inputs to the Capability Policy Context. The runtime
   * uses these to populate the CapabilityPolicyContext for both the
   * exposure-time and invocation-time engine calls. Omitting this field means
   * the corresponding BB policy dimensions (residency, presence, credential
   * boundary) are not evaluated for this agent's turns. BB001–BB004.
   */
  policyContextInputs?: CapabilityPolicyContextInputs;
  /**
   * Provider-mediated tool configurations for this agent. The developer
   * supplies the endpoint; the provider invokes it. (AY004)
   *
   * Provider tool names may overlap with `tools` entries for test-harness
   * purposes (e.g. to prove the local executor is never called). In production
   * usage, names should be kept distinct: a conforming provider returns a
   * tool-result for provider tools (routed to pre-staged messages, never
   * dispatched to the Tool Execution Gateway), but a misbehaving provider
   * returning a tool-call for the same name would reach the local executor.
   */
  providerMediatedTools?: ProviderMediatedToolConfig[];
  /**
   * Provider-native tool declarations for this agent. The provider owns
   * execution; Tuvren enables/configures the surface and records provider-
   * exposed events/results only. Policy is applied before the request is sent.
   * (AY002)
   *
   * See `providerMediatedTools` for the name-collision invariant note.
   */
  providerNativeTools?: ProviderNativeToolDeclaration[];
  responseFormat?: StructuredOutputRequest;
  /**
   * Host-provided sandbox executors keyed by endpoint id. When a tool
   * declares metadata.sandbox.endpointId, the framework looks up the executor
   * here and dispatches the invocation to it instead of tool.execute. This
   * gives the host full control over the isolation boundary (subprocess, VM,
   * container, etc.) while the framework owns lifecycle observation, retry,
   * cancellation, and audit. (AX004)
   *
   * The executor receives `(input: unknown, context: ToolExecutionContext)`.
   * Cast to TuvrenSandboxExecutor from @tuvren/core/capabilities for the typed
   * interface.
   */
  sandboxExecutors?: Map<
    string,
    {
      execute(
        input: unknown,
        context: ToolExecutionContext
      ): Promise<unknown> | unknown;
    }
  >;
  /**
   * Server execution class configuration for this agent. Controls per-tenant
   * rate limiting of Tuvren-server invocations. (AX003)
   */
  serverExecution?: ServerExecutionConfig;
  systemPrompt?: string;
  tools?: TuvrenToolDefinition[];
}

/**
 * The hard-stop execution bounds whose breach finalizes a turn as `failed`.
 * `maxConcurrentToolCalls` is intentionally excluded: it is a concurrency
 * throttle, not a terminal bound. (ADR-043 §3.11)
 */
export type ExecutionBoundKind =
  | "maxIterations"
  | "maxToolCalls"
  | "maxWallClockMs";

/**
 * Framework-enforced per-turn execution bounds (ADR-043 §3.11), applied above
 * the driver's own loop policy so a misbehaving or adversarial driver cannot
 * run a turn unbounded. Configured per runtime instance via
 * `createTuvren({ bounds })` / `RuntimeCoreOptions.bounds`. Unset fields take
 * the documented safe defaults; every configured bound must be a finite
 * positive integer. A driver cannot raise or disable a bound.
 */
export interface ExecutionBounds {
  /** Maximum concurrent tool calls (throttle, not a terminal bound). Default 16. */
  maxConcurrentToolCalls?: number;
  /** Maximum ReAct iterations per turn. Default 64. */
  maxIterations?: number;
  /** Maximum cumulative tool calls per turn. Default 256. */
  maxToolCalls?: number;
  /** End-to-end wall-clock deadline in milliseconds. Default 600_000. */
  maxWallClockMs?: number;
}

/**
 * Details carried by the `execution_bound_exceeded` `TuvrenRuntimeError`, the
 * fatal canonical `error` event, and the bounded-execution telemetry event when
 * a hard-stop bound is breached. (ADR-043)
 */
export interface ExecutionBoundExceededDetails {
  /** Which hard-stop bound was breached. */
  bound: ExecutionBoundKind;
  /** The configured limit for the breached bound. */
  limit: number;
  /** The observed value at breach time. */
  observed: number;
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
  awaitResult(): Promise<ExecutionResult>;
  cancel(): void;
  events(): AsyncIterable<TuvrenStreamEvent>;
  resolveApproval(response: ApprovalResponse): ExecutionHandle;
  status(): ExecutionStatus;
  steer(signal: InputSignal): void;
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
  createdAtMs: EpochMs;
  rootTurnNodeHash: HashString;
  schemaId: string;
  threadId: string;
}

export interface BranchSummary {
  branchId: string;
  headTurnNodeHash: HashString;
  threadId: string;
}

export interface TurnSnapshot {
  eventHash: HashString | null;
  manifest: ContextManifest | null;
  paths: Record<string, HashString[] | HashString | null>;
  previousTurnNodeHash: HashString | null;
  schemaId: string;
  turnNodeHash: HashString;
  turnTreeHash: HashString;
}

export type ListThreadsCursor = string; // opaque to host; see TechSpec §3.8
export type TurnHistoryCursor = string; // opaque to host; see TechSpec §3.8
export type BranchMessagesCursor = string; // opaque to host; see TechSpec §3.8

/**
 * Host-facing projection of the kernel reclamation summary (kernel spec §9.4;
 * cross-language authority: `@tuvren/kernel-protocol` `ReclamationSummary`).
 * Counts the durable state released and retained within the runtime's bound
 * Scope by a reachability reclamation sweep. The framework returns the kernel's
 * summary unchanged, so the two shapes are intentionally identical.
 */
export interface ReclamationSummary {
  releasedArchivedBranchCount: number;
  releasedObjectCount: number;
  releasedOrderedPathChunkCount: number;
  releasedRunCount: number;
  releasedTurnCount: number;
  releasedTurnNodeCount: number;
  releasedTurnTreeCount: number;
  retainedObjectCount: number;
}

/**
 * Host-facing data-lifecycle maintenance surface (ADR-051; architecture flow
 * §4.17). The runtime owns the mechanism only; the host owns retention policy
 * and key custody. Erasure (right-to-erasure / crypto-shredding) is the host
 * destroying a Scope's payload-encryption keys on its own keyring — never a
 * runtime call, since the runtime never holds keys.
 */
export interface RuntimeMaintenance {
  /**
   * Drops the bound Scope's entire durable partition for full tenant
   * offboarding (architecture flow §4.17). Unlike `reclaim`, this removes all of
   * the Scope's state, not only the unreachable remainder. Per kernel spec §9.4
   * this is a substrate concern outside the kernel syscall surface, so it is
   * driven directly against the durable backend rather than through a kernel
   * operation. Crypto-shredding erasure remains the host destroying the Scope's
   * payload keys; this call removes the residual ciphertext partition. Rejects
   * when the runtime does not own a backend that supports partition drop (for
   * example when constructed with an externally-supplied kernel).
   */
  purgeScope(): Promise<void>;
  /**
   * Drives capability-gated reachability reclamation (kernel spec §9.4) for the
   * runtime's bound Scope: releases durable state unreachable from live roots
   * (non-archived branch heads, thread roots, active-run staged work),
   * grace-windowed against the oldest active execution lease so it can never
   * race recovery. Rejects with a persistence error when the backend does not
   * advertise `maintenance.reclamation`. The host decides when (and whether) to
   * call it; the runtime supplies no retention policy.
   */
  reclaim(options?: { nowMs?: EpochMs }): Promise<ReclamationSummary>;
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

  getTurnHistory(
    input: { threadId: string; branchId: string },
    options?: { limit?: number; before?: TurnHistoryCursor }
  ): AsyncIterableIterator<TurnSnapshot>;

  getTurnState(input: {
    threadId: string;
    branchId: string;
    turnNodeHash?: HashString;
  }): Promise<TurnSnapshot>;

  // listBranches is intentionally unbounded: branches per thread are bounded
  // by O(1) active divergence paths in v1 and kernel.branch.list is unpaginated.
  listBranches(input: { threadId: string }): Promise<BranchSummary[]>;

  // ── Durable-Read Surface (ADR-036) ──────────────────────────────────────
  listThreads(options?: {
    limit?: number;
    cursor?: ListThreadsCursor;
    filter?: { schemaId?: string };
  }): Promise<{ threads: ThreadSummary[]; nextCursor?: ListThreadsCursor }>;

  // ── Data-Lifecycle Maintenance Surface (ADR-051, §4.17) ─────────────────
  // Host-facing reclamation + tenant-offboarding mechanism. Retention policy
  // and key custody stay host-owned.
  maintenance: RuntimeMaintenance;

  // A reclaimed/crypto-shredded message (ADR-051, KRT-BF005) surfaces as a typed
  // `ErasedPayload` marker (distinguished by `kind: "erased"`) instead of a
  // decoded message, so the read stays total and the lineage hash structure
  // referencing it is unchanged.
  readBranchMessages(input: {
    branchId: string;
    limit?: number;
    after?: BranchMessagesCursor;
  }): Promise<{
    messages: (ErasedPayload | TuvrenMessage)[];
    nextCursor?: BranchMessagesCursor;
  }>;
  setBranchHead(input: {
    branchId: string;
    turnNodeHash: HashString;
  }): Promise<{
    branchId: string;
    headTurnNodeHash: HashString;
    archiveBranchId?: string;
  }>;
}
