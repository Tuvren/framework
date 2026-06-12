# KRT-AY001 — Provider-Native & Provider-Mediated Surface Matrix

**Status:** closed (spike completed)
**Epic:** AY — Provider-Native & Provider-Mediated Execution Classes
**Investigated surface:** `@ai-sdk/provider@3.0.8` / `ai@6.0.142` bridge

---

## Investigation Scope

This spike investigated what the AI-SDK-bridged providers actually expose in 2026 for:
1. **Provider-native tools** — the provider executes the tool entirely on its own infrastructure; Tuvren enables/configures the surface and records only provider-exposed events/results.
2. **Provider-mediated tools** — the developer provides an endpoint; the provider invokes it; Tuvren configures the relationship and records partial observability.

The bridge layer in scope is `LanguageModelV3` / `ProviderV3` from `@ai-sdk/provider@3.0.8`. Higher-level `ai@6` helpers (e.g. `anthropic.tools.codeExecution_20260120()`) resolve to `LanguageModelV3ProviderTool` objects at this layer.

---

## Provider-Native Tool Surface

`LanguageModelV3ProviderTool` is the bridge-level type for configuring provider-native tools:

```typescript
type LanguageModelV3ProviderTool = {
  type: 'provider';
  id: `${string}.${string}`;  // e.g. "anthropic.code_execution_20260120"
  name: string;               // model-facing name
  args: Record<string, unknown>;
};
```

Rows marked **verified** are confirmed present in the installed provider adapters (`@ai-sdk/anthropic@3.0.66`, `@ai-sdk/openai@3.0.53`, `@ai-sdk/google` installed). Rows marked **unverified** are reported by external sources but could not be confirmed in the installed SDK; treat as aspirational until the corresponding adapter is installed and verified.

| Provider | Tool ID | Name | Args | GA / Beta | Bridge Status |
|----------|---------|------|------|-----------|---------------|
| Anthropic | `anthropic.code_execution_20260120` | `code_execution` | `{}` | GA (no beta header); Opus 4.6, Sonnet 4.6, Sonnet 4.5, Opus 4.5 | **verified** |
| Anthropic | `anthropic.code_execution_20250825` | `code_execution` | `{}` | Beta (`code-execution-2025-08-25` header); Python + Bash | **verified** |
| Google | `google.google_maps` | `google_maps` | `{ mapId?: string }` | GA (Gemini 2.0+) | **verified** |
| Google | `google.vertex_rag_store` | `vertex_rag_store` | `{ corpusName: string }` | GA (Gemini 2.0+) | **verified** |
| Google | `google.file_search` | `file_search` | `{ storeId: string }` | GA (Gemini 2.5+) | **verified** |
| xAI | `xai.web_search` | `web_search` | `{ domain_filter?: string[] }` | GA | **unverified** (`@ai-sdk/xai` not in bridge deps) |
| xAI | `xai.x_search` | `x_search` | `{ handle?: string, dateRange?: object }` | GA | **unverified** |
| xAI | `xai.code_execution` | `code_execution` | `{}` | GA | **unverified** |

### Observable Fields on Provider-Native Results

When the provider executes a native tool, `LanguageModelV3ToolResult` appears in the generate response content or as a `tool-result` stream part:

```typescript
type LanguageModelV3ToolResult = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  result: NonNullable<JSONValue>;  // provider's result (opaque JSON)
  isError?: boolean;
  preliminary?: boolean;
  dynamic?: boolean;              // true for provider-invoked dynamic tools
  providerMetadata?: SharedV3ProviderMetadata;
};
```

**Observable**: `toolCallId`, `toolName`, `result`, `isError`, `providerMetadata`

**Not observable by Tuvren**:
- Intermediate execution steps (code execution sub-steps, search queries)
- Cancel signal to provider infrastructure
- Retry of provider-native invocation
- Audit trail of provider execution
- Resume of a partial provider execution

`LanguageModelV3ToolCall.providerExecuted: true` signals a tool call that the provider executed (the tool call appears alongside its result in the same response).

---

## Provider-Mediated Tool Surface

