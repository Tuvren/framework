## 4. Functional Capabilities

### Epic: Durable Stateful Runtime Foundation

- **Priority:** P0
- **Capability ID:** CAP-P0-001
- **Capability:** The product must preserve agent execution as durable, inspectable state transitions rather than as only transient in-memory flow.
- **Rationale:** Long-running or interrupted agent work is only trustworthy if progress survives failures and can be audited.

- **Priority:** P0
- **Capability ID:** CAP-P0-002
- **Capability:** The product must maintain explicit lineage for each thread of work so builders can understand how the current state was reached and what prior states remain recoverable.
- **Rationale:** Stateful agent systems need trustworthy continuity, rollback, and auditability.

- **Priority:** P0
- **Capability ID:** CAP-P0-003
- **Capability:** The product must allow active work to continue on named alternate continuations without destroying previously committed history.
- **Rationale:** Exploration, rollback, and correction require preserved prior paths rather than destructive overwrite.

- **Priority:** P0
- **Capability ID:** CAP-P0-039
- **Capability:** The product must support first-party enumeration of the threads owned by a runtime instance at the kernel-level structural boundary, with a backend-advertised capability bit so storage substrates that cannot enumerate efficiently can opt out and remain conformant.
- **Rationale:** A host application developer cannot build a serious operator-facing product (recent-threads pane, multi-thread debugger, replay UI) without listing the threads the runtime owns; the kernel already exposes branch enumeration inside a thread, and thread enumeration is the symmetric structural primitive that completes that picture without violating the mechanism-not-policy rule.

### Epic: Turn Execution and Recovery

- **Priority:** P0
- **Capability ID:** CAP-P0-004
- **Capability:** The product must execute user-visible work in turns while allowing internal execution attempts to pause, fail, resume, or restart within that turn.
- **Rationale:** Human-visible continuity and machine execution continuity are related but not identical and must both be represented.

- **Priority:** P0
- **Capability ID:** CAP-P0-005
- **Capability:** The product must recover safely after interruption by distinguishing committed progress from incomplete work and resuming only what remains unfinished.
- **Rationale:** Crash-safe recovery is a core product promise for stateful agents.

- **Priority:** P0
- **Capability ID:** CAP-P0-006
- **Capability:** The product must commit execution progress at declared boundaries so that nondeterministic or side-effecting work does not depend on best-effort memory alone.
- **Rationale:** Builders need clear trust boundaries around what is durable and what may re-execute.

### Epic: Conversational and Structural State

- **Priority:** P0
- **Capability ID:** CAP-P0-007
- **Capability:** The product must retain conversational content in natural order while also exposing sufficient structure for runtime decisions about context, control flow, and status.
- **Rationale:** Agent systems need both human-readable history and machine-readable runtime state.

- **Priority:** P0
- **Capability ID:** CAP-P0-008
- **Capability:** The product must persist execution status that reflects whether work is running, paused, completed, failed, or partially interrupted.
- **Rationale:** Hosts, operators, and orchestrators need durable visibility into active execution state.

- **Priority:** P1
- **Capability ID:** CAP-P1-009
- **Capability:** The product must preserve a compact structural summary of active context so context-management decisions can be made without full history scans.
- **Rationale:** Long-lived agent sessions become impractical if every context decision requires re-reading everything.

### Epic: Context Engineering

- **Priority:** P0
- **Capability ID:** CAP-P0-010
- **Capability:** The product must support deliberate reshaping of the active context window, including reduction, replacement, or condensation of active material, without erasing historical traceability.
- **Rationale:** Practical agent runtime use requires controlling context growth while preserving audit history.

- **Priority:** P1
- **Capability ID:** CAP-P1-011
- **Capability:** The product must allow context engineering to operate as an explicit runtime action with visible consequences to subsequent execution.
- **Rationale:** Hidden or implicit context mutation makes agent behavior hard to explain and debug.

### Epic: Model and Tool Interaction

