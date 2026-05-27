# KRT-AP001 Spike Report: Atomic-Merge Feasibility for `@tuvren/core` Consolidation

## Import Inventory

Workspace scan of files under `boundaries/` that import from the five retired packages and `@tuvren/runtime-core`:

| Source Package | Import Sites | Notes |
|---|---|---|
| `@tuvren/core-types` | 199 | split across error types and primitive types |
| `@tuvren/runtime-api` (root) | 150 | need per-symbol subpath routing |
| `@tuvren/runtime-api/events` | 7 | direct map → `@tuvren/core/events` |
| `@tuvren/runtime-api/execution` | 6 | direct map → `@tuvren/core/execution` |
| `@tuvren/runtime-api/tools` | 8 | direct map → `@tuvren/core/tools` |
| `@tuvren/runtime-api/provider` | 5 | direct map → `@tuvren/core/provider` |
| `@tuvren/runtime-api/orchestration` | 1 | direct map → `@tuvren/core/execution` |
| `@tuvren/event-stream` | 15 | direct map → `@tuvren/core/events` |
| `@tuvren/tool-contracts` | 1 | direct map → `@tuvren/core/tools` |
| `@tuvren/driver-api` | 75 | direct map → `@tuvren/core/driver` |
| `@tuvren/runtime-core` | 10 | direct map → `@tuvren/runtime` |
| **Total** | **~477** | |

## Symbol-to-Subpath Routing for `@tuvren/runtime-api` Root Imports

The root `@tuvren/runtime-api` exports are a superset of the five subpaths (`/events`, `/execution`, `/tools`, `/provider`, `/orchestration`) plus a few root-only types.

**Routing rule:**
- If a symbol is already exported by a specific subpath → route to the corresponding `@tuvren/core/<subpath>`
- Root-only content-part and message-format types → `@tuvren/core/messages`
- `TuvrenValidationError` (re-exported from core-types) → `@tuvren/core/errors`

**Symbol map:**

`/events`: All `*Event` types, `EventSource`, `DriverAttributedEventSource`, `TuvrenStreamEvent`, `TuvrenErrorProjection`, `assertTuvrenStreamEvent`, `isTuvrenStreamEvent`

`/execution`: All execution-lifecycle types (`ExecutionHandle`, `ExecutionResult`, `ExecutionStatus`, `TuvrenRuntime`), orchestration types (`OrchestrationHandle`, `OrchestrationRuntime`, `OrchestrationResult`), context/policy types (`ContextManifest`, `AgentConfig`, `LoopPolicy`, etc.), durable-read cursor types, extension types (`TuvrenExtension`, `ExtensionContext`, lifecycle handlers), `TuvrenMessage`, guards (`assertContextManifest`, `assertExecutionStatus`, `assertTuvrenMessage`, `isExecutionStatus`, `isTuvrenMessage`)

`/tools`: All approval types (`ApprovalDecision`, `ApprovalPolicy`, `ApprovalRequest`, `ApprovalResponse`), tool contract types (`TuvrenToolDefinition`, `ToolRegistry`, etc.), tool execution types, guards

`/provider`: `TuvrenProvider`, `ProviderStreamChunk`, `ProviderUsage`, `StructuredOutputRequest`, `TuvrenModelResponse`, `TuvrenPrompt`, guards

`/messages`: Root-only types — `ContentPart`, `TextPart`, `ReasoningPart`, `ToolCallPart`, `ToolResultPart`, `FilePart`, `StructuredPart`, `TuvrenModelConfig`, `TuvrenJsonSchema`, `TuvrenJsonValue`, `ApprovalDecisionType`

`/errors`: `TuvrenValidationError` (only case where runtime-api re-exports a core-types symbol at root)

## Recommendation

**One-shot codemod** is the correct path. Staged shim-package migration is unnecessary because:

1. All 5 source packages are already co-authored in this monorepo. No published-package consumer freeze is needed since internal workspace consumers are the only current users.
2. The source files have clean dependency graphs: `core-types` has no external deps; `runtime-api` only depends on `core-types`; `driver-api` only depends on `core-types` and `runtime-api`. Once source is consolidated into `@tuvren/core/src/lib/`, all cross-package imports become same-package relative imports.
3. The codemod is fully mechanical for 5 of the 6 cases (direct subpath-to-subpath). Only the `@tuvren/runtime-api` root case requires per-symbol routing, which is covered by a static symbol-to-subpath map (all ~90 symbols mapped).
4. The entire migration is in scope for a single atomic epic (KRT-AP001 through KRT-AP011) that lands in one merge, so no intermediate broken-state window exists.

**Effort estimate:** ~4–6 hours total for all 11 tickets.

**Risk classification:** Low. All consumers are workspace-internal; the codemod is mechanical; the build will catch any miss via typecheck gate. The main risk is the `@tuvren/runtime-api` root per-symbol routing needing a complete symbol map — that map is built once and verified by the typecheck gate.

## Codemod Strategy

The codemod script lives at `tools/scripts/migrate-to-core.ts`. It:
1. Walks all `.ts` files under `boundaries/` (excluding `dist/`, `node_modules/`, `generated/`)
2. Parses import statements with a regex-based extractor (sufficient for well-formatted imports)
3. Applies the routing table
4. Writes updated files in-place
5. Reports every rewrite for audit

The script is committed and remains in the repo for future audit.
