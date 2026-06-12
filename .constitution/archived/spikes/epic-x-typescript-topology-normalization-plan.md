# Epic X TypeScript Topology Normalization Plan

This file opens Epic X. It is not a closure inventory. It records the gap
analysis, target topology, and ticket plan for moving every TypeScript-only
asset out of the language-neutral slots in `boundaries/` so that the repository
shape stops implying TypeScript ownership of contract or testkit roots.

## Status

- Epic X is active in current repo reality.
- Authority chain: Architecture.md `1.4` cross-language drift risk and
  Architecture.md `6` mitigation explicitly authorize this normalization
  before another implementation line becomes authoritative. The Rust kernel is
  already authoritative through Epic U closure, which makes this work overdue
  cleanup rather than new architecture.
- Epic W is closed. Epic X is a structural follow-up to Epic W's semantic
  maturity, not a re-opening of the semantic-authority decisions Epic W
  recorded.

## Core Rule

The boundary tree must reveal language ownership through path topology. Every
asset under `boundaries/<area>/` falls into exactly one of these classes:

- **Language-neutral** assets live at boundary-owned roots. Examples: JSON
  conformance fixtures, JSON Schema validators, suite manifests, CDDL grammar,
  TypeSpec source, generated JSON Schema or OpenAPI artifacts, `.proto` files,
  scenario manifests, README files describing neutral semantics.
- **Language-specific** assets live exclusively under
  `boundaries/<area>/[contracts/<contract>/]implementations/<lang>/`. Examples:
  `package.json`, `Cargo.toml`, `tsup.config.ts`, `tsconfig*.json`, `src/`,
  `dist/`, `test/`, `bench/`, `smoke/`, `node_modules/`, `target/`, language
  build artifacts.

A reader of the tree must be able to tell which language owns a directory by
its path alone, without opening files.

## Current Gaps

### Gap A: Boundary-level testkits are TS-only at a language-neutral slot

`boundaries/{kernel,framework,providers}/testkit/` sit as siblings of
`implementations/`. They contain only TypeScript artifacts (`package.json`,
`src/`, `tsup.config.ts`, `tsconfig*.json`) and are never consumed by Rust.
The Rust runner reimplements equivalent harness logic inline at
`boundaries/kernel/implementations/rust/conformance-runner/src/main.rs`.

Impacted consumers (verified by `package.json` scan):

- `@tuvren/kernel-testkit` is consumed by `kernel-conformance-runner`,
  `backend-memory`, `backend-sqlite`, and `playground-host`.
- `@tuvren/framework-testkit` is consumed by `framework-conformance-runner`,
  `runtime-core`, `stream-core`, `stream-sse`, and `stream-agui`.
- `@tuvren/provider-testkit` is consumed by `provider-conformance-runner` and
  `bridge-ai-sdk`.

Because consumers reference the package by workspace name (`workspace:*`), no
consumer `package.json` changes are required when the package directory moves.
The relocation impact is concentrated in the Nx project metadata,
`tsup.config.ts` paths if any are absolute, and `bun install`-regenerated
`node_modules/@*` symlinks.

### Gap B: Contract directories mix neutral spec with TS implementation

Every `boundaries/<area>/contracts/<contract>/` directory currently hosts both
language-neutral assets (`spec/cddl/`, `spec/typespec/`, `artifacts/`) and the
TypeScript package guts (`package.json`, `src/`, `dist/`, `tsup.config.ts`,
`tsconfig*.json`, `test/`, `smoke/`, `bench/`, `node_modules/`). The TS guts
treat the contract root as if TypeScript were the authoritative authoring
home, which the constitution explicitly forbids.

Affected contract packages:

- `boundaries/kernel/contracts/protocol/` (`@tuvren/kernel-protocol`)
- `boundaries/framework/contracts/runtime-api/` (`@tuvren/runtime-api`)
- `boundaries/framework/contracts/driver-api/` (`@tuvren/driver-api`)
- `boundaries/framework/contracts/event-stream/` (`@tuvren/event-stream`)
- `boundaries/framework/contracts/tool-contracts/` (`@tuvren/tool-contracts`)
- `boundaries/providers/contracts/provider-api/` (`@tuvren/provider-api`)
- `boundaries/shared/contracts/core-types/` (`@tuvren/core-types`)

Same workspace-name resolution rule applies: consumers see only the package
name, so the directory move does not break dependency declarations.

### Gap C: Four contract surfaces have no language-neutral source

- `runtime-api`, `driver-api`, `event-stream` carry only TypeScript source.
  Their `spec/` directory does not exist or holds only a README.
- `core-types` has only `src/lib/{kernel-records.ts,tuvren-error.ts}`. Its
  `spec/README.md` is a placeholder.

These surfaces remain TypeScript-authored even after Gap A and Gap B are
fixed. Promoting them to a language-neutral source (TypeSpec or CDDL) is real
specification work, not file-tree movement, and warrants its own future epic
once the topology cleanup lands.

### Gap D: Topology rule is not yet codified

`AGENTS.md` and the constitution describe boundary discipline in semantic
terms but do not state the path-topology rule that this epic enforces. Without
that rule recorded as authority, the gaps could re-emerge.

## Target Topology

After Epic X closes, the boundary tree must look like this for every
participating package:

```
boundaries/<area>/
  contracts/<contract>/
    spec/                          # language-neutral source (TypeSpec, CDDL, ...)
    artifacts/                     # language-neutral generated artifacts
    README.md                      # language-neutral semantic notes
    implementations/
      typescript/                  # TS package guts: package.json, src, dist, ...
      rust/                        # only present when a Rust crate exists
  conformance/                     # language-neutral fixtures, schemas, scenarios
  interop/                         # language-neutral transport contracts
  implementations/
    typescript/
      <package>/                   # TS implementation packages
      testkit/                     # TS testkit moved here from boundary root
    rust/
      <crate>/                     # Rust crates
```

Gap C surfaces (runtime-api, driver-api, event-stream, core-types) keep their
TS implementation under `implementations/typescript/`, but their boundary root
will explicitly carry only `README.md` and a `spec/` placeholder noting that a
neutral source has not been authored yet. The Epic X closure inventory will
record those packages as deferred semantic-source promotion work.

## Ticket Plan

### KRT-X001 Topology Inventory

- **Type:** Spike
- **Effort:** 1
- **Description:** Confirm the directory list, package list, Nx project list,
  and consumer list captured in this plan against the live repository, and
  freeze them as inputs to the relocation tickets.
- **Acceptance:** every TS-only directory under a language-neutral slot is
  listed, every consumer of an impacted package is enumerated, and the list is
  recorded in this plan or a referenced inventory file.

### KRT-X002 Testkit Relocation

- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-X001
- **Description:** Move the three boundary-root testkit packages into their
  TypeScript-implementation subtrees, update Nx project metadata, regenerate
  workspace symlinks, and verify `bun run typecheck`, `bun run conformance`,
  and `bun run nx run <project>:test` for every consumer.
- **Scope:**
  - `boundaries/kernel/testkit/`           -> `boundaries/kernel/implementations/typescript/testkit/`
  - `boundaries/framework/testkit/`        -> `boundaries/framework/implementations/typescript/testkit/`
  - `boundaries/providers/testkit/`        -> `boundaries/providers/implementations/typescript/testkit/`
- **Out of scope:** package renames, public API changes, fixture changes.

### KRT-X003 Contract Implementation Relocation

- **Type:** Chore
- **Effort:** 5
- **Dependencies:** KRT-X002
- **Description:** Move the TypeScript package guts of every contract package
  into a sibling `implementations/typescript/` directory while leaving
  language-neutral `spec/`, `artifacts/`, and README assets at the contract
  root. Update Nx project metadata and verify build/typecheck/test/conformance
  across all consumers.
- **Scope:** the seven contract packages enumerated under Gap B.
- **Out of scope:** authoring new neutral specs (Gap C), changing public
  package APIs, changing artifact regeneration commands beyond path edits.

### KRT-X004 Topology Guardrail Documentation

- **Type:** Chore
- **Effort:** 2
- **Dependencies:** KRT-X003
- **Description:** Codify the topology rule so the gaps cannot re-emerge.
  Update `AGENTS.md` boundary-discipline guidance, add a TechSpec ADR pinning
  the rule, and update Architecture.md `6` to mark the cross-language drift
  mitigation as enforced through Epic X.
- **Out of scope:** authoring neutral specs for Gap C surfaces.

### KRT-X005 Closure Inventory

- **Type:** Chore
- **Effort:** 1
- **Dependencies:** KRT-X004
- **Description:** Record what Epic X delivered, which gaps it closed (A, B,
  D), which it explicitly left for a later epic (C), and what new authority
  references the closure produced. Set TechSpec/Tasks status language for the
  next planning pass.

## Phasing And Pull Request Boundaries

Each ticket lands as its own pull request so review can verify topology
correctness before broader scope. Estimated change sizes:

- KRT-X001: documentation only.
- KRT-X002: roughly 1.5k LOC across moves and Nx metadata edits.
- KRT-X003: roughly 4-7k LOC across moves and Nx metadata edits.
- KRT-X004: small documentation edits.
- KRT-X005: documentation only.

KRT-X002 and KRT-X003 stay below the planning heuristic warning threshold
individually. They must not be combined into a single PR.

## Out-of-scope For Epic X

- Authoring TypeSpec or CDDL for `runtime-api`, `driver-api`, `event-stream`,
  or `core-types`. Those promotions belong to a later epic that cites Epic X
  closure and Epic W coverage matrix entries.
- Renaming TypeScript packages (`@tuvren/kernel-testkit`,
  `@tuvren/kernel-protocol`, ...). Names already work as workspace handles
  regardless of directory location, so renaming would add churn without
  improving topology honesty.
- Promoting Rust testkits or Rust contract implementations. No Rust code today
  needs that structure; it can be added when a future epic introduces it.
- Changing public TypeScript APIs, conformance fixtures, or generated
  artifacts.

## Authority References

- `constitution/Architecture.md` `1.4` cross-language drift risk
- `constitution/Architecture.md` `6` TypeScript-first repo structure risk and
  mitigation
- `constitution/spikes/epic-r-multilanguage-transition-guide.md` boundary
  ownership rules
- `constitution/spikes/epic-w-semantic-coverage-matrix.md` semantic surfaces
  that remain authoritative regardless of topology