- **Priority:** P0
- **Capability ID:** CAP-P0-012
- **Capability:** The product must normalize model outputs into a canonical internal representation of conversational content, reasoning content, structured output, tool calls, tool results, and file-like payloads.
- **Rationale:** Builders need one stable runtime model even when upstream model providers differ.

- **Priority:** P0
- **Capability ID:** CAP-P0-013
- **Capability:** The product must execute requested tools, capture their results durably, and feed those results back into subsequent agent reasoning as part of the ongoing turn.
- **Rationale:** Tool execution is a core part of practical agent behavior and must be a first-class runtime concern.

- **Priority:** P0
- **Capability ID:** CAP-P0-014
- **Capability:** The product must preserve partial progress within a tool batch so completed tool work is not needlessly repeated after interruption.
- **Rationale:** Batch execution without partial durability produces duplicated side effects and wasted work.

- **Priority:** P1
- **Capability ID:** CAP-P1-015
- **Capability:** The product must validate tool inputs against declared contracts before execution and surface failures as agent-visible results rather than silent runtime corruption.
- **Rationale:** Tooling reliability depends on explicit validation and recoverable failure semantics.

- **Priority:** P0
- **Capability ID:** CAP-P0-040
- **Capability:** The product must offer a tool-authoring helper that accepts multiple schema authoring styles (Zod v3 and v4, Standard Schema-compliant schemas, and wrapped JSON Schema) without locking the host into one validator, while preserving strict TypeScript inference for the execute callback's input parameter and continuing to accept raw JSON Schema and the existing `CustomSchema` interop shape at the boundary contract.
- **Rationale:** A tool ecosystem that forces one validator narrows adoption, loses type inference whenever the host's chosen toolkit differs, and contradicts the product posture that ergonomics is a first-class outcome; the boundary contract must remain stable for portability, but the authoring helper is where the SDK earns its DX.

- **Priority:** P0
- **Capability ID:** CAP-P0-041
- **Capability:** The product must integrate with the Model Context Protocol as a first-class tool source, allowing a host to connect to any MCP server over stdio or HTTP/SSE and consume its advertised tools as Tuvren tool definitions without writing a bespoke bridge.
- **Rationale:** MCP is the emerging standard for AI tool ecosystems in 2026; a runtime claiming to rival LangChain/LangGraph cannot ignore the most active tool-ecosystem surface without forcing every host to write its own MCP adapter.

### Epic: Capability Orchestration and Execution Classes

- **Priority:** P0
- **Capability ID:** CAP-P0-056
- **Capability:** The product must separate the model-facing tool surface (what the model may see and call) from the underlying capability (the authority to perform an action), so that one capability can back multiple surfaces and one surface can resolve to different capabilities across providers and contexts.
- **Rationale:** A single `name + description + schema + execute` shape only describes a developer-defined function executed locally; it cannot honestly represent capabilities the provider executes, capabilities a provider invokes against a developer endpoint, or capabilities a client environment executes.

- **Priority:** P0
- **Capability ID:** CAP-P0-057
- **Capability:** The product must recognize four execution classes — provider-native, provider-mediated developer-provided, Tuvren-server, and Tuvren-client — each with distinct ownership of execution, state, credentials, observability, and control, and must not model all of them as locally executed functions.
- **Rationale:** These classes differ in who executes, who owns state, who owns credentials, who sees intermediate steps, who can cancel, retry, or audit, who pays, where data is processed, and whether behavior is portable; collapsing them into one abstraction makes runtime behavior unsafe to reason about.

- **Priority:** P0
- **Capability ID:** CAP-P0-058
- **Capability:** The product must resolve every model-visible tool call to a policy-checked capability invocation against a known execution class; provider-native invocations are the only case where the provider owns execution, and they must still be represented as known provider-native capabilities with explicit observation and control limits.
- **Rationale:** This invariant keeps the runtime honest: there is no untyped, unclassified tool call, and the runtime never silently assumes control it does not have.

