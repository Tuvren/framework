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

/**
 * A JSON-serializable value at the shared contract seam: `null`, booleans,
 * numbers, strings, and acyclic arrays/objects thereof.
 *
 * @see {@link isSerializableContractValue} for the runtime guard.
 */
export type TuvrenJsonValue =
  | null
  | boolean
  | number
  | string
  | TuvrenJsonValue[]
  | { [key: string]: TuvrenJsonValue };
/**
 * A JSON Schema document at the shared contract seam: either a boolean
 * schema (`true`/`false` always-match/never-match) or a JSON-serializable
 * plain object of schema keywords.
 *
 * @see {@link isTuvrenJsonSchema} for the structural validator.
 */
export type TuvrenJsonSchema = { [key: string]: TuvrenJsonValue } | boolean;
/**
 * The operator's disposition for a single pending tool call in an
 * {@link ApprovalResponse} (KrakenFrameworkSpecification §1.7):
 * `"approve"` executes with the original input, `"edit"` executes with
 * `ApprovalDecision.editedInput`, `"reject"` produces an error
 * `ToolResultPart`, and any other application-defined string is treated as a
 * reject with the decision type and message surfaced to the model.
 */
export type ApprovalDecisionType =
  | "approve"
  | "edit"
  | "reject"
  | (string & {});
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
  | (string & {});

/** Freeform assistant/user text content (KrakenFrameworkSpecification §1.1). */
export interface TextPart {
  providerMetadata?: Record<string, unknown>;
  text: string;
  type: "text";
}

/**
 * Model reasoning/thinking content (KrakenFrameworkSpecification §1.1).
 * `text` may be empty when `redacted` is `true`; a non-redacted
 * reasoning part must carry non-empty text. Provider-native continuity
 * tokens (e.g. Anthropic's `signature`) live in `providerMetadata`.
 */
export interface ReasoningPart {
  providerMetadata?: Record<string, unknown>;
  redacted: boolean;
  text: string;
  type: "reasoning";
}

/**
 * A model-requested tool invocation (KrakenFrameworkSpecification §1.1).
 * `callId` is framework-generated and links this part to the resulting
 * {@link ToolResultPart}; provider-native call IDs are preserved in
 * `providerMetadata` instead. `input` is always the parsed argument value,
 * never a raw JSON string.
 */
export interface ToolCallPart {
  callId: string;
  input: unknown;
  name: string;
  providerMetadata?: Record<string, unknown>;
  type: "tool_call";
}

/**
 * The outcome of executing a {@link ToolCallPart} (KrakenFrameworkSpecification
 * §1.1). `callId` matches the originating call; `isError` marks a
 * deliberate failure result rather than a framework-level error.
 */
export interface ToolResultPart {
  callId: string;
  isError?: boolean;
  name: string;
  output: unknown;
  providerMetadata?: Record<string, unknown>;
  type: "tool_result";
}

/**
 * Binary or base64 file content (KrakenFrameworkSpecification §1.1).
 * `mediaType` is an IANA media type and `data` is either a base64 string or
 * raw `Uint8Array`, depending on the producing adapter.
 */
export interface FilePart {
  data: string | Uint8Array;
  filename?: string;
  mediaType: string;
  providerMetadata?: Record<string, unknown>;
  type: "file";
}

/**
 * Model-authored structured output conforming to a requested schema
 * (KrakenFrameworkSpecification §1.1, §3.5). `data` is always the parsed
 * result, never a raw string; `name` carries the schema identifier from the
 * originating {@link StructuredOutputRequest} when present. Distinct from a
 * tool call: it carries no executable side effects and requires no result.
 */
export interface StructuredPart {
  data: unknown;
  name?: string;
  providerMetadata?: Record<string, unknown>;
  type: "structured";
}

type NonEmptyArray<T> = [T, ...T[]];

/**
 * The atomic unit of conversational content: a strict discriminated union
 * on `type` over every content kind the framework carries
 * (KrakenFrameworkSpecification §1.1). One type per part — no
 * bag-of-optional-fields — so each variant's exact key set is independently
 * validated by {@link isContentPart}.
 */
export type ContentPart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | FilePart
  | StructuredPart;

