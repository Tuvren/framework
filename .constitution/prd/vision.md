# Product Vision

## 0. Version

v0.9.0 — current local Stage 1 SemVer; full history in `changelog.md`.

## 1. Executive Summary & Target Archetype

- **Target Archetype:** Embeddable stateful agent and workflow runtime kernel plus driver-oriented framework/SDK
- **Vision:** Tuvren Runtime becomes a trustworthy substrate for building long-lived agent systems whose progress, state transitions, interruptions, and control transfers remain durable, inspectable, and recoverable instead of opaque and fragile, and whose host-developer surface is ergonomic enough that serious operator-facing products can be built directly on the SDK without private shortcuts.
- **Problem:** Existing agent runtimes often make state continuity, tool execution, pause/resume, context shaping, and multi-agent control feel incidental or ad hoc, while many workflow systems hard-code one execution style as if it were the whole product. Equally, even when their underlying engines are sound, their host-developer surfaces force every consumer to compose low-level primitives, hand-roll terminal-value handling, reach around the SDK to read durable state, or commit to a single tool-authoring style. That makes long-running agent work hard to audit, hard to recover after interruption, hard to govern, hard to adapt cleanly across different execution models, and hard to build a credible product on without leaking implementation accidents into every host.
- **Jobs to Be Done:** Enable a builder to run durable agent or workflow execution with explicit history; let a host observe and steer execution safely; let a system execute tools, approvals, and handoffs without losing continuity; let downstream teams reason about what happened, why it happened, and how to resume, redirect, or swap execution strategy without discarding the shared runtime foundation; let a host developer assemble a serious operator-facing product (CLI, IDE integration, web console, ambient agent runner) from one curated SDK entrypoint without bypassing the host-facing boundary; and let a host inspect, list, and replay its own durable state without coupling to kernel internals.

### 1.1 Product Posture

- Tuvren is the company brand, Tuvren Runtime is the runtime product, and Kraken is the engine identity behind it.
- Tuvren Runtime must treat durable state continuity as a first-class product outcome, not an implementation detail.
- Tuvren Runtime must separate low-level runtime mechanism from higher-level execution policy so that the product can stay stable while agent and workflow behaviors evolve.
- Tuvren Runtime must be host-embeddable. The product serves applications, services, CLIs, and protocol adapters rather than replacing them.
- Tuvren Runtime must support a shared runtime foundation that can host more than one execution driver over time rather than treating one agent loop as the entire product ontology.
- Tuvren Runtime must preserve a language-neutral semantic core so future implementations can share one runtime meaning without turning the first TypeScript line into the permanent oracle.
- Tuvren Runtime must enforce that cross-implementation meaning lives in boundary-owned machine-readable authority and executable evidence rather than in any single implementation language, runner codebase, or human-prose document.
- The first product-depth implementation line must prove the SDK through a serious REPL-style reference host that exercises the runtime end to end without relying on private-only shortcuts that other hosts cannot use.
- Documented core runtime surfaces are expected to become real product scope for the first product-depth implementation line; long-lived deferral is reserved for ecosystem expansion or integrations that inherently depend on external SDK ecosystems.
- Every in-scope runtime feature defined by the project’s semantic docs is intended to be portable across implementation lines unless it exists only as an adapter to an external SDK or ecosystem-specific protocol.
- Host-developer ergonomics are a first-class product outcome on equal footing with semantic correctness. A curated host-facing SDK boundary, a batteries-included entrypoint, schema-agnostic tool authoring, and a first-party tool ecosystem surface are part of the product, not a courtesy facade.
- Single-tenant durable state must be inspectable, enumerable, and replayable through the host-facing SDK rather than through private kernel access; the first-party reference host must not need any seam that downstream hosts cannot also use.
- Production trustworthiness is a first-class product outcome on equal footing with semantic correctness and host-developer ergonomics: the durability and recovery promises must be demonstrably true under failure, the runtime must be observable enough to operate and debug in production, and untrusted edges must be governed rather than implicitly trusted.
- Tuvren Runtime is a cross-provider capability orchestration runtime, not only a tool executor. It decides which tool surfaces are exposed to a model, which capabilities back them, where execution authority lives, which policies apply before exposure and before invocation, and what it can observe, persist, resume, cancel, retry, or audit.
- Tuvren Runtime must distinguish the model-facing Tool Surface from the underlying Capability, and must represent the execution class that owns each capability invocation rather than treating every tool as a locally executed developer function.
- Tuvren Runtime must never imply stronger control than the execution class actually grants; provider-owned and client-owned invocations are represented as known capabilities with explicit observation and control limits.

