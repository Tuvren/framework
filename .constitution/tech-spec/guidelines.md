---
verification_commands:
  - name: other
    label: "Inner loop"
    command: "bun run check"
    exists: true
  - name: lint
    command: "bun run lint"
    exists: true
  - name: format
    command: "bun run format"
    exists: true
  - name: typecheck
    command: "bun run typecheck"
    exists: true
  - name: test
    label: "All TypeScript project tests"
    command: "bun run nx run-many -t test"
    exists: true
  - name: build
    label: "All TypeScript project builds"
    command: "bun run nx run-many -t build"
    exists: true
  - name: other
    label: "Kernel boundary gate"
    command: "bun run verify:kernel"
    exists: true
  - name: other
    label: "Full release gate"
    command: "bun run verify"
    exists: true
  - name: other
    label: "Semantic conformance lanes"
    command: "bun run conformance"
    exists: true
  - name: other
    label: "Generated artifact freshness"
    command: "bun run codegen"
    exists: true
  - name: other
    label: "Cross-language interop smoke"
    command: "bun run interop-smoke"
    exists: true
  - name: other
    label: "Portability gate"
    command: "bun run portability:check"
    exists: true
  - name: other
    label: "Host import-boundary gate"
    command: "bun run host-boundary:check"
    exists: true
  - name: other
    label: "Public API freeze gate"
    command: "bun run api-freeze:check"
    exists: true
  - name: other
    label: "Compatibility evidence freshness"
    command: "bun run compatibility:check"
    exists: true
  - name: docs
    label: "Docs-to-authority freeze gate"
    command: "bun run docs:authority-freeze:check"
    exists: true
  - name: docs
    label: "Conformance gap plan freshness"
    command: "bun run docs:af-gap-plan:check"
    exists: true
  - name: probe
    label: "Proving host, SQLite backend"
    command: "bun run proving-host:scenario-sqlite"
    exists: true
  - name: probe
    label: "Proving host, PostgreSQL backend"
    command: "bun run proving-host:scenario-postgres"
    exists: true
  - name: other
    label: "Release readiness"
    command: "bun run release-check"
    exists: true
  - name: typecheck
    label: "Narrow lane quoted by archived ticket KRT-BJ001"
    command: "bun run nx run sdk:typecheck && bun run nx run framework-runtime:typecheck && bun run conformance"
    exists: true
  - name: typecheck
    label: "Narrow lane quoted by archived ticket KRT-BJ002"
    command: "bun run nx run host-repl:typecheck && bun run nx run host-repl:test"
    exists: true
  - name: typecheck
    label: "Narrow lane quoted by archived ticket KRT-BJ004"
    command: "bun run nx run shared-core:typecheck && bun run nx run sdk:typecheck && bun run nx run framework-runtime:typecheck"
    exists: true
  - name: typecheck
    label: "Narrow lane quoted by archived ticket KRT-BJ006"
    command: "bun run nx run shared-core:typecheck && bun run lint"
    exists: true
  - name: lint
    label: "Narrow lane quoted by archived ticket KRT-BJ007"
    command: "bun run lint && bun run nx run shared-core:typecheck"
    exists: true
  - name: other
    label: "Narrow lane quoted by archived ticket KRT-BJ008"
    command: "bun run nx run shared-core:typecheck && bun tools/scripts/release-check.ts"
    exists: true
  - name: test
    label: "Narrow lane quoted by archived ticket KRT-BK003"
    command: "bun run nx run backend-memory:test"
    exists: true
  - name: test
    label: "Narrow lane quoted by archived tickets KRT-BK009 and KRT-BK011"
    command: "bun run nx run backend-sqlite:test"
    exists: true
  - name: test
    label: "Narrow lane quoted by archived ticket KRT-BL004"
    command: "bun run nx run host-repl:test"
    exists: true
  - name: build
    label: "Narrow lane quoted by archived ticket KRT-BM007"
    command: "bun run nx run backend-sqlite:build"
    exists: true
  - name: typecheck
    label: "Narrow lane quoted by archived ticket KRT-BM008"
    command: "bun run nx run framework-runtime:typecheck"
    exists: true
  - name: other
    label: "CI workflow definition quoted as the verification artifact by archived ticket KRT-BM001"
    command: ".github/workflows/ci.yml"
    exists: true
layout:
  - path: spec
    purpose: "Language-neutral runtime authority, organized by port: authority packets, TypeSpec and CDDL sources, generated artifacts, and shared conformance plans and fixtures."
  - path: typescript
    purpose: "The first authoritative implementation line, one package per runtime area (core, sdk, runtime, kernel, providers, runners, streaming, telemetry, tools, host)."
  - path: rust
    purpose: "The Rust kernel-port line, including the kernel gRPC service and its conformance adapter."
  - path: go
    purpose: "The Go kernel-port line as flat modules under the root go.work."
  - path: python
    purpose: "The Python kernel-port line as uv workspace members under the root pyproject.toml."
  - path: dart
    purpose: "The Dart kernel-port line as pub workspace members under the root pubspec.yaml."
  - path: tools/conformance/harness
    purpose: "The shared semantic conformance engine that every implementation adapter runs against."
  - path: tools/scripts
    purpose: "Repository gates invoked through Nx and bun scripts: freeze, portability, host boundary, API freeze, verify, and release lanes."
  - path: tools/generators
    purpose: "Artifact generators for the TypeSpec, protobuf, and semantic-convention families."
  - path: tools/nx
    purpose: "Nx target routing helpers shared across the language lines."
  - path: docs
    purpose: "The human semantic layer: the Kraken kernel and framework specifications the authority gates classify."
  - path: tests
    purpose: "Cross-cutting repository tests that sit above any single language package."
  - path: reports/compatibility
    purpose: "Checked-in compatibility evidence refreshed by bun run compatibility:evidence."
  - path: .github/workflows
    purpose: "CI lanes that run the same gates as the local lane ladder."
  - path: .constitution
    purpose: "The staged constitution: prd, architecture, tech-spec, and tasks, plus reports, research, spikes, and evidence."
live_verification:
  - name: reference-host-memory-scenario
    surface: cli
    launch: "bun run nx run host-repl:build"
    doctor: "python3 -c 'raise SystemExit(0 if __import__(\"os\").path.isfile(\"typescript/host/repl/dist/cli.js\") else 1)'"
    drive: "bun run nx run host-repl:scenario"
    drive_kind: command
    evidence:
      kind: log_line
      ref: "\"scenario\": \"streaming\""
    exists: true
  - name: reference-host-headless-sqlite
    surface: cli
    launch: "bun run nx run host-repl:build"
    doctor: "python3 -c 'raise SystemExit(0 if __import__(\"os\").path.isfile(\"typescript/host/repl/dist/cli.js\") else 1)'"
    drive: "bun run proving-host:scenario-sqlite-pinned && bun -e 'console.log(\"headless sqlite scenario passed\")'"
    drive_kind: command
    evidence:
      kind: log_line
      ref: "headless sqlite scenario passed"
    exists: true
  - name: kernel-grpc-interop-smoke
    surface: rpc
    launch: "bun run nx run host-repl:build"
    doctor: "cargo --version"
    drive: "bun run proving-host:interop-smoke"
    drive_kind: command
    evidence:
      kind: log_line
      ref: "headlessInteropSmoke"
    exists: true
  - name: mcp-stdio-smoke
    surface: other
    launch: "bun run nx run host-repl:build"
    doctor: "cargo --version"
    drive: "bun run proving-host:interop-smoke"
    drive_kind: command
    evidence:
      kind: log_line
      ref: "mcpOutputSeen"
    exists: true
commit_convention: "Conventional Commits with a scope naming the ticket, epic, or area: feat(BJ004), fix(kernel-protocol), chore(constitution), docs(tsdoc). The subject stays imperative and under about 72 characters; the body explains what changed and why."
safety_standard: "Untrusted edges — provider responses, MCP servers, tool inputs, and client-reported results — are validated at the boundary and surfaced as agent-visible results rather than trusted. Every turn runs under a configured execution bound. Credentials never reach durable state, operational telemetry, or a transcript."
---
## 5. Implementation Guidelines

### 5.1 Project Structure

Target implementation layout for the first authoritative TypeScript line plus
the multi-language transition foundation:

```text
.
├── .constitution/
├── docs/
├── reports/
│   └── compatibility/
├── tools/
│   ├── generators/
│   ├── nx/
│   └── scripts/
├── devenv.nix
├── devenv.yaml
├── biome.jsonc
├── package.json
├── bun.lock
├── nx.json
├── tsconfig.base.json
├── tsconfig.json
├── buf.yaml                # when kernel interop activates
├── buf.gen.yaml            # when kernel interop activates
├── Cargo.toml              # when Rust is introduced
├── Cargo.lock              # when Rust is introduced
├── rust-toolchain.toml     # when Rust is introduced
├── spec/                                    # language-neutral authority, port-organized
│   │                                        # (Epic #87: this supersedes the former
│   │                                        # boundaries/<area>/contracts|conformance|interop
│   │                                        # split; @tuvren/core absorbed the former
│   │                                        # runtime-api/, event-stream/, tool-contracts/,
│   │                                        # and driver-api/ contract subtrees per ADR-0037 —
│   │                                        # this is current repo reality, not a pending step)
│   ├── core/                                # neutral authority for @tuvren/core
│   │   ├── typespec/
│   │   ├── bindings/
│   │   ├── artifacts/
│   │   │   ├── json-schema/
│   │   │   └── openapi/
│   │   └── authority-packet.json            # one merged packet declaring the @tuvren/core
│   │                                        # subpath surfaces (messages, tools, capabilities,
│   │                                        # events, errors, execution, runner, provider,
│   │                                        # extensions, telemetry)
│   ├── kernel/
│   │   ├── cddl/
│   │   ├── artifacts/
│   │   └── authority-packet.json
│   ├── host/                                # includes client-endpoint-integration.md
│   │   ├── typespec/
│   │   ├── bindings/
│   │   └── artifacts/
│   ├── providers/
│   │   ├── typespec/
│   │   ├── bindings/
│   │   └── authority-packet.json
│   ├── tools/
│   │   ├── mcp/                             # ADR-0039: authority packet for MCP tool-source
│   │   │   └── authority-packet.json
│   │   └── typespec/
│   ├── runners/
│   │   ├── react/                           # @tuvren/runner-react authority
│   │   │   └── authority-packet.json
│   │   ├── typespec/
│   │   └── bindings/
│   ├── streaming/
│   │   ├── sse/
│   │   │   └── authority-packet.json
│   │   ├── resume/                          # tuvren.framework.event-stream-resume (ADR-0061)
│   │   │   └── authority-packet.json
│   │   ├── ws/                               # tuvren.framework.event-stream-ws (ADR-0062)
│   │   │   └── authority-packet.json
│   │   ├── typespec/
│   │   └── bindings/
│   ├── telemetry/
│   │   ├── semconv/
│   │   │   └── tuvren-runtime.yaml
│   │   ├── artifacts/
│   │   │   ├── semantic-conventions.md
│   │   │   └── otel-attributes.json
│   │   └── authority-packet.json
│   ├── extensions/
│   ├── interop/
│   │   ├── proto/                           # neutral .proto authority
│   │   └── authority-packet.json
│   └── conformance/
│       ├── engine/
│       │   └── plans/                       # runtime-api-*, including runtime-api-durable-
│       │                                    # reads, runtime-api-handle-terminal-value,
│       │                                    # runtime-api-schema-authoring, runtime-api-
│       │                                    # batteries-included, and (production-trust)
│       │                                    # runtime-api-execution-bounds check sets
│       ├── kernel/
│       │   └── plans/
│       ├── providers/
│       │   ├── fixtures/                    # includes secret-isolation-fixtures.json
│       │   └── plans/
│       ├── runners/
│       │   └── plans/                       # react-runner-*
│       ├── streaming/
│       │   └── plans/                       # event-stream-*
│       ├── telemetry/
│       │   └── plans/                       # framework-operational-telemetry,
│       │                                    # invocation-lifecycle-observation
│       ├── tools/
│       │   └── plans/                       # tool-contracts-extended, providers-mcp-client,
│       │                                    # capability-policy, tuvren-*-execution-class,
│       │                                    # secret-isolation check sets
│       ├── interop/
│       │   └── rust-kernel/
│       └── schemas/
├── typescript/                              # all TypeScript packages
│   ├── core/                                # @tuvren/core (ADR-0037 consolidation target)
│   │   └── src/
│   │       ├── index.ts                     # root export (errors, primitive types)
│   │       ├── messages/
│   │       ├── tools/                       # includes defineTool, FlexibleSchema, asSchema,
│   │       │                                # jsonSchema, zodSchema, standardSchema
│   │       ├── capabilities/                # ADR-0046: ToolSurface, Capability, ExecutionClass,
│   │       │                                # Binding, Endpoint, CapabilityObservation, policy +
│   │       │                                # invocation-attribution shapes
│   │       ├── events/
│   │       ├── errors/
│   │       ├── execution/                   # includes ExecutionHandle.awaitResult,
│   │       │                                # ExecutionResult, OrchestrationResult, and the
│   │       │                                # five TuvrenRuntime durable-read methods
│   │       ├── runner/                      # formerly driver/ (M6 rename); RuntimeRunner,
│   │       │                                # RunnerRegistry, RunnerExecutionResult, etc.
│   │       ├── provider/
│   │       ├── extensions/
│   │       └── telemetry/                   # ADR-0042: TuvrenTelemetrySink + telemetry record types;
│   │                                        # ADR-0058 adds TelemetryDestination (funnel-routing contract)
│   ├── runtime/                             # @tuvren/runtime (ADR-0040, demoted per ADR-0057):
│   │                                        # internal engine package consumed via @tuvren/sdk;
│   │                                        # not host-facing, excluded from the stable-core guarantee;
│   │                                        # src/lib/ absorbs the former runtime-core package
│   │   └── src/lib/
│   ├── sdk/                                 # @tuvren/sdk (ADR-0057): the slim convenience/composition
│   │                                        # tier — createTuvren + curated re-exports + schema/codec
│   │                                        # helpers; peer-deps @tuvren/core, deps @tuvren/runtime +
│   │                                        # @tuvren/kernel-protocol + @tuvren/kernel-runtime;
│   │                                        # zero backend/runner/provider dependencies. The opt-in
│   │                                        # ./advanced subpath (ADR-0059) re-exports the low-level
│   │                                        # composition factories (createOrchestrationRuntime,
│   │                                        # createRunnerRegistry, createTuvrenRuntime,
│   │                                        # createRuntimeKernel) for advanced hosts
│   ├── kernel/
│   │   ├── protocol/                        # @tuvren/kernel-protocol; kernel-types.ts lives at
│   │   │                                    # src/lib/kernel-types.ts and is NOT absorbed into
│   │   │                                    # @tuvren/core/execution by ADR-0037
│   │   ├── runtime/                         # @tuvren/kernel-runtime
│   │   ├── grpc-client/                     # @tuvren/kernel-grpc-client (ADR-0059): host-facing
│   │   │                                    # kernel-transport leaf owning createGrpcRuntimeKernel +
│   │   │                                    # the kernel-interop generated bindings/codec relocated
│   │   │                                    # out of @tuvren/runtime
│   │   ├── backends/
│   │   │   ├── memory/
│   │   │   ├── sqlite/
│   │   │   └── postgres/
│   │   ├── testkit/                         # kernel testkit; owns createFaultInjectingBackend (ADR-0045)
│   │   ├── conformance-adapter/
│   │   ├── certification/
│   │   ├── certification-sqlite/
│   │   └── certification-postgres/
│   ├── providers/
│   │   ├── provider-api/                    # NOTE: provider-api is a separate leaf package
│   │   │                                    # (peer-depends on @tuvren/core per ADR-0037);
│   │   │                                    # the @tuvren/core/provider subpath absorbs the
│   │   │                                    # provider-facing types formerly in @tuvren/runtime-api,
│   │   │                                    # NOT the provider-api contract itself
│   │   ├── bridge-ai-sdk/                   # @tuvren/provider-bridge-ai-sdk
│   │   ├── testkit/                         # includes mock MCP server harness
│   │   ├── conformance-adapter/
│   │   └── certification/
│   ├── tools/
│   │   └── mcp-client/                      # @tuvren/mcp-client (ADR-0039)
│   ├── runners/
│   │   └── react/                           # @tuvren/runner-react; peerDep @tuvren/core
│   │                                        # (renamed from @tuvren/driver-react at M6)
│   ├── streaming/
│   │   ├── core/                            # peerDep @tuvren/core
│   │   ├── sse/                             # peerDep @tuvren/core
│   │   ├── agui/                            # peerDep @tuvren/core
│   │   └── ws/                              # @tuvren/stream-ws; peerDep @tuvren/core
│   ├── telemetry/
│   │   ├── semconv/
│   │   └── otel/                            # @tuvren/telemetry-otel (ADR-0042); peerDep @tuvren/core
│   ├── host/
│   │   └── repl/                            # @tuvren/repl-host; sole proving host
│   │                                        # (per ADR-0041 playground/ is retired; the
│   │                                        # deletion is complete in repo reality)
│   ├── testkit/                             # shared framework testkit (@tuvren/framework-testkit),
│   │                                        # top-level rather than per-area
│   ├── conformance-adapter/
│   └── certification/
├── rust/                                    # Rust packages
│   ├── kernel/
│   ├── kernel-grpc-service/
│   ├── kernel-certification/
│   ├── kernel-conformance-adapter/
│   ├── conformance-adapter/
│   └── certification/
├── go.work                 # Go workspace root (kernel-port line)
├── go/                                      # Go modules (flat, one module per unit)
│   ├── kernel/
│   ├── kernel-conformance-adapter/
│   └── kernel-certification/
├── pyproject.toml          # uv virtual workspace root (kernel-port line)
├── uv.lock
├── python/                                  # Python uv workspace members
│   ├── kernel/
│   ├── kernel-conformance-adapter/
│   └── kernel-certification/
├── pubspec.yaml             # Dart pub workspace root (kernel-port line)
├── pubspec.lock
├── dart/                                    # Dart pub workspace members
│   ├── kernel/
│   ├── kernel-conformance-adapter/
│   └── kernel-certification/
└── tests/                                    # transitional until normative assets are migrated
```

