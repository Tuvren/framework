# Runtime Monorepo Tooling Assessment

## Purpose

Record the current judgment about the monorepo orchestration stack and local
developer environment so future implementation work does not accidentally turn
Nx into the semantic or operational authority for the multi-language runtime.

This report is a tooling-boundary assessment, not a migration authorization.

## Summary Judgment

The current `devenv + native toolchains + Nx` setup is good enough for the
current transition line through Epic V, but it should be treated as
transitional rather than final.

The repo already does several important things correctly:

- `devenv` owns reproducible shell provisioning for Bun, Node, Rust, Buf,
  Protobuf tooling, and Weaver
- Cargo owns the Rust workspace and Rust package/build/test truth
- Buf owns `.proto` linting, breaking checks, and generation governance
- TypeSpec owns the selected contract-authoring lanes
- Weaver owns telemetry semantic-convention generation

The main weakness is orchestration scope. Nx currently acts as the operational
entrypoint for much more than TypeScript ergonomics. Root `typecheck`,
`conformance`, `codegen`, and `interop-smoke` all route through Nx, and most
Rust and Buf targets are currently expressed as `nx:run-commands` wrappers
around native CLIs.

That is acceptable for the current phase, but it is not the right long-term
authority posture for a multi-language monorepo.

## Current-State Judgment

### 1. The local developer environment is fundamentally healthy

`devenv.nix` pins the core shell toolchain surface for the active stack:

- Bun
- Node.js
- Rust via `rust-toolchain.toml`
- Buf
- Protobuf / `protoc-gen-es`
- Weaver

This is a strong base for reproducibility and cross-language onboarding.

### 2. Native tools already own important truths

The repository has already avoided the worst failure mode of fake toolchain
neutrality.

- TypeScript truth lives in workspace manifests, `tsconfig`, and package-local
  build/test commands
- Rust truth lives in `Cargo.toml`, `Cargo.lock`, and `rust-toolchain.toml`
- Buf truth lives in `buf.yaml` and `buf.gen.yaml`
- contract and telemetry generation still invoke their real native CLIs

This means the repo is not currently pretending that Nx is the compiler,
package manager, or schema system.

### 3. Nx currently owns too much operational control

The current graph is still Nx-centered in practice:

- root scripts route most verification through `nx run` or `nx run-many`
- Rust package targets are exposed through `nx:run-commands`
- Buf governance and codegen are exposed through Nx targets
- compatibility generation and telemetry generation are exposed through Nx

This keeps one convenient entrypoint, but it also means the canonical
cross-language execution story still runs through Nx task definitions.

### 4. The current setup is adequate for Epic V, not ideal for the final state

Epic V still focuses on TypeScript framework to Rust kernel interop
stabilization. The repo does not yet contain multiple mature non-TypeScript
implementation trees competing for equal build-system authority.

Because of that, replacing the current stack with Bazel immediately would be a
large migration cost before the repo has fully earned the complexity:

- Bun-oriented package and runtime flows would need Bazel-native wrapping
- TypeSpec and Weaver lanes would likely require custom shell-rule posture
- the repo would need a second graph and target taxonomy migration at the same
  time as interop stabilization

That is too much movement for the current critical path.

## Bazel Recommendation Assessment

The proposed ownership split is directionally correct for the long-term target
state.

### Keep from the recommendation

- Bazel is a more credible long-term owner than Nx for:
  - canonical dependency graph
  - cross-language build and test graph
  - hermetic toolchains
  - cache truth
  - CI affectedness
  - artifact production
- Nx is better suited to:
  - JS/TS ergonomics
  - generators
  - frontend or host-app workflows
  - local developer UX wrappers

### Reject as an immediate migration

Do not migrate to Bazel now solely because the ownership model is attractive on
paper.

The present repository is still in the phase where:

- TypeScript remains the first authoritative implementation line
- Rust is active only in the kernel boundary
- the immediate critical path is interop stabilization, not build-system
  replacement

The repo should therefore avoid a premature toolchain migration that would
compete with Epic V for attention and validation bandwidth.

## Recommended Posture Now

### 1. Keep the current stack through Epic V

Continue using:

- `devenv` for reproducible shell provisioning
- Bun for workspace package management and TypeScript runtime entrypoints
- Cargo for Rust package/build/test truth
- Buf for `.proto` governance
- Nx for target routing and local UX

### 2. Treat Nx as orchestration, not authority

Nx may continue to expose convenient targets, but the repo should preserve the
rule that native tools remain authoritative inside each ecosystem.

That means:

- do not move Rust dependency or build truth out of Cargo
- do not move proto governance truth out of Buf
- do not turn Nx metadata into the canonical cross-language contract graph
- do not make CI validity depend on Nx-only knowledge that native tools do not
  also expose

### 3. Avoid expanding Nx into permanent monorepo truth

Future changes should not increase Nx authority beyond the current transitional
posture unless the constitution explicitly authorizes that move.

In particular, avoid:

- making new cross-language contracts depend on Nx-only project metadata
- encoding artifact validity rules only in Nx target wiring
- treating Nx affectedness as the only CI truth for non-TypeScript changes
- making native tool invocations unreachable except through Nx wrappers

### 4. Revisit Bazel only when the repo earns it

A Bazel migration becomes materially more compelling when most of the following
are true:

- more than one non-TypeScript implementation tree is active
- cross-language code generation fans out into multiple consumer trees
- CI cost or cache invalidation noise becomes a recurring problem
- hermeticity gaps start causing real drift between local and CI behavior
- the repo is ready to promote one canonical cross-language build graph

Until then, the repo should prefer disciplined orchestration boundaries over a
full build-system replacement.

## Working Rule

For the current transition line:

- native toolchains own truth
- `devenv` owns reproducible environment provisioning
- Nx owns convenience orchestration only

If future work starts drifting toward Nx owning canonical cross-language graph
truth, artifact validity, or CI truth, stop and reassess before proceeding.
