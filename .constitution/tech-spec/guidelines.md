## 5. Implementation Guidelines

### 5.1 Project Structure

Target implementation layout for the first authoritative TypeScript line plus
the multi-language transition foundation:

```text
.
├── .constitution/
├── docs/
├── telemetry/
│   ├── semconv/
│   │   └── tuvren-runtime.yaml
│   ├── semantic-conventions.md
│   └── otel-attributes.json
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
├── boundaries/
│   ├── framework/
│   │   ├── contracts/
│   │   │   # Per ADR-037, the historical contracts/runtime-api/,
│   │   │   # contracts/event-stream/, contracts/tool-contracts/,
│   │   │   # contracts/driver-api/ subtrees are retired; their
│   │   │   # source moves into boundaries/shared/contracts/core/.
│   │   │   # Deprecated shim packages keep the old @tuvren/* names
│   │   │   # for one cycle as re-exports.
│   │   ├── implementations/
│   │   │   ├── typescript/
│   │   │   │   ├── drivers/
│   │   │   │   │   └── react/                # @tuvren/driver-react; peerDep @tuvren/core
│   │   │   │   ├── runtime/                  # @tuvren/runtime (per ADR-040)
│   │   │   │   │                             # exposes createTuvren + curated re-exports;
│   │   │   │   │                             # absorbs former @tuvren/runtime-core
│   │   │   │   ├── stream-core/              # peerDep @tuvren/core
│   │   │   │   ├── stream-sse/               # peerDep @tuvren/core
│   │   │   │   ├── stream-agui/              # peerDep @tuvren/core
│   │   │   │   ├── telemetry-otel/           # @tuvren/telemetry-otel (ADR-042); peerDep @tuvren/core
│   │   │   │   ├── conformance-adapter/
│   │   │   │   └── testkit/
│   │   │   └── rust/
│   │   │       └── conformance-adapter/
│   │   ├── conformance/
│   │   │   ├── schemas/
│   │   │   ├── fixtures/
│   │   │   ├── plans/                        # runtime-api-*, react-driver-*, event-stream-*,
│   │   │   │                                 # tool-contracts-extended, plus the new
│   │   │   │                                 # runtime-api-durable-reads, runtime-api-handle-
│   │   │   │                                 # terminal-value, runtime-api-schema-authoring,
│   │   │   │                                 # runtime-api-batteries-included,
│   │   │   │                                 # proving-host-headless-transcript-replay, and the
│   │   │   │                                 # production-trust sets (framework-operational-
│   │   │   │                                 # telemetry, runtime-api-execution-bounds,
│   │   │   │                                 # secret-isolation)
│   │   │   └── scenarios/
│   │   └── interop/
│   │       └── rust-kernel/
│   ├── kernel/
│   │   ├── contracts/
│   │   │   └── protocol/
│   │   │       ├── spec/
│   │   │       │   └── cddl/
│   │   │       ├── artifacts/
│   │   │       └── implementations/
│   │   │           └── typescript/
│   │   ├── interop/
│   │   │   └── grpc/
│   │   │       └── proto/                    # neutral .proto authority
│   │   ├── implementations/
│   │   │   ├── typescript/
│   │   │   │   ├── runtime-kernel/
│   │   │   │   ├── backend-memory/
│   │   │   │   ├── backend-sqlite/
│   │   │   │   ├── backend-postgres/
│   │   │   │   ├── conformance-runner/
│   │   │   │   ├── conformance-runner-postgres/
│   │   │   │   └── testkit/                  # kernel testkit; owns createFaultInjectingBackend (ADR-045)
│   │   │   └── rust/
│   │   │       ├── kernel/
│   │   │       ├── grpc-service/
│   │   │       └── conformance-runner/
│   │   └── conformance/
│   │       ├── schemas/
│   │       ├── fixtures/
│   │       └── scenarios/
│   ├── providers/
│   │   ├── contracts/
│   │   │   ├── provider-api/                 # NOTE: provider-api is a separate leaf package
│   │   │   │                                 # (peer-depends on @tuvren/core per ADR-037);
│   │   │   │                                 # the @tuvren/core/provider subpath absorbs the
│   │   │   │                                 # provider-facing types from @tuvren/runtime-api,
│   │   │   │                                 # NOT the provider-api contract itself
│   │   │   └── mcp/                          # ADR-039: new authority packet for MCP tool-source
│   │   │       ├── spec/                     # translation rules and conformance plan
│   │   │       │   └── authority-packet.json
│   │   │       └── README.md
│   │   ├── implementations/
│   │   │   ├── typescript/
│   │   │   │   ├── bridge-ai-sdk/            # @tuvren/provider-bridge-ai-sdk
│   │   │   │   ├── mcp-client/               # @tuvren/mcp-client (ADR-039)
│   │   │   │   ├── conformance-runner/
│   │   │   │   └── testkit/                  # includes mock MCP server harness
│   │   │   └── rust/
│   │   └── conformance/
│   │       ├── schemas/
│   │       ├── fixtures/
│   │       ├── plans/                        # includes the new providers-mcp-client.json plan
│   │       └── scenarios/
│   ├── shared/
│   │   └── contracts/
│   │       └── core/                         # ADR-037: consolidated shared primitive container
│   │           ├── spec/
│   │           │   ├── typespec/             # absorbed from former tool-contracts spec; will
│   │           │   │                         # grow to cover events, execution, driver, provider,
│   │           │   │                         # extensions subpaths as their TypeSpec sources are
│   │           │   │                         # authored
│   │           │   └── authority-packet.json # one merged packet declaring all 9 subpath surfaces
│   │           ├── artifacts/
│   │           │   ├── json-schema/
│   │           │   └── openapi/
│   │           └── implementations/
│   │               └── typescript/           # @tuvren/core with subpath exports
│   │                   ├── src/
│   │                   │   ├── index.ts      # root export (errors, primitive types)
│   │                   │   ├── messages/
│   │                   │   ├── tools/        # includes defineTool, FlexibleSchema, asSchema,
│   │                   │   │                 # jsonSchema, zodSchema, standardSchema
│   │                   │   ├── capabilities/ # ADR-046: ToolSurface, Capability, ExecutionClass,
│   │                   │   │                 # Binding, Endpoint, CapabilityObservation, policy +
│   │                   │   │                 # invocation-attribution shapes
│   │                   │   ├── events/
│   │                   │   ├── errors/
│   │                   │   ├── execution/    # includes ExecutionHandle.awaitResult,
│   │                   │   │                 # ExecutionResult, OrchestrationResult, and the
│   │                   │   │                 # five TuvrenRuntime durable-read methods
│   │                   │   ├── driver/
│   │                   │   ├── provider/
│   │                   │   ├── extensions/
│   │                   │   └── telemetry/    # ADR-042: TuvrenTelemetrySink + telemetry record types
│   │                   ├── tsup.config.ts    # 11 entries: index + 10 subpaths
│   │                   └── package.json      # peerDeps: zod (optional), @standard-schema/spec (optional)
│   └── hosts/
│       └── implementations/
│           └── typescript/
│               └── repl/                     # @tuvren/repl-host; sole proving host
│                                             # (per ADR-041 playground/ is retired)
└── tests/                                    # transitional until normative assets are migrated
```

