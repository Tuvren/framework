### ADR-039 MCP Client Container: Unified `MCPClient` Over stdio + HTTP/SSE

- **Status:** accepted
- **Context:** PRD v0.7.0 CAP-P0-041 commits to first-class Model Context Protocol client integration over both stdio and HTTP/SSE transports. Architecture v0.7.0 places the MCP Client Container as an external tool-ecosystem integration boundary, treating external MCP servers as untrusted, requiring tool-input and tool-output validation in both directions, and exposing the integration through a unified `MCPClient` interface so transports do not fragment behavior. The official `@modelcontextprotocol/sdk@1.29.0` ships stdio, deprecated SSE, and Streamable HTTP transports with a shared `Client` core. Package metadata for v1.29.0 still declares `zod` as a non-optional peer dependency; the Tuvren package must absorb that upstream requirement without turning `zod` into a public Tuvren peer.
- **Decision:** Introduce a new leaf package `@tuvren/mcp-client` under `boundaries/providers/implementations/typescript/mcp-client/` (sibling of `bridge-ai-sdk/`). It depends on `@modelcontextprotocol/sdk@1.29.0` and `zod@4.4.3` as direct dependencies and peer-depends on `@tuvren/core`. The direct `zod` dependency exists only to satisfy the pinned SDK's own peer/runtime contract; `@tuvren/mcp-client` must not expose `zod` types or require hosts to install `zod` separately unless they use `@tuvren/core`'s optional Zod authoring path. Tuvren's public `transport: "http-sse"` compatibility name is implemented with the SDK's non-deprecated Streamable HTTP transport, not the deprecated upstream SSE transport. Public surface:
  ```ts
  export type McpTransportConfig =
    | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { transport: "http-sse"; endpoint: string; headers?: Record<string, string>; auth?: McpAuth };

  export type McpAuth =
    | { kind: "bearer"; token: string }
    | { kind: "header"; name: string; value: string };

  export interface McpToolSource {
    readonly serverName: string;
    readonly tools: TuvrenToolDefinition[];
    refresh(): Promise<{ tools: TuvrenToolDefinition[] }>;
    close(): Promise<void>;
  }

  export interface CreateMcpToolSourceOptions extends McpTransportConfig {
    name?: string;
    onError?: (error: TuvrenProviderError) => void;
    toolNameSeparator?: string;
  }

  export function createMcpToolSource(
    options: CreateMcpToolSourceOptions,
  ): Promise<McpToolSource>;
  ```
  The internal `MCPClient` interface wraps the upstream SDK's client with one connection-lifecycle surface (`initialize`, `listTools`, `invokeTool`, `close`) over which the stdio and Streamable HTTP transports implement only framing and connection. Translation rules from MCP advertisements to `TuvrenToolDefinition`:
  1. MCP `tool.name` → `TuvrenToolDefinition.name`; an optional `name` prefix from `CreateMcpToolSourceOptions.name` is prepended as `<prefix>.<toolname>` to disambiguate when multiple servers register
  2. MCP `tool.description` → `TuvrenToolDefinition.description`
  3. MCP `tool.inputSchema` (JSON Schema) → wrapped via `jsonSchema<unknown>()` from `@tuvren/core/tools`; inputs are validated by Ajv before being sent across the transport
  4. MCP tool outputs are wrapped as `TuvrenToolDefinition.execute`'s return value; if the advertised `outputSchema` is present, outputs are validated against it before surfacing as `ToolResultPart`; validation failures are surfaced as `ToolResultPart` with `isError: true` and a `TuvrenProviderError` payload using code `mcp_tool_output_invalid`. MCP `CallToolResult.isError` responses bypass output-schema validation and surface as `ToolResultPart` with `isError: true` and code `mcp_tool_error`.
  5. MCP `tool.annotations` (if present) are preserved under `TuvrenToolDefinition.metadata.mcp`
  6. Transport errors (connection lost, request timeout, protocol error) are translated to `ToolResultPart` with `isError: true` and a `TuvrenProviderError` with code `mcp_transport_failure`; the runtime does not retry automatically
  7. Provider-level initialization and tool-list failures are raised as `TuvrenProviderError` instead of being hidden in tool results
  
  The MCP server-side projection (exposing Tuvren as an MCP server) is explicitly out of scope.
- **Consequences:** New leaf package, new authority packet entry under `boundaries/providers/contracts/mcp/spec/authority-packet.json` declaring the MCP tool-source binding contract (the wire protocol itself is owned by `@modelcontextprotocol/sdk`; Tuvren's packet describes the translation rules). New conformance plan `providers-mcp-client.json` exercises the translation rules and transport-error normalization; transport parity uses the official `@modelcontextprotocol/server-everything@2026.1.26` fixture over stdio and Streamable HTTP, while the in-repo provider-testkit mock covers auth, invalid-output, and controlled transport-failure injection. Provider testkit gains both helper families. The `createMcpToolSource` helper is re-exported from `@tuvren/runtime`'s convenience surface for batteries-included composition.

