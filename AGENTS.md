# Repository Guidelines

## Project Structure & Module Organization

This is an architecture-first, multi-language runtime monorepo. TypeScript is one implementation lane, alongside Rust kernel implementation, gRPC kernel interop, boundary-owned conformance assets, telemetry generation, and compatibility reporting. Cross-language authority is owned by boundary packets, generated artifacts, conformance plans, fixtures, interop assets, and measured evidence rather than by any implementation language. Runtime code and semantic assets live under `boundaries/`:

- `boundaries/framework/` for shared runtime contracts, TypeScript framework implementations, stream adapters, the ReAct driver, framework conformance assets, and Rust-kernel interop scenarios
- `boundaries/kernel/` for kernel contracts, TypeScript kernel implementations, Rust kernel crates, gRPC interop definitions, and kernel conformance assets
- `boundaries/providers/` for provider-facing contracts, TypeScript provider implementations, the AI SDK bridge, and provider conformance assets
- `boundaries/hosts/` for private host harnesses such as the TypeScript playground
- `boundaries/shared/` for truly cross-boundary primitives

Within `boundaries/`, path topology must reveal language ownership through the
path alone:

- language-neutral assets live at boundary, contract, conformance, and interop roots
- language-specific package roots live only under `implementations/<lang>/`
- boundary-level testkits live only under `boundaries/<area>/implementations/<lang>/testkit/`
- contract roots may hold neutral `spec/`, `artifacts/`, and explanatory `README.md` files, but TypeScript package manifests and sources belong under sibling `implementations/typescript/` trees

Do not place `package.json`, `Cargo.toml`, `src/`, `dist/`, `test/`,
`bench/`, `smoke/`, `tsconfig*.json`, generated bindings, or other
language-tooling output at a boundary root or contract root.

Working plans live in `constitution/`. Engine-level specs live in `docs/`. The root `tests/` tree is not an authority home and must not own reusable TypeScript contract, conformance, or compatibility fixtures; keep shared executable behavioral assets under the relevant boundary-owned `conformance/` or `interop/` roots. Tooling scripts live in `tools/`. Repo-level telemetry and compatibility evidence live in `telemetry/` and `reports/compatibility/`.

## Source of Truth

Align behavior changes with `docs/` and implementation changes with `constitution/`.

- Read `docs/KrakenKernelSpecification.md` before changing kernel behavior
- Read `docs/KrakenFrameworkSpecification.md` before changing framework behavior
- Use `constitution/TechSpec.md` and `constitution/Tasks.md` to keep implementation and active scope aligned
- Read current epic status, deferred scope, and active critical path from `constitution/Tasks.md` instead of repeating that state in agent guidance
- Treat `constitution/spikes/` closure inventories as durable handoff records for closed epics when touching areas they established
- Keep boundary-owned `contracts/`, `conformance/`, `interop/`, generated artifacts, and `reports/compatibility/` aligned with the human specs when a change affects their semantics
- When a constitution-scoped epic is fully closed in repo reality, update the matching `constitution/Tasks.md` and `constitution/TechSpec.md` status language in the same change and add or refresh any closure inventory under `constitution/spikes/` that future epics depend on
- When a shared contract adds a host-owned control or policy seam (for example `loopPolicy` or handoff helpers), either wire it through the baseline ReAct/runtime path in the same change or explicitly document the limitation in `docs/` and `constitution/`

Do not invent behavior, contracts, or scope that conflict with those sources.

## Build, Test, and Development Commands

- `bun run lint` checks formatting and lint rules with Biome
- `bun run format` applies Biome fixes
- `bun run typecheck` runs Nx typechecks across the workspace
- `bun run conformance` runs the active TypeScript and Rust conformance runners
- `bun run compatibility:evidence` refreshes the checked-in compatibility matrix and evidence files, including known red TDD lanes, without treating red evidence as a passing verification gate
- `bun run codegen` regenerates TypeSpec, telemetry, compatibility, and kernel interop artifacts
- `bun run interop-smoke` runs the governed interop smoke lanes, including Rust-kernel paths
- `bun run verify` runs the repo-global verification script across TypeScript, Rust, codegen, conformance, and interop lanes
- `bun run release-check` runs the release-oriented verification wrapper and reports Bun/Node runtime drift
- `bun run nx run <project>:test` runs a package test target, for example `bun run nx run framework-runtime-api:test`
- `bun run nx graph` opens the Nx project graph

