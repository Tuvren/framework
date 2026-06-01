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
  ToolSurface,
} from "@tuvren/core/capabilities";

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

class BasicCapabilityPolicyEngine implements CapabilityPolicyEngine {
  private readonly deniedCapabilities: ReadonlySet<string>;
  private readonly deniedSurfaces: ReadonlySet<string>;

  constructor(options: CapabilityPolicyEngineOptions) {
    this.deniedCapabilities = options.deniedCapabilityIds ?? new Set();
    this.deniedSurfaces = options.deniedSurfaceNames ?? new Set();
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
