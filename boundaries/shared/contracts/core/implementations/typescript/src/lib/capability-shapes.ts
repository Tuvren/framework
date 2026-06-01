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

/**
 * Capability Orchestration concept shapes per TechSpec §3.13 / ADR-046.
 *
 * These are runtime/configuration types, not kernel record state. The
 * conceptual invariant: every model-visible tool call resolves to exactly one
 * Capability invocation against exactly one ExecutionClass.
 */

import type { TuvrenJsonSchema } from "./runtime-contract-shapes.js";

// ---------------------------------------------------------------------------
// Closed sets
// ---------------------------------------------------------------------------

/** Who owns a capability invocation. Closed set per ADR-046. */
export type ExecutionClass =
  | "provider-native"
  | "provider-mediated"
  | "tuvren-server"
  | "tuvren-client";

/**
 * Concrete execution target kinds. MCP appears here as `"mcp-server"` under
 * the provider-mediated, tuvren-server, or tuvren-client execution classes —
 * never as an execution class of its own.
 */
export type EndpointKind =
  | "provider-runtime"
  | "tuvren-in-process"
  | "tuvren-server"
  | "tuvren-worker"
  | "tuvren-sandbox"
  | "client-endpoint"
  | "mcp-server";

// ---------------------------------------------------------------------------
// Core compositional shapes
// ---------------------------------------------------------------------------

/**
 * The underlying authority to perform an action, independent of how it is
 * surfaced to a model or who executes it.
 */
export interface Capability {
  /** Stable identifier, e.g. "web.search" or "mcp.shopify.search_products". */
  id: string;
  riskClass?: "low" | "medium" | "high";
  title?: string;
}

/**
 * The model-facing representation of a capability: the name, description,
 * schema, and optional provider rendering constraints that determine what the
 * model may see and call. Distinct from the underlying Capability.
 */
export interface ToolSurface {
  /** The Capability this surface presents. */
  capabilityId: string;
  description: string;
  /** Provider-wire shape (CustomSchema-normalized upstream). */
  inputSchema: TuvrenJsonSchema;
  /** Model-facing name. */
  name: string;
  /** Provider-specific rendering constraints (non-secret). */
  providerRendering?: Record<string, unknown>;
}

/**
 * Concrete execution target for a binding. Credentials and transport details
 * are owned by the execution-class endpoint container, not stored here.
 */
export interface Endpoint {
  /** Stable, non-secret endpoint identifier. */
  id: string;
  kind: EndpointKind;
}

/**
 * Ties a Capability to one ExecutionClass and one Endpoint in a given context.
 * A Capability may carry multiple candidate Bindings; the resolver selects one
 * per context.
 */
export interface Binding {
  capabilityId: string;
  endpoint: Endpoint;
  executionClass: ExecutionClass;
}

// ---------------------------------------------------------------------------
// Observation limits (per class)
// ---------------------------------------------------------------------------

/**
 * Per-class bounds on what the runtime can know, persist, resume, cancel,
 * retry, or audit. The runtime must not expose an affordance the class does
 * not grant.
 */
export interface CapabilityObservation {
  canAudit: boolean;
  canCancel: boolean;
  canObserveIntermediate: boolean;
  canPersistResult: boolean;
  canResume: boolean;
  canRetry: boolean;
  executionClass: ExecutionClass;
}

// ---------------------------------------------------------------------------
// Policy decision shapes
// ---------------------------------------------------------------------------

/** Outcome of the exposure-time decision point for one tool surface. */
export interface ExposureDecision {
  /** Whether the surface may be included in the model-visible set. */
  exposed: boolean;
  /** Non-secret denial reason when exposed is false. */
  reason?: string;
  surfaceName: string;
}

/** Outcome of the invocation-time decision point for one resolved capability. */
export interface InvocationDecision {
  /** Whether the invocation is admitted. */
  admitted: boolean;
  capabilityId: string;
  executionClass: ExecutionClass;
  /** Non-secret denial reason when admitted is false. */
  reason?: string;
  /** True when the invocation requires an explicit approval decision first. */
  requiresApproval?: boolean;
}

// ---------------------------------------------------------------------------
// Attribution (canonical event-stream / telemetry)
// ---------------------------------------------------------------------------

/**
 * Who owns an invocation: the model provider ("provider") or Tuvren
 * ("tuvren"). Used as the canonical `owner` dimension on events and telemetry.
 */
export type InvocationOwner = "provider" | "tuvren";

/**
 * Attribution record attached to canonical tool/capability invocation events
 * (§4.5) and operational telemetry (§3.10). Added additively as optional
 * fields so existing event consumers are unaffected.
 */
export interface CapabilityInvocationAttribution {
  capabilityId: string;
  executionClass: ExecutionClass;
  observation: CapabilityObservation;
  /** "provider" for provider-native/mediated invocations; "tuvren" otherwise. */
  owner: InvocationOwner;
}

// ---------------------------------------------------------------------------
// Policy engine contract (interface owned here; implementation in @tuvren/runtime)
// ---------------------------------------------------------------------------

/**
 * Context provided to the Capability Policy Engine at each decision point.
 * Covers the dimensions named in §4.21. Full depth (data-residency, risk,
 * presence, credential boundary, idempotency/retry) lands in Epic BB.
 */
export interface CapabilityPolicyContext {
  modelId: string;
  /** User/org permission tokens present for this invocation. */
  permissions: string[];
  providerId: string;
}

/**
 * Two-decision-point framework-owned policy gate per ADR-046 §4.21.
 * The implementation lives in @tuvren/runtime; the interface here so hosts
 * can configure and AgentConfig can type it without a circular dependency.
 */
export interface CapabilityPolicyEngine {
  /**
   * Evaluate exposure-time policy over candidate surfaces. Returns decisions
   * indicating which surfaces may be included in the model-visible set.
   *
   * The runtime must filter denied surfaces before presenting the tool list
   * to the model. This enforcement wiring lands in Epic BB; for the foundation
   * phase (Epic AW), the baseline engine returns correct decisions but the
   * runtime does not yet act on them during tool-set construction.
   */
  evaluateExposure(
    surfaces: ToolSurface[],
    context: CapabilityPolicyContext
  ): ExposureDecision[];

  /**
   * Evaluate invocation-time policy for a resolved binding. Denied
   * invocations must surface as `tool.result` with `isError: true`.
   */
  evaluateInvocation(
    binding: Binding,
    context: CapabilityPolicyContext
  ): InvocationDecision;
}