/**
 * A durable conversation message, discriminated by `role`
 * (KrakenFrameworkSpecification §1.2). `tool` is a role distinct from
 * `user` even though some providers merge tool results into user messages —
 * each provider adapter handles the merge or split at its own boundary.
 *
 * @see {@link isTuvrenMessage} for the runtime guard.
 */
export type TuvrenMessage =
  | { role: "system"; content: string }
  | { role: "user"; parts: NonEmptyArray<ContentPart> }
  | {
      role: "assistant";
      parts: NonEmptyArray<ContentPart>;
      providerMetadata?: Record<string, unknown>;
    }
  | { role: "tool"; parts: NonEmptyArray<ToolResultPart> };

/**
 * The canonical inbound signal accepted by the framework and its runners
 * (KrakenFrameworkSpecification §1.3). Not itself a persisted message — the
 * framework normalizes it into a {@link TuvrenMessage} during input
 * incorporation. An empty `parts` array is invalid at the shared contract
 * boundary.
 */
export interface InputSignal {
  parts: NonEmptyArray<ContentPart>;
}

/**
 * The provider-facing projection of a runtime tool definition
 * (KrakenFrameworkSpecification §1.4). Runtime executable tool definitions
 * (with `execute`, policy fields, etc.) never cross the provider prompt
 * boundary; only this reduced shape does.
 */
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

/**
 * Model selection and provider settings carried on a {@link TuvrenPrompt}
 * (KrakenFrameworkSpecification §1.4). `model` and `provider` are adapter-
 * facing identifiers; `settings` is an opaque, provider-specific options
 * bag.
 */
export interface TuvrenModelConfig {
  model?: string;
  provider?: string;
  settings?: Record<string, unknown>;
}

/**
 * The provider-neutral request for schema-constrained model output
 * (KrakenFrameworkSpecification §1.4, §3.5). `schema` is the JSON Schema
 * the response must satisfy (draft-07 by default; declare `schema.$schema`
 * to select draft-2019-09 or draft-2020-12). `name` is an optional
 * identifier mapped to provider-native name fields where applicable.
 * `strict` is an enforcement hint honored by providers with native
 * structured-output enforcement; the framework validates the result
 * regardless.
 */
export interface StructuredOutputRequest {
  name?: string;
  schema: TuvrenJsonSchema;
  strict?: boolean;
}

/**
 * The provider-neutral model request assembled by the renderer contract
 * (KrakenFrameworkSpecification §1.4, §5.2) and passed to
 * {@link TuvrenProvider.generate}/`stream`.
 */
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

/** Token accounting for a model call (KrakenFrameworkSpecification §1.4). */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The normalized intermediate type yielded by {@link TuvrenProvider.stream}
 * (KrakenFrameworkSpecification §3.2). Carries content deltas and tool-call
 * fragments without framework identity — the provider never generates
 * `messageId` or `timestamp`; those are runner concerns assigned when the
 * runner maps each chunk to a {@link TuvrenStreamEvent}. `providerCallId` is
 * the provider's native tool-call ID (e.g. Anthropic's `toolu_...`, OpenAI's
 * `call_...`); the runner maps it to a framework-generated `callId` and
 * preserves the provider ID in `providerMetadata` on the resulting part.
 *
 * @see {@link isProviderStreamChunk} for the runtime guard.
 */
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

/**
 * The complete, non-streaming model response consumed by the loop policy,
 * `aroundModel` chain, and durable staging (KrakenFrameworkSpecification
 * §1.4). Produced either directly by {@link TuvrenProvider.generate} or by
 * accumulating a {@link ProviderStreamChunk} sequence via the
 * StreamAccumulator (§3.3).
 *
 * @see {@link isTuvrenModelResponse} for the runtime guard.
 */
export interface TuvrenModelResponse {
  finishReason: "stop" | "tool_call" | "length" | "error" | "content_filter";
  parts: ContentPart[];
  providerMetadata?: Record<string, unknown>;
  /**
   * Provider-native and provider-mediated invocation records. These are
   * separate from `parts` so they do not contaminate the model-facing content
   * flow and the framework never routes them through the Tool Execution Gateway.
   * The runner processes these into pre-staged tool results. (AY002/AY004)
   */
  providerToolResults?: ProviderNativeInvocationRecord[];
  usage?: ProviderUsage;
}

