# Realign interview rulings

- **Date:** 2026-08-19
- **Target:** Realign
- **Mode for follow-up stages:** Evolution
- **Interview depth:** Full sweep

## Outcome

The constitution must describe Tuvren as a framework, not as a runtime product. The active product phase is **1.0 Framework Stabilization**.

SaaS readiness remains an active quality dimension until its guarantees pass dogfood, conformance, and release evidence.

The realignment must follow this authority chain: Product Requirements Document (PRD), Architecture, Technical Specification (TechSpec), and Tasks.

Each stage must use Evolution mode. It must not preserve a stale shape only because an earlier skill version produced it.

## Product identity and archetype

- The canonical product name is **Tuvren**. The runtime is one internal framework component.
- The sole product archetype is `Library/SDK`, with high confidence.
- Tuvren competes for the host-development job served by agent frameworks and SDKs. It is not a hosted service, reference-host product, or command-line product.
- The reference Read-Eval-Print Loop (REPL) host is a golden example and proving asset. Promotion to a product requires a separate Evolution decision after the framework stabilizes.

## Actors

- **Framework Adopter** supersedes **Runtime Integrator** and **Host Application Developer**. A Framework Adopter builds a command-line interface, software-as-a-service server, service, browser host, or another host shape with Tuvren.
- Advanced Framework Adopters can implement providers, tools, Model Context Protocol (MCP) server integrations, runners, persistence backends, transports, telemetry exporters, and approval mechanisms through supported public surfaces.
- ReAct extensions and middleware remain a ReAct Runner surface. They are not a framework-wide abstraction.
- **Framework Contributor** maintains Tuvren internals and first-party packages. A Framework Adopter can contribute work upstream without changing actor identity.
- **Human Approver** remains a distinct runtime actor who interacts through a host-shaped interface.
- Multi-Agent Designer, Extension or Tool Author, and Capability or Endpoint Integrator become advanced Framework Adopter specializations.
- Runtime Implementation Maintainer and Reference Host Operator or Test Author become Framework Contributor specializations.

The user chose this consolidation because adopter intent depends on using the framework, not on the host form or depth of customization.

## Adopter experience and public surfaces

The golden adoption path is:

1. Install a public package.
2. Configure providers, tools, persistence, and a runner.
3. Expose a host-specific interface.
4. Test locally.
5. Deploy the host.
6. Observe, recover, and upgrade executions.

Tuvren owns framework internals throughout this path. Framework Adopters must work through deliberate, documented, and compatibility-governed public surfaces.

The authoritative package model is:

- `@tuvren/sdk` is the canonical composition and adopter entry point.
- `@tuvren/core` contains shared public contracts and primitives in the preview surface.
- Selected leaf packages expose deliberate advanced extension surfaces.
- `@tuvren/runtime` is implementation infrastructure. Documentation must not present it as the normal host entry point.
- An internal package can remain published for package-resolution needs without receiving a public support promise.

## Execution and lineage model

The canonical hierarchy remains `Thread -> Branch -> Turn -> Run -> Step`.

- A Thread is a durable line of work or conversation.
- A Branch is an advanced lineage concept. It can remain outside the first-use path.
- A Turn is one host-submitted interaction.
- A Run is a bounded kernel execution and checkpoint unit that serves part or all of a Turn.
- Multiple Runs are normal within one Turn. They can cover input incorporation, runner iterations, context engineering, finalization, and recovery.
- A Step is a framework-canonical unit of execution, such as model inference, tool invocation, approval wait, handoff, or context transformation.
- An Event is an immutable observation of Run or Step progress. Multiple Events can describe one Step.
- `TurnNode` and `TurnTree` remain advanced durable-state concepts.

A Step has one stable logical identity. Each physical retry has a distinct Step Attempt identity.

The Step lifecycle contains `pending`, `running`, `waiting`, `succeeded`, `failed`, `cancelled`, and `indeterminate`. Conditional work that a runner doesn't schedule doesn't create a skipped Step.

These Step and Step Attempt semantics are accepted target behavior. They don't state that implementation is complete.

The active kernel authority models immutable Step declarations and sequence position but doesn't provide the full lifecycle.

The realignment must reconcile PRD, Architecture, TechSpec, machine authority, conformance, and implementation before claiming support.

