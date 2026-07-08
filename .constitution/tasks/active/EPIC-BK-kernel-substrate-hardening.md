# Epic BK — Kernel Substrate Hardening (KRT)

**Status:** Active. Governing authority: the 2026-07-04 constitutional audit `.constitution/reports/audit-2026-07-04-170703-post-epic-87-baseline.md`, findings [E-01] (copy-paste kernel backend cores), [A-01] (leaseless reclamation-horizon pin), [A-02] (`purgeScope` serialization-bypass window), [B-01] (provider-bridge ADR-044 secret-screening bypass), [B-02] (guardrail-gate `shell: true` execution), [B-03] (latent injection/unguarded-seam cluster: sqlite `LIMIT` interpolation, gRPC seam caps), [C-01] (postgres whole-blob persistence model / sqlite full-DB `health`/`reclaim` loads), [D-01] (Rust conformance parity gap), plus the post-audit-verified TurnTree caller-side chunking finding and [E-02]/[E-03] cleanup items (sqlite rollback double-normalization, backend test-density). Cross-referenced authority: ADR-044 (secret isolation across durable/telemetry/transcript surfaces), ADR-050 (backend-authoritative lease clock for shared backends), ADR-051 (data lifecycle, reachability, reclamation, crypto-shred), ADR-052 (side-effect-once under preemption / idempotency envelope), and ADR-011 (TurnTree storage is path-granular with threshold-based chunking) for KRT-BK008.

This epic is sequenced to land and close before the Epic BL freeze gate activates, so kernel-substrate invariant, security, and persistence-model decisions are settled while the public surface is still open to non-additive change.

**Total: 31 points.**

#### KRT-BK001 Extract the Shared Kernel-Backend Invariant Core
- **Type:** Chore
- **Effort:** 5
- **Dependencies:** None
- **Category:** Tech-Debt
- **Capability / Contract Mapping:** `kernel.reclamation`, `kernel.run-liveness`, `kernel.lineage` (state-immutability and run-transition-legality invariants shared by all three `RuntimeBackend` realizations)
- **Scope (In-Scope Files):**
  - `typescript/kernel/backends/postgres/src/lib/memory-backend-reclamation.ts`
  - `typescript/kernel/backends/memory/src/lib/memory-backend-reclamation.ts`
  - `typescript/kernel/backends/postgres/src/lib/memory-backend-record-utils.ts`
  - `typescript/kernel/backends/memory/src/lib/memory-backend-record-utils.ts`
  - `typescript/kernel/backends/postgres/src/lib/memory-backend-run-logic.ts`
  - `typescript/kernel/backends/memory/src/lib/memory-backend-run-logic.ts` (counterpart, to diff error-code-prefix deltas against)
  - `typescript/kernel/backends/sqlite/src/lib/sqlite-reclamation.ts`
  - `typescript/kernel/backends/postgres/src/lib/` (new shared-core module, e.g. `kernel-backend-invariant-core.ts`, or a new `typescript/kernel/backends/core/` package if cross-package reuse requires it — confirm placement against the repository Structure rules before creating a new package)
- **Scope (Out-of-Scope Files):** `typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts` (transaction/connection lifecycle, addressed by KRT-BK009), `typescript/kernel/backends/postgres/src/lib/postgres-backend-persistence.ts` (persistence model, addressed by KRT-BK007), any conformance plan file under `spec/conformance/kernel/plans/`
- **Verification Command:** `bun run verify:kernel`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if any kernel conformance check (`spec/conformance/kernel/plans/kernel-reclamation.json` or any lineage/liveness plan) changes outcome versus the pre-extraction baseline; STOP if error-code-prefix parameterization would require changing a check's asserted `code` value rather than just its emitter.
- **Description:** Extract one shared internal module implementing the reclamation keep-closure (which state is reachable and must survive a reclaim pass), run-transition legality (which `RunStatus` transitions are valid and under what lease/fencing preconditions), and committed-state immutability checks, parameterized only by an error-code prefix per backend. All three backends (memory, postgres, sqlite) consume this module instead of hand-copying or re-implementing the logic. The extraction must be behavior-preserving: no backend's observable reclamation, transition-legality, or immutability behavior changes, only its source of truth for that behavior.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Shared kernel-backend invariant core

  Scenario: Postgres backend no longer hand-copies memory-backend reclamation logic
    Given the shared invariant-core module exists and is imported by all three backends
    When I diff the postgres backend's reclamation logic file against its pre-extraction copy
    Then the postgres backend file re-exports or delegates to the shared module
    And no independent copy of the reclamation keep-closure remains in the postgres backend

  Scenario: Behavior is preserved across all three backends
    Given the pre-extraction kernel conformance baseline for memory, sqlite, and postgres backends
    When I run "bun run verify:kernel" after the extraction
    Then every previously-passing reclamation, run-transition, and immutability check still passes
    And no check's asserted error code or outcome differs from the pre-extraction baseline

  Scenario: Error-code prefixes remain backend-distinguishable
    Given a run-transition-legality violation is triggered against each backend independently
    When the shared module raises the invariant error
    Then the memory backend's error code carries the memory backend's existing prefix
    And the sqlite and postgres backends carry their own existing prefixes unchanged
