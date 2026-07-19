# Tuvren-Client Integration Contract

This document describes what a host-developer must implement to attach a conforming client endpoint to a runtime instance. Concrete endpoints (browser extensions, desktop apps, device agents, client-side MCP runners) are **host-developer deliverables** — the runtime only needs the interface described here to orchestrate, lease, and observe client-side execution.

## What the Runtime Provides

The runtime owns orchestration and policy. The client endpoint owns environmental execution and may hold authority the server does not (for example, browser DOM access, user credentials, local device capabilities).

When a capability invocation is admitted by policy:

1. The runtime constructs a `ClientInvocationEnvelope` carrying `callId`, `capabilityId`, `input`, and a non-secret `leaseToken`.
2. The runtime calls `endpoint.dispatch(envelope)` and awaits the `Promise<ClientReportedResult>`.
3. The client-reported result is recorded as a canonical `tool.result` event with `owner: "tuvren"` and the `tuvren-client` partial-observability limits.

## Interface: `AttachedClientEndpoint`

```ts
import type {
  AttachedClientEndpoint,
  ClientEndpointCapabilityAdvertisement,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
```

### `endpointId: string`

A stable, non-secret identifier for the endpoint. Used by the lease model and surfaced in binding endpoint IDs.

### `advertisedCapabilities: ClientEndpointCapabilityAdvertisement[]`

The capabilities this endpoint can execute, declared at attach time. Each entry must provide:

| Field | Type | Description |
|---|---|---|
| `capabilityId` | `string` | Stable capability identifier (e.g. `"browser.screenshot"`). |
| `description` | `string` | Human-readable capability description. |
| `inputSchema` | `TuvrenJsonSchema` | JSON Schema for the input the runtime will dispatch. |
| `mcpServerName?` | `string` | Optional. When set, this capability is a **client-side MCP** tool — the endpoint invokes or runs an MCP server. The binding will use `endpoint.kind === "mcp-server"` under the `tuvren-client` execution class. |

### `dispatch(envelope: ClientInvocationEnvelope): Promise<ClientReportedResult>`

The runtime calls this once per admitted invocation. The endpoint must:

1. Execute the capability in the client environment.
2. **Echo back the `leaseToken` exactly** as received in the envelope. A mismatched or stale token causes the runtime to treat the result as a stale late-completion and ignore it (it will not mutate the in-flight invocation).
3. Return a `ClientReportedResult`:
   - `callId`: echo from the envelope.
   - `content`: the result payload (no credentials or secrets — this enters durable lineage).
   - `isError?: boolean`: set to `true` when the execution produced an error.
   - `leaseToken`: **must match** `envelope.leaseToken` exactly.

> **Error handling:** Surface failures by returning `ClientReportedResult{ isError: true, content: { error: "..." } }`. Do **not** throw or reject the returned `Promise` — while the runtime catches thrown rejections and converts them to typed `tuvren-client` error results, throwing is a lower-fidelity path: the `content` becomes `{ error: "<message>" }` without a `code` field (unlike the `{ code, error }` shape used by runtime-side errors such as `capability_binding_unavailable`), and the result is harder to distinguish from other error conditions at the model or operator level. Return `isError: true` to give the model actionable, consistently-shaped error context.

```ts
export interface ClientInvocationEnvelope {
  callId: string;
  capabilityId: string;
  input: unknown;
  leaseToken: string;   // echo this back in ClientReportedResult
}

export interface ClientReportedResult {
  callId: string;
  content: unknown;     // must not carry credentials or secrets
  isError?: boolean;
  leaseToken: string;   // must match envelope.leaseToken
}
```

## Lease Lifecycle

The runtime tracks endpoint availability through a `ClientEndpointBoundary`. A capability is **available** when its endpoint is present in `AgentConfig.clientEndpoints`. The lifecycle is:

1. **Attach**: Pass the endpoint in `AgentConfig.clientEndpoints`. The runtime registers its advertised capabilities as `tuvren-client` bindings.
2. **Available**: Each dispatch call succeeds while the endpoint remains attached.
3. **Detach**: Call `boundary.detach(endpointId)` on the `ClientEndpointBoundary` to remove the endpoint. Subsequent invocations to those capabilities yield a typed `capability_binding_unavailable` result rather than dispatching.

Hosts that need dynamic lifecycle control (endpoint becomes unavailable mid-turn) should pre-create a boundary via `createClientEndpointBoundary([endpoint])` from `@tuvren/runtime`, call `detach()` as needed, and pass it as `AgentConfig.clientEndpointBoundary`.

> **Note:** `clientEndpoints` and `clientEndpointBoundary` serve distinct roles. `clientEndpoints` registers the capability surface in the tool registry so the model can see and call those tools. `clientEndpointBoundary` governs dispatch availability at invocation time. Supplying only `clientEndpointBoundary` without `clientEndpoints` produces a valid boundary but zero registered tools — the model has no visibility of the capabilities. Always supply both when using the explicit lifecycle pattern (see Option B in the configuration summary below).

