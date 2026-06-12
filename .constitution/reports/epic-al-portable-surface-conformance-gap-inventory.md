# Epic AL Portable-Surface Conformance Gap Inventory

This inventory is the KRT-AL001 spike output. It classifies every cross-implementation
semantic surface in the active TypeScript product scope as one of `portable`,
`exception:ag-ui`, `exception:ai-sdk-bridge`, `exception:telemetry-otel`, `memory-proof-obligation`,
`ts-ai-sdk-bridge-product-obligation`, or `gap`, and lists the concrete artifacts
KRT-AL002 added or revised to close the portability gate.

- Authored under KRT-AL001 as a spike inventory. Hand-authored Markdown, surface-level.
  Unlike `epic-af-conformance-gap-plan.md`, this file has no generator script; it is
  preserved as the KRT-AL002 gap-closure punch list and may be replaced by a
  generated artifact if AL002 introduces one.
- This document is planning evidence under `.constitution/reports/`. It does not
  extend the live constitutional authority chain.
- **Machine-readable companion**: `.constitution/reports/epic-al-portability-inventory.json`.
  That JSON is the canonical machine projection of this inventory's closure state
  (expected packets, standing exceptions, required authoritative sources). The
  portability gate at `tools/scripts/portability-gate.ts` reads from the JSON and
  fails if it drifts from the on-disk packet topology. The JSON and this MD must
  be revised together — a one-sided change is unreviewed drift.

## 1. Inputs and authority sources

The classification below is derived from these inputs only. Implementation source,
runner source, and Markdown other than the four live constitutional documents and the
authoritative behavioral specs are not authority for any cross-language semantic.

- Live constitutional documents:
  - `.constitution/prd/` (capability scope: CAP-P0-037, CAP-P1-035, CAP-P1-036, CAP-P1-038, CAP-P1-032)
  - `.constitution/architecture/`
  - `.constitution/tech-spec/` (`§2.1`, `§3.1`, `§4.6`, `§4.11`, `§4.12`, `§4.13`, `§5.4`, ADR-023-033)
  - `.constitution/tasks/` (Epic AL definition, build order, DoD)
- Behavioral authority:
  - `docs/KrakenKernelSpecification.md`
  - `docs/KrakenFrameworkSpecification.md`
- Prior planning evidence:
  - `.constitution/reports/epic-af-conformance-gap-plan.md` / `.json`
  - `.constitution/reports/epic-ad-docs-to-authority-coverage-matrix.json`
- Current authority packets (the 9 promoted surfaces after Epic AP package consolidation plus Epic AS):
  - `boundaries/shared/contracts/core/spec/authority-packet.json`
  - `boundaries/kernel/contracts/protocol/spec/authority-packet.json`
  - `boundaries/framework/contracts/event-stream-sse/spec/authority-packet.json`
  - `boundaries/framework/contracts/react-driver/spec/authority-packet.json`
  - `boundaries/providers/contracts/provider-api/spec/authority-packet.json`
  - `boundaries/providers/contracts/mcp/spec/authority-packet.json`
  - `boundaries/kernel/interop/grpc/spec/authority-packet.json`
  - `boundaries/framework/interop/rust-kernel/spec/authority-packet.json`
  - `boundaries/telemetry/semconv/spec/authority-packet.json`
- Current conformance plans (21):
  - kernel: `kernel-protocol-core`, `kernel-protocol-extended`, `kernel-restart-recovery`, `kernel-run-liveness`
  - framework: `runtime-api-lifecycle`, `runtime-api-lifecycle-extended`, `runtime-api-callables`, `runtime-api-callables-extended`, `runtime-api-orchestration`, `runtime-api-batteries-included`, `event-stream-core`, `event-stream-extended`, `event-stream-sse`, `driver-api-core`, `driver-api-extended`, `react-driver-callables`, `react-driver-extended`, `tool-contracts-extended`
  - providers: `provider-api-bridge`, `provider-api-bridge-extended`, `providers-mcp-client`
- Canonical verification path entries relevant to portability today:
  - `tools/scripts/verify.ts` step `Epic AL portability gate` (`bun run portability:check`) — the current portability proxy over the nine-packet inventory, three standing exceptions, and eleven required authoritative sources
  - `tools/scripts/verify.ts` step `docs:authority-freeze:check` — the docs-to-authority freeze gate from Epic AD
  - `tools/scripts/verify.ts` step `docs:af-gap-plan:check` — historical AF gap plan freshness evidence; retained in `verify` and `codegen`, but no longer the portability proxy
  - `tools/scripts/portability-check.ts` — verifies that 18 `@tuvren/*` packages can be `import()`-ed from both Bun and Node; package-publish health, not semantic conformance
  - `package.json` `codegen` script — gates on `docs:authority-freeze:check`, `portability:check`, `docs:af-gap-plan:check`, authority-packet validation, conformance-plan validation, adapter-protocol validation, meta-conformance, vocabulary validation, authority guardrails, and generator freshness
- Proving-host lanes that anchor TypeScript product-proof obligations:
  - `proving-host:interop-smoke` -> `host-repl:interop-smoke`
  - `proving-host:scenario-sqlite` -> `host-repl:scenario-sqlite`
  - `proving-host:scenario-postgres` -> `host-repl:scenario-postgres`

## 2. Classification legend