```

##### KRT-BK001 Deviations & Justifications
- **Touched Files:** `bun.lock`, `tools/scripts/verify.ts`, `tsconfig.base.json`, `tsconfig.json`, each backend's `package.json`, and each backend's `tsconfig.dts.json`/`tsconfig.lib.json` (plus memory's `tsconfig.typecheck.json`, its only local paths override); additionally, `typescript/kernel/backends/sqlite/src/lib/sqlite-run-invariants.ts`.
- **Justification:** The ticket's Scope explicitly authorized creating a new shared-core package ("a new `typescript/kernel/backends/core/` package if cross-package reuse requires it"). A new Nx/Bun-workspace package cannot build, link, or typecheck without workspace-manifest wiring: `bun.lock` records the new package's install graph, `tsconfig.base.json`/`tsconfig.json` register its project reference, `tools/scripts/verify.ts` registers it in `WORKSPACE_TEST_PROJECTS`/`WORKSPACE_BUILD_PROJECTS` so `bun run check`'s workspace-coverage gate doesn't fail on an unregistered project, and each consuming backend's `package.json`/`tsconfig.dts.json`/`tsconfig.lib.json` add the new `@tuvren/backend-shared` dependency edge. These are necessary, mechanical consequences of the pre-authorized new package, not scope creep — behavior of the extracted logic itself is unchanged (verified: `bun run verify:kernel` conformance counts identical pre/post at memory 64/68, sqlite 67/68, postgres 68/68).
  - `sqlite-run-invariants.ts` was not in the ticket's declared In-Scope Files list for sqlite (only `sqlite-reclamation.ts` was named), an omission rather than a deliberate exclusion — the ticket's Description ("All three backends... consume this module instead of hand-copying or re-implementing the logic") and Gherkin Scenario 3 require run-transition-legality/immutability parity across all three backends, not just reclamation. The initial commit (b9301b7) only delegated sqlite's reclamation, leaving [E-01] partially closed for sqlite; an independent milestone review (both standards and spec axes) caught this and flagged it P1. A follow-up commit delegates `assertRunUpdateIsLegal`, `assertMonotonicUpdatedAtMs`, `assertImmutableField`, `assertImmutableOptionalField`, and `assertImmutableBytes` to the shared core (`errorPrefix: "sqlite"`), while leaving every genuinely sqlite-specific export in that file (turn-span/lineage/canonical-lineage checks with no shared-core counterpart) untouched. Verified byte-identical error codes and an unchanged `verify:kernel` conformance baseline before and after.

#### KRT-BK002 Reclamation Horizon: Leaseless-Run Expiry Path
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** KRT-BK001
- **Category:** Correctness
- **Capability / Contract Mapping:** `kernel.reclamation`, `kernel.run-liveness` — ADR-050 (backend-authoritative lease clock), ADR-051 (reclamation/crypto-shred lifecycle)
- **Scope (In-Scope Files):**
  - `typescript/kernel/backends/memory/src/lib/memory-backend-reclamation.ts` (or its post-KRT-BK001 shared-core successor)
  - `typescript/kernel/backends/memory/src/lib/memory-backend-record-utils.ts` (`isExpiredLeasedRunningRun`, line ~584)
  - `typescript/kernel/runtime/src/lib/runtime-kernel-runs.ts` (`create`, line ~273)
  - `typescript/kernel/backends/sqlite/src/lib/sqlite-reclamation.ts`
  - `spec/kernel/authority-packet.json`
  - `spec/conformance/kernel/plans/kernel-reclamation.json`
- **Scope (Out-of-Scope Files):** `typescript/kernel/backends/postgres/src/lib/postgres-backend-persistence.ts`, provider-bridge and guardrail files, `rust/kernel-grpc-service/src/lib.rs`
- **Verification Command:** `bun run verify:kernel`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if the chosen expiry rule would change committed-lineage semantics (i.e., would ever cause a committed, non-abandoned run's state to become unreachable); STOP if requiring leases on every abandonable run would break an existing public `run.create` call shape without a documented migration path — surface the trade-off instead of silently picking one.
- **Description:** Today `computeGraceHorizonMs` pins the reclamation grace horizon to `min(createdAtMs)` over all active runs, and a `run.create` call with no `executionOwnerId`/`fencingToken`/`leaseExpiresAtMs` produces a leaseless running run that `isExpiredLeasedRunningRun` can never classify as expired — so a crashed owner of a leaseless run blocks reclamation of everything created after it, forever. Define and implement an explicit expiry rule for leaseless runs (either an administrative timeout/expiry path independent of lease fields, or a policy requiring leases on every abandonable run) inside the shared invariant core from KRT-BK001, and update the kernel authority packet and the reclamation conformance plan in the same change so the new rule is authoritative, not implicit.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Leaseless-run reclamation expiry

  Scenario: A leaseless run with a crashed owner eventually becomes reclaimable
    Given a run created via "run.create" with no executionOwnerId, fencingToken, or leaseExpiresAtMs
    And the run's creator never transitions it out of "running"
    When the kernel's defined leaseless-expiry horizon elapses
    Then the run is classified as expired by the reclamation pass
    And state created after that run's creation becomes reclaimable

  Scenario: Reclamation horizon is no longer pinned indefinitely by one abandoned leaseless run
    Given one leaseless running run older than the expiry horizon
    And other active runs created after it
    When "computeGraceHorizonMs" is evaluated
    Then the horizon advances past the abandoned leaseless run
    And unrelated live runs remain unaffected

  Scenario: The authority packet and conformance plan encode the new rule
    Given the updated "spec/kernel/authority-packet.json" and "spec/conformance/kernel/plans/kernel-reclamation.json"
    When "bun run verify:kernel" runs
    Then the leaseless-expiry check passes against memory and sqlite backends
    And no previously-passing reclamation check regresses
```