- **Priority:** P0
- **Capability ID:** CAP-P0-059
- **Capability:** The product must bind a capability to a specific execution class and endpoint based on provider, model, policy, endpoint availability, and product configuration, and must allow one logical capability to have multiple possible bindings.
- **Rationale:** The same logical capability (for example search or code execution) may be served provider-native, Tuvren-server, provider-mediated, or client-side; the runtime must select or allow the binding rather than hard-coding one execution owner.

- **Priority:** P0
- **Capability ID:** CAP-P0-060
- **Capability:** The product must apply policy at two distinct decision points — before a tool surface is exposed to a model, and before a capability is invoked — covering at least provider/model compatibility, user and organization permissions, approval requirements, data-residency restrictions, active-endpoint requirements, user-presence requirements, credential boundaries, idempotency and retry behavior, and risk classification.
- **Rationale:** Exposure and invocation are different trust decisions; conflating them hides whether a capability was withheld from the model or merely blocked at call time.

- **Priority:** P0
- **Capability ID:** CAP-P0-061
- **Capability:** The product must bound and represent, per execution class, what it can observe, persist, resume, cancel, retry, and audit, and must distinguish runtime events that represent provider-native invocations from events that represent Tuvren-owned invocations.
- **Rationale:** Observation differs by execution class; the runtime must record provider-exposed events for provider-owned work and full-lifecycle events for Tuvren-owned work without overstating visibility.

- **Priority:** P1
- **Capability ID:** CAP-P1-062
- **Capability:** The product must treat the Model Context Protocol as a binding mechanism that can appear under provider-mediated, Tuvren-server, or Tuvren-client execution, classified by who invokes or runs the MCP server, rather than as a top-level execution class.
- **Rationale:** MCP is a protocol, not an execution owner; the same MCP server may be invoked by a provider, by Tuvren server-side, or by a client endpoint, with different observability and control in each case.

- **Priority:** P1
- **Capability ID:** CAP-P1-063
- **Capability:** The product must orchestrate Tuvren-client capabilities as leased endpoint capabilities, accounting for client availability, leases, stale endpoint responses, and partial observability, rather than as ordinary server functions.
- **Rationale:** Client environments may hold authority the server does not and should not hold; the runtime owns orchestration and policy while the client endpoint owns environmental execution.

### Epic: Human-in-the-Loop Governance

- **Priority:** P0
- **Capability ID:** CAP-P0-016
- **Capability:** The product must support approval-gated tool execution, including partial completion before pause and exact continuation after a human decision.
- **Rationale:** Real-world agent systems need governed execution for sensitive operations.

- **Priority:** P0
- **Capability ID:** CAP-P0-017
- **Capability:** The product must let a host provide approval decisions that approve, edit, reject, or otherwise resolve pending tool work without requiring a new conversational turn.
- **Rationale:** Approval resolution is operational control, not ordinary user chat.

- **Priority:** P1
- **Capability ID:** CAP-P1-018
- **Capability:** The product must make approval state visible to hosts and operators in a structured way that explains what is pending and what has already completed.
- **Rationale:** Effective human supervision requires clarity, not implicit pause states.

### Epic: Host Control and Streaming Observability

- **Priority:** P0
- **Capability ID:** CAP-P0-019
- **Capability:** The product must expose a host control surface that can start execution, stream runtime events, cancel work, inject steering, and resolve approvals.
- **Rationale:** Tuvren Runtime is meant to be embedded into host systems, so the host contract is part of the product, not a side detail.

- **Priority:** P0
- **Capability ID:** CAP-P0-020
- **Capability:** The product must emit a canonical stream of lifecycle, model, tool, control, and error events that downstream adapters can translate into other protocols.
- **Rationale:** Hosts and UIs need real-time insight into execution without coupling to provider-specific event shapes.

- **Priority:** P1
- **Capability ID:** CAP-P1-021
- **Capability:** The product must support both streaming and non-streaming model integrations while preserving a consistent outward event vocabulary.
- **Rationale:** Builders should not need separate host integrations for different provider transport modes.

- **Priority:** P1
- **Capability ID:** CAP-P1-022
- **Capability:** The product must support non-destructive steering that injects user intent between iterations of a running turn.
- **Rationale:** Hosts need a way to redirect active work without discarding committed progress.

