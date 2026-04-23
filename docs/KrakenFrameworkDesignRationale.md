# Kraken Framework — Design Rationale

**Companion to**: Framework Specification
**Purpose**: Decision archaeology, cross-framework analysis, design reasoning. Not contract — the Framework Specification is authoritative.

Read after `KrakenFrameworkSpecification.md`. This document explains decisions; it does not define the contract.

Kraken is the execution engine inside Tuvren Runtime, so this rationale stays intentionally engine-focused rather than product-marketing focused.

---

## 1. Cross-Framework Analysis

### 1.1 The Intersection

Analysis of seven frameworks (OpenAI Agents SDK, Hermes, LangGraph, LangChain, Pi, Cloudflare Agents, Google ADK) reveals the same pattern under different names:

1. There is always some durable representation of progress.
2. There is always some execution driver that advances step by step.
3. There is always some mechanism turning model output into executable actions.
4. There is always some interception point where external policy can alter execution.
5. There is always some way to stop, pause, or resume safely.
6. There is almost always a translation boundary between rich internal state and the stricter payload sent to the model or client.

The real intersection: an agent runtime is a durable state machine that repeatedly interprets model output, executes side effects, records what happened, and either continues, pauses, or terminates. Everything else is ergonomics, topology, hosting, or product skin.

### 1.2 Execution Primitives Differ

The systems differ in their execution primitive:

- **Turn-loop runtimes**: Hermes, OpenAI Agents, Pi
- **Graph/state-machine runtimes**: LangGraph, LangChain
- **Durable reactive runtimes**: Cloudflare
- **Event-stream runtimes**: ADK (between turn loop and event runtime)

"Agent framework" is too broad to be architecturally useful. The precise question: what is the system's execution primitive?

### 1.3 State Representations

Four practical shapes appear:

**Append-only conversational log** (OpenAI Agents, Hermes, Pi): Simple, auditable, replay-friendly. Weakness: no structural dependency or selective recomputation without separate policies.

**Reducer-based shared state** (LangGraph, LangChain): Most formal answer to concurrent updates. Cost: conceptual overhead (schemas, reducers, triggers, graph scheduling).

**Event log plus mutable overlay** (OpenAI Agents, ADK): Pragmatic middle ground. Risk: replay semantics become subtle when critical info lives in mutable context.

**Synchronized durable state blob** (Cloudflare): Reactive, long-lived, connected agents. Least "agentic" looking but solves real systems.

Kraken chose a hybrid: append-only immutable DAG (like the log model) with schema-driven structured state (like the reducer model) and content-addressed structural sharing (unique to Kraken). This gives audit, replay, and efficient storage without reducer complexity.

### 1.4 The Translation Boundary

Several systems distinguish rich internal state from model-facing payloads. Pi converts richer internal messages into provider-compatible payloads. LangChain normalizes providers into common forms. This boundary is essential because internal runtime truth and provider protocol truth are rarely the same object.

Kraken has two translation boundaries: the Provider Bridge (inbound: provider → canonical types) and the Streaming Protocol (outbound: framework events → client protocols).

### 1.5 Extension Patterns

Four recurring patterns across frameworks:

1. **Observe-only hooks** — see what happened, no mutation.
2. **Short-circuit plugin chains** — first objection wins.
3. **Wrap/onion middleware** — before/after/around with nesting.
4. **Control objects** — returned from execution to influence flow.

LangChain's middleware is the most ergonomically developed: bundles multiple hooks into named units, distinguishes sequential from wrapping hooks, allows owned state, provides prebuilt library.

Kraken's Extension System combines all four patterns. The ergonomic challenge (identified in the v0.8 review) is that the full model is concept-dense. The authoritative specification keeps the core primitives explicit; ergonomic facades are implementation concerns rather than specification surface.

---

## 2. Design Basis by Topic

### 2.1 Execution Model

**What every framework's loop looks like:**

1. Build context from accumulated state
2. Call model
3. Append model response to state
4. If continuation needed: execute tools, append results, loop
5. Else: done

Vercel AI SDK wraps this in a do/while. Pi uses nested while loops with steering. The core is identical.

**Manus lesson**: Context engineering is not a pre-loop concern. In long-running sessions (hundreds of tool calls), the context window must be managed mid-loop. This led to per-iteration context engineering checks driven by the manifest.

**Manus lesson**: Compression must be restorable. Kraken's immutable Object store provides this — compacted content is always recoverable from previous TurnNodes.

**Manus lesson**: Keep the wrong stuff in context. Tool failures produce error ToolResultParts the model sees and reasons about, rather than crashing the Run.

### 2.2 State Schema

**Why messages + manifest, not split paths**: The v0.5 schema separated state into nine paths. This created three problems: context assembly must reconstruct ordering (split paths lose it), no storage benefit (same Objects either way), misalignment with every framework (all store messages as primary unit).

**Why manifest**: A single messages path preserves order but context engineering needs structural knowledge (tool call counts, turn boundaries, token estimates). Without a manifest, every context engineering decision requires scanning all messages. The manifest provides O(1) structural analysis.

