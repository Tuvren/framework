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
│   │                                        # and driver-api/ contract subtrees per ADR-037 —
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
│   │   ├── mcp/                             # ADR-039: authority packet for MCP tool-source
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
│   ├── core/                                # @tuvren/core (ADR-037 consolidation target)
│   │   └── src/
│   │       ├── index.ts                     # root export (errors, primitive types)
│   │       ├── messages/
│   │       ├── tools/                       # includes defineTool, FlexibleSchema, asSchema,
│   │       │                                # jsonSchema, zodSchema, standardSchema
│   │       ├── capabilities/                # ADR-046: ToolSurface, Capability, ExecutionClass,
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
│   │       └── telemetry/                   # ADR-042: TuvrenTelemetrySink + telemetry record types;
│   │                                        # ADR-058 adds TelemetryDestination (funnel-routing contract)
│   ├── core-types/                          # deprecated shim package (console.warn re-export);
│   │                                        # scheduled for removal, retained on disk today
│   ├── runtime/                             # @tuvren/runtime (ADR-040, demoted per ADR-057):
│   │                                        # internal engine package consumed via @tuvren/sdk;
│   │                                        # not host-facing, excluded from the stable-core guarantee;
│   │                                        # src/lib/ absorbs the former runtime-core package
│   │   └── src/lib/
│   ├── sdk/                                 # @tuvren/sdk (ADR-057): the slim convenience/composition
│   │                                        # tier — createTuvren + curated re-exports + schema/codec
│   │                                        # helpers; peer-deps @tuvren/core, deps @tuvren/runtime;
│   │                                        # zero backend/runner/provider dependencies
│   ├── kernel/
│   │   ├── protocol/                        # @tuvren/kernel-protocol; kernel-types.ts lives at
│   │   │                                    # src/lib/kernel-types.ts and is NOT absorbed into
│   │   │                                    # @tuvren/core/execution by ADR-037
│   │   ├── runtime/                         # @tuvren/kernel-runtime
│   │   ├── backends/
│   │   │   ├── memory/
│   │   │   ├── sqlite/
│   │   │   └── postgres/
│   │   ├── testkit/                         # kernel testkit; owns createFaultInjectingBackend (ADR-045)
│   │   ├── conformance-adapter/
│   │   ├── certification/
│   │   ├── certification-sqlite/
│   │   └── certification-postgres/
│   ├── providers/
│   │   ├── provider-api/                    # NOTE: provider-api is a separate leaf package
│   │   │                                    # (peer-depends on @tuvren/core per ADR-037);
│   │   │                                    # the @tuvren/core/provider subpath absorbs the
│   │   │                                    # provider-facing types formerly in @tuvren/runtime-api,
│   │   │                                    # NOT the provider-api contract itself
│   │   ├── bridge-ai-sdk/                   # @tuvren/provider-bridge-ai-sdk
│   │   ├── testkit/                         # includes mock MCP server harness
│   │   ├── conformance-adapter/
│   │   └── certification/
│   ├── tools/
│   │   └── mcp-client/                      # @tuvren/mcp-client (ADR-039)
│   ├── runners/
│   │   └── react/                           # @tuvren/runner-react; peerDep @tuvren/core
│   │                                        # (renamed from @tuvren/driver-react at M6)
│   ├── streaming/
│   │   ├── core/                            # peerDep @tuvren/core
│   │   ├── sse/                             # peerDep @tuvren/core
│   │   └── agui/                            # peerDep @tuvren/core
│   ├── telemetry/
│   │   ├── semconv/
│   │   └── otel/                            # @tuvren/telemetry-otel (ADR-042); peerDep @tuvren/core
│   ├── host/
│   │   └── repl/                            # @tuvren/repl-host; sole proving host
│   │                                        # (per ADR-041 playground/ is retired; the
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