Every neutral `spec/<port>/` root carries language-neutral assets (`typespec/`,
`bindings/`, `artifacts/`, `README.md`) and each language implementation lives
in the sibling language-specific root: `typescript/<area>/` or `rust/<area>/`.
A surface that has not yet authored a neutral source still keeps its
TypeScript implementation under `typescript/<area>/`, and its `spec/<port>/`
directory remains a placeholder until a later epic authors the neutral
source. Testkits live under `typescript/<area>/testkit/` (or the shared
`typescript/testkit/` for the cross-cutting framework testkit) rather than
under `spec/`, because a testkit is always language-specific harness code over
the language-neutral `spec/conformance/<port>/` assets.

Per ADR-0026, every contract surface that has crossed Epic Y promotion also
carries one Authority Packet manifest at
`spec/<port>/authority-packet.json` (or `spec/<port>/<subport>/authority-packet.json`
for nested ports such as `spec/tools/mcp/`, or the equivalent path under
`spec/conformance/<port>/` for behavior- or interop-rooted packets). Per Epic
Y, conformance plans for a port live under `spec/conformance/<port>/plans/`;
the shared semantic conformance engine lives at `tools/conformance/harness/run.ts`; the
implementation adapter protocol lives under
`tools/conformance/adapter-protocol/`; and the authority-packet and
conformance-plan JSON Schemas live under `tools/schemas/`.

### 5.1.1 Structure Rules

- The repository is architecture-first and language-neutral at the top level.
- `spec/` is the universal home for language-neutral authority: contract, conformance, and interop assets organized by port (`core`, `kernel`, `host`, `providers`, `tools`, `runners`, `streaming`, `telemetry`, `extensions`, `interop`, plus `spec/conformance/<port>/`).
- Top-level directories outside `spec/`, `typescript/`, `rust/`, `go/`, `python/`, and `dart/` are reserved for global human authority (`docs/`, `.constitution/`), repo-global tooling (`tools/`), root workspace files, and generated reports (`reports/`).
- The current repo-root `tests/` tree is a deliberate transitional exception to that top-level posture until its normative assets are migrated into port-owned `spec/conformance/<port>/` trees.
- Each port owns its own neutral authority tree under `spec/<port>/` (and `spec/conformance/<port>/` for conformance plans, fixtures, and scenarios) when those concerns exist for that port; implementation code for the same port lives under `typescript/<area>/`, `rust/<area>/`, `go/<area>/`, `python/<area>/`, and/or `dart/<area>/`.
- Language-specific code lives under `typescript/<area>/...`, `rust/<area>/...`, `go/<area>/...`, `python/<area>/...`, or `dart/<area>/...`, and any checked-in generated language bindings belong under the consuming implementation tree rather than a shared root generated directory.
- Per ADR-0022, every directory is either language-neutral (under `spec/`) or language-specific (exclusively under `typescript/<area>/...`, `rust/<area>/...`, `go/<area>/...`, `python/<area>/...`, or `dart/<area>/...`). The Go line uses flat per-module directories registered in the root `go.work`; the Python line uses uv workspace members of the root `pyproject.toml` (pinned by `uv.lock`); the Dart line uses pub workspace members of the root `pubspec.yaml` (pinned by the committed `pubspec.lock`) — native workspace files at the repo root own dependency truth for their language, exactly as `Cargo.toml` does for Rust. No language-specific build manifest, source directory, or generated binding may live at a `spec/<port>/` or `spec/conformance/<port>/` root. This rule covers `package.json`, `Cargo.toml`, `tsup.config.ts`, `tsconfig*.json`, `src/`, `dist/`, `test/`, `bench/`, `smoke/`, `node_modules/`, `target/`, and any other language-tooling output. Testkits live under `typescript/<area>/testkit/` (or the shared `typescript/testkit/`), never at a `spec/` root.
- Nx manages orchestration and target naming. Nx does not define the repo ontology and must delegate actual work to the native toolchain for the language or artifact family involved.
- The consolidated `@tuvren/core` package (`typescript/core/`, neutral authority at `spec/core/`) must remain the single home for truly cross-boundary primitives. It must not become a semantic dumping ground or a backdoor TypeScript convenience layer.
- Contract-driven components such as backends, provider surfaces, runner contracts, tool contracts, event vocabulary, conformance suites, and interop seams must have an explicit port-owned home under `spec/<port>/` before any new implementation package is added.
- `spec/core/authority-packet.json` is the machine authority entry for shared framework runtime contracts (this single packet is the ADR-0037 / Epic AP consolidation target; the former split `runtime-api`, `event-stream`, `tool-contracts`, and `driver-api` authority packets are absorbed into it). All ten subpath surfaces (`/messages`, `/tools`, `/events`, `/errors`, `/execution`, `/runner`, `/provider`, `/extensions`, `/telemetry`, `/capabilities`) are declared as binding sections within this single packet. The deprecated split packages (including `@tuvren/core-types`, removed at KRT-BM006) have all completed their one-cycle compatibility window and no longer exist in the workspace.
- Where a stable language-neutral structure exists, TypeScript adopts it first so later languages inherit a real system rather than a permanent TypeScript exception.
- Per ADR-0023, ADR-0024, ADR-0025, ADR-0026, ADR-0027, and ADR-0028, every cross-implementation semantic surface must own one Authority Packet manifest declaring its authoritative sources, generated artifacts, conformance plans, binding projections, and forbidden authority sources. Implementation-language source trees, generic conformance runner source, and Markdown documents are forbidden authority sources for any cross-implementation semantic; they may project, validate, or describe authority but cannot become it. Generic runners must own only generic mechanics and consume product semantics from conformance plans referenced by an authority packet.
- Per the final Epic Y conformance-engine adjustment, implementation language trees may host `conformance-adapter/` code that invokes native logic and returns neutral observations. Assertion evaluation, required-evidence enforcement, capability selection, adapter-error isolation, and compatibility evidence emission belong in the shared conformance engine under `tools/conformance/harness/`, not in language adapter hosts.
- Per Epic AG, promoted conformance adapters must expose raw `result`, `events`, and `state` observations and may expose diagnostic/provenance `evidence`; they must not expose semantic verdict proxies through evidence, import semantic verifier/assertion helpers, or depend on implementation-local `/test/` harnesses as the main proof path unless a testkit contract explicitly allows it.

### 5.2 Coding Standards

- **Formatting / Linting:** Use Biome configured to follow the repository’s Ultracite-aligned standards.
- **Workspace Tooling:** Use `devenv` for reproducible developer environments and `nx@22.6.3` with aligned `@nx/*` packages for project orchestration, affected-graph analysis, caching, generators, and task coordination across the TypeScript subtree. Canonical repo-wide target names are `build`, `test`, `lint`, `typecheck`, `conformance`, `codegen`, `interop-smoke`, and later `bench` where benchmarking becomes a first-class concern.
- **Build Tooling:** Use `tsup` for TypeScript package builds. Core packages emit ESM-first builds and do not publish JavaScript sourcemaps or TypeScript declaration maps by default.
- **Contract / Artifact Rules:**
  - TypeSpec emits JSON Schema 2020-12 and OpenAPI artifacts only from boundary-owned contract packages that have explicitly promoted TypeSpec to the authored source.
  - Kernel record grammar is authored in CDDL and validated separately from runtime behavior.
  - `.proto` definitions lint, generate, and run breaking-change checks through Buf once the interop surface exists, with Buf `FILE` compatibility as the default breaking gate.
  - JSON conformance fixtures are reviewed like code and validated by boundary-owned fixture schemas.
- **TypeScript Settings:**
  - `"strict": true`
  - `"module": "esnext"`
  - `"moduleResolution": "bundler"`
  - `"target": "esnext"`
  - explicit `"rootDir"` per package
  - explicit `"types"` arrays where runtime globals are required
- **Kernel Encoding Rules:**
  - deterministic CBOR only for structured kernel records
  - lowercase hex SHA-256 digests only for canonical hash strings
  - no floating-point values in normative kernel records
  - timestamps are safe-integer epoch milliseconds
- **Testing Expectations:**
  - unit tests for pure logic in `typescript/core` (the consolidated `@tuvren/core` package per ADR-0037), `typescript/kernel/protocol`, `typescript/kernel/backends/memory`, `typescript/kernel/backends/sqlite`, `typescript/kernel/backends/postgres`, `typescript/runtime` (the internal engine package per ADR-0040/ADR-0057), `typescript/sdk` (the composition tier per ADR-0057), `typescript/runners/react`, and `typescript/tools/mcp-client` (per ADR-0039)
  - unit tests for the Schema Authoring Helper detection precedence (per ADR-0038) covering at least: wrapped schema branch, Zod v4 branch, Zod v3 via Standard Schema branch, Standard Schema non-zod branch, lazy function branch, and bare TuvrenJsonSchema branch, plus the ambiguous-case fixtures named in ADR-0038
  - unit tests for the `createTuvren` batteries-included composition across constructed instances of all three official backends and the `aimock-openai` provider (per ADR-0057 the string-kind shorthands are retired; the composition tests pass constructed backend/runner instances)
  - unit tests for transcript JSONL writer/reader round-trips covering every record kind in §3.9
  - unit tests for durable-read cursor encode/decode round-trips and rejection of malformed cursors
  - golden-byte tests for deterministic CBOR encodings
  - hash identity fixtures for opaque bytes and structured records
  - shared backend contract tests that every official backend must pass
  - recovery and checkpoint scenario tests covering pause/resume, reactive checkpointing, and rollback archival
  - runner contract and framework-runtime integration tests that keep shared framework services distinct from ReAct-specific behavior
  - AI SDK bridge contract tests
  - a shared semantic conformance runner that consumes port-owned plans and drives implementation-language adapter hosts without redefining semantics locally
  - compatibility-matrix generation from actual conformance and interop-smoke results
  - runtime portability tests for core packages on Bun and Node; Deno compatibility tests for core non-native packages as soon as package surfaces stabilize
  - per ADR-0042, operational-telemetry tests that drive a deterministic turn and assert the expected lineage-keyed spans/events for turn, iteration, model, tool, checkpoint, approval transitions, and error paths through an in-memory capture sink, plus a targeted restart/recovery fixture for recovery telemetry and an implementation-specific `@tuvren/telemetry-otel` mapping test
  - per ADR-0043, execution-bounds tests asserting that exceeding the hard-stop bounds (`maxIterations`, `maxToolCalls`, `maxWallClockMs`) yields a `failed` result with code `execution_bound_exceeded` and correct `details`, that the canonical stream emits the matching fatal `error` event before the failed terminal `turn.end`, that a configured capture sink observes the `execution.bounded` telemetry event for each hard-stop breach, that `AgentConfig.maxIterations` is clamped by `bounds.maxIterations`, that `maxConcurrentToolCalls` is enforced by throttling tool concurrency to the configured cap, that `AgentConfig.maxParallelToolCalls` and `defaultMaxParallelToolCalls` are clamped by that cap rather than bypassing it, that invalid non-finite or non-positive bound configuration is rejected, and that within-bounds turns are unaffected, using a runaway aimock runner fixture
  - per ADR-0044, secret-isolation tests asserting through a shared runner-owned secret-absence helper that a configured provider key plus MCP bearer-auth and header-auth secrets, along with common encoded variants, never appear in persisted kernel records, captured canonical stream events, captured telemetry attributes or error summaries, or a recorded transcript
  - per ADR-0045, crash-recovery tests using `createFaultInjectingBackend` that inject faults at each commit point and under a concurrent writer, asserting resume-or-fail-clean with no torn or partial lineage across the SQLite and PostgreSQL backends