- **Priority:** P0
- **Capability ID:** CAP-P0-042
- **Capability:** The product must expose a unified terminal-value surface on every execution handle so that a host can await an execution's completion as a single promise resolving to a structured execution result, without having to derive completion from raw event iteration or status polling. The same surface must exist on both single-turn execution handles and orchestration handles.
- **Rationale:** Every serious host treats "await this turn's final value" as a primitive; today only orchestration handles expose it, forcing single-turn hosts to hand-roll the same plumbing the reference host already wrote internally.

### Epic: Single-Tenant Durable-Read Surface

- **Priority:** P0
- **Capability ID:** CAP-P0-043
- **Capability:** The product must let a host list the threads owned by the runtime instance it is operating, with cursor-based pagination and optional filters, through the host-facing SDK alone.
- **Rationale:** A serious operator-facing product needs a recent-threads or thread-picker surface; today the host cannot list threads at all, which forces it either to maintain a parallel index or to pierce kernel internals.

- **Priority:** P0
- **Capability ID:** CAP-P0-044
- **Capability:** The product must let a host list the branches that exist within a thread it owns through the host-facing SDK.
- **Rationale:** Branching is a first-party kernel concept; the host cannot reason about exploratory paths or rollback positions without enumerating them, and the kernel already supports the underlying structural enumeration.

- **Priority:** P0
- **Capability ID:** CAP-P0-045
- **Capability:** The product must let a host read the structured runtime state at any specific TurnNode of a branch it owns through the host-facing SDK.
- **Rationale:** Debugging, replay, and time-travel inspection all require reading the exact state at a chosen turn, not only the current head.

- **Priority:** P0
- **Capability ID:** CAP-P0-046
- **Capability:** The product must let a host walk the turn history of a branch it owns through the host-facing SDK, using a cursor that is meaningful inside the runtime's lineage model, in newest-first order, and as an async iterator that does not require loading the entire history into memory.
- **Rationale:** Conversation history scrollback and audit trails are bounded by the host's display window, not by the runtime's full lineage depth; an async-iterator cursor is the only shape that scales to long-lived threads.

- **Priority:** P0
- **Capability ID:** CAP-P0-047
- **Capability:** The product must let a host read the durable conversational messages of a branch it owns through the host-facing SDK without requiring the host to reconstruct messages from TurnTree references and the content-addressed object store by hand.
- **Rationale:** Reading "the messages on this branch" is the most common host operation; today it requires composing tree resolution, store reads, and content decoding manually, which is exactly why the reference host had to introduce a private inspector.

### Epic: Extensibility and Policy Composition

- **Priority:** P0
- **Capability ID:** CAP-P0-023
- **Capability:** The product must let builders add composable cross-cutting behaviors that can observe, influence, or wrap execution at defined lifecycle points.
- **Rationale:** Governance, telemetry, budget control, approval policy, and domain behavior should be additive rather than hard-coded into the core.

- **Priority:** P1
- **Capability ID:** CAP-P1-024
- **Capability:** The product must allow extensions to maintain their own scoped persisted state and expose declared shared outputs to other runtime participants.
- **Rationale:** Useful extensions require continuity across iterations and sometimes across agents.

- **Priority:** P1
- **Capability ID:** CAP-P1-025
- **Capability:** The product must support pluggable policies for context shaping, prompt rendering, loop continuation, and tool execution.
- **Rationale:** Different agent products need different execution policies without redefining the runtime’s core ontology.

### Epic: Driver Modularity

- **Priority:** P0
- **Capability ID:** CAP-P0-033
- **Capability:** The product must support a shared runtime foundation that can host multiple execution drivers over time rather than hard-coding one execution model as the whole framework.
- **Rationale:** Durable state, host control, provider neutrality, and orchestration primitives should be reusable across ReAct-style agents and future workflow-oriented drivers.