Use `bun` for package management and TypeScript runtime entry points. Use Nx targets for package-scoped work when they exist, but keep the native command authoritative inside its ecosystem.

### Tooling Authority Guardrail

- Treat the current `devenv + native toolchains + Nx` stack as transitional and coordination-oriented.
- Native tools remain authoritative inside their ecosystems: Cargo for Rust workspace truth, Buf for `.proto` governance, Bun/TypeScript manifests and `tsconfig` for TypeScript package truth, and generator CLIs such as TypeSpec or Weaver for their artifact families.
- Nx may provide local ergonomics, target routing, generators, and developer UX wrappers, but it must not become the canonical cross-language monorepo graph, contract authority, artifact-validity authority, or CI truth source.
- When adding or changing cross-language build, test, codegen, or interop lanes, prefer making the native command the real source of truth and Nx the wrapper around it rather than encoding unique validity rules only in Nx metadata.

## Coding Style & Naming Conventions

Formatting and linting are owned by Biome. Keep package entrypoints small and explicit, and prefer Nx target wiring over package-local script sprawl.

Name boundaries matter:

- `Tuvren` is the product and host-developer surface: package names, imports, public runtime APIs, and examples
- `Kraken` marks engine internals and subsystem wrappers, while public contract symbols should use `Tuvren*` or neutral runtime names such as `RuntimeKernel` and `RuntimeDriver`

If a change makes ordinary library consumers type `Kraken*`, treat that as a boundary check.

Cross-language boundary discipline matters too:

- Keep host/framework controls such as `ExecutionHandle`, cancellation, steering, approval resolution, and stream fanout above the kernel transport seam.
- Keep kernel interop protocol-only and data-only. Do not widen `boundaries/kernel/interop/grpc/proto/` into framework or host semantics.
- Generated TypeScript and Rust helpers must derive from the owned sources instead of becoming parallel hand-authored contracts.

## Testing Guidelines

Tests use Bun (`bun test`) for TypeScript packages, Cargo for Rust crates, and Nx as the repo-facing wrapper where targets exist. Keep package-local tests near the package they verify under `test/`, and keep shared behavioral assets under boundary-owned `conformance/` or `interop/` roots. Root-level `tests/` files must not import `@tuvren/*` packages or become reusable semantic fixtures; move those assets into boundary-owned conformance/interop roots, or into package-local tests when they are binding-local probes.

Run the narrowest relevant target first before broadening:

- TypeScript package checks: `bun run nx run <project>:test`, `:typecheck`, or `:build`
- Rust checks: the relevant Cargo command or Rust Nx target for `kernel-rust-kernel`, `kernel-rust-grpc-service`, or `kernel-rust-conformance-runner`
- Contract/codegen changes: `bun run codegen` or the specific `:codegen` target
- Cross-language changes: `bun run interop-smoke` or the specific `kernel-interop-grpc`, `kernel-rust-grpc-service`, or `host-playground` interop target
- Release confidence: `bun run verify` before claiming broad workspace readiness

Conformance status is part of the contract, not just command output. If a
runner emits structured evidence with `status: "fail"`, the normal
`conformance`, `codegen`, and `verify` gates must fail; use
`bun run compatibility:evidence` only when intentionally refreshing checked-in
evidence for an implementation lane that is expected to remain red.
Authority fixture validation is not implementation conformance. A promoted
implementation check may use a boundary fixture as input, but the passing
evidence must come from implementation code run through the adapter protocol,
not from replaying the fixture and asserting it against itself.
Event-stream implementation conformance must consume events emitted by the
runtime or driver implementation under test; projection-only checks over
preauthored stream fixtures belong in binding-local adapter tests or fixture
validation, not in compatibility evidence for an implementation lane.
Promoted plans must not assert implementation-owned error-code literals such as
driver- or runner-specific prefixes unless a neutral contract artifact owns that
code first.
Treat each conformance plan `evidence` entry as required evidence. A check that
passes its assertions but omits required evidence is still failing conformance.
Keep driver-neutral plans and concrete-driver plans separate: ReAct loop counts,
hook sequencing, and other ReAct-specific behavior belong under the ReAct driver
authority packet/plan family, not under the neutral `driver-api` packet.