- **Observability Hooks:**
  - structured logger interface injected at runtime boundaries
  - event tee support for tests and host adapters
  - stable metric names for turn count, iteration count, provider latency, tool latency, checkpoint count, and recovery count
  - `telemetry/semconv/tuvren-runtime.yaml` is the authored OpenTelemetry semantic-convention source for current and future implementation lines
  - reviewed outputs such as `telemetry/semantic-conventions.md` and `telemetry/otel-attributes.json` are derived from that source
  - generated TypeScript and Rust constants or helpers derived from the telemetry semantic-convention source belong under the consuming implementation trees, not under a shared root generated directory
  - OpenTelemetry attribute conventions cover run id, turn id, branch id, runner id, tool call id, checkpoint hash, parent checkpoint hash, resumed-from hash, backend id, and provider id
  - per ADR-0042, the runtime emits to a first-class `TuvrenTelemetrySink` (`@tuvren/core/telemetry`) at turn/run/iteration/model/tool/checkpoint/recovery/bounded-execution/error points, reusing the canonical event vocabulary so telemetry and the event stream cannot diverge; the default sink is `NoopTelemetrySink` and the OpenTelemetry projection lives in the implementation-specific `@tuvren/telemetry-otel`
  - per ADR-0044, no secret material may reach the canonical event stream, telemetry sink, durable kernel records, or transcripts; host-supplied telemetry attributes pass through a semconv allowlist, telemetry error summaries are sanitized before emission, and transcript headers redact backend credential fields
- **Migration / Deployment Notes:**
  - `kernel/implementations/typescript/backend-memory` has no persisted migration surface
  - `kernel/implementations/typescript/backend-sqlite` ships forward-only SQL migrations
  - `kernel/implementations/typescript/backend-postgres` owns backend-local schema initialization, forward-only migration tracking, and snapshot payload versioning inside PostgreSQL
  - the first SQLite backend implementation is Node.js-first because it depends on `better-sqlite3@12.8.0`
  - future backends own their own physical migration story
  - no runtime may silently weaken backend guarantees below the kernel contract
- **Performance / Capacity Notes:**
  - `ContextManifest` exists to avoid repeated full-history scans
  - ordered-path chunking is an internal optimization and must remain protocol-invisible
  - provider bridges must keep provider-specific details out of core hot paths

### 5.3 Documentation Drift Prevention

- `docs/KrakenKernelSpecification.md` and `docs/KrakenFrameworkSpecification.md` remain the authoritative behavioral sources that this TechSpec realizes physically.
- `.constitution/prd/`, `.constitution/architecture/`, `.constitution/tech-spec/`, and `.constitution/tasks/` remain the governing artifacts for product, logical architecture, technical implementation posture, and execution posture.
- Generated live support artifacts such as the Epic AD docs-to-authority coverage matrix and the Epic AF gap-plan outputs live under `.constitution/reports/`. They are checked-in support inputs for docs portability classification and freshness verification, not additions to the four-document authority chain.
- Historical constitutional support material that no longer drives forward execution lives under `.constitution/archived/` and remains historical context only.
- Changes to provider posture, backend posture, record encoding, hash algorithm, or public framework contracts require a TechSpec update in the same change.
- Changes that alter the runner model, runner-neutral framework surface, or the ReAct Runner’s role as the initial baseline require a TechSpec update in the same change.
- New backend adapters require updates to backend conformance documentation and compatibility notes.
- Changes that promote or revise boundary-owned contract, conformance, interop, telemetry, or compatibility-ledger authority require TechSpec updates in the same change.
- Normative claims in `docs/KrakenFrameworkSpecification.md` and `docs/KrakenKernelSpecification.md` must be inventoried and classified in a checked-in docs-to-authority coverage matrix before a future framework implementation line is activated.
- Any claim that remains implementation-defined, explicitly deferred, stale, or backed only by implementation-local evidence must be labeled at the nearest relevant docs or constitution section rather than implied as portable.
- When a shared contract adds a host-owned control or policy seam, the baseline ReAct/runtime path must either wire it through in the same change or document the limitation explicitly in `docs/` and `.constitution/`.
- Adding, removing, or changing an Authority Packet manifest, a referenced Conformance Plan, a generated artifact declared in a manifest, the Compatibility Ledger Contract, or the Implementation Adapter Protocol requires a TechSpec update in the same change. ADR-0023 through ADR-0033 are not advisory: a future contributor may not satisfy a cross-implementation semantic claim by editing implementation source, runner source, adapter evidence, or Markdown alone.
- `bun run codegen` and `bun run verify` must reject promoted evidence-only checks; `schemaValid` over `$.evidence` as the only decisive-looking assertion; `noEvent` over adapter evidence arrays; raw compatibility evidence with `status: "pass"` and `applicableChecks: 0`; promoted adapter imports of implementation-local `/test/` harnesses unless explicitly allowed by a boundary-owned testkit contract; promoted adapter imports of semantic verifier/assertion helpers; and measurable closure claims that are not generated from live checks.
- Freeze-readiness or future implementation-line activation claims require fresh `bun run verify`, `bun run release-check`, `bun run conformance`, `bun run codegen`, and `bun run interop-smoke` evidence from a clean checkout, plus refreshed compatibility evidence and proving-host validation wired into the canonical verification path with cited affected check IDs.

### 5.4 Initial Build Sequence

1. Treat Epics A-AG and related closure inventories as historical context under `.constitution/archived/`, not as the active implementation posture, so live authority paths stay narrow and trustworthy.
2. Reconfirm the live authority chain: `docs/` carries timeless runtime semantics; `.constitution/prd/`, `.constitution/architecture/`, `.constitution/tech-spec/`, and `.constitution/tasks/` carry live planning and execution posture; `.constitution/reports/` holds generated support inputs without becoming authority; `.constitution/` routes contributors to that chain without becoming a fifth authority source; archived material is historical only.
3. Expand the TypeScript line from “promoted subset is green” to “full product line is being proven”: keep conformance hardening active by subsystem while product work proceeds, but stop treating the AG subset as the whole readiness story.
4. Normalize TypeScript package naming and topology immediately before the serious REPL host build so the lived host-building experience, rather than historical package accidents, determines the curated public SDK surface.
5. Build the serious REPL host entirely on the intended high-level SDK surface. The proving host must exercise durable threads and branches, streaming, steering, approvals, orchestration, extensions, structured output, and SQLite-backed reload without private runtime shortcuts, and its automated evidence must become the decisive `product proof gate` in the canonical verification path.
6. `@tuvren/backend-postgres` now stands beside SQLite as an official backend and remains part of the `platform gate`; its conformance and proving-host lanes stay wired into the canonical verification path rather than becoming optional follow-up work.
7. Close the `portability gate` by promoting the intended portable surface into packet/plan/runner-owned evidence under fresh checks, wiring that evidence into the canonical verification path, keeping canonical stream plus SSE portable, and allowing AG-UI plus the TypeScript AI SDK bridge implementation to remain the main implementation-specific exceptions. Epic AL closed this step in current repo reality; `tools/scripts/portability-gate.ts` is now the decisive portability proxy enforced by `bun run verify`.
8. Only after `product proof gate`, `platform gate`, and `portability gate` all pass may Rust framework/product work resume. Per the KRT-AL003 re-entry reassessment at `.constitution/reports/epic-al-rust-re-entry-gate-reassessment.md`, all three gates currently pass under fresh canonical-lane evidence; the resumption itself requires a new epic that explicitly reopens that scope.

### 5.4.1 ReAct and Multilanguage Epic Partition Status

- Historical epic closure detail from Epics A-AG remains useful audit context, but it no longer belongs in the live forward-execution path once archive migration is complete.
- The active forward path through TypeScript product proof, TypeScript platform completion, and portability-gate closure landed across Epics AI-AL.
- The v0.7.0 constitutional revision realized through ADR-0034 through ADR-0041 (Epics AM-AT) is closed in repository reality.
- The v0.8.0 production-trust revision realized through ADR-0042 through ADR-0045 remains the active forward path. Epic AU (fault-injection-verified crash recovery) is closed in repository reality; Epics AV and AW remain active in `Tasks.md`.
- Rust framework/product work, future provider-family expansion beyond MCP-as-tool-source, future host protocols, additional official backends, and future runner families remain blocked until a new epic explicitly reopens that scope and re-satisfies the staged gates in `5.4` under fresh evidence. The production-trust block does not reopen any of those lines; it hardens the existing TypeScript line.

### 5.5 Migration Plans for the v0.27.0 Revision

This section consolidates the bounded migration actions implied by ADR-0034 through ADR-0041. Each migration is in scope for one or more execution epics specified in `Tasks.md`; this section names what must be done and in what order, not who does it or when.

#### 5.5.1 Kernel Syscall Addition (ADR-0034)

Order within one epic:
1. Bump `docs/KrakenKernelSpecification.md` to v0.10. Correct every "28 operations" mention to "30 operations." Add a new `thread.list` syscall section with full validation rules, the `KernelThreadListCursor` shape, and the `thread.enumeration` capability gate.
2. Update `spec/kernel/authority-packet.json` to declare the new syscall surface and bump its packet version.
3. Add `thread.list` to the TypeScript `RuntimeKernel` interface in `typescript/kernel/protocol/src/lib/kernel-types.ts`. This file lives in `@tuvren/kernel-protocol` — it is NOT absorbed into `@tuvren/core/execution` by ADR-0037; kernel-protocol is outside ADR-0037's absorption list.
4. Implement `thread.list` in the in-memory backend (`typescript/kernel/backends/memory/`): trivial `Array.from(state.threads.values())` with sort by `(createdAtMs, threadId)` and cursor-based pagination.
5. Implement `thread.list` in the SQLite backend (`typescript/kernel/backends/sqlite/`): `SELECT * FROM threads WHERE (created_at_ms, thread_id) > (?, ?) [AND schema_id = ?] ORDER BY created_at_ms ASC, thread_id ASC LIMIT ?`. Add a covering index on `(created_at_ms, thread_id)`.
6. Implement `thread.list` in the PostgreSQL backend (`typescript/kernel/backends/postgres/`): identical SQL with PostgreSQL parameter binding; covering index per backend migration.
7. Update each backend's `capabilities()` accessor to return `{ "thread.enumeration": true }`.
8. Add `thread.list` to `typescript/kernel/runtime/` so the TS `RuntimeKernel` dispatches to the backend's `ThreadRepository.list` when the capability bit is true; otherwise throws `TuvrenPersistenceError` code `kernel_capability_unsupported`.
9. Add `thread_list` to the Rust `InMemoryKernel` at `rust/kernel/src/memory.rs`. Add it to the Rust capability descriptor.
10. Add `ThreadList` RPC to `spec/interop/proto/tuvren/kernel/interop/v1/kernel_services.proto`. Define `ThreadListRequest` and `ThreadListResponse` messages in `kernel_types.proto`. Run `bun run codegen` to regenerate TypeScript bindings under `typescript/runtime/src/lib/generated/kernel-interop/` (this is the current location after the ADR-0040 runtime-core fold).
11. Implement the new RPC in the Rust gRPC service at `rust/kernel-grpc-service/src/lib.rs`.
12. Add a `thread.list` codec call in the TypeScript `createGrpcRuntimeKernel` adapter.
13. Add `kernel-protocol.thread.enumeration` check set to all four kernel conformance plans (`kernel-protocol-core.json`, `kernel-protocol-extended.json`, `kernel-restart-recovery.json`, `kernel-run-liveness.json`) with per-capability applicability.
14. Run `bun run verify` from a clean checkout; capture fresh compatibility evidence.

#### 5.5.2 Handle Terminal-Value Promotion (ADR-0035)

Order within one epic (may co-execute with §5.5.1 if epic capacity allows):
1. Bump `docs/KrakenFrameworkSpecification.md` to v0.18 to add `awaitResult` to base `ExecutionHandle`.
2. Update the `ExecutionHandle` and `OrchestrationHandle` interfaces in `@tuvren/core/execution` (post-ADR-0037) to add `awaitResult` and the `ExecutionResult` / `OrchestrationResult` discriminated unions.
3. Implement `awaitResult` on `RuntimeExecutionHandle` in the runtime implementation: collect events into a private buffer (already happening for `events()`), resolve on the first `turn.end` event, synthesize the result from the final assistant message in collected events plus `status()`.
4. Implement `awaitResult` on `OrchestrationHandleImpl` to aggregate `childResults` from spawned child handles' own `awaitResult` resolutions; the existing internal `awaitResult` becomes the parent half of this.
5. Migrate the two existing `awaitResult` conformance checks from `spec/conformance/engine/plans/runtime-api-orchestration.json` to a new check set `runtime-api-handle-terminal-value` in `runtime-api-callables.json`; the orchestration plan keeps its subtree-result-specific checks.
6. Update the `@tuvren/core` authority packet binding appendix at `spec/core/bindings/typescript.md` (the ADR-0037 consolidation target for the former runtime-api binding appendix) to add `awaitResult` to the `ExecutionHandle` binding section.
7. Delete the REPL host's hand-rolled completion derivation in `startProjectionCapture`; replace with `handle.awaitResult()`.

#### 5.5.3 Durable-Read Surface (ADR-0036)

Order within one epic (must follow §5.5.1 for `thread.list` and §5.5.2 for `awaitResult`):
1. Add the five durable-read method signatures to the `TuvrenRuntime` interface in `@tuvren/core/execution`. Export the supporting types (`ThreadSummary`, `BranchSummary`, `TurnSnapshot`, all three cursor types).
2. Implement the surface in a new `durable-reads.ts` module under `typescript/runtime/src/lib/` (the ADR-0040 location; the former separate `runtime-core/src/lib/` package no longer exists):
   - `listThreads` composes `kernel.thread.list(options)`
   - `listBranches` composes `kernel.branch.list(threadId)`
   - `getTurnState` composes `kernel.branch.get` (for head fallback) + `kernel.node.get` + `kernel.tree.manifest` + `kernel.store.get` for each manifest reference relevant to the requested shape
   - `getTurnHistory` returns an async iterator that walks `kernel.node.walkBack` lazily, applying the `before` cursor and `limit` constraints
   - `readBranchMessages` composes `kernel.branch.get` + `kernel.tree.resolve(treeHash, "messages")` + `kernel.store.get` per message hash, with cursor-based pagination over the ordered messages path
3. Implement cursor encode/decode helpers per §3.8; reject malformed cursors with `TuvrenValidationError` code `invalid_durable_read_cursor`.
4. Add the `runtime-api-durable-reads` check set to `spec/conformance/engine/plans/runtime-api-callables-extended.json` with positive-path, pagination, capability-rejected (for `listThreads`), and lineage-bounded coverage. Run against all three backends; verify that the capability-rejected path is exercised against a synthetic non-enumerating backend in the framework testkit.
5. Delete `createPlaygroundKernelInspector` from `@tuvren/repl-host`; replace its three call sites (`readBranchMessages`, `readBranchStatus`, `readBranchEvents` equivalent) with `runtime.readBranchMessages` and `runtime.getTurnState`.

