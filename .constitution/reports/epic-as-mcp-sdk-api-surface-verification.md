# Epic AS MCP SDK API Surface Verification

This is the KRT-AS001 live support artifact for the MCP Client Container.
It records the current upstream MCP SDK surface used by
`@tuvren/mcp-client` and the test fixture choices made for Epic AS.

## Verified SDK Surface

- Package: `@modelcontextprotocol/sdk@1.29.0`.
- Client core: the SDK exposes a shared `Client` implementation with
  `connect`, `listTools`, `callTool`, `close`, and server-version access.
- Stdio transport: `StdioClientTransport` is available and used for
  `transport: "stdio"`.
- HTTP transport: `StreamableHTTPClientTransport` is available and used for
  Tuvren's public `transport: "http-sse"` lane.
- Deprecated SSE: the SDK still exposes an SSE transport, but Epic AS does not
  use it. The implementation intentionally maps the public legacy
  `"http-sse"` configuration name to non-deprecated Streamable HTTP.
- Tool advertisements: MCP tool metadata includes `name`, optional
  `description`, `inputSchema`, optional `outputSchema`, and optional
  `annotations`; the Tuvren projection only treats those advertised fields as
  translation input.

## Dependency Notes

- `@tuvren/mcp-client` carries direct dependencies on
  `@modelcontextprotocol/sdk@1.29.0`, `zod@4.4.3`, and `ajv@8.18.0`.
- `zod@4.4.3` is a direct package dependency because the upstream SDK package
  metadata declares `zod` as a non-optional peer as well as a runtime
  dependency. It is not exposed as a Tuvren public peer.
- `@tuvren/core` remains the only Tuvren peer for `@tuvren/mcp-client`.

## Test Implementation Choice

- Official fixture: `@modelcontextprotocol/server-everything@2026.1.26`.
- The provider testkit exposes helpers for the official everything server over
  stdio and Streamable HTTP so the MCP conformance parity check exercises a
  real upstream implementation in both transport modes.
- A small in-repo mock MCP server remains in the provider testkit for
  Tuvren-specific cases the official fixture does not cover directly:
  auth-header verification, intentionally invalid output, and controlled
  transport-close failure injection.

## Local Verification

- `bun run nx run providers-testkit:test`
- `bun run nx run providers-mcp-client:test`
- `bun run nx run providers-mcp-client:typecheck`
- `bun run nx run providers-mcp-client:build`
- `bun run nx run providers-typescript-conformance-runner:conformance`

