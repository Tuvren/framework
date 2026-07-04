# Codebase Constitutional Audit Report: post-epic-87-baseline

- **Timestamp:** 2026-07-04-170703 (resolved via `date`)
- **Target Commit SHA:** `3249d016029598bd7250626ee328c6b06738531f`
- **Audit Depth:** deep (8 parallel read-only auditors: kernel correctness, runtime/core correctness, security, performance, test/conformance coverage, tech debt/architecture/dependencies, DX/tooling/CI, product direction; all top findings re-verified by the lead auditor before inclusion)

## Executive Summary

This is an unusually healthy codebase by the measures audits normally lean on. Hand-written TypeScript source contains **zero** `any`, non-null assertions, `@ts-ignore`, empty catch blocks, skipped tests, or TODO/FIXME markers across ~187k LOC. Durability-critical machinery (lease/fencing-token CAS per ADR-050/052, durable-read cursor validation, timer lifecycle, wall-clock bounds) was audited adversarially and came back clean. Docs drift after the Epic-87 restructure did not materialize — the authority-freeze gate is doing its job. The debt that exists is structural and concentrated, not diffuse.

Five themes dominate the vetted findings:

1. **The kernel's storage substrate is the weakest layer relative to its ambitions.** The postgres backend imports hand-copied files literally named `memory-backend-*.ts` (reclamation logic byte-identical, run logic differing only in error-code prefixes), rewrites the *entire* scope CBOR snapshot on every write under a single `FOR UPDATE` row and a `max: 1` connection, and the sqlite backend loads the whole database into memory for `health()` and twice per `reclaim()`. A leaseless run whose owner crashes pins the reclamation grace horizon forever. These compound: the copy-paste pairs mean invariant fixes drift silently between backends, and the backends have the thinnest test density in the repo (~0.25–0.27 test:src vs ~1.07 for runtime).
2. **Two real security gaps and two latent ones.** Provider-bridge request bodies and response headers bypass the ADR-044 secret screening on their way into durable state and the canonical event stream; the authority-guardrail gate executes manifest-owned strings via `spawn(..., { shell: true })` on every contributor machine and CI run. Latent: a string-interpolated `LIMIT` clause in the sqlite backend, and the kernel gRPC service has no authentication, TLS, message-size ceiling, or timeout — safe today at its loopback default, ungoverned by any ADR if it ever binds elsewhere.
3. **Rust conformance parity is thinner than the compatibility matrix suggests at a glance.** The Rust kernel passes 100% of the checks it runs — but it runs 42 of 68: the entire reclamation, crash-recovery, scope-isolation, and lease-clock/preemption suites (precisely the ADR-048–052 surfaces) are absent. The honest diagnosis is that Rust's gap is *persistence* (in-memory backend only), not semantics — the 33-syscall surface is fully implemented and certified.
4. **Epic BI (SDK stabilization + npm publication) starts from zero infrastructure, not "nearly ready."** All 22 `@tuvren/*` packages are `private: true`, version `0.0.0`, missing `files`/`license` fields; no changesets/release tooling, no API-surface snapshot tooling for the KRT-BI003 freeze gate, no experimental-marker mechanism for `@tuvren/core/capabilities`. Its BE/BF gating dependencies are, however, verified real and closed — sequencing is not the problem, missing scaffolding is. The epic should be rewritten around that reality (see Product Direction).
5. **The developer loop and CI leave easy wins on the table.** CI is entirely uncached (full Nix closure + bun install + crate_universe on every push) and compiles the full Rust workspace twice in parallel jobs. `verify-kernel`/`check` serialize validators the main `verify` lane already parallelizes; `verify-kernel.ts` hardcodes project lists without the drift guard its sibling codegen list gained after a real incident; the conformance assertion engine recompiles an AJV validator per `schemaValid` assertion.

## Findings Table

Sorted by Leverage (Impact/Effort × Confidence × (1 − Risk)):

| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence |
|---|---------|----------|--------|--------|------|------------|----------|
| 1 | 22 packages structurally unpublishable (`private: true`, `0.0.0`, no `files`/`license`) while Epic BI assumes near-readiness | I | HIGH | S–M | LOW | HIGH | all `typescript/*/package.json` |
| 2 | CI has zero caching: full Nix + bun + crate_universe cost on every push | G | HIGH | S | LOW | HIGH | `.github/workflows/ci.yml` |
| 3 | Byte-identical invariant/reclamation logic hand-copied between memory and postgres backends | E/A | HIGH | M | LOW | HIGH | `typescript/kernel/backends/postgres/src/lib/memory-backend-reclamation.ts` (diff exit 0 vs memory) |
| 4 | Provider-bridge `requestBody`/response headers bypass ADR-044 secret screening into durable state + canonical events | B | HIGH | M | LOW | MED | `typescript/providers/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge-utils.ts:437` |
| 5 | Leaseless crashed run pins the reclamation grace horizon forever → unbounded storage growth | A/C | HIGH | M | MED | HIGH | `typescript/kernel/backends/memory/src/lib/memory-backend-reclamation.ts:71`, `runtime-kernel-runs.ts:273` |
| 6 | Rust kernel skips 26/68 conformance checks — all reclamation/crash-recovery/scope-isolation/lease-clock suites | D | HIGH | M–L | LOW | HIGH | `reports/compatibility/compatibility-matrix.json` |
| 7 | Authority-guardrail gate executes manifest-owned strings via `spawn(..., {shell: true})` | B | MED | M | LOW | HIGH | `tools/scripts/authority-guardrails/authority-guardrails.ts:1645` |
| 8 | `core-types` is a stale byte-identical fork of two `core` files, zero consumers | E | MED | S | LOW | HIGH | `typescript/core-types/src/lib/*` |
| 9 | AJV validator recompiled per `schemaValid` assertion and per plan-file load | C | MED | S | LOW | HIGH | `tools/conformance/harness/assertion-engine/index.ts:187` |
| 10 | String-interpolated `LIMIT ${fetchLimit}` in sqlite thread-list, no runtime numeric guard in the chain | B | MED | S | LOW | HIGH | `typescript/kernel/backends/sqlite/src/lib/sqlite-repositories-support.ts:459` |
| 11 | `verify-kernel.ts` hardcodes project lists without the drift guard its codegen sibling has | G | MED | S | LOW | HIGH | `tools/scripts/verify-kernel.ts:25` |
| 12 | `verify-kernel`/`check` run independent validators fully serial; `codegen` chains ~9 validators serially in package.json | G/E | MED | S | LOW | HIGH | `tools/scripts/verify.ts:437`, `package.json:28` |
| 13 | `portability-check.ts`: 18 sequential process spawns on the verify critical path | C | MED | S | LOW | HIGH | `tools/scripts/portability-check.ts:146` |
| 14 | SQLite `health()`/`reclaim()` load the entire DB into memory (reclaim ×2) inside a writer-blocking transaction | C | HIGH | M | MED | HIGH | `typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts:283,405` |
| 15 | `purgeScope` deletes the per-scope serialization queue mid-critical-section → single-writer bypass window | A | MED | S | LOW | MED | `typescript/kernel/backends/memory/src/lib/memory-backend-scope-store.ts:68` |
| 16 | No experimental-marker mechanism + no API-snapshot tooling + no release tooling for Epic BI's gates | I | HIGH | M | MED | HIGH | ADR-054; no api-extractor/changesets anywhere |
| 17 | Kernel gRPC seam: no auth/TLS/message caps/timeouts, and no ADR governs the seam's transport posture | B | MED* | M | LOW | HIGH | `rust/kernel-grpc-service/src/lib.rs:76-115` |
| 18 | No correlation/trace ID field anywhere in the TS↔Rust kernel interop protocol | G | MED | M | MED | HIGH | `spec/interop/proto/tuvren/kernel/interop/v1/kernel_types.proto:197` |
| 19 | verify + bazel CI jobs each compile the full Rust workspace, uncached, in parallel | G | MED | M | MED | MED | `.github/workflows/ci.yml`, `tools/scripts/verify.ts:270` |
| 20 | Postgres backend rewrites the whole scope CBOR blob per write; all scope writers serialized (`max: 1` + `FOR UPDATE`) | C/E | HIGH | L | HIGH | HIGH | `typescript/kernel/backends/postgres/src/lib/postgres-backend-persistence.ts:266-333` |
| 21 | Unbounded `.all()` SELECTs on hot sqlite read paths (turns, runs, staged results, expired runs) | C | MED | M | MED | HIGH | `typescript/kernel/backends/sqlite/src/lib/sqlite-lookups.ts` |
| 22 | Conformance harness: 3 sequential JSON-RPC round trips per check; `events`+`inspectState` are parallelizable | C | MED | S | MED | MED | `tools/conformance/harness/run.ts:289-315` |
| 23 | Test-only `@tuvren/runner-react` in `bridge-ai-sdk` production dependencies | E/F | LOW | S | LOW | HIGH | `typescript/providers/bridge-ai-sdk/package.json:22` |
| 24 | Duplicated 4-part shell pipelines across sqlite backend `project.json` targets | E | LOW | S | LOW | HIGH | `typescript/kernel/backends/sqlite/project.json` |
| 25 | `SqliteBackend.transact` double-normalizes errors on the rollback path | A | LOW | S | LOW | HIGH | `typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts:337-408` |
| 26 | Kernel backend test density thinnest in the repo (postgres 0.27, sqlite 0.25 test:src) | D | MED | M | LOW | MED | LOC ratios; shared testkit carries cross-backend semantics |
| 27 | Hand-written conformance-adapter god files (2453 and 1754 lines) ~10× the repo median | E | MED | M | MED | MED | `typescript/kernel/conformance-adapter/src/host.ts` |
| 28 | `@tuvren/runtime` has the widest fan-in (10 workspace deps), blurring orchestration vs batteries-included wiring | E | MED | L | MED | MED | `typescript/runtime/package.json` |
| 29 | Internal `Kraken*` aliasing across ~18 runtime files + test helpers (public surface verified clean) | E | LOW | S–M | LOW | HIGH | `typescript/runtime/src/lib/runner-registry.ts:19` |
| 30 | `detachPromise` fire-and-forget at ~9 lifecycle sites with no documented error-routing contract | A | LOW | S | LOW | MED | `typescript/runtime/src/lib/runtime-core-shared.ts:149` |
| 31 | README quickstart assumes Nix + direnv pre-installed; CI itself needs two install steps to reach that point | H | LOW | S | LOW | HIGH | `README.md:37`, `.github/workflows/ci.yml:119` |
| 32 | No explicit Postgres readiness wait between `services:up` and verify lanes (possible CI flake source) | G | LOW | S | LOW | MED | `tools/scripts/services-up.sh`, `ci.yml:157` |
| 33 | Lease-expiry monotonicity unenforced at the storage layer (relies on `renewLease` being the only writer) | A | LOW | S | LOW | LOW | `memory-backend-run-logic.ts:178` |
| 34 | MCP http-sse endpoint accepts any URL (latent SSRF if config ever becomes dynamic); stdio command unguarded | B | LOW* | S | LOW | MED | `typescript/tools/mcp-client/src/lib/mcp-sdk-client.ts:117-132` |
| 35 | zod pinned exact in 3 packages but caret peer range in `sdk` | F | LOW | S | LOW | MED | `typescript/sdk/package.json:28` |