Per ADR-026, every contract surface that has crossed Epic Y promotion also
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
- Top-level directories outside `spec/`, `typescript/`, and `rust/` are reserved for global human authority (`docs/`, `.constitution/`), repo-global tooling (`tools/`), root workspace files, and generated reports (`reports/`).
- The current repo-root `tests/` tree is a deliberate transitional exception to that top-level posture until its normative assets are migrated into port-owned `spec/conformance/<port>/` trees.
- Each port owns its own neutral authority tree under `spec/<port>/` (and `spec/conformance/<port>/` for conformance plans, fixtures, and scenarios) when those concerns exist for that port; implementation code for the same port lives under `typescript/<area>/` and/or `rust/<area>/`.
- Language-specific code lives under `typescript/<area>/...` or `rust/<area>/...`, and any checked-in generated language bindings belong under the consuming implementation tree rather than a shared root generated directory.
- Per ADR-022, every directory is either language-neutral (under `spec/`) or language-specific (exclusively under `typescript/<area>/...` or `rust/<area>/...`). No language-specific build manifest, source directory, or generated binding may live at a `spec/<port>/` or `spec/conformance/<port>/` root. This rule covers `package.json`, `Cargo.toml`, `tsup.config.ts`, `tsconfig*.json`, `src/`, `dist/`, `test/`, `bench/`, `smoke/`, `node_modules/`, `target/`, and any other language-tooling output. Testkits live under `typescript/<area>/testkit/` (or the shared `typescript/testkit/`), never at a `spec/` root.
- Nx manages orchestration and target naming. Nx does not define the repo ontology and must delegate actual work to the native toolchain for the language or artifact family involved.
- The consolidated `@tuvren/core` package (`typescript/core/`, neutral authority at `spec/core/`) must remain the single home for truly cross-boundary primitives. It must not become a semantic dumping ground or a backdoor TypeScript convenience layer.
- Contract-driven components such as backends, provider surfaces, runner contracts, tool contracts, event vocabulary, conformance suites, and interop seams must have an explicit port-owned home under `spec/<port>/` before any new implementation package is added.
- `spec/core/authority-packet.json` is the machine authority entry for shared framework runtime contracts (this single packet is the ADR-037 / Epic AP consolidation target; the former split `runtime-api`, `event-stream`, `tool-contracts`, and `driver-api` authority packets are absorbed into it). All ten subpath surfaces (`/messages`, `/tools`, `/events`, `/errors`, `/execution`, `/runner`, `/provider`, `/extensions`, `/telemetry`, `/capabilities`) are declared as binding sections within this single packet. Compatibility re-exports from the deprecated split packages (including `@tuvren/core-types`) remain valid binding projections for one release cycle.
- Where a stable language-neutral structure exists, TypeScript adopts it first so later languages inherit a real system rather than a permanent TypeScript exception.
- Per ADR-023, ADR-024, ADR-025, ADR-026, ADR-027, and ADR-028, every cross-implementation semantic surface must own one Authority Packet manifest declaring its authoritative sources, generated artifacts, conformance plans, binding projections, and forbidden authority sources. Implementation-language source trees, generic conformance runner source, and Markdown documents are forbidden authority sources for any cross-implementation semantic; they may project, validate, or describe authority but cannot become it. Generic runners must own only generic mechanics and consume product semantics from conformance plans referenced by an authority packet.
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
  - unit tests for pure logic in `typescript/core` (the consolidated `@tuvren/core` package per ADR-037), `typescript/kernel/protocol`, `typescript/kernel/backends/memory`, `typescript/kernel/backends/sqlite`, `typescript/kernel/backends/postgres`, `typescript/runtime` (the internal engine package per ADR-040/ADR-057), `typescript/sdk` (the composition tier per ADR-057), `typescript/runners/react`, and `typescript/tools/mcp-client` (per ADR-039)
  - unit tests for the Schema Authoring Helper detection precedence (per ADR-038) covering at least: wrapped schema branch, Zod v4 branch, Zod v3 via Standard Schema branch, Standard Schema non-zod branch, lazy function branch, and bare TuvrenJsonSchema branch, plus the ambiguous-case fixtures named in ADR-038
  - unit tests for the `createTuvren` batteries-included composition across constructed instances of all three official backends and the `aimock-openai` provider (per ADR-057 the string-kind shorthands are retired; the composition tests pass constructed backend/runner instances)
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
  - per ADR-042, operational-telemetry tests that drive a deterministic turn and assert the expected lineage-keyed spans/events for turn, iteration, model, tool, checkpoint, approval transitions, and error paths through an in-memory capture sink, plus a targeted restart/recovery fixture for recovery telemetry and an implementation-specific `@tuvren/telemetry-otel` mapping test
  - per ADR-043, execution-bounds tests asserting that exceeding the hard-stop bounds (`maxIterations`, `maxToolCalls`, `maxWallClockMs`) yields a `failed` result with code `execution_bound_exceeded` and correct `details`, that the canonical stream emits the matching fatal `error` event before the failed terminal `turn.end`, that a configured capture sink observes the `execution.bounded` telemetry event for each hard-stop breach, that `AgentConfig.maxIterations` is clamped by `bounds.maxIterations`, that `maxConcurrentToolCalls` is enforced by throttling tool concurrency to the configured cap, that `AgentConfig.maxParallelToolCalls` and `defaultMaxParallelToolCalls` are clamped by that cap rather than bypassing it, that invalid non-finite or non-positive bound configuration is rejected, and that within-bounds turns are unaffected, using a runaway aimock runner fixture
  - per ADR-044, secret-isolation tests asserting through a shared runner-owned secret-absence helper that a configured provider key plus MCP bearer-auth and header-auth secrets, along with common encoded variants, never appear in persisted kernel records, captured canonical stream events, captured telemetry attributes or error summaries, or a recorded transcript
  - per ADR-045, crash-recovery tests using `createFaultInjectingBackend` that inject faults at each commit point and under a concurrent writer, asserting resume-or-fail-clean with no torn or partial lineage across the SQLite and PostgreSQL backends