- **Priority:** P1
- **Capability ID:** CAP-P1-034
- **Capability:** The product must ship with one primary driver-first baseline, centered initially on a ReAct-style execution model, while keeping room for future workflow, routing, evaluator, or orchestration-focused drivers.
- **Rationale:** Tuvren Runtime needs one strong default execution path now without letting that first choice become an accidental product monopoly.

### Epic: Multi-Agent Orchestration

- **Priority:** P0
- **Capability ID:** CAP-P0-026
- **Capability:** The product must support delegated worker execution as a first-class pattern for subordinate tasks whose results return to a parent workflow.
- **Rationale:** Complex agent systems often need bounded sub-work without transferring full control.

- **Priority:** P0
- **Capability ID:** CAP-P0-027
- **Capability:** The product must support explicit handoff between agent configurations within the same ongoing work item while preserving continuity and traceability.
- **Rationale:** Specialization requires transfer of responsibility without pretending the work started over.

- **Priority:** P1
- **Capability ID:** CAP-P1-028
- **Capability:** The product must support pipeline-style agent sequences where one agent’s output becomes the next agent’s starting context.
- **Rationale:** Many multi-agent workflows are structured pipelines rather than open-ended collaboration.

- **Priority:** P1
- **Capability ID:** CAP-P1-029
- **Capability:** The product must preserve the distinction between worker execution, handoff, and sequence progression in both runtime behavior and observable events.
- **Rationale:** These patterns solve different user problems and should not collapse into one vague orchestration mechanism.

### Epic: Portability and Provider Neutrality

- **Priority:** P0
- **Capability ID:** CAP-P0-030
- **Capability:** The product must provide a provider-neutral internal model so that agent behavior does not depend on any one provider’s wire format or naming conventions.
- **Rationale:** Tuvren Runtime’s product value depends on stable internal semantics even as model ecosystems change.

- **Priority:** P1
- **Capability ID:** CAP-P1-031
- **Capability:** The product must preserve opaque provider continuity artifacts when needed for correct multi-turn operation without promoting provider-specific concepts into the core product language.
- **Rationale:** Portability requires a neutral core, but operational correctness may still depend on carrying provider-specific continuity data through the system.

- **Priority:** P1
- **Capability ID:** CAP-P1-035
- **Capability:** The product must preserve language-neutral semantic seams so future TypeScript, Rust, Go, Python, Zig, or other implementations can share one runtime meaning rather than drifting behind per-language wrappers.
- **Rationale:** Long-term portability only matters if multiple implementations can remain part of one semantic ecosystem instead of becoming parallel products.

- **Priority:** P1
- **Capability ID:** CAP-P1-036
- **Capability:** The product must let implementations prove parity through shared machine-readable contracts and behavioral fixtures instead of relying on one language codebase as the long-term oracle.
- **Rationale:** Durable multi-language portability needs executable semantic evidence, not only prose promises or reference-implementation folklore.

- **Priority:** P0
- **Capability ID:** CAP-P0-037
- **Capability:** The product must guarantee that no single implementation language, runner codebase, or human-prose document can act as the source of cross-implementation semantic truth; every binding cross-language semantic must live in a boundary-owned machine authority packet that pairs machine-readable sources with at least one executable verification path.
- **Rationale:** Multi-language portability collapses the moment a TypeScript file, Rust crate, generic runner, or Markdown specification becomes the de facto oracle, because future implementations are then forced to chase implementation accidents rather than honor a shared meaning.

- **Priority:** P1
- **Capability ID:** CAP-P1-038
- **Capability:** The product must let a new implementation be built and judged against shared meaning by inspecting only authority packets, generated artifacts, conformance plans, fixtures, language-binding adapters, and measured evidence, without reading another language's implementation source, a generic runner's hard-coded assertions, or Markdown prose as the binding semantic source.
- **Rationale:** Adding a new language line is only an honest portability claim when the work is reproducible from boundary-owned machine authority alone.

### Epic: Host Developer Ergonomics

