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
import type {
  AttachedClientEndpoint,
  Binding,
} from "@tuvren/core/capabilities";
import { CAPABILITY_BINDING_UNAVAILABLE } from "@tuvren/core/errors";

/**
 * The resolved dispatch result: the client-reported content and whether the
 * client treated the invocation as an error.
 */
export interface ClientDispatchResult {
  content: unknown;
  isError: boolean;
}

/**
 * Runtime boundary for the Tuvren-client execution class (KRT-AZ001 / §4.21).
 *
 * Orchestrates capability invocations against attached client endpoints:
 * - Tracks which endpoint advertises which capability.
 * - Dispatches an invocation envelope with a monotonic leaseToken.
 * - Validates the echoed leaseToken on the result to detect stale late-completions.
 * - Returns null when the result is stale (mismatched token) rather than
 *   mutating the in-flight invocation.
 *
 * No credentials or environment secrets enter this boundary. The Binding it
 * produces never carries secret material.
 */
export interface ClientEndpointBoundary {
  /** Whether any attached endpoint advertises the given capabilityId. */
  isAvailable(capabilityId: string): boolean;

  /**
   * Resolve a Binding for a capabilityId.
   * Returns undefined when no endpoint advertises the capability.
   */
  resolveBinding(capabilityId: string): Binding | undefined;

  /**
   * Dispatch a capability invocation to the attached endpoint.
   *
   * Generates a fresh leaseToken for the envelope and validates the token in
   * the client-reported result. Returns:
   * - A ClientDispatchResult when the result is valid (leaseToken matches and
   *   the endpoint is still attached).
   * - null when the result is stale (token mismatch) — the caller must NOT
   *   surface null as a successful result.
   *
   * Throws TuvrenRuntimeError(capability_binding_unavailable) when no endpoint
   * is attached for the capability at dispatch time.
   */
  dispatch(
    capabilityId: string,
    callId: string,
    input: unknown
  ): Promise<ClientDispatchResult | null>;
}

// ---------------------------------------------------------------------------
// Internal capability-to-endpoint index entry
// ---------------------------------------------------------------------------

interface EndpointCapabilityEntry {
  endpoint: AttachedClientEndpoint;
  mcpServerName?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class BasicClientEndpointBoundary implements ClientEndpointBoundary {
  private readonly capabilityIndex = new Map<string, EndpointCapabilityEntry>();
  /** Monotonically incremented to generate unique per-dispatch lease tokens. */
  private leaseCounter = 0;

  constructor(endpoints: AttachedClientEndpoint[]) {
    for (const endpoint of endpoints) {
      for (const cap of endpoint.advertisedCapabilities) {
        this.capabilityIndex.set(cap.capabilityId, {
          endpoint,
          mcpServerName: cap.mcpServerName,
        });
      }
    }
  }

  isAvailable(capabilityId: string): boolean {
    return this.capabilityIndex.has(capabilityId);
  }

  resolveBinding(capabilityId: string): Binding | undefined {
    const entry = this.capabilityIndex.get(capabilityId);
    if (entry === undefined) return undefined;

    const { endpoint, mcpServerName } = entry;

    if (mcpServerName !== undefined) {
      return {
        capabilityId,
        endpoint: {
          // Client-side MCP: client runs the MCP server, so endpoint kind is
          // "mcp-server" under the tuvren-client execution class — never
          // reclassified as tuvren-server or provider-mediated. (KRT-AZ004)
          id: `client-mcp:${endpoint.endpointId}:${mcpServerName}`,
          kind: "mcp-server",
        },
        executionClass: "tuvren-client",
      };
    }

    return {
      capabilityId,
      endpoint: {
        id: `client-endpoint:${endpoint.endpointId}`,
        kind: "client-endpoint",
      },
      executionClass: "tuvren-client",
    };
  }

  async dispatch(
    capabilityId: string,
    callId: string,
    input: unknown
  ): Promise<ClientDispatchResult | null> {
    const entry = this.capabilityIndex.get(capabilityId);
    if (entry === undefined) {
      // Availability is checked before dispatch in the tool execute closure;
      // this path is a safety net for direct callers.
      throw new TuvrenRuntimeError(
        `Tuvren-client capability "${capabilityId}" has no attached endpoint.`,
        { code: CAPABILITY_BINDING_UNAVAILABLE, details: { capabilityId } }
      );
    }

    this.leaseCounter += 1;
    const leaseToken = `${capabilityId}:${callId}:${this.leaseCounter}`;

    const reported = await entry.endpoint.dispatch({
      callId,
      capabilityId,
      input,
      leaseToken,
    });

    // Stale-result guard: if the client echoes back the wrong token this
    // result was produced for a previous invocation and must not mutate the
    // current one. (KRT-AZ003)
    if (reported.leaseToken !== leaseToken) {
      return null;
    }

    return {
      content: reported.content,
      isError: reported.isError === true,
    };
  }
}

export function createClientEndpointBoundary(
  endpoints: AttachedClientEndpoint[]
): ClientEndpointBoundary {
  return new BasicClientEndpointBoundary(endpoints);
}
