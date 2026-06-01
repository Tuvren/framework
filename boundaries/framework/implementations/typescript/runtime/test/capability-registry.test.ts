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

import { describe, expect, test } from "bun:test";
import type { Capability, ToolSurface } from "@tuvren/core/capabilities";
import { createCapabilityRegistry } from "../src/lib/capability-registry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapability(id: string): Capability {
  return { id };
}

function makeSurface(name: string, capabilityId: string): ToolSurface {
  return {
    name,
    description: `surface for ${capabilityId}`,
    inputSchema: { type: "object" },
    capabilityId,
  };
}

// ---------------------------------------------------------------------------
// Surface-vs-capability separation
// ---------------------------------------------------------------------------

describe("CapabilityRegistry — surface vs capability separation", () => {
  test("registered surface and its backing capability are distinct objects", () => {
    const registry = createCapabilityRegistry();
    const cap = makeCapability("web.search");
    const surface = makeSurface("search", "web.search");

    registry.registerCapability(cap);
    registry.registerSurface(surface);

    const caps = registry.getCapabilities();
    const surfaces = registry.getEligibleSurfaces();

    expect(caps).toHaveLength(1);
    expect(surfaces).toHaveLength(1);
    // Different objects
    expect(caps[0]).not.toBe(surfaces[0]);
    // Surface references capability by id, not by value equality
    expect(surfaces[0]?.capabilityId).toBe("web.search");
    expect(caps[0]?.id).toBe("web.search");
  });

  test("registering a capability does not automatically create a surface", () => {
    const registry = createCapabilityRegistry();
    registry.registerCapability(makeCapability("code.execute"));

    expect(registry.getCapabilities()).toHaveLength(1);
    expect(registry.getEligibleSurfaces()).toHaveLength(0);
  });

  test("registering a surface does not automatically create a capability", () => {
    const registry = createCapabilityRegistry();
    registry.registerSurface(makeSurface("executor", "code.execute"));

    expect(registry.getEligibleSurfaces()).toHaveLength(1);
    expect(registry.getCapabilities()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// One capability can back multiple surfaces
// ---------------------------------------------------------------------------

describe("CapabilityRegistry — one capability, multiple surfaces", () => {
  test("a single capability can be backed by multiple model-facing surfaces", () => {
    const registry = createCapabilityRegistry();
    const cap = makeCapability("web.search");
    const surfaceA = makeSurface("web_search", "web.search");
    const surfaceB = makeSurface("search_web", "web.search");

    registry.registerCapability(cap);
    registry.registerSurface(surfaceA);
    registry.registerSurface(surfaceB);

    const surfaces = registry.getEligibleSurfaces();
    expect(surfaces).toHaveLength(2);
    for (const s of surfaces) {
      expect(s.capabilityId).toBe("web.search");
    }
    const caps = registry.getCapabilities();
    expect(caps).toHaveLength(1);
  });

  test("getCapabilityById returns the capability when registered", () => {
    const registry = createCapabilityRegistry();
    registry.registerCapability(makeCapability("crm.lookup"));

    const found = registry.getCapabilityById("crm.lookup");
    expect(found).toBeDefined();
    expect(found?.id).toBe("crm.lookup");
  });

  test("getCapabilityById returns undefined when not registered", () => {
    const registry = createCapabilityRegistry();
    expect(registry.getCapabilityById("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Eligible-surface candidate set (pre-policy)
// ---------------------------------------------------------------------------

describe("CapabilityRegistry — eligible surface candidate set", () => {
  test("getEligibleSurfaces returns all registered surfaces (pre-policy)", () => {
    const registry = createCapabilityRegistry();
    registry.registerCapability(makeCapability("web.search"));
    registry.registerCapability(makeCapability("code.execute"));
    registry.registerSurface(makeSurface("search", "web.search"));
    registry.registerSurface(makeSurface("execute", "code.execute"));

    const surfaces = registry.getEligibleSurfaces();
    expect(surfaces).toHaveLength(2);
    const names = surfaces.map((s) => s.name);
    expect(names).toContain("search");
    expect(names).toContain("execute");
  });

  test("getSurfacesForCapability returns only surfaces for the given capability id", () => {
    const registry = createCapabilityRegistry();
    registry.registerCapability(makeCapability("web.search"));
    registry.registerCapability(makeCapability("code.execute"));
    registry.registerSurface(makeSurface("search_v1", "web.search"));
    registry.registerSurface(makeSurface("search_v2", "web.search"));
    registry.registerSurface(makeSurface("exec", "code.execute"));

    const searchSurfaces = registry.getSurfacesForCapability("web.search");
    expect(searchSurfaces).toHaveLength(2);
    for (const s of searchSurfaces) {
      expect(s.capabilityId).toBe("web.search");
    }

    const execSurfaces = registry.getSurfacesForCapability("code.execute");
    expect(execSurfaces).toHaveLength(1);
  });

  test("empty registry returns empty eligible surface set", () => {
    const registry = createCapabilityRegistry();
    expect(registry.getEligibleSurfaces()).toHaveLength(0);
  });

  test("registering the same surface name twice throws", () => {
    const registry = createCapabilityRegistry();
    registry.registerSurface(makeSurface("search", "web.search"));
    expect(() =>
      registry.registerSurface(makeSurface("search", "web.search"))
    ).toThrow();
  });

  test("registering the same capability id twice throws", () => {
    const registry = createCapabilityRegistry();
    registry.registerCapability(makeCapability("web.search"));
    expect(() =>
      registry.registerCapability(makeCapability("web.search"))
    ).toThrow();
  });
});
