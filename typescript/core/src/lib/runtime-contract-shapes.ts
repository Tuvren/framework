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
  CapabilityPolicyEngine,
  ClientEndpointBoundary,
  ExecutionClass,
} from "./capability-shapes.js";
import type { HashString } from "./kernel-records.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ContextEngineeringHelpers,
  ContextEngineeringPlan,
  ContextManifest,
  ProviderMediatedToolConfig,
  ProviderNativeToolDeclaration,
  RenderedToolDefinition,
  StructuredOutputRequest,
  ToolCallPart,
  ToolResultPart,
  TuvrenJsonSchema,
  TuvrenMessage,
  TuvrenModelConfig,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "./runtime-data-contract-shapes.js";
import type {
  EventSource,
  TuvrenStreamEvent,
  ValidationErrorPayload,
} from "./runtime-event-contract-shapes.js";

/* oxlint-disable typescript/method-signature-style -- Preserve the frozen public method signatures and their method bivariance under strictFunctionTypes. */

/**
 * Selects which standard {@link HandoffContextBuilder} the framework applies
 * during a handoff (KrakenFrameworkSpecification §10.4): `"preserve_trace"`
 * rewrites history into a chronological summarized trace for the receiving
 * agent, `"last_output_only"` hands the receiving agent a clean-slate
 * request containing only the previous agent's final visible output, and
 * any other application-defined string selects a custom builder.
 */
export type HandoffContextMode =
  | "preserve_trace"
  | "last_output_only"
  // oxlint-disable-next-line typescript/ban-types -- Preserve the intentional open-string union without collapsing editor completion for known values.
  | (string & {});

/**
 * The read-only context a {@link HandoffContextBuilder} receives
 * (KrakenFrameworkSpecification §1.5, §10.4): the outgoing agent's message
 * history and manifest, the handoff intent (target agent, reason, optional
 * payload), both the source and target {@link AgentConfig}s, and the
 * {@link ContextEngineeringHelpers} for producing the receiving agent's new
 * message hashes.
 */
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

/**
 * Produces the complete replacement message-hash array for the receiving
 * agent during a handoff (KrakenFrameworkSpecification §1.5, §10.4). The
 * framework executes the builder during a dedicated handoff context
 * engineering Run, not at `RuntimeResolution` resolution time. The two
 * standard builders are `preserve_trace` (chronological summarized trace)
 * and `last_output_only` (clean-slate, final-output-only); see
 * {@link HandoffContextMode}.
 */
export type HandoffContextBuilder = (
  context: HandoffSourceContext
) => HashString[];

/**
 * The declarative handoff plan carried by `RuntimeResolution.handoff`
 * (KrakenFrameworkSpecification §1.5, §10.4). Bundles the target agent, the
 * human-facing `reason`, the selected {@link HandoffContextMode}, the
 * {@link HandoffContextBuilder} to run, and the {@link HandoffSourceContext}
 * it will run against.
 */
export interface HandoffContextPlan {
  builder: HandoffContextBuilder;
  mode: HandoffContextMode;
  reason: string;
  sourceContext: HandoffSourceContext;
  targetAgent: string;
}

/**
 * The exhaustive discriminated union of runtime control-flow outcomes
 * (KrakenFrameworkSpecification §1.5). The shared runner seam maps loop
 * policy, extension verdicts, handoff detection, and error handling into
 * this type. Resolution precedence when multiple sources produce a
 * resolution in the same iteration: `fail(hard) > pause > handoff >
 * end_turn > fail(soft) > continue_iteration`.
 */
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

/**
 * The outcome of validating a value against a {@link CustomSchema}
 * (KrakenFrameworkSpecification §8.2): either the successfully parsed
 * `value` or a {@link ValidationErrorPayload} describing why it failed.
 */
export type ValidationResult =
  | { valid: true; value: unknown }
  | { valid: false; error: ValidationErrorPayload };

