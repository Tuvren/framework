# Engineering Execution Plan

## 0. Version History & Changelog

- v0.29.0 - Opened the v0.8.0 production-trust block (PRD v0.8.0 / Architecture v0.8.0 / TechSpec v0.28.0, ADR-042 through ADR-045): added Epics AU (durability & recovery proof under fault injection), AV (operational telemetry surface + vendor-neutral export), and AW (trust-boundary security hardening — framework-enforced execution bounds, secret isolation, and approval/input trust-boundary verification) as the active critical path (19 tickets, 83 points). Recorded the post-trust-block roadmap (Epics AX–BB: performance budgets, public API freeze, publication, docs/onboarding, reference application) as named, un-ticketed deferred scope to anchor a future planning session.
- v0.28.4 - Maintenance alignment: reflected TechSpec v0.27.2, closed the stale AQ status marker, narrowed active scope language to AS-AT, and corrected Epic AS planning around `@modelcontextprotocol/sdk@1.29.0`'s inherited `zod` peer requirement.
- v0.28.3 - Closed Epic AR: `createTuvren` factory, `TuvrenInstance` types, `[Symbol.asyncDispose]` cleanup wiring, curated re-exports on `@tuvren/runtime`, and full `runtime-api-batteries-included` conformance across memory, SQLite, and PostgreSQL backends. Active scope drops to AS-AT (19 tickets, 65 points). Block 2 is fully closed.
- ... [Older history truncated, refer to git logs]

## 1. Executive Summary & Active Critical Path

- **Total Active Story Points:** 83 across the production-trust block — Epic AU (23), Epic AV (24), and Epic AW (36). Epics AM (32), AN (13), AO (26), AP (37), AQ (15), AR (15), AS (31), and AT (34) are closed and remain in this live plan as recently completed context for audit.
- **Critical Path:** `KRT-AV001 → KRT-AV002`, with `KRT-AW001` feeding `KRT-AV002`; then the branch splits: `KRT-AV004 → KRT-AW004` for telemetry-secret isolation, while `KRT-AW005` converges with `KRT-AV002` into `KRT-AW006 → KRT-AW007 → KRT-AW008` for execution bounds. `KRT-AW009` is an independent required close-condition security lane and must complete before the final block closure/verify point. The durability-proof track `KRT-AU001 → KRT-AU002 → KRT-AU003 → KRT-AU004 → KRT-AU005` remains fully independent and may start immediately.
- **Planning Assumptions:** PRD v0.8.0, Architecture v0.8.0, and TechSpec v0.28.0 (ADR-042 through ADR-045) are approved upstream and govern this block; the prior chain (PRD v0.7.0 / Architecture v0.7.0 / TechSpec v0.27.x, ADR-034 through ADR-041, Epics AM-AT) is closed. The production-trust block hardens the existing TypeScript line and does NOT reopen Rust framework/product work, additional drivers, additional host protocols, additional backends, or broader provider families. The `product proof gate`, `platform gate`, and `portability gate` from Epic AL remain the staged-gate baseline. The locked external dependency versions per TechSpec §1 still apply; `@tuvren/telemetry-otel` pins its `@opentelemetry/*` versions in Epic AV per the §1 pin-on-activation rule. The new `@tuvren/core/telemetry` subpath raises the curated core surface from 8 to 9 subpaths; `@tuvren/telemetry-otel` is an implementation-specific projection (a standing portability exception alongside AG-UI) while the canonical telemetry vocabulary (`telemetry/semconv/tuvren-runtime.yaml`) remains portable authority.

### Brownfield Continuity Note

- Epics A-AL remain historical context. Epic AL's closure of the staged gates is the foundation this chain extends.
- The current repo proves the host-facing SDK through the serious REPL host (`@tuvren/repl-host`) and its named `proving-host:*` validation lanes; exercises PostgreSQL as a first-class backend across kernel conformance and proving-host reload; closes the portability gate through `tools/scripts/portability-gate.ts`; and now carries the shared primitive surface in `@tuvren/core` with source-bearing runtime implementation in `@tuvren/runtime`. The old contract package handles and `@tuvren/runtime-core` are compatibility shims only; Epic AT retired `@tuvren/playground-host` and the remaining playground-named REPL internals in favor of the production REPL/headless CLI.
- Historical closure inventories live under `constitution/archived/` for audit only.

### Sequential Scope Rule

- No Rust framework or Rust product-line expansion is active in this plan. The kernel work in Epic AM (Rust `InMemoryKernel.thread_list` + gRPC server) extends the existing Rust kernel boundary; it does not open Rust framework/product scope.
- No first-class Tuvren provider packages are active in this plan beyond the TypeScript AI SDK bridge and the new MCP client (which is a tool source, not a model provider).
- No AG-UI portability work is active in this plan beyond preserving correct TypeScript projection behavior.
- No additional host protocols beyond the canonical stream and SSE surfaces are active in this plan. The headless REPL mode (Epic AT) is a CLI surface, not a wire protocol.
- Public package publication remains deferred. The consolidated SDK layout (`@tuvren/core` + `@tuvren/runtime`) defines the curated v1 surface; the publication act itself is out of scope for this chain and is recorded as a named post-trust-block roadmap item (Epic AZ) in §2.
- The production-trust block (AU, AV, AW) hardens the existing TypeScript line only. The fault-injection seam (Epic AU) is testkit-only and never reachable from production paths; the telemetry surface (Epic AV) adds an outbound observability surface plus an implementation-specific OTel projection without changing runtime truth; execution bounds and secret isolation (Epic AW) add framework-owned guards and credential-edge confinement without altering kernel semantics.

### Planning Heuristic

- Prefer ticket slices that fit focused solo-dev execution while preserving strict gates around product proof, backend rigor, and conformance truthfulness.
- Treat “green because a private harness succeeds” as insufficient evidence once a proving-host ticket exists on the critical path.

## 2. Project Phasing & Iteration Strategy

### Current Active Scope

- **Block 4 — Production trust (Epics AU, AV, AW): ACTIVE.** This is the current critical path. Epic AU proves the durability and recovery guarantees under fault injection (resume-or-fail-clean, atomic checkpoints, concurrency-safe lineage) via a testkit-only fault-injection seam and a strengthened `kernel-crash-recovery` conformance set. Epic AV adds the first-class operational telemetry surface (`@tuvren/core/telemetry` sink) with framework emission and a vendor-neutral `@tuvren/telemetry-otel` export. Epic AW hardens the trust boundaries: framework-enforced execution bounds with a typed `execution_bound_exceeded` terminal result, secret isolation across durable, telemetry, and transcript surfaces, and verification that approval gates are non-bypassable and untrusted MCP/tool inputs are validated.
- **Block 1 — Boundary correctness gate (Epics AM, AN, AO):** closed. The kernel now exposes `thread.list` with the corrected 30-operation narrative, `ExecutionHandle` exposes base-handle `awaitResult`, and `TuvrenRuntime` exposes the five-method durable-read surface (`listThreads`, `listBranches`, `getTurnState`, `getTurnHistory`, `readBranchMessages`).
- **Block 2 — Curated surface + ergonomics (Epics AP, AQ, AR):** closed. Epic AP landed `@tuvren/core` and folded the source-bearing runtime implementation into `@tuvren/runtime`. Epic AQ added the schema-agnostic `defineTool` helper (Zod / Standard Schema / wrapped JSON Schema with type inference). Epic AR added the `createTuvren({...})` batteries-included factory with full lifecycle conformance across memory, SQLite, and PostgreSQL backends.
- **Block 3 — Capability spikes (Epics AS, AT):** closed. Epic AS added `@tuvren/mcp-client` as a first-class tool source over stdio + Streamable HTTP-backed public `http-sse` transports. Epic AT retired `@tuvren/playground-host`, renamed internal REPL host modules to drop the playground naming, added headless stdin mode for the reference host, added streaming JSONL output, and added JSONL transcript capture/replay.

### Future / Deferred Scope

- Rust framework and Rust product-line work — still blocked. The kernel work in Epic AM (Rust `InMemoryKernel.thread_list` + gRPC server) extends the existing Rust kernel boundary only.
- First-class Tuvren-owned model-provider packages beyond the TypeScript AI SDK bridge.
- Cross-tenant thread search, multi-tenant ACLs, full-text indexed querying through the embeddable SDK (PRD v0.7.0 §6 Out of Scope; deferred to a future hosted/server projection).
- Server or REST projection of the durable-read surface (same future projection).
- Model Context Protocol server-side projection — Tuvren as an MCP server. Only the client side is in scope through Epic AS.
- Schema adapters beyond Zod, Standard Schema, and wrapped JSON Schema in the core surface — Valibot, ArkType, Effect Schema, and others remain post-v1 optional packages.
- Driver hot-swap or additional drivers beyond the ReAct baseline.
- Per-call approval edit forms beyond the existing approve/reject/edit verbs in the reference host UX.
- Script-file interpreter or external scripting language for the headless reference host (stdin is the only headless input surface).
- AG-UI as a required cross-language portable surface (currently a standing exception).
- Additional host protocols beyond the canonical stream and SSE surfaces.
- Additional official backends beyond memory, SQLite, and PostgreSQL.
- Public package publication and final long-lived package curation — the consolidated `@tuvren/core` + `@tuvren/runtime` layout from Epic AP defines the surface; the publication act itself is post-chain (see Epic AZ in the roadmap below).

#### Post-Trust-Block Roadmap (Epics AX–BB) — Named, Not Yet Ticketed

These epics are the agreed direction after the production-trust block, toward the goal of host adoption plus first-party dogfooding (PRD §1.4 Strategic Direction). They are recorded here with enough scope to anchor a future planning session; they are intentionally NOT decomposed into tickets yet, and their upstream PRD/Architecture/TechSpec deltas (where needed) are authored when each is activated.

- **Epic AX — Performance Characterization & Regression Budgets.** Benchmark the hot paths (deterministic CBOR encode/hash, checkpoint commit, context assembly, backend reads/writes, durable-read pagination), publish documented performance budgets, and wire a `bench` regression gate into the canonical verification path. Prerequisite: the durability guarantees from Epic AU are proven first, so budgets are measured against a correct baseline.
- **Epic AY — Public API Surface Freeze & Semver Discipline.** Define the stable public API of `@tuvren/core` + `@tuvren/runtime` (API-report tooling, deprecation policy, documented stability guarantees). Sequencing note: run AY *after* the reference application (BB) so the surface is frozen against real usage friction, not before.
- **Epic AZ — Publication & Release Engineering.** npm publication of the curated packages, changesets / versioning, CI release pipeline, and provenance. This is the deferred "post-chain" publication item, de-risked by the trust block and gated on AY's surface freeze.
- **Epic BA — Documentation & Onboarding.** Docs site, getting-started, cookbook, and API reference — the artifacts that convert "built" into "others build on it."
- **Epic BB — Reference Application (Dogfood Target).** A real, non-trivial application built end-to-end on Tuvren that satisfies the dogfooding goal and surfaces API friction feeding back into AY. Recommended to run before AY.

### Archived or Already Completed Scope

- Epic AH completed the constitutional authority reset: historical support material moved under `constitution/archived/`, active generated support artifacts now live under `constitution/support/live/`, and the live authority chain is narrowed to the four constitutional documents plus explicit support inputs.
- Epics A-Q established the baseline TypeScript runtime, ReAct path, provider bridge, stream adapters, playground host, and release-hardening work.
- Epic AI completed the current host-facing TypeScript package audit/normalization path through [epic-ai-high-level-sdk-surface-audit.md](./archived/spikes/epic-ai-high-level-sdk-surface-audit.md).
- Epic AJ completed the serious REPL proving-host path, including shared interactive/scenario host wiring, named `proving-host:*` validation targets, Node-backed SQLite reload proof, Rust-kernel interop proof, and refreshed compatibility evidence.
- Epic AK completed the PostgreSQL platform-gate path by landing `@tuvren/backend-postgres`, wiring REPL PostgreSQL reload proof plus TypeScript PostgreSQL conformance through `devenv`, and integrating those lanes into the canonical verification path.
- Epic AL closed the portability gate by promoting tool contracts, kernel CDDL registration, SSE projection, kernel and framework interop packets, and telemetry semantic conventions into packet/plan/runner-owned authority, by landing `tools/scripts/portability-gate.ts` as the canonical portability proxy in the verify lane, and by recording the staged-gate re-entry verdict in `constitution/support/live/epic-al-rust-re-entry-gate-reassessment.md`.
- Epics R-AG established the multi-language transition foundation, shared conformance architecture, kernel interop, and the AG hardening subset that remains historical evidence for promoted surfaces.
- Epics AM through AP closed the kernel enumeration, base-handle terminal-value, durable-read, and package-consolidation portions of the v0.27.0 constitutional revision chain.
- Epic AS and Epic AT closed the MCP client and reference-host consolidation capability spikes.
- That work remains valuable audit context. The active forward path is the production-trust block (Epics AU, AV, AW); see Current Active Scope.

## 3. Build Order (Mermaid)

```mermaid
flowchart LR
  closed["Blocks 1-3 (Epics AM-AT) — closed"]

  subgraph block4["Block 4 — Production trust (ACTIVE)"]
    subgraph au["Epic AU — Durability & recovery proof"]
      AU1["AU001 Spike: characterize recovery"]
      AU2["AU002 Fault-injection backend (testkit)"]
      AU3["AU003 kernel-crash-recovery plan"]
      AU4["AU004 Fix atomicity/concurrency defects"]
      AU5["AU005 Kernel-spec invariant + verify"]
      AU1 --> AU2 --> AU3 --> AU4 --> AU5
    end
    subgraph aw_sec["Epic AW — Secret isolation + trust boundary"]
      AW1["AW001 Telemetry secret-screening helpers"]
      AW2["AW002 Transcript redactor"]
      AW3["AW003 Edge-confinement docs/fixtures"]
      AW4["AW004 secret-isolation check set"]
      AW9["AW009 Approval/input trust-boundary verify"]
      AW1 --> AW4
      AW2 --> AW4
      AW3 --> AW4
    end
    subgraph av["Epic AV — Operational telemetry"]
      AV1["AV001 @tuvren/core/telemetry sink types"]
      AV2["AV002 Framework emission + sink wiring"]
      AV3["AV003 @tuvren/telemetry-otel export"]
      AV4["AV004 framework-operational-telemetry plan"]
      AV5["AV005 Re-export + verify"]
      AV1 --> AV2 --> AV4 --> AV5
      AV1 --> AV3 --> AV5
    end
    subgraph aw_bounds["Epic AW — Execution bounds"]
      AW5["AW005 ExecutionBounds types + code"]
      AW6["AW006 Bounds guard in runtime"]
      AW7["AW007 runtime-api-execution-bounds plan"]
      AW8["AW008 Framework-spec bounds note + verify"]
      AW5 --> AW6 --> AW7 --> AW8
    end
    trust_close["Block 4 close + verify"]
    AU5 --> trust_close
    AV5 --> trust_close
    AW4 --> trust_close
    AW8 --> trust_close
    AW9 --> trust_close
  end

  closed --> AU1
  closed --> AV1
  closed --> AW1
  closed --> AW2
  closed --> AW3
  closed --> AW5
  closed --> AW9
  AW1 --> AV2
  AV2 --> AW6
  AV4 --> AW4
  AV4 --> AW7
```

