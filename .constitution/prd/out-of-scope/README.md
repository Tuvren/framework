# Anti-Scope Database

Concepts explicitly rejected or deferred at the product layer. Migrated verbatim from the consolidated PRD §6 "Out of Scope" list; split into per-concept files when a rejection needs detailed rationale.

### Out of Scope

- A managed hosted control plane, SaaS product, or operations console
- Concrete cloud-vendor selection beyond the curated host-facing SDK boundary and the MCP wire protocol
- A UI-first showcase whose primary value is presentation rather than proving the host-building SDK
- Automatic agent discovery, agent marketplace behavior, or dynamic agent self-registration
- Cross-thread shared memory semantics beyond deliberate runtime coordination mechanisms
- Branch merge semantics for reconciling divergent histories
- Worker process scheduling, infrastructure supervision, or operating-system-level orchestration
- Garbage-collection policy for historical data or archival branches
- Domain-specific business tools, vertical workflows, or provider-exclusive capabilities as core product requirements
- A simultaneous full-framework port across multiple languages before the shared semantic system is artifact-backed and stable
- Bespoke per-implementation conformance suites that re-encode product semantics inside runner code instead of consuming a shared, data-owned conformance plan
- Cross-tenant thread search, multi-tenant access control, and full-text indexed querying through the embeddable SDK (deferred to a future hosted/server projection)
- A server or REST projection of the durable-read surface (same future projection)
- A Model Context Protocol server projection that lets external clients consume the runtime as an MCP server (only the client side is in scope)
- Schema adapters beyond Zod, Standard Schema, and wrapped JSON Schema in the core surface (additional adapters such as Valibot, ArkType, or Effect Schema ship as separate optional packages)
- Driver hot-swap or additional drivers beyond the ReAct baseline in v1
- Per-call approval edit forms beyond the existing approve/reject/edit verbs in the reference host (UX scope, not runtime semantics)
- A script-file interpreter or external scripting language for the headless reference-host mode
- Shipping concrete client endpoints themselves (browser extensions, desktop clients, device agents) as product deliverables; the runtime orchestrates and leases client endpoints but does not provide them
- Provider-exclusive parameters or behaviors of any one provider-native tool as core, portable product requirements
- The concrete transport, schema, adapter API, MCP implementation strategy, deployment model, or package layout for the capability-orchestration model (those are implementation decisions for the execution plan, not product requirements)

