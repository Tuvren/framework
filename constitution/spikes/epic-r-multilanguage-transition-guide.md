# Epic R Multilanguage Transition Guide

This file closes `KRT-R001` in current repo reality and records the
multi-language transition posture for the post-Epic-Q implementation line. It
is not a rewrite plan. It is a boundary-preservation plan for turning Tuvren
into one artifact-backed semantic system that can later host multiple
implementations.

## Status

- `KRT-R001` is closed in current repo reality.
- Epic R remains active through `KRT-R002` to `KRT-R004`.
- Downstream Epics S-V depend on this guide; Epic W stays deferred until those
  epics close.

## Core Rule

Tuvren should be as language-neutral as possible at its semantic seams and
explicitly language-aware where native toolchains, package systems, and
implementation workflows must remain authoritative.

The first TypeScript line stays authoritative until the artifact-backed
semantic system exists. Future languages join that system; they do not replace
it with parallel truth.

## Authority Stack

Human semantic authority flows in this order:

- `docs/` for normative runtime meaning
- `constitution/` for implementation and planning authority

Machine-readable authority then flows by boundary ownership:

- `boundaries/<area>/contracts/` for shape authority
- `boundaries/<area>/conformance/` for behavioral authority
- `boundaries/<area>/interop/` for transport authority where a boundary really
  crosses process or language seams
- `tools/` for repo-global automation and orchestration wrappers
- `reports/` for generated evidence such as compatibility status

Generated code, generated bindings, and generated reports are evidence or
implementation support. They are not semantic authority by default.

## Design Principles

### Keep `boundaries/` as the universal boundary-owned root

`boundaries/` remains the home for:

- implementation code
- language-specific runners and harnesses
- authored contract sources
- authored conformance assets
- interop definitions
- checked-in generated support code that is genuinely owned by that boundary

Top-level directories outside `boundaries/` are reserved for global authority,
repo-global tooling, root workspace files, observability conventions, or
generated reports.

The current repo-root `tests/` tree is a deliberate transitional exception to
that posture until normative fixtures and scenarios are migrated into
boundary-owned `conformance/` trees.

### Keep native toolchains authoritative

The repo stays orchestrated together, but native toolchains remain authoritative
inside each language:

- TypeScript truth lives in `package.json`, `tsconfig`, and Nx project metadata
- Rust truth lives in `Cargo.toml`, `Cargo.lock`, and `rust-toolchain.toml`
- future Go truth lives in `go.mod` / `go.work`
- future Python truth lives in `pyproject.toml`
- future Zig truth lives in `build.zig`

Nx coordinates. It does not pretend every language is really TypeScript.

### Do not weaken the current TypeScript line

Nothing in this transition is allowed to destabilize the current
TypeScript-heavy delivery path. TypeScript stays the first authoritative
implementation until the transition foundation is ready.

### Keep narrow waists explicit

The long-term semantic seams that must stay artifact-backed are:

- kernel protocol boundary
- framework shared-contract boundary
- canonical event vocabulary
- stable error surface
- host/runtime control seam

### Separate shape from behavior

Schemas and service definitions are not enough. Tuvren needs both:

- contract definitions for shapes and interfaces
- conformance fixtures for observable behavior

### Prefer boring interop first

Rust enters through a process boundary, not FFI. The first goal is correctness,
durability, and inspectability across languages, not minimum overhead.

### One semantic ecosystem, then multiple implementations

TypeScript and Rust should not be compared directly as if one is the oracle.
They should both be compared against the same contracts, fixtures, and
compatibility reporting surface.

### Normalize TypeScript into the future shape first

Where a stable language-neutral structure exists, TypeScript adopts it first so
later languages inherit a real system rather than a permanent TypeScript-only
exception.

## Monorepo Governance Model

### Root-level responsibilities

The repo root owns only global concerns:

- `docs/`
- `constitution/`
- `telemetry/`
- `reports/`
- `tools/`
- root workspace files such as `package.json`, `nx.json`, `buf.yaml`,
  `buf.gen.yaml`, and future Rust workspace files