## 4. Ticket List

### Epic AM — Kernel `thread.list` Syscall + 28→30 Count Correction (KRT)

**Status:** Closed — all 11 tickets implemented and verified under `bun run verify` + `bun run compatibility:evidence`. Correction to KRT-AM010 scope: `kernel.logical.thread_list` was placed in `kernel-protocol-extended.json` only (not all four plans) to avoid duplicate check IDs in the conformance runner's `nonApplicableCheckIds` across plans.

**KRT-AM001 Kernel Specification v0.10 Bump and Count Correction**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** None
- **Capability / Contract Mapping:** PRD `CAP-P0-039`; TechSpec ADR-034, §4.2
- **Description:** Bump `docs/KrakenKernelSpecification.md` to v0.10. Correct every "28 operations" / "28-vs-29" narrative mention to "30 operations across 10 groups." Add a normative `thread.list` syscall section defining parameters (`limit`, `cursor`, `filter.schemaId`), return shape, the `thread.enumeration` capability gate, and the `kernel_capability_unsupported` rejection envelope for backends that do not advertise the capability.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the kernel specification at v0.9 declares "28 operations" while the actual surface exposes 29
When the kernel specification is bumped to v0.10
Then the syscall-count narrative cites "30 operations across 10 groups"
And the new `thread.list` syscall has full validation rules, parameter shapes, return shape, and capability-rejection semantics documented
And every existing "28 operations" mention in the spec, kernel rationale, and TechSpec narrative is corrected
And the change is reviewable as one self-contained spec amendment
```

**KRT-AM002 Kernel Authority Packet Update for `thread.list`**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** `KRT-AM001`
- **Capability / Contract Mapping:** PRD `CAP-P0-039`, `CAP-P0-037`; TechSpec ADR-026, ADR-034
- **Description:** Update `boundaries/kernel/contracts/protocol/spec/authority-packet.json` to declare the new syscall surface (`thread.list`), reference the new conformance-plan check sets that will land in KRT-AM010, and bump the packet version. Update the CDDL grammar reference if the cursor or response payload requires it.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the kernel specification has been bumped to v0.10
When the kernel protocol authority packet is updated
Then the packet declares the new syscall surface in its `authoritativeSources` and `conformancePlans` arrays
And the packet `version` field is bumped per ADR-026 minor-bump rules
And the bumped packet passes `bun run codegen` and authority-packet freshness checks
```

**KRT-AM003 BackendCapability Descriptor on RuntimeBackend**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AM001`
- **Capability / Contract Mapping:** PRD `CAP-P0-039`; TechSpec §3.7, §4.3, ADR-034
- **Description:** Add the `BackendCapability` descriptor type and the `RuntimeBackend.capabilities(): BackendCapability` accessor to the boundary contract. Define the initial `thread.enumeration` capability bit. This is the shared contract change that all three TS backends and the Rust backend will need to honor in subsequent tickets.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the kernel protocol contract has no capability-advertisement surface today
When the BackendCapability descriptor is added to the RuntimeBackend contract
Then `RuntimeBackend.capabilities()` returns a `BackendCapability` with the `thread.enumeration` boolean bit
And the descriptor type allows additional future bits via index signature
And the contract addition is documented in the kernel authority packet binding appendix
And typecheck passes across the workspace without changes to existing backend behavior (capability defaults are not yet honored at dispatch)
```

**KRT-AM004 TypeScript RuntimeKernel `thread.list` Interface + Dispatch**
- **Type:** Feature
- **Effort:** 2
- **Dependencies:** `KRT-AM003`
- **Capability / Contract Mapping:** PRD `CAP-P0-039`; TechSpec §4.2, ADR-034
- **Description:** Add `thread.list(options?)` to the TypeScript `RuntimeKernel` interface. Implement dispatch in `boundaries/kernel/implementations/typescript/runtime-kernel/` that checks the backend's `capabilities()["thread.enumeration"]` bit and either delegates to `ThreadRepository.list` or throws `TuvrenPersistenceError` code `kernel_capability_unsupported`. Define `KernelThreadListCursor` shape per TechSpec §3.8.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the BackendCapability descriptor exists on RuntimeBackend
When the TypeScript RuntimeKernel adds the thread.list dispatch
Then calling `kernel.thread.list({...})` on a backend advertising `thread.enumeration: true` calls through to the backend's ThreadRepository.list
And calling `kernel.thread.list({...})` on a backend advertising `thread.enumeration: false` throws TuvrenPersistenceError with code `kernel_capability_unsupported`
And the dispatch surface honors limit, cursor, and filter parameters
And unit tests cover both the advertised and non-advertised paths
```

**KRT-AM005 backend-memory ThreadRepository.list Implementation**
- **Type:** Feature
- **Effort:** 2
- **Dependencies:** `KRT-AM004`
- **Capability / Contract Mapping:** PRD `CAP-P0-039`; TechSpec §4.3, ADR-034
- **Description:** Implement `ThreadRepository.list(options?)` in `@tuvren/backend-memory`. Sort by `(createdAtMs ASC, threadId ASC)`. Respect the optional `cursor` and `filter.schemaId`. Implement `capabilities()` to return `{ "thread.enumeration": true }`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the TypeScript RuntimeKernel dispatch exists
When backend-memory implements ThreadRepository.list and capabilities
Then `kernel.thread.list({})` against a memory backend returns all threads in (createdAtMs, threadId) order
And cursor pagination resumes strictly after the (lastCreatedAtMs, lastThreadId) pair encoded in the cursor
And the `filter.schemaId` restricts results to matching threads
And cursor-stability invariants hold under concurrent thread.create operations within the same test
```

**KRT-AM006 backend-sqlite ThreadRepository.list Implementation**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AM005`
- **Capability / Contract Mapping:** PRD `CAP-P0-039`; TechSpec §4.3, §3.5 SQLite Backend Schema, ADR-034
- **Description:** Implement `ThreadRepository.list(options?)` in `@tuvren/backend-sqlite` with the SQL `SELECT * FROM threads WHERE (created_at_ms, thread_id) > (?, ?) [AND schema_id = ?] ORDER BY created_at_ms ASC, thread_id ASC LIMIT ?`. Add a forward-only migration that creates a covering index on `(created_at_ms, thread_id)`. Implement `capabilities()` to return `{ "thread.enumeration": true }`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the backend-memory implementation exists as a reference
When backend-sqlite implements ThreadRepository.list and capabilities
Then a forward-only migration adds the `(created_at_ms, thread_id)` covering index
And the list query uses parameterized SQL and honors cursor + limit + schemaId filter
And the same conformance suite that passes against memory passes against sqlite
And the SQLite backend's `capabilities()` returns the thread.enumeration bit
```

**KRT-AM007 backend-postgres ThreadRepository.list Implementation**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AM005`
- **Capability / Contract Mapping:** PRD `CAP-P0-039`; TechSpec §4.3, §3.5 PostgreSQL Backend Schema, ADR-034
- **Description:** Implement `ThreadRepository.list(options?)` in `@tuvren/backend-postgres` with PostgreSQL-parameterized SQL equivalent to the SQLite implementation. Add a forward-only migration adding the covering index. Implement `capabilities()` to return `{ "thread.enumeration": true }`. Verify the implementation against the existing `devenv`-provisioned PostgreSQL service.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given backend-memory and backend-sqlite implementations exist as references
When backend-postgres implements ThreadRepository.list and capabilities
Then the PostgreSQL migration adds the `(created_at_ms, thread_id)` covering index
And the list query uses prepared statements honoring cursor + limit + schemaId filter
And the same conformance suite that passes against memory and sqlite passes against postgres
And the PostgreSQL backend's `capabilities()` returns the thread.enumeration bit
```

**KRT-AM008 Rust InMemoryKernel `thread_list` Implementation**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AM001`, `KRT-AM003`
- **Capability / Contract Mapping:** PRD `CAP-P0-039`; TechSpec ADR-034
- **Description:** Add `thread_list(options)` to the Rust `InMemoryKernel` at `boundaries/kernel/implementations/rust/kernel/src/memory.rs`. Sort by `(created_at_ms, thread_id)`. Add a `capabilities()` accessor returning the `BackendCapability` equivalent struct. Maintain 1:1 parity with the TypeScript backend-memory behavior.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the TypeScript backend-memory thread.list implementation exists
When the Rust InMemoryKernel adds thread_list and the capability descriptor
Then the Rust implementation matches TypeScript backend-memory result ordering and cursor semantics
And the Rust capability descriptor advertises thread.enumeration support
And the Rust kernel crate's existing unit tests still pass
And a new Rust unit test covers thread_list against deterministic fixtures
```

**KRT-AM009 gRPC ThreadList RPC + Codec Regen + Rust Server**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AM004`, `KRT-AM008`
- **Capability / Contract Mapping:** PRD `CAP-P0-039`; TechSpec §4.9, ADR-034
- **Description:** Add the `ThreadList` RPC to `KernelThreadService` in `boundaries/kernel/interop/grpc/proto/tuvren/kernel/interop/v1/kernel_services.proto`. Define `ThreadListRequest` and `ThreadListResponse` messages in `kernel_types.proto` with the cursor payload as bytes (opaque on the wire). Regenerate TypeScript bindings via `bun run codegen`. Implement the new RPC handler in the Rust gRPC service at `boundaries/kernel/implementations/rust/grpc-service/src/lib.rs`. Add the codec call in the TypeScript `createGrpcRuntimeKernel` adapter.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the TypeScript and Rust local backends support thread.list
When the gRPC proto and Rust server expose ThreadList
Then `buf lint` and `buf breaking` pass against the proto change with the FILE compatibility policy
And `bun run codegen` regenerates the TypeScript bindings without diff drift
And the Rust gRPC service handles ThreadList requests and proxies to InMemoryKernel.thread_list
And the TypeScript `createGrpcRuntimeKernel` adapter exposes `thread.list` over the remote kernel transport
And the interop-smoke suite exercises TS framework → Rust kernel ThreadList end to end
```

**KRT-AM010 Kernel Conformance Plans `thread.enumeration` Check Set**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AM005`, `KRT-AM006`, `KRT-AM007`, `KRT-AM008`
- **Capability / Contract Mapping:** PRD `CAP-P0-039`, `CAP-P1-036`; TechSpec ADR-034, ADR-031
- **Description:** Add a `kernel-protocol.thread.enumeration` check set to all four kernel conformance plans (`kernel-protocol-core.json`, `kernel-protocol-extended.json`, `kernel-restart-recovery.json`, `kernel-run-liveness.json`). The check set evaluates per-backend-capability: backends advertising `thread.enumeration: true` are expected to pass the positive-path checks (ordering, cursor stability, filter correctness); backends advertising `thread.enumeration: false` are marked `not_applicable` per ADR-031. Provide deterministic fixtures.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given all kernel implementations support thread.list
When the kernel conformance plans gain the thread.enumeration check set
Then the new check set is referenced by the bumped kernel authority packet
And all three TypeScript backends produce `pass` evidence for the check set
And the Rust kernel produces `pass` evidence for the check set
And a synthetic non-advertising backend (test-only) produces `not_applicable` evidence rather than `unsupported`
And `bun run conformance` includes the new check set without manual flag passing
```

**KRT-AM011 Canonical Verification Path + Interop-Smoke Evidence Refresh**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** `KRT-AM010`, `KRT-AM009`
- **Capability / Contract Mapping:** PRD `CAP-P0-039`; TechSpec §5.3
- **Description:** Run `bun run codegen`, `bun run conformance`, `bun run interop-smoke`, `bun run verify`, and `bun run compatibility:evidence` from a clean checkout. Refresh `reports/compatibility/compatibility-matrix.json` with the new check set's evidence. Commit the refreshed artifacts.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given all Epic AM tickets through KRT-AM010 have merged
When the canonical verification path is run from a clean checkout
Then `bun run verify` exits zero
And the refreshed compatibility matrix records `pass` for kernel-protocol.thread.enumeration on all three TS backends and the Rust kernel
And the TS-framework-to-Rust-kernel interop smoke evidence covers the new ThreadList RPC
And no checked-in support artifact is stale relative to its sources
```

### Epic AN — `ExecutionHandle.awaitResult` Promotion to Base + `ExecutionResult` Type (KRT)

**Status:** Closed — all 6 tickets implemented and verified under `bun run verify` + `bun run compatibility:evidence`; compatibility evidence now includes the `runtime-api-handle-terminal-value` check set.

**KRT-AN001 Framework Specification v0.18 Bump**
- **Type:** Chore
- **Effort:** 1
- **Dependencies:** None
- **Capability / Contract Mapping:** PRD `CAP-P0-042`; TechSpec ADR-035
- **Description:** Bump `docs/KrakenFrameworkSpecification.md` to v0.18. Update §7.1 to add `awaitResult(): Promise<ExecutionResult>` to the base `ExecutionHandle` definition. Define the `ExecutionResult` discriminated union in spec prose. Clarify that §10.6 `OrchestrationHandle.awaitResult` overrides to return `OrchestrationResult`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the framework specification at v0.17 places awaitResult only on OrchestrationHandle
When the framework specification is bumped to v0.18
Then §7.1 lists awaitResult on the base ExecutionHandle with the ExecutionResult return shape
And §10.6 documents the OrchestrationResult subtype with child-result aggregation
And the spec change is reviewable as one self-contained amendment
```

