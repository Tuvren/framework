# Tuvren

Tuvren is a durable, stateful agent-execution framework. It applies the model of content-addressed storage, parent-linked history, and movable references — the way Git tracks source history — to continuous runtime checkpointing, so an agent's execution state survives crashes, restarts, and branching without a separate durability layer bolted on top.

"Kraken" is the engine-internal name for the substrate underneath — durable turn/thread/branch state, deterministic hashing, backend capabilities — and never appears in consumer-facing APIs; host-developer APIs are always `Tuvren*`.

## Why

Most agent frameworks treat durability as an afterthought: state lives in process memory, and "resumability" means replaying a transcript against a fresh model call. Tuvren instead makes every step of execution a durable, content-addressed write:

- **Every turn is checkpointed, not just logged.** A crash mid-turn resumes from the last durable write, not from the start of the conversation.
- **Threads branch like Git branches.** Forking a conversation to explore an alternate path is a first-class kernel operation, not an application-level workaround.
- **The kernel knows nothing about agents.** It provides mechanism — immutable content storage, structured snapshots, a history DAG, write-ahead tracking — without policy. It doesn't know what a "model call" or a "tool" is. That separation is what lets the framework layer evolve (new runners, new providers) without touching the durability guarantee underneath it.
- **Cross-language semantics are defined once.** Every implementation — TypeScript, Rust, Go, Python, Dart — is certified against the same language-neutral authority, not against another implementation's source. See [The certification model](#the-certification-model).

Read `docs/KrakenKernelSpecification.md` for the full kernel semantics and `docs/KrakenFrameworkSpecification.md` for the framework/runner layer built on top of it.

## Architecture

Three layers, each with a narrower job than the one above it:

| Layer | Owns | Knows about |
|---|---|---|
| **Kernel** | Durable mechanism: content-addressed storage, the turn/thread/branch history DAG, checkpointing, backend capabilities | Nothing about agents — pure structural persistence |
| **Framework** | Shared runtime model: messages, tool calls, structured output, approvals, streaming event shapes, context assembly | The kernel's primitives, not any one runner's control flow |
| **Runner** | One concrete execution model over the shared framework and kernel (today: ReAct) | Iterative loop behavior, provider/tool feedback |

Everything crossing the kernel/framework boundary is data — serializable, schema-driven, inspectable. No callbacks from kernel to framework, no framework types leaking into the kernel.

**What's implemented on top of that, in the TypeScript reference implementation:**

- **Providers** — `bridge-ai-sdk` adapts any Vercel AI SDK model (OpenAI, Anthropic, Gemini, and the rest of the AI SDK's provider ecosystem) to the `TuvrenProvider` contract.
- **Runner** — `runners/react`, the reason-act agent loop.
- **Backends** — durable session persistence on `memory` (tests/dev), `sqlite` (single-node), and `postgres`.
- **Streaming** — a shared stream-adapter core, projected onto Server-Sent Events (`streaming/sse`) and the AG-UI protocol (`streaming/agui`) for HTTP hosts.
- **Tools** — `tools/mcp-client` connects Model Context Protocol servers as Tuvren tool sources.
- **Telemetry** — an OpenTelemetry sink (`telemetry/otel`) bridging Tuvren events and spans onto OTel.
- **Host** — `host/repl`, an interactive REPL and CLI driving the above end to end.

## Repo map

- `spec/` — language-neutral authority: authority packets, CDDL/TypeSpec contracts, generated artifacts, and conformance plans/fixtures per port (`kernel`, `core`, `providers`, `tools`, `runners`, `streaming`, `host`, `telemetry`, `interop`, `extensions`).
- `typescript/` — the TypeScript reference implementation: kernel, runtime, providers, runners, streaming, tools/drivers, telemetry, and the host REPL, plus each boundary's conformance adapters and certification wrappers.
- `rust/` — the Rust kernel-port line: the kernel (`rust/kernel`), its gRPC service (`rust/kernel-grpc-service`), and both the kernel-specific and generic framework conformance adapter/certification pairs (`rust/kernel-conformance-adapter` + `rust/kernel-certification`, `rust/conformance-adapter` + `rust/certification`).
- `go/` and `python/` — the Go and Python kernel-port lines, following the same flat-per-unit shape as Rust: `<lang>/kernel`, `<lang>/kernel-conformance-adapter`, `<lang>/kernel-certification`, registered in the root `go.work` and `pyproject.toml`/`uv.lock` respectively. Both are certified today at full eight-capability parity with the TypeScript memory baseline, with 68 of 72 kernel conformance checks applicable and passing (the remaining 4 are non-applicable durable-backend/shared-clock checks a process-local memory backend can't exercise).
- `dart/` — the Dart kernel-port line, following the same flat-per-unit shape: `dart/kernel`, `dart/kernel-conformance-adapter`, `dart/kernel-certification`, registered as members of the root `pubspec.yaml` pub workspace and pinned by the committed `pubspec.lock`. Certified today at the same capability parity and check count as Go and Python — 68 of 72 applicable kernel conformance checks passing, 4 non-applicable.
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

# 1. Load the repo toolchain (bun, cargo, go, uv/python, bazel, buf, weaver, postgres — via Nix/devenv)
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
- [Streaming and events](docs/guides/streaming-and-events.md)
- [Adding a new implementation language](docs/guides/add-a-language.md)
- [Adding a new driver](docs/guides/add-a-driver.md)
- [Adding a new runner](docs/guides/add-a-runner.md)
- [Adding a new kernel backend](docs/guides/add-a-kernel-backend.md)
- [Publishing and adopter onboarding](docs/guides/publishing-and-adopter-onboarding.md)
- [Kernel Specification](docs/KrakenKernelSpecification.md)
- [Framework Specification](docs/KrakenFrameworkSpecification.md)

## License

Apache License 2.0 — see [LICENSE](LICENSE).
