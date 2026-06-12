### 4.9 Host Adds an External MCP Server as a Tool Source

- **Maps to PRD capability:** CAP-P0-041

```mermaid
sequenceDiagram
participant Host as Host Integration Boundary
participant SDK as Curated Host-Facing SDK Surface
participant MCP as MCP Client Container
participant Server as External MCP Server
participant ToolSource as Tool Source Container
participant Tooling as Tool Execution Gateway
participant Driver as Driver Runtime

Host->>SDK: configure MCP tool source (transport=stdio|http+sse, endpoint, auth)
SDK->>MCP: construct MCP client over chosen transport
MCP->>Server: MCP initialize handshake
Server-->>MCP: server capabilities, protocol version
MCP->>Server: list tools
Server-->>MCP: MCP tool advertisements (name, description, input schema)
MCP->>MCP: translate each MCP tool into a Tuvren tool definition (validate schema, wrap into CustomSchema)
MCP->>ToolSource: register translated tool definitions
ToolSource-->>Tooling: tools available to the active agent segment
Driver->>Tooling: tool batch invocation
Tooling->>Tooling: validate input against advertised schema
Tooling->>MCP: invoke MCP tool with validated input
MCP->>Server: MCP tools/call
Server-->>MCP: MCP tool result (or transport/protocol error)
MCP->>MCP: validate result shape; translate transport errors into canonical failure
MCP-->>Tooling: canonical ToolResultPart (success or error)
Tooling-->>Driver: tool result incorporated into iteration
```