### 1.2 Success Criteria

- A builder can embed Tuvren Runtime as the execution substrate for an agentic product without having to invent custom persistence, pause/resume, or recovery semantics.
- A host can observe execution in real time and still rely on a durable post hoc history of what was committed.
- A human supervisor can interrupt, approve, reject, or resume sensitive work without corrupting the execution lineage.
- A multi-agent workflow can delegate, hand off, and continue work while preserving traceability and avoiding ambiguous control transfer.
- A host application developer can build a serious operator-facing host from the same high-level SDK surface used by the first-party reference host rather than depending on private runtime seams.
- A host application developer can issue a first Turn from one batteries-included entrypoint without composing kernel, backend, driver registry, and runtime factories by hand, while retaining the ability to swap any of those substrates when product needs require it.
- A host application developer can author tools using Zod, Standard Schema, or wrapped JSON Schema with type inference flowing into the execute callback, and can also pass raw JSON Schema at the contract boundary without breaking compatibility.
- A host application developer can attach external Model Context Protocol servers (stdio or HTTP/SSE) as first-class tool sources without writing a bespoke bridge.
- A host application developer can list the threads owned by the runtime, list branches inside a thread, read the state at any TurnNode, walk turn history with a cursor, and read durable messages on a branch through the host-facing SDK alone.
- A first-party reference host proves durable threads, branching, streaming, approvals, steering, orchestration, extension behavior, and persistence as one coherent operator experience, in both an interactive readline mode and a headless stdin-driven mode, while reading durable state exclusively through the host-facing SDK.
- A test author or operations script can drive the reference host headlessly through stdin and capture an on-disk transcript that can later be replayed for postmortems or regressions.
- A runtime maintainer can introduce a new implementation language against shared contracts and behavioral fixtures without redefining the product’s semantic model.
- A runtime maintainer can build and judge a new implementation strictly from boundary-owned machine authority, generated artifacts, executable conformance evidence, and language-binding adapters, without reading another language's implementation, a generic runner's source code, or a Markdown document as the source of cross-language truth.
- A builder can trust that when a process is interrupted mid-turn, the runtime either resumes the unfinished work from the last durable checkpoint or fails cleanly, and never leaves partial or corrupt lineage; this guarantee is backed by reproducible failure-injection evidence rather than asserted by design alone.
- An operator can observe and reconstruct what a turn did — model interactions, tool calls, checkpoints, approvals, and recovery events — through a first-class telemetry surface, and can export that telemetry to standard tooling without coupling to runtime internals.
- A host can connect untrusted external tool sources and run sensitive tool work while trusting that inputs are validated, approval gates cannot be bypassed, runaway loops and resource exhaustion are bounded, and provider credentials never leak into durable state, telemetry, or transcripts.
- A builder can expose the same logical capability (for example search or code execution) through different execution classes — provider-native, Tuvren-server, provider-mediated, or client-side — and trust that the runtime applies policy before exposure and before invocation, resolves each model-visible call to a known execution class, and represents honestly what it can observe, persist, resume, cancel, retry, or audit for that class.

### 1.3 Scope Distinctions That Must Remain Stable