\* Conditional impact: exploitable only under deployment/configuration changes that no ADR currently forbids or governs.

**Killed in vetting:** the sqlite `turn_tree_paths` index-order finding (the `(turn_tree_hash, path)` PRIMARY KEY already serves both observed query shapes); Epic BI phantom-dependency hypothesis (BE/BF exist and are closed); console-logging sprawl (2 hits repo-wide); post-Epic-87 docs drift (freeze gate holds); `certification-batteries-included` as vestigial (it's a correctly-shaped config-only certification wrapper); MCP tool I/O validation gaps (Ajv-validated per ADR-039); postgres identifier interpolation (schema names regex-gated + quoted, data parameterized).

**Post-audit verification (upgraded from open question to finding):** the runtime *does* resubmit full flat TurnTree path arrays on every write — `toStoredTurnTreePath` (`typescript/kernel/runtime/src/lib/runtime-kernel-storage.ts:116-136`) unconditionally emits `orderedEncoding: "flat"` with the complete items array and has no chunk-aware path, so past the ADR-011 threshold the backend re-chunks and re-hashes the entire collection per append. Content-addressing dedupes storage but not CPU: append cost is O(collection size) at the caller. Category C | Impact MED (grows with conversation length) | Effort S–M (teach the caller to submit already-chunked records/deltas; the backend already accepts them) | Risk LOW | Confidence HIGH. Belongs in the kernel-substrate epic alongside the persistence-model decision.

## Detailed Findings

### [I-01] Epic BI's publication runway does not exist yet
- **Evidence:** All 22 `typescript/*/package.json` files: `"private": true`, `"version": "0.0.0"`, no `files`, no `license` (root `LICENSE` never referenced). No `.changeset/`, no release/publish script, no api-extractor or `.d.ts`-diff tooling, zero `@experimental` markers in `typescript/core/src`. ADR-054 and KRT-BI002/BI003 presuppose all of these. Dependencies KRT-BE006/KRT-BF006 verified real and closed (`.constitution/tasks/completed/EPIC-BE-*.md:78`, `EPIC-BF-*.md:78`).
- **Impact:** As written, KRT-BI001's audit could pass while the packages remain literally unpublishable; KRT-BI003's freeze gate has no mechanism to distinguish stable from experimental changes; KRT-BI004's Effort-5 estimate undercounts a from-scratch pipeline build.
- **Effort & Risk:** Effort: M aggregate | Risk: LOW–MED (metadata + additive tooling; gate miscalibration is the real risk)
- **Confidence:** HIGH
- **Fix Sketch:** Rewrite Epic BI as two epics: (1) *Publishing Infrastructure* — manifest metadata (`files: ["dist"]`, license, real semver), changesets adoption, experimental-marker ADR + implementation; (2) *Freeze & Publish* — API-surface snapshot gate scoped to ADR-054's stable core, then registry pipeline with provenance. Write the experimental-marker ADR first: the freeze gate and marker convention must be designed together.

### [E-01] Copy-paste kernel backend cores
- **Evidence:** `typescript/kernel/backends/postgres/src/lib/memory-backend-reclamation.ts` is byte-for-byte identical to the memory backend's copy (`diff` exit 0, 415 lines); `memory-backend-record-utils.ts` and `memory-backend-run-logic.ts` pairs differ only in error-code prefixes. The sqlite backend re-implements the same invariants a third way.
- **Impact:** An invariant fix (reclamation reachability, lease-transition legality, immutability checks) applied to one backend silently leaves the others unpatched — backend-specific divergence in exactly the logic conformance may not exercise per-backend. Compounded by the backends having the thinnest test density in the repo.
- **Effort & Risk:** Effort: M | Risk: LOW (behavior-preserving extraction; parameterize error-code prefixes)
- **Confidence:** HIGH
- **Fix Sketch:** Extract a shared internal `kernel-backend-core` module (state validation, reclamation closure, run-transition legality) consumed by all three backends; the deletion test — removing the postgres copies loses nothing — passes today by construction.

### [A-01] Reclamation grace horizon pinned by leaseless crashed runs
- **Evidence:** `computeGraceHorizonMs` (`memory-backend-reclamation.ts:71-79`, same logic in sqlite) takes `min(createdAtMs)` over all active runs; `run.create` (`runtime-kernel-runs.ts:273-314`) creates `status: "running"` records with no lease fields; `isExpiredLeasedRunningRun` (`memory-backend-record-utils.ts:584-595`) requires `executionOwnerId`, `fencingToken`, and `leaseExpiresAtMs` all present, so a leaseless run can never be listed expired or preempted.
- **Impact:** One crashed owner of a leaseless run permanently blocks reclamation of all state created after that run's `createdAtMs` — unbounded storage growth on any long-lived host using the non-leased run API.
- **Effort & Risk:** Effort: M | Risk: MED (changes lifecycle invariants; needs conformance plan updates in lockstep)
- **Confidence:** HIGH (mechanism verified end-to-end; production exposure depends on leaseless-API usage)
- **Fix Sketch:** Either require leases on every run that can be abandoned, or add an administrative expiry/timeout path for leaseless runs; encode the chosen rule in the kernel authority packet and reclamation conformance plan.

### [B-01] Provider-bridge extras bypass ADR-044 secret screening
- **Evidence:** `ai-sdk-provider-bridge-generate.ts:390-400` and `ai-sdk-provider-bridge-stream.ts:105-113,732-748` capture `requestBody` and response headers via `sanitizeMetadataValue` (`ai-sdk-provider-bridge-utils.ts:437-492`), which performs JSON-safety normalization only — no pattern-based secret screening, unlike `typescript/runtime/src/lib/telemetry-secret-screening.ts`. The values flow through `buildProviderMetadata` into `tool_call.done` canonical events and durable run records. ADR-044 §Context names the canonical event stream and durable state as credential-free zones; its `secret-isolation` fixture scans only for the *configured* secret values, so differently-shaped leaks pass.
- **Impact:** Any provider/gateway that embeds credentials in request bodies or echoes tokens/signed URLs in response headers persists them verbatim into durable state and transcript-visible events.
- **Effort & Risk:** Effort: M | Risk: LOW (apply the existing screening module at the bridge seam; screening is already allowlist-shaped)
- **Confidence:** MED (mechanism verified; real-world header/body secret shapes vary by provider)
- **Fix Sketch:** Route `bridgeExtras` values through the ADR-044 screening channel before they enter provider metadata; extend the secret-isolation conformance fixture with a pattern-shaped (not value-equality) assertion.

### [B-02] Guardrail gate executes manifest-owned shell strings
- **Evidence:** `authority-guardrails.ts:1645-1648`: `spawn(command, { cwd: REPO_ROOT, shell: true })` where `command` is `freshnessChecks[].regenerateCommand` from checked-in `spec/**/authority-packet.json`, validated only for non-emptiness (line ~195).
- **Impact:** This gate runs inside `bun run check`/`verify` on every contributor machine and CI. A PR editing a JSON manifest field — a diff type that draws less review scrutiny than code — executes arbitrary shell with metacharacter interpretation. A plausible internal supply-chain vector.
- **Effort & Risk:** Effort: M | Risk: LOW–MED (must keep legitimate multi-word regenerate commands working)
- **Confidence:** HIGH
- **Fix Sketch:** Replace `shell: true` with argv-array execution against an allowlisted command prefix set (`bun`, `bunx`, `cargo`, `buf`, …), or resolve `regenerateCommand` to registered script IDs instead of raw strings.

### [D-01] Rust kernel conformance parity gap on the durability-critical suites
- **Evidence:** `reports/compatibility/compatibility-matrix.json`: `rust-kernel` runs 42 checkIds vs `typescript-kernel-postgres` 68. Missing entirely: `kernel.reclamation.*` (5), `kernel.crash-recovery.*` (3), `kernel.scope-isolation.*` (3), `kernel.run-liveness.{clock_skew_preemption, expired_listing, lease_renewal, stale_preemption}`, `kernel-restart-af.*`, `kernel-restart-recovery.close_reopen_checkpoint`.
- **Impact:** The ADR-048–052 surfaces — the ones this repo's whole SaaS-readiness block hardened — have zero automated verification in Rust. A Rust regression in scope isolation or recovery ships undetected. Note the honest complement: Rust passes 100% of what it runs, and `rust-framework` correctly reports `unsupported` rather than gaming the matrix.
- **Effort & Risk:** Effort: M–L (some checks presuppose persistence/restart, which the in-memory Rust kernel cannot express — see [I-02]) | Risk: LOW (additive)
- **Confidence:** HIGH
- **Fix Sketch:** Promote the reclamation/scope-isolation/liveness checks that are expressible against the in-memory backend now; tie the restart/crash-recovery checks to the Rust persistence epic ([I-02]) as its acceptance gate.

### [C-01] Postgres whole-blob persistence model (independently confirmed twice)
- **Evidence:** `postgres-backend.ts:238-355` + `postgres-backend-persistence.ts:266-333`: every transaction does `SELECT … FOR UPDATE` on the single scope row, decodes the full CBOR snapshot, clones, mutates, re-encodes, and rewrites the whole blob — even for one small write — over a `max: 1` connection with an additional in-process transaction queue. No ADR documents this as an accepted trade-off (checked ADR-006/048/049/050/051).
- **Impact:** Per-write cost is O(total scope state); all writers within a scope are serialized. For the documented SaaS topology (many concurrent runs against one active tenant scope), per-turn latency grows with accumulated history — a scalability ceiling that arrives well before storage limits.
- **Effort & Risk:** Effort: L | Risk: HIGH (touches the canonical CBOR snapshot model several ADRs lean on)
- **Confidence:** HIGH (mechanism; scale onset unmeasured)
- **Fix Sketch:** First decide, then build: write an ADR either accepting the blob model with explicit scope-size bounds, or committing to path-granular/row-per-record persistence. Add a benchmark to `docs/perf-benchmarks.md` measuring write latency vs scope size so the decision is evidence-based. Same decision governs sqlite's full-DB `health()`/`reclaim()` loads (`sqlite-backend.ts:283-291,405-431`).

### [A-02] `purgeScope` serialization-bypass window
- **Evidence:** `memory-backend-scope-store.ts:68-71`: `dropScope` deletes the `scopeQueues` entry from *inside* the `runExclusive` critical section (`memory-backend.ts:215-224`). A transaction B already chained on the queue is unaffected, but a caller C arriving after the deletion chains on a fresh `Promise.resolve()` and runs concurrently with B.
- **Impact:** Breaks the store's documented single-writer guarantee exactly during tenant offboarding under load; can corrupt concurrent drafts or throw spurious invariant errors. Untested path (`backend-memory.purge-scope.test.ts` has no purge-vs-transact race case).
- **Effort & Risk:** Effort: S | Risk: LOW
- **Confidence:** MED (narrow window; requires a shared store + racing purge)
- **Fix Sketch:** Don't delete the queue entry while continuations may be chained — replace with a resolved sentinel, or delete only if the current map value is the one this call installed; add the race test.

### [B-03] Latent injection + unguarded seam inputs (defense-in-depth cluster)
- **Evidence:** (a) `sqlite-repositories-support.ts:456-459`: `` `LIMIT ${fetchLimit}` `` interpolated, `options.limit` typed `number` with no runtime guard anywhere in the chain (`kernel-types.ts:425,684`, `runtime-kernel.ts:487`); currently shielded only because the gRPC path happens to use `optional uint32`. (b) `rust/kernel-grpc-service/src/lib.rs:76-115`: no auth interceptor, no TLS, no `.max_decoding_message_size`/`.timeout`/`.concurrency_limit_per_connection`; bind address env-overridable to `0.0.0.0`; `node_walk_back` (lib.rs:287-326) has no depth cap. No ADR governs this seam's transport posture. (c) `mcp-sdk-client.ts:117-132`: stdio command/args/env and http endpoint passed through unguarded — consistent with ADR-039's host-trust model today, but with no structural guard if config ever becomes tenant- or model-sourced.
- **Impact:** None exploitable at today's defaults; each becomes real the day a new caller, deployment, or config source appears — and nothing in the authority chain currently prevents that day.
- **Effort & Risk:** Effort: S each | Risk: LOW
- **Confidence:** HIGH (a), HIGH (b), MED (c)
- **Fix Sketch:** (a) `Number.isSafeInteger` guard + parameterize. (b) A short ADR fixing the seam's posture (loopback-only until authenticated; size/time/depth caps now). (c) Document caller obligations in the MCP client README per ADR-039.

### [G-01] CI and verification-lane throughput
- **Evidence:** `.github/workflows/ci.yml` — no `actions/cache` anywhere; verify job (cargo clippy + test via `verify.ts:270-312`) and bazel job (`bazel build/test //...`) each compile the full Rust workspace; identical Nix/devenv install steps duplicated byte-for-byte across both jobs (lines 119-134, 173-185). `verify.ts:437-450` maps explicit step lists (used by `verify-kernel`, `check`) to `concurrency: 1` phases even for independent validators, while `DEFAULT_VERIFICATION_PHASES` already parallelizes the same validators at concurrency 8. `package.json:28` chains ~9 independent validators serially. `verify-kernel.ts:25-40` hardcodes `KERNEL_TYPECHECK_PROJECTS`/`KERNEL_CONFORMANCE_PROJECTS` as literals — the same stale-list bug class that hit the codegen list at 87-M4.2c, whose fix (`verify.ts:33-70` parses + validates against the live Nx graph) was never applied to this sibling. `portability-check.ts:146-156`: 18 sequential process spawns.
- **Impact:** Every push pays minutes of avoidable cold-start; the two fastest-feedback lanes (`check`, `verify:kernel`) pay serial latency the slow lane already avoids; a kernel project rename can silently drop it from verification.
- **Effort & Risk:** Effort: S per item | Risk: LOW (the phase engine and the graph-validation pattern both already exist in-repo)
- **Confidence:** HIGH
- **Fix Sketch:** Add Nix/bun/cargo caching + a composite setup action; group `verify-kernel`'s independent validators into one parallel phase; move the codegen chain into `tools/scripts/codegen.ts` reusing `AUTHORITY_GATE_STEPS`; derive kernel project lists from the Nx graph; bound-concurrency the portability spawns.

### [C-02] Conformance harness CPU/latency waste
- **Evidence:** `assertion-engine/index.ts:187-188` — fresh `new Ajv2020().compile()` per `schemaValid` assertion; `plan-compiler/index.ts:122,183-190` — plan-schema validator re-read from disk and recompiled per plan file; `harness/run.ts:289-315,386-419` — `dispatch` → `events` → `inspectState` fully sequential per check/step though `events` and `inspectState` are independent after dispatch.
- **Impact:** Pure wasted CPU and RPC-latency tail multiplied across every check × adapter × certification run in every `conformance`/`verify` invocation.
- **Effort & Risk:** Effort: S | Risk: LOW (memo maps); LOW–MED for the RPC parallelization (verify the stdio protocol tolerates interleaved requests)
- **Confidence:** HIGH
- **Fix Sketch:** Module-level validator caches keyed by schema identity (the runtime already does this — `tool-execution-helpers.ts:925-941` is the in-repo precedent); `Promise.all` the two post-dispatch reads.

### [G-02] No correlation ID across the only cross-process, cross-language seam
- **Evidence:** `spec/interop/proto/tuvren/kernel/interop/v1/kernel_types.proto:197-202` (`StepContext` carries no trace/request ID); repo-wide search finds no `traceparent`/correlation field on the interop path.
- **Impact:** A failure crossing TS↔Rust gRPC cannot be correlated across both sides' logs/spans — undermining ADR-042's telemetry ambition precisely where debugging is hardest.
- **Effort & Risk:** Effort: M | Risk: MED (frozen, authority-governed proto surface — needs the freeze-gate workflow)
- **Confidence:** HIGH
- **Fix Sketch:** Add an optional `trace_context` field (W3C traceparent string) to the interop request envelope via the authority-change process; thread it into telemetry attributes on both sides.

### [E-02] Consolidation cluster (small, high-certainty cleanups)
- **Evidence & fixes:**
  - `typescript/core-types/src/lib/{tuvren-error,kernel-records}.ts` — byte-identical stale forks of `core`, zero importers: delete the package or reduce to pure re-exports. (S)
  - `typescript/providers/bridge-ai-sdk/package.json:22` — `@tuvren/runner-react` used only by tests: move to devDependencies. (S)
  - `typescript/kernel/backends/sqlite/project.json` — 4-part compile+copy-migrations pipeline duplicated across `bench`/`retention-dry-run`/`test`: extract to a `tools/scripts/` helper. (S)
  - `sqlite-backend.ts:337-408` — double `normalizeBackendError` on rollback: collapse to one try/catch. (S)
  - `typescript/sdk/package.json:28` — align zod peer range with the exact-pin convention. (S)
  - ~18 runtime files + test helpers aliasing public types to `Kraken*`: drop the aliases; optionally add a lint guard keeping `Kraken*` out of public exports permanently. (S–M)
  - `runtime-core-shared.ts:149` `detachPromise`: document the "callee must route its own errors" contract at the definition site. (S)
- **Impact:** Each is small; together they remove the main drift vectors the audit found outside the kernel substrate.
- **Confidence:** HIGH

### [E-03] Structural watch items (act when touched, not before)
- `typescript/kernel/conformance-adapter/src/host.ts` (2453 lines) and `typescript/conformance-adapter/src/framework-adapter-runtime-scenarios.ts` (1754) — ~10× the 211-line repo median; split by scenario family behind a dispatcher next time they're materially edited (Risk: MED — conformance-critical).
- `@tuvren/runtime`'s 10-dependency fan-in — **post-audit verification:** ADR-054 §Context explicitly defines the curated surface as "`@tuvren/core` … plus `@tuvren/runtime` (`createTuvren` and curated re-exports)", so the composition living in runtime is a *settled* ADR-040/054 decision, not drift. This is therefore not a refactor finding but a one-question decision for the Epic BI rewrite: amend ADR-040/054 pre-freeze to split composition into a batteries-included package (every SDK consumer currently installs all three backends + the React runner transitively), or reaffirm the ADR and accept the dependency weight. Post-freeze the split becomes a semver-major, so the decision window closes at KRT-BI003.
- Kernel backend test density (postgres 0.27, sqlite 0.25) — the shared testkit carries cross-backend semantics, but backend-*specific* storage behavior (SQL edge cases, WAL/locking, pool exhaustion) has proportionally thin dedicated coverage; grow alongside any backend-substrate work.
- Unbounded sqlite `.all()` reads (`sqlite-lookups.ts`: turns/runs/staged-results/expired-runs) — needs a pagination contract decision at the kernel API level; bundle with the persistence-model ADR rather than piecemeal.
- `docs/perf-benchmarks.md` references one retired package name — S fix, fold into any docs pass.
- README quickstart: add the two-line Nix/direnv prerequisite the CI workflow itself needs (`ci.yml:119-134`); consider a `pg_isready` wait in `services-up.sh`.

## Product & Feature Direction Suggestions

1. **Rewrite Epic BI as "Publishing Infrastructure" → "Freeze & Publish", front-loaded by an experimental-marker ADR.** Evidence ([I-01]): 22 private/0.0.0 manifests, no changesets, no API-snapshot tooling, no marker mechanism — while KRT-BI003's acceptance criterion *requires* the gate to distinguish stable from experimental changes, which is impossible until the marker convention exists. The marker mechanism (TSDoc `@experimental` + snapshot-tool exclusion vs a dedicated subpath) is a load-bearing design choice that determines the gate's shape — decide it in an ADR before re-ticketing. Fold the public-surface audit (KRT-BI001) in as the freeze candidate step it already is; its `Kraken*`-leak precondition is verified clean today by this audit.

2. **Name a "Kernel Substrate Hardening" epic — the storage layer is where correctness risk, performance ceilings, and test thinness all converge.** Evidence: [E-01] copy-paste backend cores, [A-01] grace-horizon pinning, [A-02] purge race, [C-01] blob-per-write model with no governing ADR, [B-03a] the LIMIT interpolation, plus the thinnest test ratios in the repo. A single epic — extract the shared backend core, decide the persistence-model ADR with benchmark evidence, fix the lifecycle/race bugs, add the missing race/scale tests — resolves five findings with one coherent scope, and it should land *before* npm publication makes the kernel contract harder to change.

3. **Scope a small "Rust Kernel Persistence + Conformance Parity" epic, decoupled from the deprioritized full-parity theme.** Evidence ([I-02], [D-01]): the Rust kernel's 33-syscall semantic surface is complete and honestly certified; the actual gaps are one persistent backend and the 26 unrun durability-critical checks — several of which (scope isolation, reclamation on the in-memory backend) are promotable *now* without persistence. This captures real value (a production-usable Rust kernel) without reopening the second-implementation-line question `vision.md` explicitly deprioritizes, and the restart/crash-recovery checks become the epic's natural acceptance gate.

## Next Step

Pivot to **`/interview for Tasks`** with this report as input. That stage (the `planning-engineering-execution` skill) is the constitutional mechanism to prioritize these findings with you and decompose them into a sequenced epic file with Gherkin tickets — including the Epic BI rewrite this audit motivates.