/**
 * An executable schema alternative to a plain {@link TuvrenJsonSchema}
 * (KrakenFrameworkSpecification §8.2), used for tool `inputSchema` /
 * `outputSchema` when a bespoke validator is preferable to JSON Schema.
 * `toJSONSchema` renders the provider-facing projection; `validate` performs
 * the actual check.
 *
 * @see {@link isKrakenToolSchema} for the guard accepting either schema kind.
 */
export interface CustomSchema {
  toJSONSchema(): TuvrenJsonSchema;
  validate(input: unknown): ValidationResult;
}

/**
 * The declarative gate on a {@link TuvrenToolDefinition}
 * (KrakenFrameworkSpecification §8.4): a static boolean, or a per-invocation
 * predicate evaluated against the candidate `input` and execution context.
 * When `true` (or the function resolves `true`), the call is marked pending
 * approval. This is shorthand for the same gating the `aroundTool` chain
 * can trigger imperatively via a pause verdict.
 */
export type ApprovalPolicy =
  | boolean
  | ((
      input: unknown,
      context: ToolExecutionContext
    ) => boolean | Promise<boolean>);

/**
 * The context passed to a tool's `execute` function
 * (KrakenFrameworkSpecification §8.3). `emit`/`forward` are present only
 * when the tool executes within a streaming context: `emit` injects custom
 * events, `forward` injects source-attributed events for worker sub-agent
 * streaming (§6.7).
 */
export interface ToolExecutionContext {
  callId: string;
  emit?: (event: { name: string; data: unknown }) => void;
  forward?: (event: TuvrenStreamEvent, source: EventSource) => void;
  /**
   * Side-effect-once idempotency identity for this invocation (ADR-0052 as
   * amended by ADR-0065).
   *
   * A deterministic identity derived from the turn id and this call id — the
   * logical call identity. A tool that performs a non-idempotent external side
   * effect should thread this value into its external call so the external
   * system can deduplicate a dispatch it has already seen: every dispatch of one
   * logical call presents an identical key, whether it is the first attempt, a
   * framework retry, or a re-dispatch after an approval resume or a preemption
   * recovery. The `runId` and the run fencing token are deliberately excluded —
   * a Run is one execution attempt (freshly minted per iteration, per resume,
   * and per recovery) and the fencing token rotates on every lease renewal, so
   * either would make the identity churn under the very conditions it must
   * survive. Present whenever the runtime builds an execution context; tools
   * that do not perform external effects may ignore it.
   */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  name: string;
  signal?: AbortSignal;
}

/**
 * The signature every {@link TuvrenToolDefinition.execute} implements
 * (KrakenFrameworkSpecification §8.3): takes the validated `input` and the
 * per-invocation {@link ToolExecutionContext}, and returns the tool's raw
 * result (validated against `outputSchema`, if declared, before surfacing).
 */
/* oxlint-disable typescript/no-redundant-type-constituents -- Preserve the frozen sync-or-Promise callable spelling in the public API snapshot. */
export type ExecuteFunction = (
  input: unknown,
  context: ToolExecutionContext
) => Promise<unknown> | unknown;
/* oxlint-enable typescript/no-redundant-type-constituents */

/**
 * A model-callable, framework-executed tool
 * (KrakenFrameworkSpecification §8.1). `name` must be unique within the
 * active tool set; `inputSchema` and the optional `outputSchema` may be
 * either plain JSON Schema or an executable {@link CustomSchema}. The
 * remaining optional fields declare capability-orchestration policy
 * (approval, retry, residency, credential scopes, risk class — Epics AX/BB)
 * enforced by the runtime around `execute`.
 *
 * @see {@link isTuvrenToolDefinition} for the runtime guard.
 */
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
   *
   * After losing authority, a live owner does not retry a `nonRetryable` call,
   * but cold recovery redispatches a missing call once per recovery attempt
   * with its original call identity, so the tool must deduplicate on
   * `idempotencyKey`.
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

