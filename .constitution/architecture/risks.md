## 6. Logical Risks & Technical Debt

- **Risk:** Shared framework services absorb ReAct-specific semantics and quietly erase the value of driver modularity.
- **Why it matters:** Future workflow-oriented drivers would either duplicate framework logic or be forced into a ReAct-shaped abstraction they do not actually fit.
- **Mitigation or follow-up:** Keep driver contracts explicit in the implementation layer and treat the current behavior as the ReAct baseline rather than as anonymous “framework default” behavior.

- **Risk:** Driver plurality inflates early scope beyond what a solo developer can validate well.
- **Why it matters:** Trying to implement multiple drivers now would dilute the quality of the kernel, provider, and host foundations.
- **Mitigation or follow-up:** Ship one production-depth driver first, keep future drivers as deferred scope, and use the architecture only to preserve the conceptual boundary.

- **Risk:** Host-facing contracts and event vocabulary drift if adapters or drivers bypass shared framework services.
- **Why it matters:** Different hosts would observe different runtime truths, weakening portability and operability.
- **Mitigation or follow-up:** Route host controls and canonical event publication through the shared framework layer even when a driver has specialized execution behavior.

- **Risk (mitigated):** The first-party proving host relies on privileged seams that downstream hosts cannot use, creating false confidence in the SDK.
- **Why it mattered:** The product would appear host-buildable while still depending on implementation-local shortcuts, undermining both SDK quality and later portability work.
- **Mitigation status:** The Durable-Read Surface on Framework Shared Services now promotes every durable read that previously justified a private inspector (branch messages, runtime status, turn state, history walks, thread enumeration) onto the host-facing SDK. The Reference Host container explicitly states the SDK-only invariant. Epic AT closes the proving-host consolidation risk by deleting the playground host package, renaming playground-named REPL internals, adding headless mode, adding streaming JSONL output, and adding transcript replay. The private-inspector and proving-host consolidation risks are closed for the current Reference Host scope.

- **Risk:** TypeScript-first repo structure or test tooling becomes a permanent exception that later languages have to work around.
- **Why it matters:** A one-off structure would turn every future implementation into an adapter to historical accidents instead of a peer in one boundary-owned semantic system.
- **Mitigation or follow-up:** Epic X now enforces the topology rule in repo reality: language-neutral assets stay at boundary-owned roots, and language-specific package roots live only under `implementations/<lang>/`. Future implementation lines must enter through that normalized structure instead of reopening TypeScript-first exceptions.

- **Risk:** Machine-readable artifacts drift away from the human semantic sources in `docs/` and `.constitution/`.
- **Why it matters:** Cross-language parity collapses quickly when schemas, fixtures, or reports become de facto truth without matching the normative specs.
- **Mitigation or follow-up:** Treat docs and constitution as the human authority chain, require boundary-owned review for artifact changes, and generate compatibility reports from actual suite evidence rather than hand-authored claims.

- **Risk:** A cross-language semantic continues to be defined only by TypeScript source, Rust source, generic runner code, or Markdown prose, making one of those surfaces the silent oracle.
- **Why it matters:** Future implementations must then chase implementation accidents instead of honoring shared meaning, and "the same runtime" stops surviving the addition of any new language line.
- **Mitigation or follow-up:** Every cross-language semantic must live in a boundary-owned Authority Packet Surface that names its authoritative sources and forbidden authority sources, with at least one Conformance Plan Authority entry and a Generic Conformance Runner path that can drive any compliant Implementation Adapter Boundary; CI must reject claims that depend only on implementation language source, runner-internal assertions, or prose documents.

- **Risk:** Generic conformance runners absorb product semantics through hard-coded expected event sequences, expected error codes, expected check IDs, or expected lifecycle transitions and quietly become a second oracle in their own right.
- **Why it matters:** Switching runner implementations or adding a new language line then depends on inheriting hidden runner assumptions rather than reading the conformance plan.
- **Mitigation or follow-up:** Runners must own only generic mechanics (adapter startup, dispatch, schema validation, generic assertion operators, ordered-channel consumption, cancellation injection, timeout control, evidence emission), and product semantics must arrive only from Conformance Plan Authority artifacts referenced by an Authority Packet Surface.