| Code | Meaning |
| --- | --- |
| `portable` | Surface owns an Authority Packet manifest, at least one referenced Conformance Plan, and at least one runner-observed decisive assertion per ADR-030. Adapter evidence is diagnostic only. |
| `exception:ag-ui` | Standing implementation-specific projection. Allowed by Tasks.md §1 and §4. TypeScript-only by intent until a new explicit decision changes that rule. |
| `exception:ai-sdk-bridge` | Standing implementation-specific provider bridge. TypeScript-only by intent until a new explicit decision changes that rule. |
| `exception:telemetry-otel` | Standing implementation-specific observability projection. The canonical telemetry sink and semantic vocabulary remain portable authority; OTel export is TypeScript implementation scope unless later promoted. |
| `memory-proof-obligation` | Not a cross-language portability target. Tested only through TypeScript proving-host lanes so the `memory` mode does not silently regress. |
| `ts-ai-sdk-bridge-product-obligation` | Not a cross-language portability target. Tested only through TypeScript proving-host lanes that drive AI-SDK-bridge provider scenarios. |
| `gap` | Should be portable under Epic AL's intent but is missing one or more of: authority packet, conformance plan, runner-observed decisive assertion, registered authoritative source, registered binding projection, or freshness check. |

## 3. Active portable surfaces

Each row lists the surface's authority packet, the referenced conformance plans, and
the surface's current decisive-assertion coverage.

| Surface | Packet | Plans | Decisive coverage | Notes |
| --- | --- | --- | --- | --- |
| Shared core primitives | `tuvren.shared.core` (`boundaries/shared/contracts/core/spec/authority-packet.json`) | `runtime-api-lifecycle{,-extended}`, `runtime-api-callables{,-extended}`, `runtime-api-orchestration`, `runtime-api-batteries-included`, `event-stream-core`, `event-stream-extended`, `driver-api-core`, `driver-api-extended`, `tool-contracts-extended` | `resultField`, `stateField`, `eventSequence`, `terminalEvent`, `noEvent`, `errorEnvelope` per plan inspection | Epic AP absorbed the former `core-types`, `runtime-api`, `event-stream`, `driver-api`, and `tool-contracts` packets into one consolidated core packet with binding sections for the eight `@tuvren/core/*` subpaths. |
| Kernel protocol semantics | `tuvren.kernel.protocol` (`boundaries/kernel/contracts/protocol/spec/authority-packet.json`) | `kernel-protocol-core`, `kernel-protocol-extended`, `kernel-run-liveness`, `kernel-restart-recovery` | `resultField`, `stateField`, `eventSequence` per plan inspection | Records appendix matrix and recovery edges promoted by AF KRT-AF006 are runner-observed. KRT-AL002 registered `spec/cddl/kernel-records.cddl` as a CDDL authoritative source on the packet. |
| Framework SSE projection | `tuvren.framework.event-stream-sse` (`boundaries/framework/contracts/event-stream-sse/spec/authority-packet.json`) | `event-stream-sse` | `eventSequence`, `resultField`, `ordering`, `errorEnvelope` per plan inspection | KRT-AL002/AL003 promoted the EventSource-compatible wire projection through TypeSpec, byte-trace fixtures, and WHATWG-conformant adapter decoding. |
| Framework ReAct driver behavior | `tuvren.framework.react-driver` (`boundaries/framework/contracts/react-driver/spec/authority-packet.json`) | `react-driver-callables`, `react-driver-extended` | `eventSequence`, `stateField`, `noEvent` per plan inspection | No TypeSpec; data-owned per ADR-025. AF promoted hook ordering, around-hook nesting, after-iteration terminality, and live/durable aroundModel reconciliation. |
| Provider bridge contract | `tuvren.providers.provider-api` (`boundaries/providers/contracts/provider-api/spec/authority-packet.json`) | `provider-api-bridge`, `provider-api-bridge-extended` | `resultField`, `eventSequence`, `errorEnvelope` per plan inspection | The provider-neutral contract is portable. The `bridge-ai-sdk` projection (TS implementation that adapts the AI SDK to this contract) is a standing exception — see §4. |
| MCP Client Container translation contract | `tuvren.providers.mcp` (`boundaries/providers/contracts/mcp/spec/authority-packet.json`) | `providers-mcp-client` | `resultField` per plan inspection | Epic AS promotes the Tuvren-owned translation, validation, auth-header, and transport-parity rules for `@tuvren/mcp-client`. The upstream MCP wire protocol remains owned by the official `@modelcontextprotocol/sdk`; Tuvren's authority packet covers the tool-source projection only. |

## 4. Standing implementation-specific exceptions

Per Tasks.md and ADR-033/ADR-042, exactly three surfaces are allowed to remain
implementation-specific. Each exception is named, scoped, and documented so it does
not silently grow into a portability obligation.

### 4.1 AG-UI projection (`@tuvren/stream-agui`)

- Classification: `exception:ag-ui`
- Implementation root: `boundaries/framework/implementations/typescript/stream-agui`
- Why allowed: AG-UI is a downstream UI-protocol projection of the canonical event
  stream, not a runtime semantic. Tasks.md §1 names it explicitly as an
  implementation-specific exception.
- What still covers it: Bun + Node TypeScript import smoke in `portability-check.ts`,
  `framework-stream-agui` build/test/exports-smoke lanes in `verify.ts`, and any
  in-package tests under `stream-agui/test/`.