Every contract directory carries language-neutral assets (`spec/`,
`artifacts/`, `README.md`) at its root and houses each language implementation
under a sibling `implementations/<lang>/` subtree. A contract surface that has
not yet authored a neutral source still keeps its TypeScript implementation
under `implementations/typescript/`, and its `spec/` directory remains a
placeholder until a later epic authors the neutral source. Boundary-level
testkits live under `implementations/<lang>/testkit/` rather than at the
boundary root, because a testkit is always language-specific harness code over
the language-neutral `conformance/` assets.

Per ADR-026, every contract surface that has crossed Epic Y promotion also
carries one Authority Packet manifest at
`boundaries/<area>/contracts/<surface>/spec/authority-packet.json` (or the
equivalent path under `conformance/spec/` or `interop/<channel>/spec/` for
behavior- or interop-rooted packets). Per Epic Y, conformance plans for a
boundary live under `boundaries/<area>/conformance/plans/`; the shared
semantic runner target lives under `tools/conformance/runner/`; the
implementation adapter protocol lives under
`tools/conformance/adapter-protocol/`; and the authority-packet and
conformance-plan JSON Schemas live under `tools/schemas/`.

### 5.1.1 Structure Rules

- The repository is architecture-first and language-neutral at the top level.
- `boundaries/` is the universal home for boundary-owned implementation code plus boundary-owned machine-readable contract, conformance, and interop assets.
- Top-level directories outside `boundaries/` are reserved for global human authority (`docs/`, `.constitution/`), repo-global tooling (`tools/`), repo-global observability conventions (`telemetry/`), root workspace files, and generated reports (`reports/`).
- The current repo-root `tests/` tree is a deliberate transitional exception to that top-level posture until its normative assets are migrated into boundary-owned `conformance/` trees.
- Each architectural boundary owns its own `contracts/`, `implementations/`, `conformance/`, and `interop/` trees when those concerns exist for that boundary.
- Language-specific code lives under `implementations/<language>/...`, and any checked-in generated language bindings belong under the consuming implementation tree rather than a shared root generated directory.
- Per ADR-022, every directory under `boundaries/` is either language-neutral (at boundary, contract, conformance, or interop roots) or language-specific (exclusively under `implementations/<language>/...`). No language-specific build manifest, source directory, or generated binding may live at a boundary, contract, conformance, or interop root. This rule covers `package.json`, `Cargo.toml`, `tsup.config.ts`, `tsconfig*.json`, `src/`, `dist/`, `test/`, `bench/`, `smoke/`, `node_modules/`, `target/`, and any other language-tooling output. Boundary-level testkits live under `boundaries/<area>/implementations/<language>/testkit/`, never at the boundary root.
- Nx manages orchestration and target naming. Nx does not define the repo ontology and must delegate actual work to the native toolchain for the language or artifact family involved.
- `shared/` must remain small and contain only truly cross-boundary primitives. It must not become a semantic dumping ground or a backdoor TypeScript convenience layer.
- Contract-driven components such as backends, provider surfaces, driver contracts, tool contracts, event vocabulary, conformance suites, and interop seams must have an explicit boundary-owned home before any new implementation package is added.
- `boundaries/shared/contracts/core/spec/authority-packet.json` is the machine authority entry for shared framework runtime contracts (replaces the former `boundaries/framework/contracts/runtime-api/spec/authority-packet.json`, which is absorbed into the merged core packet by ADR-037 / Epic AP). All ten subpath surfaces (`/messages`, `/tools`, `/events`, `/errors`, `/execution`, `/driver`, `/provider`, `/extensions`, `/telemetry`, `/capabilities`) are declared as binding sections within this single packet. Compatibility re-exports from the deprecated split packages remain valid binding projections for one release cycle.
- Where a stable language-neutral structure exists, TypeScript adopts it first so later languages inherit a real system rather than a permanent TypeScript exception.
- Per ADR-023, ADR-024, ADR-025, ADR-026, ADR-027, and ADR-028, every cross-implementation semantic surface must own one Authority Packet manifest declaring its authoritative sources, generated artifacts, conformance plans, binding projections, and forbidden authority sources. Implementation-language source trees, generic conformance runner source, and Markdown documents are forbidden authority sources for any cross-implementation semantic; they may project, validate, or describe authority but cannot become it. Generic runners must own only generic mechanics and consume product semantics from conformance plans referenced by an authority packet.
- Per the final Epic Y conformance-engine adjustment, implementation language trees may host `conformance-adapter/` code that invokes native logic and returns neutral observations. Assertion evaluation, required-evidence enforcement, capability selection, adapter-error isolation, and compatibility evidence emission belong in the shared runner under `tools/conformance/runner/`, not in language adapter hosts.
- Per Epic AG, promoted conformance adapters must expose raw `result`, `events`, and `state` observations and may expose diagnostic/provenance `evidence`; they must not expose semantic verdict proxies through evidence, import semantic verifier/assertion helpers, or depend on implementation-local `/test/` harnesses as the main proof path unless a boundary-owned testkit contract explicitly allows it.

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
  - unit tests for pure logic in `shared/contracts/core/implementations/typescript` (the consolidated `@tuvren/core` package per ADR-037), `kernel/contracts/protocol/implementations/typescript`, `kernel/implementations/typescript/backend-memory`, `kernel/implementations/typescript/backend-sqlite`, `kernel/implementations/typescript/backend-postgres`, `framework/implementations/typescript/runtime` (the consolidated convenience package per ADR-040), `framework/implementations/typescript/drivers/react`, and `providers/implementations/typescript/mcp-client` (per ADR-039)
  - unit tests for the Schema Authoring Helper detection precedence (per ADR-038) covering at least: wrapped schema branch, Zod v4 branch, Zod v3 via Standard Schema branch, Standard Schema non-zod branch, lazy function branch, and bare TuvrenJsonSchema branch, plus the ambiguous-case fixtures named in ADR-038
  - unit tests for the `createTuvren` batteries-included composition across all three `BackendKind` values and the `aimock-openai` provider
  - unit tests for transcript JSONL writer/reader round-trips covering every record kind in §3.9
  - unit tests for durable-read cursor encode/decode round-trips and rejection of malformed cursors
  - golden-byte tests for deterministic CBOR encodings
  - hash identity fixtures for opaque bytes and structured records
  - shared backend contract tests that every official backend must pass
  - recovery and checkpoint scenario tests covering pause/resume, reactive checkpointing, and rollback archival
  - driver contract and framework-runtime integration tests that keep shared framework services distinct from ReAct-specific behavior
  - AI SDK bridge contract tests
  - a shared semantic conformance runner that consumes boundary-owned plans and drives implementation-language adapter hosts without redefining semantics locally
  - compatibility-matrix generation from actual conformance and interop-smoke results
  - runtime portability tests for core packages on Bun and Node; Deno compatibility tests for core non-native packages as soon as package surfaces stabilize
  - per ADR-042, operational-telemetry tests that drive a deterministic turn and assert the expected lineage-keyed spans/events for turn, iteration, model, tool, checkpoint, approval transitions, and error paths through an in-memory capture sink, plus a targeted restart/recovery fixture for recovery telemetry and an implementation-specific `@tuvren/telemetry-otel` mapping test
  - per ADR-043, execution-bounds tests asserting that exceeding the hard-stop bounds (`maxIterations`, `maxToolCalls`, `maxWallClockMs`) yields a `failed` result with code `execution_bound_exceeded` and correct `details`, that the canonical stream emits the matching fatal `error` event before the failed terminal `turn.end`, that a configured capture sink observes the `execution.bounded` telemetry event for each hard-stop breach, that `AgentConfig.maxIterations` is clamped by `bounds.maxIterations`, that `maxConcurrentToolCalls` is enforced by throttling tool concurrency to the configured cap, that `AgentConfig.maxParallelToolCalls` and `defaultMaxParallelToolCalls` are clamped by that cap rather than bypassing it, that invalid non-finite or non-positive bound configuration is rejected, and that within-bounds turns are unaffected, using a runaway aimock driver fixture
  - per ADR-044, secret-isolation tests asserting through a shared runner-owned secret-absence helper that a configured provider key plus MCP bearer-auth and header-auth secrets, along with common encoded variants, never appear in persisted kernel records, captured canonical stream events, captured telemetry attributes or error summaries, or a recorded transcript
  - per ADR-045, crash-recovery tests using `createFaultInjectingBackend` that inject faults at each commit point and under a concurrent writer, asserting resume-or-fail-clean with no torn or partial lineage across the SQLite and PostgreSQL backends
