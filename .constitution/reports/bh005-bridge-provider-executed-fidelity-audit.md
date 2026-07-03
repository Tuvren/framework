# KRT-BH005 — Bridge `providerExecuted`/`dynamic` Fidelity Audit

> **Path/terminology note (2026-07, epic #87, M10.3b):** This is a historical diagnostic report; its body is preserved verbatim below and is not rewritten. At the time of this audit, `@tuvren/provider-bridge-ai-sdk` lived at `boundaries/providers/implementations/typescript/bridge-ai-sdk/`; epic #87 relocated it to `typescript/providers/bridge-ai-sdk/`. The audited package identity and findings are unaffected by the move.

**Status:** closed (audit completed; one defect found and fixed)
**Epic:** BH — Conversation-State Ownership Hardening (KRT)
**Authority:** TechSpec ADR-055 (bridge fidelity audit); ADR-005 (baseline bridge); AY002/AY004 (provider-native/mediated execution classes)
**Audited surface:** `ai@6.0.142` / `@ai-sdk/provider@3.0.8` bridge (`@tuvren/provider-bridge-ai-sdk`)
**Landmine of record:** [vercel/ai #10888](https://github.com/vercel/ai/issues/10888) — `parseToolCall` validates provider-executed tools against the user tool map and injects spurious "invalid tool" errors.

---

## Audit Scope

ADR-055 requires, before any native-client work, an audit of the baseline AI SDK bridge's `providerExecuted`/`dynamic` round-trip fidelity against the `parseToolCall` landmine:

1. provider-executed tool calls/results are attributed to the **provider-native** execution class;
2. **no spurious validation error** is injected; and
3. the per-class **observation limits** (no cancel, retry, or audit) hold.

AI SDK v6 models a provider-executed tool as a `tool-call` part carrying `providerExecuted: true` (and, for runtime-defined provider tools such as MCP, `dynamic: true`) **followed by** a `tool-result` part. On the **generate** path that is the whole shape. On the **stream** path real providers emit the tool-call *incrementally first*: in `@ai-sdk/openai@3.0.53` the Responses API stream enqueues `tool-input-start` → `tool-input-delta`* → `tool-input-end` → `tool-call` → `tool-result`, and **`tool-input-start` is the only part that carries the `providerExecuted` / `dynamic` flags** (verified directly in `@ai-sdk/openai@3.0.53` `dist/index.js`, where `web_search`, `code_interpreter`, `computer_use`, `file_search`, `image_generation`, and MCP all emit `tool-input-start { providerExecuted: true }`; and in the `@ai-sdk/provider@3.0.8` `LanguageModelV3StreamPart` type, where only `tool-input-start` declares `providerExecuted?`/`dynamic?`). The bridge must therefore recognise a declared provider-executed tool at the **start** of its streamed input, not only at the terminal `tool-call`.

---

## Finding 1 — Structural immunity to #10888 (no change required)

`parseToolCall` lives in the AI SDK's higher-level orchestration (`generateText`/`streamText`), where tool-call parts are validated against the **user's** function tool map. Tuvren's bridge never enters that orchestration: it consumes the **low-level** `LanguageModelV3.doGenerate`/`doStream` contract directly (`ai-sdk-provider-bridge.ts` — `this.model.doGenerate(...)` / `model.doStream(...)`). Provider-executed tool routing in the bridge is keyed by the host's **declared** provider-native/mediated tools (`ProviderToolClassLookup`), not by the user function tool map, so the #10888 mis-validation has no code path to fire.

The audit test (`ai-sdk-provider-bridge-provider-executed-fidelity.test.ts`) and the conformance op (`providers.conversation-state.provider-executed-fidelity`) both drive the exact #10888 trigger — a provider-executed tool whose name is **absent** from a non-empty user function tool map — and confirm the round-trip is attributed to `provider-native` with the assistant content produced normally.

---

## Finding 2 — DEFECT FOUND AND FIXED: inline provider-executed tool-call was rejected even when declared

Before this milestone, `rejectUnsupportedProviderOwnedToolPart` rejected **every** `tool-call` part with `providerExecuted: true` or `dynamic: true` with `unsupported_ai_sdk_content` / `provider_owned_tool_execution_unsupported`, regardless of whether the host had declared that tool as provider-native/mediated. Because real providers emit the inline provider-executed `tool-call` part **before** its `tool-result` (verified above), a realistic provider-executed round-trip aborted at the call part — the `tool-result` (which the bridge *does* attribute to `provider-native` via the declared lookup) was never reached.

This was a genuine fidelity gap against ADR-055 criterion (1): the prior tests for provider-native/mediated tools only exercised result-only content, never the call+result shape a live provider produces.

**Fix (minimal, behaviour-preserving for the baseline boundary):** a provider-executed/`dynamic` tool the host **declared** provider-native/mediated is now **skipped** at the bridge across its whole streamed lifecycle — the matching `tool-result` carries the provider-native attribution (AY002/AY004), and the call does not contaminate the client-facing `parts`/stream with a function `tool_call` (or its incremental input deltas) the runtime would attempt to execute. An **undeclared** provider-owned tool is still rejected (baseline protection unchanged). Touched:

- `ai-sdk-provider-bridge-generate.ts` — `mapGeneratedToolCallPart` takes the lookup, returns `undefined` (skip) for a declared provider-executed call, throws for an undeclared one.
- `ai-sdk-provider-bridge-stream.ts` — `handleToolCallStreamPart` skips a declared provider-executed `tool-call` (returns no chunk), throws for an undeclared one. The **streamed incremental prelude is handled symmetrically**: `handleToolInputStartPart` recognises a declared provider-executed tool at `tool-input-start` (the only part carrying the flags), marks the tool-state `providerOwned`, and emits no `tool_call_start`; the marker makes `tool-input-delta`/`tool-input-end` emit no client chunk and exempts the entry from the client tool-call completeness invariant and the client tool-call correlation scan (so a lingering provider-owned state never misattributes a same-named client call). An undeclared provider-executed `tool-input-start` still throws. Because the seeded `providerOwned` state lives in `state.toolStates`, the **finish-reason** computation (`createFinishStreamChunks`) excludes provider-owned states from its `hasToolCalls` count — otherwise a provider-executed-only turn the provider finished with `stop` would normalize to `tool_call` on the stream path while the generate path (which counts emitted `tool_call` parts) reported `stop`, a stream/generate divergence that would spuriously drive a continue/execute-tools iteration with no client call.
- `ai-sdk-provider-bridge-utils.ts` — `isProviderOwnedToolPart` + `providerOwnedToolExecutionUnsupportedError` are the shared primitives; `StreamToolState` gains a `providerOwned` marker. The previous `rejectUnsupportedProviderOwnedToolPart` helper (whose only caller was the unconditional `tool-input-start` rejection) was **removed** in favour of the declared-lookup guard.

Scope note (corrected after milestone review): an earlier draft of this fix left the `tool-input-start` path unconditionally strict, on the mistaken premise that providers never stream provider-executed tool inputs incrementally. That premise is **false** — `@ai-sdk/openai@3.0.53` streams every Responses server tool (and MCP) as `tool-input-start { providerExecuted: true }` first (see Audit Scope), so a declared provider-executed tool would have aborted at `tool-input-start` before the fixed terminal `tool-call` was ever reached. The streaming fix therefore covers the incremental prelude as described above. The fix is provider-agnostic — it keys off the `providerExecuted`/`dynamic` flags plus the declared lookup — so it covers the same incremental shape from Anthropic server tool use / Google and any MCP round-trip, not only OpenAI.

Orphan-call boundary (made explicit after milestone review): skipping a declared provider-executed `tool-call` rests on the matching `tool-result` carrying the attribution. The bridge does **not** assume the result always arrives — it simply treats the call as the provider's own bookkeeping. The **result** is the attributable observation (independently mapped to `provider-native` via the declared lookup, whether or not a preceding call was seen); the **call** carries no observation of its own. So a declared provider-executed call whose result never arrives this turn (truncated/interrupted/multi-step response) yields **no provider-native record and no client-facing function `tool_call`**, and — critically — does **not** throw the way the prior over-broad rejection did. This is pinned by tests (`a DECLARED provider-executed tool-call with no matching result …`, generate + stream). Consistent with the `tool-input-start` minimalism above, the bridge does not add skip-tracking state to emit a degraded/diagnostic record for an orphan call; that is deferred to the ADR-055 native-client phases, where a richer provider-execution lifecycle is in scope. For the baseline bridge the durable-lineage posture (ADR-053) governs: lineage records what actually arrived, and an orphan call contributes nothing to attribute.

---

## Finding 3 — Per-class observation limits already hold (no change required)

The provider-native/mediated observation limits are enforced at the runtime event layer and are already proven by `runtime-core.provider-execution-class.test.ts` (KRT-AY003): for both classes, `tool.start`/`tool.result` carry `attribution.owner === "provider"` and the correct `executionClass`, the observation flags `canAudit`/`canCancel`/`canRetry`/`canResume` are all `false`, and **no** `tool.audit` event is emitted. Provider-executed results bypass the Tool Execution Gateway (pre-staged), so there is no cancel/retry/audit surface to begin with. This milestone adds no runtime behavior; it references that existing proof for criterion (3).

---

## #10888 Status (verified 2026-06)

Issue #10888 remains **open**. The proposed upstream fix is to have `parseToolCall` skip validation when `providerExecuted: true` (there is no user tool to conflict with). Tuvren is unaffected either way because it does not use `parseToolCall`; if the upstream fix lands, no Tuvren change is required.

## Version Confirmation

`ai@6.0.142` and `@ai-sdk/provider@3.0.8` are the locked versions (`boundaries/providers/implementations/typescript/bridge-ai-sdk/package.json`), matching ADR-055's recorded surface. No version drift; the audit's behavioral assertions are valid against the shipped stack.

---

## Evidence

| Criterion | Proof |
|-----------|-------|
| Attributed to provider-native; no spurious validation error | `ai-sdk-provider-bridge-provider-executed-fidelity.test.ts` (generate + stream) and conformance check `bh.bh005.provider-executed-fidelity` (`providers.conversation-state.provider-executed-fidelity`) |
| Incremental streamed shape (`tool-input-start{providerExecuted}` → delta → end → call → result) attributed to provider-native with no client `tool_call`/args-delta | Same audit test ("attributes an INCREMENTALLY-streamed providerExecuted round-trip …") + the conformance op now driving the incremental prelude |
| Stream/generate finish-reason parity (provider-executed-only `stop` turn reports `stop` on both paths, not normalized to `tool_call`) | Audit test ("…INCREMENTALLY-streamed…" finish-reason assertion) + conformance `result.providerExecutedFinishReasonParity` |
| Undeclared provider-owned execution still rejected (baseline protection) | Same audit test ("still rejects an UNDECLARED providerExecuted tool-call" + "still rejects an UNDECLARED provider-executed tool-input-start") + existing `providers.bridge.provider-owned-tool-execution-rejection` |
| Orphan declared provider-executed call (no result) → no observation, no throw | Same audit test ("a DECLARED provider-executed tool-call with no matching result …", generate + stream) |
| Per-class observation limits (no cancel/retry/audit) | `runtime-core.provider-execution-class.test.ts` (KRT-AY003) |