- Removal preconditions (informational, not in AL scope): a new explicit decision in
  Tasks.md / TechSpec naming AG-UI as a required portable surface, plus an
  authority packet + conformance plan with at least one runner-observed decisive
  assertion that does not depend on the `@ag-ui/core` event union as the semantic
  oracle.

### 4.2 TypeScript AI SDK bridge implementation (`@tuvren/provider-bridge-ai-sdk`)

- Classification: `exception:ai-sdk-bridge`
- Implementation root: `boundaries/providers/implementations/typescript/bridge-ai-sdk`
- Why allowed: The portable contract is `tuvren.providers.provider-api`. The AI SDK
  bridge is the TypeScript-line projection of that contract onto `LanguageModelV3`
  / `ProviderV3`. Tasks.md §1 names it explicitly as an implementation-specific
  exception. The bridge's behavior is exercised through the portable
  `provider-api-bridge*` plans and through `runtime-api-callables*` provider scenarios.
- What still covers it: provider-api conformance plans (driving the bridge through
  the neutral contract), the TypeScript proving-host lanes that run AI-SDK-backed
  provider scenarios, and `providers-bridge-ai-sdk` workspace tests.
- Removal preconditions (informational, not in AL scope): a second portable provider
  implementation lands that exercises the same `provider-api-bridge*` plans without
  the AI SDK as the semantic oracle; or the AI SDK itself becomes a registered
  cross-language authority (it does not today).

### 4.3 OpenTelemetry projection (`@tuvren/telemetry-otel`)

- Classification: `exception:telemetry-otel`
- Implementation root: `boundaries/framework/implementations/typescript/telemetry-otel`
- Why allowed: the portable surface is the `@tuvren/core/telemetry` sink contract
  and the authored semantic convention vocabulary. The OTel package projects that
  canonical surface onto the TypeScript OpenTelemetry API and is implementation-
  specific by ADR-042.
- What still covers it: `@tuvren/telemetry-otel` unit tests and export smoke tests,
  plus the portable `framework-operational-telemetry.json` conformance plan over
  the canonical sink records.

## 5. Proving-only obligations

These surfaces are not cross-language portability targets, but they must remain
tested because their differing product obligations matter. Per Epic AL's Gherkin,
they are recorded separately so they do not get folded into the portable scope.

| Obligation | Why not portable | Where it stays tested |
| --- | --- | --- |
| `memory` backend proving | Non-durable by design; reload semantics do not apply. Memory is the default proving substrate for non-persistence scenarios. | `host-repl` `memory` scenarios in interactive and scripted modes; `memory` capability selection inside `kernel-protocol-core` / `kernel-protocol-extended` runs; `framework-stream-*` and runtime tests that run on memory. |
| `@tuvren/backend-sqlite` Node-bound proving | `better-sqlite3` is a Node native addon; the backend is documented as "Node-only" in `portability-check.ts` and is not a portability target across languages. SQLite physical schema is a TypeScript line commitment. | `proving-host:scenario-sqlite` in `verify.ts`; `kernel-restart-recovery` + `kernel-run-liveness` plans driven by the SQLite adapter; `backend-sqlite` workspace test target. |
| `@tuvren/backend-postgres` Node-bound proving | Same posture as SQLite: PostgreSQL physical schema is a TypeScript line commitment within the platform gate, not a cross-language portable surface. | `proving-host:scenario-postgres` in `verify.ts`; `kernel-restart-recovery` + `kernel-run-liveness` plans driven by the Postgres adapter; `backend-postgres` workspace test target. |
| TypeScript AI SDK bridge product scenarios | The bridge implementation itself is an exception (§4.2), but the TypeScript line's product-proof claim covers AI-SDK-backed flows end to end and must not regress. | `host-repl` AI-SDK provider scenarios; `provider-api-bridge*` plans (driven via the bridge as one capable adapter, not as authority); compatibility evidence under `reports/compatibility/`. |

## 6. Portability gaps

Each gap row preserves the AL001 pre-closure inventory: current state at the time,
missing artifact(s), proposed packet/plan home, recommended decisive assertion kinds,
and the concrete hand-off to KRT-AL002. The closure table in §9b is the current
post-AL002 / post-AP source of truth for which gaps are closed and where their
artifacts landed.

### G1. Tool contracts are absorbed into the consolidated core packet

- **AL001 gap state**: `boundaries/framework/contracts/tool-contracts/` had TypeSpec
  (`spec/typespec/main.tsp`), generated JSON Schema artifacts, generated OpenAPI
  artifacts, a TypeScript projection, and a workspace test target, but no authority
  packet or tool-specific conformance plan.
- **Closure state after AL002 + AP**: tool-call, approval, and result behavior now
  live under the consolidated `tuvren.shared.core` authority packet at
  `boundaries/shared/contracts/core/spec/authority-packet.json`. The packet declares
  the `tool-contracts-extended.json` conformance plan and a tool-contract binding
  section instead of introducing a standalone `tuvren.framework.tool-contracts`
  packet.
- **Decisive assertion kinds landed / still relevant**: `resultField` over tool-result shapes,
  `eventSequence` over `ToolStart`/`ToolCallStart`/`ToolCallArgsDelta`/`ToolCallDone`/`ToolResult`,
  `ordering` for parallel-wave traces, `errorEnvelope` for tool failure codes.