/**
 * The Turn-scoped identity and durability handle passed to a tool executor
 * batch (KrakenFrameworkSpecification §8.3, §8.6). The executor must call
 * `stageResult` immediately after producing each {@link ToolResultPart} so
 * completed results become durably recoverable before the whole batch
 * returns.
 */
export interface ToolDispatchContext {
  branchId: string;
  iterationCount: number;
  runId: string;
  stageResult(result: ToolResultPart): Promise<void>;
  turnId: string;
}

/**
 * The result of a tool executor batch (KrakenFrameworkSpecification §5.4,
 * §8.6): `approval: undefined` means every call in the batch executed;
 * `approval: ApprovalRequest` means the batch is partial, with `results`
 * from already-completed calls and the request describing the pending
 * remainder.
 */
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

/**
 * Alias for {@link TuvrenToolResultBatch} matching the `toolExecutor.execute`
 * return-type name used in KrakenFrameworkSpecification §5.4.
 */
export type ToolExecutionResult = TuvrenToolResultBatch;

/**
 * The Turn-scoped collection of registered tools
 * (KrakenFrameworkSpecification §8.5). Tools may be modified between Turns
 * but not during normal execution of an active agent segment; the active
 * registry is rebuilt on handoff. `toDefinitions` renders the provider-
 * facing projection for prompt assembly.
 */
export interface ToolRegistry {
  get(name: string): TuvrenToolDefinition | undefined;
  has(name: string): boolean;
  list(): TuvrenToolDefinition[];
  register(tool: TuvrenToolDefinition): void;
  toDefinitions(): RenderedToolDefinition[];
}

/**
 * The return type of the loop policy contract
 * (KrakenFrameworkSpecification §5.3), mapped into {@link RuntimeResolution}
 * during resolution composition. A tool-call response may only proceed with
 * `continue: true, executeTools: true`; other combinations paired with
 * executable tool calls are rejected as `invalid_loop_policy`.
 */
export interface IterationDecision {
  continue: boolean;
  executeTools: boolean;
  reason?: string;
}

/**
 * The no-op result of the context policy contract
 * (KrakenFrameworkSpecification §5.1), returned when no context
 * engineering action is needed this iteration. The alternative return value
 * is a {@link ContextEngineeringPlan}.
 */
export interface ContextPolicyResult {
  action: "none";
}

/**
 * The context policy contract (KrakenFrameworkSpecification §5.1), called
 * at the top of every iteration after `beforeIteration` hooks. `evaluate`
 * is O(1) via the manifest; the default implementation always returns
 * `{ action: "none" }`.
 */
export interface ContextPolicy {
  evaluate(
    manifest: ContextManifest,
    iterationCount: number
  ): ContextPolicyResult | ContextEngineeringPlan;
}

/**
 * The loop policy contract (KrakenFrameworkSpecification §5.3), evaluated
 * after each model response to decide whether the iteration loop continues
 * and whether requested tools should execute. Structured output does not
 * alter the default rules unless the policy is explicitly specialized.
 */
export interface LoopPolicy {
  evaluate(
    response: TuvrenModelResponse,
    manifest: ContextManifest,
    iterationCount: number
  ): IterationDecision;
}

/**
 * The context passed to a {@link SystemPromptFn}
 * (KrakenFrameworkSpecification §9.2): the extension's own persisted state,
 * other extensions' declared exports, the current manifest, and the
 * iteration count.
 */
export interface SystemPromptContext {
  extensionState: Record<string, unknown>;
  iterationCount: number;
  manifest: ContextManifest;
  sharedExports: Record<string, Record<string, unknown>>;
}

/**
 * A dynamic system-prompt contribution (KrakenFrameworkSpecification §9.2),
 * evaluated before each model call. Returning `undefined` means no
 * injection for that call. Contributions are transient — never persisted
 * in the messages path — and may invalidate provider KV cache if the
 * output varies between calls.
 */
export type SystemPromptFn = (
  context: SystemPromptContext
) => string | undefined;

