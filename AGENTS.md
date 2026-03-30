# Kraken Runtime — Project Instructions

## What this project is

Kraken Runtime is a stateful agent runtime kernel+framework built from scratch. It is built on immutable objects, content-addressed storage, and structural checkpointing — Git internals applied to continuous runtime persistence.

The specification set in `docs/` is the current architecture. `KrakenKernelSpecification.md` freezes the kernel primitives. `KrakenFrameworkSpecification.md` is authoritative for framework behavior built on top of the kernel. The two rationale documents are explanatory only.

## How to work on this project

1. Read `docs/KrakenKernelSpecification.md` first.
2. Read `docs/KrakenFrameworkSpecification.md` whenever the session touches framework behavior.
3. Ask what I want to work on this session. Don't assume.
4. If I reference decisions not in the spec, ask — I may have iterated between sessions.
5. Track what's decided vs. what's open. Decisions are load-bearing.

## Guard rails

- The spec is language-agnostic. Don't assume implementation choices unless explicitly decided.
- Don't introduce provider-specific concerns into core primitives.
- Don't propose abstractions that exist to be "extensible" rather than to solve a named problem.
- Don't add concepts to the spec unless they earn their place.
- Don't conform yourself with snippets from the project's files, read files fully