- **Remaining note**: §9b records G1 as closed; §9b's E6 note preserves the future
  productization follow-up for concatenated streamed tool arguments.

### G2. Kernel record CDDL grammar is unregistered authority

- **Current state**: `boundaries/kernel/contracts/protocol/spec/cddl/kernel-records.cddl`
  exists and is exercised by `kernel-protocol/implementations/typescript/test/kernel-cddl.test.ts`,
  but the `tuvren.kernel.protocol` authority packet does not list it under
  `authoritativeSources`. The packet currently declares only conformance plans and
  fixture sets. The `cddl` format is allowed by `§4.11`.
- **What is missing**: Register the CDDL file as an authoritative source on the
  kernel-protocol packet so a future Rust kernel implementation can validate its
  serialized records against the registered grammar instead of inferring shape from
  fixtures.
- **Recommended verification path**: add a `schema-validation` or `vocabulary-check`
  verificationPath that points at the CDDL grammar and an associated freshness check
  if a generator is added later. At minimum, register the source.
- **Hand-off to AL002**: edit `kernel-protocol/spec/authority-packet.json` to add
  `{ "path": "boundaries/kernel/contracts/protocol/spec/cddl/kernel-records.cddl", "format": "cddl" }`
  to `authoritativeSources`, version-bump per `§2.1` compatibility-rules (minor —
  adding a declared authoritative source is minor).

### G3. SSE projection authority packet is closed

- **AL001 gap state**: `boundaries/framework/implementations/typescript/stream-sse/`
  was a TypeScript implementation with build/test/exports-smoke targets, but had no
  SSE-specific authority packet, conformance plan, or fixtures.
- **Closure state after AL002 + AL003 follow-up**: `tuvren.framework.event-stream-sse`
  now owns `boundaries/framework/contracts/event-stream-sse/spec/authority-packet.json`,
  a TypeSpec source, WHATWG-normative byte-trace fixtures, generated JSON Schema
  artifacts, and the `event-stream-sse.json` conformance plan.
- **Decisive assertion kinds landed / still relevant**: `eventSequence` over decoded SSE frames,
  `resultField` over framing details (Content-Type, line endings, terminator),
  `ordering` between SSE projection events and canonical-stream events, `errorEnvelope`
  for malformed SSE traces. See §8.E5 for SSE specifics worth contracting.
- **Remaining note**: §9b records G3 as closed; §9b also notes the AL003 follow-up
  that wires the TypeScript framework conformance adapter through a WHATWG-conformant
  decoder in `@tuvren/stream-sse`.

### G4. Kernel gRPC interop seam has no authority packet

- **Current state**: `boundaries/kernel/interop/grpc/proto/tuvren/kernel/interop/v1/`
  contains `kernel_services.proto` and `kernel_types.proto`. `verify.ts` runs
  `kernel-rust-grpc-service:interop-smoke` and `kernel-interop-grpc:interop-smoke`.
  Per `§4.11`, interop surfaces should own a packet at
  `boundaries/<area>/interop/<channel>/spec/authority-packet.json`. That file does
  not exist.
- **What is missing**: a packet `tuvren.kernel.interop.grpc` declaring the `.proto`
  files as `format: "proto"` authoritative sources, the generated Rust/TS bindings
  as generated artifacts, the existing `interop-smoke` lane as an `interop-smoke`
  verification path, and freshness checks tied to the codegen command.
- **Proposed packet home**: `boundaries/kernel/interop/grpc/spec/authority-packet.json`
- **Recommended verification path kinds**: `interop-smoke` (already declared in the
  enum), plus `freshness-check` for generated bindings.
- **Hand-off to AL002**: create the packet, register the existing `.proto` sources,
  reference the `kernel-interop-grpc:interop-smoke` Nx target through the
  `interop-smoke` verification path (the runner exists; only the packet wrapper is
  missing).

### G5. Framework / Rust-kernel interop has no authority packet

- **Current state**: `boundaries/framework/interop/rust-kernel/scenarios/suite-manifest.json`
  and its accompanying JSON Schema exist; the framework drives an in-tree
  Rust-kernel interop suite. There is no
  `boundaries/framework/interop/rust-kernel/spec/authority-packet.json`.
- **What is missing**: a packet `tuvren.framework.interop.rust-kernel` declaring the
  suite manifest and its schema as authoritative sources, declaring the rust-kernel
  binding projection, and naming the interop-smoke verification path.
- **Proposed packet home**: `boundaries/framework/interop/rust-kernel/spec/authority-packet.json`
- **Hand-off to AL002**: create the packet. Existing suite-manifest + schema become
  authoritative sources; the smoke target (whichever Nx target drives it) becomes
  the interop-smoke verification path.

### G6. Telemetry semantic conventions are not packet-owned

- **Current state**: `telemetry/semconv/tuvren-runtime.yaml` defines runtime
  identity, run/turn/branch, driver, checkpoint, and resumed-from attributes as an
  OpenTelemetry semconv-shaped vocabulary. `telemetry-codegen` produces an
  `otel-attributes.json` consumer and a TypeScript projection. The `§4.11` format
  enum allows `semconv-yaml`. The `verificationPaths.kind` enum allows
  `vocabulary-check`. Neither is currently used by any packet.
