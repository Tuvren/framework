## 3. Actors & Personas

### 3.1 Primary Actor

- **Role:** Runtime Integrator
- **Context:** Builds an agentic product, platform feature, internal tool, or service that needs durable execution rather than one-shot prompting.
- **Goals:** Embed a runtime that can preserve state, recover progress, govern tool execution, manage context growth, and support advanced agent patterns without bespoke infrastructure.
- **Frictions:** Existing agent tooling often hides execution state, couples behavior to vendor specifics, loses progress on failure, and makes pause/resume or multi-agent control feel improvised.

### 3.2 Host Application Developer

- **Role:** Host Application Developer
- **Context:** Exposes Tuvren Runtime through an API, UI, CLI, editor integration, or protocol bridge. Builds an operator-facing product (for example an IDE coding agent, a CLI assistant, an ambient agent runner, or a web console) on top of the host-facing SDK and expects to reach a working first Turn within minutes, list and inspect threads owned by the runtime, replay past sessions, and connect external Model Context Protocol servers without writing bespoke adapters.
- **Goals:** Start turns, consume streamed events, await terminal values, inject steering, route approvals, surface execution status, list threads and branches the host owns, read state at any TurnNode, replay past sessions, and connect external tool servers without owning the runtime semantics.
- **Frictions:** Needs one batteries-included entrypoint instead of composing five low-level factories; needs a uniform terminal-value surface instead of hand-rolling completion detection from event streams; needs first-party durable reads instead of reaching around the SDK into kernel internals; needs to keep schema-authoring choices open (Zod, Standard Schema, raw JSON Schema) rather than being forced into one validator; needs first-class MCP support to access the existing tool ecosystem.

### 3.3 Extension and Tool Author

- **Role:** Extension and Tool Author
- **Context:** Adds cross-cutting policy, observability, gating, or domain-specific tool behavior around agent execution.
- **Goals:** Intervene in execution predictably, add tools cleanly, express approvals or policy decisions without breaking runtime guarantees, and author tools using their preferred schema toolkit while still getting type inference for the execute callback's input.
- **Frictions:** Ad hoc hook systems are easy to misuse and often blur durable behavior with ephemeral wrappers; tool-authoring surfaces that force one validator narrow the ecosystem and lose type inference whenever the host's chosen toolkit differs.

### 3.4 Human Approver or Supervisor

- **Role:** Human Approver or Supervisor
- **Context:** Must review sensitive or consequential actions while the agent is mid-turn.
- **Goals:** Understand what the runtime is asking to do, approve or reject safely, and resume work without duplicated or lost side effects.
- **Frictions:** Approval systems often lack durable continuity, forcing operators to choose between safety and productivity.

### 3.5 Multi-Agent Workflow Designer

- **Role:** Multi-Agent Workflow Designer
- **Context:** Coordinates specialists, workers, or pipelines that need to share responsibility without collapsing traceability.
- **Goals:** Delegate subtasks, hand off control, forward worker signals, and preserve execution lineage across agent boundaries.
- **Frictions:** Many systems conflate delegation with transfer of control or make multi-agent behavior impossible to inspect after the fact.

### 3.6 Runtime Implementation Maintainer

- **Role:** Runtime Implementation Maintainer
- **Context:** Must extend or maintain Tuvren Runtime in a new language, runtime, or process boundary without weakening the kernel/framework semantics already promised to hosts and builders.
- **Goals:** Consume stable contracts, prove behavior against shared fixtures, preserve observability and compatibility signals, and add new implementation lines without creating a shadow specification.
- **Frictions:** Ports often drift into rewrites, language-specific toolchains often leak into semantic boundaries, and shared behavior usually becomes folklore unless parity is enforced mechanically.

### 3.7 Reference-Host Operator and Test Author

- **Role:** Reference-Host Operator and Test Author
- **Context:** Uses the first-party reference host to exercise, demo, debug, or regression-test the runtime end to end, either at the interactive REPL or as a headless stdin-driven process inside CI, evaluation suites, or operations scripts.
- **Goals:** Drive the runtime through every host-facing capability the SDK exposes, capture on-disk transcripts of meaningful sessions, replay those transcripts for postmortems and regressions, and trust that everything the reference host can do is achievable by any downstream host through the same SDK.
- **Frictions:** Interactive-only tooling is hard to embed in CI; transcript-less debugging is fragile; reference hosts that pierce private seams give false confidence about what downstream products can build.

### 3.8 Capability and Endpoint Integrator

- **Role:** Capability and Endpoint Integrator
- **Context:** Configures which capabilities a runtime instance may use, how they are surfaced to models, and where they execute — enabling provider-native tools, configuring provider-mediated tools, registering Tuvren-server capabilities, and attaching client endpoints.
- **Goals:** Expose the right tool surfaces per provider and model; choose or allow the execution class and endpoint for each capability; apply exposure and invocation policy; and rely on honest per-class observation and control limits rather than assuming uniform runtime control.
- **Frictions:** A single tool abstraction hides who executes, who owns state, who owns credentials, who can cancel or retry, and what is observable; forcing provider-native, provider-mediated, server-side, and client-side capabilities into one shape makes runtime behavior unsafe to reason about.

