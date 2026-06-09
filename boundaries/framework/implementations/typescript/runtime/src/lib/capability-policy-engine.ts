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
  CapabilityPolicyContext,
  CapabilityPolicyEngine,
  ExposureDecision,
  InvocationDecision,
  PolicyCapabilityMetadata,
  ToolSurface,
} from "@tuvren/core/capabilities";

/**
 * Extension interface for custom policy dimensions. Implementations are
 * appended after the built-in framework dimensions and participate in the
 * same deny-from-any composition: returning a non-null string adds a denial
 * reason; returning null passes. Use `options.dimensions` on
 * `createCapabilityPolicyEngine` to register extension dimensions. (Epic BB+, follows BB005 composition/precedence)
 */
export interface PolicyDimension {
  /**
   * Evaluate exposure-time policy for a single surface.
   * Return a non-empty reason string to withhold the surface from the model;
   * return null to pass. The built-in framework dimensions are evaluated
   * before this method is called.
   */
  checkExposure(
    surface: ToolSurface,
    metadata: PolicyCapabilityMetadata | undefined,
    context: CapabilityPolicyContext
  ): string | null;
  /**
   * Evaluate invocation-time policy for a single binding.
   * Return a non-empty reason string to deny the invocation;
   * return null to pass. The built-in framework dimensions are evaluated
   * before this method is called.
   */
  checkInvocation(
    binding: Binding,
    metadata: PolicyCapabilityMetadata | undefined,
    context: CapabilityPolicyContext
  ): string | null;
}

/**
 * Options for the baseline Capability Policy Engine. Controls the static
 * policy rules applied at both decision points; per-capability metadata and
 * session-level context dimensions are supplied at call time via
 * CapabilityPolicyContext. Epic BB extends these with risk-class thresholds.
 */
