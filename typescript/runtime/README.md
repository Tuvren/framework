<!--
Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
Licensed under the Apache License, Version 2.0.
-->

# @tuvren/runtime — internal orchestration engine

> **Internal package. Not a host-facing API.** (ADR-057)

`@tuvren/runtime` is the internal orchestration engine that drives a Tuvren
turn: the runtime core loop, orchestration runtime, runner registry, capability
registry/policy engine, context-manifest builder, handoff builders, and the
kernel-bridge factories. It is composed by the host-facing composition tier and
is **not** something a downstream host imports directly.

## Do not import this package directly

A host composes the framework through the **curated host-facing SDK boundary**:

- `@tuvren/core` — the behavior-free ABI (types, contracts, assertions) and its
  subpaths.
- `@tuvren/sdk` — the composition tier: the batteries-included `createTuvren`
  entrypoint plus the curated `@tuvren/core` re-exports and developer helpers.
- The **leaf packages** you choose — a backend
  (`@tuvren/backend-memory` / `@tuvren/backend-sqlite` /
  `@tuvren/backend-postgres`), a runner (`@tuvren/runner-react`), the provider
  bridge, stream adapters, MCP client, etc.

`createTuvren` (from `@tuvren/sdk`) accepts **constructed instances only** — you
build the backend and runner from their leaf packages and pass them in; there
are no `"memory"` / `"react"` string shorthands (ADR-057 §2).

An automated boundary check in the canonical verification path fails if a file
under `typescript/host/**` imports `@tuvren/runtime` (or a kernel package).

## Stability

This package **remains published for transparency but is marked internal and is
not semver-guaranteed** (ADR-057 §5). Its surface can change without a major
version bump. Depend on `@tuvren/core` + `@tuvren/sdk` + leaf packages instead;
those carry the stable, semver-guaranteed host-facing contract.

The engine surface here is consumed by `@tuvren/sdk` and by the conformance
adapters that exercise the engine at a lower level than `createTuvren`.

For adopter onboarding — the host import contract, stable vs.
`@experimental` surfaces, and an install-plus-first-Turn walkthrough — see
`docs/guides/publishing-and-adopter-onboarding.md` in the
[Tuvren framework repository](https://github.com/Tuvren/framework).