### 2.3 Provider Bridge

**Discriminated union, one type per part**: Google's Part uses optional fields (a bag). Kraken decomposes into discrete parts with exactly one `type` each. Unambiguous matching, no "which field is present" logic.

**Tool call input always parsed**: OpenAI returns arguments as JSON strings. Kraken always parses. This prevents downstream code from parsing JSON conditionally based on provider.

**callId is framework-owned**: Provider-native IDs have incompatible formats (Anthropic: `toolu_...`, OpenAI: `call_...`, Google: optional). Framework-generated IDs eliminate cross-provider normalization.

**providerMetadata is structural**: Without it, multi-turn reasoning continuity breaks. Anthropic's thinking `signature`, OpenAI's `encrypted_content`, Google's `thoughtSignature` must survive round-trips.

**Streaming is not in the content model**: Content types represent complete durable content. Streaming deltas are transport — handled by `stream()`, accumulated into complete types.

**Zero runtime dependencies**: `@tuvren/core-types` contains only interfaces. No Zod, no classes, no serialization.

### 2.4 Streaming

**The two-path problem**: During a model call, the UI needs tokens immediately (live path) while the framework needs the complete response (durable path). These cannot unify. The framework runs both simultaneously.

**Generator over event bus**: `AsyncIterable<TuvrenStreamEvent>` over `EventEmitter` because: no subscription management, natural backpressure, consumer controls iteration, composition is function application (`toAGUI(executeTurn(...))`), matches `provider.stream()`.

**Internal vocabulary, external adapters**: Kraken does not define its own client-facing protocol. It defines an internal vocabulary and provides adapters (AG-UI, ACP, Raw SSE). Same principle as the Provider Bridge: one canonical vocabulary, adapters for the many-to-many mapping.

### 2.5 Multi-Agent

**Two coordination axes**: Delegation (worker vs. handoff) × timing (sync vs. async). Workers do subtasks and return results. Handoffs transfer control. These combine into three useful patterns (sync worker, async worker, handoff) plus sequences as a special case.

**Same Thread, same Branch**: New Threads at handoff boundaries would orphan history. Context engineering avoids this — old messages remain in previous TurnNodes. Clean context for the new agent, intact history for audit.

**Handoff context is deterministic**: No model call. Extract user messages, assistant text, and tool outcomes into structured format. The receiving agent sees what matters without noise from tools it doesn't own.

---

## 3. Wire Mapping Reference

### 3.1 Text

| Direction | Kraken                | Anthropic                    | OpenAI Chat              | OpenAI Responses               | Google             |
| --------- | --------------------- | ---------------------------- | ------------------------ | ------------------------------ | ------------------ |
| Input     | `{type:"text", text}` | `{type:"text", text}`        | `{type:"text", text}`    | `{type:"input_text", text}`    | `{text}` in Part   |
| Output    | `{type:"text", text}` | `{type:"text", text}`        | `content: string`        | `{type:"output_text", text}`   | `{text}` in Part   |
| Notes     | —                     | citations → providerMetadata | string → single TextPart | annotations → providerMetadata | text field on Part |

### 3.2 Reasoning

| Aspect       | Kraken                       | Anthropic                    | OpenAI Responses       | Google               |
| ------------ | ---------------------------- | ---------------------------- | ---------------------- | -------------------- |
| Shape        | Part on message              | Separate block types         | Separate item type     | `thought: true` flag |
| Opaque token | providerMetadata             | `signature`                  | `encrypted_content?`   | `thoughtSignature?`  |
| Redacted     | `redacted: true`, empty text | `{type:"redacted_thinking"}` | encrypted_content only | —                    |

### 3.3 Tool Call

| Field | Kraken               | Anthropic | OpenAI Chat                        | OpenAI Responses          | Google  |
| ----- | -------------------- | --------- | ---------------------------------- | ------------------------- | ------- |
| ID    | `callId` (framework) | `id`      | `id`                               | `call_id`                 | `id`    |
| Name  | `name`               | `name`    | `function.name`                    | `name`                    | `name`  |
| Args  | `input` (parsed)     | `input`   | `function.arguments` (JSON string) | `arguments` (JSON string) | `args?` |

### 3.4 Tool Result

| Field    | Kraken            | Anthropic     | OpenAI Chat       | OpenAI Responses | Google             |
| -------- | ----------------- | ------------- | ----------------- | ---------------- | ------------------ |
| Links by | `callId`          | `tool_use_id` | `tool_call_id`    | `call_id`        | `id` + `name`      |
| Result   | `output: unknown` | `content`     | `content: string` | `output: string` | `response: Record` |
| Error    | `isError?`        | `is_error?`   | —                 | —                | —                  |

### 3.5 File / Media

| Type     | Kraken                                       | Anthropic           | OpenAI Chat          | OpenAI Responses       | Google         |
| -------- | -------------------------------------------- | ------------------- | -------------------- | ---------------------- | -------------- |
| Image    | `{type:"file", mediaType:"image/*"}`         | `{type:"image"}`    | `{type:"image_url"}` | `{type:"input_image"}` | `{inlineData}` |
| Document | `{type:"file", mediaType:"application/pdf"}` | `{type:"document"}` | `{type:"file"}`      | `{type:"input_file"}`  | `{fileData}`   |