/**
 * The base context shared by every extension handler
 * (KrakenFrameworkSpecification §9.3): the extension's own persisted
 * state, a read-only projection of other extensions' declared exports, the
 * current manifest and iteration count, and `emit` for injecting custom
 * events.
 */
export interface ExtensionContext {
  emit(event: { name: string; data: unknown }): void;
  extensionState: Record<string, unknown>;
  iterationCount: number;
  manifest: ContextManifest;
  sharedExports: Record<string, Record<string, unknown>>;
}

/**
 * The context passed to an {@link InterceptHandler}
 * (KrakenFrameworkSpecification §9.4): adds a read-only `messages` snapshot
 * and the active `runId`/`turnId` to {@link ExtensionContext}.
 */
export interface InterceptContext extends ExtensionContext {
  messages: TuvrenMessage[];
  runId: string;
  turnId: string;
}

/**
 * The verdict and state update an intercept hook may return
 * (KrakenFrameworkSpecification §9.4). `reason` is required when `verdict`
 * is `"endTurn"`; `error` is required when `verdict` is `"softFail"` or
 * `"hardFail"`. Verdicts compose into {@link RuntimeResolution} via its
 * documented precedence.
 */
export interface InterceptResult {
  error?: Error;
  reason?: string;
  state?: Record<string, unknown>;
  verdict?: "endTurn" | "softFail" | "hardFail";
}

/**
 * The signature shared by `beforeTurn` and `afterTurn` extension hooks
 * (KrakenFrameworkSpecification §9.4). Intercepts observe execution at
 * phase boundaries; they do not wrap execution and cannot call `next()`. A
 * thrown error is caught and treated as `fail(soft)`.
 */
export type InterceptHandler = (
  context: InterceptContext
) => InterceptResult | undefined | Promise<InterceptResult | undefined>;

/**
 * The `beforeIteration` hook's result (KrakenFrameworkSpecification §9.4),
 * extending {@link InterceptResult} with an optional `cePlan`. When
 * `cePlan` is returned, the framework executes it as a separate context
 * engineering Run before the iteration proceeds — this is the only hook
 * that can trigger context engineering.
 */
export interface BeforeIterationResult extends InterceptResult {
  cePlan?: ContextEngineeringPlan;
}

/** The `beforeIteration` extension hook signature (KrakenFrameworkSpecification §9.4). */
export type BeforeIterationHandler = (
  context: InterceptContext
) =>
  | BeforeIterationResult
  | undefined
  | Promise<BeforeIterationResult | undefined>;

/**
 * The context passed to an `afterIteration` hook
 * (KrakenFrameworkSpecification §9.4): adds the completed iteration's model
 * `response`, any `toolResults`, and the iteration's current `resolution`
 * to {@link InterceptContext}. Fires after checkpoint, so it sees the
 * complete iteration outcome including committed state.
 */
export interface AfterIterationContext extends InterceptContext {
  resolution: RuntimeResolution;
  response: TuvrenModelResponse;
  toolResults?: ToolResultPart[];
}

/** The `afterIteration` extension hook signature (KrakenFrameworkSpecification §9.4). */
export type AfterIterationHandler = (
  context: AfterIterationContext
) => InterceptResult | undefined | Promise<InterceptResult | undefined>;

/**
 * The context passed to an `aroundModel` handler
 * (KrakenFrameworkSpecification §9.5): `config`, `prompt`, and `tools` are
 * mutable — this is how tool filtering, prompt modification, and model
 * swapping work when passed to `next`.
 */
export interface AroundModelContext extends ExtensionContext {
  config: TuvrenModelConfig;
  messages: TuvrenMessage[];
  prompt: TuvrenPrompt;
  tools: RenderedToolDefinition[];
}

/**
 * The return type of an `aroundModel` handler
 * (KrakenFrameworkSpecification §9.5): either the bare
 * {@link TuvrenModelResponse}, or a wrapper carrying an additional `state`
 * update to merge into the iteration's pending extension updates.
 */
export type AroundModelResult =
  | TuvrenModelResponse
  | {
      response: TuvrenModelResponse;
      state?: Record<string, unknown>;
    };