A failed Run doesn't automatically fail its Turn. Recovery can create a successor Run while the Turn can continue. After a Turn reaches a terminal state, continuation creates a linked Turn rather than mutating terminal history.

The host declares Thread state:

- `open` accepts Turns.
- `closed` rejects Turns but remains immediately readable and can reopen.
- `archived` permits storage optimization and different latency while preserving correct reads and mandatory reopening.

Archival is not erasure. Tuvren must not infer when a Thread is complete.

Branch merge and generalized multi-agent aggregation remain unresolved. See the open-decisions report.

## Provider, tool, and approval failures

Provider failure handling must:

- Enforce configured deadlines and bounded retries.
- Normalize provider failures into stable framework errors.
- Preserve attempt and telemetry history.
- Prohibit silent provider switching.
- Permit an adopter-configured fallback policy.
- Let the runner schedule another Step Attempt, wait, degrade, fail the Run, or preserve Turn continuation through a successor Run.

For local tools and remote MCP calls, Tuvren owns the runner-visible invocation lifecycle. It doesn't claim control of an external process's internal lifecycle.

- A failure before dispatch can retry under policy.
- An explicit tool error returns to the runner.
- An invalid response is a contract failure.
- A timeout or disconnect after dispatch produces an indeterminate outcome unless evidence proves the result.
- A side-effecting retry requires stable idempotency identity or explicit host authorization.
- Cancellation is bounded and observable. Unacknowledged external cancellation doesn't prove that a side effect didn't occur.
- Tool and MCP adapters must declare cancellation capability before dispatch and report runtime acknowledgement.

Approval routing and identity are host-owned. Tuvren owns durable pause, approve, reject, expire, cancel, duplicate-decision handling, crash recovery, provenance, and safe resume semantics.

## Persistence, policy, and telemetry failures

Durable execution must fail closed when persistence is unavailable or inconsistent. Tuvren must not report durable progress before commit. A durable Run must not silently continue in memory.

Persistence failure handling must:

- Distinguish transient availability failure from corruption or invariant failure.
- Retry only operations that are proven safe to repeat.
- Preserve recoverable intent after an ambiguous commit outcome.
- Prevent continuation from state that was emitted but not durably committed.

Capability policy is evaluated when Tuvren exposes a Tool Surface and immediately before invocation. Invocation-time denial wins. An already dispatched operation follows host policy and the adapter's cancellation capability.

Operational telemetry is separate from correctness-bearing content state:

- Exporters use bounded buffering and an adopter-configured overflow policy.
- Exporter failure doesn't block a Run indefinitely.
- Dropped telemetry produces an observable health signal.
- A lossless compliance ledger is a distinct durable integration.

## Scope and data lifecycle

Scope is an opaque, host-bound isolation identity. A host can compose tenant, customer, workspace, user, or other identifiers into a Scope. Tuvren must not parse or derive hierarchy from the value.

Every implementation must enforce one portable Scope identity contract. The TechSpec must set the encoding and length limits from measured backend constraints.

Tuvren owns a race-safe Scope lifecycle:

1. `open` accepts work.
2. `closing` rejects new work and applies the host's bounded drain or cancellation policy. Application-content writes stop at the cutoff. Only lifecycle-maintenance writes can continue.
3. `retired` prevents reuse and permits final retention, erasure, and reclamation work.

This lifecycle and cold-crash side-effect safety are 1.0 blockers.

Erasure guarantees apply at the Scope boundary. The host selects Scope granularity and owns retention policy and keys.

The opaque `keyRef` remains an advanced codec mechanism without a subject-level product guarantee. Tuvren must correct claims that imply managed intra-Scope subject erasure.

The user chose Scope-level erasure because hosts can construct Scope values at the granularity their data model requires. Tuvren can't embed every host ownership model.

## Streaming, replay, and AG-UI

Resumable streaming is a standard-neutral Tuvren guarantee:

- Execution ownership is independent of a socket.
- Disconnect doesn't cancel work unless host policy says it does.
- Delivery is ordered and at least once within the advertised retention window.
- Stable projected-frame identity permits client deduplication.
- Replay never reruns a Step.
- A replay gap returns an explicit outcome and falls back to a snapshot derived from durable state.
- One slow client can't stall a Run.

Responsibility is divided as follows:

- Framework core owns canonical Event and durable-history semantics.
- A Tuvren-provided, standard-neutral resume and session layer owns sequencing, cursors, replay outcomes, gap handling, projected-frame retention, and snapshot protocol behavior.
- The host configures authentication, session lookup, buffer capacity, retention time, and durable-state access.
- A replacement host-session implementation must conform to the same Tuvren replay and snapshot contract.
- A transport maps cursors to its protocol, such as Server-Sent Events (SSE) identifiers or a WebSocket envelope.
- A frontend stores its last applied cursor, deduplicates frames, and resets from snapshots after a gap.

Agent User Interaction Protocol (AG-UI) is a first-party projection over the Tuvren transport contract. AG-UI must receive the same resume guarantees. Tuvren must not attribute those guarantees to the upstream AG-UI specification.

One canonical Event can expand into several AG-UI events. Replay must sequence actual projected frames or an explicitly atomic projected batch.

The private host-session, remote-session, and session-client packages remain proving components. They can become supported public packages only after adopter need, contract stability, compatibility policy, and conformance evidence justify publication.

Reasoning persistence has no implicit default. When reasoning is enabled, the host must select a policy such as ephemeral streaming, encrypted durability, or suppression. Tuvren must not silently persist or discard reasoning.

## Multi-language scope

TypeScript remains the only supported full Framework implementation during stabilization.

Rust, Go, Python, and Dart kernel ports are conformance proofs and feedback instruments for language-neutral authority.

A kernel port can become the foundation of another Framework implementation only after a separate product decision.

The cached kernel gate must include every promoted implementation, including Rust. A metadata-driven Bazel graph must add promoted ports automatically. The fresh gate must prove the same set without cache.

## Stabilization and dogfood

The first dogfood target is the interactive agent host. The unrelated deterministic background pipeline is outside Tuvren scope.

The dogfood path must exercise:

- Public SDK adoption.
- Durable Threads and snapshots.
- Provider and tool normalization.
- Dynamic capability exposure.
- Mixed streaming content.
- Reconnection and stale-client protection.
- Content and telemetry separation.
- Failure classification and cancellation.

Snapshot resynchronization and fine-grained cursor replay must both meet the 1.0 framework contract. The interview didn't set their implementation order.

The following list contains every 1.0 requirement settled in this interview:

- Adopter success through public surfaces only.
- SaaS-readiness guarantees that pass dogfood, conformance, and release evidence.
- Explicit stable and experimental boundaries.
- Authority-backed execution, recovery, approval, streaming, and Scope semantics.
- A race-safe `open -> closing -> retired` Scope lifecycle, including application-write cutoff and bounded drain or cancellation.
- Snapshot resynchronization and cursor replay through the standard-neutral Tuvren transport contract and first-party AG-UI projection.
- Complete public API documentation and migration policy.
- A golden REPL that imports only public SDK surfaces.
- Persistence recovery, migration, and performance evidence.
- One release-gate command that passes from a clean checkout without undocumented generation steps.
- Reliable release automation and immutable published versions.
- Closure of cold-crash side-effect safety.
- Competitive developer-experience evidence.
- A versioned GDPR responsibility map and SOC 2 control-support crosswalk with explicit host responsibilities.

## Competitive evidence

The required TypeScript cohort is:

- LangGraph JS, with LangChain `createAgent` as the high-level entry point.
- Mastra.
- Inngest AgentKit.
- Vercel AI SDK.
- OpenAI Agents SDK for TypeScript.

Pydantic AI and Microsoft Agent Framework are second-round semantic controls. Deep Agents is a LangGraph-based harness rather than an independent runtime comparison.

Benchmarks must compare deterministic friction, scenario parity, and evaluated semantic clarity.

The scenario set covers first Turn, approval resume, process-stop recovery, stream replay, historical fork, existing handoff behavior, and operational cost. It must not define the generalized fan-out or aggregation behavior deferred by OD-02.

Results must separate framework-owned guarantees, integration guarantees, application glue, and unsupported behavior.

## Compliance enablement

Compliance remains a host responsibility. Tuvren can provide privacy and control mechanisms, evidence, and responsibility mappings. It must not claim that adoption makes a host compliant or certified.

The 1.0 documentation set requires:

- A versioned General Data Protection Regulation (GDPR) responsibility and control map.
- A non-authoritative System and Organization Controls 2 (SOC 2) Trust Services Criteria control-support crosswalk.
- Concrete conformance and evidence links.
- Explicit host responsibilities and configuration prerequisites.
- Clear statements that the artifacts aren't legal advice, certification, an attestation report, or a guarantee of an auditor's conclusion.

Scope-level erasure doesn't prove GDPR erasure across providers, exports, backups, telemetry, or data that shares a Scope.

## Build, toolchain, and verification

Bazel becomes the primary build, test, typecheck, lint, code generation, conformance, packaging, and continuous integration task graph. Nx must be removed after Bazel reaches measured command and cache parity.

Native manifests, lockfiles, package managers, compilers, and generators remain ecosystem authority. devenv provides the reproducible, pinned toolchain and long-lived services.

The build must satisfy these requirements:

- Pin release-critical runtimes, compilers, generators, and Bazel rule sets.
- Declare generated files as Bazel outputs and dependencies.
- Pass one release-gate command from a clean checkout without undocumented generation steps.
- Keep service startup explicit rather than starting long-lived services inside build actions.
- Keep narrow native or Bazel targets for focused debugging.

## Contracts and technical authority

The TechSpec must derive every contract family from the shipped surface and the `Library/SDK` archetype. It must not preserve artifacts required only by an earlier stage-skill version.

Provider and tool OpenAPI projections must be removed unless discovery identifies a real Tuvren HTTP API. TypeSpec sources, JSON Schema artifacts, language-native public declarations, and protocol-specific artifacts remain where they match actual surfaces.

Machine-readable authority remains boundary-owned under `spec/`. Constitution contract and data-model directories remain pointer indexes rather than cross-language oracles.

## Release policy

The npm publication at `0.1.0` is a public preview, not a stable API freeze. The next breaking TypeScript preview release is `0.2.0`.

- Every distributable package, crate, module, or equivalent follows Semantic Versioning.
- Every release unit maintains a Keep a Changelog history.
- The public TypeScript package set remains a lockstep compatibility group through pre-1.0 stabilization.
- Rust crates and Go, Python, and Dart packages version independently.
- Every observable published change requires a version decision and release note.
- Published versions are immutable and can't be reused.

## PostgreSQL and planning reconciliation

The relational row-per-record PostgreSQL implementation is accepted as intended behavior. The constitution must retire blob-redesign roadmap text.

Remaining work covers migration guidance, performance evidence, and consolidation of duplicated backend invariants.

The Tasks stage must not create fictional retroactive tickets for landed work. PRD, Architecture, and TechSpec accept approved behavior as repository reality.

Changelogs and issue or commit references provide provenance. Active tickets cover only unresolved defects, missing evidence, migrations, Bazel adoption, and 1.0 stabilization work.

Planned constitution epics and behavior-bearing tracked issues in the stabilization program must use the current `execute-epic-end-to-end` workflow.

Throwaway changes, blocked epics, and work without implementation-ready upstream authority retain the skill's declared exclusions and routing rules.

For applicable work, milestone validation and constitutional reconciliation must prevent another implementation-versus-plan divergence.

## Drift ownership and ordered realignment

The stages must run in this order:

1. **PRD Evolution:** Correct the archetype, actor model, canonical vocabulary, product phase, public-surface intent, Scope lifecycle and erasure promises, 1.0 gates, competitive evidence, compliance enablement, and accepted framework streaming commitments. Record Step and Step Attempt lifecycle as target product behavior.
2. **Architecture Evolution:** Rebuild logical boundaries and flows against the PRD. Correct stale paths, direct-kernel telemetry claims, risks, remote-session semantics, Scope lifecycle, AG-UI layering, Step lifecycle ownership, and cold-crash recovery. Remove resolved risks from active wording.
3. **TechSpec Evolution:** Align package ownership, Bazel migration target, pinned devenv toolchain, verification commands, contract families, streaming frame authority, Step lifecycle contracts, release policy, PostgreSQL reality, and Architecture Decision Records (ADRs).
4. **Tasks Evolution:** Replace the empty or stale active plan with dependency-ordered 1.0 work. Schedule only unresolved work and evidence. Exclude completed epics and superseded roadmap text from active totals and graphs.

Each downstream stage must read the revised upstream directory before writing. A downstream stage must not repair an upstream defect locally.