Provider-mediated tools are those where the **developer supplies an endpoint** and the **provider invokes it**. The primary mechanism in 2026 is OpenAI's remote MCP tool.

| Provider | Tool ID | Name | Args | Notes |
|----------|---------|------|------|-------|
| OpenAI | `openai.mcp` | varies | `{ server_url?: string, connector_id?: string }` | Provider invokes developer's MCP server directly; `dynamic: true` on returned tool results |

### Configuration

OpenAI's MCP tool is configured as a `LanguageModelV3ProviderTool` with `server_url` (or `connector_id`) in `args`. The provider discovers and invokes the MCP server's tools without Tuvren's Tool Execution Gateway being involved. Returned results carry `dynamic: true` to signal provider-invoked dynamic tool execution.

**Provider-mediated MCP classified as**: MCP binding (`endpoint.kind === "mcp-server"`) under the `provider-mediated` execution class. This is consistent with ADR-046: MCP is a binding mechanism whose execution class depends on who invokes/runs the server; here the provider invokes it, so the class is `provider-mediated`.

### Observable Fields on Provider-Mediated Results

Same `LanguageModelV3ToolResult` shape as provider-native, with `dynamic: true` set.

**Partial observability**: Tuvren can observe the final result returned by the provider for each MCP tool call. Tuvren cannot observe the provider's intermediate MCP protocol exchanges, the individual MCP tool listing, or the provider's invocation retry behavior.

---

## Credential and Secret Boundary

Neither provider-native nor provider-mediated tool configuration in `TuvrenPrompt` should carry API keys, bearer tokens, or secrets:
- Provider credentials (Anthropic API key, OpenAI API key) are held at the Provider Gateway edge by `@tuvren/provider-bridge-ai-sdk` (passed as model auth on construction, not in the prompt).
- For provider-mediated MCP, `args.server_url` is a non-secret endpoint URL. If the developer's MCP server requires auth tokens, those must be handled outside Tuvren's prompt layer (e.g., via provider-side connector configuration or `providerOptions.headers`).

---

## Continuation-State Artifacts

Some providers return opaque continuity artifacts in `providerMetadata` that must be threaded into subsequent turns for correct multi-turn operation (e.g., Anthropic code execution container IDs, session tokens for search grounding). These are:
- **Non-secret**: they are session/continuation identifiers, not API credentials
- **Opaque**: their internal structure is provider-specific
- **Excluded from durable lineage**: must not appear in kernel records, telemetry spans, or `tool.result` events
- **Held at the Provider Gateway edge**: passed via `TuvrenPrompt.providerContinuity` on subsequent turns and merged into `providerOptions` by the bridge

---

## Concrete Proof Targets for KRT-AY006

| Class | Proof Target | Method |
|-------|-------------|--------|
| `provider-native` | Anthropic `code_execution_20260120` pattern | Mock `LanguageModelV3` returning `LanguageModelV3ToolResult` for a declared `ProviderNativeToolDeclaration { id: "anthropic.code_execution_20260120", name: "code_execution" }` |
| `provider-mediated` | OpenAI `openai.mcp` pattern | Mock `LanguageModelV3` returning `LanguageModelV3ToolResult { dynamic: true }` for a declared `ProviderMediatedToolConfig { mediationType: "mcp", endpoint: "https://example.com/mcp" }` |

### Live-Provider Gap

Real live-provider integration tests require Anthropic and OpenAI API keys, which are not available in the CI/conformance environment. The mock-backed proofs validate the full contract (declaration → bridge mapping → provider tool configuration → result recording → event attribution) with representative fixtures. The gap is recorded here; a future productionization epic or external integration suite can close it with live API access.

---

## Downstream Decisions

- `ProviderNativeToolDeclaration.id` format: `"{provider}.{tool-name}"` — matches `LanguageModelV3ProviderTool.id` directly; no remapping needed.
- `ProviderMediatedToolConfig.mediationType: "mcp"` — only MCP is supported in this epic; other provider-mediated patterns (e.g. provider-invoked HTTP endpoints) are deferred.
- Undeclared `LanguageModelV3ToolResult` and `providerExecuted: true` results continue to be rejected by the bridge (existing baseline protection preserved for framework-owned tool execution boundary).