- **Risk:** Generated artifacts (validators, bindings, transport descriptors, conformance plans) drift from their authority sources and silently change observable meaning.
- **Why it matters:** Stale generated artifacts are functionally an unreviewed authority change.
- **Mitigation or follow-up:** Authority Packet Surface manifests must declare freshness checks, and CI must fail when generated artifacts diverge from their authoritative sources.

- **Risk:** Amending the kernel syscall surface to add `thread.list` ripples through every downstream artifact that names the syscall set (authority packet, conformance plans, both kernel implementations, gRPC interop, backends, and the Durable-Read Surface composition).
- **Why it matters:** A partial amendment leaves cross-language drift between what one implementation supports and what another claims to support, or between what conformance plans verify and what backends actually implement.
- **Mitigation or follow-up:** Treat the kernel amendment as one architectural action with a closed checklist: kernel spec version bump (also correcting the pre-existing 28-vs-29 syscall-count discrepancy to the new count), authority packet entry, conformance plan entries (per backend capability), TypeScript `RuntimeKernel` interface, Rust kernel `InMemoryKernel` implementation, all three TypeScript backends, gRPC proto + codec regeneration, and the Durable-Read Surface composition. The TechSpec and Tasks artifacts must explicitly sequence these so no implementation language advances ahead of its authority.

- **Risk:** Schema-adapter detection in the Schema Authoring Helper is ambiguous between Zod v3, Zod v4, Standard Schema, and wrapped JSON Schema, and a schema is silently routed to the wrong adapter.
- **Why it matters:** Misrouted detection changes validation behavior without changing the tool definition's source, which becomes a subtle correctness bug that surfaces only on bad input.
- **Mitigation or follow-up:** Centralize detection in one normalization routine with an explicit precedence order (already-wrapped Schema brand → Zod v4 marker → Zod v3 marker → Standard Schema vendor property → lazy function unwrap). The precedence order is part of the authority for the Schema Authoring Helper and is conformance-checked through a fixture set in the relevant conformance plan.

- **Risk:** MCP transport fragmentation: stdio and HTTP/SSE have different connection lifecycles, different framing, and different error models, and the runtime ends up with two parallel client paths whose behaviors diverge.
- **Why it matters:** A host that switches transports for the same MCP server would observe different tool advertisements, different invocation semantics, or different error translations, breaking portability of host-side tool configuration.
- **Mitigation or follow-up:** The MCP Client Container exposes one unified client interface with two transport implementations behind it. The interface owns the MCP protocol session lifecycle and validation; transports own only framing and connection. Conformance plans for the MCP Client Container exercise both transports against the same scenario set to enforce behavioral parity.

- **Risk:** Durable-Read Surface pagination shape diverges (cursor for histories vs. limit-offset for collections vs. async iterator everywhere), and host developers receive inconsistent reading ergonomics that complicate downstream tooling.
- **Why it matters:** A scrollback loop that works for turn history must not behave fundamentally differently from a scrollback loop for threads or branches; mismatched pagination forces every host to re-implement the same paging adapter.
- **Mitigation or follow-up:** Adopt an architectural rule: **history surfaces use a runtime-internal cursor returned from the previous read plus an async iterator (newest-first), and collection surfaces use a runtime-internal cursor plus an optional limit (no offsets)**. Both shapes return an opaque cursor token the host does not have to interpret. Cursor opacity preserves backend freedom; the iterator-vs-page distinction tracks whether the read is over a lineage chain or over an unordered collection. The Durable-Read Surface conformance plan enforces both shapes.

