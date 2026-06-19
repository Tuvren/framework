### Epic BE — Tenancy Scope Seam + Isolation-by-Construction (KRT)

**Status:** Active. First epic of the SaaS-Readiness block and its keystone. Realizes ADR-048 (scope seam bound at construction; kernel syscall surface stays scope-free) and ADR-049 (isolation-by-construction; scope-resolved content addressing) for PRD CAP-P0-064/065. Gates the data-lifecycle epic (BF) and the SDK freeze epic (BI). Because the new kernel/framework spec sections are SaaS-readiness targets, `KRT-BE001` aligns machine authority first so the docs-to-authority freeze gate accepts them.

**KRT-BE001 Authority Alignment for Scope-Resolved Identity**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** None
- **Capability / Contract Mapping:** PRD `CAP-P0-065`; TechSpec ADR-049; `docs/KrakenKernelSpecification.md` §2.3
- **Description:** Align machine authority for the new kernel §2.3 scope-resolved identity semantics so the docs-to-authority freeze gate accepts them: add the coverage-matrix classification entries for the §2.3 claims (and the framework scope notes), declare the scope-isolation surface in the kernel-protocol authority packet with its conformance-plan reference, and wire the freeze-gate classifier for the new claims. No runtime behavior changes here; this unblocks the rest of the epic without leaving unclassified normative claims.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given docs/KrakenKernelSpecification.md v0.12 adds §2.3 scope-resolved object identity
When the docs-to-authority freeze gate runs
Then every new §2.3 normative claim is classified in the coverage matrix
And the kernel-protocol authority packet declares the scope-isolation surface and its conformance-plan reference
And no new normative claim is left unclassified
```

**KRT-BE002 Spike: Scope-Binding Realization Across Backends**
- **Type:** Spike
- **Effort:** 3
- **Dependencies:** KRT-BE001
- **Capability / Contract Mapping:** TechSpec ADR-048, ADR-049
- **Description:** Choose the concrete scope-binding realization per backend: memory scope-keyed stores; SQLite file-per-scope vs scope-discriminator column; PostgreSQL row-level-isolated host-supplied connection vs dedicated schema. Output `.constitution/spikes/SPK-BE002.md`. No production code.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the scope-binding seam must be realized for memory, SQLite, and PostgreSQL
When the spike completes
Then SPK-BE002.md records the chosen realization per backend with trade-offs
And it names the implementation tickets it unlocks (KRT-BE003 through KRT-BE006)
```

**KRT-BE003 Scope Binding at Backend Construction (Contract + Memory)**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BE002
- **Capability / Contract Mapping:** PRD `CAP-P0-064`; TechSpec ADR-048
- **Description:** Extend the backend construction contract so a host binds a Scope at construction with no kernel syscall change, and realize it in `@tuvren/backend-memory` by keying object, tree, node, schema, staging, and enumeration stores by scope. `createTuvren` / `createRuntimeKernel` thread the host's scoped backend unchanged.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a host constructs two memory backends bound to scope A and scope B
When content is stored under scope A
Then it is not retrievable, enumerable, or existence-checkable through the scope-B backend
And the kernel syscall surface takes no scope argument
And listThreads requires no scope parameter
```

**KRT-BE004 SQLite Scope Realization**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BE003
- **Capability / Contract Mapping:** PRD `CAP-P0-064`, `CAP-P0-065`; TechSpec ADR-048, ADR-049
- **Description:** Realize scope binding in `@tuvren/backend-sqlite` per the SPK-BE002 decision (file-per-scope or scope-discriminator), confining every read, write, and enumeration to the constructing scope, with a migration if a discriminator column is chosen.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given two SQLite backends bound to scope A and scope B
When the same content is stored in both
Then each scope holds an independent durable object
And no query in scope B can observe scope-A content
And existing single-scope behavior is preserved under migration
```

**KRT-BE005 PostgreSQL Scope Realization (Row-Level Isolation)**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BE003
- **Capability / Contract Mapping:** PRD `CAP-P0-064`, `CAP-P0-065`; TechSpec ADR-048, ADR-049
- **Description:** Realize scope binding in `@tuvren/backend-postgres` via a host-supplied scoped connection/role (row-level isolation) or dedicated schema per SPK-BE002, so the backend honors the host's tenancy discriminator without the kernel knowing tenants.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a PostgreSQL backend constructed against a scope-bound connection
When two scopes share the database under row-level isolation
Then a read, enumeration, or existence check in one scope never returns another scope's rows
And the host supplies the scope discriminator at construction, not per syscall
```

**KRT-BE006 Scope-Resolved Durable Identity + Durable-Read Scope Safety**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BE004, KRT-BE005
- **Capability / Contract Mapping:** PRD `CAP-P0-065`; TechSpec ADR-049; `docs/KrakenKernelSpecification.md` §2.3
- **Description:** Make durable identity resolution and the Durable-Read Surface (`listThreads`, `listBranches`, state-at-TurnNode, history walk, branch messages, `store.has`/`store.get`) provably scope-confined across all three backends; identical content in two scopes is two independent objects with no cross-scope dedup.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given identical content stored under scope A and scope B
When store.has(hash) is called in scope A for content only present in scope B
Then it returns false
And every Durable-Read Surface operation returns only the constructing scope's state
```

**KRT-BE007 Cross-Scope Isolation Conformance**
- **Type:** Security
- **Effort:** 5
- **Dependencies:** KRT-BE006
- **Capability / Contract Mapping:** PRD `CAP-P0-065`; TechSpec ADR-049
- **Description:** Add a cross-scope isolation conformance check set proving no read, enumeration, or existence check crosses a scope, evaluated per backend capability across memory, SQLite, and PostgreSQL, and register it in the relevant authority packet.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the cross-scope isolation conformance plan
When it runs against the memory, SQLite, and PostgreSQL adapters
Then every probe for another scope's content fails to observe it
And per-backend evidence is recorded
```

**KRT-BE008 Scope-Tagged Telemetry and Transcripts**
- **Type:** Security
- **Effort:** 3
- **Dependencies:** KRT-BE006
- **Capability / Contract Mapping:** PRD `CAP-P0-064`; TechSpec ADR-048; Architecture Tenancy & Scope Isolation / Secret Isolation models
- **Description:** Ensure operational telemetry and transcripts carry the scope as correlation context and never emit another scope's data; extend the secret/scope isolation checks to assert no cross-scope leakage on these surfaces.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a turn executed under scope A
When telemetry and a transcript are emitted
Then they are correlated to scope A
And they contain no scope-B lineage, content, or identifiers
```