#### 5.5.4 Package Consolidation (ADR-0037)

Order within one epic (must be atomic — no intermediate state where some leaves are migrated and others are not):
1. Create the `typescript/core/` workspace package `@tuvren/core` with the source directory layout shown in §5.1 (`src/index.ts` + 8 subpath directories). (Realized: `typescript/core/` is the live package today.)
2. Move source from the pre-consolidation contract packages into `@tuvren/core`'s subpath directories:
   - the former `core-types` implementation source → `@tuvren/core/src/errors/` + `@tuvren/core/src/index.ts` (split error sources from primitive types); the old `@tuvren/core-types` workspace handle survived for one cycle as the deprecated shim described in step 10 and was removed at KRT-BM006
   - the former `runtime-api` implementation source → split across `@tuvren/core/src/messages/`, `@tuvren/core/src/execution/`, `@tuvren/core/src/extensions/`, `@tuvren/core/src/provider/` (using the existing internal `runtime-contract-shapes.ts` decomposition as a guide); no separate `runtime-api` implementation directory exists today
   - the former `event-stream` implementation source → `@tuvren/core/src/events/`; no separate `event-stream` implementation directory exists today
   - the former `tool-contracts` implementation source → `@tuvren/core/src/tools/`; no separate `tool-contracts` implementation directory exists today
   - the former `driver-api` implementation source → `@tuvren/core/src/runner/` (subpath renamed from `driver` to `runner` at the M6 rename); no separate `driver-api` implementation directory exists today
3. Configure `package.json` exports field with 9 entries (root + 8 subpaths), each with `import` and `types` conditions pointing at the compiled `dist/<subpath>/index.js` and `dist/<subpath>/index.d.ts`.
4. Configure `tsup.config.ts` with 9 entries; one per export.
5. Declare `zod` and `@standard-schema/spec` as optional `peerDependencies` in `@tuvren/core`'s `package.json` with `peerDependenciesMeta.<name>.optional = true`. Do not also list them as `optionalDependencies` — that would auto-install them from the registry and defeat the consumer-choice contract.
6. Merge the former `runtime-api` authority packet and the other three contract packets into the single `spec/core/authority-packet.json` declaring the eight then-current subpath surfaces as binding sections. Later work may add additional binding sections (for example ADR-0042 adds `/telemetry`). TypeSpec sources for the merged packet live at `spec/core/typespec/`.
7. Update `tools/scripts/portability-gate.ts` to expect the new packet layout (8 packets instead of 12).
8. Run one mechanical codemod across the workspace replacing imports:
   - `from "@tuvren/core-types"` → split between `from "@tuvren/core/errors"` and `from "@tuvren/core"` based on what's imported
   - `from "@tuvren/runtime-api"` → split across `from "@tuvren/core/execution"`, `from "@tuvren/core/messages"`, `from "@tuvren/core/provider"`, `from "@tuvren/core/extensions"` based on what's imported
   - `from "@tuvren/event-stream"` → `from "@tuvren/core/events"`
   - `from "@tuvren/tool-contracts"` → `from "@tuvren/core/tools"`
   - `from "@tuvren/driver-api"` → `from "@tuvren/core/runner"`
