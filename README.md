# Tuvren

Tuvren is a durable, stateful agent-execution framework, built polyglot by construction: language-neutral authority under `spec/` (authority packets, CDDL/TypeSpec contracts, and conformance plans) defines cross-language semantics once, and each language implementation is certified against that same authority rather than against another language's source. The kernel — durable turn/thread/branch state, deterministic hashing, backend capabilities — is the substrate this durability guarantee is built on; "Kraken" is the engine-internal name for that substrate and never appears in consumer-facing APIs.

## Repo map

- `spec/` — language-neutral authority: authority packets, CDDL/TypeSpec contracts, generated artifacts, and conformance plans/fixtures per port (`kernel`, `core`, `providers`, `tools`, `runners`, `streaming`, `host`, `telemetry`, `interop`, `extensions`).
- `typescript/` — the TypeScript reference implementation: kernel, runtime, providers, runners, streaming, tools/drivers, telemetry, and the host REPL, plus each boundary's conformance adapters and certification wrappers.
- `rust/` — the Rust implementation line, currently the framework's second language: the kernel (`rust/kernel`), its gRPC service (`rust/kernel-grpc-service`), and both the kernel-specific and generic framework conformance adapter/certification pairs (`rust/kernel-conformance-adapter` + `rust/kernel-certification`, `rust/conformance-adapter` + `rust/certification`).
- `tools/` — shared, language-neutral tooling: the semantic conformance engine (`tools/conformance/harness/run.ts`), the adapter protocol, certification discovery, codegen/validation scripts, and generators.
- `docs/` — human-authored specifications (`KrakenKernelSpecification.md`, `KrakenFrameworkSpecification.md`) and contributor guides (`docs/guides/`).

## Quickstart

```sh
# 0. One-time prerequisites: install Nix and devenv (as CI's setup-toolchain
#    action does), plus direnv for the local .envrc hook (CI enters the devenv
#    shell directly instead). CI pins the canonical devenv version in
#    .github/actions/setup-toolchain/action.yml.
curl -fsSL https://install.determinate.systems/nix | sh -s -- install
# ... restart your shell so `nix` is on PATH, then:
nix profile install nixpkgs#devenv nixpkgs#direnv   # then enable direnv's shell hook

# 1. Load the repo toolchain (bun, cargo, bazel, buf, weaver, postgres — via Nix/devenv)
direnv allow   # or: eval "$(devenv direnvrc)" && use devenv

# 2. Install workspace dependencies
bun install

# 3. Fast inner-loop check (authority gates + affected typecheck/test/lint)
bun run check

# 4. Start devenv-managed services once per session (Postgres, for kernel/verify lanes)
bun run services:up

# 5. Full release gate
bun run verify
```

Narrower lanes exist for iterating on the kernel boundary specifically: `bun run verify:kernel` (cached) and `bun run verify:kernel:fresh` (forced through uncached Nx targets).

## The certification model

Cross-language truth lives in committed, machine-readable authority under `spec/` — authority packets and conformance plans — never in Markdown or in any one implementation's source. Certification is discovery-driven: every Nx project tagged `layer:certification` is discovered automatically and cross-checked against a manifest (`tools/conformance/certification/certified-projects.json`) by a hard-fail parity gate, so a certification runner can't silently disappear or go unregistered. Each certified project wraps a language-specific conformance adapter — a protocol-only process that never grades its own output — and the shared semantic engine (`tools/conformance/harness/run.ts`) evaluates that adapter's behavior against the authority-defined conformance plan, so every implementation of a given port is judged against the same neutral checks.

## Guides

- [How conformance works](docs/guides/how-conformance-works.md)
- [Adding a new implementation language](docs/guides/add-a-language.md)
- [Adding a new driver](docs/guides/add-a-driver.md)
- [Adding a new runner](docs/guides/add-a-runner.md)
- [Kernel Specification](docs/KrakenKernelSpecification.md)
- [Framework Specification](docs/KrakenFrameworkSpecification.md)

## License

Apache License 2.0 — see [LICENSE](LICENSE).