- **Observability Hooks:**
  - structured logger interface injected at runtime boundaries
  - event tee support for tests and host adapters
  - stable metric names for turn count, iteration count, provider latency, tool latency, checkpoint count, and recovery count
  - `telemetry/semconv/tuvren-runtime.yaml` is the authored OpenTelemetry semantic-convention source for current and future implementation lines
  - reviewed outputs such as `telemetry/semantic-conventions.md` and `telemetry/otel-attributes.json` are derived from that source
  - generated TypeScript and Rust constants or helpers derived from the telemetry semantic-convention source belong under the consuming implementation trees, not under a shared root generated directory
  - OpenTelemetry attribute conventions cover run id, turn id, branch id, runner id, tool call id, checkpoint hash, parent checkpoint hash, resumed-from hash, backend id, and provider id
  - per ADR-042, the runtime emits to a first-class `TuvrenTelemetrySink` (`@tuvren/core/telemetry`) at turn/run/iteration/model/tool/checkpoint/recovery/bounded-execution/error points, reusing the canonical event vocabulary so telemetry and the event stream cannot diverge; the default sink is `NoopTelemetrySink` and the OpenTelemetry projection lives in the implementation-specific `@tuvren/telemetry-otel`
  - per ADR-044, no secret material may reach the canonical event stream, telemetry sink, durable kernel records, or transcripts; host-supplied telemetry attributes pass through a semconv allowlist, telemetry error summaries are sanitized before emission, and transcript headers redact backend credential fields
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
- Adding, removing, or changing an Authority Packet manifest, a referenced Conformance Plan, a generated artifact declared in a manifest, the Compatibility Ledger Contract, or the Implementation Adapter Protocol requires a TechSpec update in the same change. ADR-023 through ADR-033 are not advisory: a future contributor may not satisfy a cross-implementation semantic claim by editing implementation source, runner source, adapter evidence, or Markdown alone.
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
- The v0.7.0 constitutional revision realized through ADR-034 through ADR-041 (Epics AM-AT) is closed in repository reality.
- The v0.8.0 production-trust revision realized through ADR-042 through ADR-045 remains the active forward path. Epic AU (fault-injection-verified crash recovery) is closed in repository reality; Epics AV and AW remain active in `Tasks.md`.
- Rust framework/product work, future provider-family expansion beyond MCP-as-tool-source, future host protocols, additional official backends, and future runner families remain blocked until a new epic explicitly reopens that scope and re-satisfies the staged gates in `5.4` under fresh evidence. The production-trust block does not reopen any of those lines; it hardens the existing TypeScript line.

### 5.5 Migration Plans for the v0.27.0 Revision

This section consolidates the bounded migration actions implied by ADR-034 through ADR-041. Each migration is in scope for one or more execution epics specified in `Tasks.md`; this section names what must be done and in what order, not who does it or when.

#### 5.5.1 Kernel Syscall Addition (ADR-034)

Order within one epic:
1. Bump `docs/KrakenKernelSpecification.md` to v0.10. Correct every "28 operations" mention to "30 operations." Add a new `thread.list` syscall section with full validation rules, the `KernelThreadListCursor` shape, and the `thread.enumeration` capability gate.
2. Update `spec/kernel/authority-packet.json` to declare the new syscall surface and bump its packet version.
3. Add `thread.list` to the TypeScript `RuntimeKernel` interface in `typescript/kernel/protocol/src/lib/kernel-types.ts`. This file lives in `@tuvren/kernel-protocol` — it is NOT absorbed into `@tuvren/core/execution` by ADR-037; kernel-protocol is outside ADR-037's absorption list.
4. Implement `thread.list` in the in-memory backend (`typescript/kernel/backends/memory/`): trivial `Array.from(state.threads.values())` with sort by `(createdAtMs, threadId)` and cursor-based pagination.
5. Implement `thread.list` in the SQLite backend (`typescript/kernel/backends/sqlite/`): `SELECT * FROM threads WHERE (created_at_ms, thread_id) > (?, ?) [AND schema_id = ?] ORDER BY created_at_ms ASC, thread_id ASC LIMIT ?`. Add a covering index on `(created_at_ms, thread_id)`.
6. Implement `thread.list` in the PostgreSQL backend (`typescript/kernel/backends/postgres/`): identical SQL with PostgreSQL parameter binding; covering index per backend migration.
7. Update each backend's `capabilities()` accessor to return `{ "thread.enumeration": true }`.
8. Add `thread.list` to `typescript/kernel/runtime/` so the TS `RuntimeKernel` dispatches to the backend's `ThreadRepository.list` when the capability bit is true; otherwise throws `TuvrenPersistenceError` code `kernel_capability_unsupported`.
9. Add `thread_list` to the Rust `InMemoryKernel` at `rust/kernel/src/memory.rs`. Add it to the Rust capability descriptor.
10. Add `ThreadList` RPC to `spec/interop/proto/tuvren/kernel/interop/v1/kernel_services.proto`. Define `ThreadListRequest` and `ThreadListResponse` messages in `kernel_types.proto`. Run `bun run codegen` to regenerate TypeScript bindings under `typescript/runtime/src/lib/generated/kernel-interop/` (this is the current location after the ADR-040 runtime-core fold).
11. Implement the new RPC in the Rust gRPC service at `rust/kernel-grpc-service/src/lib.rs`.
12. Add a `thread.list` codec call in the TypeScript `createGrpcRuntimeKernel` adapter.
13. Add `kernel-protocol.thread.enumeration` check set to all four kernel conformance plans (`kernel-protocol-core.json`, `kernel-protocol-extended.json`, `kernel-restart-recovery.json`, `kernel-run-liveness.json`) with per-capability applicability.
14. Run `bun run verify` from a clean checkout; capture fresh compatibility evidence.

#### 5.5.2 Handle Terminal-Value Promotion (ADR-035)

