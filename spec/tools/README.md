# Tools port — authority

The tool-contract authority is physically consolidated here as of
87-M5.1 (lifted from `boundaries/framework/contracts/tool-contracts/`,
merging that contract root's README and its spec README into this
file):

- `typespec/` — the reviewed TypeSpec source (`main.tsp`) for the tool
  surface (tool definitions, approval flow, validation results, tool
  result batches). Generated or emitted artifacts must not become
  semantic authority by default.
- `artifacts/` — the reviewed JSON Schema and OpenAPI outputs generated
  from the TypeSpec source (regenerated via `tools-spec:codegen`).

Packet ownership is unchanged: these are authoritative sources of the
consolidated `tuvren.shared.core` packet (`spec/core/authority-packet.json`,
`tools` binding section). The engine-facing vocabulary remains
`@tuvren/core/tools` and `@tuvren/core/capabilities`.

The capability surface (execution classes, binding, policy — ADR-046)
is also `tuvren.shared.core` authority: its hand-authored JSON Schemas
live at `spec/core/artifacts/json-schema/` alongside the core artifacts
until TypeSpec coverage is promoted; they deliberately do not move here.

MCP (`tuvren.providers.mcp`, the tool bus-driver) joins this port at
87-M5.1c: its authority packet moves cross-port to
`spec/tools/mcp/authority-packet.json`, and the tools-owned conformance
plans consolidate at `spec/conformance/tools/`. Until then the packet
remains at `boundaries/providers/contracts/mcp/spec/authority-packet.json`
and `@tuvren/mcp-client` remains at
`boundaries/providers/implementations/typescript/mcp-client` (moves at
M5.2).

The deprecated `@tuvren/tool-contracts` shim package (import-dead;
successor `@tuvren/core/tools`) retires at 87-M5.1b.
