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
  ClientDispatchResult,
  ClientEndpointBoundary,
} from "@tuvren/core/capabilities";
import { CAPABILITY_BINDING_UNAVAILABLE } from "@tuvren/core/errors";

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

  detach(endpointId: string): void {
    for (const [capabilityId, entry] of this.capabilityIndex) {
      if (entry.endpoint.endpointId === endpointId) {
        this.capabilityIndex.delete(capabilityId);
      }
    }
  }

  isAvailable(capabilityId: string): boolean {
    return this.capabilityIndex.has(capabilityId);
  }

  resolveBinding(capabilityId: string): Binding | undefined {
    const entry = this.capabilityIndex.get(capabilityId);
    if (entry === undefined) {
      return undefined;
    }

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