Order within one epic (may co-execute with §5.5.1 if epic capacity allows):
1. Bump `docs/KrakenFrameworkSpecification.md` to v0.18 to add `awaitResult` to base `ExecutionHandle`.
2. Update the `ExecutionHandle` and `OrchestrationHandle` interfaces in `@tuvren/core/execution` (post-ADR-037) to add `awaitResult` and the `ExecutionResult` / `OrchestrationResult` discriminated unions.
3. Implement `awaitResult` on `RuntimeExecutionHandle` in the runtime implementation: collect events into a private buffer (already happening for `events()`), resolve on the first `turn.end` event, synthesize the result from the final assistant message in collected events plus `status()`.
4. Implement `awaitResult` on `OrchestrationHandleImpl` to aggregate `childResults` from spawned child handles' own `awaitResult` resolutions; the existing internal `awaitResult` becomes the parent half of this.
5. Migrate the two existing `awaitResult` conformance checks from `spec/conformance/engine/plans/runtime-api-orchestration.json` to a new check set `runtime-api-handle-terminal-value` in `runtime-api-callables.json`; the orchestration plan keeps its subtree-result-specific checks.
6. Update the `@tuvren/core` authority packet binding appendix at `spec/core/bindings/typescript.md` (the ADR-037 consolidation target for the former runtime-api binding appendix) to add `awaitResult` to the `ExecutionHandle` binding section.
7. Delete the REPL host's hand-rolled completion derivation in `startProjectionCapture`; replace with `handle.awaitResult()`.

#### 5.5.3 Durable-Read Surface (ADR-036)

Order within one epic (must follow §5.5.1 for `thread.list` and §5.5.2 for `awaitResult`):
1. Add the five durable-read method signatures to the `TuvrenRuntime` interface in `@tuvren/core/execution`. Export the supporting types (`ThreadSummary`, `BranchSummary`, `TurnSnapshot`, all three cursor types).
2. Implement the surface in a new `durable-reads.ts` module under `typescript/runtime/src/lib/` (the ADR-040 location; the former separate `runtime-core/src/lib/` package no longer exists):
   - `listThreads` composes `kernel.thread.list(options)`
   - `listBranches` composes `kernel.branch.list(threadId)`
   - `getTurnState` composes `kernel.branch.get` (for head fallback) + `kernel.node.get` + `kernel.tree.manifest` + `kernel.store.get` for each manifest reference relevant to the requested shape
   - `getTurnHistory` returns an async iterator that walks `kernel.node.walkBack` lazily, applying the `before` cursor and `limit` constraints
   - `readBranchMessages` composes `kernel.branch.get` + `kernel.tree.resolve(treeHash, "messages")` + `kernel.store.get` per message hash, with cursor-based pagination over the ordered messages path
3. Implement cursor encode/decode helpers per §3.8; reject malformed cursors with `TuvrenValidationError` code `invalid_durable_read_cursor`.
4. Add the `runtime-api-durable-reads` check set to `spec/conformance/engine/plans/runtime-api-callables-extended.json` with positive-path, pagination, capability-rejected (for `listThreads`), and lineage-bounded coverage. Run against all three backends; verify that the capability-rejected path is exercised against a synthetic non-enumerating backend in the framework testkit.
5. Delete `createPlaygroundKernelInspector` from `@tuvren/repl-host`; replace its three call sites (`readBranchMessages`, `readBranchStatus`, `readBranchEvents` equivalent) with `runtime.readBranchMessages` and `runtime.getTurnState`.

#### 5.5.4 Package Consolidation (ADR-037)

Order within one epic (must be atomic — no intermediate state where some leaves are migrated and others are not):
1. Create the `typescript/core/` workspace package `@tuvren/core` with the source directory layout shown in §5.1 (`src/index.ts` + 8 subpath directories). (Realized: `typescript/core/` is the live package today.)
2. Move source from the pre-consolidation contract packages into `@tuvren/core`'s subpath directories:
   - the former `core-types` implementation source → `@tuvren/core/src/errors/` + `@tuvren/core/src/index.ts` (split error sources from primitive types); the old `@tuvren/core-types` workspace handle survives today only as the deprecated shim described in step 10
   - the former `runtime-api` implementation source → split across `@tuvren/core/src/messages/`, `@tuvren/core/src/execution/`, `@tuvren/core/src/extensions/`, `@tuvren/core/src/provider/` (using the existing internal `runtime-contract-shapes.ts` decomposition as a guide); no separate `runtime-api` implementation directory exists today
   - the former `event-stream` implementation source → `@tuvren/core/src/events/`; no separate `event-stream` implementation directory exists today
   - the former `tool-contracts` implementation source → `@tuvren/core/src/tools/`; no separate `tool-contracts` implementation directory exists today
   - the former `driver-api` implementation source → `@tuvren/core/src/runner/` (subpath renamed from `driver` to `runner` at the M6 rename); no separate `driver-api` implementation directory exists today