- **Semantic turn vs. execution run:** A user-visible turn may span more than one execution run when approval or recovery interrupts work.
- **Delegation vs. handoff:** Workers perform subordinate tasks and return results; handoffs transfer active control to another agent.
- **History preservation vs. active context shaping:** The active working context may be reduced or rewritten, but previously committed history remains recoverable.
- **Host control vs. runtime execution:** The host initiates, observes, and influences execution, but the runtime remains responsible for the execution lifecycle itself.
- **Framework vs. driver:** The framework supplies shared runtime services and contracts, while a driver defines one concrete execution model built on that shared foundation.
- **Machine authority vs. implementation projection:** Cross-implementation meaning lives in boundary-owned machine authority and executable evidence; an implementation language, generic runner codebase, or human-prose document is a projection of that authority and is never the source of cross-language truth.
- **Single-tenant durable reads vs. cross-tenant discovery:** Listing, reading, and replaying state for the runtime instance the host owns is a host-facing SDK capability; cross-tenant search, multi-tenant access control, and full-text indexed querying are deferred to a future hosted/server projection and are not part of the embeddable SDK.
- **SDK ergonomics vs. semantic correctness:** A curated host-facing surface, batteries-included composition, type-inferring helpers, and re-exported primitives are product responsibilities; they are not a substitute for the underlying semantic contracts, and they must not silently weaken any guarantee the boundary contracts make.
- **Authoring style vs. boundary contract:** Tool authoring may use Zod, Standard Schema, wrapped JSON Schema, or future schema adapters; the boundary contract still accepts raw JSON Schema and a `CustomSchema` interop shape. Authoring helpers add type inference and ergonomic defaults without narrowing what is legal at the contract seam.
- **Tool surface vs. capability:** The model-facing tool surface (what the model may see and call) is distinct from the underlying capability (the authority to perform an action); one capability may back several surfaces and one surface may resolve to different capabilities across providers and contexts.
- **Execution class vs. tool source:** The execution class names who owns a capability invocation — provider-native, provider-mediated developer-provided, Tuvren-server, or Tuvren-client — and is not the same as the tool source or the protocol used to reach the tool.
- **MCP as binding vs. execution class:** The Model Context Protocol is a binding/protocol mechanism that can appear under provider-mediated, Tuvren-server, or Tuvren-client execution; it is classified by who invokes or runs the MCP server, not treated as a top-level execution class.
- **Provider-native tools vs. local functions:** Provider-native tools are configured and exposed by Tuvren and executed by the provider; they are not modeled as locally executable functions, and Tuvren records only provider-exposed events and results for them.
- **Tuvren-client capabilities vs. server functions:** Client-side capabilities are leased endpoint capabilities executed in a client environment that may hold authority the server does not; they are not ordinary server functions and carry availability, lease, staleness, and partial-observability properties.

### 1.4 Strategic Direction (Near-Term)

The documented v1 runtime surface is functionally complete in the first implementation line. The near-term product goal is therefore not new runtime surface area but **trustworthiness and adoption**: making Tuvren Runtime something both its own maintainers and external host developers will build real products on.

- **Primary goal:** external host adoption combined with first-party dogfooding. Both audiences need the same thing first — a runtime whose durability, recovery, observability, and trust-boundary promises are demonstrably true.
- **Deprioritized (not abandoned):** multi-language implementation parity as an architectural showcase. The language-neutral semantic posture and authority discipline remain non-negotiable, but a second full implementation line is explicitly below adoption and dogfooding in priority.
- **Active scope:** the production-trust capabilities and constraints introduced in this revision (durability-under-failure verification, operational observability, and execution-safety / trust-boundary controls).
- **Deferred post-trust roadmap themes (to be planned in a later session, recorded in `Tasks.md` deferred scope):** performance characterization with regression budgets; public SDK API-stability guarantees and package publication; documentation and onboarding for external adopters; and a first-party reference application that dogfoods the SDK end to end. These themes are captured so a future planning session inherits clear focus; they are intentionally not decomposed into tickets yet.


## Appendix: Operator Preferences

- Formalize the project through the staged framework process, starting with a comprehensive PRD before architecture or implementation artifacts.
- Preserve the conceptual separation already established between kernel concerns and framework concerns while keeping the PRD technology-agnostic.
- Treat the first product-depth implementation line as TypeScript, with a serious REPL CLI as the proving host for the embeddable SDK rather than as a separate product direction.
- Keep the baseline TypeScript provider strategy limited to the AI SDK bridge while preserving Tuvren-owned provider semantics as portable authority.
- Treat the canonical event stream and SSE projection as portable runtime surfaces, while allowing AG-UI integration to remain implementation-specific because it depends on external SDK ecosystems.
- The proving host has now clarified the right high-level SDK boundary; the v1 commitment is one shared-primitive package with subpath exports plus one slim convenience package, with leaf packages peer-depending on the shared primitive package. Package publication and long-lived public-surface curation are no longer deferred and can be planned against this layout.
- Prefer path-level imports (subpath exports) for the shared-primitive layer; keep backends, stream adapters, drivers, provider bridges, and the MCP client as separate root-only-exported leaf packages.
- Treat schema-agnostic tool authoring as a first-class DX property; the v1 supported authoring styles are Zod (v3 and v4), Standard Schema-compliant schemas, and wrapped JSON Schema; additional adapters ship as separate optional packages and are not part of the core surface.
- Treat MCP client integration over both stdio and HTTP/SSE as v1 scope; MCP server-side projection remains deferred.
- Treat headless mode for the reference host as stdin-driven only; do not introduce a script-file interpreter or external scripting language.
- Treat the kernel-level `thread.list` syscall addition as the structural completion of the existing `branch.list` primitive; advertise enumeration capability per backend so object-store-style substrates can opt out and remain conformant.