- **Observability Hooks:**
  - structured logger interface injected at runtime boundaries
  - event tee support for tests and host adapters
  - stable metric names for turn count, iteration count, provider latency, tool latency, checkpoint count, and recovery count
  - `telemetry/semconv/tuvren-runtime.yaml` is the authored OpenTelemetry semantic-convention source for current and future implementation lines
  - reviewed outputs such as `telemetry/semantic-conventions.md` and `telemetry/otel-attributes.json` are derived from that source
  - generated TypeScript and Rust constants or helpers derived from the telemetry semantic-convention source belong under the consuming implementation trees, not under a shared root generated directory
  - OpenTelemetry attribute conventions cover run id, turn id, branch id, driver id, tool call id, checkpoint hash, parent checkpoint hash, resumed-from hash, backend id, and provider id
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
- Changes that alter the driver model, driver-neutral framework surface, or the ReAct Driver’s role as the initial baseline require a TechSpec update in the same change.
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
- Rust framework/product work, future provider-family expansion beyond MCP-as-tool-source, future host protocols, additional official backends, and future driver families remain blocked until a new epic explicitly reopens that scope and re-satisfies the staged gates in `5.4` under fresh evidence. The production-trust block does not reopen any of those lines; it hardens the existing TypeScript line.

### 5.5 Migration Plans for the v0.27.0 Revision