**KRT-AN002 `@tuvren/runtime-api` `ExecutionHandle.awaitResult` + `ExecutionResult` Types**
- **Type:** Feature
- **Effort:** 2
- **Dependencies:** `KRT-AN001`
- **Capability / Contract Mapping:** PRD `CAP-P0-042`; TechSpec §4.1, ADR-035
- **Description:** Add `awaitResult(): Promise<ExecutionResult>` to the `ExecutionHandle` interface in `@tuvren/runtime-api` (pre-AP consolidation; post-AP, the type lives in `@tuvren/core/execution`). Define `ExecutionResult` and `OrchestrationResult` discriminated unions. Override `OrchestrationHandle.awaitResult` return type to `OrchestrationResult`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the framework specification has been bumped to v0.18
When the runtime-api types add awaitResult and ExecutionResult
Then ExecutionHandle.awaitResult resolves to ExecutionResult
And ExecutionResult is a discriminated union with "completed" and "failed" branches
And OrchestrationHandle.awaitResult resolves to OrchestrationResult extending ExecutionResult with childResults
And typecheck passes across the workspace including all consumers
```

**KRT-AN003 `RuntimeExecutionHandle.awaitResult` Implementation**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AN002`
- **Capability / Contract Mapping:** PRD `CAP-P0-042`; TechSpec ADR-035
- **Description:** Implement `awaitResult` on `RuntimeExecutionHandle` in `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-execution-handle.ts`. Reuse the existing internal event-buffer plumbing if present; otherwise collect events into a private buffer. Resolve on the first `turn.end` event. Synthesize the result from the final assistant message in collected events plus the final `status()` snapshot. Reject with `TuvrenRuntimeError` code `execution_cancelled` on cancellation.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the ExecutionHandle interface declares awaitResult
When RuntimeExecutionHandle implements awaitResult
Then awaiting a turn that completes returns an ExecutionResult with status "completed" and the final assistant message
And awaiting a turn that fails returns an ExecutionResult with status "failed" carrying the error
And awaiting a cancelled turn rejects with TuvrenRuntimeError code "execution_cancelled"
And the same handle may be awaited multiple times and returns the same ExecutionResult
And awaitResult does not interfere with concurrent events() iteration
```

**KRT-AN004 `OrchestrationHandleImpl.awaitResult` Override with Child Aggregation**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AN003`
- **Capability / Contract Mapping:** PRD `CAP-P0-042`; TechSpec ADR-035
- **Description:** Override `awaitResult` on `OrchestrationHandleImpl` in `boundaries/framework/implementations/typescript/runtime-core/src/lib/orchestration-runtime.ts` to additionally aggregate spawned child handles' `awaitResult` resolutions into `childResults`. The existing internal `awaitResult` becomes the parent-half; child aggregation runs after the parent completes.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given RuntimeExecutionHandle.awaitResult exists
When OrchestrationHandleImpl overrides awaitResult
Then awaitResult on a parent orchestration returns an OrchestrationResult with childResults keyed by descendant source identity
And orchestrations with no spawned children resolve to OrchestrationResult with empty childResults
And child failures are recorded in childResults without failing the parent unless the parent itself failed
And test coverage exercises a parent-plus-two-children orchestration
```

**KRT-AN005 Migrate `awaitResult` Conformance Checks to New `runtime-api-handle-terminal-value` Set**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** `KRT-AN003`, `KRT-AN004`
- **Capability / Contract Mapping:** PRD `CAP-P0-042`, `CAP-P1-036`; TechSpec ADR-035, ADR-030
- **Description:** Create a new `runtime-api-handle-terminal-value` check set in `boundaries/framework/conformance/plans/runtime-api-callables.json` exercising `awaitResult` against the base `ExecutionHandle`. Migrate the two existing `runtime-orchestration.launch.await-result-rejects-before-parent-start` and `runtime-orchestration.surfaces.await-result-failure-rejects` checks from `runtime-api-orchestration.json` to the new check set where their semantics apply to the base handle; the orchestration plan keeps its subtree-result-specific assertions.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the awaitResult promotion is implemented in runtime-core
When the conformance plans are updated
Then runtime-api-callables.json contains the runtime-api-handle-terminal-value check set
And the check set covers positive-path completion, failure-path rejection, cancellation rejection, and repeat-await idempotency
And the migrated orchestration checks evaluate subtree-result semantics only, not base-handle semantics
And `bun run conformance` includes the new check set automatically
```

**KRT-AN006 Runtime-API Authority Packet Binding Appendix Update**
- **Type:** Chore
- **Effort:** 1
- **Dependencies:** `KRT-AN001`, `KRT-AN002`
- **Capability / Contract Mapping:** PRD `CAP-P0-042`; TechSpec ADR-026, ADR-035
- **Description:** Update the runtime-api authority packet binding appendix at `boundaries/framework/contracts/runtime-api/spec/bindings/typescript.md` to add `awaitResult` to the `ExecutionHandle` binding section. Note the `ExecutionResult` discriminated union and the `OrchestrationResult` extension. Bump the packet version if required by ADR-026 rules.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the framework specification and the runtime-api types include awaitResult
When the authority packet binding appendix is updated
Then the binding appendix documents awaitResult on the base ExecutionHandle binding
And the ExecutionResult discriminated union is documented
And the packet passes authority-packet freshness checks via `bun run codegen`
```

### Epic AO — `TuvrenRuntime` Durable-Read Surface (KRT)

**Status:** Closed — all 7 tickets implemented and verified under `bun run verify` + `bun run compatibility:evidence`; compatibility evidence now includes durable-read coverage for list/read paths and capability rejection.

**KRT-AO001 `TuvrenRuntime` Five-Method Signature Addition**
- **Type:** Feature
- **Effort:** 2
- **Dependencies:** `KRT-AM004`, `KRT-AN002`
- **Capability / Contract Mapping:** PRD `CAP-P0-043` through `CAP-P0-047`; TechSpec §4.1, ADR-036
- **Description:** Add the five durable-read method signatures (`listThreads`, `listBranches`, `getTurnState`, `getTurnHistory`, `readBranchMessages`) to the `TuvrenRuntime` interface. Export the supporting types (`ThreadSummary`, `BranchSummary`, `TurnSnapshot`, `ListThreadsCursor`, `TurnHistoryCursor`, `BranchMessagesCursor`).
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the TuvrenRuntime interface lacks durable-read methods
When the five durable-read method signatures are added
Then TuvrenRuntime exposes listThreads, listBranches, getTurnState, getTurnHistory, readBranchMessages
And the supporting return types (ThreadSummary, BranchSummary, TurnSnapshot) and the three cursor types are exported
And typecheck passes across the workspace including all consumers
```

**KRT-AO002 Durable-Read Cursor Encode/Decode Helpers**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AO001`
- **Capability / Contract Mapping:** PRD `CAP-P0-043`, `CAP-P0-046`, `CAP-P0-047`; TechSpec §3.8, ADR-036
- **Description:** Implement cursor encode/decode helpers for `ListThreadsCursor`, `TurnHistoryCursor`, and `BranchMessagesCursor` per TechSpec §3.8. Cursors are URL-safe base64-encoded JSON. Decoding malformed cursors raises `TuvrenValidationError` code `invalid_durable_read_cursor`. Filter-mismatch detection between paged calls raises `TuvrenValidationError` code `durable_read_cursor_filter_mismatch`. Head-drift detection raises `TuvrenValidationError` code `durable_read_cursor_head_drift`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the cursor shapes are specified
When the cursor helpers are implemented
Then encode/decode round-trips preserve the structured payload bit-for-bit
And decoding a malformed cursor raises TuvrenValidationError code "invalid_durable_read_cursor"
And paging listThreads with a mismatched filter between calls raises "durable_read_cursor_filter_mismatch"
And paging readBranchMessages after head drift raises "durable_read_cursor_head_drift"
And unit tests cover round-trips and every error path
```

**KRT-AO003 `durable-reads.ts` — `listThreads` + `listBranches`**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AO002`
- **Capability / Contract Mapping:** PRD `CAP-P0-043`, `CAP-P0-044`; TechSpec ADR-036
- **Description:** Implement the `listThreads` and `listBranches` methods in a new `durable-reads.ts` module under `boundaries/framework/implementations/typescript/runtime-core/src/lib/`. `listThreads` composes `kernel.thread.list(options)` and translates `StoredThread[]` into `ThreadSummary[]`. `listBranches` composes `kernel.branch.list(threadId)` and translates the `Array<[string, HashString]>` shape into `BranchSummary[]`. Both methods translate cursors at the boundary.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the cursor helpers and TuvrenRuntime signatures exist
When listThreads and listBranches are implemented
Then listThreads returns paginated ThreadSummary results in (createdAtMs, threadId) order
And listBranches returns BranchSummary results for the named thread
And kernel-capability-rejection from listThreads surfaces as TuvrenPersistenceError code "kernel_capability_unsupported"
And both methods are exposed through the assembled TuvrenRuntime instance
```

**KRT-AO004 `durable-reads.ts` — `getTurnState` + `getTurnHistory`**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AO003`
- **Capability / Contract Mapping:** PRD `CAP-P0-045`, `CAP-P0-046`; TechSpec ADR-036
- **Description:** Implement `getTurnState` and `getTurnHistory` in `durable-reads.ts`. `getTurnState` composes `kernel.branch.get` (when `turnNodeHash` is omitted, to find the current head), `kernel.node.get` to fetch the TurnNode, `kernel.tree.manifest` to enumerate paths, and `kernel.store.get` for each manifest reference relevant to the requested shape. Returns a `TurnSnapshot`. `getTurnHistory` returns an async iterator that lazily walks `kernel.node.walkBack` from the resolved start point (current head or cursor's `lastTurnNodeHash`), respecting `limit`, and yielding `TurnSnapshot` values in newest-first order.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given listThreads and listBranches are implemented
When getTurnState and getTurnHistory are implemented
Then getTurnState returns a TurnSnapshot for the current head when turnNodeHash is omitted
And getTurnState returns a TurnSnapshot for any specific turnNodeHash on the branch
And getTurnHistory yields TurnSnapshot values newest-first, respecting limit and cursor
And the async iterator stops at the branch's root TurnNode or at the limit, whichever comes first
And lineage validation rejects requests targeting nodes outside the branch's lineage
```

**KRT-AO005 `durable-reads.ts` — `readBranchMessages` with Head-Drift Detection**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AO004`
- **Capability / Contract Mapping:** PRD `CAP-P0-047`; TechSpec §3.8, ADR-036
- **Description:** Implement `readBranchMessages` in `durable-reads.ts`. Compose `kernel.branch.get` to find the current head, `kernel.tree.resolve(treeHash, "messages")` to enumerate the ordered messages path, and `kernel.store.get` per message hash. Apply cursor `positionFromOldest` and `branchHeadAtCursorIssuance` to handle pagination. Detect head drift between paged calls and raise `durable_read_cursor_head_drift` when the messages prefix up to the cursor position has diverged.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given getTurnState and getTurnHistory are implemented
When readBranchMessages is implemented
Then readBranchMessages returns durable TuvrenMessage[] from the branch's current head in oldest-first order
And cursor pagination resumes strictly after the recorded positionFromOldest when the branch head has not moved
And paging after head movement that preserved the prefix up to the cursor position resumes normally
And paging after head movement that diverged the prefix raises "durable_read_cursor_head_drift" so the host can restart
And unit tests cover both stable-head pagination and divergent-head detection
```

**KRT-AO006 `runtime-api-durable-reads` Conformance Check Set**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AO005`
- **Capability / Contract Mapping:** PRD `CAP-P0-043` through `CAP-P0-047`, `CAP-P1-036`; TechSpec ADR-036, ADR-030
- **Description:** Add a `runtime-api-durable-reads` check set to `boundaries/framework/conformance/plans/runtime-api-callables-extended.json` with positive-path coverage for all five methods, pagination coverage (cursor stability and forward progress), capability-rejected coverage for `listThreads` against a synthetic non-enumerating backend in the framework testkit, lineage-bounded coverage for `getTurnState`/`getTurnHistory`, and head-drift coverage for `readBranchMessages`. Run against all three real backends.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given all five durable-read methods are implemented
When the runtime-api-durable-reads check set is added
Then the check set covers positive-path, pagination, lineage-bounded, capability-rejected, and head-drift scenarios
And the check set runs against memory, sqlite, and postgres backends with `pass` evidence
And the synthetic non-enumerating backend produces capability-rejected behavior matching the spec
And `bun run conformance` includes the new check set automatically
```

**KRT-AO007 Delete `createPlaygroundKernelInspector` and Migrate REPL Host Reads**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** `KRT-AO005`
- **Capability / Contract Mapping:** PRD `CAP-P0-047`, §1.1 (proving-host SDK-only invariant); TechSpec ADR-036, ADR-041
- **Description:** Delete `createPlaygroundKernelInspector` from `boundaries/hosts/implementations/typescript/repl/src/lib/playground-kernel.ts` (and its duplicate in the playground host package). Replace the three call sites in `@tuvren/repl-host` (`readBranchMessages`, `readBranchStatus`, equivalent) with calls to `runtime.readBranchMessages` and `runtime.getTurnState`. Delete the `boundaries/hosts/implementations/typescript/playground/src/lib/playground-kernel.ts` copy.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the TuvrenRuntime durable-read surface is implemented and covered by conformance
When createPlaygroundKernelInspector is deleted and the REPL host is migrated
Then no source file under boundaries/hosts/implementations/typescript/ imports kernel internals directly
And the REPL host's branch-message and branch-status reads go through TuvrenRuntime
And the playground-kernel.ts file is deleted from both the repl and playground host packages
And the REPL proving-host scenario suite still passes
```

### Epic AP — `@tuvren/core` Consolidation + Fold `runtime-core` Into `@tuvren/runtime` (KRT)

**Status:** Closed — all 11 tickets implemented and verified under `bun run verify` + `bun run compatibility:evidence`. Correction to KRT-AP008 scope: the source-bearing `@tuvren/runtime-core` package was folded into `@tuvren/runtime`, while the old workspace handle remains for one cycle as a deprecated compatibility shim. Closure also kept the five retired contract handles as deprecated one-cycle shims while making `@tuvren/core` and `@tuvren/runtime` the source-bearing surfaces.

**KRT-AP001 Atomic-Merge Feasibility Spike**
- **Type:** Spike
- **Effort:** 2
- **Dependencies:** `KRT-AO007`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`; TechSpec ADR-037, §5.5.4
- **Description:** Inventory every internal import of `@tuvren/core-types`, `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, `@tuvren/driver-api`, and `@tuvren/runtime-core` across the workspace. Determine whether a one-shot codemod can rewrite all imports atomically or whether a staged migration with shim packages is required for the transition. Recommend one path and document the codemod or shim-package strategy.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the workspace contains many internal imports of the five contract packages and the runtime-core helper
When the atomic-merge feasibility spike completes
Then the spike report inventories every import site grouped by source package and target subpath
And the spike recommends either a one-shot codemod or a staged shim-package migration
And the recommendation includes effort estimates and risk classification for each path
And the recommended path is recorded in `constitution/support/live/` as a spike output
```