- **Risk:** The operational telemetry surface grows a second vocabulary that diverges from the canonical runtime event vocabulary.
- **Why it matters:** Operators and host UIs would describe the same runtime activity in incompatible terms, and cross-language telemetry parity would collapse.
- **Mitigation or follow-up:** The Telemetry & Observability Boundary derives from the same canonical runtime activity vocabulary as the Event Stream Adapter Layer; the telemetry vocabulary is boundary-owned authority with an Authority Packet Surface entry, and the vendor-neutral export is an ecosystem projection above it rather than a parallel source of meaning.

- **Risk:** Credentials leak into durable lineage, operational telemetry, or transcripts.
- **Why it matters:** The durability, observability, and replay surfaces that make Tuvren trustworthy would become the exact channel through which secrets escape, and replayable transcripts would be unsafe to share.
- **Mitigation or follow-up:** Enforce the Secret Isolation Model: confine credentials to the Provider Gateway and MCP Client Container edges, treat the durable, telemetry, and transcript surfaces as credential-free zones, and assert their absence through conformance and review rather than relying on redaction alone.

- **Risk:** Execution bounds are placed at driver discretion instead of framework enforcement.
- **Why it matters:** A misbehaving, buggy, or adversarial driver could then opt out of the runtime's safety limits, reintroducing the runaway loops and resource exhaustion that bounded execution exists to prevent.
- **Mitigation or follow-up:** Keep Execution Bound enforcement in Framework Shared Services above driver discretion; drivers may choose to continue only within the framework-enforced bounds, and conformance asserts that exceeding a bound yields the typed bounded-execution terminal outcome.

- **Risk:** The fault-injection seam used for recovery verification leaks into production control paths.
- **Why it matters:** A failure-injection capability reachable by hosts or drivers in normal operation would be both a reliability hazard and an attack surface.
- **Mitigation or follow-up:** Scope the fault-injection seam to verification-time only at the persistence boundary; it must not be reachable through the host-facing SDK, drivers, or any production path, and its realization is a TechSpec-controlled test seam rather than a runtime feature.

- **Risk:** The execution-class distinction collapses into a single `origin` field or a rigid tool subclass taxonomy.
- **Why it matters:** Either shortcut hard-codes current deployment patterns and re-hides who executes, who owns state and credentials, who can cancel or retry, and what is observable — exactly the unsafe single abstraction the capability model exists to remove.
- **Mitigation or follow-up:** Keep the model compositional (Tool Surface × Capability × Binding × Endpoint × Policy × Observation); the Binding & Endpoint Resolver and Capability Policy Engine are first-class containers so execution class and policy are explicit per invocation.

- **Risk:** The runtime models provider-owned or client-owned invocations as locally executed functions and overstates its control or observation.
- **Why it matters:** Hosts would trust cancellation, retry, audit, or completeness guarantees the runtime cannot actually provide for provider-native, provider-mediated, or client-side work.
- **Mitigation or follow-up:** Enforce the Execution-Class Observation Model and the provider-owned and leased-client trust boundaries; represent these classes as known capabilities with explicit observation/control limits and tag their events accordingly.

- **Risk:** MCP is treated as a top-level execution class rather than a binding mechanism.
- **Why it matters:** The same MCP server reached provider-mediated, server-side, or client-side has different observability and control; conflating them produces wrong assumptions about who can cancel, retry, or audit, and where credentials live.
- **Mitigation or follow-up:** Classify MCP bindings by who invokes or runs the server in the Binding & Endpoint Resolver; route provider-mediated MCP through the Provider Gateway and Tuvren-run MCP through the MCP Client Container.

- **Risk:** A leased client endpoint is unavailable, slow, or returns a stale result after its lease expires.
- **Why it matters:** The runtime could block a turn, double-dispatch an invocation, or accept a stale client-reported result as authoritative, corrupting the invocation record.
- **Mitigation or follow-up:** Apply the Client-Endpoint Lease Model: track availability, return a typed unavailable-binding outcome when absent, and ignore late completions after lease expiry so they cannot mutate the invocation.
