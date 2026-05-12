# AI Agent Instruction Manual: System Execution Guide

> **System Context:** This repository is managed via a strict 4-document planning pipeline plus historical support material that may remain available during archive migration. As an AI coding agent executing tasks within this project, your role is to implement the specifications exactly as defined. Rely on `PRD.md`, `Architecture.md`, `TechSpec.md`, `Tasks.md`, any support artifact those live documents explicitly keep active, and the authoritative behavioral specifications in `../docs/` to determine architecture, business logic, contracts, and dependencies. Treat `constitution/AGENTS.md` as a routing helper for that chain, not as a fifth authority document.

## The 4-Document Architecture

This project separates concerns into four distinct layers. Understand where your current task sits within these boundaries and load only the layer you need.

1. **`PRD.md` (The Conceptual Layer):** Defines the problem space. Contains the product vision, ubiquitous language, actors, success criteria, and capability scope.
2. **`Architecture.md` (The Logical Layer):** Defines the system structure. Contains the logical containers, trust boundaries, resilience posture, and critical execution flows.
3. **`TechSpec.md` (The Physical Layer):** Defines the concrete implementation. Contains the exact stack versions, canonical record shapes, backend schema details, interface contracts, project structure, and implementation rules.
4. **`Tasks.md` (The Execution Layer):** Defines the execution logistics. Contains the active scope split, the build order dependency graph, the ticket list, and the Gherkin acceptance criteria for each ticket.

### Planning Posture

- `Tasks.md` is the only source of truth for active scope, deferred scope, closed epics, and the current critical path.
- When no ticket is active, do not invent one from the archived ticket list. Treat user-requested chores, documentation alignment, verification, and review work as maintenance unless the user explicitly asks to open or revise scope.
- During archive migration, the explicitly retained live support artifacts are the Epic AD docs-to-authority coverage matrix and the Epic AF gap-plan outputs under `constitution/spikes/`. Treat them as transitional support inputs only until `KRT-AH001` / `KRT-AH002` relocate or replace them.
- For closed areas or archive-cleanup chores, use the relevant archived or explicitly retained support artifact only as historical context before changing behavior, validation claims, or follow-up language. Do not treat `spikes/` closure inventories as live authority unless the four live constitutional documents explicitly keep a specific artifact active.

---

## Documentation Routing Table

To conserve your context window and improve accuracy, use this lookup table to find the right source of truth quickly:

| If you need to know...                                        | Target File                                                                          | Specific Section to Parse                                                                               |
| :------------------------------------------------------------ | :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ |
| **What task to do next?**                                     | `Tasks.md`                                                                           | `Executive Summary & Active Critical Path`, `Build Order`, and the relevant ticket in `Ticket List`     |
| **How to test if a task is done?**                            | `Tasks.md`                                                                           | `Acceptance Criteria (Gherkin)` under the specific Ticket ID                                            |
| **What exact tech/library to use?**                           | `TechSpec.md`                                                                        | `Stack Specification (Bill of Materials)` and `Implementation Guidelines`                               |
| **What the persisted records and backend schema are?**        | `TechSpec.md`                                                                        | `State & Data Modeling`, especially `Canonical Entity Shapes` and `SQLite Backend Schema` when relevant |
| **What the required public and internal contracts are?**      | `TechSpec.md`                                                                        | `Interface Contract`                                                                                    |
| **How runtime boundaries communicate?**                       | `Architecture.md`                                                                    | `System Containers`, `Communication Relationships`, and `Critical Execution Flows`                      |
| **What a specific business/runtime term means?**              | `PRD.md`                                                                             | `Ubiquitous Language (Glossary)`                                                                        |
| **Whether a feature belongs in scope at all?**                | `PRD.md`                                                                             | `Functional Capabilities`, `Success Criteria`, and `Scope Distinctions That Must Remain Stable`         |
| **What the kernel and framework behavior mean semantically?** | `../docs/KrakenKernelSpecification.md` and `../docs/KrakenFrameworkSpecification.md` | Read the relevant normative sections directly                                                           |
| **What closed epic work actually delivered?**                 | `constitution/spikes/` during archive migration; later `constitution/archived/`      | Read the affected historical inventory only as context, or consult the explicitly retained live support artifacts named in `Planning Posture` |
| **What implementation parity is currently evidenced?**        | `../reports/compatibility/`                                                          | Treat generated matrix and evidence files as measured evidence, not semantic authority                   |
| **What carries the cross-implementation truth for a surface?** | `boundaries/<area>/contracts/<surface>/spec/authority-packet.json` and the conformance plans it references | Read the manifest first; treat implementation source, runner source, and Markdown as forbidden authority for any cross-implementation semantic |

