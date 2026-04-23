# AI Agent Instruction Manual: System Execution Guide

> **System Context:** This repository is managed via a strict 4-document planning pipeline. As an AI coding agent executing tasks within this project, your role is to implement the specifications exactly as defined. Rely on the documentation in this directory and the authoritative behavioral specifications in `../docs/` to determine architecture, business logic, contracts, and dependencies.

## The 4-Document Architecture

This project separates concerns into four distinct layers. Understand where your current task sits within these boundaries and load only the layer you need.

1. **`PRD.md` (The Conceptual Layer):** Defines the problem space. Contains the product vision, ubiquitous language, actors, success criteria, and capability scope.
2. **`Architecture.md` (The Logical Layer):** Defines the system structure. Contains the logical containers, trust boundaries, resilience posture, and critical execution flows.
3. **`TechSpec.md` (The Physical Layer):** Defines the concrete implementation. Contains the exact stack versions, canonical record shapes, backend schema details, interface contracts, project structure, and implementation rules.
4. **`Tasks.md` (The Execution Layer):** Defines the execution logistics. Contains the active scope split, the build order dependency graph, the ticket list, and the Gherkin acceptance criteria for each ticket.

---

## Documentation Routing Table

To conserve your context window and improve accuracy, use this lookup table to find the right source of truth quickly:

| If you need to know... | Target File | Specific Section to Parse |
| :--------------------- | :---------- | :------------------------ |
| **What task to do next?** | `Tasks.md` | `Executive Summary & Active Critical Path`, `Build Order`, and the relevant ticket in `Ticket List` |
| **How to test if a task is done?** | `Tasks.md` | `Acceptance Criteria (Gherkin)` under the specific Ticket ID |
| **What exact tech/library to use?** | `TechSpec.md` | `Stack Specification (Bill of Materials)` and `Implementation Guidelines` |
| **What the persisted records and backend schema are?** | `TechSpec.md` | `State & Data Modeling`, especially `Canonical Entity Shapes` and `SQLite Backend Schema` when relevant |
| **What the required public and internal contracts are?** | `TechSpec.md` | `Interface Contract` |
| **How runtime boundaries communicate?** | `Architecture.md` | `System Containers`, `Communication Relationships`, and `Critical Execution Flows` |
| **What a specific business/runtime term means?** | `PRD.md` | `Ubiquitous Language (Glossary)` |
| **Whether a feature belongs in scope at all?** | `PRD.md` | `Functional Capabilities`, `Success Criteria`, and `Scope Distinctions That Must Remain Stable` |
| **What the kernel and framework behavior mean semantically?** | `../docs/KrakenKernelSpecification.md` and `../docs/KrakenFrameworkSpecification.md` | Read the relevant normative sections directly |

---

## Execution Guidelines

1. **Interface First:** Adhere strictly to the exact types, field names, operations, and contracts defined in `TechSpec.md`. If a task requires a schema field, runtime operation, or contract detail that does not exist upstream, pause and ask the user instead of inventing it.
2. **Ubiquitous Language:** Use the exact terminology defined in `PRD.md` when naming code concepts. Avoid introducing synonyms for load-bearing terms such as Tuvren Runtime, Kraken Kernel, Kraken Framework, Thread, Branch, Turn, Run, Step, TurnNode, TurnTree, Staged Result, Context Manifest, Context Engineering, Structured Output, Steering, Approval, Extension, Handoff, Worker, ExecutionHandle, KernelRecord, HashString, and EpochMs.
3. **Definition of Done:** Treat a task as complete only when the implementation satisfies the exact `Given / When / Then` Gherkin acceptance criteria listed for that ticket in `Tasks.md`.
4. **Scope Containment:** Focus only on the current atomic ticket. Do not implement future tickets early, and do not widen active scope unless the user explicitly revises `Tasks.md`.
5. **Layer Discipline:** Do not repair missing product, architecture, or contract decisions inside code. If the task reveals a missing upstream definition, point back to the correct artifact layer instead of improvising.
6. **Behavioral Authority:** For kernel and framework semantics, treat `../docs/KrakenKernelSpecification.md` and `../docs/KrakenFrameworkSpecification.md` as authoritative behavior sources. The constitution documents govern planning and implementation posture; the docs govern meaning.

## Getting Started

To begin implementation:

1. Locate the current Ticket ID in `Tasks.md`.
2. Read that ticket's dependencies and Gherkin acceptance criteria.
3. Load the corresponding implementation and contract sections from `TechSpec.md`.
4. Load `PRD.md`, `Architecture.md`, or the authoritative specs in `../docs/` only as needed to resolve terminology, boundaries, or behavioral semantics.
5. Implement only what is necessary to satisfy the current ticket's documented acceptance criteria.