- **Priority:** P0
- **Capability ID:** CAP-P0-048
- **Capability:** The product must expose a single batteries-included entrypoint that assembles a working runtime (kernel, backend, driver registry, framework runtime) from one curated factory call so a host developer can issue a first Turn without composing five lower-level factories, while retaining the ability to substitute any of those substrates when the host's needs require it.
- **Rationale:** First-Turn time-to-value is a measurable adoption lever; every serious agent SDK in 2026 has a one-call composition story, and the absence of one is the strongest single contributor to perceived complexity in the current host-facing surface.

- **Priority:** P0
- **Capability ID:** CAP-P0-049
- **Capability:** The product must expose one curated host-facing SDK boundary composed of a single shared-primitive package with named subpath exports and a slim convenience package that bundles the batteries-included entrypoint and the curated primitive re-exports, with all leaf packages (backends, stream adapters, drivers, provider bridges, MCP client) peer-depending on the shared-primitive package so that consumers experience a coherent SDK surface and never carry mismatched primitive versions.
- **Rationale:** The current split into multiple separately-versioned contract packages forces every consumer to depend on the right combination of five primitive packages and risks version skew between primitive packages; one shared-primitive package with subpath exports is the convergent pattern in comparable ecosystems and is the only way to ship a coherent SDK without bundle-size penalties or unsafe duplicated primitive instances.

### Epic: Reference Host Operational Ergonomics

- **Priority:** P1
- **Capability ID:** CAP-P1-050
- **Capability:** The product must expose a headless operating mode of the reference host that consumes line-delimited input on stdin and emits structured output, intended for tests, scripts, and operations tooling, sharing the same package, same command set, and same execution path as the interactive mode.
- **Rationale:** Interactive-only proving hosts cannot be exercised in CI without bespoke scaffolding; a stdin-driven mode shares all behavior with the interactive surface and gives test authors and operations scripts a single durable target.

- **Priority:** P1
- **Capability ID:** CAP-P1-051
- **Capability:** The product must allow the reference host to capture a session transcript to durable on-disk storage and to replay a captured transcript against a fresh runtime instance for postmortems and regression tests.
- **Rationale:** Debugging interactive sessions without a transcript is fragile; replayability turns one-off operator sessions into reusable regression fixtures and makes incident investigation tractable.

### Epic: Reader and Operator Clarity

- **Priority:** P1
- **Capability ID:** CAP-P1-032
- **Capability:** The product must be explainable through a stable set of canonical concepts so builders can reason about behavior without reverse-engineering implementation details.
- **Rationale:** A runtime this foundational only becomes adoptable if its conceptual model is teachable and inspectable.

### Epic: Operational Observability and Telemetry

- **Priority:** P0
- **Capability ID:** CAP-P0-052
- **Capability:** The product must expose a first-class operational telemetry surface that makes the lifecycle of a turn observable after the fact — model interactions, tool calls, checkpoints, approvals, recovery events, and errors — as structured, correlated records keyed to the runtime's own lineage concepts, distinct from the real-time host event stream and usable for operating and debugging the runtime in production.
- **Rationale:** The real-time host event stream (CAP-P0-020) serves a UI consuming a live turn; operating Tuvren in production additionally requires durable, correlatable telemetry for postmortems, performance investigation, and incident response. Without it, the durability and recovery promises cannot be observed or trusted in a running system.

- **Priority:** P1
- **Capability ID:** CAP-P1-053
- **Capability:** The product must allow operational telemetry to be exported to standard, vendor-neutral observability tooling without coupling the runtime's canonical telemetry vocabulary to any one observability vendor or wire format.
- **Rationale:** Adopters operate Tuvren inside existing observability stacks; a vendor-neutral export path is the difference between telemetry that is usable in production and telemetry that is trapped inside the runtime.

### Epic: Execution Safety and Trust Boundaries

- **Priority:** P0
- **Capability ID:** CAP-P0-054
- **Capability:** The product must enforce bounded execution so that a single turn cannot run unbounded iterations, tool calls, or resource consumption; when a configured bound is reached, the runtime must stop safely and surface the outcome as a host-visible failed result plus a live runtime-stream failure signal rather than looping or exhausting resources silently.
- **Rationale:** A runtime that hosts untrusted model output and external tools cannot be trusted in production if a misbehaving agent can loop forever or exhaust resources; bounded execution is the difference between a recoverable failure and an outage.