> **Durability note:** `detach()` state is process-local. The `ClientEndpointBoundary` is an in-memory object; if the runtime pauses durably and resumes in a new process, the boundary is reconstructed from `AgentConfig.clientEndpoints` rather than restoring the in-memory instance. Any `detach()` calls made before the durable pause are not replayed on resume. If permanent revocation across process restarts is required, remove the endpoint from `clientEndpoints` before resuming.

## Client-Side MCP Binding

When an advertised capability includes `mcpServerName`, the runtime classifies it as a **client-side MCP** tool:

- Binding: `{ executionClass: "tuvren-client", endpoint: { kind: "mcp-server", id: "client-mcp:<endpointId>:<serverName>" } }`
- Dispatch goes through the same `dispatch(envelope)` path — the client endpoint is responsible for running the actual MCP invocation against the server.
- The runtime never reclassifies it as `tuvren-server` or `provider-mediated`.

## Observation Limits

For the `tuvren-client` execution class, the runtime's observation is partial:

| Affordance | Value |
|---|---|
| `canPersistResult` | `true` — the client-reported result enters durable lineage |
| `canAudit` | `false` — no `tool.audit` events |
| `canCancel` | `false` — the runtime cannot cancel client-side execution |
| `canRetry` | `false` — the runtime does not retry client invocations |
| `canResume` | `false` |
| `canObserveIntermediate` | `false` — only the dispatch/result envelope is observable |

`tool.start` and `tool.result` events are still emitted so the host event stream reflects the invocation.

## Secret Isolation

No credentials or environment secrets should appear in:

- `ClientInvocationEnvelope.input` (unless explicitly required by the capability and scoped to the client edge)
- `ClientReportedResult.content`

These values enter durable lineage. The runtime never injects provider credentials, MCP auth tokens, or other secrets into the dispatch envelope.

## Reference Implementation

The conformance mock endpoint used in the `tuvren-client-execution-class` conformance check set serves as a minimal reference implementation:

- Source: `typescript/conformance-adapter/src/framework-adapter-tuvren-client-execution-class.ts`
- Functions: `makeOkEndpoint`, `makeClientMcpEndpoint`, `makeStaleEndpoint`

These helpers show the minimal `dispatch` implementation that the runtime expects from a conforming client endpoint.

## Wire-Level Counterpart: the Duplex Session Sub-Surface

Everything above describes the **in-process** attachment contract: the host
process holds the `AttachedClientEndpoint` object and the runtime calls its
`dispatch` directly. When the client is a *remote* peer (browser extension,
mobile client, any process reached over a wire), the framework-owned wire
form of this same exchange is the duplex session sub-surface at
`spec/host/session/` (packet `tuvren.framework.host-session`, ADR-060): the
runtime's dispatch becomes an outbound `client_invocation` frame carrying
the `ClientInvocationEnvelope`, and the client's report becomes an inbound
`client_result` frame. The lease semantics documented here are unchanged —
the session layer adds only frame schemas and a second, outer staleness
check (a `client_result` matching no pending dispatch), while the
per-dispatch `leaseToken` echo check remains the boundary's own. The
TypeScript reference binding is `@tuvren/host-session`
(`typescript/host/session`); network transport, timeout, and disconnect
policy remain host concerns (issues #100/#102).

## Configuration Summary

```ts
import { createClientEndpointBoundary } from "@tuvren/runtime";
import type { AttachedClientEndpoint } from "@tuvren/core/capabilities";

const myEndpoint: AttachedClientEndpoint = {
  endpointId: "my-browser-extension",
  advertisedCapabilities: [
    {
      capabilityId: "browser.screenshot",
      description: "Capture the current browser tab screenshot",
      inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
    },
    {
      capabilityId: "browser.shopify.search_products",
      description: "Search products via the Shopify MCP server",
      inputSchema: { type: "object" },
      mcpServerName: "shopify",   // client-side MCP: endpoint runs the MCP server
    },
  ],
  async dispatch(envelope) {
    // Execute in the client environment (browser extension, desktop app, etc.)
    const result = await executeInClientContext(envelope.capabilityId, envelope.input);
    return {
      callId: envelope.callId,
      content: result,
      leaseToken: envelope.leaseToken,  // must echo back exactly
    };
  },
};

// Option A: pass endpoint directly (boundary created automatically)
const agentConfig = {
  name: "my-agent",
  clientEndpoints: [myEndpoint],
};

// Option B: manage lifecycle explicitly (for dynamic detach)
const boundary = createClientEndpointBoundary([myEndpoint]);
// ... later, if the extension disconnects:
boundary.detach("my-browser-extension");

const agentConfigWithBoundary = {
  name: "my-agent",
  clientEndpoints: [myEndpoint],      // registers capabilities in the tool registry
  clientEndpointBoundary: boundary,   // governs availability at dispatch time
};
```