### 3.6 System Message

| Kraken                     | Anthropic               | OpenAI Chat                               | OpenAI Responses     | Google                    |
| -------------------------- | ----------------------- | ----------------------------------------- | -------------------- | ------------------------- |
| `{role:"system", content}` | separate `system` param | `{role:"system"}` or `{role:"developer"}` | `instructions` param | `systemInstruction` param |

### 3.7 Streaming Protocol Mapping

| TuvrenStreamEvent    | AG-UI                        | ACP                 |
| -------------------- | ---------------------------- | ------------------- |
| `turn.start`         | `RUN_STARTED`                | —                   |
| `turn.end`           | `RUN_FINISHED` / `RUN_ERROR` | —                   |
| `iteration.start`    | `STEP_STARTED`               | —                   |
| `text.delta`         | `TEXT_MESSAGE_CONTENT`       | `AgentMessageChunk` |
| `reasoning.delta`    | `REASONING_MESSAGE_CONTENT`  | `AgentThoughtChunk` |
| `tool_call.done`     | `TOOL_CALL_END`              | `ToolCall`          |
| `tool.result`        | `TOOL_CALL_RESULT`           | `ToolCallUpdate`    |
| `state.snapshot`     | `STATE_SNAPSHOT`             | —                   |
| `approval.requested` | —                            | Elicitation request |
| `custom`             | `CUSTOM`                     | `_meta` field       |

---

## 4. Version History

### 4.1 v0.6-draft.1

First framework companion documents locked: Provider Bridge, State Schema, Tool Dispatch & Loop Policy. Established canonical content types, messages+manifest state schema, tool definition interface, and loop policy predicate.

### 4.2 v0.7-draft.1

Extension System, Streaming & Event Protocol, and Multi-Agent Orchestration locked. Extension unit bundling multiple hooks, aroundModel/aroundTool wrappers, declarative approval with gate functions, streaming event vocabulary (21 types), protocol adapter boundary, worker/handoff/sequence patterns.

### 4.3 v0.8 Review Findings

External review identified:

- **Execution model convergence (2.5/5)**: Control flow outcomes scattered across documents in different vocabularies. No single exhaustive resolution type.
- **Extension ergonomics (2.5/5)**: Architecture strong, daily use expensive. Too many concepts visible on the common path.
- **Host readiness (2.5/5)**: No formal host/runtime control surface. Steering, approval, cancellation as three separate ad-hoc mechanisms.
- **Versioning discipline (2.0/5)**: Documents spanning v0.6-v0.7 with overlapping authority.

Response:

- **RuntimeResolution type**: One exhaustive type for all framework control flow.
- **ExecutionHandle**: Formal host contract unifying steering, approval, cancellation.
- **Extension contract hardening**: Extension state, shared exports, and lifecycle responsibilities were pulled into the authoritative framework contract instead of relying on facade-level ergonomics.
- **Pluggable handoff context builder**: First-class replaceable contract.
- **Document consolidation**: Seven companion docs → one Framework Specification + two companion docs. Rationale extracted to this document.
- **FrameworkExecutionContract**: Superseded. The Framework Specification is now the single authority.

### 4.4 v0.12 Consistency Pass

The current consistency pass hardened several load-bearing framework semantics:

- **Two-tier event contract**: Canonical internal event vocabulary split into required core events and optional standardized observability events, with protocol adapters treated as outbound bridges.
- **Extension continuity**: Context engineering and handoff preserve branch-scoped extension state by default.
- **First-class shared exports**: `sharedExports` became a declared feature through explicit `exports` keys on extensions.
- **Semantic turn lineage**: Framework turn creation now treats `parentTurnId` as real same-thread lineage on the active Branch, not convenience metadata.
- **Loop-policy legality**: Invalid `continue + no tool execution` decisions in the presence of executable tool calls now fail hard by contract.

---

## 5. External Protocol Positioning

What Kraken learns from, and what it does not adopt:

| Protocol/Project         | What it informs                        | What it does not define for Kraken            |
| ------------------------ | -------------------------------------- | --------------------------------------------- |
| MCP                      | Tool and resource boundaries           | Core runtime state model                      |
| AG-UI                    | Frontend event transport               | Durable execution structure                   |
| ACP                      | Editor-native agent workflows          | Runtime ontology                              |
| AGENTS.md / Agent Skills | Input and capability description       | Core runtime objects                          |
| OpenResponses            | Typed objects, semantic events         | Thread-head semantics, branches, merge        |
| LangGraph Checkpointers  | Two-tier persistence, interrupt/resume | Content-addressed storage, structural sharing |
| LangChain Middleware     | Composable cross-cutting concerns      | Kernel/framework separation                   |
| Vercel AI SDK            | Clean provider interface               | Persistence, state, history                   |

---

_This document records the reasoning behind framework design decisions. Read it after the framework specification. It is not authoritative for implementation — the Framework Specification is the contract._