9. Replace each leaf package's `dependencies` declaration of the five retired packages with a single `peerDependencies` entry on `@tuvren/core`.
10. Leave deprecated shim packages at the old workspace handles for one cycle: `@tuvren/core-types`, `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, `@tuvren/driver-api` each contain only an `index.ts` that re-exports from `@tuvren/core/*` with a development-mode `console.warn`. All five have since been fully removed; `@tuvren/core-types` (`typescript/core-types/`) was the last, deleted at KRT-BM006 after its window elapsed.
11. Fold `@tuvren/runtime-core` into `@tuvren/runtime`: move source from the former `runtime-core/src/` package into `typescript/runtime/src/lib/` (replacing the current thin barrel). The `@tuvren/runtime` package becomes the slim convenience package per ADR-0040. (Realized: `typescript/runtime/src/lib/` is the live location; the separate `runtime-core` package no longer exists.)
12. Run `bun install`, `bun run typecheck`, `bun run lint`, `bun run test`, `bun run conformance`, `bun run codegen`, `bun run verify` from a clean checkout; everything must pass before merge.

#### 5.5.5 Schema Authoring Helper (ADR-0038)

Order within one epic (must follow §5.5.4):
1. In `@tuvren/core/tools`, add the `Schema<T>` branded type, `schemaSymbol`, `FlexibleSchema<INPUT>` union, `ZodSchema<T>`, `StandardSchema<T>`, `LazySchema<T>` type exports.
2. Implement `asSchema<T>(schema: FlexibleSchema<T>): Schema<T>` with the six-branch precedence from ADR-0038. Borrow the detection logic from the AI SDK source's `asSchema` (BSD-3 license-compatible re-implementation; do not copy the source).
3. Implement `jsonSchema<T>(schema, opts?)`, `zodSchema<T>(schema)`, `standardSchema<T>(schema)`.
4. Implement `defineTool({...})` which normalizes the `inputSchema` once via `asSchema` and returns a `TuvrenToolDefinition` with the normalized schema in `inputSchema`.
5. Add `runtime-api-schema-authoring` check set to `spec/conformance/engine/plans/runtime-api-callables-extended.json` with at least one fixture per precedence branch including the ambiguous cases listed in ADR-0038.
6. Re-export `defineTool`, `asSchema`, `jsonSchema`, `zodSchema`, `standardSchema` from `@tuvren/runtime`'s curated re-exports.

#### 5.5.6 MCP Client Container (ADR-0039)

Order within one epic (may co-execute with §5.5.5):
1. Create new workspace package `@tuvren/mcp-client` under `typescript/tools/mcp-client/`.
2. Declare direct dependencies on `@modelcontextprotocol/sdk@1.29.0` and `zod@4.4.3`, plus a peer dependency on `@tuvren/core`; do not expose `zod` in the public Tuvren peer surface.
3. Implement the internal `MCPClient` interface wrapping the upstream SDK client with one connection-lifecycle surface over both stdio and Streamable HTTP-backed public `http-sse` transports.
4. Implement `createMcpToolSource(options)` and `McpToolSource` per §4.15.
5. Implement the seven translation rules from ADR-0039.
6. Create the authority packet at `spec/tools/mcp/authority-packet.json` declaring the translation contract.
7. Create the `providers-mcp-client.json` conformance plan exercising the translation rules and transport-error normalization. Exercise both transports against the same scenario set.
8. Add a mock MCP server to `@tuvren/provider-testkit` for use in the conformance plan and downstream host tests.
9. Re-export `createMcpToolSource` from `@tuvren/runtime`'s curated re-exports.

#### 5.5.7 Batteries-Included Composition (ADR-0040)

Order within one epic (must follow §5.5.4; §5.5.6 / MCP runs after, not before):
1. Implement `createTuvren(options)` in `@tuvren/runtime`'s root `index.ts` per §4.16.
2. Rename the internal `createTuvrenRuntimeCore` to `createTuvrenRuntime`; export the latter from `@tuvren/runtime`'s curated re-exports along with `createTuvren`.
3. Implement the resource cleanup paths so `[Symbol.asyncDispose]` closes MCP sources, releases backend handles, and drains kernel work.
4. Add the `runtime-api-batteries-included` check set to `runtime-api-callables-extended.json` exercising compositional correctness across all three backend kinds and the `aimock-openai` provider.

#### 5.5.8 Reference Host Consolidation (ADR-0041)

Order within one epic (must follow §5.5.3 to remove the kernel inspector, §5.5.5–§5.5.7 to consume the new helpers):
1. Delete the former `hosts/implementations/typescript/playground/` package entirely, along with the `@tuvren/playground-host` workspace package, and remove all references in Nx targets, `package.json` workspace scripts, and `tools/scripts/`. (Realized: this deletion is complete in repo reality; `@tuvren/playground-host` and its directory no longer exist anywhere in the repository.)
2. Rename internal files in `@tuvren/repl-host` per ADR-0041: `playground-config.ts` → `repl-config.ts`, `playground-host.ts` → `repl-host.ts`, `playground-kernel.ts` → **deleted**, `playground-matrix.ts` → `repl-scenario-matrix.ts`, `playground-provider.ts` → `repl-provider.ts`, `playground-scenarios-support.ts` → `repl-scenarios-support.ts`, `playground-scenarios.ts` → `repl-scenarios.ts`, `playground-tools.ts` → `repl-builtin-tools.ts`, `playground-types.ts` → `repl-types.ts`. Rename all internal type names (`PlaygroundConfig` → `ReplConfig`, etc.); the existing public alias barrel in `src/index.ts` becomes the actual definitions.
3. Replace all reads through the deleted `createPlaygroundKernelInspector` with calls to `runtime.readBranchMessages` and `runtime.getTurnState` (already enabled by §5.5.3).
4. Add `repl-headless-mode.ts` implementing the headless stdin loop per §4.17 and ADR-0041.
5. Add `repl-transcript.ts` implementing the JSONL writer/reader per §3.9.
6. Update `cli.ts` to parse `--headless`, `--record <path>`, `--replay <path>` flags.
7. Add the `proving-host-headless-transcript-replay` check set to `runtime-api-callables-extended.json` exercising a deterministic record-and-replay cycle.
8. Update `proving-host:scenario-*` Nx targets to exercise both interactive and headless modes against the same scenarios.

### 5.6 Migration Plans for the v0.28.0 Production-Trust Revision

This section consolidates the bounded migration actions implied by ADR-0042 through ADR-0045. Epics AU, AV, and BD are all complete and are retained below as current-state closure context (ADR-0045, ADR-0042, and ADR-0043/ADR-0044 respectively). Epic BD (formerly Epic AW) realized framework-enforced execution bounds and secret isolation across the framework runtime and independently verified that approval gates are non-bypassable and untrusted MCP/tool inputs are validated before execution; with its closure the active execution plan in `Tasks.md` is empty. The telemetry secret-screening helpers from §5.6.3 had already landed because the closed telemetry sink (§5.6.2) consumes them.

#### 5.6.1 Recovery and Durability Verification (ADR-0045, Epic AU)

Closed outcome:
1. Added `createFaultInjectingBackend(inner, plan)` and the `FaultPlan` type (§3.12) to `@tuvren/kernel-testkit`, with test-only commit-phase hooks for true `mid-commit` injection on the supported durable backends and checks that no production package imports the seam.
2. Added the `kernel-crash-recovery` check set to `spec/conformance/kernel/plans/kernel-restart-recovery.json` with per-capability applicability: durable-restart subset for SQLite/PostgreSQL, in-process atomicity + concurrency subset for memory.
3. Recorded the new check set in the kernel authority packet at `spec/kernel/authority-packet.json` and bumped its packet version.
4. Ran the strengthened plan against memory, SQLite, and PostgreSQL. No storage atomicity bug was exposed in the official TypeScript backends; the validation-path drift exposed by the run was corrected without weakening the conformance plan.
5. Added a normative "Crash Recovery Invariant" note to `docs/KrakenKernelSpecification.md` stating the resume-or-fail-clean guarantee the plan verifies.
6. Refreshed checked-in compatibility evidence for the strengthened crash-recovery results.

#### 5.6.2 Operational Telemetry Surface (ADR-0042, Epic AV)

Closed outcome:
1. Added the `./telemetry` subpath to `@tuvren/core` with `TuvrenTelemetrySink`, `TelemetrySpan`, `TelemetryEvent`, `TelemetryLineage`, `TelemetrySpanKind`, `TelemetryEventKind`, and `NoopTelemetrySink`; generated the telemetry JSON schemas; and bumped the shared core authority packet with the telemetry binding section.
2. Wired `@tuvren/runtime` emission through a host-owned sink at the runtime's existing turn, iteration, model, tool, checkpoint, approval, and error producers. Throwing sinks are isolated and warned once. `CreateTuvrenOptions` and `RuntimeCoreOptions` accept `telemetry?: TuvrenTelemetrySink`, with duplicate top-level/nested configuration rejected as `invalid_createtuvren_options`.
3. Added the telemetry attribute allowlist and telemetry-error sanitizer from §5.6.3 before records reach the sink.
4. Created `@tuvren/telemetry-otel` under `typescript/telemetry/otel/`, peer-depending on `@tuvren/core`, with exact `@opentelemetry/api@1.9.1` and `@opentelemetry/sdk-trace-base@2.7.1` test dependency pins.
5. Added the `framework-operational-telemetry.json` plan (check set `runtime-api-operational-telemetry`), in-memory capture support in the framework testkit, and authority-packet discovery for the plan.
6. Re-exported `NoopTelemetrySink` plus the telemetry record types from `@tuvren/runtime`; registered the OTel projection as a standing implementation-specific portability exception in the live JSON/Markdown inventory.

#### 5.6.3 Secret Isolation (ADR-0044, Epic BD; allowlist consumed by AV)

Closed outcome:
1. Closed earlier with Epic AV: added the telemetry attribute allowlist helper (keys declared in `telemetry/semconv/tuvren-runtime.yaml` only; reject credential-shaped keys and drop or sanitize secret-like values on otherwise allowed keys) and the telemetry-error-summary sanitizer consumed by §5.6.2 step 3. If a future operational telemetry attribute is required (for example bounded-execution `bound` / `limit` / `observed`), update that semconv source in the same change before the allowlist admits it.
2. KRT-BD002: added the backend-options redactor and non-secret backend identity descriptor to `@tuvren/repl-host`'s `repl-transcript.ts`; the transcript header masks PostgreSQL `connectionString` / `password` and any credential-shaped backend option (libpq and cloud aliases included) to `"***"` while retaining non-secret identity sufficient for replay topology (§3.9 constraint, format `v: 1` compatible). Replay reconstructs the backend from non-secret options plus environment-supplied credentials; a transcript recorded before redaction remains replayable.
3. KRT-BD003: documented edge-confinement in the `@tuvren/mcp-client` and `@tuvren/provider-bridge-ai-sdk` READMEs and staged reusable secret-isolation fixtures (representative provider key plus MCP bearer-auth and header-auth values) under `spec/conformance/providers/fixtures/` for the BD004 absence checks.
4. KRT-BD004: added the `secret-isolation` check set to `providers-mcp-client.json`, `framework-operational-telemetry.json`, and `runtime-api-callables-extended.json`. A fixture configures a provider key plus MCP bearer-auth and header-auth secrets and runs a turn; a new shared runner-owned secret-absence helper (`tools/conformance/harness/secret-absence/`, exposed through the `secretAbsence` assertion kind) recursively scans the raw observation surfaces and asserts that neither the raw secrets nor their common derived leak forms — bearer-prefixed, header-normalized, URL-encoded, base64/base64url-encoded, and partial-token — appear in persisted kernel records, captured canonical stream events, captured telemetry attributes or error summaries, or the in-process recorded transcript. The runner owns every verdict; adapters supply only raw surfaces and the configured secret values.
5. KRT-BD008: ran the full clean `bun run verify` (exit 0) with refreshed compatibility evidence.

#### 5.6.4 Framework-Enforced Execution Bounds (ADR-0043, Epic BD)

Closed outcome:
1. KRT-BD005: added `ExecutionBounds` and `ExecutionBoundExceededDetails` (§3.11) to `@tuvren/core/execution`; documented the `execution_bound_exceeded` code in `@tuvren/core/errors`; added the cooperative `TuvrenPrompt.signal` cancellation field to the provider contract authority owned by `spec/providers/` (with its TypeScript implementation at `typescript/providers/provider-api/`); and updated the shared core execution sources/generated artifacts/merged authority packet plus the provider-api sources/generated artifacts/authority packet with the required packet-version bumps. `ExecutionBoundExceededDetails.bound` is the three-value union `"maxIterations" | "maxToolCalls" | "maxWallClockMs"`; `maxConcurrentToolCalls` is intentionally excluded because it is a concurrency throttle, never a terminal bound.
2. KRT-BD006: implemented the bounds guard in `@tuvren/runtime`'s turn/run orchestration shell — enforces `maxIterations` and `maxToolCalls` at iteration and tool-batch boundaries above runner discretion, clamps `AgentConfig.maxIterations` by `bounds.maxIterations`, wraps the whole turn in a `maxWallClockMs` deadline that propagates an abort signal through `TuvrenPrompt.signal` and `ToolExecutionContext.signal` (forwarded by the owned `bridge-ai-sdk` and owned tool paths), ignores late completions after abort, and enforces `maxConcurrentToolCalls` by throttling tool concurrency to the configured cap. A breached hard-stop bound finalizes a `failed` `ExecutionResult` with code `execution_bound_exceeded` and `details`, emits the fatal canonical `error` event carrying the same code/details before the failed `turn.end`, resolves the abandoned tool work to the terminal `ignored` `InvocationLifecycleState`, and emits the `execution.bounded` telemetry event when a sink is configured. Invalid non-integer/non-finite/non-positive bounds are rejected at construction, and supplying both top-level and nested `bounds` is rejected as `invalid_createtuvren_options`.
3. KRT-BD006: added `bounds?: ExecutionBounds` to `CreateTuvrenOptions` and `RuntimeCoreOptions` with the safe defaults from §3.11 (64 / 256 / 600_000 / 16); added the `execution.bounded` attributes to the semconv source and regenerated the telemetry allowlist in the same change before admitting them.
4. KRT-BD007: added the `runtime-api-execution-bounds` check set to `runtime-api-callables-extended.json` using a runaway aimock runner fixture that always requests continuation; asserts each hard-stop bound's breach result and details, the fatal `error` event before the failed `turn.end`, observation of the `execution.bounded` telemetry event through a configured capture sink, clamping of `AgentConfig.maxIterations` by `bounds.maxIterations`, enforcement of the `maxConcurrentToolCalls` throttle, clamping of `AgentConfig.maxParallelToolCalls` and `defaultMaxParallelToolCalls` by that cap, rejection of invalid bound configuration, signal delivery and late-completion ignoring through owned integrations, and a within-bounds control case.
5. KRT-BD009: added the independent `trust-boundary` check set to `runtime-api-callables-extended.json` and `providers-mcp-client.json`, pinning that approval-gated tool work is non-bypassable, that a local tool-input schema violation surfaces as `tool.result isError: true` with code `tool_input_validation_failed`, and that an MCP-advertised input violation surfaces as `tool.result isError: true` with code `mcp_tool_input_invalid` rejected before transport invocation. No implementation gap was exposed; both validation paths already existed and the check set pins them.
6. KRT-BD008: added the normative "Execution Bounds" section (§4.12) to `docs/KrakenFrameworkSpecification.md` (bumped to v0.20) so future runners inherit the framework-owned guard, extended the docs-to-authority freeze gate with the matching execution-bounds evidence template and classifier, and ran the full clean `bun run verify` (exit 0) with refreshed compatibility evidence reflecting the execution-bounds, secret-isolation, and trust-boundary lanes.

### 5.7 Migration Plans for the v0.29.0 Capability-Orchestration Revision

This section consolidates the bounded migration actions implied by ADR-0046 and ADR-0047. The conceptual model and contracts are authored above (PRD v0.9.0, Architecture v0.9.0, §3.13, §4.21); the source implementation was captured in `Tasks.md` as the now-closed **Tooling block (Epics AW–BC)**, which preceded the trust block (Epic BD, also closed) and the named-but-not-yet-ticketed productionization roadmap (Epics BE–BI). No code landed from this TechSpec revision itself; it is the contract the Tooling block implemented. The block is "finished" when all four execution classes are orchestrated by the runtime with honest per-class observation/control limits, MCP is classified as a binding across classes, exposure/invocation policy applies, the cross-class invariant is conformance-verified, and the framework specification states the model.

#### 5.7.1 Tooling Block Foundation (ADR-0046, ADR-0047, Epic AW)

Order:
1. Add the `./capabilities` subpath to `@tuvren/core` with the §3.13 types; generate the capability JSON schemas; add a `capabilities` binding section to the merged shared-core authority packet and bump its version.
2. Implement the Capability Registry, Binding & Endpoint Resolver, and Capability Policy Engine (exposure-time and invocation-time decision points) in `@tuvren/runtime`; surface invocation denials and unavailable bindings as `tool.result` `isError` per the §4.21 error model (including the new `capability_binding_unavailable` code in `@tuvren/core/errors`).
3. Reclassify today's `TuvrenToolDefinition` path as the Tuvren-server class (no host change) and `@tuvren/mcp-client` as a binding mechanism; route both through the resolver to the existing Tool Execution Gateway.
4. Add the execution-class + `owner` attribution to the canonical event stream (§4.5) and operational telemetry (§3.10) for tool/capability invocation events, additively.
5. Add the `runtime-api-capability-orchestration` foundation check set (the invariant, surface-vs-capability separation, exposure/invocation policy, attribution, back-compat that `defineTool` is Tuvren-server) in the framework plans.

#### 5.7.2 Per-Class and Cross-Class Build-Out (Epics AX–BC)

Each epic is active scope in `Tasks.md` and builds on the foundation:
- **Epic AX — Tuvren-Server Execution Class:** full server lifecycle (input/output validation, idempotent retry, cancellation, trace, audit, tenant isolation, rate-limit, server-side MCP binding, server sandbox endpoint) and its conformance.
- **Epic AY — Provider-Native & Provider-Mediated Execution Classes: CLOSED.** Landed: `ProviderNativeToolDeclaration`/`ProviderMediatedToolConfig` in `TuvrenPrompt`/`AgentConfig`; AI SDK bridge `providerToolClassLookup` accepting declared provider tool results; pre-staged provider tool messages bypassing the Tool Execution Gateway; `emitProviderToolAttributionEvents` with per-class observation limits; `provider-native-execution-class` and `provider-mediated-execution-class` conformance check sets (19 new checks, 51/51 provider checks pass). Known gap: AY005 multi-turn providerContinuity extraction round-trip is structurally wired but not covered by a multi-turn proof; deferred to Epic BA or a follow-on ticket.
- **Epic AZ — Tuvren-Client Execution Class: CLOSED.** Landed the leased client-endpoint dispatch/result protocol and attachment seam (runtime side only); `AttachedClientEndpoint`, `ClientEndpointBoundary` (with `detach()`), leaseToken staleness detection; client-side MCP classification as `tuvren-client / mcp-server`; partial-observability model (canAudit/canCancel/canRetry/canResume: false); `tuvren-client-execution-class` conformance check set (13 checks, 13/13 pass); client-endpoint integration contract at `spec/host/client-endpoint-integration.md`. Concrete client endpoints remain host-developer deliverables.
- **Epic BA — Invocation Lifecycle & Observation Model: CLOSED.** Landed: `InvocationLifecycleState` union type in `@tuvren/core/capabilities` (6 phases: resolved → policy-admitted → dispatched → completed/failed/ignored); provider-native/mediated `tool.start`/`tool.result` attribution events routed through `publishRuntimeEvent` so the telemetry emitter observes them (BA002 gap); `null` as the JSON-serializable "not observed" sentinel for provider tool inputs; cross-class resume/recovery semantics proven through unit tests and conformance (tuvren-server fails clean per durability, provider classes resolve from observed state, tuvren-client stale/unavailable paths surface CAPABILITY_RESULT_STALE/CAPABILITY_BINDING_UNAVAILABLE, turn abort terminates cleanly); lifecycle telemetry depth confirmed using existing semconv (no extension needed); `invocation-lifecycle-observation` conformance check set (19 checks: BA001–BA003 invariants); 424 runtime tests pass; 399/399 framework conformance checks pass; `bun run verify` exits 0.
- **Epic BB — Exposure & Invocation Policy Model: CLOSED.** Landed: `PolicyCapabilityMetadata` type; `CapabilityPolicyContext` extended with all §4.21 dimensions; `TuvrenToolDefinition` BB policy fields; `AgentConfig.policyContextInputs`; five-dimension policy engine (residency, risk/approval, active-endpoint, user-presence, credential-boundary) with deterministic composition; exposure-time filtering wired; invocation-time context populated from real config; resume-path check added; `nonRetryable` overrides idempotency; `requiresApproval` bridges to approval flow; `capability-policy` conformance check set (26 checks, 26/26 pass); 472 runtime tests pass; 425/425 framework conformance checks pass.
- **Epic BC — Tooling Restructuring Closeout:** cross-class integration conformance, the normative "Capability Orchestration" section in `docs/KrakenFrameworkSpecification.md` (minor bump), the capability-surface portability inventory and authority-packet finalization, and a clean `bun run verify`.

### 5.8 Migration Plans for the v0.32.0 SDK-Boundary and Two-Funnel Revision

Sequencing for ADR-0056/ADR-0057/ADR-0058 lives in the execution plan (the constitution's tasks layer); this section records only the physical migration constraints the ADRs impose.

#### 5.8.1 Experimental Marker (ADR-0056)

1. Tag every export of `@tuvren/core/capabilities` with TSDoc `/** @experimental */`; add the subpath-level notice to its docs.
2. Record the marker declarations in the `spec/core/authority-packet.json` surface listing so gate, docs, and conformance read one source.
3. The API-snapshot gate (built in the freeze epic) consumes tags per the ADR-0056 diff table; the consistency floor (untagged export under a declared-experimental subpath fails the build) lands with the gate.

#### 5.8.2 SDK Composition Tier (ADR-0057)

1. One coordinated commit resolves the dependency-edge inversion: remove `@tuvren/sdk` from `@tuvren/runtime`'s `peerDependencies`, add `@tuvren/runtime` to `@tuvren/sdk`'s `dependencies`, and move `create-tuvren.ts` plus its composition helpers from `typescript/runtime/src/lib/` to `typescript/sdk/src/lib/`. Any intermediate state is a workspace dependency cycle.
2. Retire the ADR-0040 string-kind shorthands from `CreateTuvrenOptions` (instances-only shape per ADR-0057 §2); update the batteries-included conformance check set to target the `@tuvren/sdk` surface.
3. Remove the curated `@tuvren/core` re-exports from `@tuvren/runtime/src/index.ts`; `@tuvren/sdk` re-exports the curated set alongside `createTuvren`.
4. Re-point the Reference Host: `typescript/host/repl/package.json` drops `@tuvren/runtime`, adds `@tuvren/sdk`; all 14 importing modules migrate to `@tuvren/sdk` / `@tuvren/core` subpaths / leaf-package instances. Engine composition factories the host genuinely needs (`createOrchestrationRuntime`, `createRunnerRegistry`, `createTuvrenRuntime`, `createRuntimeKernel`) come from the `@tuvren/sdk/advanced` subpath, and `createGrpcRuntimeKernel` from the `@tuvren/kernel-grpc-client` leaf (both per ADR-0059).
5. Add the host-boundary check to the canonical verification path: no import of `@tuvren/runtime`, `@tuvren/kernel-protocol`, or `@tuvren/kernel-runtime` from `typescript/host/**` or documentation examples. The check allows `@tuvren/sdk` (root and `/advanced`) and the host-facing `@tuvren/kernel-grpc-client` leaf (ADR-0059).
6. Mark `@tuvren/runtime` internal in its `README.md` and `package.json` description.
7. **Advanced composition surface + gRPC-client leaf (ADR-0059, amends §3/§6).** ADR-0057's grounding checked host-facing types only; the Reference Host also consumes engine *factory functions* with no curated home. Add the opt-in `@tuvren/sdk/advanced` subpath (`createOrchestrationRuntime`, `createRunnerRegistry`, `createTuvrenRuntime`, `createRuntimeKernel` — re-exported from `@tuvren/runtime`/`@tuvren/kernel-runtime`, install weight unchanged since `@tuvren/sdk` already deps both) and extract the `@tuvren/kernel-grpc-client` leaf (`typescript/kernel/grpc-client/`) owning `createGrpcRuntimeKernel` + the relocated kernel-interop generated bindings/codec. Retarget the kernel-interop codegen (`buf.gen.yaml` out-path, `tools/scripts/kernel-interop-governance.ts` path constants, the `kernel-interop-grpc` Nx `outputs`) from `typescript/runtime` to the leaf, and drop `@connectrpc/*` + `@bufbuild/protobuf` from `@tuvren/runtime`. The leaf joins the publishable set (KRT-BJ007/BJ008 + the ADR-0054/ADR-0056 freeze); `@tuvren/sdk/advanced` is an additional entry of the already-frozen `@tuvren/sdk`.

#### 5.8.3 Two-Funnel Routing Contract (ADR-0058)

1. Add `TelemetryDestination` (deliver, buffering descriptor, operational-signal channel) to `@tuvren/core/telemetry`; declare it in the core authority packet's `/telemetry` binding section.
2. Widen the `telemetry` option on `CreateTuvrenOptions` to `TuvrenTelemetrySink | TelemetryDestination | { sink?; destination? }` (backward-compatible pre-freeze widening).
3. Extend the telemetry emission boundary in `typescript/runtime/src/lib/runtime-core-telemetry.ts` with destination delivery + failure-to-operational-signal conversion; no emission path may throw into session execution.
4. Add the funnel-isolation conformance check set (destination healthy-vs-unavailable session equivalence; no content payload on the telemetry funnel under default routing; failure-to-signal mapping). No proto change: kernel interop stays funnel-unaware.
5. Official destination adapter packages are deferred per CAP-P1-073 and ship additively post-freeze.

### 5.9 Live verification

`reference-host-memory-scenario` builds the reference host and runs `--scenario streaming` through `createReplHost`, which calls `createTuvrenRuntime`. It does not call `createTuvren`. That entrypoint is used by transcript replay (`createReplHostUsingCreateTuvren`), and replay has no package script: it needs a transcript file. There is no active ticket that could own an `exists: false` recipe, so the curated library entrypoint has no recipe. Do not cite the memory scenario as proof of `createTuvren`.

`reference-host-headless-sqlite` is the CLI recipe. It runs `proving-host:scenario-sqlite-pinned`, then prints `headless sqlite scenario passed` only if that script exits 0. The script gives the run a private temp directory and deletes that directory on exit, including failure, so it cannot remove another run's database. `pipefail` keeps a failing CLI from being hidden by the assert helper. The helper only checks that the JSONL is nonempty and has no error record, so the script also requires a `text.delta` event from the turn. The two halves do not share a file, so this recipe is not a reload proof. It does not leave a service running.

`kernel-grpc-interop-smoke` and `mcp-stdio-smoke` are the same drive: `bun run proving-host:interop-smoke`. That script builds the host, starts the Rust kernel gRPC service, and feeds headless stdin that includes `.mcp smoke` against the mock stdio server. It stops the service in a `finally` block. One command covers both seams; the two recipes name which line to capture.

PostgreSQL is `bun run proving-host:scenario-postgres` after `bun run services:up`. It is not a recipe, because a dark-factory run cannot assume the service is up. The remote WebSocket session has a local launcher (`--serve-ws` plus `typescript/host/repl/scripts/ws-peer.ts`, covered by `repl-serve-ws.e2e.test.ts`), and that test needs the same PostgreSQL service. It is omitted for the same reason, not because no command exists.

No contract is pinned. There is no active epic, so no shape is shared by a wave. The next wave's step 0 should consider pinning the kernel record profile, the core TypeSpec, the authority-packet schema, and the duplex session frames.

## 1. Stack Specification (Bill of Materials)

- **Primary Language / Runtime:** TypeScript `6.0.2` is the first authoritative implementation language for the framework and kernel protocol implementation. Rust `1.95.0` is now active for the kernel-first implementation line through the root Cargo workspace and `rust-toolchain.toml`. The kernel protocol remains language-neutral by contract. Core TypeScript packages target portable ESM across Bun, Node.js, and Deno. Bun remains the preferred local development runtime and package manager. Go and Python kernel-boundary implementation lines are now active (authorized by the 2026-07-15 kernel-port conformance stress-test effort, PR #96): Go uses flat `go/<name>` modules under the root `go.work`, Python uses `python/<name>` uv workspace members under the root `pyproject.toml` + `uv.lock`, and both toolchains are provisioned by `devenv.nix`. The Dart kernel-boundary implementation line is likewise active: Dart uses `dart/<name>` pub workspace members under the root `pubspec.yaml` (Dart 3.6+ `workspace:` field) with the committed `pubspec.lock` as dependency-pin authority, and its toolchain is provisioned by `devenv.nix` (`languages.dart.enable`). Future Zig or other implementations must likewise use their native workspace files when and only when their boundary work is authorized.
- **Primary Frameworks / Libraries:** `ai@6.0.142` and `@ai-sdk/provider@3.0.8` for the baseline AI SDK Providers bridge, using the `LanguageModelV3` / `ProviderV3` surface only in the baseline bridge; `@ag-ui/core@0.0.52` for the baseline AG-UI event union and runtime validation surface; `ajv@8.18.0` for JSON Schema validation; `cbor-x@1.6.4` for deterministic CBOR encoding and decoding in the TypeScript implementation; `@biomejs/biome@2.4.10` for formatting and linting; `tsup@8.5.1` for package builds; `@typespec/compiler@1.11.0`, `@typespec/json-schema@1.11.0`, `@typespec/openapi3@1.11.0`, and their pinned TypeSpec peer libraries for TypeSpec contract artifact generation; `cddl@0.20.1` for kernel CDDL grammar validation; `@modelcontextprotocol/sdk@1.29.0` for the MCP Client Container's protocol and transport implementation (consumed as a direct dependency of `@tuvren/mcp-client`; package metadata for v1.29.0 still declares `zod` as a non-optional peer as well as a runtime dependency, so `@tuvren/mcp-client` must satisfy that upstream requirement with a direct `zod@4.4.3` dependency while keeping `zod` out of its public peer surface); `@modelcontextprotocol/server-everything@2026.1.26` as the official MCP provider-testkit fixture for stdio and Streamable HTTP parity checks; `zod@4.4.3` as an optional peer dependency of `@tuvren/core` for the Zod (v3 and v4) authoring path in the Schema Authoring Helper; `@standard-schema/spec@1.1.0` as an optional peer dependency of `@tuvren/core` for the Standard Schema authoring path in the Schema Authoring Helper (types-only; carries the `StandardSchemaV1` interface and the Standard JSON Schema spec). The transition line also standardizes on Protobuf plus gRPC for the first cross-language kernel process boundary, Buf v2 configuration for `.proto` governance, Devenv-provisioned `buf@1.66.1`, `protobuf`/`protoc`, and `protoc-gen-es@2.11.0` for current kernel interop generation, `@bufbuild/protobuf@2.11.0` for the generated TypeScript binding runtime, Rust `tonic`/`tonic-prost`/`tonic-prost-build@0.14.5`, `prost@0.14.3`, `tokio@1.52.1`, `ciborium@0.2.2`, `serde@1.0.228`, and OpenTelemetry semantic conventions for cross-language observability. Exact package and plugin versions for future additions must be pinned in the activation change that introduces them.
- **State Stores / Persistence:** Tuvren uses a Kraken-owned backend contract first. `@tuvren/backend-memory` is the reference development and semantic test backend. `@tuvren/backend-sqlite` is the first officially supported persistent backend adapter and the baseline persistent backend for Node-capable proving hosts. `@tuvren/backend-postgres` is the second officially supported persistent backend adapter and the service-backed persistent backend for PostgreSQL-capable hosts. Each backend advertises a `BackendCapability` descriptor (§3.7) that names which optional kernel-level structural enumerations it supports efficiently; the `thread.enumeration` capability bit is one such descriptor entry, mandatory for backends serving hosts that consume the `TuvrenRuntime.listThreads` durable-read surface. Later backends such as MySQL/MariaDB and MongoDB are peer adapters against the same kernel contract, not SQLite-shaped or PostgreSQL-shaped variants.
- **Infrastructure / Tooling:** `devenv` for reproducible development environments, local PostgreSQL service lifecycle, and CLI-path provisioning; `nx@22.6.3` plus aligned `@nx/*` packages for TypeScript project orchestration; Bun workspaces; root TypeScript project references; `tsup` package builds; structured JSON logging; exact dependency pinning in `package.json` plus `bun.lock`; environment-variable-based provider credentials at bridge boundaries; and `devenv`-provisioned Weaver, Buf, and Protobuf generator CLI paths for semantic-convention and interop generation. The repo root also remains the home for repo-global orchestration, Buf configs, the root Rust workspace files (`Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`), `reports/compatibility/`, and `tools/` wrappers that coordinate native toolchains without replacing them; the canonical telemetry semantic-convention vocabulary now lives under boundary-owned `spec/telemetry/semconv/` rather than a repo-root `telemetry/` directory.
- **Testing / Quality Tooling:** `bun test`, `tsc --noEmit`, Biome, TypeSpec code generation checks, CDDL grammar validation, deterministic CBOR golden-byte tests, hash identity fixtures, shared backend conformance suites, checkpoint/recovery scenario tests, AI SDK bridge contract fixtures, target-state proving-host end-to-end validation, and local mock-provider validation through `@copilotkit/aimock@1.15.1` plus `@ai-sdk/openai@3.0.53`, `@ai-sdk/anthropic@3.0.66`, and `@ai-sdk/google@3.0.64` against local OpenAI-, Anthropic-, and Gemini-compatible provider boundaries for success, control, and provider-failure paths. The baseline TypeScript line now proves product depth through the serious REPL host’s named `proving-host:interop-smoke`, `proving-host:scenario-sqlite`, and `proving-host:scenario-postgres` lanes in the canonical verification path. The former playground host is retired; the REPL host is the lasting product-proof gate. The transition line adds boundary-owned JSON conformance fixtures, JSON Schema 2020-12 fixture validation, compatibility-matrix generation, Buf breaking-change checks when `.proto` surfaces exist, and real interop-smoke validation between the TypeScript framework line and the Rust kernel services.
- **Version Pinning / Compatibility Policy:** Versions named in this TechSpec are authoritative for the baseline implementation line and must match the repository manifests. Public package APIs follow semantic versioning. Changes to kernel record encoding, hash algorithm, or durable identity rules are semver-major. Semantic surface versions for kernel protocol, framework contracts, event vocabulary, error vocabulary, conformance suites, and interop transport are tracked independently from npm package versions or future crate versions.


## 1.1 Implementation Posture

- **Authoritative center:** The kernel boundary is a protocol of serializable data, not an in-process callback API.
- **First implementation choice:** TypeScript is the first authoritative implementation of that protocol for speed of validation, not a claim that the kernel is fundamentally JavaScript-bound.
- **Semantic authority posture:** `docs/` and `.constitution/` are the human semantic authorities. Boundary-owned machine-readable contract, conformance, and interop assets are downstream projections of that authority unless explicitly promoted as normative in the same change.
- **Documentation posture:** `docs/` carries the project’s timeless semantic layer, while `.constitution/` is the live planning and execution framework for the repo. `.constitution/` is a routing helper aligned to the live constitutional chain rather than a fifth authority document. Generated support artifacts that canonical verification or portability classification still consumes live under `.constitution/reports/`, but they do not extend the four-document authority chain. Historical constitutional planning, report, and closure material lives under `.constitution/archived/` as historical context only.
- **Portability posture:** Core packages stay runtime-portable where practical; backend packages and provider bridges may have narrower runtime support when their dependencies require it.
- **Multilanguage posture:** Tuvren is one semantic ecosystem with multiple implementations, not multiple independent ports. Shape contracts, behavioral conformance, and cross-process transport are separate authority layers.
- **TypeScript productization posture:** TypeScript is the first full product line. It must prove the embeddable SDK through a serious REPL-style host that exercises the documented runtime surface end to end before package curation is treated as stable and before Rust framework/product work resumes.
- **Freeze-readiness posture:** AG-generated green evidence for the currently promoted supported applicable surfaces remains valid historical evidence, but it is no longer the governing readiness claim. Active readiness now follows three staged gates: `product proof gate`, `platform gate`, and `portability gate`. Rust remains blocked until the portability gate passes under fresh evidence.
- **Authority stack posture:** Cross-implementation meaning is carried by a layered authority stack — TypeSpec for the logical contract spine; CDDL for deterministic CBOR/kernel binary-record grammar; Protobuf/Buf for transport projections where gRPC is the chosen transport; JSON Schema 2020-12 for portable validation artifacts; conformance-plan JSON for executable behavior assertions; OpenTelemetry semconv via Weaver for telemetry vocabulary. TypeScript and Rust are implementation languages and binding-projection surfaces, not authority. Markdown is governance and rationale prose, not authority. Authority Packet manifests under `spec/<port>/authority-packet.json` declare which of these formats together carry one cross-implementation semantic surface and which sources are forbidden authority for that surface.
- **Framework posture:** The framework layer is runner-oriented. Shared framework contracts and runtime services stay runner-neutral where practical, while concrete execution semantics live in runner implementations.
- **Initial runner posture:** The first production-depth runner is the ReAct Runner (`@tuvren/runner-react`). It is the baseline implementation, not the whole framework ontology.
- **Provider posture:** Tuvren owns the canonical provider contract, while Kraken supplies the engine semantics behind it. The baseline TypeScript bridge surface is AI SDK Providers only, but the AI SDK bridge is not the provider semantic oracle. Tuvren-owned provider semantics, event shapes, error behavior, and continuity expectations must remain portable and implementation-agnostic so future Rust connectors can satisfy the same contract without inheriting AI SDK types or naming. Per ADR-0053, the durable lineage is the unconditional source of truth for a provider request: provider server-side state and continuity artifacts are reconstructable optimizations the bridge carries but never depends on, and provider-side caching is correctness-neutral. Per ADR-0055, native first-party provider clients (Anthropic/OpenAI/Gemini) stay deferred behind a named trigger and the baseline bridge gets a `providerExecuted`/`dynamic` round-trip fidelity audit. LangChain and first-class Tuvren provider packages remain out of current baseline scope.
- **Backend posture:** All official backends implement one strict kernel-visible contract. Memory remains the reference development backend, SQLite and PostgreSQL are the official production-depth backends for current TypeScript hosts, and backend-specific optimizations may exist internally so long as they do not change kernel semantics or require capability negotiation at the kernel layer in v0.1. Per ADR-0048/ADR-0049, each backend is constructed against a host-bound Scope and resolves durable identity within that Scope (isolation-by-construction) while the kernel syscall surface stays scope-free. Per ADR-0050, the `BackendCapability` descriptor additionally advertises whether the backend can serve as the authoritative shared lease clock (PostgreSQL: yes, via server time; single-writer memory/SQLite: no, in-process clock); per ADR-0051 it advertises whether it supports the reachability reclamation maintenance primitive.
- **Tenancy & isolation posture:** Tuvren is tenancy-agnostic. The Scope seam (ADR-0048) is the only tenancy mechanism the product owns; tenant definition, authentication, routing, and cross-tenant discovery are host policy. Isolation-by-construction (ADR-0049) means no read, enumeration, or existence check crosses a Scope, realized at the storage substrate (row-level-isolated connection, store-per-scope, or scope discriminator) rather than in the kernel protocol.
- **Data lifecycle & erasure posture:** Garbage collection is now an in-scope mechanism (ADR-0051): a kernel reachability reclamation primitive (capability-advertised, grace-windowed) reclaims unreferenced durable state, and sensitive untrusted-edge payloads are stored as host-key-encrypted references so erasure is crypto-shredding (destroy the host-held key) rather than history rewriting. The host owns retention policy and keys; the runtime owns the mechanism; the kernel stores opaque ciphertext blobs and remains data-only.
- **Execution-sovereignty posture:** Per ADR-0050/ADR-0052/ADR-0065, the shared backend owns the lease-expiry clock for multi-worker deployments, side-effecting invocations carry an idempotency identity derived from `(turnId, callId)` — the logical call identity, which survives retries, approval resumes, and preemption recovery because a Turn spans its Runs — in-flight `nonRetryable` work is not retried on authority loss, and a client-reported result is a proposal that commits only under a valid run fencing token. The `runId` and the fencing token are deliberately excluded from the identity (ADR-0065): the former is per-attempt, the latter rotates per renewal, and either would make the key churn under exactly the conditions it must survive.
- **Tool-result sanitization posture:** Per ADR-0064, an optional host-supplied `sanitizeToolResult?: (result, ctx: { callId, executionClass?, toolName }) => ToolResultPart` hook on `AgentConfig`/`RuntimeCoreOptions` runs at every path that can durably stage a tool result before it does so — inside `stageAndEmitResult` (the Tool Execution Gateway chokepoint preceding both durable kernel staging and the canonical `tool.result` event) and, via the same shared `applySanitizeHookToPart` helper, inside the pre-staged provider tool-message path (AY003) in `executeIterationPhase`, which bypasses the gateway entirely — so a host that installs a redaction policy is guaranteed it runs before host-, peer-, or provider-authored tool-result content becomes permanent lineage. The framework guarantees only the seam and its ordering, never content inspection; a throwing hook fails that call's own result (`tool_result_sanitization_failed`) rather than the turn or a silent substitution. The hook is threaded symmetrically to every in-memory consumer of a staged result (batch outcomes, same-turn `afterIteration` hooks, the resume path, and provider attribution events) so no consumer observes the pre-sanitization form, and re-stamps `callId`/`name`/`type` (and, at the provider-message path, `providerMetadata`) from the input after the hook returns so a careless host rebuild cannot desync durable identity or continuity from the originating call.
- **SDK distribution & stability posture:** Per ADR-0054, the curated host-facing SDK is frozen and published to the public registry under semantic versioning only after the tenancy (ADR-0048/ADR-0049) and data-lifecycle (ADR-0051) work lands; the stable core (`@tuvren/core` primitives, Durable-Read Surface, `ExecutionHandle`/`awaitResult`, `createTuvren`, published leaf packages) is semver-guaranteed, while in-flux surfaces (notably the `@tuvren/core/capabilities` advanced classes) are explicitly marked experimental and excluded from the guarantee.
- **Stream portability posture:** The canonical event stream and SSE projection are required portable surfaces. AG-UI translation remains implementation-specific because it depends on an external SDK ecosystem, but it must stay a projection of canonical runtime meaning rather than a competing semantic surface. Per ADR-0060, the inbound direction now has canonical vocabulary too: the duplex session frame family (`spec/host/session/`, packet `tuvren.framework.host-session`) is the framework-owned wire form of the client-to-agent interactions (client results, approval responses, steering, cancellation) plus the session-owned outbound frames; it is experimental (`0.x`, ADR-0056 posture) and portable by intent, with TypeScript as the only advertising implementation today. The control channel never tunnels through AG-UI `CUSTOM` frames. Per ADR-0061, stream resumability is likewise framework-owned vocabulary: a wire-level sequencing envelope and opaque resume cursor (`spec/streaming/resume/`, packet `tuvren.framework.event-stream-resume`, experimental `0.x`) that every projection inherits from `@tuvren/stream-core` — SSE carries the cursor as the frame `id` (`Last-Event-ID`), and transports own only carriage, never cursor semantics. Per ADR-0062, the WebSocket transport (`spec/streaming/ws/`, packet `tuvren.framework.event-stream-ws`, experimental `0.x`) is the second such carriage-only projection: `@tuvren/stream-ws` (`typescript/streaming/ws/`) carries duplex session frames over one bidirectional connection in JSON text envelopes, carrying the ADR-0061 resume cursor on its handshake and outbound event frames without owning cursor or replay semantics, and owning only its own connection-level concerns (in-band handshake, heartbeat, bounded outbound backpressure, and a close-code vocabulary in the 4000-4005 application range). It has no third-party WebSocket dependency: the package wraps an abstract socket seam (`WsSocketSink`) the host supplies, not a bundled client/server library. TypeScript remains the only advertising implementation today. Per ADR-0063 (issues #102/#104), a session-lifecycle seam now sits between the session binding and any carriage binding, closing both obligations ADR-0062 §6 deferred: `@tuvren/remote-session` holds the single `outbound()` claim and the one sequencer/replay-buffer instance for the session's whole life (claimed on first `attach`, not construction), so `@tuvren/stream-ws` no longer owns a sequencer and takes a session rather than a binding, and unanswered `client_invocation` frames are recovered by redelivery on reattach rather than left unrecoverable. Neither package opens a new authority packet — the semantics are certified as an extension of the existing `tuvren.framework.host-session` and `tuvren.shared.core` plans — and both are TypeScript-only host implementations today, with the genuinely cross-process, real-socket claim proved only as package-test evidence in the REPL host's e2e suite (see the host-proof posture note below) rather than as a portable conformance surface.
- **Toolchain posture:** Nx orchestrates repo-wide target names and dependency flow, but Bun, Cargo, Buf, and future language-native tools remain authoritative inside their ecosystems.
- **Interop posture:** The first cross-language seam is a process boundary around the kernel. FFI remains explicitly out of the first Rust phase.


## 1.2 Current-State vs Target-State

- **Current repository reality:** The repository already contains the workspace scaffold, `@tuvren/core` as the consolidated shared-primitive package, the schema-authoring helpers (`defineTool`, `FlexibleSchema`, `asSchema`, `jsonSchema`, `zodSchema`, `standardSchema`) under `@tuvren/core/tools`, no remaining compatibility shims (`@tuvren/core-types`, `@tuvren/runtime-api`, `@tuvren/driver-api`, `@tuvren/event-stream`, and `@tuvren/tool-contracts` all completed their one-cycle deprecation window and were removed from the workspace; `@tuvren/core-types` was the last, removed at KRT-BM006), `@tuvren/kernel-protocol`, `@tuvren/backend-shared` (the shared reclamation/run-transition-legality/immutability invariant core the memory, SQLite, and PostgreSQL backends delegate to as thin per-backend shims), `@tuvren/backend-memory`, `@tuvren/backend-sqlite`, `@tuvren/backend-postgres`, `@tuvren/kernel-testkit`, `@tuvren/provider-api`, a source-bearing `@tuvren/runtime` package (`typescript/runtime/`) that now absorbs the former runtime-core implementation directly into `src/lib/` per ADR-0040 and exposes `createTuvren({...})` plus curated re-exports (the separate `runtime-core` package/dir and its `@tuvren/runtime-core` compatibility shim no longer exist, having completed their one-cycle deprecation window), the serious REPL proving host `@tuvren/repl-host` (`typescript/host/repl/`) with shared interactive, scripted-scenario, headless JSONL, transcript record/replay, and MCP smoke execution plus named `proving-host:*` validation lanes, the ReAct Runner baseline (`@tuvren/runner-react` at `typescript/runners/react/`) with implementation-proven loop completion, streaming/provider semantics, shared runtime tool/approval integration, `ExecutionHandle.awaitResult`, the five-method `TuvrenRuntime` durable-read surface, and the reusable `createGrpcRuntimeKernel()` helper for the governed Rust-kernel transport seam, `@tuvren/provider-bridge-ai-sdk` as the first concrete provider bridge, the host stream adapter line `@tuvren/stream-core`, `@tuvren/stream-sse`, `@tuvren/stream-agui`, and `@tuvren/stream-ws` (`typescript/streaming/{core,sse,agui,ws}/`, `@tuvren/stream-ws` now pure carriage over a session per ADR-0063), the reattachable session-lifecycle seam `@tuvren/remote-session` (`typescript/host/remote-session/`, ADR-0063; private, `@experimental`) and its zero-dependency reference remote peer `@tuvren/session-client` (`typescript/host/session-client/`, issues #102/#104 M5; private, mirrors the §4.22/§4.23 wire shapes locally rather than depending on the workspace), the hardening testkits `@tuvren/provider-testkit` and `@tuvren/framework-testkit` (the latter at top-level `typescript/testkit/`), release and portability scripts under `tools/scripts`, the checked-in Epic Q portability matrix, the Epic Q release-hardening closure inventory, the repo-global `reports/compatibility/` root plus the boundary-owned `spec/telemetry/` semantic-convention authority, port-scoped conformance plan roots under `spec/conformance/` for the engine (core/framework), kernel, and providers ports, TypeSpec-authored tool/provider contract sources plus reviewed JSON Schema/OpenAPI artifacts, kernel CDDL grammar under `spec/kernel/cddl/`, one shared semantic conformance harness at `tools/conformance/harness/run.ts`, JSON-RPC adapter protocol schemas under `tools/conformance/adapter-protocol/`, TypeScript and Rust implementation adapter hosts under `conformance-adapter/` directories (`typescript/<area>/conformance-adapter/`, `rust/conformance-adapter/`, `rust/kernel-conformance-adapter/`), the TypeScript PostgreSQL certification host (`typescript/kernel/certification-postgres/`) alongside the existing memory and SQLite certification lanes, compatibility evidence emitted through shared-harness evidence files, kernel-only proto authority under `spec/interop/proto/`, root `buf.yaml` / `buf.gen.yaml`, the `kernel-interop-grpc` Nx target surface, Devenv-provisioned Buf/protoc generator tooling plus the local PostgreSQL service lifecycle, generated TypeScript telemetry and kernel-interop helpers under the consuming TypeScript implementation packages, root Cargo workspace files, the Rust kernel core (`rust/kernel/`), Rust gRPC service (`rust/kernel-grpc-service/`), generated Rust telemetry helper under the Rust kernel tree, a real TypeScript-framework-to-Rust-kernel interop suite manifest under `spec/conformance/interop/rust-kernel/`, and a measured compatibility matrix whose checked-in payload uses deterministic sentinel `generatedAtMs` / `sourceRevision` values plus scrubbed interop telemetry attributes while still preserving the substantive `rust-kernel`, `rust-framework`, TypeScript current-lane, and `typescript-framework__rust-kernel` evidence entries.
- **Current TypeScript kernel closure posture:** `@tuvren/kernel-runtime` now exists at `typescript/kernel/runtime/` as the port-owned TypeScript adapter from `RuntimeBackend` to `RuntimeKernel`, exported through `createRuntimeKernel()`. REPL local memory and SQLite modes now obtain syscall behavior from that package, while host-owned code is limited to host wiring rather than private syscall semantics.
- **Current kernel conformance posture:** `tuvren.kernel.protocol` now references promoted kernel protocol core, kernel protocol extended, run-liveness, and restart-recovery plans. The TypeScript memory, SQLite, and PostgreSQL kernel adapters execute native `@tuvren/kernel-runtime` behavior under the shared runner, TypeScript SQLite and PostgreSQL evidence are full-pass for their advertised durable capability sets, TypeScript memory evidence is pass for its advertised capability subset without durable restart-recovery, and Rust additionally advertises and passes the `kernel.run-liveness` and `kernel.reclamation` capability families (lease-aware run-liveness plus a ported mark-and-sweep reachability-reclamation primitive including crypto-shredding erasure, promoted by Epic BK's `KRT-BK010`), remaining capability-scoped and non-applicable only where it does not yet advertise the relevant extension — durable restart/crash-recovery and `kernel.scope-isolation` (no Scope dimension yet), both tracked to the named-but-not-yet-ticketed Epic BN in `critical-path.md`.
- **Current semantic-evidence posture:** The boundary-owned semantic evidence posture from Epic W remains intact after Epic X and final Epic Y closure. The TypeScript testkits still act as helper and facade packages for TypeScript-local testing, but they now live under implementation-owned paths. TypeScript and Rust conformance entry points are wrappers or native adapter hosts; `tools/conformance/harness/run.ts` owns assertion evaluation, required evidence, capability selection, adapter-error isolation, trace execution, and compatibility evidence emission.
- **Current host-proof posture:** The repository now proves the host story through the serious REPL host `@tuvren/repl-host`, with shared interactive, scripted scenario, headless JSONL, transcript record/replay, and MCP smoke wiring; named `proving-host:interop-smoke`, `proving-host:scenario-sqlite`, and `proving-host:scenario-postgres` validation targets; fresh compatibility evidence; and canonical-verification-path integration. Per ADR-0041 (v0.27.0), `@tuvren/playground-host` has been retired and the REPL host internals now use `Repl*` naming. The boundary-piercing `createPlaygroundKernelInspector` has been deleted in favor of the new `TuvrenRuntime` durable-read surface (ADR-0036). Headless stdin mode (`--headless`) supports output-only JSONL and streaming JSONL (`--stream-jsonl`), and transcript capture/replay is wired through `--record` / `--replay`. Per ADR-0063 (issues #102/#104, M6), the REPL host also gained the first real network host for the duplex session chain: a `--serve-ws` mode (`--serve-ws-port` / `--serve-ws-hostname`) adapts `Bun.serve` WebSocket connections into `WsSocketSink`s over a host-owned `sessionId -> RemoteClientSession` registry (session identity is host application state per ADR-0063), composing binding -> `RemoteClientSession` -> `createWsSessionTransport` -> socket per connection, plus a headless peer script (`scripts/ws-peer.ts`) driving `@tuvren/session-client`. Its e2e suite (`typescript/host/repl/test/repl-serve-ws.e2e.test.ts`) proves reconnect-redelivery dedup (a killed raw socket, unanswered `client_invocation`, exactly-once handler execution on reattach) and process-kill durability (SIGKILL, fresh runtime reads the committed result back from disposable PostgreSQL) over genuine sockets — the cross-process, real-socket evidence the rest of the chain's conformance checks approximate in-process. The test deliberately does not claim a cold-recovery resume of the killed session, recording that ADR-0065 obligation 1 (framework spec §4.9 staged-result re-presentation) remains open rather than overclaiming.
- **Current production-trust posture:** Epic AU is closed in repository reality. `@tuvren/kernel-testkit` owns the testkit-only `createFaultInjectingBackend` seam; memory, SQLite, and PostgreSQL are covered by `kernel-crash-recovery` checks in `kernel-restart-recovery.json`; the kernel protocol authority packet references that strengthened plan; `docs/KrakenKernelSpecification.md` states the Crash Recovery Invariant; and checked-in compatibility evidence reflects the crash-recovery results. Epic AV (operational telemetry) is closed; Epic BD (trust-boundary security hardening; formerly Epic AW), which ran after the Tooling block (Epics AW–BC), is now also closed — framework-enforced execution bounds, secret isolation across durable/stream/telemetry/transcript surfaces, and the verified approval/untrusted-input trust boundaries all landed in repository reality. With Epic BD closed, the entire production-trust block is complete and the active execution plan is empty.
- **Current capability-orchestration posture:** Epics AW, AX, AY, AZ, BA, and BB are closed. Repository reality now includes: `@tuvren/core/capabilities` subpath with all §3.13 types plus `PolicyCapabilityMetadata`, `CapabilityPolicyEngine`, `TuvrenSandboxExecutor`, `ClientEndpointBoundary`, and `ClientDispatchResult` interfaces; `AttachedClientEndpoint`, `ClientEndpointCapabilityAdvertisement`, `ClientInvocationEnvelope`, `ClientReportedResult` shapes; Capability Registry, Binding & Endpoint Resolver (back-compat `defineTool` → `tuvren-server / tuvren-in-process`; MCP → `tuvren-server / mcp-server`; `metadata.sandbox.endpointId` → `tuvren-server / tuvren-sandbox`; `metadata.clientEndpointId` → `tuvren-client / client-endpoint` or `tuvren-client / mcp-server` for client-side MCP), and Capability Policy Engine wired into tool dispatch with the full BB policy model (BB001 residency, BB002 risk/approval, BB003 active-endpoint/user-presence, BB004 credential-boundary/nonRetryable, BB005 composition/precedence); `TuvrenToolDefinition` extended with `outputSchema?`, `idempotent?`, `maxRetries?`, `riskClass?`, `requiredResidency?`, `requiresUserPresence?`, `requiredCredentialScopes?`, `nonRetryable?`; `AgentConfig` extended with `capabilityPolicyEngine?`, `policyContextInputs?`, `serverExecution?`, `sandboxExecutors?`, `providerNativeTools?`, `providerMediatedTools?`, `clientEndpoints?`, and `clientEndpointBoundary?`; `CapabilityPolicyContextInputs` carries the host-facing BB context dimensions; exposure-time filtering wired in `createRunnerExecutionContext`; resume-path invocation check in `resolveResumeDecision`; `nonRetryable: true` overrides `idempotent: true` in retry budget; `requiresApproval: true` bridges into pending-approval flow; `tuvren-server-execution-class` conformance check set (19 checks, 19/19 pass); `provider-native-execution-class` (10 checks) and `provider-mediated-execution-class` (10 checks) in the `tuvren.providers.provider-api` authority packet; `tuvren-client-execution-class` (13 checks) and `invocation-lifecycle-observation` (19 checks) and `capability-policy` (26 checks) conformance check sets in the `tuvren.shared.core` authority packet (425/425 framework conformance checks pass); `verify:kernel:fresh` passes. The remaining Tooling block (Epic BC) closes out with cross-class integration conformance, framework-spec section, portability inventory, and final verify.
- **Current package/publication posture:** A curated host-facing SDK surface now exists as `@tuvren/core` plus `@tuvren/runtime`, and current source-bearing host-building paths consume those surfaces rather than defining semantics in `runtime-core`, `runtime-api`, `runner-react`, `kernel-runtime`, `core-types`, or `kernel-protocol` directly. `@tuvren/core` now owns the schema-authoring helper surface, and `@tuvren/runtime` currently owns the batteries-included `createTuvren({...})` factory — a current-state fact that ADR-0057 retargets: the target state moves `createTuvren` and the curated re-exports to `@tuvren/sdk` (the composition tier, zero backend/runner/provider dependencies, instances-only options) and demotes `@tuvren/runtime` to an internal engine package excluded from the stable-core guarantee, with hosts importing only `{@tuvren/core, @tuvren/sdk, chosen leaf packages}`. All five old contract handles plus `@tuvren/runtime-core` are gone: `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, `@tuvren/driver-api`, `@tuvren/runtime-core`, and finally `@tuvren/core-types` (removed at KRT-BM006) all completed their one-cycle deprecation window and were removed from the workspace. Final public package publication remains deferred.
- **Current freeze-readiness posture:** `reports/compatibility/compatibility-matrix.json` still records fresh AG-gated evidence for the currently promoted supported applicable surfaces, but that evidence is now historical input to the broader TypeScript productization program rather than the governing readiness claim. The `product proof gate` runs through fresh proving-host evidence in `package.json`, `tools/scripts/verify.ts`, and `reports/compatibility/`; the `platform gate` includes PostgreSQL backend tests, PostgreSQL kernel conformance, and PostgreSQL proving-host reload proof in that same canonical path; the `portability gate` is now enforced by `tools/scripts/portability-gate.ts` (9 packets, 2 standing exceptions, 11 required authoritative sources in `.constitution/reports/epic-al-portability-inventory.json`) as the decisive portability proxy alongside the runner-observed conformance, vocabulary-check, authority-packet validation, plan validation, adapter-protocol validation, meta-conformance, and machine authority guardrail lanes. Per the KRT-AL003 re-entry reassessment at `.constitution/reports/epic-al-rust-re-entry-gate-reassessment.md`, all three staged gates currently pass under fresh evidence; Rust framework/product work remains blocked until a new epic explicitly reopens that scope, names the line, preserves the staged gates as prerequisites under fresh evidence, and adds only the line-specific evidence that goes beyond those gates.
- **Current TypeScript provider-bridge evidence posture:** The shared provider and framework compatibility evidence now describes TypeScript guarantees with framework-mediated capability labels instead of broad native-provider labels. The active TypeScript lane advertises `providers.framework-owned-tool-execution`, `providers.framework-owned-approval-boundary`, and `providers.rejects-native-strict-structured-output`, and the promoted provider or framework plans now prove the fail-closed bridge behavior for strict structured-output requests, provider-owned tool execution or approval surfaces, approval-resume continuity, and resumed event-stream checkpoint or thread association semantics.
- **Current framework orchestration authority posture:** The framework spec, the runtime-api authority packet, the shared orchestration conformance plan, the TypeScript binding appendix, and refreshed compatibility evidence now align on orchestration semantics such as `spawn()`, `allEvents()`, `awaitResult()`, descendant source attribution, run-local worker lifecycle behavior, explicit execution-surface inheritance, nested descendant attribution, handoff resolution boundaries, and worker-forwarded event sources. Remaining documented orchestration, extension, and host-proof semantics that are not yet packet/plan/runner-owned are active portability debt rather than accepted long-lived locality.
- **Current implementation-line gate posture:** TypeScript currently clears the `product proof gate`, `platform gate`, and `portability gate` under the fresh evidence captured by the KRT-AL003 re-entry reassessment. PostgreSQL landed before any Rust framework/product activation, the portability gate is now canonical, and no Rust framework/product line, additional runner family, additional host protocol, additional official backend, or broader provider-family expansion is activated merely because the staged gates pass. Each such future scope requires a new epic that explicitly reopens that work, names the line, preserves the staged gates as prerequisites under fresh evidence, and adds only the line-specific evidence that goes beyond those gates.
- **Current topology posture:** Epic X's boundary-rooted topology (Epic X closure) has since been superseded by the Epic 87 sovereign polyglot restructuring: the repository is now organized as language-neutral authority under `spec/<port>/` (ports: core, providers, tools, runners, streaming, telemetry, host, extensions, interop, kernel), all TypeScript packages under `typescript/<area>/`, all Rust packages under `rust/*`, and repo-global scripts plus the shared conformance harness under `tools/`. Area-scoped testkits live under `typescript/<area>/testkit/` (e.g. `typescript/kernel/testkit/`, `typescript/providers/testkit/`) or, for the shared framework testkit, at the top-level `typescript/testkit/`; `spec/<port>/` roots expose only language-neutral authority (TypeSpec sources, generated JSON Schema/OpenAPI artifacts, authority packets, CDDL, proto) with no `package.json`, `src/`, or other language tooling. Path topology now reveals both port ownership and language ownership without opening files. The prior `boundaries/` tree no longer contains any tracked content.
- **Target implementation state:** The package layout and interfaces defined below are the intended implementation target for the first authoritative TypeScript product line, including a serious REPL proving host (sole proving host; `@tuvren/playground-host` retired in this revision), official SQLite and PostgreSQL backends, the curated host-facing SDK consolidated into one shared-primitive `@tuvren/core` package with subpath exports plus the slim `@tuvren/sdk` convenience/composition package (per ADR-0057; `@tuvren/runtime` is the internal engine below it) with its opt-in `@tuvren/sdk/advanced` subpath and the host-facing `@tuvren/kernel-grpc-client` transport leaf for advanced/remote-kernel hosts (per ADR-0059), the construction-time funnel-routing seam with the `TelemetryDestination` contract in `@tuvren/core/telemetry` (per ADR-0058), the landed Schema Authoring Helper and batteries-included composition surfaces, the MCP Client Container as the remaining first-class host-developer tool-source surface, and comprehensive portable conformance across the documented runtime surface except for explicitly external-SDK-dependent integrations such as AG-UI translation and the TypeScript-only AI SDK bridge implementation.
- **Drift rule:** The future codebase must conform to this TechSpec. The TechSpec must not be treated as a loose commentary on whatever structure happens to emerge.


## 2.1 Compatibility Record

- **Kernel identity compatibility:** Changes to deterministic CBOR profile, SHA-256 usage, hash string representation, or durable record shapes are semver-major.
- **Framework public API compatibility:** Breaking changes to exported TypeScript library contracts require a semver-major release.
- **Runner compatibility:** Changes to shared runner-selection semantics or runner-neutral framework contracts are semver-major; adding a new runner is semver-minor unless it changes existing shared contracts.
- **Backend compatibility:** All official backends must preserve the same kernel semantics. Physical schemas may differ by backend.
- **Provider compatibility:** AI SDK bridge upgrades may happen in minor releases only if the Tuvren-owned provider contract remains unchanged and contract fixtures still pass. Baseline AI SDK bridge compatibility is anchored to `LanguageModelV3`; adding `LanguageModelV2` compatibility later is additive only if it does not widen or weaken the Tuvren-owned provider contract.
- **Contract artifact compatibility:** Framework/provider contract versions, emitted JSON Schema artifacts, and emitted OpenAPI artifacts follow their owning boundary’s compatibility rules and are reviewed outputs of authored sources rather than independent contracts.
- **Conformance compatibility:** Normative fixture schemas, scenario identity, and suite semantics version independently from implementation packages. Behavior changes require explicit suite-version or compatibility-policy updates.
- **Interop transport compatibility:** Cross-process transport versions evolve independently from npm package or crate versions. Buf breaking policy must guard `.proto` changes once the interop surface exists.
- **Compatibility ledger posture:** `reports/compatibility/` records measured implementation parity and is not a public support matrix unless a later release policy explicitly promotes it.
- **Authority packet compatibility:** Each Authority Packet manifest carries its own `version`. Adding declared sources, generated artifacts, conformance plans, or binding projections is minor; removing a declared authoritative source, removing a referenced conformance plan, or relaxing a declared forbidden authority source is major. Conformance plans referenced by a manifest version-track independently and follow conformance-suite compatibility rules.
- **Generated artifact freshness:** Per ADR-0027, every artifact declared as generated under an Authority Packet manifest is regenerated and diff-checked in CI. A drifting generated artifact is treated as a contract change for the purpose of release gating.
- **Kernel syscall surface compatibility:** Per ADR-0034, adding a new syscall is semver-minor for the kernel protocol when it is capability-gated and existing backends remain conformant (e.g. `thread.list`). Removing a syscall, changing an existing syscall's parameters or return shape, or introducing a non-gated syscall that existing backends cannot satisfy is semver-major.
- **Handle terminal-value compatibility:** Per ADR-0035, adding `awaitResult` to the base `ExecutionHandle` is semver-minor because no existing implementation declared that the base handle lacked the method; existing hosts that drained `events()` to detect completion continue to work. Adding fields to `ExecutionResult` is semver-minor. Removing fields or changing the discriminant is semver-major.
- **Durable-read surface compatibility:** Per ADR-0036, adding new durable-read methods to `TuvrenRuntime` is semver-minor. Changing pagination shape (cursor vs. offset; sync vs. iterator) is semver-major. Adding cursor payload fields is semver-minor (forward-compatible decode); removing them is semver-major.
- **Package layout compatibility:** Per ADR-0037, retiring `@tuvren/core-types`, `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, `@tuvren/driver-api` in favor of `@tuvren/core` subpaths is semver-major for those package handles, but the deprecated shim packages preserve a one-cycle migration window. Internal workspace consumers migrate in the same atomic epic; external consumers (when the packages publish) get one cycle of deprecation warnings before removal. That one-cycle window has since elapsed for all five handles — `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, `@tuvren/driver-api`, and (at KRT-BM006) `@tuvren/core-types` — which are now fully removed from the workspace.
- **Schema authoring helper compatibility:** Per ADR-0038, adding a new accepted schema authoring kind is semver-minor; changing the detection precedence order is semver-major.
- **MCP client compatibility:** Per ADR-0039, `@tuvren/mcp-client` follows semver. Bumping the upstream `@modelcontextprotocol/sdk` to a new minor that maintains MCP protocol compatibility is internal; bumping to a new MCP protocol major requires a `@tuvren/mcp-client` major.
- **Batteries-included composition compatibility:** Per ADR-0040, adding a new `BackendKind` or `RunnerKind` is semver-minor; changing the default `runner` is semver-major; renaming `CreateTuvrenOptions` fields is semver-major.
- **Reference host transcript compatibility:** Per ADR-0041 and §3.9, transcript file format versioning is independent of `@tuvren/repl-host` package version. Format version `v: 1` is forward-compatible across runtime minor versions. Format major bumps require an explicit transcript-replay version negotiation.
- **Operational telemetry compatibility:** Per ADR-0042, adding the `@tuvren/core/telemetry` subpath and the `TuvrenTelemetrySink` interface is semver-minor. The canonical telemetry vocabulary (`spec/telemetry/semconv/tuvren-runtime.yaml`) versions independently as boundary-owned authority; adding semconv attributes is minor, removing or renaming one is major. `@tuvren/telemetry-otel` is an implementation-specific projection that follows its own semver and is not part of the portable cross-language surface.
- **Execution bounds compatibility:** Per ADR-0043, adding the `ExecutionBounds` type and the `bounds` option is semver-minor, and the new `execution_bound_exceeded` code is additive. Changing a default bound value is semver-minor but must be called out in release notes because it changes observable stop behavior. Reusing the existing `failed` `ExecutionResult` discriminant keeps ADR-0035's union semver-stable.
- **Secret isolation compatibility:** Per ADR-0044, the transcript-header redaction, the telemetry attribute allowlist, and sanitized telemetry error summaries are additive and semver-minor; transcripts recorded before redaction remain replayable because replay never depended on transcript-embedded secrets. Tightening the redaction or sanitization set later is semver-minor.
- **Recovery verification compatibility:** Per ADR-0045, the fault-injection seam is testkit-only and carries no public-runtime compatibility surface. Strengthening `kernel-restart-recovery.json` with the `kernel-crash-recovery` check set follows conformance-suite compatibility rules; a backend that newly fails the strengthened plan is treated as a bug, not a contract relaxation.
- **Capability orchestration compatibility:** Per ADR-0046 and ADR-0047, adding the `@tuvren/core/capabilities` subpath and the capability/surface/binding/endpoint/execution-class/observation/policy types is semver-minor and additive. The existing `TuvrenToolDefinition` (`@tuvren/core/tools`) is unchanged and is defined as the Tuvren-server execution-class binding, so existing hosts and the boundary `CustomSchema` contract are unaffected. Adding the execution-class and `owner` attribution dimension to canonical tool/capability events (§4.5) and operational telemetry (§3.10) is additive (new optional fields). Adding the `capability_binding_unavailable` error code is additive. Adding a new `ExecutionClass` or `EndpointKind` value is semver-minor; removing one or changing an existing member of the closed `ExecutionClass` set is semver-major. Implementation is phased across the active Tooling block (Epics AW–BC): Epic AW lands the foundation and Epics AX–BC land the per-class and cross-class depth.