**KRT-AP002 `@tuvren/core` Package Scaffolding with 9 Export Entries**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AP001`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`; TechSpec ADR-037, §5.1
- **Description:** Create the new `@tuvren/core` workspace package at `boundaries/shared/contracts/core/implementations/typescript/`. Scaffold the source directory layout: `src/index.ts` plus eight subpath directories (`messages/`, `tools/`, `events/`, `errors/`, `execution/`, `driver/`, `provider/`, `extensions/`). Configure `package.json` with conditional exports for the 9 entries pointing at the compiled `dist/<subpath>/index.js` and `dist/<subpath>/index.d.ts`. Configure `tsup.config.ts` with 9 build entries.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the spike has recommended the migration path
When the @tuvren/core package scaffolding is committed
Then `@tuvren/core` exists as a workspace package with exactly 9 export entries
And `bun run nx run @tuvren/core:build` produces dist artifacts for all 9 entries
And the package has no source content yet (placeholder index files only)
And the existing workspace continues to build and test without depending on @tuvren/core yet
```

**KRT-AP003 Migrate Source from 5 Retired Packages Into `@tuvren/core` Subpaths**
- **Type:** Chore
- **Effort:** 8
- **Dependencies:** `KRT-AP002`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`; TechSpec ADR-037, §5.5.4
- **Description:** Move source from `@tuvren/core-types`, `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, and `@tuvren/driver-api` into the appropriate `@tuvren/core/src/<subpath>/` directories per TechSpec §5.5.4 step 2. Preserve all existing exports' identity (every symbol must remain importable from the new subpath). Do not yet migrate consumers' imports — KRT-AP006 handles that.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given @tuvren/core scaffolding exists
When source migration from the five retired packages completes
Then every previously-exported symbol from the five packages is available via the matching @tuvren/core subpath
And the five source packages still build (they re-export from @tuvren/core internally as a temporary shim during this ticket)
And typecheck across the workspace passes
And no symbol has been silently renamed or had its signature changed
```

**KRT-AP004 Merge Authority Packets Into `boundaries/shared/contracts/core/spec/authority-packet.json`**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** `KRT-AP003`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`, `CAP-P0-037`; TechSpec ADR-026, ADR-037
- **Description:** Merge the runtime-api, event-stream, tool-contracts, driver-api, and core-types authority packets into one new packet at `boundaries/shared/contracts/core/spec/authority-packet.json` declaring all 8 subpath surfaces as binding sections. Move existing TypeSpec sources from `tool-contracts/spec/typespec/` (and any other source-bearing surfaces) under `boundaries/shared/contracts/core/spec/typespec/` with namespace adjustments.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given source migration is complete
When the merged authority packet is created
Then the new packet declares 8 subpath surfaces with their authoritative sources, generated artifacts, conformance plans, and binding projections
And the five retired packets are removed from their original locations
And `bun run codegen` regenerates artifacts from the new packet without diff drift
And authority-packet freshness verification passes
```

**KRT-AP005 Update `portability-gate.ts` for New Packet Layout**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** `KRT-AP004`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`; TechSpec ADR-037
- **Description:** Update `tools/scripts/portability-gate.ts` to recognize the new packet layout. The 12-packet count drops by 4 (the four absorbed packets are now declared as binding sections inside the merged core packet); the script's expected packet count and packet identity list are updated accordingly.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the merged authority packet exists
When portability-gate.ts is updated
Then `bun run nx run-many --target=portability-gate` passes with the new expected packet count
And the script's packet identity list reflects the consolidated layout
And no other packet has been silently dropped from the portability requirement
```

**KRT-AP006 Codemod Internal Imports Across Workspace**
- **Type:** Chore
- **Effort:** 5
- **Dependencies:** `KRT-AP004`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`; TechSpec ADR-037, §5.5.4 step 8
- **Description:** Run one mechanical codemod across the workspace replacing imports from `@tuvren/core-types`, `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, `@tuvren/driver-api` with the appropriate `@tuvren/core/<subpath>` imports per TechSpec §5.5.4 step 8. The codemod tool itself lives under `tools/scripts/` and is committed for auditability.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the merged @tuvren/core package exposes all symbols at the new subpath locations
When the codemod is run
Then no source file in the workspace imports from any of the five retired package names
And every migrated import resolves to the correct @tuvren/core subpath
And the codemod tool is committed under tools/scripts/ for future audit
And typecheck passes after the codemod
```

**KRT-AP007 Deprecated Shim Packages for the 5 Retired Handles**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** `KRT-AP006`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`; TechSpec ADR-037
- **Description:** Replace the source-bearing implementations of `@tuvren/core-types`, `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, `@tuvren/driver-api` with thin deprecated shim packages. Each shim contains only an `index.ts` that re-exports from the matching `@tuvren/core` subpath plus an optional development-mode `console.warn`. The shims preserve the published-name compatibility for one cycle.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given internal imports have been migrated to @tuvren/core subpaths
When the deprecated shim packages are committed
Then each retired package handle still resolves and re-exports the correct symbols
And importing from a retired handle emits a development-mode deprecation warning
And the shim packages are flagged in their README as removal-targets for the next minor release
And the workspace continues to build and test
```

**KRT-AP008 Fold Source-Bearing `runtime-core` Into `@tuvren/runtime`**
- **Type:** Chore
- **Effort:** 5
- **Dependencies:** `KRT-AP006`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`; TechSpec ADR-037, ADR-040
- **Description:** Move source from `boundaries/framework/implementations/typescript/runtime-core/src/` into `boundaries/framework/implementations/typescript/runtime/src/lib/` (replacing the current thin barrel). `@tuvren/runtime` becomes the slim convenience package per ADR-040 with one root export entry. Rename the internal `createTuvrenRuntimeCore` factory to `createTuvrenRuntime` (the `Core` suffix exposed an internal name; ADR-040). Update internal imports. Keep `@tuvren/runtime-core` only as a deprecated re-export shim for one cycle, matching the retired contract-handle shim policy.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the @tuvren/core consolidation has landed
When the source-bearing @tuvren/runtime-core implementation is folded into @tuvren/runtime
Then @tuvren/runtime-core no longer exists as a source-bearing workspace package
And the old @tuvren/runtime-core handle remains only as a deprecated re-export shim for one cycle
And the createTuvrenRuntimeCore factory is renamed to createTuvrenRuntime and exported from @tuvren/runtime
And all workspace consumers import from @tuvren/runtime instead of @tuvren/runtime-core
And typecheck and conformance still pass
```

**KRT-AP009 Update PeerDependency Declarations Across All Leaf Packages**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** `KRT-AP008`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`; TechSpec ADR-037
- **Description:** Replace each leaf package's `dependencies` declaration of the five retired packages (including `@tuvren/core-types` and any others now subsumed by `@tuvren/core`) with a single `peerDependencies` entry on `@tuvren/core`. Leaf packages: `@tuvren/backend-memory`, `@tuvren/backend-sqlite`, `@tuvren/backend-postgres`, `@tuvren/stream-core`, `@tuvren/stream-sse`, `@tuvren/stream-agui`, `@tuvren/driver-react`, `@tuvren/provider-bridge-ai-sdk`, `@tuvren/kernel-runtime`, `@tuvren/kernel-protocol`, `@tuvren/runtime`. Also declare the peer in `peerDependenciesMeta` as required.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the runtime-core fold and consolidation are complete
When peerDependency declarations are updated across leaf packages
Then every leaf package declares @tuvren/core as a peerDependency (not a regular dependency)
And bun install succeeds with the peer-resolution honored across the workspace
And no leaf package exports a duplicated copy of any @tuvren/core symbol
And typecheck passes
```

**KRT-AP010 `@tuvren/core` Optional Peer Deps Declaration**
- **Type:** Chore
- **Effort:** 1
- **Dependencies:** `KRT-AP008`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`, `CAP-P0-040`; TechSpec §1, ADR-038
- **Description:** Declare `zod@4.4.3` and `@standard-schema/spec@1.1.0` as optional `peerDependencies` of `@tuvren/core` with `peerDependenciesMeta.<name>.optional = true`. These support the upcoming Schema Authoring Helper (Epic AQ) without forcing installation on hosts that author tools only through wrapped JSON Schema.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given @tuvren/core is the consolidated shared-primitive package
When zod and @standard-schema/spec are declared as optional peerDependencies
Then both packages are marked optional in peerDependenciesMeta
And bun install succeeds without installing zod or @standard-schema/spec when no consumer requests them
And typecheck passes (peer types resolve through the workspace when consumers do install them)
```

**KRT-AP011 Clean-Checkout Verify and Compatibility Refresh**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** `KRT-AP009`, `KRT-AP010`, `KRT-AP005`, `KRT-AP007`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`; TechSpec §5.3
- **Description:** Run `bun install`, `bun run typecheck`, `bun run lint`, `bun run test`, `bun run conformance`, `bun run codegen`, `bun run interop-smoke`, `bun run verify`, and `bun run compatibility:evidence` from a clean checkout. Refresh `reports/compatibility/compatibility-matrix.json`. Commit the refreshed artifacts. This is the gate that confirms the atomic consolidation succeeded.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given all Epic AP tickets through KRT-AP010 have merged
When the canonical verification path is run from a clean checkout
Then `bun run verify` exits zero
And the refreshed compatibility matrix records the new packet layout
And the portability-gate target passes with the updated packet count
And no stale support artifact references the retired package handles in a normative way
```

### Epic AQ — Schema Authoring Helper (`defineTool` + `FlexibleSchema`) (KRT)

**Status:** Closed — all 5 tickets implemented and verified through the schema-authoring unit tests, `runtime-api-schema-authoring` conformance coverage, and curated `@tuvren/runtime` re-exports.

**KRT-AQ001 `@tuvren/core` Schema-Authoring Type Exports**
- **Type:** Feature
- **Effort:** 2
- **Dependencies:** `KRT-AP011`
- **Capability / Contract Mapping:** PRD `CAP-P0-040`; TechSpec §4.14, ADR-038
- **Description:** Add the `Schema<T>` branded type, `schemaSymbol`, `FlexibleSchema<INPUT>` union, `ZodSchema<T>`, `StandardSchema<T>`, `LazySchema<T>` type exports to `@tuvren/core/tools`. The optional peer deps from KRT-AP010 supply the underlying library types.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given @tuvren/core/tools is the consolidated tools subpath
When the schema-authoring type exports are added
Then @tuvren/core/tools exports Schema, schemaSymbol, FlexibleSchema, ZodSchema, StandardSchema, LazySchema
And the types resolve correctly with or without the optional zod / @standard-schema/spec peers installed
And typecheck passes across the workspace
```

**KRT-AQ002 `asSchema` Normalizer with 6-Branch Precedence**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AQ001`
- **Capability / Contract Mapping:** PRD `CAP-P0-040`; TechSpec §4.14, ADR-038
- **Description:** Implement `asSchema<T>(schema: FlexibleSchema<T>): Schema<T>` with the six-branch precedence from ADR-038: already-wrapped → Zod v4 → Standard Schema non-zod → Standard Schema with vendor "zod" → lazy function → bare TuvrenJsonSchema. Implement `jsonSchema<T>(schema, opts?)`, `zodSchema<T>(schema)`, `standardSchema<T>(schema)` adapter helpers. Borrow the detection logic patterns from the AI SDK source (re-implementation, not copy).
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the schema authoring type surface is defined
When asSchema and the adapter helpers are implemented
Then asSchema correctly routes each FlexibleSchema input through its precedence branch
And jsonSchema wraps a TuvrenJsonSchema with a TS brand
And zodSchema accepts both Zod v3 and Zod v4 instances
And standardSchema accepts any Standard Schema-compliant input
And the ambiguous-case fixtures from ADR-038 (Zod v3 implementing ~standard with vendor "zod"; lazy function returning Zod v4; bare TuvrenJsonSchema) route as specified
And unit tests cover every precedence branch including the ambiguous cases
```

**KRT-AQ003 `defineTool` Helper Implementation**
- **Type:** Feature
- **Effort:** 2
- **Dependencies:** `KRT-AQ002`
- **Capability / Contract Mapping:** PRD `CAP-P0-040`; TechSpec §4.14, ADR-038
- **Description:** Implement `defineTool<INPUT, OUTPUT>({ name, description, inputSchema, execute, approval?, timeout?, metadata? })` in `@tuvren/core/tools`. Normalize `inputSchema` via `asSchema` once at definition time. Return a `TuvrenToolDefinition` whose `inputSchema` field carries the normalized `CustomSchema` shape that the Tool Execution Gateway has always accepted.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given asSchema and the adapter helpers exist
When defineTool is implemented
Then defineTool returns a TuvrenToolDefinition whose inputSchema satisfies the CustomSchema boundary contract
And the execute callback's input parameter is strictly typed against the inferred INPUT from inputSchema
And normalization runs once at definition time, not per-invocation
And the boundary CustomSchema contract is unchanged; existing tool definitions continue to work without using defineTool
```

**KRT-AQ004 `runtime-api-schema-authoring` Conformance Check Set**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AQ003`
- **Capability / Contract Mapping:** PRD `CAP-P0-040`, `CAP-P1-036`; TechSpec ADR-038, ADR-030
- **Description:** Add a `runtime-api-schema-authoring` check set to `boundaries/framework/conformance/plans/runtime-api-callables-extended.json` with at least one fixture per precedence branch, including the ambiguous-case fixtures named in ADR-038. The check set evaluates correct adapter routing and tool-definition-output equivalence.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given defineTool and asSchema are implemented
When the runtime-api-schema-authoring check set is added
Then the check set covers all six precedence branches with at least one fixture each
And the ambiguous-case fixtures from ADR-038 produce the documented routing decisions
And the check set passes against the TypeScript implementation
And `bun run conformance` includes the new check set automatically
```

**KRT-AQ005 Re-export `defineTool` and Helpers from `@tuvren/runtime`**
- **Type:** Chore
- **Effort:** 1
- **Dependencies:** `KRT-AQ003`
- **Capability / Contract Mapping:** PRD `CAP-P0-040`, `CAP-P0-049`; TechSpec ADR-038, ADR-040
- **Description:** Re-export `defineTool`, `asSchema`, `jsonSchema`, `zodSchema`, `standardSchema` from `@tuvren/runtime`'s curated re-export surface so hosts that import only `@tuvren/runtime` for batteries-included usage get the helpers without separately importing from `@tuvren/core/tools`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given defineTool and helpers exist in @tuvren/core/tools
When @tuvren/runtime re-exports them
Then a host importing only @tuvren/runtime can call defineTool, asSchema, jsonSchema, zodSchema, standardSchema
And the re-exports preserve type identity (no duplicated type definitions)
And typecheck passes for hosts using both the curated re-exports and direct @tuvren/core/tools imports
```

### Epic AR — `createTuvren` Batteries-Included Factory (KRT)

**Status:** Done — all five tickets closed (KRT-AR001..AR005)

**KRT-AR001 `CreateTuvrenOptions` and `TuvrenInstance` Types**
- **Type:** Feature
- **Effort:** 2
- **Dependencies:** `KRT-AP011`
- **Capability / Contract Mapping:** PRD `CAP-P0-048`; TechSpec §4.16, ADR-040
- **Description:** Define the `CreateTuvrenOptions` interface (including `BackendKind`, `DriverKind`, the inline option discriminated unions per backend) and the `TuvrenInstance` interface in `@tuvren/runtime`. Export both from the package root.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given @tuvren/runtime is the slim convenience package
When CreateTuvrenOptions and TuvrenInstance types are defined
Then both types are exported from @tuvren/runtime's root
And the type signatures match the contract in TechSpec §4.16
And typecheck passes across the workspace
```