#### KRT-BK003 Purge/Transact Serialization Race Fix
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** None
- **Category:** Correctness
- **Capability / Contract Mapping:** `kernel.scope-isolation` (single-writer-per-scope guarantee during tenant offboarding)
- **Scope (In-Scope Files):**
  - `typescript/kernel/backends/memory/src/lib/memory-backend-scope-store.ts` (`dropScope`, lines 68-71; `runExclusive`, lines ~79-97)
  - `typescript/kernel/backends/memory/test/backend-memory.purge-scope.test.ts`
- **Scope (Out-of-Scope Files):** `typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts` `purgeScope` (already file-close based, not affected by this race), `typescript/kernel/backends/postgres/src/lib/`
- **Verification Command:** `bun run nx run backend-memory:test`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if a sentinel/conditional-delete fix cannot preserve the documented "distinct Scopes never contend" guarantee under the added test — escalate instead of shipping a partial fix.
- **Description:** `dropScope` deletes the per-scope queue entry (`this.scopeQueues.delete(scope)`) from inside the same call that also deletes committed state, without checking whether a later caller has already chained a new continuation onto that scope's queue. A caller arriving after the deletion chains onto a fresh `Promise.resolve()` instead of the true prior continuation, letting it run concurrently with a transaction still in flight — bypassing the single-writer-per-scope guarantee during tenant purge. Fix by not unconditionally deleting the queue entry while continuations may still be chained (a resolved sentinel value, or a conditional delete that only removes the map entry if it still holds the value this call installed), then add the purge-vs-concurrent-transact race regression test that does not exist today in `backend-memory.purge-scope.test.ts`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Purge-scope serialization safety

  Scenario: A transaction racing a concurrent scope purge does not bypass the single-writer guarantee
    Given a Scope with an in-flight transaction queued via "runExclusive"
    And a concurrent caller invokes "dropScope" on the same Scope
    And a third caller immediately starts a new transaction on the same Scope
    When all three operations are allowed to interleave
    Then the third caller's transaction does not execute concurrently with the still-in-flight transaction
    And the store's single-writer-per-scope guarantee holds throughout

  Scenario: Purge-vs-transact race test exists and passes
    Given "backend-memory.purge-scope.test.ts"
    When "bun run nx run backend-memory:test" runs
    Then a test simulating a purge racing a concurrent transact on the same scope exists
    And it asserts no concurrent execution window opens