/**
 * The adapter seam every model backend implements
 * (KrakenFrameworkSpecification §3.1). `generate` returns a complete
 * response; `stream` yields normalized intermediate chunks. Authentication,
 * retry, rate limiting, timeout, and HTTP configuration are internal to
 * each adapter and never surface at this interface. The provider never
 * generates framework execution identity (`messageId`, `timestamp`) — those
 * are runner concerns.
 */
export interface TuvrenProvider {
  generate(prompt: TuvrenPrompt): Promise<TuvrenModelResponse>;
  readonly id: string;
  stream(prompt: TuvrenPrompt): AsyncIterable<ProviderStreamChunk>;
}

/**
 * Per-role message counts on a {@link ContextManifest}
 * (KrakenFrameworkSpecification §1.6). Sums must equal `messageCount`; see
 * {@link isContextManifest} for the enforced invariant.
 */
export interface ContextManifestCounters {
  assistant: number;
  system: number;
  tool: number;
  user: number;
}

/**
 * A named-count aggregate used for the {@link ContextManifest} `toolCalls`
 * and `toolResults` indexes (KrakenFrameworkSpecification §1.6). `total`
 * must equal the sum of `byName`'s values.
 */
export interface ContextManifestNameCounters {
  byName: Record<string, number>;
  total: number;
}

/**
 * A lightweight, O(1)-queryable index over the active conversation, staged
 * alongside messages on every checkpoint (KrakenFrameworkSpecification
 * §1.6). Context engineering and loop policies read this instead of
 * scanning the full message history. `extensions` holds extension-owned
 * persisted namespaces; the core manifest never reads that data itself.
 *
 * @see {@link isContextManifest} for the structural and arithmetic
 * consistency guard.
 */
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

/**
 * A tool call awaiting an operator decision inside an
 * {@link ApprovalRequest} (KrakenFrameworkSpecification §1.7). `decisions`
 * enumerates the decision-type strings the operator may choose from for
 * this specific call; `message` is human-facing context explaining why
 * approval is required.
 */
export interface PendingToolCall {
  callId: string;
  decisions: string[];
  input: unknown;
  message: string;
  name: string;
}

/**
 * The pause payload carried by `RuntimeResolution.pause` and the
 * `approval.requested` stream event (KrakenFrameworkSpecification §1.7).
 * `toolCalls` are pending decisions; `completedResults` are tool results
 * from the same batch that already executed before the pause (partial
 * parallel-batch execution). Every `callId` across both arrays is distinct.
 *
 * @see {@link isApprovalRequest} for the runtime guard.
 */
export interface ApprovalRequest {
  completedResults: ToolResultPart[];
  toolCalls: PendingToolCall[];
}

/**
 * A single operator decision resolving one {@link PendingToolCall}
 * (KrakenFrameworkSpecification §1.7). `callId` must match a pending call;
 * `editedInput` is required for `type: "edit"` and forbidden otherwise.
 *
 * @see {@link isApprovalDecision} for the runtime guard.
 */
export interface ApprovalDecision {
  callId: string;
  editedInput?: unknown;
  message?: string;
  type: ApprovalDecisionType;
}

/**
 * The operator's answer to a paused {@link ApprovalRequest}
 * (KrakenFrameworkSpecification §1.7). Structurally request-independent —
 * {@link isApprovalResponse} checks only internal well-formedness;
 * {@link isApprovalResponseForRequest} additionally verifies decision
 * coverage against the specific pending request.
 */
export interface ApprovalResponse {
  decisions: ApprovalDecision[];
}

/**
 * Helper surface passed to {@link ContextEngineeringPlan.execute} and
 * handoff builders for reading and writing durable messages by content
 * hash (KrakenFrameworkSpecification §1.5). The framework owns Run
 * lifecycle, checkpointing, and manifest recomputation around these calls.
 */
export interface ContextEngineeringHelpers {
  loadMessage(hash: HashString): TuvrenMessage | null;
  storeMessage(message: TuvrenMessage): HashString;
  storeMessages(messages: TuvrenMessage[]): HashString[];
}

/**
 * The read/write surface a {@link ContextEngineeringPlan} executes against
 * (KrakenFrameworkSpecification §1.5, §4.5): the current message hash
 * sequence, the materialized messages, the manifest, and the
 * {@link ContextEngineeringHelpers} for producing a new hash sequence.
 */