**KRT-AR002 `createTuvren` Factory Implementation**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AR001`
- **Capability / Contract Mapping:** PRD `CAP-P0-048`; TechSpec §4.16, ADR-040
- **Description:** Implement `createTuvren(options)` in `@tuvren/runtime`'s root `index.ts`. Wire the chosen backend through the appropriate backend factory, build the kernel via `createRuntimeKernel({ backend })`, build a driver registry containing the requested driver (default `react`), and construct the framework runtime via the internal `createTuvrenRuntime` helper. Return a `TuvrenInstance` with `runtime`, `orchestration`, `kernel`, optional `provider`, and `[Symbol.asyncDispose]`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the CreateTuvrenOptions and TuvrenInstance types are defined
When createTuvren is implemented
Then a host can construct a runnable TuvrenInstance from one factory call against any of memory, sqlite, or postgres backends
And the default driver is "react" when no driver option is supplied
And inline option shapes (e.g. { backend: "sqlite", options: { databasePath: "..." } }) are honored
And explicit RuntimeBackend instances are accepted as the backend option
```

**KRT-AR003 `[Symbol.asyncDispose]` Resource Cleanup Wiring**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AR002`
- **Capability / Contract Mapping:** PRD `CAP-P0-048`; TechSpec §4.16, ADR-040
- **Description:** Implement `[Symbol.asyncDispose]` on the returned `TuvrenInstance` so it closes any `McpToolSource` references in `tools`, releases backend resources (closes the SQLite file handle, returns the PostgreSQL pool), and resolves any pending kernel work cleanly. Support TC39 `await using` syntax.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given createTuvren returns a TuvrenInstance
When [Symbol.asyncDispose] is implemented
Then `await using tuvren = await createTuvren({ backend: "memory" })` triggers cleanup at scope exit
And SQLite file handles are closed after disposal
And PostgreSQL connection pools are returned after disposal
And MCP tool sources have their close() invoked during disposal
And pending kernel work is awaited or cancelled cleanly during disposal
```

**KRT-AR004 `runtime-api-batteries-included` Conformance Check Set**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AR003`
- **Capability / Contract Mapping:** PRD `CAP-P0-048`, `CAP-P1-036`; TechSpec ADR-040, ADR-030
- **Description:** Add a `runtime-api-batteries-included` check set to `boundaries/framework/conformance/plans/runtime-api-callables-extended.json` exercising `createTuvren` compositional correctness across all three backend kinds with the `aimock-openai` provider. Cover full lifecycle: construct → execute a turn → readBranchMessages → dispose.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given createTuvren and disposal are implemented
When the runtime-api-batteries-included check set is added
Then the check set covers construct + executeTurn + read + dispose against memory, sqlite, postgres
And the check set produces `pass` evidence on all three backends
And `bun run conformance` includes the new check set automatically
```

**KRT-AR005 Rename `createTuvrenRuntimeCore` → `createTuvrenRuntime` and Curated Re-exports**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** `KRT-AR002`
- **Capability / Contract Mapping:** PRD `CAP-P0-049`; TechSpec ADR-037, ADR-040
- **Description:** Complete the rename from KRT-AP008 by ensuring all consumers (including tests, the REPL host, and any examples) use `createTuvrenRuntime`. Add curated re-exports to `@tuvren/runtime`'s root: backend factories (`createMemoryBackend`, `createSqliteBackend`, `createPostgresBackend`), kernel factories (`createRuntimeKernel`, `createGrpcRuntimeKernel`), driver factory (`createReActDriver`), driver registry (`createDriverRegistry`), orchestration runtime factory (`createOrchestrationRuntime`), `createTuvrenRuntime`, and runtime telemetry constants. Hosts that need fine-grained control still get everything through one import path.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given createTuvren exists as the batteries-included entrypoint
When the curated re-exports are added to @tuvren/runtime
Then a host importing only @tuvren/runtime can compose a runtime manually using the re-exported factories or batteries-included via createTuvren
And the createTuvrenRuntimeCore name is no longer exported anywhere
And the workspace continues to build and test
```

### Epic AS — MCP Client Container (`@tuvren/mcp-client`) (KRT)

**Status:** Active — depends on Epics AP, AQ, AR

**KRT-AS001 Spike: `@modelcontextprotocol/sdk@1.29.0` API Surface Verification**
- **Type:** Spike
- **Effort:** 3
- **Dependencies:** `KRT-AQ002`
- **Capability / Contract Mapping:** PRD `CAP-P0-041`; TechSpec ADR-039, §1
- **Description:** Verify that `@modelcontextprotocol/sdk@1.29.0`'s public API surface matches the assumptions in TechSpec §4.15 and ADR-039. Confirm: (1) the SDK exports a shared `Client` core that supports stdio plus HTTP/SSE-family transports through a pluggable transport interface; (2) the package's inherited `zod` peer/runtime requirement can be satisfied inside `@tuvren/mcp-client` through the TechSpec-approved direct dependency without adding `zod` to Tuvren's public peer surface; (3) tool advertisements include `inputSchema`, optional `outputSchema`, and optional `annotations`; (4) transport-error envelopes are translatable to `TuvrenProviderError`. If any assumption is wrong, document the necessary contract or implementation amendment.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given @modelcontextprotocol/sdk@1.29.0 is the locked dependency
When the API surface spike is completed
Then the spike report confirms or refutes each of the four assumptions
And any refuted assumption is paired with a proposed contract or implementation amendment
And the spike output is recorded under constitution/support/live/ for future audit
```

**KRT-AS002 New `@tuvren/mcp-client` Workspace Package Scaffolding**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** `KRT-AS001`
- **Capability / Contract Mapping:** PRD `CAP-P0-041`; TechSpec ADR-039, §5.1
- **Description:** Create the new `@tuvren/mcp-client` workspace package at `boundaries/providers/implementations/typescript/mcp-client/`. Configure `package.json` with `@modelcontextprotocol/sdk@1.29.0` and `zod@4.4.3` as direct dependencies, and `@tuvren/core` as the only required Tuvren peer dependency. Configure `tsup.config.ts` and `tsconfig*.json` per the boundary conventions.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the spike confirms the SDK assumptions
When @tuvren/mcp-client is scaffolded
Then the package exists as a workspace member with the locked SDK dependency
And the package declares `zod@4.4.3` as a direct dependency to satisfy the pinned SDK's upstream peer requirement
And the package peer-depends on @tuvren/core
And `bun run nx run @tuvren/mcp-client:build` produces empty dist artifacts (no source yet)
```

**KRT-AS003 Internal `MCPClient` Interface + stdio Transport**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AS002`
- **Capability / Contract Mapping:** PRD `CAP-P0-041`; TechSpec §4.15, ADR-039
- **Description:** Implement the internal `MCPClient` interface wrapping the upstream SDK's client with one connection-lifecycle surface (`initialize`, `listTools`, `invokeTool`, `close`). Implement the stdio transport implementation that conforms to that interface using the SDK's stdio transport primitives.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the @tuvren/mcp-client package is scaffolded
When the internal MCPClient interface and stdio transport are implemented
Then the MCPClient exposes initialize, listTools, invokeTool, and close
And the stdio implementation handles process spawning, stdin/stdout framing, and graceful close
And unit tests cover handshake success, listTools, a successful invokeTool round-trip, and graceful close
And the stdio implementation does not expose zod in @tuvren/mcp-client's public API
```

**KRT-AS004 HTTP/SSE-Named Streamable HTTP Transport Implementation**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AS003`
- **Capability / Contract Mapping:** PRD `CAP-P0-041`; TechSpec §4.15, ADR-039
- **Description:** Implement Tuvren's public `transport: "http-sse"` lane using the SDK's non-deprecated Streamable HTTP client transport. The historical public transport name remains for TechSpec compatibility, but the deprecated upstream SSE transport must not be used. The HTTP/SSE-named transport must conform to the same internal `MCPClient` interface as stdio so transport choice does not fragment behavior (per Architecture v0.7.0 §6 MCP transport fragmentation mitigation).
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the stdio transport is implemented
When the HTTP/SSE-named transport is implemented
Then the implementation uses the SDK's non-deprecated Streamable HTTP transport and conforms to the same internal MCPClient interface as stdio
And the transport handles connection establishment, request/response correlation, and graceful close
And authentication (bearer + arbitrary header) is honored
And unit tests cover handshake success, listTools, a successful invokeTool round-trip, and graceful close against a mock Streamable HTTP server
```

**KRT-AS005 `createMcpToolSource` + `McpToolSource` + Translation Rules**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AS004`, `KRT-AQ003`
- **Capability / Contract Mapping:** PRD `CAP-P0-041`; TechSpec §4.15, ADR-039
- **Description:** Implement the public `createMcpToolSource(options)` helper and `McpToolSource` interface. Translate MCP tool advertisements into `TuvrenToolDefinition[]` per ADR-039's seven translation rules: name prefix, description passthrough, inputSchema wrapping via `jsonSchema`, optional outputSchema validation, annotations preserved under `metadata.mcp`, transport errors normalized to typed `ToolResultPart` with `isError: true`, and provider-level errors raised as `TuvrenProviderError`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given both transports and the MCPClient interface exist
When createMcpToolSource is implemented
Then it returns a Promise<McpToolSource> after the handshake completes
And the returned tools satisfy TuvrenToolDefinition with normalized CustomSchema input schemas
And MCP transport errors during invokeTool produce ToolResultPart with isError: true carrying a TuvrenProviderError
And MCP advertised outputSchema is validated against the returned output
And source.close() releases transport resources cleanly
And source.refresh() re-lists tools from the server
```

**KRT-AS006 MCP Test Servers in `@tuvren/provider-testkit`**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AS003`
- **Capability / Contract Mapping:** PRD `CAP-P0-041`; TechSpec ADR-039
- **Description:** Add MCP test-server helpers to `@tuvren/provider-testkit` for use in the conformance plan and downstream host tests. Prefer official upstream test implementations where they can cover the behavior (`@modelcontextprotocol/server-everything` over stdio and Streamable HTTP), and keep a small deterministic in-repo mock only for Tuvren-specific auth, invalid-output, and failure-injection cases.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the MCP client implementations exist
When the MCP test-server helpers are added to provider-testkit
Then official everything-server helpers support stdio and Streamable HTTP transports
And the in-repo mock's tool advertisements and tool results are deterministic for the same inputs
And the in-repo mock's auth and transport-error simulation can be triggered through test configuration
And both helper families are usable from unit tests in @tuvren/mcp-client and from the providers-mcp-client conformance plan
```

**KRT-AS007 MCP Authority Packet + Portability Gate Update**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** `KRT-AS005`
- **Capability / Contract Mapping:** PRD `CAP-P0-041`, `CAP-P0-037`; TechSpec ADR-026, ADR-039
- **Description:** Create the authority packet at `boundaries/providers/contracts/mcp/spec/authority-packet.json` declaring the MCP tool-source translation contract. The wire protocol itself is owned by `@modelcontextprotocol/sdk`; Tuvren's packet describes the translation rules and the conformance plan that verifies them. Also update the Epic AL portability inventory consumed by `tools/scripts/portability-gate.ts` so the MCP packet becomes the 9th expected packet.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given createMcpToolSource is implemented and the portability inventory expects 8 packets
When the MCP authority packet is created
Then the packet declares the translation contract as its authoritative source
And the packet references the upcoming providers-mcp-client conformance plan
And the packet declares forbidden authority sources (implementation language source, prose docs)
And the packet passes authority-packet freshness verification
And the portability inventory is updated to expect 9 packets
And `bun run portability:check` passes with the new count
```

**KRT-AS008 `providers-mcp-client` Conformance Plan with Both-Transport Parity**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AS006`, `KRT-AS007`
- **Capability / Contract Mapping:** PRD `CAP-P0-041`, `CAP-P1-036`; TechSpec ADR-039, ADR-030
- **Description:** Add a `providers-mcp-client.json` conformance plan exercising the seven translation rules and transport-error normalization. Run the translation parity scenario against both stdio and Streamable HTTP using the official everything server, and use the deterministic in-repo mock for auth, invalid-output, and transport-error injection (per Architecture v0.7.0 §6 mitigation).
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the MCP test-server helpers and the authority packet exist
When the providers-mcp-client.json conformance plan is added
Then the plan covers every translation rule from ADR-039
And the parity scenario runs against both stdio and Streamable HTTP transports with `pass` evidence
And transport-error normalization is verified by injecting failures through the mock
And `bun run conformance` includes the new plan automatically
```

**KRT-AS009 Re-export `createMcpToolSource` from `@tuvren/runtime`**
- **Type:** Chore
- **Effort:** 1
- **Dependencies:** `KRT-AS005`, `KRT-AR005`
- **Capability / Contract Mapping:** PRD `CAP-P0-041`, `CAP-P0-049`; TechSpec ADR-039, ADR-040
- **Description:** Re-export `createMcpToolSource` and `McpToolSource` from `@tuvren/runtime`'s curated re-export surface so hosts that compose through `createTuvren` can pass MCP sources without separately importing from `@tuvren/mcp-client`. Depends on `KRT-AR005` because the re-export target (`@tuvren/runtime`) must have its curated surface established before MCP helpers are added to it.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given createMcpToolSource exists in @tuvren/mcp-client
When @tuvren/runtime re-exports it
Then a host importing only @tuvren/runtime can call createMcpToolSource
And a host can pass the resulting source to createTuvren via the tools array
And typecheck passes for hosts using both the curated re-export and direct @tuvren/mcp-client imports
```

### Epic AT — Reference Host Consolidation + Headless + Transcript (KRT)

**Status:** Done — all 9 tickets implemented and validated through focused REPL tests, transcript replay conformance, proving-host interactive/headless target lanes, and Rust interop smoke with headless MCP coverage.

**KRT-AT001 Delete `@tuvren/playground-host` and Clean Up Nx Targets**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** `KRT-AO007`, `KRT-AP011`
- **Capability / Contract Mapping:** PRD `CAP-P1-050`, §4 (proving-host retirement); TechSpec ADR-041
- **Description:** Delete `boundaries/hosts/implementations/typescript/playground/` entirely. Remove `@tuvren/playground-host` from `bun.lock`, workspace `package.json` scripts, Nx project graph, `tools/scripts/`, and any other references. Relocate any scenario-test coverage unique to the playground into `@tuvren/repl-host` (most should already be duplicated).
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the durable-read surface lets the REPL replace all playground-only reads
When @tuvren/playground-host is deleted
Then no workspace member references @tuvren/playground-host
And no Nx target invokes a playground:* command
And any scenario coverage that was unique to the playground host is preserved in @tuvren/repl-host
And the workspace continues to build and test
```