```

##### KRT-BK003 Deviations & Justifications
- **Touched Files:** `typescript/kernel/backends/memory/test/backend-memory.scope-store-concurrency.test.ts` (new file, not the Gherkin-named `backend-memory.purge-scope.test.ts`).
- **Justification:** The new test targets `MemoryScopeStore`'s internal `runExclusive`/`dropScope` serialization primitive directly (three racing actors sequenced via hand-rolled deferreds, no timers), a different concern than `backend-memory.purge-scope.test.ts`'s existing black-box `purgeScope()` behavior tests. The substantive Gherkin criterion — a purge-vs-transact race test exists under `bun run nx run backend-memory:test` (actual Nx project name; the ticket's cited `kernel-backend-memory` does not exist) and asserts no concurrent window opens — is met in a differently-named file. Achieved a genuine red-then-green TDD cycle: the test failed against unmodified source with the exact predicted ordering violation (`D-ran` before `B-done`) before the fix was applied.

#### KRT-BK004 Provider-Bridge Secret Screening at the Seam (ADR-044/058)
- **Type:** Security
- **Effort:** 3
- **Dependencies:** None
- **Category:** Security
- **Capability / Contract Mapping:** `providers.secret-isolation` — ADR-044 (secret isolation across durable/telemetry/transcript surfaces), ADR-058 (construction-time funnel routing for telemetry destinations)
- **Scope (In-Scope Files):**
  - `typescript/providers/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge-utils.ts` (`sanitizeMetadataValue`, lines 437-492; `bridgeExtras` construction)
  - `typescript/providers/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge-generate.ts` (lines ~390-400)
  - `typescript/providers/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge-stream.ts` (lines ~105-113, ~732-748)
  - `typescript/runtime/src/lib/telemetry-secret-screening.ts`
  - `typescript/conformance-adapter/src/framework-adapter-secret-isolation.ts`
  - `spec/conformance/providers/fixtures/secret-isolation-fixtures.json`
- **Scope (Out-of-Scope Files):** kernel backend files, `tools/scripts/authority-guardrails/authority-guardrails.ts`
- **Verification Command:** `bun run conformance`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if routing `bridgeExtras` through the existing screening module would require changing the screening module's own allowlist contract rather than just calling it — surface the seam mismatch instead of relaxing screening semantics.
- **Description:** `requestBody` and response-header values captured into `bridgeExtras` currently pass only through `sanitizeMetadataValue`, which performs JSON-safety normalization (stringifying `Date`/`URL`/`Uint8Array`/`Error`, recursing into plain objects and arrays) with no pattern-based secret detection, unlike the dedicated `telemetry-secret-screening.ts` module used elsewhere in the runtime. These values flow through `buildProviderMetadata` into `tool_call.done` canonical events and durable run records, both of which ADR-044 names as credential-free zones. Apply the shared secret-screening module at the bridge seam before values enter provider metadata, and extend the secret-isolation conformance fixture with a pattern-shaped assertion (detecting secret-shaped values structurally) rather than only the existing value-equality assertion against configured secrets.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Provider-bridge secret screening

  Scenario: Request-body secrets are screened before entering durable state
    Given a provider response whose captured requestBody contains a credential-shaped value not equal to any configured secret
    When the AI SDK provider bridge builds bridgeExtras and provider metadata
    Then the credential-shaped value is screened out or redacted before reaching "tool_call.done" event payloads
    And it is screened out or redacted before reaching durable run records

  Scenario: Response headers carrying signed URLs or tokens are screened
    Given a provider response with a header value shaped like a signed URL or bearer token
    When the bridge captures response headers into bridgeExtras
    Then the shared telemetry-secret-screening module is applied to that value
    And the screened output contains no raw credential-shaped substring

  Scenario: Pattern-shaped secret-isolation conformance passes
    Given the extended "spec/conformance/providers/fixtures/secret-isolation-fixtures.json" with a pattern-shaped (non-value-equality) fixture
    When "bun run conformance" runs
    Then the secret-isolation check detects the credential-shaped leak class
    And no previously-passing secret-isolation check regresses
```