This section consolidates the bounded migration actions implied by ADR-034 through ADR-041. Each migration is in scope for one or more execution epics specified in `Tasks.md`; this section names what must be done and in what order, not who does it or when.

#### 5.5.1 Kernel Syscall Addition (ADR-034)

Order within one epic:
1. Bump `docs/KrakenKernelSpecification.md` to v0.10. Correct every "28 operations" mention to "30 operations." Add a new `thread.list` syscall section with full validation rules, the `KernelThreadListCursor` shape, and the `thread.enumeration` capability gate.
2. Update `boundaries/kernel/contracts/protocol/spec/authority-packet.json` to declare the new syscall surface and bump its packet version.
3. Add `thread.list` to the TypeScript `RuntimeKernel` interface in `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-types.ts`. This file lives in `@tuvren/kernel-protocol` — it is NOT absorbed into `@tuvren/core/execution` by ADR-037; kernel-protocol is outside ADR-037's absorption list.
4. Implement `thread.list` in the in-memory backend (`boundaries/kernel/implementations/typescript/backend-memory/`): trivial `Array.from(state.threads.values())` with sort by `(createdAtMs, threadId)` and cursor-based pagination.
5. Implement `thread.list` in the SQLite backend (`boundaries/kernel/implementations/typescript/backend-sqlite/`): `SELECT * FROM threads WHERE (created_at_ms, thread_id) > (?, ?) [AND schema_id = ?] ORDER BY created_at_ms ASC, thread_id ASC LIMIT ?`. Add a covering index on `(created_at_ms, thread_id)`.
6. Implement `thread.list` in the PostgreSQL backend (`boundaries/kernel/implementations/typescript/backend-postgres/`): identical SQL with PostgreSQL parameter binding; covering index per backend migration.
7. Update each backend's `capabilities()` accessor to return `{ "thread.enumeration": true }`.
8. Add `thread.list` to `boundaries/kernel/implementations/typescript/runtime-kernel/` so the TS `RuntimeKernel` dispatches to the backend's `ThreadRepository.list` when the capability bit is true; otherwise throws `TuvrenPersistenceError` code `kernel_capability_unsupported`.
9. Add `thread_list` to the Rust `InMemoryKernel` at `boundaries/kernel/implementations/rust/kernel/src/memory.rs`. Add it to the Rust capability descriptor.
10. Add `ThreadList` RPC to `boundaries/kernel/interop/grpc/proto/tuvren/kernel/interop/v1/kernel_services.proto`. Define `ThreadListRequest` and `ThreadListResponse` messages in `kernel_types.proto`. Run `bun run codegen` to regenerate TypeScript bindings under `boundaries/framework/implementations/typescript/runtime/src/lib/generated/kernel-interop/` (or wherever ADR-037 places them after the runtime-core fold).
11. Implement the new RPC in the Rust gRPC service at `boundaries/kernel/implementations/rust/grpc-service/src/lib.rs`.
12. Add a `thread.list` codec call in the TypeScript `createGrpcRuntimeKernel` adapter.
13. Add `kernel-protocol.thread.enumeration` check set to all four kernel conformance plans (`kernel-protocol-core.json`, `kernel-protocol-extended.json`, `kernel-restart-recovery.json`, `kernel-run-liveness.json`) with per-capability applicability.
14. Run `bun run verify` from a clean checkout; capture fresh compatibility evidence.

#### 5.5.2 Handle Terminal-Value Promotion (ADR-035)