---

## Execution Guidelines

1. **Interface First:** Adhere strictly to the exact types, field names, operations, and contracts defined in `TechSpec.md`. If a task requires a schema field, runtime operation, or contract detail that does not exist upstream, pause and ask the user instead of inventing it.
2. **Ubiquitous Language:** Use the exact terminology defined in `PRD.md` when naming code concepts. Avoid introducing synonyms for load-bearing terms such as Tuvren Runtime, Thread, Branch, Turn, Run, Step, TurnNode, TurnTree, Staged Result, Context Manifest, Context Engineering, Structured Output, Steering, Approval, Extension, Handoff, Worker, ExecutionHandle, KernelRecord, HashString, and EpochMs. Keep `Kraken Kernel` and `Kraken Framework` for engine semantics, architecture, and internal implementation references; use `Tuvren*` or neutral runtime names for public contract symbols and host-facing vocabulary.
3. **Definition of Done:** Treat a task as complete only when the implementation satisfies the exact `Given / When / Then` Gherkin acceptance criteria listed for that ticket in `Tasks.md`.
4. **Scope Containment:** Focus only on the current atomic ticket when one is active. When `Tasks.md` says no implementation epic is active, do not promote deferred or archived tickets into active scope unless the user explicitly revises `Tasks.md`.
5. **Layer Discipline:** Do not repair missing product, architecture, or contract decisions inside code. If the task reveals a missing upstream definition, point back to the correct artifact layer instead of improvising.
6. **Behavioral Authority:** For kernel and framework semantics, treat `../docs/KrakenKernelSpecification.md` and `../docs/KrakenFrameworkSpecification.md` as authoritative behavior sources. The constitution documents govern planning and implementation posture; the docs govern meaning.
7. **Evidence Discipline:** Boundary-owned `contracts/`, `conformance/`, `interop/`, telemetry outputs, and `../reports/compatibility/` are executable evidence layers. Update them with the human docs when semantics change, but do not let generated artifacts silently become a parallel source of truth.
8. **Native Toolchain Discipline:** The current repo is multi-language. Bun/TypeScript, Cargo/Rust, Buf/proto, TypeSpec, Weaver, and Nx each have distinct authority. Nx routes targets; it does not replace the native truth for each ecosystem.
9. **Machine-Enforced Authority Discipline (Epic Y):** Per TechSpec ADR-023, ADR-024, ADR-025, ADR-026, ADR-027, and ADR-028, every cross-implementation semantic surface owns one Authority Packet manifest at `boundaries/<area>/contracts/<surface>/spec/authority-packet.json` (or the equivalent under `conformance/spec/` or `interop/<channel>/spec/`). No implementation-language file, generic conformance runner source file, or Markdown document is cross-implementation authority. The manifest names the authoritative sources; the §4.12 conformance plans carry behavior assertions; the §4.13 implementation adapter protocol is the seam. When a task touches a promoted surface, the authority packet manifest is the answer to "what must be true." When a task touches a deferred surface that lacks a manifest, do not invent an oracle — extend or open the manifest in the same change, or block on Epic Y.

## Getting Started

To begin implementation when a ticket is active:

1. Locate the current Ticket ID in `Tasks.md`.
2. Read that ticket's dependencies and Gherkin acceptance criteria.
3. Load the corresponding implementation and contract sections from `TechSpec.md`.
4. Load `PRD.md`, `Architecture.md`, or the authoritative specs in `../docs/` only as needed to resolve terminology, boundaries, or behavioral semantics.
5. Implement only what is necessary to satisfy the current ticket's documented acceptance criteria.

To handle maintenance when no ticket is active:

1. Confirm the current planning posture in `Tasks.md` and the current-state language in `TechSpec.md`.
2. Read any explicitly referenced archived inventory or retained support artifact only when the live constitutional documents point to it.
3. Make the smallest alignment change that keeps docs, implementation, generated artifacts, and evidence claims consistent.
4. Run the narrowest relevant validation lane, then broaden only when the change justifies it.