#### KRT-BK005 Guardrail Gate Command Execution Hardening
- **Type:** Security
- **Effort:** 2
- **Dependencies:** None
- **Category:** Security
- **Capability / Contract Mapping:** Audit finding [B-02] — manifest-owned command execution inside the `check`/`verify` gates
- **Scope (In-Scope Files):**
  - `tools/scripts/authority-guardrails/authority-guardrails.ts` (`runRegenerateCommand`, lines ~1639-1665; validation at line ~195)
  - `spec/kernel/authority-packet.json` and any other `spec/**/authority-packet.json` declaring `freshnessChecks[].regenerateCommand` (audit for allowlist compliance)
- **Scope (Out-of-Scope Files):** kernel backend files, provider-bridge files
- **Verification Command:** `bun run check`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if any existing authority-packet `regenerateCommand` cannot be expressed as an argv array against the allowlisted command-prefix set (`bun`, `bunx`, `cargo`, `buf`, and other native CLIs this repo already treats as ecosystem truth) — surface the non-conforming command instead of widening the allowlist or falling back to `shell: true`.
- **Description:** `runRegenerateCommand` currently executes manifest-owned `regenerateCommand` strings via `spawn(command, { shell: true })`, validated only for non-emptiness, inside `bun run check`/`verify` on every contributor machine and in CI. A pull request editing a checked-in JSON manifest field can execute arbitrary shell with metacharacter interpretation. Replace shell-string execution with argv-array execution (parsing the manifest command into a program plus arguments, no shell interpretation) restricted to an allowlisted command-prefix set, preserving every legitimate multi-word regenerate command already declared in the repo's authority packets.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Guardrail regenerate-command hardening

  Scenario: Regenerate commands execute without shell interpretation
    Given an authority packet declares a "regenerateCommand" such as "bun run codegen:kernel"
    When the guardrail gate runs that freshness check
    Then the command executes via argv-array spawn with no shell involved
    And shell metacharacters in an untrusted string have no special effect

  Scenario: Allowlist rejects unrecognized command prefixes
    Given a manifest "regenerateCommand" whose program is not in the allowlisted prefix set
    When the guardrail gate attempts to run it
    Then the gate fails loud with an explicit allowlist-violation error
    And it does not fall back to shell execution

  Scenario: Every existing authority-packet regenerateCommand still runs
    Given every "regenerateCommand" declared across "spec/**/authority-packet.json" today
    When "bun run check" runs the guardrail gate
    Then each command executes successfully under argv-array execution
    And none require shell-only syntax to function
```

#### KRT-BK006 Kernel Input Hardening: LIMIT Guard + Interop Resource Caps
- **Type:** Security
- **Effort:** 2
- **Dependencies:** None
- **Category:** Security
- **Capability / Contract Mapping:** Audit finding [B-03] — unguarded SQL interpolation and unbounded gRPC seam resources
- **Scope (In-Scope Files):**
  - `typescript/kernel/backends/sqlite/src/lib/sqlite-repositories-support.ts` (lines ~456-459)
  - `rust/kernel-grpc-service/src/lib.rs` (`serve_kernel_grpc`, lines ~76-115; `node_walk_back`, lines ~287-326)
- **Scope (Out-of-Scope Files):** `spec/interop/proto/tuvren/kernel/interop/v1/` (no proto/schema change), other sqlite repository files not touching `LIMIT`
- **Verification Command:** `bun run verify:kernel`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if adding decode-size/timeout/concurrency caps changes any existing interop-smoke pass/fail outcome — recheck the chosen ceiling values instead of forcing the suite green.
- **Description:** (a) `sqlite-repositories-support.ts` interpolates `` `LIMIT ${fetchLimit}` `` directly into a SQL string with no runtime numeric guard anywhere upstream in the call chain; add a `Number.isSafeInteger` (non-negative) runtime guard and switch to a parameterized `LIMIT ?` clause. (b) `rust/kernel-grpc-service`'s `serve_kernel_grpc` registers the full kernel gRPC surface with no message-decode-size ceiling, no per-RPC timeout, and no concurrency limit, and `node_walk_back` has no recursion/iteration depth cap; add `.max_decoding_message_size`, `.timeout`, and `.concurrency_limit_per_connection` to the `Server::builder()` chain and a depth cap to `node_walk_back`, documenting the loopback-only default this seam relies on today. No proto or wire-format change.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Kernel input hardening

  Scenario: SQLite LIMIT clause rejects unsafe values
    Given a caller supplies a non-safe-integer or negative value as a list-options limit
    When the sqlite repository builds its query
    Then the query construction fails loud before reaching SQL
    And a safe-integer limit is parameterized rather than string-interpolated

  Scenario: gRPC service enforces a message-decode-size ceiling
    Given a client sends a request exceeding the configured max decode size
    When the request reaches the kernel gRPC service
    Then the server rejects it with a resource-exhausted error
    And it does not attempt to decode the full oversized payload

  Scenario: gRPC service enforces a per-RPC timeout and connection concurrency limit
    Given a client opens more concurrent requests than the configured per-connection limit
    When those requests are issued against the kernel gRPC service
    Then requests beyond the limit are bounded or rejected per the configured policy
    And a long-running RPC beyond the configured timeout is terminated

  Scenario: node_walk_back has a depth cap
    Given a pathologically deep turn-node lineage
    When "node_walk_back" traverses it
    Then traversal stops at the documented depth cap
    And returns a bounded result or an explicit depth-exceeded error
```