Order within one epic (may co-execute with §5.5.1 if epic capacity allows):
1. Bump `docs/KrakenFrameworkSpecification.md` to v0.18 to add `awaitResult` to base `ExecutionHandle`.
2. Update the `ExecutionHandle` and `OrchestrationHandle` interfaces in `@tuvren/core/execution` (post-ADR-037) to add `awaitResult` and the `ExecutionResult` / `OrchestrationResult` discriminated unions.
3. Implement `awaitResult` on `RuntimeExecutionHandle` in the runtime implementation: collect events into a private buffer (already happening for `events()`), resolve on the first `turn.end` event, synthesize the result from the final assistant message in collected events plus `status()`.
4. Implement `awaitResult` on `OrchestrationHandleImpl` to aggregate `childResults` from spawned child handles' own `awaitResult` resolutions; the existing internal `awaitResult` becomes the parent half of this.
5. Migrate the two existing `awaitResult` conformance checks from `boundaries/framework/conformance/plans/runtime-api-orchestration.json` to a new check set `runtime-api-handle-terminal-value` in `runtime-api-callables.json`; the orchestration plan keeps its subtree-result-specific checks.
6. Update the runtime-api authority packet binding appendix (`boundaries/framework/contracts/runtime-api/spec/bindings/typescript.md`, or post-ADR-037 location) to add `awaitResult` to the `ExecutionHandle` binding section.
7. Delete the REPL host's hand-rolled completion derivation in `startProjectionCapture`; replace with `handle.awaitResult()`.

#### 5.5.3 Durable-Read Surface (ADR-036)

Order within one epic (must follow §5.5.1 for `thread.list` and §5.5.2 for `awaitResult`):
1. Add the five durable-read method signatures to the `TuvrenRuntime` interface in `@tuvren/core/execution`. Export the supporting types (`ThreadSummary`, `BranchSummary`, `TurnSnapshot`, all three cursor types).
2. Implement the surface in a new `durable-reads.ts` module under `boundaries/framework/implementations/typescript/runtime/src/lib/` (post-ADR-040 location, formerly `runtime-core/src/lib/`):
   - `listThreads` composes `kernel.thread.list(options)`
   - `listBranches` composes `kernel.branch.list(threadId)`
   - `getTurnState` composes `kernel.branch.get` (for head fallback) + `kernel.node.get` + `kernel.tree.manifest` + `kernel.store.get` for each manifest reference relevant to the requested shape
   - `getTurnHistory` returns an async iterator that walks `kernel.node.walkBack` lazily, applying the `before` cursor and `limit` constraints
   - `readBranchMessages` composes `kernel.branch.get` + `kernel.tree.resolve(treeHash, "messages")` + `kernel.store.get` per message hash, with cursor-based pagination over the ordered messages path
3. Implement cursor encode/decode helpers per §3.8; reject malformed cursors with `TuvrenValidationError` code `invalid_durable_read_cursor`.
4. Add the `runtime-api-durable-reads` check set to `boundaries/framework/conformance/plans/runtime-api-callables-extended.json` with positive-path, pagination, capability-rejected (for `listThreads`), and lineage-bounded coverage. Run against all three backends; verify that the capability-rejected path is exercised against a synthetic non-enumerating backend in the framework testkit.
5. Delete `createPlaygroundKernelInspector` from `@tuvren/repl-host`; replace its three call sites (`readBranchMessages`, `readBranchStatus`, `readBranchEvents` equivalent) with `runtime.readBranchMessages` and `runtime.getTurnState`.

#### 5.5.4 Package Consolidation (ADR-037)

Order within one epic (must be atomic — no intermediate state where some leaves are migrated and others are not):
1. Create new `boundaries/shared/contracts/core/implementations/typescript/` workspace package `@tuvren/core` with the source directory layout shown in §5.1 (`src/index.ts` + 8 subpath directories).
2. Move source from:
   - `boundaries/shared/contracts/core-types/implementations/typescript/src/` → `@tuvren/core/src/errors/` + `@tuvren/core/src/index.ts` (split error sources from primitive types)
   - `boundaries/framework/contracts/runtime-api/implementations/typescript/src/` → split across `@tuvren/core/src/messages/`, `@tuvren/core/src/execution/`, `@tuvren/core/src/extensions/`, `@tuvren/core/src/provider/` (using the existing internal `runtime-contract-shapes.ts` decomposition as a guide)
   - `boundaries/framework/contracts/event-stream/implementations/typescript/src/` → `@tuvren/core/src/events/`
   - `boundaries/framework/contracts/tool-contracts/implementations/typescript/src/` → `@tuvren/core/src/tools/`
   - `boundaries/framework/contracts/driver-api/implementations/typescript/src/` → `@tuvren/core/src/driver/`
3. Configure `package.json` exports field with 9 entries (root + 8 subpaths), each with `import` and `types` conditions pointing at the compiled `dist/<subpath>/index.js` and `dist/<subpath>/index.d.ts`.
4. Configure `tsup.config.ts` with 9 entries; one per export.
5. Declare `zod` and `@standard-schema/spec` as optional `peerDependencies` in `@tuvren/core`'s `package.json` with `peerDependenciesMeta.<name>.optional = true`. Do not also list them as `optionalDependencies` — that would auto-install them from the registry and defeat the consumer-choice contract.
6. Merge `boundaries/framework/contracts/runtime-api/spec/authority-packet.json` and the other three contract packets into a single new `boundaries/shared/contracts/core/spec/authority-packet.json` declaring the eight then-current subpath surfaces as binding sections. Later work may add additional binding sections (for example ADR-042 adds `/telemetry`). Move existing TypeSpec sources to `boundaries/shared/contracts/core/spec/typespec/`.
7. Update `tools/scripts/portability-gate.ts` to expect the new packet layout (8 packets instead of 12).
8. Run one mechanical codemod across the workspace replacing imports:
   - `from "@tuvren/core-types"` → split between `from "@tuvren/core/errors"` and `from "@tuvren/core"` based on what's imported
   - `from "@tuvren/runtime-api"` → split across `from "@tuvren/core/execution"`, `from "@tuvren/core/messages"`, `from "@tuvren/core/provider"`, `from "@tuvren/core/extensions"` based on what's imported
   - `from "@tuvren/event-stream"` → `from "@tuvren/core/events"`
   - `from "@tuvren/tool-contracts"` → `from "@tuvren/core/tools"`
   - `from "@tuvren/driver-api"` → `from "@tuvren/core/driver"`