- **What is missing**: a packet `tuvren.telemetry.semconv` declaring the semconv
  YAML and registry manifest as authoritative sources, declaring `vocabulary-check`
  over the generated `otel-attributes.json`, and freshness-checking the consumer
  projection. Without this, a future Rust implementation has no authority source
  for span/attribute names beyond reading Markdown.
- **Proposed packet home**: a new boundary lane — the `§4.11` `boundary` enum is
  `{framework, kernel, providers, shared, hosts}` and does not include `telemetry`.
  Cleanest option: file the telemetry packet under `shared` as
  `boundaries/shared/telemetry/spec/authority-packet.json` with `boundary: "shared"`
  and `surface: "telemetry-semconv"`. Alternative: extend the `§4.11` enum to add
  `telemetry`, which is a TechSpec change. AL001 recommends the `shared` placement
  to avoid widening the enum — but it is a real decision AL002 must make.
- **Recommended verification path kinds**: `vocabulary-check` over the generated
  attribute vocabulary; `freshness-check` over `otel-attributes.json`.
- **Hand-off to AL002**: pick the boundary lane (`shared` recommended), create the
  packet, wire `vocabulary-check`, ensure the existing `telemetry-codegen` step in
  `package.json` `codegen` honors freshness on the registered artifact.

### G7. Verification path enum drift

- **Current state**: `tools/schemas/authority-packet.schema.json` line 117-127 lists
  six `verificationPaths.kind` values: `schema-validation`, `openapi-validation`,
  `conformance-plan`, `interop-smoke`, `freshness-check`, `vocabulary-check`. The
  embedded JSON Schema in `.constitution/tech-spec/` §4.11 (lines 1796-1804) lists
  only five — `openapi-validation` is missing. The `provider-api` packet currently
  uses `openapi-validation`.
- **What is missing**: either TechSpec adds `openapi-validation` to the documented
  enum (preferred — the schema file is the implementation of the contract and
  matches what packets already use), or the schema file removes the kind and
  provider-api migrates to `schema-validation` over the OpenAPI artifact.
- **Hand-off to AL002**: small TechSpec §4.11 edit to add `openapi-validation` to
  the documented enum, with a one-line ADR-027 reaffirmation that the schema file
  remains the executable contract.

### G8. Canonical verification still treats `docs:af-gap-plan:check` as the portability proxy

- **Current state**: `tools/scripts/verify.ts` step "Epic AF conformance gap plan
  freshness" (line 199) and `package.json` `codegen` (line 21) gate on
  `docs:af-gap-plan:check`. Per Tasks.md KRT-AL002's Gherkin, this must be replaced
  by the promoted portability evidence once the new gate lands.
- **What is missing**: the new portability-gate verification target — composed of
  the gap closures listed above plus a fresh-evidence check over the AL inventory
  / AL gap plan. The exact target name is AL002's call, but the wiring change is
  in scope for AL002 in both `verify.ts` and the `codegen` script.
- **Hand-off to AL002**: design the replacement target (likely a new
  `portability:check` script that validates packet coverage against this inventory
  plus runs the new SSE / tool-contracts / interop / telemetry plans), wire it
  into `verify.ts` and `package.json` `codegen`, and remove the
  `docs:af-gap-plan:check` invocation as the portability proxy. The AF gap plan
  itself stays as historical/coverage evidence.

### G9. No `hosts` boundary authority packet

- **Current state**: `§4.11` boundary enum includes `hosts`. `boundaries/hosts/implementations/typescript/{playground,repl}/`
  exists. Proving-host scenarios are validated via `host-repl:*` Nx targets named in
  `verify.ts`. No `boundaries/hosts/contracts/<surface>/spec/authority-packet.json`
  exists.
- **AL001 decision**: do **not** open a `hosts` portable surface in Epic AL. The
  proving-host is, per ADR-032, a TypeScript-line product-proof artifact rather
  than a cross-language portability target. Operator command surface is not a
  required portable runtime semantic under the active scope.
- **Recorded as proving-only**: the proving-host product obligation lives in §5
  under TS proving lanes. If a future epic adds a second host (a different
  language or a different protocol) the missing `hosts` packet becomes a real
  portability gap; until then, leaving this open is consistent with Tasks.md's
  Sequential Scope Rule.
- **Hand-off to AL002**: none. Record this decision in AL003's gate reassessment.

## 7. Out-of-scope / inflation traps

Per Epic AL's Gherkin, explanatory docs and ecosystem-only adapter notes are not
allowed to inflate the portable runtime scope. The following are deliberately **not**
portability surfaces:

- **Package topology and naming** (`@tuvren/*` shape, re-exports, deep-import policy
  of `@tuvren/runtime`). Already excluded by AF KRT-AF001 ("stream adapter package
  topology"). Remains a TypeScript-line packaging concern.
- **Workspace tooling** (`devenv.nix`, `nx.json`, `tsup`, Biome configuration, the
  `bun2nix` build path). Implementation logistics, not runtime semantics.
- **Compatibility ledger presentation** (`reportStatus` strings, table layout in
  `reports/compatibility/`). The ledger is measured evidence under ADR-031; raw
  `status` is the contracted surface, not the presentation.
- **REPL host command names, prompt strings, scripted-scenario file format**. Proving
  artifacts under ADR-032; not a cross-language portability target.
- **`@tuvren/stream-agui` event union details beyond the AG-UI projection contract
  the upstream library defines.** AG-UI is explicitly an exception per §4.1.
- **AI SDK provider catalogue and per-provider quirks.** The bridge sits on the
  portable provider-api contract; provider-family specifics live in the
  TypeScript line.
- **Documentation prose under `docs/` and `.constitution/` themselves.** These are
  human authority refs per `§4.11`; they cannot be authoritative sources for any
  packet by ADR-023 / ADR-024.

## 8. Expert-grade observations for future productization

These observations are **advisory** and not in scope for KRT-AL002 unless explicitly
promoted. They identify productization concerns a senior backend/library reviewer
would normally raise at the same review pass as a portability inventory. Each one is
marked `[blocking AL002]`, `[non-blocking AL002]`, or `[future epic]`.

- **E1. Packet version posture.** The AL001 inventory observed the pre-closure packet
  set at `version 0.1.0` and `planVersion 0.1.0`. `§2.1` defines semver semantics
  for packets, but no packet had yet been promoted to a stability tier. Recommend
  future packet work explicitly decide whether an additive surface expansion graduates
  a packet to `0.2.0` or to a higher tier per ADR-033 once the portability gate passes.
  `[non-blocking AL002]`
- **E2. Error envelope universe.** Conformance plans assert error codes via
  `equals` (`approval_pause_phase_mismatch`, `orchestration_parent_not_started`,
  `invalid_loop_policy`, etc.). The closed set of error codes is not enumerated in
  any normative authority source. A future Rust implementation has to discover the
  code universe by reading plans one-by-one. Recommend a `shared/errors/` packet or
  an enumerable type on `shared/core-types` that closes the set.
  `[non-blocking AL002]`
- **E3. Approval expiry / timeout.** Approvals pause runs indefinitely. The
  contract has no expiry, no timeout escalation, and no third-party handoff for
  long-lived agents. Productized public use will hit this. Not a portability gap
  yet (no implementation has expiry) but record it as a future portability
  liability if any implementation adds it. `[future epic]`
- **E4. Stream replay / reconnection contract.** After cancellation + reload, what
  events does a client see on reconnect? Replay scope is implicit. The canonical
  event-stream packet does not declare a replay envelope (last-committed checkpoint,
  resume position, gap behavior). This intersects with G3 (SSE) — a reconnecting
  SSE client needs a contract. Recommend AL002 include at minimum a
  `resume-from-checkpoint` decisive assertion in the new SSE plan.
  `[blocking AL002 partial]` — covered if SSE plan includes Last-Event-ID behavior.
- **E5. SSE specifics worth contracting (input for G3).** Heartbeat / keepalive
  interval, `retry:` field semantics, `id:` field semantics and Last-Event-ID
  reconnection behavior, Content-Type strictness (`text/event-stream` with charset),
  line-ending normalization (CRLF vs LF), final-event marker conventions,
  comment-line (`:`) policy, and behavior under back-pressured consumers. Any one
  of these silently diverging between implementations is a real interop bug.
  `[blocking AL002 for SSE plan completeness]`
- **E6. Tool argument streaming completeness.** `ToolCallArgsDeltaEvent` exists
  but the contract does not currently say whether deltas must be valid prefix-JSON,
  whether they can mid-token break (`{"key": "val` → `ue"}`), whether the runtime
  guarantees a final `ToolCallDone` parses to valid JSON, or how a malformed final
  payload is reported. Recommend AL002 fold this into the new tool-contracts plan
  (G1) with a decisive `eventSequence` + `schemaValid` assertion over the
  concatenated args. `[blocking AL002 for tool-contracts plan completeness]`
- **E7. Structured-output dialect declaration.** AF promoted
  `runtime-callable-af.structured-output-default-draft07` — defaulting to JSON
  Schema Draft 07. Draft 2019-09 and 2020-12 round-trip differently for `$ref`
  resolution and unevaluated properties. Recommend the structured-output checks
  carry a decisive `resultField` on `validation.dialect` so the chosen dialect is
  contracted, not merely observed. `[non-blocking AL002]`
- **E8. Reasoning part visibility / redaction.** `ReasoningPart` carries
  provider-private text. No portable redaction or masking contract exists. For
  productized public use this is a real liability (logs, telemetry, host display).
  Recommend at minimum a vocabulary-level annotation in the telemetry semconv
  packet (G6) declaring reasoning content as `requirement_level: opt_in`.
  `[future epic]`
- **E9. Resource-limit constants.** No portable contract for max manifest size,
  max branch depth, max event payload size, max staged-result count, lease
  duration upper bound. Implementations may diverge silently. Recommend AL002
  add a `shared/limits/` vocabulary or extend the kernel-protocol packet with a
  declared limits table. `[non-blocking AL002]`
- **E10. PostgreSQL behavior posture.** Connection-pool sizing, advisory-lock
  ownership, schema-migration ordering, and `WAL` vs `read-committed` isolation
  choices are not in TechSpec. Postgres parity is currently anchored by
  `kernel-restart-recovery` + `kernel-run-liveness` plans driven through one
  Postgres adapter. A second Postgres adapter could legitimately diverge.
  `[future epic — second Postgres adapter]`
- **E11. Authority-packet self-test.** No packet currently runs a `vocabulary-check`
  or `schema-validation` against its own declared `forbiddenAuthoritySources` list
  (i.e., a test that the listed forbidden paths exist and are not authorityful).
  The `authority-guardrails` script does part of this. Recommend AL002 fold a
  packet-coverage assertion into the new portability gate target (G8).
  `[blocking AL002 if portability gate target lands]`
- **E12. `@tuvren/runtime` re-export discipline.** The curated facade re-exports
  many types. There is no automated test that the public re-export surface is
  stable across versions, or that internal types do not leak through. This is a
  TypeScript-line packaging concern (out of portability scope, see §7) but a real
  productization concern. `[future epic — public release]`

## 9. Guardrails

These guardrails mirror the AF gap plan and apply to KRT-AL002.

- Runner code and adapter code must not receive expected event sequences, expected
  phase traces, or pass/fail decisions from this inventory. The inventory is
  planning evidence, not a semantic oracle.
- Every promoted check produced under AL002 must declare required evidence in its
  conformance plan and must be backed by adapter observations only.
- Adapter-supplied `Observation.evidence` is diagnostic. No promoted AL check may
  rely on `evidenceField` as the only proof. Decisive assertions must use
  `resultField`, `stateField`, `eventSequence`, `terminalEvent`, `schemaValid` over
  `$.result` / `$.events` / `$.state`, `errorEnvelope`, `ordering`, or `noEvent`.
- Capability selection in plans must not name implementation IDs, language names,
  runner names, or adapter names.
- Unsupported implementations remain non-applicable through capability selection per
  ADR-031. No AL check may target an implementation ID directly.
- Excluded surfaces in §7 stay excluded until a later TechSpec/Tasks revision
  explicitly promotes them.
- Standing exceptions in §4 stay exceptions until a later TechSpec/Tasks revision
  explicitly promotes them. AL002 may not unilaterally remove the AG-UI or
  AI-SDK-bridge exception.

## 9b. KRT-AL002 closure status

KRT-AL002 has landed the gap closures listed below. The portability gate
target (`bun run portability:check` / `tools/scripts/portability-gate.ts`)
now enforces the post-AL002 packet topology so a future change cannot
silently drop a portable surface, add an unauthorized packet, or promote a
standing exception without revising both this inventory and the gate's
machine-readable companion at
`.constitution/reports/epic-al-portability-inventory.json`. The gate
no longer carries hardcoded topology constants — it reads the JSON
companion at runtime and fails closed if the JSON is missing, malformed,
or names paths that disagree with the on-disk packet set.

| Gap | Status | Landing artifact |
| --- | --- | --- |
| G1 tool-contracts | closed | `tool-contracts-extended.json` plan plus tool-contract binding section in the consolidated `tuvren.shared.core` packet; AF tool checks relocated under `tool-contracts-af.*` prefix |
| G2 kernel CDDL registration | closed | `boundaries/kernel/contracts/protocol/spec/cddl/kernel-records.cddl` registered as `cddl` authoritative source on the kernel-protocol packet (version 0.2.0) |
| G3 SSE projection | closed | `tuvren.framework.event-stream-sse` packet, TypeSpec source, eighteen WHATWG-normative byte-trace fixtures (including the empty-`id:` reset and the unterminated-final-frame edge added under AL003 review followup), and `event-stream-sse.core` conformance plan with nineteen decisive checks |
| G4 kernel gRPC interop packet | closed | `tuvren.kernel.interop-grpc` packet referencing the existing `.proto` files and interop-smoke target |
| G5 framework rust-kernel interop packet | closed | `tuvren.framework.interop-rust-kernel` packet referencing the suite manifest and host-repl interop-smoke target |
| G6 telemetry semconv packet | closed | `tuvren.telemetry.semconv` packet (TechSpec §4.11 boundary enum extended to include `telemetry`), Weaver-driven freshness checks, new `vocabulary-check` runner at `tools/conformance/vocabulary/validate-vocabulary.ts` |
| G7 TechSpec verification-path enum drift | closed | TechSpec §4.11 documented JSON Schema now lists `openapi-validation`; the executable-verification rule recognizes `openapi-validation`, `interop-smoke`, and `vocabulary-check` alongside `schema-validation` and `conformance-plan` |
| G8 portability gate replaces `docs:af-gap-plan:check` | closed | `tools/scripts/portability-gate.ts` + `package.json` `portability:check` script; wired into `tools/scripts/verify.ts` and the `codegen` script as the canonical portability proxy |
| G9 `hosts` boundary intentionally unopened | closed | Recorded in §6.G9 above; the portability gate enforces no `hosts` packet exists |

Follow-up items that are explicitly outside KRT-AL002's scope and remain
candidates for future tickets:

- §8.E5 SSE checks were closed under the KRT-AL003 wave-5 review followup:
  the TypeScript framework conformance adapter now declares the
  `framework.event-stream-sse` capability and routes
  `event-stream-sse.decode-trace` / `event-stream-sse.report-wire-compliance`
  through a WHATWG-conformant decoder in `@tuvren/stream-sse`, so every check
  in `event-stream-sse.json` runs as applicable evidence on the TypeScript
  framework lane. The plan's bumped `planVersion` is `0.2.0`; the TypeScript
  binding appendix at
  `boundaries/framework/contracts/event-stream-sse/spec/bindings/typescript.md`
  documents the wired adapter behavior.
- §8.E6 tool argument streaming completeness assertion was not added in
  AL002; it requires either canonical `$.events` exposure or an adapter
  capability that surfaces concatenated `ToolCallArgsDelta` payloads.
- §8.E1, E2, E7, E9, E11 are non-blocking productization items recorded for
  future epics.
- The interop-smoke target's pre-existing E2BIG environmental sensitivity
  (esbuild service argument-list limit when many tsup invocations chain) is
  unrelated to AL002 and was resolved during KRT-AL003 by rerouting the
  smoke's pre-build through `bun run nx run host-repl:build --skipNxCache`
  so Nx isolates each per-package tsup invocation. See the KRT-AL003
  reassessment record for the full follow-up resolution log.

## 9c. KRT-AL003 closure status

KRT-AL003 reassessed the staged gates against fresh canonical-lane evidence
and recorded the verdict in
`.constitution/reports/epic-al-rust-re-entry-gate-reassessment.md`. All
three gates pass under fresh evidence: the `portability gate` through this
inventory's promoted authority plus `tools/scripts/portability-gate.ts`; the
`product proof gate` through the `proving-host:interop-smoke`,
`proving-host:scenario-sqlite`, and `proving-host:scenario-postgres` lanes;
the `platform gate` through PostgreSQL backend tests, PostgreSQL kernel
conformance, and the PostgreSQL proving-host reload scenario. Rust
framework/product work remains blocked until a new epic explicitly reopens
that scope. Resolved during AL003: the interop-smoke E2BIG environmental
sensitivity (now delegated to Nx), latent post-AK lint/typecheck issues
under `backend-postgres` and the kernel TypeScript conformance adapter, and
a `devenv up -d postgres` readiness race in the backend-postgres test
helper.

## 10. Historical Hand-off to KRT-AL002

The concrete punch list AL002 executed. This section is preserved as historical
planning evidence; §9b records the current closure artifacts and supersedes the
pre-closure recommendations when package consolidation changed the landing shape.

1. **G1** — Close tool contracts through the consolidated
   `tuvren.shared.core` packet at
   `boundaries/shared/contracts/core/spec/authority-packet.json`. Add the
   `tool-contracts-extended` plan with decisive
   `resultField`/`eventSequence`/`ordering`/`errorEnvelope` assertions over
   tool execution and approval flow. Wire the plan into the existing
   tool-execution scenarios and record the tool-contract binding section in the
   consolidated core packet. The streamed-argument completeness assertion from E6
   remains future work, as recorded in §9b.
2. **G2** — Edit `boundaries/kernel/contracts/protocol/spec/authority-packet.json`
   to add the existing CDDL grammar as an authoritative source
   (`format: "cddl"`). Minor packet version bump per §2.1.
3. **G3** — Add the `tuvren.framework.event-stream-sse` packet and
   `event-stream-sse.json` plan. Add an SSE source (TypeSpec for the projection
   shape) and byte-level trace fixtures. The plan must include the SSE specifics
   listed in §8.E5 as decisive assertions where applicable (Last-Event-ID
   reconnection, `retry:` semantics, Content-Type, line-ending normalization).
4. **G4** — Add `tuvren.kernel.interop.grpc` packet at
   `boundaries/kernel/interop/grpc/spec/authority-packet.json` referencing the
   existing `.proto` files as `format: "proto"` authoritative sources and the
   existing `kernel-interop-grpc:interop-smoke` Nx target as the `interop-smoke`
   verification path.
5. **G5** — Add `tuvren.framework.interop.rust-kernel` packet at
   `boundaries/framework/interop/rust-kernel/spec/authority-packet.json`
   referencing the suite manifest and its schema.
6. **G6** — Pick the telemetry packet boundary (recommend `shared`), add
   `tuvren.shared.telemetry-semconv` (or `tuvren.telemetry.semconv` if the
   boundary enum is extended), reference `telemetry/semconv/tuvren-runtime.yaml`
   as `format: "semconv-yaml"`, declare a `vocabulary-check` verification path
   over `telemetry/otel-attributes.json`, and freshness-check the consumer
   projection. Document the boundary-enum decision in the same TechSpec edit.
7. **G7** — Edit TechSpec §4.11's embedded JSON Schema to add `openapi-validation`
   to the documented `verificationPaths.kind` enum, matching the schema file.
8. **G8** — Author the new portability-gate target (suggested name
   `portability:check` under `tools/scripts/`). Validate packet coverage against
   this inventory, run the new plans (G1, G3, G6), and pass freshness checks for
   all generated artifacts. Wire the target into both `tools/scripts/verify.ts`
   and `package.json` `codegen`, replacing `docs:af-gap-plan:check` as the
   portability proxy.
9. **G9** — Record in the AL003 reassessment that the `hosts` boundary remains
   intentionally unopened. No code change.

Historical estimated artifact footprint for AL002:

- 4 new authority packet files (G3, G4, G5, G6) plus the consolidated-core packet
  edit that absorbed G1 after ADR-037 / Epic AP
- 1 packet edit (G2)
- 2-3 new conformance plan files (G1, G3, optional G6 fixture set)
- 1 TypeSpec source (G3 SSE projection), optionally 1 fixture set (G3 byte traces)
- 1 TechSpec edit (G7, plus §5.4 wording if AL002 reframes the portability gate)
- 1 new verification script (G8), 2 wiring edits (`verify.ts`, `package.json`)
- Compatibility evidence refresh after the new plans run