#### KRT-BK007 Persistence-Model Benchmark Spike
- **Type:** Spike
- **Effort:** 3
- **Dependencies:** None
- **Category:** Perf
- **Capability / Contract Mapping:** Audit finding [C-01]; TechSpec changelog v0.32.0 (persistence-model decision explicitly deferred as evidence-gated)
- **Scope (In-Scope Files):**
  - `typescript/kernel/backends/postgres/src/lib/postgres-backend-persistence.ts` (read-only measurement target, lines ~266-333)
  - `typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts` (read-only measurement target, `health()` line ~283, `reclaim()` line ~405)
  - `.constitution/spikes/SPK-BK007.md` (placeholder already created at planning time per the Spike protocol; this ticket fills in its baseline, benchmark data, and recommendation sections)
- **Scope (Out-of-Scope Files):** No production source changes anywhere; do not modify `postgres-backend-persistence.ts` or `sqlite-backend.ts` themselves
- **Verification Command:** `bun run verify:kernel`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP and do not write any production code under this ticket — it is measurement-only. STOP if a representative benchmark cannot be constructed without touching production source; escalate instead of adding instrumentation to the measured files.
- **Description:** Measure write latency as a function of scope size for the postgres whole-blob-per-write persistence model, and measure the cost of sqlite's full-database loads inside `health()` and `reclaim()` (the latter loads the database twice). Complete `.constitution/spikes/SPK-BK007.md` following the existing spike-report format, recommending either accept-with-documented-bounds or a path-granular/row-per-record persistence redesign, to feed a future ADR alongside the existing ADR-006/048/049/050/051 set that currently does not address this trade-off. No production code changes are in scope for this ticket.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Persistence-model benchmark spike

  Scenario: The spike report exists and names a recommendation
    Given the spike work is complete
    When I read ".constitution/spikes/SPK-BK007.md"
    Then it contains measured write-latency-vs-scope-size data for the postgres backend
    And it contains measured load-cost data for sqlite "health()" and "reclaim()"
    And it explicitly names a recommendation: accept-with-bounds or path-granular persistence

  Scenario: No production code changed
    Given the spike is complete
    When I diff the working tree against the epic's starting commit
    Then "postgres-backend-persistence.ts" and "sqlite-backend.ts" are unchanged
    And no other production source file under "typescript/kernel/backends/" changed