9. Replace each leaf package's `dependencies` declaration of the five retired packages with a single `peerDependencies` entry on `@tuvren/core`.
10. Leave deprecated shim packages at the old workspace handles for one cycle: `@tuvren/core-types`, `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, `@tuvren/driver-api` each contain only an `index.ts` that re-exports from `@tuvren/core/*` with a development-mode `console.warn`. They are removed in the next minor release.
11. Fold `@tuvren/runtime-core` into `@tuvren/runtime`: move source from `boundaries/framework/implementations/typescript/runtime-core/src/` into `boundaries/framework/implementations/typescript/runtime/src/lib/` (replacing the current thin barrel). The `@tuvren/runtime` package becomes the slim convenience package per ADR-040.
12. Run `bun install`, `bun run typecheck`, `bun run lint`, `bun run test`, `bun run conformance`, `bun run codegen`, `bun run verify` from a clean checkout; everything must pass before merge.

#### 5.5.5 Schema Authoring Helper (ADR-038)

Order within one epic (must follow §5.5.4):
1. In `@tuvren/core/tools`, add the `Schema<T>` branded type, `schemaSymbol`, `FlexibleSchema<INPUT>` union, `ZodSchema<T>`, `StandardSchema<T>`, `LazySchema<T>` type exports.
2. Implement `asSchema<T>(schema: FlexibleSchema<T>): Schema<T>` with the six-branch precedence from ADR-038. Borrow the detection logic from the AI SDK source's `asSchema` (BSD-3 license-compatible re-implementation; do not copy the source).
3. Implement `jsonSchema<T>(schema, opts?)`, `zodSchema<T>(schema)`, `standardSchema<T>(schema)`.
4. Implement `defineTool({...})` which normalizes the `inputSchema` once via `asSchema` and returns a `TuvrenToolDefinition` with the normalized schema in `inputSchema`.
5. Add `runtime-api-schema-authoring` check set to `boundaries/framework/conformance/plans/runtime-api-callables-extended.json` with at least one fixture per precedence branch including the ambiguous cases listed in ADR-038.
6. Re-export `defineTool`, `asSchema`, `jsonSchema`, `zodSchema`, `standardSchema` from `@tuvren/runtime`'s curated re-exports.

#### 5.5.6 MCP Client Container (ADR-039)

Order within one epic (may co-execute with §5.5.5):
1. Create new workspace package `@tuvren/mcp-client` under `boundaries/providers/implementations/typescript/mcp-client/`.
2. Declare direct dependencies on `@modelcontextprotocol/sdk@1.29.0` and `zod@4.4.3`, plus a peer dependency on `@tuvren/core`; do not expose `zod` in the public Tuvren peer surface.
3. Implement the internal `MCPClient` interface wrapping the upstream SDK client with one connection-lifecycle surface over both stdio and Streamable HTTP-backed public `http-sse` transports.
4. Implement `createMcpToolSource(options)` and `McpToolSource` per §4.15.
5. Implement the seven translation rules from ADR-039.
6. Create the authority packet at `boundaries/providers/contracts/mcp/spec/authority-packet.json` declaring the translation contract.
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
1. Delete `boundaries/hosts/implementations/typescript/playground/` entirely. Delete the `@tuvren/playground-host` workspace package. Remove all references in Nx targets, `package.json` workspace scripts, `tools/scripts/`.
2. Rename internal files in `@tuvren/repl-host` per ADR-041: `playground-config.ts` → `repl-config.ts`, `playground-host.ts` → `repl-host.ts`, `playground-kernel.ts` → **deleted**, `playground-matrix.ts` → `repl-scenario-matrix.ts`, `playground-provider.ts` → `repl-provider.ts`, `playground-scenarios-support.ts` → `repl-scenarios-support.ts`, `playground-scenarios.ts` → `repl-scenarios.ts`, `playground-tools.ts` → `repl-builtin-tools.ts`, `playground-types.ts` → `repl-types.ts`. Rename all internal type names (`PlaygroundConfig` → `ReplConfig`, etc.); the existing public alias barrel in `src/index.ts` becomes the actual definitions.
3. Replace all reads through the deleted `createPlaygroundKernelInspector` with calls to `runtime.readBranchMessages` and `runtime.getTurnState` (already enabled by §5.5.3).
4. Add `repl-headless-mode.ts` implementing the headless stdin loop per §4.17 and ADR-041.
5. Add `repl-transcript.ts` implementing the JSONL writer/reader per §3.9.
6. Update `cli.ts` to parse `--headless`, `--record <path>`, `--replay <path>` flags.
7. Add the `proving-host-headless-transcript-replay` check set to `runtime-api-callables-extended.json` exercising a deterministic record-and-replay cycle.
8. Update `proving-host:scenario-*` Nx targets to exercise both interactive and headless modes against the same scenarios.

### 5.6 Migration Plans for the v0.28.0 Production-Trust Revision

This section consolidates the bounded migration actions implied by ADR-042 through ADR-045. Epics AU and AV are complete and retained below as current-state closure context for ADR-045 and ADR-042. Epic BD (formerly Epic AW) remains active execution scope in `Tasks.md`, sequenced after the Tooling block (Epics AW–BC): BD (execution bounds + secret isolation) touches the framework/kernel runtime. The telemetry secret-screening helpers from §5.6.3 have landed because the closed telemetry sink (§5.6.2) consumes them.

#### 5.6.1 Recovery and Durability Verification (ADR-045, Epic AU)

Closed outcome:
1. Added `createFaultInjectingBackend(inner, plan)` and the `FaultPlan` type (§3.12) to `@tuvren/kernel-testkit`, with test-only commit-phase hooks for true `mid-commit` injection on the supported durable backends and checks that no production package imports the seam.
2. Added the `kernel-crash-recovery` check set to `boundaries/kernel/conformance/plans/kernel-restart-recovery.json` with per-capability applicability: durable-restart subset for SQLite/PostgreSQL, in-process atomicity + concurrency subset for memory.
3. Recorded the new check set in the kernel authority packet at `boundaries/kernel/contracts/protocol/spec/authority-packet.json` and bumped its packet version.
4. Ran the strengthened plan against memory, SQLite, and PostgreSQL. No storage atomicity bug was exposed in the official TypeScript backends; the validation-path drift exposed by the run was corrected without weakening the conformance plan.
5. Added a normative "Crash Recovery Invariant" note to `docs/KrakenKernelSpecification.md` stating the resume-or-fail-clean guarantee the plan verifies.
6. Refreshed checked-in compatibility evidence for the strengthened crash-recovery results.

#### 5.6.2 Operational Telemetry Surface (ADR-042, Epic AV)

Closed outcome:
1. Added the `./telemetry` subpath to `@tuvren/core` with `TuvrenTelemetrySink`, `TelemetrySpan`, `TelemetryEvent`, `TelemetryLineage`, `TelemetrySpanKind`, `TelemetryEventKind`, and `NoopTelemetrySink`; generated the telemetry JSON schemas; and bumped the shared core authority packet with the telemetry binding section.
2. Wired `@tuvren/runtime` emission through a host-owned sink at the runtime's existing turn, iteration, model, tool, checkpoint, approval, and error producers. Throwing sinks are isolated and warned once. `CreateTuvrenOptions` and `RuntimeCoreOptions` accept `telemetry?: TuvrenTelemetrySink`, with duplicate top-level/nested configuration rejected as `invalid_createtuvren_options`.
3. Added the telemetry attribute allowlist and telemetry-error sanitizer from §5.6.3 before records reach the sink.
4. Created `@tuvren/telemetry-otel` under `boundaries/framework/implementations/typescript/telemetry-otel/`, peer-depending on `@tuvren/core`, with exact `@opentelemetry/api@1.9.1` and `@opentelemetry/sdk-trace-base@2.7.1` test dependency pins.
5. Added the `framework-operational-telemetry.json` plan (check set `runtime-api-operational-telemetry`), in-memory capture support in the framework testkit, and authority-packet discovery for the plan.
6. Re-exported `NoopTelemetrySink` plus the telemetry record types from `@tuvren/runtime`; registered the OTel projection as a standing implementation-specific portability exception in the live JSON/Markdown inventory.

#### 5.6.3 Secret Isolation (ADR-044, Epic BD; allowlist consumed by AV)

Order:
1. Closed with Epic AV: added the telemetry attribute allowlist helper (keys declared in `telemetry/semconv/tuvren-runtime.yaml` only; reject credential-shaped keys and drop or sanitize secret-like values on otherwise allowed keys) and the telemetry-error-summary sanitizer consumed by §5.6.2 step 3. If a future operational telemetry attribute is required (for example bounded-execution `bound` / `limit` / `observed`), update that semconv source in the same change before the allowlist admits it.
2. Add the backend-options redactor and non-secret backend identity descriptor to `@tuvren/repl-host`'s `repl-transcript.ts`; mask PostgreSQL `connectionString` / `password` in the transcript header (§3.9 constraint). Confirm replay reconstructs from non-secret options plus environment credentials.
3. Document edge-confinement in `@tuvren/mcp-client` and `@tuvren/provider-bridge-ai-sdk` READMEs and fixtures.
4. Add the `secret-isolation` check set to `providers-mcp-client.json`, `framework-operational-telemetry.json`, and `runtime-api-callables-extended.json`: configure a provider key plus MCP bearer-auth and header-auth secrets, run a turn, and use a shared runner-owned secret-absence helper to assert that neither raw nor commonly encoded variants of those secrets appear in persisted records, captured canonical stream events, captured telemetry attributes or error summaries, or a recorded transcript.
5. Run `bun run verify`.

#### 5.6.4 Framework-Enforced Execution Bounds (ADR-043, Epic BD)

Order:
1. Add `ExecutionBounds` and `ExecutionBoundExceededDetails` (§3.11) to `@tuvren/core/execution`; document the `execution_bound_exceeded` code in `@tuvren/core/errors`; add `TuvrenPrompt.signal` to the provider contract authority owned by `boundaries/providers/contracts/provider-api/`; and update the shared core execution sources/generated artifacts/merged authority packet plus the provider-api sources/generated artifacts/authority packet, including the required packet-version bumps.
2. Implement the bounds guard in `@tuvren/runtime`'s turn/run orchestration shell: enforce `maxIterations` and `maxToolCalls` at iteration and tool-batch boundaries, clamp `AgentConfig.maxIterations` by `bounds.maxIterations`, wrap the whole turn in a `maxWallClockMs` deadline that propagates an abort signal through `TuvrenPrompt.signal` and `ToolExecutionContext.signal`, ignore late completions after abort, and enforce `maxConcurrentToolCalls` by throttling tool concurrency to the configured cap. Finalize a breached hard-stop bound as a `failed` `ExecutionResult` with code `execution_bound_exceeded`, emit the fatal canonical `error` event carrying the same code/details, then emit the matching `turn.end` event and bounded-execution telemetry event.
3. Add `bounds?: ExecutionBounds` to `CreateTuvrenOptions` and `RuntimeCoreOptions`; apply the safe defaults from §3.11.
4. Add the `runtime-api-execution-bounds` check set to `runtime-api-callables-extended.json` using a runaway aimock driver fixture; assert each hard-stop bound's breach result, observation of the `execution.bounded` telemetry event through a configured capture sink, clamping of `AgentConfig.maxIterations` by `bounds.maxIterations`, enforcement of the `maxConcurrentToolCalls` throttle, clamping of `AgentConfig.maxParallelToolCalls` and `defaultMaxParallelToolCalls` by that cap, rejection of invalid non-finite or non-positive bound configuration, and a within-bounds control case.
5. Add a normative "Execution Bounds" section to `docs/KrakenFrameworkSpecification.md` (minor bump) so future drivers inherit the framework-owned guard.
6. Run `bun run verify`.

### 5.7 Migration Plans for the v0.29.0 Capability-Orchestration Revision

This section consolidates the bounded migration actions implied by ADR-046 and ADR-047. The conceptual model and contracts are authored above (PRD v0.9.0, Architecture v0.9.0, §3.13, §4.21); the source implementation is captured in `Tasks.md` as the active **Tooling block (Epics AW–BC)**, sequenced ahead of the trust block (Epic BD) and the productionization roadmap (Epics BE–BI). No code lands from this TechSpec revision itself; it is the contract the Tooling block implements. The block is "finished" when all four execution classes are orchestrated by the runtime with honest per-class observation/control limits, MCP is classified as a binding across classes, exposure/invocation policy applies, the cross-class invariant is conformance-verified, and the framework specification states the model.

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
- **Epic AZ — Tuvren-Client Execution Class: CLOSED.** Landed the leased client-endpoint dispatch/result protocol and attachment seam (runtime side only); `AttachedClientEndpoint`, `ClientEndpointBoundary` (with `detach()`), leaseToken staleness detection; client-side MCP classification as `tuvren-client / mcp-server`; partial-observability model (canAudit/canCancel/canRetry/canResume: false); `tuvren-client-execution-class` conformance check set (13 checks, 13/13 pass); client-endpoint integration contract at `boundaries/framework/contracts/client-endpoint-integration.md`. Concrete client endpoints remain host-developer deliverables.
- **Epic BA — Invocation Lifecycle & Observation Model: CLOSED.** Landed: `InvocationLifecycleState` union type in `@tuvren/core/capabilities` (6 phases: resolved → policy-admitted → dispatched → completed/failed/ignored); provider-native/mediated `tool.start`/`tool.result` attribution events routed through `publishRuntimeEvent` so the telemetry emitter observes them (BA002 gap); `null` as the JSON-serializable "not observed" sentinel for provider tool inputs; cross-class resume/recovery semantics proven through unit tests and conformance (tuvren-server fails clean per durability, provider classes resolve from observed state, tuvren-client stale/unavailable paths surface CAPABILITY_RESULT_STALE/CAPABILITY_BINDING_UNAVAILABLE, turn abort terminates cleanly); lifecycle telemetry depth confirmed using existing semconv (no extension needed); `invocation-lifecycle-observation` conformance check set (19 checks: BA001–BA003 invariants); 424 runtime tests pass; 399/399 framework conformance checks pass; `bun run verify` exits 0.
- **Epic BB — Exposure & Invocation Policy Model: CLOSED.** Landed: `PolicyCapabilityMetadata` type; `CapabilityPolicyContext` extended with all §4.21 dimensions; `TuvrenToolDefinition` BB policy fields; `AgentConfig.policyContextInputs`; five-dimension policy engine (residency, risk/approval, active-endpoint, user-presence, credential-boundary) with deterministic composition; exposure-time filtering wired; invocation-time context populated from real config; resume-path check added; `nonRetryable` overrides idempotency; `requiresApproval` bridges to approval flow; `capability-policy` conformance check set (26 checks, 26/26 pass); 472 runtime tests pass; 425/425 framework conformance checks pass.
- **Epic BC — Tooling Restructuring Closeout:** cross-class integration conformance, the normative "Capability Orchestration" section in `docs/KrakenFrameworkSpecification.md` (minor bump), the capability-surface portability inventory and authority-packet finalization, and a clean `bun run verify`.
