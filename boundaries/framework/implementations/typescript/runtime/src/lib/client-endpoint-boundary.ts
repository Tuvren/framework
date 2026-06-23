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
        if (this.capabilityIndex.has(cap.capabilityId)) {
          // Duplicate capabilityId across endpoints would silently overwrite the
          // boundary index while causing the tool registry to throw
          // duplicate_tool_registration at turn time. Fail fast here instead.
          throw new TuvrenRuntimeError(
            `Tuvren-client capability ID "${cap.capabilityId}" is advertised by more than one endpoint. Capability IDs must be globally unique across all attached endpoints.`,
            {
              code: "invalid_runtime_options",
              details: { capabilityId: cap.capabilityId },
            }
          );
        }
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
    input: unknown,
    idempotencyKey?: string
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
    // leaseToken encodes capabilityId, callId, and a per-boundary counter. The
    // counter is in-memory only; after a process restart with a fresh boundary
    // it resets to 0. Staleness is therefore guaranteed by callId uniqueness
    // (runtime-generated per invocation), not by the counter alone — a reset
    // counter with a matching callId requires an astronomically unlikely
    // collision across process lifetimes.
    // The token is COMPARE-ONLY and is never parsed back into components;
    // do not add a parser without re-escaping the interpolated fields.
    const leaseToken = `${capabilityId}:${callId}:${this.leaseCounter}`;

    let reported: import("@tuvren/core/capabilities").ClientReportedResult;
    try {
      reported = await entry.endpoint.dispatch({
        callId,
        capabilityId,
        // Side-effect-once identity (ADR-052): carried on the envelope so the
        // client environment can deduplicate a retried external effect. Omitted
        // from the field set when absent so the envelope stays minimal.
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        input,
        leaseToken,
      });
    } catch (err) {
      // Convert a thrown endpoint rejection into an isError result. Client
      // endpoints should surface failures via ClientReportedResult{isError:true}
      // but throwing is a realistic failure mode (network error, client crash).
      // Catching here ensures the turn surfaces a typed tuvren-client error
      // ToolResultPart rather than a generic execution-failure. (KRT-AZ002)
      //
      // NOTE: err.message is host-controlled and enters durable lineage
      // unscrubbed. The secret-isolation contract is a host responsibility —
      // the runtime does not validate or redact the thrown message content.
      reported = {
        callId,
        content: {
          error: err instanceof Error ? err.message : String(err),
        },
        isError: true,
        leaseToken,
      };
    }

    // Stale-result guard: if the client echoes back the wrong token or callId
    // this result was produced for a previous invocation and must not mutate
    // the current one. leaseToken already encodes callId, but we validate both
    // explicitly for defense in depth. (KRT-AZ003)
    //
    // This is the client-endpoint lease (availability/staleness of THIS
    // dispatch). It is deliberately distinct from — and composes with, never
    // conflated with — the run execution lease (write authority): the
    // client-result-as-proposal run-fencing gate lives at the tool-execution
    // seam (tool-registry synthetic execute + the commit-under-valid-authority
    // staging gate), which rejects a result that returns after the run lost
    // write authority even when this per-dispatch token matches. (KRT-BG004)
    if (reported.leaseToken !== leaseToken || reported.callId !== callId) {
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