3. Configure `package.json` exports field with 9 entries (root + 8 subpaths), each with `import` and `types` conditions pointing at the compiled `dist/<subpath>/index.js` and `dist/<subpath>/index.d.ts`.
4. Configure `tsup.config.ts` with 9 entries; one per export.
5. Declare `zod` and `@standard-schema/spec` as optional `peerDependencies` in `@tuvren/core`'s `package.json` with `peerDependenciesMeta.<name>.optional = true`. Do not also list them as `optionalDependencies` — that would auto-install them from the registry and defeat the consumer-choice contract.
6. Merge the former `runtime-api` authority packet and the other three contract packets into the single `spec/core/authority-packet.json` declaring the eight then-current subpath surfaces as binding sections. Later work may add additional binding sections (for example ADR-042 adds `/telemetry`). TypeSpec sources for the merged packet live at `spec/core/typespec/`.
7. Update `tools/scripts/portability-gate.ts` to expect the new packet layout (8 packets instead of 12).
8. Run one mechanical codemod across the workspace replacing imports:
   - `from "@tuvren/core-types"` → split between `from "@tuvren/core/errors"` and `from "@tuvren/core"` based on what's imported
   - `from "@tuvren/runtime-api"` → split across `from "@tuvren/core/execution"`, `from "@tuvren/core/messages"`, `from "@tuvren/core/provider"`, `from "@tuvren/core/extensions"` based on what's imported
   - `from "@tuvren/event-stream"` → `from "@tuvren/core/events"`
   - `from "@tuvren/tool-contracts"` → `from "@tuvren/core/tools"`
   - `from "@tuvren/driver-api"` → `from "@tuvren/core/runner"`