- the repo-root `tests/` tree only as a deliberate transitional exception until
  normative assets move into boundary-owned `conformance/` trees

### Boundary-owned responsibilities

Each boundary owns:

- contract sources
- generated contract artifacts when they are reviewed outputs
- conformance schemas, fixtures, and scenarios
- interop definitions where needed
- implementation trees per language

### Orchestration model

Nx remains the repo-wide task orchestrator and dependency graph layer. Native
toolchains remain the real execution engines underneath:

- Bun / TypeScript for the current line
- Cargo for Rust when introduced
- Buf for `.proto` governance and code generation
- later language-native tools only when their boundaries are authorized

## Canonical Target Vocabulary

The repo converges on a small target vocabulary across languages:

- `build`
- `test`
- `lint`
- `typecheck`
- `conformance`
- `codegen`
- `interop-smoke`
- `bench` when benchmarking becomes first-class

Target meaning stays stable even when implementations differ.

## Artifact-Layer Decisions

### Framework and provider contracts

Use TypeSpec only where it becomes the authored source. Emit:

- JSON Schema 2020-12
- OpenAPI

Expected package shape:

```text
contracts/<surface>/
  spec/
  artifacts/
  src/
  test/
```

### Kernel record grammar

Use CDDL for:

- kernel record shapes
- manifests
- turn tree records
- run records
- checkpoint and recovery payload shapes

CDDL defines record grammar only. It does not define behavior.

### Cross-process interop

Use Protobuf and gRPC for the first TS-to-Rust process boundary, limited to
the kernel. Keep authored transport definitions under:

```text
boundaries/kernel/interop/grpc/proto/
```

Use Buf for:

- linting
- generation orchestration
- breaking-change detection

Buf `FILE` compatibility is the default governance gate from the first
transport-contract merge onward. Any weaker setting must be an explicit future
decision, not a convenience downgrade.

### Behavioral authority

Use boundary-owned JSON fixtures plus JSON Schema 2020-12 fixture validation
for:

- canonical record normalization
- canonical CBOR hex expectations
- stable hash expectations
- legal and illegal transitions
- recovery traces
- approval pause/resume traces
- branching and lineage scenarios
- event sequence expectations
- stable error code expectations

### Language-specific runners

Every implementation gets its own thin runner that consumes the same shared
fixtures. The current TypeScript `testkit` packages are transitional and must
be split into:

- shared boundary-owned conformance assets
- TypeScript-specific runners

After that split, TypeScript is one peer consumer of the shared behavioral
corpus. It is not the root semantic authority for later languages.

### Generated code policy

- authored sources are primary
- reviewed generated contract artifacts may be checked in
- generated language bindings should usually stay out of source control
- if checked in, generated bindings must live under the consuming
  implementation tree

### Compatibility ledger

Compatibility status is generated under:

```text
reports/compatibility/compatibility-matrix.json
```

The ledger answers which implementation passes which suite version and whether
TS framework to Rust kernel interop passes real smoke suites. It is evidence,
not semantic authority, but it should be fit for near-public readiness signaling
once real measured results exist.

### Observability conventions

Cross-language observability is standardized under:

```text
telemetry/
  semconv/
    tuvren-runtime.yaml
  semantic-conventions.md
  otel-attributes.json
```

`telemetry/semconv/tuvren-runtime.yaml` is the authored source. The markdown
summary, JSON attribute registry, and generated TypeScript and Rust constants or
helpers are downstream outputs of that source and must exist before Rust
implementation work begins.

Initial stable attributes include:

- run id
- turn id
- branch id
- driver id
- tool call id
- checkpoint hash
- parent checkpoint hash
- resumed-from hash
- backend id
- provider id

## Target Repo Shape

The repo should move toward this shape as the transition line executes:

```text
docs/
constitution/
telemetry/
reports/
  compatibility/
tools/
  generators/
  nx/
  scripts/

package.json
nx.json
tsconfig.base.json
buf.yaml
buf.gen.yaml
Cargo.toml
Cargo.lock
rust-toolchain.toml

boundaries/
  framework/
    contracts/
    implementations/
      typescript/
      rust/
    conformance/
  kernel/
    contracts/
      protocol/
    interop/
      grpc/
    implementations/
      typescript/
      rust/
    conformance/
  providers/
    contracts/
    implementations/
      typescript/
      rust/
    conformance/
  shared/
    contracts/
  hosts/
    implementations/
      typescript/
```

This is a target shape, not a demand for one destabilizing repo rewrite.

## Migration Phases

### Phase 0 - Keep current focus stable

The TypeScript-heavy line must remain stable first:

- stable kernel behavior
- stable framework behavior
- stable driver seams
- stable runtime seams
- ReAct behaving as documented

### Phase 1 - Artifactize current truths

Do this before Rust:

- add boundary-owned `spec/`, `artifacts/`, `conformance/`, and `interop/`
  homes
- add `telemetry/`
- author the formal telemetry semantic-convention source and generated-helper
  contract before Rust begins
- formalize repo-global generators and wrappers under `tools/`
- normalize TypeScript as the first consumer of the new artifact-backed
  structure

Initial outputs should include:

- TypeSpec-authored framework/provider artifacts where justified
- kernel CDDL grammar
- protocol, recovery, and event fixtures
- a first compatibility matrix
- canonical target names

### Phase 2 - Introduce Rust kernel only

Rust scope stays inside the kernel boundary:

- kernel core
- interop service
- conformance runner

Exit criteria:

- Rust kernel passes protocol conformance
- Rust kernel passes core recovery suites
- TS framework talks to Rust kernel through the governed interop seam
- compatibility ledger reflects measured passing status

### Phase 3 - Stabilize TS framework to Rust kernel interop

Prove boring repeatability for:

- transport contracts
- event propagation
- error transport
- pause/resume behavior
- checkpoint and recovery behavior
- cross-language observability
- CI separation across repo-global, language-native, and cross-language lanes

### Phase 4 - Begin Rust framework work

Only after the kernel and interop seam are boring may Rust framework work
begin. At that point it can reuse the shared contracts, conformance assets,
transport definitions, event/error surfaces, and task model.

## Immediate Guardrails To Preserve Now

- Do not let convenience implementation details become de facto semantics.
- Treat stable error codes as part of the public semantic surface.
- Treat event names, required fields, and sequencing expectations as future
  artifact candidates.
- Do not widen the kernel seam to solve framework convenience problems.
- Prefer explicit records and envelopes over function-shaped coupling at future
  cross-language seams.
- Keep repo-global helpers in `tools/`.

## What Not To Do

- Do not use TypeSpec as the authority for kernel behavior.
- Do not make the TypeScript implementation the oracle for future languages.
- Do not start Rust interop with FFI.
- Do not delay the conformance layer until after Rust exists.
- Do not invent a universal extension or plugin ABI before the core waists are
  solid.
- Do not rebuild the whole repo structure before the TypeScript side is stable.
- Do not confuse repo-wide orchestration with a universal implementation
  toolchain.

## Verification Notes

This guide was aligned against current references before being formalized:

- TypeSpec JSON Schema and OpenAPI emitters are current supported surfaces in
  the TypeSpec docs.
- Buf v2 `buf.yaml` and `buf.gen.yaml` remain the current configuration model,
  and Buf still governs breaking-change checks through `buf breaking`.
- Cargo workspaces and `rust-toolchain.toml` remain the standard Rust workspace
  and toolchain-pinning posture.
- OpenTelemetry semantic-convention guidance still supports project-defined
  attribute conventions when existing namespaces do not already cover the
  domain.

## Next Active Dependency

The next active implementation work is `KRT-R002`, not Rust coding. The
transition only remains credible if it starts by building the artifact-backed
semantic system first.
