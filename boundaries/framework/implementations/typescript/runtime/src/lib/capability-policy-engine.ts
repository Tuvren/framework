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
  Binding,
  ExposureDecision,
  InvocationDecision,
  ToolSurface,
} from "@tuvren/core/capabilities";

/**
 * Context provided to the Capability Policy Engine at each decision point.
 * Covers the dimensions named in §4.21 (provider/model, permissions,
 * residency, endpoint availability, approval, credential boundary, etc.).
 *
 * The baseline implementation gates on permissions and explicit deny-lists.
 * Full depth (data-residency, risk-classification, presence, credential
 * boundary, idempotency/retry) lands in Epic BB (§5.7.3).
 */
export interface CapabilityPolicyContext {
  modelId: string;
  /** User/org permission tokens present for this invocation. */
  permissions: string[];
  providerId: string;
}

/**
 * Options for the baseline Capability Policy Engine.
 *
 * At this foundation phase (Epic AW), the engine supports explicit deny-lists
 * for surfaces and capabilities. The full policy dimension set (residency,
 * risk, presence, credential boundary, idempotency/retry, composition) lands
 * in Epic BB.
 */
export interface CapabilityPolicyEngineOptions {
  /** Capability ids to deny at invocation-time regardless of other context. */
  deniedCapabilityIds?: Set<string>;
  /** Surface names to deny at exposure-time regardless of other context. */
  deniedSurfaceNames?: Set<string>;
}

/**
 * Two-decision-point framework-owned policy gate per ADR-046 §4.21:
 *
 * - Exposure-time: called before the model sees the tool surface set.
 *   A denied surface is never included in the model-visible set.
 * - Invocation-time: called after the model calls a tool, before dispatch.
 *   A denied invocation surfaces as `tool.result` with `isError: true`
 *   carrying a non-secret reason rather than being executed.
 *
 * Both decision points are framework-owned and above driver discretion.
 * Drivers see only the exposed surface set and cannot override denials.
 *
 * APPROVAL INTEGRATION (deferred to Epic AX/BB):
 * The `InvocationDecision.requiresApproval` field allows this gate to signal
 * "admitted, but route through approval first." The baseline (Epic AW) never
 * sets `requiresApproval` because the existing approval gate in
 * `tool-execution.ts` remains non-bypassable by construction — the engine is
 * not yet wired into the tool execution path. When integration lands, callers
 * must NOT read `admitted: true` as "no approval required"; they must
 * additionally consult `requiresApproval` and route through the approval gate
 * when it is set. This is intentionally deferred; the approval guarantee is
 * preserved by the existing gate, not by this engine.
 *
 * CONTEXT-DRIVEN DIMENSIONS (deferred to Epic BB):
 * `CapabilityPolicyContext` carries `providerId`, `modelId`, and `permissions`
 * for future use. The baseline only consults explicit deny-lists; the full
 * policy dimension set (residency, risk, presence, credential boundary,
 * idempotency/retry, composition/precedence) lands in Epic BB.
 */
export interface CapabilityPolicyEngine {
  /**
   * Evaluate exposure-time policy over a candidate surface set.
   * Returns one ExposureDecision per surface; denied surfaces must not reach
   * the model's tool definition list.
   */
  evaluateExposure(
    surfaces: ToolSurface[],
    context: CapabilityPolicyContext
  ): ExposureDecision[];

  /**
   * Evaluate invocation-time policy for a resolved binding.
   * An InvocationDecision with `admitted: false` must be surfaced as a
   * `tool.result` with `isError: true` and a non-secret reason. See the
   * interface doc on approval integration for `requiresApproval` semantics.
   */
  evaluateInvocation(
    binding: Binding,
    context: CapabilityPolicyContext
  ): InvocationDecision;
}

class BasicCapabilityPolicyEngine implements CapabilityPolicyEngine {
  private readonly deniedSurfaces: ReadonlySet<string>;
  private readonly deniedCapabilities: ReadonlySet<string>;

  constructor(options: CapabilityPolicyEngineOptions) {
    this.deniedSurfaces = options.deniedSurfaceNames ?? new Set();
    this.deniedCapabilities = options.deniedCapabilityIds ?? new Set();
  }

  evaluateExposure(
    surfaces: ToolSurface[],
    _context: CapabilityPolicyContext
  ): ExposureDecision[] {
    return surfaces.map((surface) => {
      const denied = this.deniedSurfaces.has(surface.name);
      return denied
        ? {
            exposed: false,
            reason: "surface denied by exposure-time policy",
            surfaceName: surface.name,
          }
        : { exposed: true, surfaceName: surface.name };
    });
  }

  evaluateInvocation(
    binding: Binding,
    _context: CapabilityPolicyContext
  ): InvocationDecision {
    const denied = this.deniedCapabilities.has(binding.capabilityId);
    return denied
      ? {
          admitted: false,
          capabilityId: binding.capabilityId,
          executionClass: binding.executionClass,
          reason: "capability denied by invocation-time policy",
        }
      : {
          admitted: true,
          capabilityId: binding.capabilityId,
          executionClass: binding.executionClass,
        };
  }
}

export function createCapabilityPolicyEngine(
  options: CapabilityPolicyEngineOptions = {}
): CapabilityPolicyEngine {
  return new BasicCapabilityPolicyEngine(options);
}