9. Replace each leaf package's `dependencies` declaration of the five retired packages with a single `peerDependencies` entry on `@tuvren/core`.
10. Leave deprecated shim packages at the old workspace handles for one cycle: `@tuvren/core-types`, `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, `@tuvren/driver-api` each contain only an `index.ts` that re-exports from `@tuvren/core/*` with a development-mode `console.warn`. `@tuvren/core-types` (`typescript/core-types/`) is still present on disk today in exactly this shim form; the other four have already been fully removed.
11. Fold `@tuvren/runtime-core` into `@tuvren/runtime`: move source from the former `runtime-core/src/` package into `typescript/runtime/src/lib/` (replacing the current thin barrel). The `@tuvren/runtime` package becomes the slim convenience package per ADR-040. (Realized: `typescript/runtime/src/lib/` is the live location; the separate `runtime-core` package no longer exists.)
12. Run `bun install`, `bun run typecheck`, `bun run lint`, `bun run test`, `bun run conformance`, `bun run codegen`, `bun run verify` from a clean checkout; everything must pass before merge.

#### 5.5.5 Schema Authoring Helper (ADR-038)

Order within one epic (must follow §5.5.4):
1. In `@tuvren/core/tools`, add the `Schema<T>` branded type, `schemaSymbol`, `FlexibleSchema<INPUT>` union, `ZodSchema<T>`, `StandardSchema<T>`, `LazySchema<T>` type exports.
2. Implement `asSchema<T>(schema: FlexibleSchema<T>): Schema<T>` with the six-branch precedence from ADR-038. Borrow the detection logic from the AI SDK source's `asSchema` (BSD-3 license-compatible re-implementation; do not copy the source).
3. Implement `jsonSchema<T>(schema, opts?)`, `zodSchema<T>(schema)`, `standardSchema<T>(schema)`.
4. Implement `defineTool({...})` which normalizes the `inputSchema` once via `asSchema` and returns a `TuvrenToolDefinition` with the normalized schema in `inputSchema`.
5. Add `runtime-api-schema-authoring` check set to `spec/conformance/engine/plans/runtime-api-callables-extended.json` with at least one fixture per precedence branch including the ambiguous cases listed in ADR-038.
6. Re-export `defineTool`, `asSchema`, `jsonSchema`, `zodSchema`, `standardSchema` from `@tuvren/runtime`'s curated re-exports.

#### 5.5.6 MCP Client Container (ADR-039)

Order within one epic (may co-execute with §5.5.5):
1. Create new workspace package `@tuvren/mcp-client` under `typescript/tools/mcp-client/`.
2. Declare direct dependencies on `@modelcontextprotocol/sdk@1.29.0` and `zod@4.4.3`, plus a peer dependency on `@tuvren/core`; do not expose `zod` in the public Tuvren peer surface.
3. Implement the internal `MCPClient` interface wrapping the upstream SDK client with one connection-lifecycle surface over both stdio and Streamable HTTP-backed public `http-sse` transports.
4. Implement `createMcpToolSource(options)` and `McpToolSource` per §4.15.
5. Implement the seven translation rules from ADR-039.
6. Create the authority packet at `spec/tools/mcp/authority-packet.json` declaring the translation contract.
7. Create the `providers-mcp-client.json` conformance plan exercising the translation rules and transport-error normalization. Exercise both transports against the same scenario set.
8. Add a mock MCP server to `@tuvren/provider-testkit` for use in the conformance plan and downstream host tests.
9. Re-export `createMcpToolSource` from `@tuvren/runtime`'s curated re-exports.

#### 5.5.7 Batteries-Included Composition (ADR-040)

Order within one epic (must follow §5.5.4; §5.5.6 / MCP runs after, not before):
1. Implement `createTuvren(options)` in `@tuvren/runtime`'s root `index.ts` per §4.16.
2. Rename the internal `createTuvrenRuntimeCore` to `createTuvrenRuntime`; export the latter from `@tuvren/runtime`'s curated re-exports along with `createTuvren`.
3. Implement the resource cleanup paths so `[Symbol.asyncDispose]` closes MCP sources, releases backend handles, and drains kernel work.
4. Add the `runtime-api-batteries-included` check set to `runtime-api-callables-extended.json` exercising compositional correctness across all three backend kinds and the `aimock-openai` provider.

#### 5.5.8 Reference Host Consolidation (ADR-041)

Order within one epic (must follow §5.5.3 to remove the kernel inspector, §5.5.5–§5.5.7 to consume the new helpers):
1. Delete the former `hosts/implementations/typescript/playground/` package entirely, along with the `@tuvren/playground-host` workspace package, and remove all references in Nx targets, `package.json` workspace scripts, and `tools/scripts/`. (Realized: this deletion is complete in repo reality; `@tuvren/playground-host` and its directory no longer exist anywhere in the repository.)
2. Rename internal files in `@tuvren/repl-host` per ADR-041: `playground-config.ts` → `repl-config.ts`, `playground-host.ts` → `repl-host.ts`, `playground-kernel.ts` → **deleted**, `playground-matrix.ts` → `repl-scenario-matrix.ts`, `playground-provider.ts` → `repl-provider.ts`, `playground-scenarios-support.ts` → `repl-scenarios-support.ts`, `playground-scenarios.ts` → `repl-scenarios.ts`, `playground-tools.ts` → `repl-builtin-tools.ts`, `playground-types.ts` → `repl-types.ts`. Rename all internal type names (`PlaygroundConfig` → `ReplConfig`, etc.); the existing public alias barrel in `src/index.ts` becomes the actual definitions.
3. Replace all reads through the deleted `createPlaygroundKernelInspector` with calls to `runtime.readBranchMessages` and `runtime.getTurnState` (already enabled by §5.5.3).
4. Add `repl-headless-mode.ts` implementing the headless stdin loop per §4.17 and ADR-041.
5. Add `repl-transcript.ts` implementing the JSONL writer/reader per §3.9.
6. Update `cli.ts` to parse `--headless`, `--record <path>`, `--replay <path>` flags.
7. Add the `proving-host-headless-transcript-replay` check set to `runtime-api-callables-extended.json` exercising a deterministic record-and-replay cycle.
8. Update `proving-host:scenario-*` Nx targets to exercise both interactive and headless modes against the same scenarios.

### 5.6 Migration Plans for the v0.28.0 Production-Trust Revision

This section consolidates the bounded migration actions implied by ADR-042 through ADR-045. Epics AU, AV, and BD are all complete and are retained below as current-state closure context (ADR-045, ADR-042, and ADR-043/ADR-044 respectively). Epic BD (formerly Epic AW) realized framework-enforced execution bounds and secret isolation across the framework runtime and independently verified that approval gates are non-bypassable and untrusted MCP/tool inputs are validated before execution; with its closure the active execution plan in `Tasks.md` is empty. The telemetry secret-screening helpers from §5.6.3 had already landed because the closed telemetry sink (§5.6.2) consumes them.

#### 5.6.1 Recovery and Durability Verification (ADR-045, Epic AU)

Closed outcome:
1. Added `createFaultInjectingBackend(inner, plan)` and the `FaultPlan` type (§3.12) to `@tuvren/kernel-testkit`, with test-only commit-phase hooks for true `mid-commit` injection on the supported durable backends and checks that no production package imports the seam.
2. Added the `kernel-crash-recovery` check set to `spec/conformance/kernel/plans/kernel-restart-recovery.json` with per-capability applicability: durable-restart subset for SQLite/PostgreSQL, in-process atomicity + concurrency subset for memory.
3. Recorded the new check set in the kernel authority packet at `spec/kernel/authority-packet.json` and bumped its packet version.
4. Ran the strengthened plan against memory, SQLite, and PostgreSQL. No storage atomicity bug was exposed in the official TypeScript backends; the validation-path drift exposed by the run was corrected without weakening the conformance plan.
5. Added a normative "Crash Recovery Invariant" note to `docs/KrakenKernelSpecification.md` stating the resume-or-fail-clean guarantee the plan verifies.
6. Refreshed checked-in compatibility evidence for the strengthened crash-recovery results.

#### 5.6.2 Operational Telemetry Surface (ADR-042, Epic AV)

Closed outcome:
1. Added the `./telemetry` subpath to `@tuvren/core` with `TuvrenTelemetrySink`, `TelemetrySpan`, `TelemetryEvent`, `TelemetryLineage`, `TelemetrySpanKind`, `TelemetryEventKind`, and `NoopTelemetrySink`; generated the telemetry JSON schemas; and bumped the shared core authority packet with the telemetry binding section.
2. Wired `@tuvren/runtime` emission through a host-owned sink at the runtime's existing turn, iteration, model, tool, checkpoint, approval, and error producers. Throwing sinks are isolated and warned once. `CreateTuvrenOptions` and `RuntimeCoreOptions` accept `telemetry?: TuvrenTelemetrySink`, with duplicate top-level/nested configuration rejected as `invalid_createtuvren_options`.
3. Added the telemetry attribute allowlist and telemetry-error sanitizer from §5.6.3 before records reach the sink.
4. Created `@tuvren/telemetry-otel` under `typescript/telemetry/otel/`, peer-depending on `@tuvren/core`, with exact `@opentelemetry/api@1.9.1` and `@opentelemetry/sdk-trace-base@2.7.1` test dependency pins.
5. Added the `framework-operational-telemetry.json` plan (check set `runtime-api-operational-telemetry`), in-memory capture support in the framework testkit, and authority-packet discovery for the plan.
6. Re-exported `NoopTelemetrySink` plus the telemetry record types from `@tuvren/runtime`; registered the OTel projection as a standing implementation-specific portability exception in the live JSON/Markdown inventory.

#### 5.6.3 Secret Isolation (ADR-044, Epic BD; allowlist consumed by AV)

Closed outcome:
1. Closed earlier with Epic AV: added the telemetry attribute allowlist helper (keys declared in `telemetry/semconv/tuvren-runtime.yaml` only; reject credential-shaped keys and drop or sanitize secret-like values on otherwise allowed keys) and the telemetry-error-summary sanitizer consumed by §5.6.2 step 3. If a future operational telemetry attribute is required (for example bounded-execution `bound` / `limit` / `observed`), update that semconv source in the same change before the allowlist admits it.
2. KRT-BD002: added the backend-options redactor and non-secret backend identity descriptor to `@tuvren/repl-host`'s `repl-transcript.ts`; the transcript header masks PostgreSQL `connectionString` / `password` and any credential-shaped backend option (libpq and cloud aliases included) to `"***"` while retaining non-secret identity sufficient for replay topology (§3.9 constraint, format `v: 1` compatible). Replay reconstructs the backend from non-secret options plus environment-supplied credentials; a transcript recorded before redaction remains replayable.
3. KRT-BD003: documented edge-confinement in the `@tuvren/mcp-client` and `@tuvren/provider-bridge-ai-sdk` READMEs and staged reusable secret-isolation fixtures (representative provider key plus MCP bearer-auth and header-auth values) under `spec/conformance/providers/fixtures/` for the BD004 absence checks.
4. KRT-BD004: added the `secret-isolation` check set to `providers-mcp-client.json`, `framework-operational-telemetry.json`, and `runtime-api-callables-extended.json`. A fixture configures a provider key plus MCP bearer-auth and header-auth secrets and runs a turn; a new shared runner-owned secret-absence helper (`tools/conformance/harness/secret-absence/`, exposed through the `secretAbsence` assertion kind) recursively scans the raw observation surfaces and asserts that neither the raw secrets nor their common derived leak forms — bearer-prefixed, header-normalized, URL-encoded, base64/base64url-encoded, and partial-token — appear in persisted kernel records, captured canonical stream events, captured telemetry attributes or error summaries, or the in-process recorded transcript. The runner owns every verdict; adapters supply only raw surfaces and the configured secret values.
5. KRT-BD008: ran the full clean `bun run verify` (exit 0) with refreshed compatibility evidence.

#### 5.6.4 Framework-Enforced Execution Bounds (ADR-043, Epic BD)

Closed outcome:
1. KRT-BD005: added `ExecutionBounds` and `ExecutionBoundExceededDetails` (§3.11) to `@tuvren/core/execution`; documented the `execution_bound_exceeded` code in `@tuvren/core/errors`; added the cooperative `TuvrenPrompt.signal` cancellation field to the provider contract authority owned by `spec/providers/` (with its TypeScript implementation at `typescript/providers/provider-api/`); and updated the shared core execution sources/generated artifacts/merged authority packet plus the provider-api sources/generated artifacts/authority packet with the required packet-version bumps. `ExecutionBoundExceededDetails.bound` is the three-value union `"maxIterations" | "maxToolCalls" | "maxWallClockMs"`; `maxConcurrentToolCalls` is intentionally excluded because it is a concurrency throttle, never a terminal bound.
2. KRT-BD006: implemented the bounds guard in `@tuvren/runtime`'s turn/run orchestration shell — enforces `maxIterations` and `maxToolCalls` at iteration and tool-batch boundaries above runner discretion, clamps `AgentConfig.maxIterations` by `bounds.maxIterations`, wraps the whole turn in a `maxWallClockMs` deadline that propagates an abort signal through `TuvrenPrompt.signal` and `ToolExecutionContext.signal` (forwarded by the owned `bridge-ai-sdk` and owned tool paths), ignores late completions after abort, and enforces `maxConcurrentToolCalls` by throttling tool concurrency to the configured cap. A breached hard-stop bound finalizes a `failed` `ExecutionResult` with code `execution_bound_exceeded` and `details`, emits the fatal canonical `error` event carrying the same code/details before the failed `turn.end`, resolves the abandoned tool work to the terminal `ignored` `InvocationLifecycleState`, and emits the `execution.bounded` telemetry event when a sink is configured. Invalid non-integer/non-finite/non-positive bounds are rejected at construction, and supplying both top-level and nested `bounds` is rejected as `invalid_createtuvren_options`.
3. KRT-BD006: added `bounds?: ExecutionBounds` to `CreateTuvrenOptions` and `RuntimeCoreOptions` with the safe defaults from §3.11 (64 / 256 / 600_000 / 16); added the `execution.bounded` attributes to the semconv source and regenerated the telemetry allowlist in the same change before admitting them.
4. KRT-BD007: added the `runtime-api-execution-bounds` check set to `runtime-api-callables-extended.json` using a runaway aimock runner fixture that always requests continuation; asserts each hard-stop bound's breach result and details, the fatal `error` event before the failed `turn.end`, observation of the `execution.bounded` telemetry event through a configured capture sink, clamping of `AgentConfig.maxIterations` by `bounds.maxIterations`, enforcement of the `maxConcurrentToolCalls` throttle, clamping of `AgentConfig.maxParallelToolCalls` and `defaultMaxParallelToolCalls` by that cap, rejection of invalid bound configuration, signal delivery and late-completion ignoring through owned integrations, and a within-bounds control case.
5. KRT-BD009: added the independent `trust-boundary` check set to `runtime-api-callables-extended.json` and `providers-mcp-client.json`, pinning that approval-gated tool work is non-bypassable, that a local tool-input schema violation surfaces as `tool.result isError: true` with code `tool_input_validation_failed`, and that an MCP-advertised input violation surfaces as `tool.result isError: true` with code `mcp_tool_input_invalid` rejected before transport invocation. No implementation gap was exposed; both validation paths already existed and the check set pins them.
6. KRT-BD008: added the normative "Execution Bounds" section (§4.12) to `docs/KrakenFrameworkSpecification.md` (bumped to v0.20) so future runners inherit the framework-owned guard, extended the docs-to-authority freeze gate with the matching execution-bounds evidence template and classifier, and ran the full clean `bun run verify` (exit 0) with refreshed compatibility evidence reflecting the execution-bounds, secret-isolation, and trust-boundary lanes.

### 5.7 Migration Plans for the v0.29.0 Capability-Orchestration Revision

This section consolidates the bounded migration actions implied by ADR-046 and ADR-047. The conceptual model and contracts are authored above (PRD v0.9.0, Architecture v0.9.0, §3.13, §4.21); the source implementation was captured in `Tasks.md` as the now-closed **Tooling block (Epics AW–BC)**, which preceded the trust block (Epic BD, also closed) and the named-but-not-yet-ticketed productionization roadmap (Epics BE–BI). No code landed from this TechSpec revision itself; it is the contract the Tooling block implemented. The block is "finished" when all four execution classes are orchestrated by the runtime with honest per-class observation/control limits, MCP is classified as a binding across classes, exposure/invocation policy applies, the cross-class invariant is conformance-verified, and the framework specification states the model.

#### 5.7.1 Tooling Block Foundation (ADR-046, ADR-047, Epic AW)

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

Sequencing for ADR-056/057/058 lives in the execution plan (the constitution's tasks layer); this section records only the physical migration constraints the ADRs impose.

#### 5.8.1 Experimental Marker (ADR-056)

1. Tag every export of `@tuvren/core/capabilities` with TSDoc `/** @experimental */`; add the subpath-level notice to its docs.
2. Record the marker declarations in the `spec/core/authority-packet.json` surface listing so gate, docs, and conformance read one source.
3. The API-snapshot gate (built in the freeze epic) consumes tags per the ADR-056 diff table; the consistency floor (untagged export under a declared-experimental subpath fails the build) lands with the gate.

#### 5.8.2 SDK Composition Tier (ADR-057)

1. One coordinated commit resolves the dependency-edge inversion: remove `@tuvren/sdk` from `@tuvren/runtime`'s `peerDependencies`, add `@tuvren/runtime` to `@tuvren/sdk`'s `dependencies`, and move `create-tuvren.ts` plus its composition helpers from `typescript/runtime/src/lib/` to `typescript/sdk/src/lib/`. Any intermediate state is a workspace dependency cycle.
2. Retire the ADR-040 string-kind shorthands from `CreateTuvrenOptions` (instances-only shape per ADR-057 §2); update the batteries-included conformance check set to target the `@tuvren/sdk` surface.
3. Remove the curated `@tuvren/core` re-exports from `@tuvren/runtime/src/index.ts`; `@tuvren/sdk` re-exports the curated set alongside `createTuvren`.
4. Re-point the Reference Host: `typescript/host/repl/package.json` drops `@tuvren/runtime`, adds `@tuvren/sdk`; all 14 importing modules migrate to `@tuvren/sdk` / `@tuvren/core` subpaths / leaf-package instances.
5. Add the host-boundary check to the canonical verification path: no import of `@tuvren/runtime`, `@tuvren/kernel-protocol`, or `@tuvren/kernel-runtime` from `typescript/host/**` or documentation examples.
6. Mark `@tuvren/runtime` internal in its `README.md` and `package.json` description.

#### 5.8.3 Two-Funnel Routing Contract (ADR-058)

1. Add `TelemetryDestination` (deliver, buffering descriptor, operational-signal channel) to `@tuvren/core/telemetry`; declare it in the core authority packet's `/telemetry` binding section.
2. Widen the `telemetry` option on `CreateTuvrenOptions` to `TuvrenTelemetrySink | TelemetryDestination | { sink?; destination? }` (backward-compatible pre-freeze widening).
3. Extend the telemetry emission boundary in `typescript/runtime/src/lib/runtime-core-telemetry.ts` with destination delivery + failure-to-operational-signal conversion; no emission path may throw into session execution.
4. Add the funnel-isolation conformance check set (destination healthy-vs-unavailable session equivalence; no content payload on the telemetry funnel under default routing; failure-to-signal mapping). No proto change: kernel interop stays funnel-unaware.
5. Official destination adapter packages are deferred per CAP-P1-073 and ship additively post-freeze.