/**
 * An around-hook wrapping the model call (KrakenFrameworkSpecification
 * §9.5). May call `next` zero times (short-circuit, e.g. cache hit), once
 * (normal), or multiple times (retry/fallback) — each `next()` call
 * produces its own streamed event sequence with a new `messageId`. Arounds
 * are ephemeral: they do not survive crashes and re-run from scratch on
 * recovery.
 */
export type AroundModelHandler = (
  context: AroundModelContext,
  next: (context?: AroundModelContext) => Promise<TuvrenModelResponse>
) => Promise<AroundModelResult> | AroundModelResult;

/**
 * The context passed to an `aroundTool` handler
 * (KrakenFrameworkSpecification §9.5): the target `tool`, its `toolCall`
 * and `input`, and `forward` for source-attributed worker sub-agent
 * streaming (§6.7). `approvalDecision` is present when resuming this exact
 * call after approval.
 */
export interface AroundToolContext extends ExtensionContext {
  approvalDecision?: ApprovalDecision;
  callId: string;
  forward(event: TuvrenStreamEvent, source: EventSource): void;
  input: unknown;
  tool: TuvrenToolDefinition;
  toolCall: ToolCallPart;
}

/**
 * The return type of an `aroundTool` handler (KrakenFrameworkSpecification
 * §9.5): the bare {@link ToolResultPart}, a wrapper carrying an additional
 * `state` update, or a pause verdict with an {@link ApprovalRequest} — the
 * same approval machinery as a tool's own `approval` field (§8.7).
 */
export type AroundToolResult =
  | ToolResultPart
  | { result: ToolResultPart; state?: Record<string, unknown> }
  | {
      verdict: "pause";
      approval: ApprovalRequest;
      state?: Record<string, unknown>;
    };

/**
 * An around-hook wrapping tool execution (KrakenFrameworkSpecification
 * §9.5). Unlike `aroundModel`, internal retries are invisible to the event
 * stream — the consumer still sees one `tool.start` and one `tool.result`
 * regardless of how many times `next()` is called.
 */
export type AroundToolHandler = (
  context: AroundToolContext,
  next: (context?: AroundToolContext) => Promise<ToolResultPart>
) => Promise<AroundToolResult> | AroundToolResult;

/**
 * An extension's `aroundTool` contribution (KrakenFrameworkSpecification
 * §9.5): either a bare handler applied to every tool call, or a handler
 * scoped to a specific `tools` name list.
 */
export type AroundToolSpec =
  | AroundToolHandler
  | { tools: string[]; handler: AroundToolHandler };

/**
 * A composable unit of cross-cutting agent behavior
 * (KrakenFrameworkSpecification §9.1). Combines contributions (`tools`,
 * `systemPrompt`, `exports`), persistent `state`, intercept hooks
 * (`beforeTurn`/`afterTurn`/`beforeIteration`/`afterIteration`), and around
 * hooks (`aroundModel`/`aroundTool`). Registered on an {@link AgentConfig}
 * before execution begins; registration order determines composition
 * order (§9.6).
 */
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

/**
 * The fixed-window rate-limit budget for the Tuvren-server execution class
 * (AX003), nested under {@link ServerExecutionConfig.rateLimit}.
 */
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

/**
 * Per-agent configuration for the Tuvren-server capability execution class
 * (AX003), set on {@link AgentConfig.serverExecution}.
 */
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

/**
 * Context handed to {@link AgentConfig.sanitizeToolResult} alongside the
 * would-be-staged {@link ToolResultPart}.
 *
 * `executionClass` is present only when the result came from a call whose
 * binding was resolved (`tuvren-server`, `tuvren-client`, `provider-native`,
 * `provider-mediated`) — it is absent for outcomes decided before dispatch
 * (unknown tool, input-validation failure, policy denial, resume rejection),
 * per ADR-0064 §3: those genuinely have no execution class, and a guessed one
 * would be worse than none. A policy scoped to remote-peer content branches
 * on `executionClass === "tuvren-client"`; a deny-by-default policy should
 * branch on absence explicitly rather than relying on a negative equality
 * test against a specific class.
 */