- **Priority:** P0
- **Capability ID:** CAP-P0-055
- **Capability:** The product must isolate sensitive credentials and provider secrets from durable state, operational telemetry, and transcripts, so that persisted history, exported observability data, and replayable transcripts never carry secrets that were only needed transiently to reach a provider or tool.
- **Rationale:** The runtime's durability, observability, and replay surfaces all persist or emit execution data; without explicit isolation, the very features that make Tuvren trustworthy would become the channel through which credentials leak.

### 4.1 Scope Notes

- The PRD intentionally treats persistence, streaming, tool dispatch, approvals, context engineering, orchestration, host-developer ergonomics, single-tenant durable reads, and the curated SDK surface as product capabilities because they materially define the user-facing value of Tuvren Runtime as a runtime.
- The initial active product line is the shared runtime foundation plus the ReAct Driver, not a commitment to implement every possible driver pattern in the first release line.
- The first product-depth implementation line is expected to prove nearly the whole documented runtime surface through a serious reference host rather than carrying large core features as indefinite “later” promises.
- This PRD does not prescribe the concrete storage engine, programming language, packaging layout, or transport stack used to implement those capabilities, except where it explicitly commits to one curated host-facing SDK boundary and to the MCP wire protocol as the supported tool-ecosystem surface.
- Long-term portability is a boundary-preservation goal, not a rewrite mandate; future implementation lines must extend the shared semantic system rather than replace it wholesale.
- The proving-host clarification of the right high-level SDK boundary that was previously deferred is now considered closed; the consolidated curated SDK surface and the batteries-included entrypoint are the v1 commitments and downstream artifacts may plan around them.
- The capability-orchestration model reframes how tools are represented without removing any existing tool capability: a developer-defined tool executed by the runtime (CAP-P0-013) is the Tuvren-server execution class, validated tool inputs (CAP-P1-015) and approval gating (CAP-P0-016/CAP-P0-017) continue to apply, and the MCP client integration (CAP-P0-041) becomes an MCP binding. Provider-native, provider-mediated, and Tuvren-client classes are additive.
- The capability-orchestration capabilities (CAP-P0-056 through CAP-P1-063) define the target model; their implementation is phased, with the core split delivered first and the deep per-class build-out (notably the Tuvren-client endpoint lifecycle and advanced policy) sequenced behind it. The PRD commits to the model; sequencing lives in the execution plan.

### 4.2 Distinction Notes

- A paused turn is not a completed turn and not a failed turn; it represents approval-gated continuation of already-started work.
- A handoff is not a worker result and not a branch creation; it is a control transfer within the same ongoing work item.
- Context engineering changes the active working set, not the fact that prior committed history still exists.
- Semantic neutrality is not toolchain neutrality; implementations may use native package and build workflows while preserving shared runtime meaning at the boundary seams.
- Authority-packet ownership is not artifact format ownership; an authority packet may pair multiple machine-readable formats (such as logical contract sources, binary grammar, transport projections, telemetry vocabulary, and conformance plans) under one boundary, but no single format silently becomes the meaning of the surface.
- A proving host is not a privileged exception to the SDK story; it exists to prove that the same host-facing abstractions are sufficient for serious downstream products, which means the proving host cannot rely on any seam that is not part of the host-facing SDK boundary.
- A durable-read surface is not a hosted discovery service; it lets a host inspect, list, and replay the state of the runtime instance it owns, but it does not provide cross-tenant search, indexed querying, or multi-tenant access control.
- A schema-authoring helper is not a boundary contract; the helper accepts richer schema shapes for type inference and ergonomics, but the boundary contract still accepts raw JSON Schema and the existing `CustomSchema` interop shape, so portability and conformance are unaffected.
- The MCP client integration is not an MCP server projection; the runtime can consume any MCP server's tools, but does not expose itself as an MCP server in v1.
- A headless mode is not a script-file interpreter; the reference host accepts line-delimited input on stdin, exactly the same input shape as the interactive mode, with no out-of-band scripting language.
- A curated SDK surface is not a megapackage; primitives live in one shared package with subpath exports, but backends, stream adapters, drivers, provider bridges, and the MCP client remain separate leaf packages that peer-depend on the shared primitives.
- Tool surface, capability, binding, and execution class are four distinct concepts: the surface is model-facing, the capability is the authority to act, the binding ties a capability to an execution class and endpoint, and the execution class names who owns the invocation.
- Exposure-time policy and invocation-time policy are distinct decisions: one decides whether the model ever sees a surface, the other decides whether a resolved capability may actually run.