**KRT-AT002 Rename Internal `playground-*.ts` Files to `repl-*.ts` in `@tuvren/repl-host`**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** `KRT-AT001`
- **Capability / Contract Mapping:** PRD `CAP-P1-050`; TechSpec ADR-041
- **Description:** Rename internal files in `@tuvren/repl-host` per ADR-041: `playground-config.ts` → `repl-config.ts`, `playground-host.ts` → `repl-host.ts`, `playground-matrix.ts` → `repl-scenario-matrix.ts`, `playground-provider.ts` → `repl-provider.ts`, `playground-scenarios-support.ts` → `repl-scenarios-support.ts`, `playground-scenarios.ts` → `repl-scenarios.ts`, `playground-tools.ts` → `repl-builtin-tools.ts`, `playground-types.ts` → `repl-types.ts`. (The `playground-kernel.ts` was already deleted in KRT-AO007.)
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the playground host package is deleted
When the internal files in @tuvren/repl-host are renamed
Then no file in @tuvren/repl-host begins with "playground-"
And every internal import has been updated to the new file names
And the existing public barrel in @tuvren/repl-host's index.ts continues to export the same identifiers
And the proving-host scenario suite still passes
```

**KRT-AT003 Rename Internal Type Names (`PlaygroundConfig` → `ReplConfig`, etc.)**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** `KRT-AT002`
- **Capability / Contract Mapping:** PRD `CAP-P1-050`; TechSpec ADR-041
- **Description:** Rename all internal type names that still carry the `Playground` prefix to use `Repl` (e.g. `PlaygroundConfig` → `ReplConfig`, `PlaygroundHost` → `ReplHost`, `PlaygroundScenarioName` → `ReplScenarioName`). The existing public alias barrel in `src/index.ts` becomes the actual definitions; remove the alias indirection.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the internal files are renamed
When the internal type names are renamed
Then no source file in @tuvren/repl-host declares a type or interface with a Playground prefix
And the public barrel exports the same external symbol names (Repl*)
And typecheck passes
And the proving-host scenario suite still passes
```

**KRT-AT004 `repl-headless-mode.ts` Implementation**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AT003`, `KRT-AR003`
- **Capability / Contract Mapping:** PRD `CAP-P1-050`; TechSpec §4.17, ADR-041
- **Description:** Implement the headless stdin dispatch loop in a new `repl-headless-mode.ts`. Read stdin line-by-line, dispatch each non-empty line through `runReplInput(shell, line)` (same path as interactive mode), write one JSON record per input/output pair to stdout per §3.9's `TranscriptOutputRecord` shape. Exit on EOF or `.exit`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the REPL host's command-dispatch path exists
When the headless mode is implemented
Then a host process can run the REPL with --headless and pipe stdin to drive commands
And each input line produces exactly one TranscriptOutputRecord JSON object on stdout
And the headless mode exits cleanly on EOF
And the headless mode exits cleanly on .exit
And the same shell-command-handler is used as interactive mode
```

**KRT-AT005 `repl-transcript.ts` JSONL Writer/Reader**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AT003`
- **Capability / Contract Mapping:** PRD `CAP-P1-051`; TechSpec §3.9, §4.17, ADR-041
- **Description:** Implement the JSONL transcript writer and reader in a new `repl-transcript.ts`. Writer: append-only, one JSON object per line, deterministic field ordering, header + entries per §3.9. Reader: validates the header, yields entries lazily for replay consumption.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the transcript file format from §3.9 is specified
When repl-transcript.ts is implemented
Then the writer produces JSONL output with a header line followed by entry lines
And every record uses deterministic field ordering for cross-environment textual comparison
And the reader validates the header and yields entries lazily
And round-trip writes-then-reads preserve the structured records bit-for-bit
And unit tests cover every record kind from §3.9
```

**KRT-AT006 Replay Subsystem with Deterministic vs Non-Deterministic Handling**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AT005`, `KRT-AR002`
- **Capability / Contract Mapping:** PRD `CAP-P1-051`; TechSpec §4.17, ADR-041
- **Description:** Implement the transcript replay subsystem. Construct a fresh runtime via `createTuvren({ backend: header.config.backend })`. Replay each `TranscriptInputRecord` against the runtime. For deterministic providers (`aimock-*`, `fixture`), assert equality between recorded and live outputs and fail on mismatch. For real-provider transcripts (`ai-sdk-*`), capture both recorded and live outputs but do not fail on inequality; the report classifies records as deterministic-asserted or non-deterministic-recorded.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the JSONL writer/reader and createTuvren exist
When the replay subsystem is implemented
Then replay constructs a fresh runtime matching the transcript header's backend choice
And deterministic-mode replay asserts equality and exits non-zero on mismatch
And non-deterministic-mode replay records live outputs and does not fail on inequality
And the replay report distinguishes deterministic-asserted from non-deterministic-recorded records
And replay completes a recorded session and produces a structured pass/fail summary
```

**KRT-AT007 CLI Flag Parsing for `--headless`, `--record`, `--replay`**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** `KRT-AT004`, `KRT-AT006`
- **Capability / Contract Mapping:** PRD `CAP-P1-050`, `CAP-P1-051`; TechSpec §4.17, ADR-041
- **Description:** Update `cli.ts` to parse the `--headless`, `--record <path>`, and `--replay <path>` flags. Honor the `TUVREN_REPL_MODE=headless` env var. Wire each flag to the corresponding mode/writer/replay subsystem. Document the flags and env vars in the existing `.help` output.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given headless mode, transcript writer, and replay exist
When cli.ts is updated to parse the new flags
Then `--headless` activates headless stdin mode
And `--record <path>` activates transcript capture during the session
And `--replay <path>` runs the replay subsystem and exits with pass/fail
And TUVREN_REPL_MODE=headless is equivalent to --headless
And `.help` documents every flag and env var
```

**KRT-AT008 `proving-host-headless-transcript-replay` Conformance Check Set**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AT007`
- **Capability / Contract Mapping:** PRD `CAP-P1-050`, `CAP-P1-051`, `CAP-P1-036`; TechSpec ADR-041, ADR-030
- **Description:** Add a `proving-host-headless-transcript-replay` check set to `boundaries/framework/conformance/plans/runtime-api-callables-extended.json` exercising a deterministic record-and-replay cycle. The check set runs the REPL in headless mode with `--record`, replays the captured transcript with `--replay`, and asserts equality on the deterministic records.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the headless mode, transcript writer, and replay are wired through the CLI
When the proving-host-headless-transcript-replay check set is added
Then the check set drives a record-and-replay cycle against a deterministic provider configuration
And the replay produces a structured pass report for the deterministic records
And the check set passes against the memory backend with deterministic provider modes
And `bun run conformance` includes the new check set automatically
```

**KRT-AT009 Update `proving-host:scenario-*` Targets to Exercise Both Modes**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** `KRT-AT008`, `KRT-AS009`
- **Capability / Contract Mapping:** PRD `CAP-P1-050`; TechSpec §5.3, §5.4
- **Description:** Update the existing `proving-host:scenario-sqlite`, `proving-host:scenario-postgres`, and `proving-host:interop-smoke` Nx targets to exercise both interactive and headless modes against the same scenarios. Headless coverage uses the new CLI flag. Wire the headless lane into `tools/scripts/verify.ts` so the canonical verification path covers both modes. Extend the headless scenario set to include at least one MCP-tool scenario that exercises `createMcpToolSource` re-exported from `@tuvren/runtime` (depends on KRT-AS009 making the export available).
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the headless mode and transcript subsystem are conformance-covered
When the proving-host targets are updated
Then proving-host:scenario-sqlite, proving-host:scenario-postgres, and proving-host:interop-smoke each run both interactive and headless variants
And the canonical verification path through tools/scripts/verify.ts exercises both variants
And `bun run verify` exits zero
And the refreshed compatibility evidence reflects both-mode coverage for the proving-host scenarios
```

### Epic AU — Durability & Recovery Proof Under Failure (KRT)

**Status:** Not started — active. Independent of AV/AW; may start immediately. Realizes ADR-045 and the sharpened Reliability NFR.

**KRT-AU001 Spike: Characterize Current Checkpoint Atomicity and Crash Recovery**
- **Type:** Spike
- **Effort:** 3
- **Dependencies:** None
- **Capability / Contract Mapping:** PRD `CAP-P0-005`, `CAP-P0-006`, Reliability NFR; TechSpec ADR-045, §5.6.1
- **Description:** Time-boxed characterization of current checkpoint atomicity and crash-recovery behavior across `memory`, SQLite, and PostgreSQL. Manually interrupt commits (abort mid-transaction; kill between staged write and checkpoint ack) and inspect whether recovery resumes from the last committed TurnNode or leaves torn/partial lineage. Catalogue any non-atomic multi-statement commit path and any concurrency hazard on a shared branch head. Output: a short findings note naming the scenarios the conformance set (KRT-AU003) must cover and any defects KRT-AU004 must fix.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the existing kernel and the three official backends
When a checkpoint commit is interrupted mid-transaction on each backend
Then the spike documents whether recovery resumes from the last committed TurnNode or leaves torn or partial lineage
And the spike catalogues any non-atomic commit path or concurrency hazard found
And the findings name the scenarios the kernel-crash-recovery check set must cover
```

**KRT-AU002 Fault-Injection Backend Decorator in `@tuvren/kernel-testkit`**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AU001`
- **Capability / Contract Mapping:** PRD `CAP-P0-005`, `CAP-P0-006`; TechSpec ADR-045, §3.12, §4.20
- **Description:** Implement `createFaultInjectingBackend(inner, plan)` and the `FaultPlan` type in `@tuvren/kernel-testkit` per §3.12 / §4.20. Wrap `transact` for transaction selection and branch scoping, and for supported durable backends add and consume backend-specific test-only persistence hooks so the seam can interrupt at `before-commit`, `mid-commit`, and `after-commit-before-ack`; support a `concurrentWriter` racing a branch head after the matched commit is interrupted; honor `once` / `always` policy and the logical checkpoint `match` predicate. `mid-commit` must be available only when the inner backend exposes the required test hooks; it must not be faked by pretending `RuntimeBackend.transact` alone can observe partial durable writes. Injected commit faults surface as the same `TuvrenPersistenceError` type real persistence failures use. Add a dependency-direction check asserting no production package imports the seam.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the §3.12 FaultPlan shape and §4.20 seam contract
When createFaultInjectingBackend is implemented in @tuvren/kernel-testkit
Then a test can wrap any supported RuntimeBackend and inject a fault at before-commit or after-commit-before-ack
And mid-commit injection is available only when the inner backend exposes the required test-only commit hooks
And SQLite and PostgreSQL expose those test-only commit hooks through the testkit seam rather than through production APIs
And the seam can simulate a concurrent writer racing the same branch head
And injected commit faults surface as the same TuvrenPersistenceError type real persistence failures use
And a dependency check confirms no production package imports the seam
```

**KRT-AU003 `kernel-crash-recovery` Check Set + Authority Packet Bump**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AU002`
- **Capability / Contract Mapping:** PRD `CAP-P0-005`, `CAP-P0-006`; TechSpec ADR-045, §5.6.1
- **Description:** Add a `kernel-crash-recovery` check set to `boundaries/kernel/conformance/plans/kernel-restart-recovery.json` that drives the fault-injection seam per fault point and under a concurrent writer, opens a fresh kernel against the same durable state, and asserts the recovery invariant. Per-capability applicability: durable-restart subset for SQLite/PostgreSQL, in-process atomicity + concurrency subset for `memory`. Record the new check set in the kernel authority packet and bump its packet version.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given createFaultInjectingBackend exists
When the kernel-crash-recovery check set is added to kernel-restart-recovery.json
Then the check set injects each fault point and a concurrent-writer race per backend capability
And it asserts the recovered branch head is a committed TurnNode with no torn or partial lineage
And it asserts the runtime resumes only unfinished work or fails the run cleanly with TuvrenRecoveryError
And memory is not_applicable for the durable-restart subset but applicable for the in-process atomicity and concurrency subset
And the kernel authority packet records the new check set and bumps its version
```

**KRT-AU004 Make SQLite and PostgreSQL Pass the Durable Crash-Recovery Subset**
- **Type:** Feature
- **Effort:** 8
- **Dependencies:** `KRT-AU003`
- **Capability / Contract Mapping:** PRD `CAP-P0-005`, `CAP-P0-006`, Reliability NFR; TechSpec ADR-045
- **Description:** Run the strengthened plan against all three backends and fix any atomicity or concurrency defect exposed by KRT-AU001 / KRT-AU003 (e.g. wrap a non-atomic multi-statement commit in one transaction; add an optimistic head-version check for racing writers) so SQLite and PostgreSQL pass the durable crash-recovery subset and `memory` passes the in-process subset. The plan must not be relaxed to accommodate a defect.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the kernel-crash-recovery check set runs against all three backends
When any atomicity or concurrency defect it exposes is fixed in the affected backend
Then SQLite and PostgreSQL pass the durable crash-recovery subset
And memory passes the in-process atomicity and concurrency subset
And no torn or partial lineage is observable after any injected fault
And the plan is not relaxed to accommodate a defect
```