export interface ContextEngineeringContext {
  helpers: ContextEngineeringHelpers;
  manifest: ContextManifest;
  messageHashes: HashString[];
  messages: TuvrenMessage[];
}

/**
 * The framework contract for a persistent transformation of the `messages`
 * path (KrakenFrameworkSpecification §1.5, §4.5, §5.5), returned by a
 * `beforeIteration` hook or the context policy contract. The framework owns
 * the Run lifecycle, `tree.create`, checkpointing, manifest recomputation,
 * and Turn/Branch advancement around `execute`; `execute` itself returns
 * only the complete replacement hash array for the active `messages` path.
 */
export interface ContextEngineeringPlan {
  action: string;
  execute(context: ContextEngineeringContext): HashString[];
}

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
 * Multi-agent attribution carried on every {@link TuvrenStreamEvent}
 * (KrakenFrameworkSpecification §1.8): the emitting agent name, and
 * optional runner, thread, and worker identifiers for descendant/worker
 * event attribution in orchestration.
 *
 * @see {@link isEventSource} for the runtime guard.
 */
export interface EventSource {
  agent: string;
  runner?: string;
  threadId?: string;
  workerId?: string;
}

/**
 * Alias for {@link EventSource} used at runner-facing seams
 * (KrakenFrameworkSpecification §5.6) where the attribution is specifically
 * the source a runner stamps onto emitted events, as distinct from
 * framework-owned lifecycle event sources.
 */
export type RunnerAttributedEventSource = EventSource;

/**
 * The serializable, data-only projection of an error carried by the
 * `error` stream event (KrakenFrameworkSpecification §1.8). Deliberately
 * excludes the `Error` instance itself so the event stays JSON-serializable
 * across the wire.
 *
 * @see {@link isTuvrenErrorProjection} for the runtime guard.
 */
export interface TuvrenErrorProjection {
  code?: string;
  details?: unknown;
  message: string;
}

/** The `error` branch of a {@link ValidationResult}: a failed schema check. */
export interface ValidationErrorPayload {
  details?: unknown;
  message: string;
}

/**
 * Emitted once at the start of a Turn (KrakenFrameworkSpecification §1.8).
 * `resumedFrom`, when present, is the TurnNode hash of the pause point being
 * resumed; absent means a fresh Turn. Protocol adapters use its presence to
 * distinguish fresh Turns from resumed Turns.
 */
export interface TurnStartEvent {
  resumedFrom?: HashString;
  source?: EventSource;
  threadId: string;
  timestamp: EpochMs;
  turnId: string;
  type: "turn.start";
}

/**
 * Emitted once when a Turn reaches a terminal or paused stop
 * (KrakenFrameworkSpecification §1.8). `status` mirrors the terminal
 * `ExecutionStatus.phase` for that outcome.
 */
export interface TurnEndEvent {
  source?: EventSource;
  status: "completed" | "paused" | "failed";
  timestamp: EpochMs;
  turnId: string;
  type: "turn.end";
}

/** Lifecycle {@link TuvrenStreamEvent}: fires at the start of each iteration. */
export interface IterationStartEvent {
  iterationCount: number;
  source?: EventSource;
  timestamp: EpochMs;
  type: "iteration.start";
}

/** Lifecycle {@link TuvrenStreamEvent}: fires at the end of each iteration. */
export interface IterationEndEvent {
  iterationCount: number;
  source?: EventSource;
  timestamp: EpochMs;
  type: "iteration.end";
}

/**
 * Model-output {@link TuvrenStreamEvent}: precedes all content events for a
 * given assistant `messageId`.
 */
export interface MessageStartEvent {
  messageId: string;
  role: "assistant";
  source?: EventSource;
  timestamp: EpochMs;
  type: "message.start";
}

/**
 * Model-output {@link TuvrenStreamEvent}: an incremental text fragment for
 * `messageId`, arriving in order.
 */
export interface TextDeltaEvent {
  delta: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "text.delta";
}

/**
 * Model-output {@link TuvrenStreamEvent}: the complete accumulated text for
 * `messageId` once the text run finishes.
 */
export interface TextDoneEvent {
  messageId: string;
  source?: EventSource;
  text: string;
  timestamp: EpochMs;
  type: "text.done";
}

