# Open decisions

- **Date:** 2026-08-19
- **Interview target:** Realign
- **Prior register carried forward:** None found

## OD-01: Branch and lineage merge semantics

- **Question asked:** Should Tuvren support merging two divergent Branch histories into one canonical history?
- **User decision:** Defer. Branches don't merge by their present nature, but parallel test-time compute or another multi-agent model might justify merge semantics after dedicated analysis.
- **Reason left open:** The framework lacks an agreed conflict, provenance, durability, and runner-neutral merge model.
- **Downstream constraint:** PRD, Architecture, TechSpec, and Tasks must not add structural Branch merge behavior during this realignment. A host can preserve separate histories, but downstream stages must not invent a canonical merge.
- **Revisit trigger:** A concrete product workflow requires durable convergence of independent lineage rather than ordinary result aggregation.

## OD-02: Multi-agent fan-out and aggregation model

- **Question asked:** Should parallel worker executions with an aggregation Step become the supported model for ephemeral multi-agent work?
- **User decision:** Defer because the interview was overspecifying an area that requires separate analysis.
- **Reason left open:** The required isolation, persistence, aggregation, cancellation, partial-failure, and parent-child semantics haven't been established.
- **Downstream constraint:** This realignment can preserve proven handoff and worker behavior. It must not generalize those behaviors into a new fan-out or aggregation contract.
- **Revisit trigger:** A named adopter workflow or benchmark requires parallel child execution with durable aggregation semantics.

## OD-03: Intra-Scope subject erasure

- **Question asked:** Should Tuvren provide managed erasure for one subject inside a shared Scope, or limit its guarantee to Scope-level erasure?
- **User decision:** Guarantee Scope-level erasure and defer managed intra-Scope subject erasure for separate analysis.
- **Reason left open:** Tuvren has no subject identity, subject-to-record index, or per-subject lifecycle contract. The host can choose finer Scope granularity and compose identifiers to match its ownership model.
- **Downstream constraint:** The constitution must not claim managed subject-level erasure. The opaque `keyRef` can remain a host-owned codec mechanism without subject semantics.
- **Revisit trigger:** A concrete adopter must erase one subject inside an active shared Scope and can't meet the requirement through Scope design.
