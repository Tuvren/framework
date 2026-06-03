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
 * Interface for a server sandbox executor — a host-provided isolated execution
 * environment for Tuvren-server capabilities bound to the tuvren-sandbox endpoint
 * kind. The runtime calls this interface when dispatching a sandboxed capability
 * invocation, giving the host full control over the isolation boundary (e.g. a
 * subprocess, VM, or container).
 *
 * The context parameter carries callId, name, signal, emit, and forward — the
 * same ToolExecutionContext the host sees on regular tool.execute callbacks.
 * (AX004)
 */
export interface TuvrenSandboxExecutor {
  execute(input: unknown, context: unknown): Promise<unknown> | unknown;
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

// ---------------------------------------------------------------------------
// Tuvren-client execution class shapes (§4.21 / KRT-AZ001)
// ---------------------------------------------------------------------------

/**
 * A capability advertised by an attached client endpoint. Each advertisement
 * declares the capability the client endpoint can execute and the schema of
 * its inputs. The runtime registers these as tuvren-client bindings.
 *
 * When mcpServerName is set, the capability is a client-side MCP tool: the
 * client endpoint invokes or runs the MCP server. The binding's endpoint kind
 * becomes "mcp-server" under the tuvren-client execution class — it is never
 * reclassified as a Tuvren-server or provider-mediated binding.
 */
export interface ClientEndpointCapabilityAdvertisement {
  capabilityId: string;
  description: string;
  inputSchema: TuvrenJsonSchema;
  /** When set, this capability is a client-side MCP tool under the tuvren-client class. */
  mcpServerName?: string;
}

/**
 * The invocation envelope the runtime dispatches to an attached client endpoint.
 * Contains everything the client needs to execute the capability. Credentials
 * and environment secrets are never included — they are owned by the client edge.
 */
export interface ClientInvocationEnvelope {
  callId: string;
  capabilityId: string;
  input: unknown;
  /** Opaque non-secret lease token. The client must echo it in ClientReportedResult. Mismatches are stale. */
  leaseToken: string;
}

/**
 * The result a client endpoint reports back after executing a capability.
 * The client owns environmental execution; Tuvren records this result as a
 * canonical capability result with partial-observability limits.
 *
 * The leaseToken must match the envelope's leaseToken. A mismatch signals a
 * stale late-completion that the runtime will ignore rather than accept.
 *
 * No secret material (credentials, environment tokens, internal state) should
 * appear in content — this value enters durable lineage.
 */
export interface ClientReportedResult {
  callId: string;
  content: unknown;
  isError?: boolean;
  /** Must echo the envelope's leaseToken. Mismatches are treated as stale. */
  leaseToken: string;
}

/**
 * A client endpoint that can be attached to a runtime instance. Concrete
 * implementations are host-developer deliverables (browser extension, desktop
 * app, device agent, client-side MCP runner). The runtime side only needs this
 * interface to orchestrate, lease, and observe client-side execution.
 *
 * The runtime owns orchestration and policy; the client endpoint owns
 * environmental execution and may hold authority the server does not.
 */
export interface AttachedClientEndpoint {
  /** Capabilities this endpoint can execute, advertised at attach time. */
  advertisedCapabilities: ClientEndpointCapabilityAdvertisement[];
  /** Dispatch a capability invocation. Must echo back the envelope's leaseToken. */
  dispatch(envelope: ClientInvocationEnvelope): Promise<ClientReportedResult>;
  /** Stable non-secret identifier for this endpoint. */
  endpointId: string;
}

/**
 * Runtime boundary for the Tuvren-client execution class (§4.21 / KRT-AZ001).
 *
 * The interface is defined here in @tuvren/core/capabilities so AgentConfig
 * can reference it without a circular dependency. The implementation lives in
 * @tuvren/runtime. Hosts that need dynamic endpoint lifecycle control
 * (e.g. to signal unavailability for conformance testing) can obtain an
 * instance via createClientEndpointBoundary from @tuvren/runtime and pass it
 * as AgentConfig.clientEndpointBoundary.
 */
export interface ClientEndpointBoundary {
  /**
   * Remove all capabilities backed by the given endpointId from the boundary.
   *
   * After detach, `isAvailable` returns false for those capabilities. The
   * tuvren-client `execute` closures check `isAvailable` before dispatching
   * and surface `capability_binding_unavailable` when false. This models an
   * attached endpoint that has become unavailable mid-turn. (KRT-AZ003)
   */
  detach(endpointId: string): void;
  /**
   * Dispatch a capability invocation to the attached endpoint. Generates a
   * fresh leaseToken, validates the echoed token on the result, and returns
   * null when the result is stale. Throws capability_binding_unavailable when
   * no endpoint is attached for the capability.
   */
  dispatch(
    capabilityId: string,
    callId: string,
    input: unknown
  ): Promise<ClientDispatchResult | null>;
  /** Whether any attached endpoint currently advertises the given capabilityId. */
  isAvailable(capabilityId: string): boolean;
  /** Resolve the Binding for a capabilityId, or undefined if unavailable. */
  resolveBinding(capabilityId: string): Binding | undefined;
}

/** Resolved dispatch result: the client-reported content and error flag. */
export interface ClientDispatchResult {
  content: unknown;
  isError: boolean;
}