**KRT-AU005 Kernel-Spec Crash Recovery Invariant + `verify`**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** `KRT-AU004`
- **Capability / Contract Mapping:** TechSpec ADR-045, §5.6.1
- **Description:** Add a normative "Crash Recovery Invariant" note to `docs/KrakenKernelSpecification.md` (minor bump) stating the resume-or-fail-clean guarantee the plan verifies. Run `bun run verify` from a clean checkout and capture fresh compatibility evidence.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the strengthened crash-recovery conformance passes on every applicable backend
When the kernel specification's Crash Recovery Invariant note is added and bun run verify is run
Then docs/KrakenKernelSpecification.md states the resume-or-fail-clean guarantee the plan verifies
And bun run verify exits zero from a clean checkout
And fresh compatibility evidence reflects the kernel-crash-recovery results
```

### Epic AV — Operational Telemetry Surface (KRT)

**Status:** Not started — active. Realizes ADR-042. `KRT-AV002` consumes the telemetry secret-screening helpers from `KRT-AW001`.

**KRT-AV001 `@tuvren/core/telemetry` Subpath: Sink + Record Types**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** None
- **Capability / Contract Mapping:** PRD `CAP-P0-052`; TechSpec ADR-042, §3.10, §4.18
- **Description:** Add the `./telemetry` subpath to `@tuvren/core`: `TuvrenTelemetrySink`, `TelemetrySpan`, `TelemetryEvent`, `TelemetryLineage`, `TelemetrySpanKind`, `TelemetryEventKind`, and `NoopTelemetrySink` (§3.10, §4.18). Update the package `exports` map (10 entries), `tsup.config.ts` (10 entries), the merged core authority packet (one new binding section plus authoritative source entries, with a packet-version bump), the shared core machine-readable sources and generated artifacts for the new telemetry shapes, and `tools/scripts/portability-gate.ts` for the new subpath.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the §3.10 record shapes and §4.18 sink contract
When the @tuvren/core/telemetry subpath is added
Then TuvrenTelemetrySink, TelemetrySpan, TelemetryEvent, TelemetryLineage, and NoopTelemetrySink are exported from @tuvren/core/telemetry
And TelemetrySpanKind and TelemetryEventKind are exported from @tuvren/core/telemetry
And the package exports map and tsup config carry 10 entries
And the merged core authority packet declares the telemetry binding section and bumps its version
And the shared core machine-readable sources and generated artifacts define the telemetry record shapes and kind unions
And the portability gate recognizes the new subpath
And typecheck and build pass
```

