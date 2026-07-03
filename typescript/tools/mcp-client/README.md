# @tuvren/mcp-client

A first-class Model Context Protocol (MCP) tool source for the Tuvren runtime. It
connects to an MCP server over `stdio` or `http-sse`, lists the server's tools,
and exposes them as Tuvren tool definitions the runtime can invoke.

## Secret Isolation — Edge Confinement (ADR-044)

MCP credentials are **confined to the integration edge**. They live only inside
this package's transport and are never copied onto any runtime surface that can
be observed, persisted, or replayed.

Credentials accepted by this package:

- `McpAuth` bearer-auth tokens (`{ kind: "bearer", token }`).
- `McpAuth` header-auth values (`{ kind: "header", name, value }`).
- Any secret-bearing transport `headers` and `stdio` `env` values.

These values are used only to authenticate the transport connection to the MCP
server. They are **never**:

- written to kernel records or any durable state,
- placed on canonical stream events (`tool.start`, `tool.result`, …),
- placed on `TelemetrySpan` / `TelemetryEvent` attributes, or
- serialized into REPL transcripts.

The Kernel Boundary, Durable State Boundary, Telemetry & Observability Boundary,
the canonical event stream, and transcript surfaces are credential-free zones.
Tool inputs and results that flow through the runtime carry no MCP auth material.

This guarantee is verified — not assumed. The `secret-isolation` conformance
check set (KRT-BD004) configures representative MCP bearer-auth and header-auth
secrets, runs a turn, and uses a shared runner-owned secret-absence helper to
recursively scan the persisted records, stream events, telemetry, and transcript
for those secrets and their common encoded variants.

## Usage

```ts
import { createMcpToolSource } from "@tuvren/mcp-client";

const source = await createMcpToolSource({
  name: "docs",
  transport: "http-sse",
  endpoint: "https://mcp.example.com/sse",
  auth: { kind: "bearer", token: process.env.MCP_TOKEN! },
});
try {
  // source.tools are Tuvren tool definitions; credentials stay at this edge.
} finally {
  await source.close();
}
```