```

#### KRT-BK008 TurnTree Caller-Side Chunk-Aware Writes (ADR-011)
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** None
- **Category:** Perf
- **Capability / Contract Mapping:** `kernel.protocol` TurnTree storage — ADR-011 (TurnTree storage is path-granular with threshold-based chunking)
- **Scope (In-Scope Files):**
  - `typescript/kernel/runtime/src/lib/runtime-kernel-storage.ts` (`toStoredTurnTreePath`, lines 112-136)
  - `typescript/kernel/backends/memory/src/lib/memory-backend-turn-tree.ts` (`normalizeStoredTurnTreePath` and chunk-normalize logic, lines ~104-177)
- **Scope (Out-of-Scope Files):** sqlite and postgres backend turn-tree storage (already backend-agnostic consumers of the same `StoredTurnTreePath` shape; verify but do not restructure unless a chunk-shape mismatch surfaces)
- **Verification Command:** `bun run verify:kernel`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if backends do not uniformly accept caller-submitted chunked records/deltas across memory, sqlite, and postgres — the audit verified this only for the memory backend's normalize logic; confirm sqlite/postgres parity before shipping caller-side chunking, or scope this ticket to memory-backend-verified paths only and file a follow-up for the others.
- **Description:** `toStoredTurnTreePath` always resubmits the full flat items array with `orderedEncoding: "flat"`, regardless of collection size, so once an ordered TurnTree path crosses the ADR-011 chunking threshold, every subsequent append re-chunks and re-hashes the entire collection at the caller — O(collection size) CPU per append even though content-addressing already dedupes the storage. Teach the runtime caller to submit already-chunked records or deltas once the threshold is crossed, matching the chunk-aware shape (`orderedEncoding: "chunked"`, `chunkHashes`) that backends already accept per the existing normalize logic, so appends past the threshold cost work proportional to the delta, not the whole collection.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Chunk-aware TurnTree caller writes

  Scenario: Appends past the chunking threshold do not re-hash the full collection
    Given an ordered TurnTree path already past the ADR-011 chunking threshold
    When the runtime appends one additional item to that path
    Then the caller submits a chunked delta rather than the full flat items array
    And the CPU cost of the append is proportional to the new chunk, not the full collection

  Scenario: Collections below the threshold are unaffected
    Given an ordered TurnTree path below the ADR-011 chunking threshold
    When the runtime writes to that path
    Then the caller continues to submit the flat encoding exactly as before

  Scenario: Existing chunked-path conformance is preserved
    Given the existing kernel protocol conformance suite covering TurnTree chunking
    When "bun run verify:kernel" runs after this change
    Then every previously-passing chunking and hashing check still passes
```

#### KRT-BK009 SQLite Rollback-Path Error Normalization Fix
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** None
- **Category:** Correctness
- **Capability / Contract Mapping:** Audit finding [E-02] — sqlite rollback-path double normalization
- **Scope (In-Scope Files):**
  - `typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts` (`transact`, lines ~337-408)
  - `typescript/kernel/backends/sqlite/test/` (new or existing test file asserting rollback error shape)
- **Scope (Out-of-Scope Files):** `health()` and `reclaim()` (KRT-BK007 concern), memory/postgres backends
- **Verification Command:** `bun run nx run kernel-backend-sqlite:test`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if collapsing the double normalization changes the observable error shape (message, code, or cause chain) that any existing consumer or conformance check currently asserts against — reconcile the assertion or the fix, do not ship a silent shape change.
- **Description:** `SqliteBackend.transact` has a nested try/catch structure where an inner catch block normalizes a thrown error and rethrows, and an outer catch block normalizes that already-normalized error again, double-wrapping errors on the rollback path. Collapse this into a single normalization point so an error thrown during a transaction is normalized exactly once regardless of which catch block ultimately handles the rollback, and add a test asserting the resulting error shape (no double-wrapping, correct `cause`/message/code).
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: SQLite rollback error normalization

  Scenario: A transaction error is normalized exactly once
    Given a sqlite transaction whose work function throws during execution
    When "transact" handles the rollback
    Then the resulting error has been normalized exactly once
    And it is not double-wrapped by both the inner and outer catch blocks

  Scenario: Rollback error shape is asserted by a test
    Given the collapsed single-normalization rollback path
    When "bun run nx run kernel-backend-sqlite:test" runs
    Then a test asserts the exact error shape (message, code, cause) produced on rollback
    And that test fails if double-normalization is reintroduced
