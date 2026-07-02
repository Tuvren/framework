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
import { TuvrenRuntimeError } from "@tuvren/core";
import { CAPABILITY_BINDING_UNAVAILABLE } from "@tuvren/core/errors";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import { createBindingResolver } from "../src/lib/binding-resolver.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefineTool(name: string): TuvrenToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: "object" },
    execute: async () => ({ result: name }),
  };
}

function makeMcpToolDefinition(name: string): TuvrenToolDefinition {
  return {
    name,
    description: `mcp tool ${name}`,
    inputSchema: { type: "object" },
    execute: async () => ({ result: name }),
    // MCP tools carry metadata.mcp.serverName (added by @tuvren/mcp-client
    // during tool registration — see mcp-tool-source.ts).
    metadata: { mcp: { serverName: "mcp-server-id", originalName: name } },
  };
}

// ---------------------------------------------------------------------------
// Back-compat: defineTool → tuvren-server
// ---------------------------------------------------------------------------

describe("BindingResolver — back-compat: defineTool → tuvren-server", () => {
  test("a developer-defined defineTool resolves to executionClass tuvren-server", () => {
    const resolver = createBindingResolver();
    const tool = makeDefineTool("search");

    const binding = resolver.resolveFromToolDefinition(tool);

    expect(binding.executionClass).toBe("tuvren-server");
  });

  test("a developer-defined defineTool resolves to endpoint.kind tuvren-in-process", () => {
    const resolver = createBindingResolver();
    const tool = makeDefineTool("calculate");

    const binding = resolver.resolveFromToolDefinition(tool);

    expect(binding.endpoint.kind).toBe("tuvren-in-process");
  });

  test("the resolved binding capabilityId matches the tool name (back-compat identity)", () => {
    const resolver = createBindingResolver();
    const tool = makeDefineTool("my-tool");

    const binding = resolver.resolveFromToolDefinition(tool);

    expect(binding.capabilityId).toBe("my-tool");
  });

  test("the resolved binding endpoint.id is a stable non-secret identifier", () => {
    const resolver = createBindingResolver();
    const tool = makeDefineTool("calculator");

    const binding = resolver.resolveFromToolDefinition(tool);

    expect(typeof binding.endpoint.id).toBe("string");
    expect(binding.endpoint.id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// MCP-advertised tools → tuvren-server / mcp-server
// ---------------------------------------------------------------------------

describe("BindingResolver — MCP tools → tuvren-server / mcp-server", () => {
  test("an MCP-advertised tool resolves to executionClass tuvren-server", () => {
    const resolver = createBindingResolver();
    const mcpTool = makeMcpToolDefinition("mcp_search");

    const binding = resolver.resolveFromToolDefinition(mcpTool);

    expect(binding.executionClass).toBe("tuvren-server");
  });

  test("an MCP-advertised tool resolves to endpoint.kind mcp-server", () => {
    const resolver = createBindingResolver();
    const mcpTool = makeMcpToolDefinition("mcp_get_order");

    const binding = resolver.resolveFromToolDefinition(mcpTool);

    expect(binding.endpoint.kind).toBe("mcp-server");
  });

  test("MCP binding endpoint.id reflects the source server identifier", () => {
    const resolver = createBindingResolver();
    const mcpTool = makeMcpToolDefinition("mcp_search");

    const binding = resolver.resolveFromToolDefinition(mcpTool);

    // The endpoint id should encode which MCP server provided the tool
    expect(binding.endpoint.id).toContain("mcp-server-id");
  });
});

// ---------------------------------------------------------------------------
// Conceptual invariant: every resolution has a known execution class
// ---------------------------------------------------------------------------

describe("BindingResolver — conceptual invariant", () => {
  test("every resolved binding has a non-empty executionClass", () => {
    const resolver = createBindingResolver();
    const validClasses = new Set([
      "provider-native",
      "provider-mediated",
      "tuvren-server",
      "tuvren-client",
    ]);

    const tools = [makeDefineTool("tool-a"), makeDefineTool("tool-b")];
    for (const tool of tools) {
      const binding = resolver.resolveFromToolDefinition(tool);
      expect(validClasses.has(binding.executionClass)).toBe(true);
    }
  });

  test("every resolved binding has an endpoint with a non-empty kind", () => {
    const resolver = createBindingResolver();
    const tool = makeDefineTool("tool-x");

    const binding = resolver.resolveFromToolDefinition(tool);

    expect(typeof binding.endpoint.kind).toBe("string");
    expect(binding.endpoint.kind.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// registerBinding / resolveById round-trip
// ---------------------------------------------------------------------------

describe("BindingResolver — registerBinding / resolveById round-trip", () => {
  test("a registered binding is returned by resolveById", () => {
    const resolver = createBindingResolver();
    const binding = {
      capabilityId: "provider.search",
      executionClass: "provider-native" as const,
      endpoint: { kind: "provider-runtime" as const, id: "openai" },
    };

    resolver.registerBinding(binding);
    const resolved = resolver.resolveById("provider.search");

    expect(resolved.capabilityId).toBe("provider.search");
    expect(resolved.executionClass).toBe("provider-native");
    expect(resolved.endpoint.kind).toBe("provider-runtime");
    expect(resolved.endpoint.id).toBe("openai");
  });

  test("resolveById returns a defensive copy, not the original binding object", () => {
    const resolver = createBindingResolver();
    const binding = {
      capabilityId: "web.search",
      executionClass: "tuvren-server" as const,
      endpoint: { kind: "tuvren-in-process" as const, id: "local" },
    };

    resolver.registerBinding(binding);
    const resolved = resolver.resolveById("web.search");

    // Mutating the returned binding should not affect subsequent reads
    (resolved as { capabilityId: string }).capabilityId = "mutated";
    const resolved2 = resolver.resolveById("web.search");
    expect(resolved2.capabilityId).toBe("web.search");
  });

  test("a second registerBinding for the same capabilityId overwrites the previous", () => {
    const resolver = createBindingResolver();
    resolver.registerBinding({
      capabilityId: "code.execute",
      executionClass: "tuvren-server" as const,
      endpoint: { kind: "tuvren-in-process" as const, id: "local" },
    });
    resolver.registerBinding({
      capabilityId: "code.execute",
      executionClass: "tuvren-client" as const,
      endpoint: { kind: "client-endpoint" as const, id: "browser-ext" },
    });

    const resolved = resolver.resolveById("code.execute");
    expect(resolved.executionClass).toBe("tuvren-client");
  });
});

// ---------------------------------------------------------------------------
// Unavailable binding → capability_binding_unavailable error
// ---------------------------------------------------------------------------

describe("BindingResolver — unavailable binding", () => {
  test("resolveById throws TuvrenRuntimeError with capability_binding_unavailable when no binding is registered", () => {
    const resolver = createBindingResolver();

    expect(() => resolver.resolveById("nonexistent-capability")).toThrow(
      TuvrenRuntimeError
    );
  });

  test("resolveById throws with code capability_binding_unavailable", () => {
    const resolver = createBindingResolver();

    let caught: unknown;
    try {
      resolver.resolveById("unknown-cap");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TuvrenRuntimeError);
    expect((caught as TuvrenRuntimeError).code).toBe(
      CAPABILITY_BINDING_UNAVAILABLE
    );
  });

  test("CAPABILITY_BINDING_UNAVAILABLE constant is the string capability_binding_unavailable", () => {
    expect(CAPABILITY_BINDING_UNAVAILABLE).toBe(
      "capability_binding_unavailable"
    );
  });
});