export interface SanitizeToolResultContext {
  /** The tool call this result answers. */
  callId: string;
  /** Present only for results whose execution class was resolved before this
   * hook ran; see the interface doc for the absence rule. */
  executionClass?: ExecutionClass;
  /** Name of the tool that produced (or would have produced) the result. */
  toolName: string;
}

/**
 * Shape of the host sanitization seam installed at
 * {@link AgentConfig.sanitizeToolResult} and threaded through to
 * `ToolBatchEnvironment.sanitizeToolResult` in `@tuvren/framework-runtime`.
 * Named once here so both sites (and any local variable that holds the
 * resolved hook) share a single alias instead of repeating the inline
 * function type. See {@link AgentConfig.sanitizeToolResult} for the full
 * contract (ADR-0064).
 */
export type SanitizeToolResultHook = (
  result: ToolResultPart,
  ctx: SanitizeToolResultContext
) => ToolResultPart;

/**
 * The static, per-agent configuration for a Turn
 * (KrakenFrameworkSpecification §10.1): model, system prompt, tools,
 * extensions, the pluggable policy contracts, capability-orchestration
 * inputs (Epics AX/AY/BB, ADR-0046, KRT-AZ001/AZ003), and execution limits.
 * Agent configs are static for the lifetime of the orchestration; on
 * handoff the framework swaps the active config and rebuilds the active
 * tool registry, extension composition, and renderer inputs from it.
 */
export interface AgentConfig {
  /**
   * Optional capability policy engine per ADR-0046 §4.21. When set, the
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
      /* oxlint-disable typescript/no-redundant-type-constituents -- Preserve the frozen sync-or-Promise sandbox callable spelling in the public API snapshot. */
      execute(
        input: unknown,
        context: ToolExecutionContext
      ): Promise<unknown> | unknown;
      /* oxlint-enable typescript/no-redundant-type-constituents */
    }
  >;
  /**
   * Host sanitization seam for tool-result content, ordered before durability
   * (ADR-0064). Applied inside `stageAndEmitResult` — the single chokepoint
   * shared by every execution class and every error path, including the
   * thrown-`err.message` conversion at the client-endpoint boundary — so the
   * value this hook returns is what is durably staged into kernel history
   * and equally what the canonical `tool.result` event carries. The
   * pre-sanitization form never reaches either. Runs before both; there is
   * no later point at which host policy can still matter.
   *
   * The framework guarantees only the seam and its ordering, never content
   * inspection: no default redaction, no pattern matching, no key
   * heuristics. A host that installs nothing observes byte-identical
   * behavior to today. Hosts scope a policy to remote-peer content by
   * checking `ctx.executionClass === "tuvren-client"` (see
   * {@link SanitizeToolResultContext}).
   *
   * The hook is synchronous and total: it must return a {@link ToolResultPart}
   * and cannot defer, reject, or fail the call — deciding whether a call
   * proceeds is the approval seam's job, not this one. A hook that throws is
   * treated as a tool failure, not a turn failure (the framework spec §8.6
   * precedent that tool failures become results rather than aborting the
   * run): the call's result becomes an `isError: true` result carrying
   * `output.code: "tool_result_sanitization_failed"`, and the turn continues.
   *
   * See `spec/host/client-endpoint-integration.md` ("Durable Lineage Is
   * Forever") and ADR-0064 for the full decision record.
   */
  sanitizeToolResult?: SanitizeToolResultHook;
  /**
   * Server execution class configuration for this agent. Controls per-tenant
   * rate limiting of Tuvren-server invocations. (AX003)
   */
  serverExecution?: ServerExecutionConfig;
  systemPrompt?: string;
  tools?: TuvrenToolDefinition[];
}

/* oxlint-enable typescript/method-signature-style */