```

#### KRT-BK010 Promote In-Memory-Expressible Kernel Checks to the Rust Lane
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-BK002
- **Category:** Feature-Evolution
- **Capability / Contract Mapping:** `kernel.scope-isolation`, `kernel.reclamation`, `kernel.run-liveness` (checks expressible against an in-memory backend, selected by capability/surface per this repo's conformance rule, never by language or implementation ID)
- **Scope (In-Scope Files):**
  - `reports/compatibility/compatibility-matrix.json` (target artifact; regenerated, not hand-edited)
  - `spec/conformance/kernel/plans/kernel-reclamation.json`
  - `spec/conformance/interop/rust-kernel/spec/authority-packet.json`
  - `rust/kernel-conformance-adapter/` (or sibling Rust conformance-adapter host, wherever it lives — confirm exact path before editing)
- **Scope (Out-of-Scope Files):** `kernel-restart-af.*` and `kernel-restart-recovery.close_reopen_checkpoint` checks (these presuppose persistence/restart the in-memory Rust kernel cannot express; they stay tied to the named-deferred Rust persistence epic (Epic BN), not this ticket)
- **Verification Command:** `bun run conformance`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if a targeted check is selected by adapter/implementation/language identity rather than by declared capability or surface requirement — re-derive the selection criterion instead of hand-picking checks to make the matrix look better.
- **Description:** The compatibility matrix currently shows `rust-kernel` passing 42 of the 68 checks `typescript-kernel-postgres` runs, entirely omitting the `kernel.reclamation.*`, `kernel.scope-isolation.*`, and `kernel.run-liveness.{clock_skew_preemption, expired_listing, lease_renewal, stale_preemption}` families — precisely the ADR-048–052 surfaces. Promote the subset of these checks that are expressible against an in-memory backend (not dependent on process restart or crash recovery) into the Rust conformance lane, selected by the capability/surface each check declares, consistent with the repo's standing rule that promotion is never keyed to language or implementation identity. Checks requiring restart/crash-recovery remain excluded and explicitly deferred to the Rust persistence epic (Epic BN).
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Rust kernel conformance promotion

  Scenario: In-memory-expressible reclamation and scope-isolation checks run against rust-kernel
    Given the reclamation and scope-isolation checks that do not require process restart or crash recovery
    When "bun run conformance" runs against the rust-kernel implementation
    Then those checks execute and report a pass/fail outcome for rust-kernel
    And they were selected by declared capability, not by implementation ID or language

  Scenario: Restart/crash-recovery checks remain excluded
    Given the "kernel-restart-af.*" and "kernel-restart-recovery.close_reopen_checkpoint" checks
    When the promoted check set is computed
    Then those checks are not included in the rust-kernel lane
    And the compatibility matrix documents them as deferred to the Rust persistence epic

  Scenario: The compatibility matrix reflects the expanded coverage
    Given the promoted checks now run against rust-kernel
    When "reports/compatibility/compatibility-matrix.json" is regenerated
    Then rust-kernel's passedChecks/totalChecks ratio increases to reflect the promotion
    And no previously-passing rust-kernel check regresses
```

#### KRT-BK011 Backend-Specific Storage Test Uplift
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-BK001
- **Category:** Correctness
- **Capability / Contract Mapping:** Audit finding [E-03] — backend test-density gap (postgres 0.27, sqlite 0.25 test:src ratios)
- **Scope (In-Scope Files):**
  - `typescript/kernel/backends/sqlite/test/` (new backend-specific test files: SQL edge cases, WAL/locking, pool/connection behavior)
  - `typescript/kernel/backends/postgres/test/` (new backend-specific test files: connection-pool exhaustion under `max: 1`, `FOR UPDATE` contention behavior)
- **Scope (Out-of-Scope Files):** shared testkit packages (`typescript/kernel/testkit/`) — do not duplicate cross-backend semantics already covered there; this ticket adds backend-*specific* coverage only
- **Verification Command:** `bun run nx run kernel-backend-sqlite:test` and `bun run nx run kernel-backend-postgres:test`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if a proposed new test duplicates behavior already asserted by the shared testkit — redirect that case to the testkit instead of adding a backend-local duplicate.
- **Description:** The audit found postgres at a 0.27 and sqlite at a 0.25 test:src ratio, the thinnest in the repo, with the shared testkit carrying cross-backend semantics but backend-specific behavior (SQL edge cases, WAL/locking under sqlite's single-connection-per-file model, `max: 1` connection-pool and `FOR UPDATE` row-contention behavior under postgres) left thinly covered. Add targeted backend-local tests for this backend-specific behavior without duplicating suites the shared testkit already exercises against all backends uniformly.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Backend-specific storage test uplift

  Scenario: SQLite WAL/locking behavior is covered by a backend-local test
    Given two concurrent connections attempt writes against the same sqlite scope file
    When the backend-local locking test runs
    Then it asserts the observed serialization/locking behavior specific to sqlite's connection model

  Scenario: Postgres connection-pool contention behavior is covered by a backend-local test
    Given multiple concurrent transactions target the same postgres scope under the "max: 1" pool
    When the backend-local pool-contention test runs
    Then it asserts the observed queuing/contention behavior specific to postgres's "FOR UPDATE" row-lock model

  Scenario: New tests do not duplicate shared testkit coverage
    Given the shared testkit's existing cross-backend semantic suites
    When the new backend-local tests are reviewed
    Then none of them re-assert a scenario the shared testkit already covers identically across backends
```
