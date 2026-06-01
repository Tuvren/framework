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

import { TuvrenRuntimeError } from "@tuvren/core";
import type { Capability, ToolSurface } from "@tuvren/core/capabilities";

/**
 * Holds capabilities and the model-facing tool surfaces that present them.
 *
 * Invariants:
 * - A ToolSurface is distinct from its backing Capability; one Capability may
 *   back multiple ToolSurfaces.
 * - `getEligibleSurfaces()` returns the pre-policy candidate set for an agent
 *   segment. Policy (exposure-time withholding) is applied by the Capability
 *   Policy Engine, not here.
 */
export interface CapabilityRegistry {
  /** Return all registered capabilities. */
  getCapabilities(): Capability[];
  /** Look up a capability by id. */
  getCapabilityById(id: string): Capability | undefined;
  /** Return all registered tool surfaces (pre-policy eligible set). */
  getEligibleSurfaces(): ToolSurface[];
  /** Return all registered surfaces for a given capability id. */
  getSurfacesForCapability(capabilityId: string): ToolSurface[];
  /** Register a capability. Throws on duplicate id. */
  registerCapability(capability: Capability): void;
  /** Register a tool surface. Throws on duplicate name. */
  registerSurface(surface: ToolSurface): void;
}

class BasicCapabilityRegistry implements CapabilityRegistry {
  private readonly capabilities = new Map<string, Capability>();
  private readonly surfaces = new Map<string, ToolSurface>();

  registerCapability(capability: Capability): void {
    if (this.capabilities.has(capability.id)) {
      throw new TuvrenRuntimeError(
        `capability "${capability.id}" is already registered`,
        {
          code: "duplicate_capability_registration",
          details: { capabilityId: capability.id },
        }
      );
    }
    this.capabilities.set(capability.id, { ...capability });
  }

  registerSurface(surface: ToolSurface): void {
    if (this.surfaces.has(surface.name)) {
      throw new TuvrenRuntimeError(
        `tool surface "${surface.name}" is already registered`,
        {
          code: "duplicate_surface_registration",
          details: { surfaceName: surface.name },
        }
      );
    }
    this.surfaces.set(surface.name, { ...surface });
  }

  getCapabilities(): Capability[] {
    return [...this.capabilities.values()].map((c) => ({ ...c }));
  }

  getCapabilityById(id: string): Capability | undefined {
    const cap = this.capabilities.get(id);
    return cap ? { ...cap } : undefined;
  }

  getEligibleSurfaces(): ToolSurface[] {
    return [...this.surfaces.values()].map((s) => ({ ...s }));
  }

  getSurfacesForCapability(capabilityId: string): ToolSurface[] {
    return [...this.surfaces.values()]
      .filter((s) => s.capabilityId === capabilityId)
      .map((s) => ({ ...s }));
  }
}

export function createCapabilityRegistry(): CapabilityRegistry {
  return new BasicCapabilityRegistry();
}