## 6. Boundary Analysis

### In Scope

- A runtime kernel that preserves durable execution state, lineage, and recoverable history
- A framework layer that executes agent turns, manages iteration, and incorporates model and tool work
- A serious REPL-style reference host that proves the embeddable SDK can drive a real operator-facing agent product without private shortcuts, in both an interactive and a headless mode
- A headless operating mode for the reference host that consumes line-delimited stdin input and emits structured output
- Transcript capture and replay for reference-host sessions
- Canonical runtime representations for messages, reasoning content, structured output, tool calls, tool results, and file-like payloads
- Context engineering for active-context pruning, summarization, compaction, or replacement while preserving audit history
- Host-facing controls for event consumption, awaiting terminal values, cancellation, steering, and approval resolution
- A unified terminal-value surface on every execution handle
- A single-tenant durable-read surface on the host-facing SDK covering thread listing, branch listing, state at any TurnNode, cursor-based turn history walking, and branch-message reads
- A first-party kernel-level thread enumeration primitive with backend-advertised capability for substrates that cannot enumerate efficiently
- Human-in-the-loop approval flows for sensitive tool execution
- Extension and policy composition at defined lifecycle points
- Provider-neutral model integration with canonical streaming and non-streaming behavior
- Multi-agent orchestration patterns including workers, handoffs, and sequences
- A batteries-included host-facing SDK entrypoint that assembles kernel, backend, driver registry, and framework runtime from one curated factory call
- A consolidated curated SDK surface composed of one shared-primitive package with subpath exports and a slim convenience entrypoint, with leaf packages peer-depending on the shared primitives
- A schema-agnostic tool-authoring helper supporting Zod, Standard Schema, and wrapped JSON Schema with strict type inference while preserving raw JSON Schema and the existing `CustomSchema` interop shape at the boundary contract
- A first-class Model Context Protocol client integration that consumes external MCP servers over stdio and HTTP/SSE as tool sources
- A language-neutral semantic foundation that can support more than one implementation line over time through shared contracts, conformance artifacts, and compatibility evidence
- A boundary-owned machine authority surface where every cross-implementation semantic is anchored to authority packets, generated artifacts, conformance plans, and measured evidence rather than to any one language's implementation, runner code, or prose document
- Reproducible fault-injection and crash-recovery verification that proves the durability and recovery guarantees across every supported storage substrate
- A first-class operational telemetry surface covering turns, model and tool interactions, checkpoints, approvals, and recovery events, with an optional vendor-neutral export path
- Execution-safety controls that bound iterations, tool calls, and resource usage and stop safely when a limit is reached
- Credential and secret isolation that keeps sensitive values out of durable state, operational telemetry, and transcripts
- A capability-orchestration model that separates the model-facing tool surface from the underlying capability and binds capabilities to execution classes and endpoints
- Recognition of four execution classes — provider-native, provider-mediated developer-provided, Tuvren-server, and Tuvren-client — with distinct execution, state, credential, observability, and control ownership
- Exposure-time and invocation-time policy decisions over tool surfaces and capabilities
- Per-execution-class observation and control limits, and a runtime event distinction between provider-native and Tuvren-owned invocations
- Classification of MCP as a binding mechanism across execution classes rather than as an execution class