## Pull Request Follow-Up

When review feedback changes behavior, validation scope, docs, or follow-up context, update the PR body before merge so it reflects the final branch rather than the initial submission.

Before closing a PR that touches this file, remove or rephrase any guidance that only describes the temporary branch state. `AGENTS.md` should remain durable operating guidance, not a snapshot of the PR.

## Review-Learned Guardrails

- When an epic claims a scenario matrix, every named scenario needs an automated check path that asserts all report checks, not just a few representative examples.
- For reload, branching, approval resume, steering, and metadata claims, validate the specific public behavior and durable state being claimed; do not treat object existence or generic turn completion as sufficient evidence.
- If review exposes a mismatch between specs, framework tests, backend invariants, and package behavior, step back and align the contract, implementation, tests, docs, and constitution together instead of patching only the visible symptom.
- When a smoke target persists state, prefer disposable inputs or explicit cleanup so repeated validation cannot inherit stale state.
- Keep review-fix comments short and intentional: explain non-obvious validation boundaries, such as why memory reload checks intentionally fail or why a scenario is Node-backed.

## Machine-Enforced Authority Guardrails (Epic Y)

These rules are enforceable on every PR. They derive from TechSpec ADR-023, ADR-024, ADR-025, ADR-026, ADR-027, and ADR-028 and from the new logical containers in Architecture §2.

- **No Implementation Oracle.** No cross-implementation semantic claim, conformance assertion, or compatibility claim may cite any file under `boundaries/<area>/contracts/<surface>/implementations/<lang>/`, `boundaries/<area>/implementations/<lang>/`, or any other implementation-language source tree as authority. Implementation-language files may host bindings, adapters, generated projections, local tests, and optimization logic; they may not define cross-language truth. Reject PRs that claim "TypeScript is the source of truth" or "see the runtime-core implementation" for a cross-implementation surface. The authoritative source is the surface's `spec/authority-packet.json` manifest.
- **No Prose Oracle.** No acceptance criterion, conformance claim, compatibility claim, release gate, or interop check may depend solely on Markdown — including `docs/`, `constitution/`, `AGENTS.md`, or boundary `README.md` files. Every binding cross-language semantic claim must cite or derive from a machine authority packet, generated artifact, conformance plan, or measured evidence file. Markdown remains the home for rationale, workflow, ADRs, and decision records, paired with the executable artifacts that carry the actual contract.
- **No Runner Oracle.** Final Epic Y posture is one shared semantic conformance engine under `tools/conformance/runner/` plus implementation-language adapter hosts under `boundaries/<area>/implementations/<lang>/conformance-adapter/`. Any remaining `conformance-runner/` path under an implementation tree is transitional and must not grow assertion, pass/fail, required-evidence, compatibility-evidence, or check-scoped semantics. Product semantics — expected event sequences, expected error codes, expected check IDs, expected lifecycle transitions, expected provider/tool behavior — must arrive only from a Conformance Plan (TechSpec §4.12) referenced by an Authority Packet manifest. Reject PRs that add product-semantic literals or assertion ownership to runner or adapter source outside native invocation mechanics.
- **Shared Runner Evidence Only.** Compatibility evidence for current conformance lanes must be produced by `tools/conformance/runner/run.ts` through an adapter manifest. Implementation `conformance-runner/` projects may remain as Nx/native command wrappers, but they are not semantic engines and must not write compatibility evidence directly.
- **Adapter Hosts Are Not Evidence Authorities.** Adapter hosts start native implementations, translate neutral operations into native calls, and return neutral observations plus diagnostics. They must not receive `checkId`, call `emitEvidence(checkId, ...)`, decide pass/fail, replay fixtures as implementation proof, or map adapter/protocol failures into `$.result.error` where they can satisfy implementation assertions.
- **No Language-Lane Plan Pinning.** Promoted conformance plans must select capability or surface requirements, not implementation adapter IDs such as `typescript-*`. Adding another language implementation must not require editing authority plans just to be included in already-promoted checks.

When a surface lacks an Authority Packet manifest, it is in deferred scope per `constitution/Tasks.md` Epic Y; do not invent a cross-implementation claim for it inside an implementation language file, runner source, adapter source, or Markdown. Open or extend an Authority Packet manifest in the same change instead.