/**
 * Model-output {@link TuvrenStreamEvent}: an incremental reasoning/thinking
 * fragment for `messageId`.
 */
export interface ReasoningDeltaEvent {
  delta: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "reasoning.delta";
}

/**
 * Model-output {@link TuvrenStreamEvent}: signals the reasoning run for
 * `messageId` has finished.
 */
export interface ReasoningDoneEvent {
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "reasoning.done";
}

/**
 * Model-output {@link TuvrenStreamEvent}: an incremental structured-output
 * fragment for `messageId`, arriving in order.
 */
export interface StructuredDeltaEvent {
  delta: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "structured.delta";
}

/**
 * Model-output {@link TuvrenStreamEvent}: the complete parsed structured
 * output for `messageId`, following all of its `structured.delta` events.
 */
export interface StructuredDoneEvent {
  data: unknown;
  messageId: string;
  name?: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "structured.done";
}

/**
 * Model-output {@link TuvrenStreamEvent}: one complete file content part,
 * emitted between `message.start` and `message.done`.
 */
export interface FileDoneEvent {
  data: string | Uint8Array;
  filename?: string;
  mediaType: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "file.done";
}

/**
 * Model-output {@link TuvrenStreamEvent}: the model has requested a tool
 * call; precedes that call's `tool_call.args_delta` events. Distinct from
 * `tool.start`, which marks framework-side execution.
 */
export interface ToolCallStartEvent {
  callId: string;
  messageId: string;
  name: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool_call.start";
}

/**
 * Model-output {@link TuvrenStreamEvent}: an incremental fragment of a
 * requested tool call's argument text.
 */
export interface ToolCallArgsDeltaEvent {
  callId: string;
  delta: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool_call.args_delta";
}

/**
 * Model-output {@link TuvrenStreamEvent}: the complete, parsed input for a
 * requested tool call.
 */
export interface ToolCallDoneEvent {
  callId: string;
  input: unknown;
  name: string;
  providerMetadata?: Record<string, unknown>;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool_call.done";
}

/**
 * Model-output {@link TuvrenStreamEvent}: closes out `messageId`, following
 * all of that message's content events.
 */
export interface MessageDoneEvent {
  finishReason: "stop" | "tool_call" | "length" | "error" | "content_filter";
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "message.done";
  usage?: ProviderUsage;
}

/**
 * Tool-execution {@link TuvrenStreamEvent}: emitted only after approval has
 * resolved, immediately before the framework enters the first executable
 * aroundTool/execute step for this call — never merely because the model
 * requested the tool (that is `tool_call.done`).
 */
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

/**
 * Tool-execution {@link TuvrenStreamEvent}: the outcome of a tool
 * invocation, emitted after the aroundTool chain returns for that call.
 */
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

/** Control {@link TuvrenStreamEvent}: a Turn has paused on `request`. */
export interface ApprovalRequestedEvent {
  request: ApprovalRequest;
  source?: EventSource;
  timestamp: EpochMs;
  type: "approval.requested";
}

/** Control {@link TuvrenStreamEvent}: the paused Turn has resumed with `response`. */
export interface ApprovalResolvedEvent {
  response: ApprovalResponse;
  source?: EventSource;
  timestamp: EpochMs;
  type: "approval.resolved";
}

/**
 * Control {@link TuvrenStreamEvent}: a `steer()` signal was consumed at an
 * iteration boundary and incorporated as `messageId`.
 */
export interface SteeringIncorporatedEvent {
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "steering.incorporated";
}

/**
 * Control {@link TuvrenStreamEvent}: an error condition occurred. `fatal`
 * distinguishes a Turn-terminating error from a recorded but non-terminal
 * one (e.g. `fail(soft)`).
 */
export interface ErrorEvent {
  error: TuvrenErrorProjection;
  fatal: boolean;
  source?: EventSource;
  timestamp: EpochMs;
  type: "error";
}

/**
 * The internal event vocabulary: a discriminated union on `type` over every
 * event the framework and its runners emit (KrakenFrameworkSpecification
 * §1.8). Every event carries `type`, `timestamp`, and optional `source` for
 * multi-agent attribution. Grouped into lifecycle, model-output, tool-
 * execution, control, state, and custom events. Protocol adapters consume
 * this canonical stream and bridge it into AG-UI, ACP, OpenResponses-style
 * transports, or any other host protocol.
 *
 * @see {@link isTuvrenStreamEvent} for the runtime guard.
 */
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