export interface CapabilityPolicyEngineOptions {
  /** Capability ids to deny at invocation-time regardless of other context. */
  deniedCapabilityIds?: Set<string>;
  /** Surface names to deny at exposure-time regardless of other context. */
  deniedSurfaceNames?: Set<string>;
  /**
   * Custom policy dimensions appended after the framework built-ins.
   * Each dimension participates in deny-from-any composition: a non-empty
   * string return from checkExposure or checkInvocation adds a denial reason.
   * Framework dimensions always run first. (Epic BB+)
   */
  dimensions?: PolicyDimension[];
  /**
   * Capabilities strictly above this risk class are withheld at exposure time
   * (exposed: false). "high" means only high-risk capabilities are withheld;
   * "medium" means medium and high are withheld; "low" withholds all.
   * Absent means no risk-based exposure cap is active. BB002.
   */
  maxExposedRiskClass?: "low" | "medium" | "high";
  // ── BB002: risk-based policy ─────────────────────────────────────────────
  /**
   * Capabilities at or above this risk class require explicit user approval
   * at invocation time. The engine sets requiresApproval: true on the
   * InvocationDecision; the existing approval gate enforces the decision.
   * Absent means no risk-based approval gate is active. BB002.
   */
  requireApprovalForRiskClass?: "low" | "medium" | "high";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const RISK_ORDER: Record<"low" | "medium" | "high", number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function riskExceedsThreshold(
  riskClass: "low" | "medium" | "high",
  threshold: "low" | "medium" | "high"
): boolean {
  return RISK_ORDER[riskClass] > RISK_ORDER[threshold];
}

function riskMeetsOrExceedsThreshold(
  riskClass: "low" | "medium" | "high",
  threshold: "low" | "medium" | "high"
): boolean {
  return RISK_ORDER[riskClass] >= RISK_ORDER[threshold];
}

// ---------------------------------------------------------------------------
// Evaluation helpers: each returns null (pass) or a denial reason string
// ---------------------------------------------------------------------------

function checkResidencyExposure(
  capabilityId: string,
  metadata: PolicyCapabilityMetadata | undefined,
  context: CapabilityPolicyContext
): string | null {
  if (
    metadata?.requiredResidency === undefined ||
    context.allowedResidencies === undefined
  ) {
    return null;
  }
  if (!context.allowedResidencies.includes(metadata.requiredResidency)) {
    return `capability "${capabilityId}" requires data residency "${metadata.requiredResidency}" which is not in the allowed residency list`;
  }
  return null;
}

function checkActiveEndpointExposure(
  capabilityId: string,
  metadata: PolicyCapabilityMetadata | undefined,
  context: CapabilityPolicyContext
): string | null {
  if (!metadata?.requiresActiveEndpoint) {
    return null;
  }
  if (context.unavailableCapabilityIds?.has(capabilityId)) {
    return `capability "${capabilityId}" requires an active endpoint but none is currently attached`;
  }
  return null;
}

function checkRiskClassExposure(
  capabilityId: string,
  metadata: PolicyCapabilityMetadata | undefined,
  options: CapabilityPolicyEngineOptions
): string | null {
  if (
    metadata?.riskClass === undefined ||
    options.maxExposedRiskClass === undefined
  ) {
    return null;
  }
  if (riskExceedsThreshold(metadata.riskClass, options.maxExposedRiskClass)) {
    return `capability "${capabilityId}" has risk class "${metadata.riskClass}" which exceeds the maximum exposed risk class "${options.maxExposedRiskClass}"`;
  }
  return null;
}

function checkResidencyInvocation(
  capabilityId: string,
  metadata: PolicyCapabilityMetadata | undefined,
  context: CapabilityPolicyContext
): string | null {
  if (
    metadata?.requiredResidency === undefined ||
    context.allowedResidencies === undefined
  ) {
    return null;
  }
  if (!context.allowedResidencies.includes(metadata.requiredResidency)) {
    return `capability "${capabilityId}" requires data residency "${metadata.requiredResidency}" which is not in the allowed residency list`;
  }
  return null;
}

function checkUserPresenceInvocation(
  capabilityId: string,
  metadata: PolicyCapabilityMetadata | undefined,
  context: CapabilityPolicyContext
): string | null {
  if (!metadata?.requiresUserPresence) {
    return null;
  }
  if (context.userPresent === false) {
    return `capability "${capabilityId}" requires user presence but no user is present`;
  }
  return null;
}

function checkCredentialBoundaryInvocation(
  capabilityId: string,
  metadata: PolicyCapabilityMetadata | undefined,
  context: CapabilityPolicyContext
): string | null {
  if (
    !metadata?.requiredCredentialScopes ||
    metadata.requiredCredentialScopes.length === 0
  ) {
    return null;
  }
  const available = context.availableCredentialScopes ?? [];
  const missing = metadata.requiredCredentialScopes.filter(
    (scope) => !available.includes(scope)
  );
  if (missing.length > 0) {
    return `capability "${capabilityId}" requires credential scopes [${missing.join(", ")}] that are not available`;
  }
  return null;
}

function checkRiskClassInvocation(
  capabilityId: string,
  metadata: PolicyCapabilityMetadata | undefined,
  options: CapabilityPolicyEngineOptions
): { requiresApproval: true; reason: string } | null {
  if (
    metadata?.riskClass === undefined ||
    options.requireApprovalForRiskClass === undefined
  ) {
    return null;
  }
  if (
    riskMeetsOrExceedsThreshold(
      metadata.riskClass,
      options.requireApprovalForRiskClass
    )
  ) {
    return {
      requiresApproval: true,
      reason: `capability "${capabilityId}" has risk class "${metadata.riskClass}" which requires explicit approval`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engine implementation
// ---------------------------------------------------------------------------

class BasicCapabilityPolicyEngine implements CapabilityPolicyEngine {
  private readonly deniedCapabilities: ReadonlySet<string>;
  private readonly deniedSurfaces: ReadonlySet<string>;
  private readonly extensionDimensions: readonly PolicyDimension[];
  private readonly options: CapabilityPolicyEngineOptions;

  constructor(options: CapabilityPolicyEngineOptions) {
    this.options = options;
    this.deniedCapabilities = options.deniedCapabilityIds ?? new Set();
    this.deniedSurfaces = options.deniedSurfaceNames ?? new Set();
    this.extensionDimensions = options.dimensions ?? [];
  }

  evaluateExposure(
    surfaces: ToolSurface[],
    context: CapabilityPolicyContext
  ): ExposureDecision[] {
    return surfaces.map((surface) => {
      const metadata = context.capabilityMetadata?.get(surface.capabilityId);

      // Compose all exposure-time dimensions; all denials accumulate into a
      // single joined reason string.
      const denyReasons: string[] = [];

      // Static deny-list (AW baseline)
      if (this.deniedSurfaces.has(surface.name)) {
        denyReasons.push("surface denied by exposure-time policy");
      }

      // BB001: data-residency
      const residencyReason = checkResidencyExposure(
        surface.capabilityId,
        metadata,
        context
      );
      if (residencyReason !== null) {
        denyReasons.push(residencyReason);
      }

      // BB002: risk-class cap
      const riskReason = checkRiskClassExposure(
        surface.capabilityId,
        metadata,
        this.options
      );
      if (riskReason !== null) {
        denyReasons.push(riskReason);
      }

      // BB003: active-endpoint requirement
      const endpointReason = checkActiveEndpointExposure(
        surface.capabilityId,
        metadata,
        context
      );
      if (endpointReason !== null) {
        denyReasons.push(endpointReason);
      }

      // Extension dimensions (BB+): appended after framework dims.
      // Guard is typeof+length rather than !== null so that empty-string
      // returns (and JS undefined from an untyped host) are treated as pass,
      // matching the "non-empty reason string" contract in the interface JSDoc.
      for (const dim of this.extensionDimensions) {
        const extReason = dim.checkExposure(surface, metadata, context);
        if (typeof extReason === "string" && extReason.length > 0) {
          denyReasons.push(extReason);
        }
      }

      if (denyReasons.length > 0) {
        return {
          exposed: false,
          reason: denyReasons.join("; "),
          surfaceName: surface.name,
        };
      }

      return { exposed: true, surfaceName: surface.name };
    });
  }

  evaluateInvocation(
    binding: Binding,
    context: CapabilityPolicyContext
  ): InvocationDecision {
    // Note: maxExposedRiskClass (BB002) and requiresActiveEndpoint (BB003)
    // are exposure-time-only dimensions by design. A conforming driver only
    // calls tools it received from the filtered registry, so those checks do
    // not need to be repeated here. A driver that bypasses the filtered
    // registry is outside the threat model for this engine.
    const metadata = context.capabilityMetadata?.get(binding.capabilityId);
    const denyReasons: string[] = [];

    // Static deny-list (AW baseline)
    if (this.deniedCapabilities.has(binding.capabilityId)) {
      denyReasons.push("capability denied by invocation-time policy");
    }

    // BB001: data-residency
    const residencyReason = checkResidencyInvocation(
      binding.capabilityId,
      metadata,
      context
    );
    if (residencyReason !== null) {
      denyReasons.push(residencyReason);
    }

    // BB003: user-presence
    const presenceReason = checkUserPresenceInvocation(
      binding.capabilityId,
      metadata,
      context
    );
    if (presenceReason !== null) {
      denyReasons.push(presenceReason);
    }

    // BB004: credential-boundary
    const credentialReason = checkCredentialBoundaryInvocation(
      binding.capabilityId,
      metadata,
      context
    );
    if (credentialReason !== null) {
      denyReasons.push(credentialReason);
    }

    // Extension dimensions (BB+): appended after framework dims.
    // Same typeof+length guard as the exposure loop — see comment there.
    for (const dim of this.extensionDimensions) {
      const extReason = dim.checkInvocation(binding, metadata, context);
      if (typeof extReason === "string" && extReason.length > 0) {
        denyReasons.push(extReason);
      }
    }

    if (denyReasons.length > 0) {
      return {
        admitted: false,
        capabilityId: binding.capabilityId,
        executionClass: binding.executionClass,
        reason: denyReasons.join("; "),
      };
    }

    // BB002: risk-class approval requirement (not a denial; sets requiresApproval)
    const approvalSignal = checkRiskClassInvocation(
      binding.capabilityId,
      metadata,
      this.options
    );
    if (approvalSignal !== null) {
      return {
        admitted: true,
        capabilityId: binding.capabilityId,
        executionClass: binding.executionClass,
        reason: approvalSignal.reason,
        requiresApproval: true,
      };
    }

    return {
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

// ---------------------------------------------------------------------------
// Runtime helpers for the wired path
// ---------------------------------------------------------------------------

/**
 * Builds a capabilityMetadata map from TuvrenToolDefinition policy fields.
 * The runtime calls this once per iteration to populate the wired policy
 * context. Only tools that declare at least one BB policy field are included.
 *
 * Tuvren-client tools (detected via metadata.clientEndpointId, the same tag
 * used by isClientEndpointTool) are automatically assigned
 * requiresActiveEndpoint: true so the BB003 active-endpoint exposure check
 * fires correctly on the wired path when the client endpoint boundary reports
 * unavailability via unavailableCapabilityIds.
 */
export function buildCapabilityMetadataFromTools(
  tools: ReadonlyArray<{
    metadata?: Record<string, unknown>;
    name: string;
    nonRetryable?: boolean;
    requiredCredentialScopes?: readonly string[];
    requiredResidency?: string;
    requiresUserPresence?: boolean;
    riskClass?: "low" | "medium" | "high";
  }>
): ReadonlyMap<string, PolicyCapabilityMetadata> {
  const map = new Map<string, PolicyCapabilityMetadata>();
  for (const tool of tools) {
    const entry: PolicyCapabilityMetadata = {};
    if (tool.riskClass !== undefined) {
      entry.riskClass = tool.riskClass;
    }
    if (tool.requiredResidency !== undefined) {
      entry.requiredResidency = tool.requiredResidency;
    }
    if (tool.requiresUserPresence !== undefined) {
      entry.requiresUserPresence = tool.requiresUserPresence;
    }
    if (tool.requiredCredentialScopes !== undefined) {
      entry.requiredCredentialScopes = tool.requiredCredentialScopes;
    }
    if (tool.nonRetryable !== undefined) {
      entry.nonRetryable = tool.nonRetryable;
    }
    // Tuvren-client synthetic tools require an active endpoint to be exposed.
    // Detect them by the same metadata.clientEndpointId tag used by
    // isClientEndpointTool in the binding resolver.
    const clientEndpointId = (
      tool.metadata as { clientEndpointId?: unknown } | undefined
    )?.clientEndpointId;
    if (typeof clientEndpointId === "string" && clientEndpointId.length > 0) {
      entry.requiresActiveEndpoint = true;
    }
    if (Object.keys(entry).length > 0) {
      map.set(tool.name, entry);
    }
  }
  return map;
}
