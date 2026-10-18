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

import type { HashString } from "./kernel-records.js";

/* oxlint-disable typescript/method-signature-style -- Preserve the frozen public method signatures and their method bivariance under strictFunctionTypes. */

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
// oxlint-disable-next-line typescript/consistent-indexed-object-style -- Preserve the frozen recursive JSON Schema alias spelling in the public API snapshot.
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
  // oxlint-disable-next-line typescript/ban-types -- Preserve the intentional open-string union without collapsing editor completion for known values.
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
  | {
      admissionKey?: string;
      role: "user";
      parts: NonEmptyArray<ContentPart>;
    }
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
  admissionKey?: string;
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
   * framework-enforced execution bounds guard (ADR-0043) can abort an in-flight
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

/* oxlint-enable typescript/method-signature-style */