/**
 * State {@link TuvrenStreamEvent}: an observability affordance carrying the
 * current `manifest`. Standardized but optional — hosts and protocol
 * adapters must tolerate its absence.
 */
export interface StateSnapshotEvent {
  manifest: ContextManifest;
  source?: EventSource;
  timestamp: EpochMs;
  type: "state.snapshot";
}

/**
 * State {@link TuvrenStreamEvent}: an observability affordance marking a
 * durable checkpoint at `turnNodeHash`. Standardized but optional — hosts
 * and protocol adapters must tolerate its absence.
 */
export interface StateCheckpointEvent {
  iterationCount: number;
  source?: EventSource;
  timestamp: EpochMs;
  turnNodeHash: HashString;
  type: "state.checkpoint";
}

/**
 * Extension-defined {@link TuvrenStreamEvent} injected via `ctx.emit`.
 * `name` and `data` are entirely extension-owned; the framework does not
 * interpret them.
 */
export interface CustomEvent {
  data: unknown;
  name: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "custom";
}

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

/**
 * The signature every {@link TuvrenToolDefinition.execute} implements
 * (KrakenFrameworkSpecification §8.3): takes the validated `input` and the
 * per-invocation {@link ToolExecutionContext}, and returns the tool's raw
 * result (validated against `outputSchema`, if declared, before surfacing).
 */
export type ExecuteFunction = (
  input: unknown,
  context: ToolExecutionContext
) => Promise<unknown> | unknown;

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
 * The static, per-agent configuration for a Turn
 * (KrakenFrameworkSpecification §10.1): model, system prompt, tools,
 * extensions, the pluggable policy contracts, capability-orchestration
 * inputs (Epics AX/AY/BB, ADR-046, KRT-AZ001/AZ003), and execution limits.
 * Agent configs are static for the lifetime of the orchestration; on
 * handoff the framework swaps the active config and rebuilds the active
 * tool registry, extension composition, and renderer inputs from it.
 */
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
 * the runner's own loop policy so a misbehaving or adversarial runner cannot
 * run a turn unbounded. Configured per runtime instance via
 * `createTuvren({ bounds })` / `RuntimeCoreOptions.bounds`. Unset fields take
 * the documented safe defaults; every configured bound must be a finite
 * positive integer. A runner cannot raise or disable a bound.
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

/**
 * The point-in-time execution state returned by {@link ExecutionHandle.status}
 * (KrakenFrameworkSpecification §7.1). `approval` and `pauseReason` are
 * present only when `phase === "paused"`, and a paused status must carry
 * both — see {@link isExecutionStatus} for the enforced coupling invariant.
 */
export interface ExecutionStatus {
  activeAgent?: string;
  approval?: ApprovalRequest;
  iterationCount: number;
  manifest?: ContextManifest;
  pauseReason?: string;
  phase: "running" | "paused" | "completed" | "failed";
}

// `status` is the sole discriminant; `executionStatus.phase === status` for all terminal results.
/**
 * The terminal value {@link ExecutionHandle.awaitResult} resolves to
 * (KrakenFrameworkSpecification §7.1): a discriminated union on `status`
 * with `executionStatus.phase === status` as an invariant for both
 * branches. The promise resolves — never rejects — for both outcomes so
 * callers can exhaustively pattern-match without a try/catch; it rejects
 * only for cancellation.
 */
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
/**
 * The terminal value {@link OrchestrationHandle.awaitResult} resolves to
 * (KrakenFrameworkSpecification §10.6): the parent's own
 * {@link ExecutionResult} plus `childResults`, keyed by descendant worker
 * identity and populated for spawned children whose `awaitResult()`
 * settled before or during parent completion. Child failures are recorded
 * without failing the parent unless the parent itself also failed.
 */
export type OrchestrationResult = ExecutionResult & {
  childResults: Record<string, ExecutionResult>;
};

/**
 * The host-facing control surface for driving and observing a Turn
 * (KrakenFrameworkSpecification §7.1). `events()` is the primary,
 * single-consumer output and iteration drives execution; `cancel()`
 * triggers the abort signal (or rejects pending approvals if paused);
 * `steer()` injects a signal consumed at the next iteration boundary
 * (valid only while running); `resolveApproval()` resumes a paused Turn and
 * returns a **new** handle; `status()` and `awaitResult()` read current and
 * terminal state respectively.
 */