**KRT-AV002 Framework Emission + Sink Wiring + `createTuvren` Telemetry Option**
- **Type:** Feature
- **Effort:** 8
- **Dependencies:** `KRT-AV001`, `KRT-AW001`
- **Capability / Contract Mapping:** PRD `CAP-P0-052`; TechSpec ADR-042, §4.18, §5.6.2; ADR-044 (telemetry secret-screening)
- **Description:** Wire emission in `@tuvren/runtime` at the §4.18 points that already have producers in the runtime (turn/run start-end, iteration boundaries, model request/response, tool call start/end + approval transitions, checkpoint commit, recovery resume-or-fail, errors), reusing the canonical event vocabulary. Isolate a throwing sink (catch, log one warning, drop). Add `telemetry?: TuvrenTelemetrySink` to `CreateTuvrenOptions` and `RuntimeCoreOptions`, defaulting to `NoopTelemetrySink`. Apply the telemetry secret-screening helpers from `KRT-AW001` before records reach the sink. The bounded-execution telemetry producer lands with `KRT-AW006` once the bounds guard exists.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the telemetry sink contract and the telemetry secret-screening helpers exist
When framework emission is wired in @tuvren/runtime
Then a configured sink receives lineage-keyed spans and events at turn, run, iteration, model, tool, checkpoint, recovery, and error points
And a throwing sink is isolated and never fails the turn
And createTuvren and RuntimeCoreOptions accept an optional telemetry sink defaulting to NoopTelemetrySink
And host-supplied attributes pass through the semconv allowlist before reaching the sink
And telemetry error summaries are sanitized before reaching the sink
And supplying both top-level telemetry and runtimeOptions.telemetry is rejected as invalid_createtuvren_options
And the telemetry surface reuses the same canonical event vocabulary as the event stream
```

**KRT-AV003 `@tuvren/telemetry-otel` Vendor-Neutral Export Package**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AV001`
- **Capability / Contract Mapping:** PRD `CAP-P1-053`; TechSpec ADR-042, §4.18, §5.6.2
- **Description:** Create `@tuvren/telemetry-otel` under `boundaries/framework/implementations/typescript/telemetry-otel/`, peer-depending on `@tuvren/core`. Implement `createOtelTelemetrySink(options): TuvrenTelemetrySink` mapping `TelemetrySpan` / `TelemetryEvent` onto OpenTelemetry spans/events using the authored semconv attributes from `telemetry/semconv/tuvren-runtime.yaml`. Pin exact `@opentelemetry/*` versions in this epic's manifest change. Record the OTel projection as a standing implementation-specific portability exception in both the live portability inventory JSON and its paired Markdown inventory, preserving the existing standing exceptions already recorded there.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the telemetry sink contract and the authored semconv vocabulary
When @tuvren/telemetry-otel is implemented
Then createOtelTelemetrySink returns a TuvrenTelemetrySink that maps records onto OpenTelemetry spans and events using the semconv attributes
And the package peer-depends on @tuvren/core and pins exact @opentelemetry/* versions
And the OTel projection is recorded in the live portability inventory JSON and Markdown without dropping any existing standing exceptions
And a unit test verifies the record-to-OTel mapping
```

**KRT-AV004 `framework-operational-telemetry.json` Conformance Plan**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AV002`
- **Capability / Contract Mapping:** PRD `CAP-P0-052`; TechSpec ADR-042, ADR-030, §5.6.2
- **Description:** Add `framework-operational-telemetry.json` (check set `runtime-api-operational-telemetry`) under `boundaries/framework/conformance/plans/`. Drive a deterministic aimock turn and assert the expected lineage-keyed spans/events for turn/iteration/model/tool/checkpoint, approval transitions, and error paths through an in-memory capture sink added to `@tuvren/framework-testkit`, then drive a targeted restart/recovery fixture that asserts the recovery records. Record the new plan in `boundaries/shared/contracts/core/spec/authority-packet.json` so the framework runner discovers it. The OTel mapping stays out of the portable plan (covered by KRT-AV003's unit test).
- **Acceptance Criteria (Gherkin):**
```gherkin
Given framework emission is wired and an in-memory capture sink exists in the framework testkit
When the framework-operational-telemetry.json plan is added
Then a deterministic aimock turn emits the expected lineage-keyed spans and events for turn, run, iteration, model, tool, checkpoint, approval transitions, and error paths
And a targeted restart or recovery fixture emits the expected recovery records
And the check set asserts those records through the in-memory capture sink, not the OTel projection
And the merged core authority packet records framework-operational-telemetry.json, bumps its version, and makes bun run conformance discover it
And bun run conformance includes the new check set automatically
```

**KRT-AV005 Re-export Curated Telemetry Surface + `verify`**
- **Type:** Chore
- **Effort:** 1
- **Dependencies:** `KRT-AV004`, `KRT-AV003`
- **Capability / Contract Mapping:** TechSpec ADR-042, §5.6.2
- **Description:** Re-export `NoopTelemetrySink` and the telemetry record types from `@tuvren/runtime`'s curated re-exports. Run `bun run verify` from a clean checkout; capture fresh compatibility evidence reflecting the operational-telemetry lane.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the telemetry surface, emission, export package, and conformance plan exist
When @tuvren/runtime re-exports the curated telemetry surface and bun run verify runs
Then NoopTelemetrySink and the telemetry record types are reachable from @tuvren/runtime
And bun run verify exits zero from a clean checkout
And fresh compatibility evidence reflects the operational-telemetry lane
```

### Epic AW — Trust-Boundary Security Hardening (KRT)

**Status:** Not started — active. Realizes ADR-043 (execution bounds) and ADR-044 (secret isolation), plus verification of the approval/input trust boundaries the PRD elevated. `KRT-AW001` is an early cross-epic prerequisite consumed by `KRT-AV002`.

**KRT-AW001 Telemetry Secret-Screening Helpers**
- **Type:** Security
- **Effort:** 3
- **Dependencies:** None
- **Capability / Contract Mapping:** PRD `CAP-P0-055`; TechSpec ADR-044, §5.6.3
- **Description:** Implement the telemetry secret-screening helpers consumed by `KRT-AV002`'s emission path: an attribute allowlist keyed only to `telemetry/semconv/tuvren-runtime.yaml` (reject or drop credential-shaped keys such as `authorization`, `token`, `password`, `api-key`, `secret`, and drop or sanitize secret-like values on otherwise allowed keys) plus a telemetry-error-summary sanitizer that strips raw provider, MCP, backend, and transport error text down to a runtime-safe summary with no secret-bearing values. If operational telemetry needs a new canonical attribute (for example bounded-execution `bound`, `limit`, or `observed`), update the semconv source in the same change before the allowlist admits it.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the authored semconv attribute vocabulary in telemetry/semconv/tuvren-runtime.yaml
When the telemetry secret-screening helpers are implemented
Then only keys declared in telemetry/semconv/tuvren-runtime.yaml pass through to a telemetry record
And credential-shaped keys such as authorization, token, password, api-key, and secret are rejected or dropped
And secret-like values on otherwise allowed telemetry keys are dropped or sanitized before emission
And any newly required canonical runtime telemetry attribute is added to the semconv source in the same change before the helper allows it
And telemetry error summaries exclude raw headers, tokens, connection strings, credential-bearing URLs, and other secret-bearing text
And the helpers are exported for consumption by the framework emission path
And unit tests cover allowed and denied keys and sanitized error summaries
```

**KRT-AW002 Transcript Backend-Options Redactor**
- **Type:** Security
- **Effort:** 5
- **Dependencies:** None
- **Capability / Contract Mapping:** PRD `CAP-P0-055`; TechSpec ADR-044, §3.9, §5.6.3
- **Description:** Add a backend-options redactor and a non-secret backend identity descriptor to `@tuvren/repl-host`'s `repl-transcript.ts`. Mask PostgreSQL `connectionString` / `password` and any credential-shaped backend option in the transcript header `config.backend.options`. Ensure replay reconstructs the backend from non-secret options plus environment-supplied credentials, never from transcript-embedded secrets. This is a §3.9 transcript-format constraint addition (format `v: 1` compatible).
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the §3.9 transcript header carries config.backend.options
When the backend-options redactor is added to repl-transcript.ts
Then a recorded transcript header masks PostgreSQL connectionString and password and any credential-shaped backend option
And the header retains a non-secret backend identity descriptor sufficient for replay topology
And replay reconstructs the backend from non-secret options plus environment-supplied credentials
And a transcript recorded before redaction remains replayable
```

**KRT-AW003 Edge-Confinement Documentation and Fixtures**
- **Type:** Security
- **Effort:** 2
- **Dependencies:** None
- **Capability / Contract Mapping:** PRD `CAP-P0-055`; TechSpec ADR-044, §5.6.3
- **Description:** Document the edge-confinement rule in `@tuvren/mcp-client` and `@tuvren/provider-bridge-ai-sdk` READMEs and add reusable fixture inputs that carry representative provider credentials and MCP auth values for the later secret-isolation assertions in `KRT-AW004`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the Secret Isolation Model from ADR-044
When edge-confinement is documented and fixtured in @tuvren/mcp-client and @tuvren/provider-bridge-ai-sdk
Then each package README states that credentials are confined to the integration edge
And the fixtures stage representative provider keys and MCP auth values for later secret-isolation checks
And the cross-surface absence assertions remain the responsibility of KRT-AW004
```

**KRT-AW004 `secret-isolation` Check Set Across MCP, Telemetry, and Runtime Plans**
- **Type:** Security
- **Effort:** 5
- **Dependencies:** `KRT-AW001`, `KRT-AW002`, `KRT-AW003`, `KRT-AV004`
- **Capability / Contract Mapping:** PRD `CAP-P0-055`; TechSpec ADR-044, §5.6.3
- **Description:** Add a `secret-isolation` check set to `providers-mcp-client.json`, `framework-operational-telemetry.json`, and `runtime-api-callables-extended.json`. The fixture configures a provider key plus MCP bearer-auth and header-auth secrets, runs a turn that persists state, emits canonical stream events and telemetry, and records a transcript, then uses a shared runner-owned secret-absence helper to recursively scan those surfaces and assert none of the configured secret values or their common encoded variants appear in persisted kernel records, captured canonical stream events, captured telemetry attributes or error summaries, or the recorded transcript.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the telemetry secret-screening helpers, transcript redactor, and edge-confinement fixtures exist
When the secret-isolation check set is added to the MCP, telemetry, and runtime-api plans
Then a fixture configures a provider key plus MCP bearer-auth and header-auth secrets and runs a turn
And the check set asserts none of the configured secret values appear in any persisted kernel record
And the check set asserts none of the configured secret values appear in captured canonical stream events
And the check set asserts none of the configured secret values appear in captured telemetry attributes or error summaries
And the check set asserts none of the configured secret values appear in the recorded transcript
And the absence checks are evaluated by a shared runner-owned helper over raw observations rather than adapter-supplied verdict booleans
And the helper covers common derived leak forms such as bearer-prefixed, header-normalized, URL-encoded, base64-encoded, and partial-token variants
And bun run conformance includes the new check set automatically
```

**KRT-AW005 `ExecutionBounds` Types + `execution_bound_exceeded` Code**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** None
- **Capability / Contract Mapping:** PRD `CAP-P0-054`; TechSpec ADR-043, §3.11, §4.19
- **Description:** Add `ExecutionBounds` and `ExecutionBoundExceededDetails` to the shared core execution contracts, and add the cooperative provider-cancellation surface needed by `maxWallClockMs` (including `TuvrenPrompt.signal`) to the provider contract authority owned by `boundaries/providers/contracts/provider-api/` as well as the host-facing `@tuvren/core/provider` export surface. Document the stable `execution_bound_exceeded` `TuvrenRuntimeError` code in `@tuvren/core/errors`. Update the shared core execution machine-readable sources, generated artifacts, and merged core authority packet, plus the provider-api machine-readable sources, generated artifacts, and authority packet, for the new cancellation-aware contract.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the §3.11 bounds shapes and §4.19 contract
When ExecutionBounds and ExecutionBoundExceededDetails are added to @tuvren/core/execution
Then ExecutionBounds and ExecutionBoundExceededDetails are exported from @tuvren/core/execution
And the shared provider contract includes the cooperative TuvrenPrompt.signal cancellation field
And the provider-api machine-readable sources, generated artifacts, and authority packet are updated for that cancellation field and bumped as required
And the execution_bound_exceeded code is documented in @tuvren/core/errors
And the shared core execution machine-readable sources, generated artifacts, and merged core authority packet are updated for the new execution contract and bumped as required
And typecheck passes
```

**KRT-AW006 Framework-Enforced Bounds Guard in `@tuvren/runtime`**
- **Type:** Feature
- **Effort:** 8
- **Dependencies:** `KRT-AW005`, `KRT-AV002`
- **Capability / Contract Mapping:** PRD `CAP-P0-054`; TechSpec ADR-043, §4.19, §5.6.4
- **Description:** Implement the framework bounds guard in `@tuvren/runtime`'s turn/run orchestration shell. Enforce `maxIterations` and `maxToolCalls` at iteration and tool-batch boundaries above the driver's `LoopPolicy`, clamp `AgentConfig.maxIterations` by `bounds.maxIterations`, enforce `maxWallClockMs` as an end-to-end deadline that propagates abort signals into in-flight model/tool work, update the owned provider bridge and owned tool paths to forward and honor those signals, and enforce `maxConcurrentToolCalls` by throttling tool concurrency to the configured cap. On breach of a hard-stop bound, stop the loop, checkpoint a safe terminal outcome, finalize the turn as a `failed` `ExecutionResult` with `TuvrenRuntimeError` code `execution_bound_exceeded` and `details: ExecutionBoundExceededDetails`, emit a fatal canonical `error` event carrying the same code/details, let the canonical `turn.end` event mark the failed terminal state, and emit a bounded-execution telemetry event when a sink is configured. Add `bounds?: ExecutionBounds` to `CreateTuvrenOptions` and `RuntimeCoreOptions` with the §3.11 safe defaults, and reject invalid non-integer, non-finite, or non-positive bound values at construction time. A driver cannot raise or disable a bound.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given ExecutionBounds is defined and the runtime owns the turn loop
When the framework bounds guard is implemented
Then exceeding maxIterations, maxToolCalls, or maxWallClockMs stops the loop above driver discretion
And the turn finalizes as a failed ExecutionResult with code execution_bound_exceeded and correct details
And the canonical stream emits a fatal error event with code execution_bound_exceeded before the failed terminal turn.end event
And the canonical turn.end event marks the failed terminal state while the bound metadata remains on the failed ExecutionResult, canonical error-event details, and bounded-execution telemetry event
And a bounded-execution telemetry event is emitted when a sink is configured
And the runtime stops awaiting model or tool work at maxWallClockMs by propagating an abort signal through TuvrenPrompt.signal and ToolExecutionContext.signal into the in-flight work
And any late completion after that abort is ignored and cannot reopen or mutate the bounded turn
And the owned provider bridge and owned tool paths forward and honor the propagated signal for full resource containment
And AgentConfig.maxIterations is clamped by bounds.maxIterations rather than bypassing it
And parallel tool execution never exceeds maxConcurrentToolCalls because the framework throttles to the configured cap
And when AgentConfig.maxParallelToolCalls or defaultMaxParallelToolCalls is present, the effective parallel-tool limit is clamped to maxConcurrentToolCalls
And unset bound fields take the documented safe defaults
And invalid non-integer, non-finite, or non-positive bound values are rejected at construction time
And supplying both top-level bounds and runtimeOptions.bounds is rejected as invalid_createtuvren_options
And a driver that always requests continue cannot exceed the framework bound
```

**KRT-AW007 `runtime-api-execution-bounds` Check Set**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** `KRT-AW006`, `KRT-AV004`
- **Capability / Contract Mapping:** PRD `CAP-P0-054`; TechSpec ADR-043, §5.6.4
- **Description:** Add the `runtime-api-execution-bounds` check set to `runtime-api-callables-extended.json` using a runaway aimock driver fixture that always requests continue. Assert each hard-stop bound's breach yields a `failed` result with code `execution_bound_exceeded` and the correct `details`, that the canonical stream emits the matching fatal `error` event before the failed `turn.end`, that a configured capture sink observes the `execution.bounded` telemetry event, that `AgentConfig.maxIterations` is clamped by `bounds.maxIterations`, that `maxConcurrentToolCalls` is enforced by throttling parallel tool execution to the configured cap, that invalid non-integer, non-finite, or non-positive bound configuration is rejected, and that a within-bounds control turn completes normally.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the framework bounds guard is implemented
When the runtime-api-execution-bounds check set is added
Then a runaway aimock driver breaching maxIterations, maxToolCalls, or maxWallClockMs yields a failed result with code execution_bound_exceeded and correct details
And the canonical stream emits the matching fatal error event before the failed terminal turn.end event
And a configured capture sink observes the execution.bounded telemetry event for each hard-stop breach
And AgentConfig.maxIterations is clamped by bounds.maxIterations rather than bypassing it
And maxConcurrentToolCalls is enforced by throttling parallel tool execution to the configured cap
And AgentConfig.maxParallelToolCalls and defaultMaxParallelToolCalls are clamped by maxConcurrentToolCalls rather than bypassing it
And invalid non-integer, non-finite, or non-positive bound configuration is rejected
And owned provider/tool integrations are exercised so signal delivery and late-completion ignoring are verified rather than assumed
And a within-bounds control turn completes normally
And bun run conformance includes the new check set automatically
```

**KRT-AW008 Framework-Spec Execution Bounds Section + `verify`**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** `KRT-AW007`
- **Capability / Contract Mapping:** TechSpec ADR-043, §5.6.4
- **Description:** Add a normative "Execution Bounds" section to `docs/KrakenFrameworkSpecification.md` (minor bump) describing the framework-owned guard so future drivers inherit it. Run `bun run verify` from a clean checkout; capture fresh evidence.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the execution-bounds guard and conformance pass
When the framework specification's Execution Bounds section is added and bun run verify runs
Then docs/KrakenFrameworkSpecification.md describes the framework-owned bounds guard
And bun run verify exits zero from a clean checkout
And fresh compatibility evidence reflects the execution-bounds lane
```

**KRT-AW009 Approval and Untrusted-Input Trust-Boundary Verification**
- **Type:** Security
- **Effort:** 3
- **Dependencies:** None
- **Capability / Contract Mapping:** PRD `CAP-P0-016`, `CAP-P0-017`, `CAP-P1-015`, Security NFR; TechSpec ADR-039, ADR-044
- **Description:** Add a `trust-boundary` security check set to `boundaries/framework/conformance/plans/runtime-api-callables-extended.json` and `boundaries/providers/conformance/plans/providers-mcp-client.json`, asserting the existing trust-boundary guarantees the PRD elevated: approval-gated tool work cannot proceed without an explicit decision (non-bypassable), and untrusted MCP/tool inputs are validated against their declared schema before execution with canonical error results rather than implicit trust. Pin the result semantics the runner will assert: local tool-contract validation failures surface as `tool.result` with `isError: true` carrying `TuvrenValidationError` code `tool_input_validation_failed`, while MCP-advertised input validation failures surface as `tool.result` with `isError: true` carrying `TuvrenProviderError` code `mcp_tool_input_invalid`. This is an independent required close-condition lane for the block even though it does not unblock other implementation tickets; any gap the check set exposes is fixed under this ticket.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given approval gating and tool-input validation already exist
When the trust-boundary security check set is added to runtime-api-callables-extended.json and providers-mcp-client.json
Then a tool call requiring approval cannot execute without an explicit approval decision
And a local tool input that violates its declared schema is rejected before execution and surfaced as tool.result with isError true carrying TuvrenValidationError code tool_input_validation_failed
And an MCP-advertised tool input that violates its declared schema is rejected before transport invocation and surfaced as tool.result with isError true carrying TuvrenProviderError code mcp_tool_input_invalid
And any gap the check set exposes in the existing behavior is fixed under this ticket
And bun run conformance includes the new check set automatically
```

## 5. Issue-Level Definition of Done

The execution chain is not closed until every applicable statement below is true in the repository and in the live constitution.

- Historical constitutional support material no longer behaves like live authority once archived.
- The serious REPL host proves the SDK through the same host-facing abstractions downstream hosts are expected to use.
- End-to-end scenario automation exists for the proving host and covers durable reload, approvals, steering, orchestration, extensions, structured output, and persistence flows.
- `memory`, SQLite, and PostgreSQL modes are explicitly covered where their differing product obligations matter.
- SQLite and PostgreSQL satisfy the same strict kernel-visible semantics expected of first-class backends.
- Canonical stream semantics and SSE translation are portable runner-owned surfaces; AG-UI remains an explicitly implementation-specific projection.
- Provider-agnostic semantics remain Tuvren-owned and do not depend on AI SDK bridge shapes to define cross-language truth.
- TypeScript AI SDK bridge-backed provider scenarios remain a required TypeScript product-proof lane even though the bridge implementation itself is not a cross-language portability target.
- The canonical verification path enforces both the proving-host `product proof gate` and the promoted portability evidence once those lanes land.
- The `product proof gate`, `platform gate`, and `portability gate` are evidenced from fresh checks before Rust framework/product work can resume.
- The kernel syscall surface narrative cites the corrected operation count (30 operations across 10 groups, per ADR-034); no remaining text claims "28 operations" except as historical context.
- The kernel `thread.list` syscall is implemented on every official backend that advertises the `thread.enumeration` capability bit; backends that do not advertise it surface `TuvrenPersistenceError` code `kernel_capability_unsupported` on attempted invocations rather than degrading silently.
- `ExecutionHandle.awaitResult` is implemented on the base handle returning `ExecutionResult`; `OrchestrationHandle.awaitResult` overrides to return `OrchestrationResult` with `childResults` aggregation; the two previously-orchestration-only conformance checks have been migrated to the new base-handle check set.
- The `TuvrenRuntime` durable-read surface (`listThreads`, `listBranches`, `getTurnState`, `getTurnHistory`, `readBranchMessages`) is implemented on top of kernel structural primitives plus the new `thread.list` and is the only path the proving host uses to read durable state.
- `createPlaygroundKernelInspector` is deleted from the workspace; no host code (proving or otherwise) reads kernel state directly.
- The shared primitives are consolidated into `@tuvren/core` with subpath exports (`/messages`, `/tools`, `/events`, `/errors`, `/execution`, `/driver`, `/provider`, `/extensions`, `/telemetry`); the five retired packages (`@tuvren/core-types`, `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, `@tuvren/driver-api`) exist only as deprecated re-export shims slated for removal in the next minor.
- `@tuvren/runtime-core` is folded into `@tuvren/runtime`; the slim convenience package exposes `createTuvren` plus curated re-exports as one host-developer entrypoint.
- Every leaf integration package peer-depends on `@tuvren/core` so consumers cannot end up with version-skewed primitive instances.
- The Schema Authoring Helper (`defineTool`, `FlexibleSchema`, `asSchema`, `jsonSchema`, `zodSchema`, `standardSchema`) is implemented in `@tuvren/core/tools`, re-exported through `@tuvren/runtime`, and conformance-covered by the `runtime-api-schema-authoring` check set with at least one fixture per precedence branch including the documented ambiguous cases.
- `@tuvren/mcp-client` is implemented as a first-class tool source over both stdio and Streamable HTTP-backed public `http-sse` transports with behavioral parity enforced by `providers-mcp-client.json`; official and mock MCP helpers in `@tuvren/provider-testkit` exercise those paths.
- `createTuvren({...})` assembles a working `TuvrenInstance` from one factory call against any of the three official backends; `[Symbol.asyncDispose]` cleanup is verified for SQLite handles, PostgreSQL pools, and MCP transport sessions.
- `@tuvren/playground-host` is deleted from the workspace; the REPL is the sole proving host with renamed internal modules (no `playground-*.ts` files remain) and supports both interactive readline and headless stdin operating modes from one package and one command set.
- Transcript capture (`--record`) and replay (`--replay`) are implemented per the JSONL format in TechSpec §3.9; deterministic-mode replay asserts equality and fails non-zero on mismatch; non-deterministic-mode replay captures and reports without asserting.
- The canonical verification path through `tools/scripts/verify.ts` exercises both interactive and headless proving-host variants; `bun run verify` exits zero from a clean checkout after the chain closes.
- The durability and recovery guarantees are verified under fault injection: a testkit-only fault-injection seam (`createFaultInjectingBackend`) drives the `kernel-crash-recovery` check set; SQLite and PostgreSQL pass the durable crash-recovery subset; `memory` passes the in-process atomicity and concurrency subset; no torn or partial lineage is observable after any injected fault; and the seam is never reachable from any production path.
- A first-class operational telemetry surface (`@tuvren/core/telemetry` `TuvrenTelemetrySink`) emits lineage-keyed spans and events at turn/run/iteration/model/tool/checkpoint/approval-transition/recovery/bounded-execution/error points, defaults to `NoopTelemetrySink`, isolates a throwing sink, and is conformance-covered by `framework-operational-telemetry.json` through deterministic steady-state plus targeted recovery fixtures; `@tuvren/telemetry-otel` provides the vendor-neutral OpenTelemetry projection as a standing implementation-specific exception while the semconv vocabulary remains portable authority.
- The framework enforces execution bounds (`maxIterations`, `maxToolCalls`, `maxWallClockMs`) above driver discretion by stopping runtime control flow at the bound and propagating abort signals through `TuvrenPrompt.signal` and `ToolExecutionContext.signal`; breaching a hard-stop bound yields a `failed` `ExecutionResult` with code `execution_bound_exceeded`, a fatal canonical `error` event carrying the same code/details, a failed terminal `turn.end` event, and a bounded-execution telemetry event, with the bound metadata carried by the `ExecutionResult`, canonical `error`-event details, and telemetry rather than the canonical `turn.end` shape, verified by `runtime-api-execution-bounds`. Any late completion after abort is ignored and cannot mutate the bounded turn; `AgentConfig.maxIterations` is clamped by `bounds.maxIterations`; `maxConcurrentToolCalls` is enforced as a throttle on parallel tool execution; and invalid non-finite or non-positive bound configuration is rejected.
- Secret isolation is enforced and verified: credentials are confined to the Provider Gateway and MCP Client edges; the durable, canonical-stream, telemetry, and transcript surfaces are credential-free zones; transcript headers redact credential-shaped backend options; the telemetry secret-screening helpers exclude credential-shaped attributes and sanitize telemetry error summaries; and the `secret-isolation` check set uses a shared runner-owned secret-absence helper to assert that a configured provider key plus MCP bearer-auth and header-auth secrets, along with their common encoded variants, appear in no persisted record, no captured canonical stream event, no captured telemetry attribute or error summary, and no recorded transcript.
- The trust-boundary guarantees are verified: approval-gated tool work is non-bypassable, and untrusted MCP/tool inputs are validated before execution with failures surfaced as agent-visible results.
- `docs/KrakenKernelSpecification.md` states the Crash Recovery Invariant and `docs/KrakenFrameworkSpecification.md` states the Execution Bounds guard that the conformance plans verify; `bun run verify` exits zero from a clean checkout after the production-trust block closes.
