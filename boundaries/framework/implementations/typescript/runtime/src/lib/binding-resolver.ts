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
import type { Binding } from "@tuvren/core/capabilities";
import { CAPABILITY_BINDING_UNAVAILABLE } from "@tuvren/core/errors";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";

/** Stable in-process endpoint id for the Tuvren server execution class. */
const TUVREN_IN_PROCESS_ENDPOINT_ID = "tuvren.in-process";

/**
 * Stable sandbox-endpoint id prefix. The full id is
 * `sandbox:<endpointId>` where endpointId is the value from
 * `tool.metadata.sandbox.endpointId`. (AX004)
 */
export const TUVREN_SANDBOX_ENDPOINT_ID_PREFIX = "sandbox:";

/**
 * Resolves capabilities to their Binding (execution class + endpoint).
 *
 * ADR-047 back-compat rules:
 * - A `TuvrenToolDefinition` with `execute` is a `tuvren-server` binding to
 *   the in-process endpoint (`endpoint.kind === "tuvren-in-process"`).
 * - An MCP-advertised tool (detected via `metadata.mcp.serverName`) is a
 *   `tuvren-server` binding to an `mcp-server` endpoint. Tuvren runs the MCP
 *   client server-side, so the execution class is still `tuvren-server`.
 *
 * The conceptual invariant: every resolved binding has a known ExecutionClass
 * and a concrete Endpoint. There is no unclassified tool call.
 */
export interface BindingResolver {
  /** Register a manually-supplied binding (used by provider/client classes). */
  registerBinding(binding: Binding): void;

  /**
   * Resolve by capability id from the registered binding table.
   * Throws `TuvrenRuntimeError` with code `capability_binding_unavailable`
   * when no binding is registered for the given id.
   */
  resolveById(capabilityId: string): Binding;
  /**
   * Resolve a TuvrenToolDefinition to its Binding.
   * Never throws; every developer-defined tool is resolvable.
   */
  resolveFromToolDefinition(tool: TuvrenToolDefinition): Binding;
}

class BasicBindingResolver implements BindingResolver {
  private readonly bindings = new Map<string, Binding>();

  resolveFromToolDefinition(tool: TuvrenToolDefinition): Binding {
    const mcpServerName = extractMcpServerName(tool);

    if (mcpServerName !== undefined) {
      const binding: Binding = {
        capabilityId: tool.name,
        endpoint: {
          id: `mcp-server:${mcpServerName}`,
          kind: "mcp-server",
        },
        executionClass: "tuvren-server",
      };
      return binding;
    }

    const sandboxEndpointId = extractSandboxEndpointId(tool);

    if (sandboxEndpointId !== undefined) {
      return {
        capabilityId: tool.name,
        endpoint: {
          id: `${TUVREN_SANDBOX_ENDPOINT_ID_PREFIX}${sandboxEndpointId}`,
          kind: "tuvren-sandbox",
        },
        executionClass: "tuvren-server",
      };
    }

    // Developer-defined execute tool → tuvren-server / tuvren-in-process
    return {
      capabilityId: tool.name,
      endpoint: {
        id: TUVREN_IN_PROCESS_ENDPOINT_ID,
        kind: "tuvren-in-process",
      },
      executionClass: "tuvren-server",
    };
  }

  resolveById(capabilityId: string): Binding {
    const binding = this.bindings.get(capabilityId);
    if (binding === undefined) {
      throw new TuvrenRuntimeError(
        `no binding registered for capability "${capabilityId}"`,
        {
          code: CAPABILITY_BINDING_UNAVAILABLE,
          details: { capabilityId },
        }
      );
    }
    return { ...binding };
  }

  registerBinding(binding: Binding): void {
    this.bindings.set(binding.capabilityId, { ...binding });
  }
}

export function createBindingResolver(): BindingResolver {
  return new BasicBindingResolver();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractMcpServerName(tool: TuvrenToolDefinition): string | undefined {
  const meta = tool.metadata as { mcp?: { serverName?: string } } | undefined;
  const serverName = meta?.mcp?.serverName;
  return typeof serverName === "string" && serverName.length > 0
    ? serverName
    : undefined;
}

function extractSandboxEndpointId(
  tool: TuvrenToolDefinition
): string | undefined {
  const meta = tool.metadata as
    | { sandbox?: { endpointId?: string } }
    | undefined;
  const endpointId = meta?.sandbox?.endpointId;
  return typeof endpointId === "string" && endpointId.length > 0
    ? endpointId
    : undefined;
}