export interface ExecutionHandle {
  awaitResult(): Promise<ExecutionResult>;
  cancel(): void;
  events(): AsyncIterable<TuvrenStreamEvent>;
  resolveApproval(response: ApprovalResponse): ExecutionHandle;
  status(): ExecutionStatus;
  steer(signal: InputSignal): void;
}

/**
 * The control surface for a Turn spawned through the
 * {@link OrchestrationRuntime} (KrakenFrameworkSpecification §10.6). Adds
 * `allEvents()` (self plus descendant subtree events, single-consumer per
 * handle) and `spawn()` for launching child workers; overrides
 * `awaitResult()` and `resolveApproval()` to return orchestration-flavored
 * handles/results. `spawn()` is valid only while this handle is running.
 */
export interface OrchestrationHandle extends ExecutionHandle {
  allEvents(): AsyncIterable<TuvrenStreamEvent>;
  awaitResult(): Promise<OrchestrationResult>;
  resolveApproval(response: ApprovalResponse): OrchestrationHandle;
  spawn(input: { agent: string; signal: InputSignal }): OrchestrationHandle;
}

/**
 * The minimal, handle/tree-based multi-agent orchestration primitive
 * (KrakenFrameworkSpecification §10.6). Composes existing framework
 * primitives (`executeTurn`, `ExecutionHandle.events()`, Thread creation) —
 * no new kernel concepts. `executeTurn` starts both root and child Turns.
 */
export interface OrchestrationRuntime {
  executeTurn(input: {
    agent: string;
    branchId: string;
    runnerId?: string;
    parentTurnId?: string | null;
    schemaId?: string;
    signal: InputSignal;
    threadId: string;
    tools?: TuvrenToolDefinition[];
  }): OrchestrationHandle;
}

// ── Durable-Read Return Types (ADR-036) ─────────────────────────────────────

/** A summary entry returned by {@link TuvrenRuntime.listThreads} (ADR-036). */
export interface ThreadSummary {
  createdAtMs: EpochMs;
  rootTurnNodeHash: HashString;
  schemaId: string;
  threadId: string;
}

/** A summary entry returned by {@link TuvrenRuntime.listBranches} (ADR-036). */
export interface BranchSummary {
  branchId: string;
  headTurnNodeHash: HashString;
  threadId: string;
}

/**
 * A point-in-time view of a Turn's durable state, returned by
 * {@link TuvrenRuntime.getTurnState} and iterated by
 * {@link TuvrenRuntime.getTurnHistory} (ADR-036). `paths` projects the
 * schema's state paths (messages, manifest, etc.) at this TurnNode;
 * `previousTurnNodeHash` is `null` for the root Turn.
 */
export interface TurnSnapshot {
  eventHash: HashString | null;
  manifest: ContextManifest | null;
  paths: Record<string, HashString[] | HashString | null>;
  previousTurnNodeHash: HashString | null;
  schemaId: string;
  turnNodeHash: HashString;
  turnTreeHash: HashString;
}

/** Opaque pagination cursor for {@link TuvrenRuntime.listThreads} (ADR-036). */
export type ListThreadsCursor = string; // opaque to host; see TechSpec §3.8
/** Opaque pagination cursor for {@link TuvrenRuntime.getTurnHistory} (ADR-036). */
export type TurnHistoryCursor = string; // opaque to host; see TechSpec §3.8
/** Opaque pagination cursor for {@link TuvrenRuntime.readBranchMessages} (ADR-036). */
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

/**
 * The framework's host-facing runtime surface: Thread/Branch lifecycle
 * (`createThread`, `createBranch`, `setBranchHead`), Turn execution
 * (`executeTurn`), the ADR-036 durable-read surface (`listThreads`,
 * `listBranches`, `getThread`, `getTurnState`, `getTurnHistory`,
 * `readBranchMessages`), and the ADR-051 data-lifecycle `maintenance`
 * surface. This is the top-level seam a host embeds to expose Kraken to
 * external consumers (APIs, UIs, protocol endpoints).
 */
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
    runnerId?: string;
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
