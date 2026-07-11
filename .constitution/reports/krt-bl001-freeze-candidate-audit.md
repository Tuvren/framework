# KRT-BL001 — Public-Surface Freeze-Candidate Audit (2026-07-11)

**Ticket:** KRT-BL001 (Epic BL — SDK Freeze and Registry Publication).
**Authority:** PRD CAP-P0-070; ADR-054 as amended by ADR-056/ADR-057, with ADR-058 folded in pre-freeze.
**Audited commit:** `f64251ff` (master after Epic BJ #90 and Epic BK #91), on branch `feat/epic-bl-sdk-freeze-registry-publication`.
**Verdict:** the ADR-057-amended stable-core surface is **freeze-ready**. All STOP conditions were checked and none tripped. The surface enumerated in §3 is the freeze candidate KRT-BL002 snapshots.

---

## 1. Prerequisite gates (STOP-condition checks)

| Check | Result | Evidence |
| --- | --- | --- |
| KRT-BJ003 host-import-contract boundary gate exists as an automated gate | PASS | `tools/scripts/host-boundary-gate.ts`; wired into `verify` (`tools/scripts/verify.ts:208`, id "ADR-057 host import boundary gate") and into `check` (`tools/scripts/check.ts`, `INNER_LOOP_AUTHORITY_GATE_IDS`); root script `host-boundary:check` |
| No `Kraken*` type reachable from `@tuvren/core` (root or subpath) or `@tuvren/sdk` root | PASS | TypeScript-compiler-API enumeration of all 14 entrypoints (§3): 0 `Kraken`-containing export names. `isKrakenToolSchema`/`isKrakenJsonObject` exist only in internal `typescript/core/src/lib/runtime-contract-predicates.ts` / `runtime-contract-guards.ts` and are not re-exported by any barrel |
| No Durable-Read or `ExecutionHandle`/`awaitResult` signature requires a caller-supplied scope parameter (ADR-048) | PASS | `TuvrenRuntime` read methods (`getThread`, `getTurnHistory`, `getTurnState`, `listBranches`, `listThreads`, `readBranchMessages`) and `ExecutionHandle.awaitResult()` / `OrchestrationHandle.awaitResult()` in `typescript/core/src/lib/runtime-contract-shapes.ts:1195–1386` — zero `scope` parameters anywhere on the public read surface |

## 2. Audit findings against the ticket's acceptance criteria

1. **Zero `Kraken*` leaks re-confirmed.** The 2026-07-04 finding still holds post-BJ/BK: 400 export names enumerated across `@tuvren/core` root, its 12 subpaths, and `@tuvren/sdk` root; none contains `Kraken`. The internal Durable-Read implementation functions in `typescript/runtime/src/lib/durable-reads.ts` accept a `KrakenKernel` first parameter, but they are engine internals (`@tuvren/runtime` is excluded from the audited surface per ADR-057 item 5) and are not re-exported from `@tuvren/sdk`.
2. **No read signature demands a `scope` argument.** Scope binding is construction-time only (ADR-048); confirmed on every `TuvrenRuntime` read method and both `awaitResult` overloads.
3. **ADR-058 funnel-routing seam present on `CreateTuvrenOptions`.** `typescript/sdk/src/lib/create-tuvren.ts:113` declares `telemetry?: TelemetryRouting`, where `TelemetryRouting = TelemetryDestination | TelemetryRoute | TuvrenTelemetrySink` and `TelemetryRoute = { destination?; sink? }` (`typescript/core/src/telemetry/telemetry-destination.ts:124–136`) — exactly the ADR-058 union (`TuvrenTelemetrySink | TelemetryDestination | { sink?; destination? }`). A guard rejects supplying `telemetry` at both top level and `runtimeOptions` (`create-tuvren.ts:131–136`).
4. **`@tuvren/core` peer-dependency classification (BJ008 hand-off item).** `@tuvren/sdk` classifies `@tuvren/core` as a **peerDependency** (`workspace:*`), alongside optional-peer `zod`/`@standard-schema/spec`; every published leaf package that depends on `@tuvren/core` (`backend-memory`, `backend-sqlite`, `backend-postgres`, `backend-shared`, `kernel-grpc-client`, `runner-react`, `provider-bridge-ai-sdk`, `stream-core`, `stream-sse`, `stream-agui`, `mcp-client`, `telemetry-otel`) classifies it as a peerDependency — none regular-depends or bundles it. The one remaining non-private manifest, `@tuvren/telemetry-semconv`, has no dependencies of any class (it is a generated constants registry), so ADR-037's single-instance guarantee is preserved across the entire published set. All ranges are currently `workspace:*`; converting them to the ADR-037 **tilde** range is a publish-time obligation on KRT-BL003 (the workspace protocol's default materialization is exact/caret depending on tooling — the publish lane must enforce tilde).
5. **Experimental exclusion is mechanically expressible.** All 22 exports of `@tuvren/core/capabilities` carry individual `/** @experimental */` TSDoc tags on the barrel re-export statements (KRT-BJ006), recorded in `spec/core/authority-packet.json` (marker declaration). Constraint for KRT-BL002 (from the BJ006 review hand-off): the tags live on the **barrel statements**, not the canonical declarations in `capability-shapes.ts` — the gate must read tags from the barrel (source or emitted `.d.ts`, where tsc 6.0.2 preserves them verbatim), not from canonical declarations as api-extractor does.
6. **`@tuvren/telemetry-semconv` stable-core membership (BJ hand-off item): RETRACTED.** The confirm-or-retract question routed to this audit by the BJ review (`.constitution/tasks/completed/EPIC-BJ-publishing-infrastructure.md`, KRT-BJ007 notes; `.constitution/tasks/critical-path.md`) is resolved as **retract from the semver-guaranteed stable core**. Evidence: its only consumers are `@tuvren/runtime` (internal engine, published-but-internal per ADR-057 item 5) and `@tuvren/repl-host` (private) — no host-facing published package depends on it, and the ADR-054/057 stable-core enumeration never names it. It is reclassified into the published-internal tier alongside `@tuvren/runtime`: it must still be registry-published (the published-internal `@tuvren/runtime` regular-depends on it, so registry resolution requires it) but is not semver-guaranteed, is never advertised as host-installable, and its manifest description/README must state the internal posture (KRT-BL003/BL004 action). Retracting pre-freeze is free; re-admitting it to the stable core later is additive (semver-minor), whereas retracting after the freeze would have been a breaking change.

## 3. The freeze candidate (surface KRT-BL002 snapshots)

Snapshot targets per ADR-057: `@tuvren/core` (root + subpaths) and `@tuvren/sdk` (root) only. `@tuvren/runtime` is never snapshotted. Export counts from the compiler-API enumeration at the audited commit:

| Entrypoint | Exports | Stability |
| --- | --- | --- |
| `@tuvren/core` (root) | 26 | stable |
| `@tuvren/core/errors` | 17 | stable |
| `@tuvren/core/messages` | 18 | stable |
| `@tuvren/core/events` | 32 | stable |
| `@tuvren/core/execution` | 56 | stable |
| `@tuvren/core/tools` | 31 | stable |
| `@tuvren/core/runner` | 17 | stable |
| `@tuvren/core/provider` | 13 | stable |
| `@tuvren/core/extensions` | 16 | stable |
| `@tuvren/core/telemetry` | 15 | stable |
| `@tuvren/core/capabilities` | 22 | **wholly experimental** (ADR-056 consistency floor applies) |
| `@tuvren/core/lifecycle` | 9 | stable |
| `@tuvren/core/security` | 12 | stable (net-new via KRT-BK004 — see §5.2) |
| `@tuvren/sdk` (root) | 116 | stable |

The Durable-Read Surface and `ExecutionHandle`/`awaitResult` surface are covered by `@tuvren/core/execution` (contract types) and `@tuvren/sdk` (re-exports); the published leaf packages are semver-guaranteed per ADR-054 but not snapshot targets.

`@tuvren/sdk` additionally exposes an `./advanced` subpath (ADR-059 escape hatch); it and the leaf packages are outside the KRT-BL002 snapshot per the ticket's scope.

## 4. Predecessor-epic delivery verification (user-requested pre-publish review)

Two independent static verification sweeps checked that Epics BJ and BK were executed as their tickets claim, before anything is frozen or published.

### 4.1 Epic BJ (Publishing Infrastructure) — all 8 tickets VERIFIED
- BJ001: composition-tier migration landed; no sdk⇄runtime cycle (runtime no longer peer-deps sdk; sdk regular-deps runtime).
- BJ002: `typescript/host/repl` has zero `@tuvren/runtime` import statements (only string-literal transcript payloads) and depends on `@tuvren/sdk`.
- BJ003: boundary gate uses real TS AST parsing, forbids `@tuvren/runtime`/`@tuvren/kernel-protocol`/`@tuvren/kernel-runtime`, wired into `check` and `verify`. Sanctioned narrowing: the gate covers `typescript/host/**` only, not documentation code examples; one known doc drift remains (`spec/host/client-endpoint-integration.md:129` shows a forbidden `@tuvren/runtime` import example) — follow-up noted for KRT-BL004's doc pass.
- BJ004/BJ005: ADR-058 destination contract, failure isolation (`safeDeliver`/`signalTelemetryFailure`), and the three funnel-isolation conformance checks all present.
- BJ006: 22/22 `@experimental` tags + subpath notice + authority-packet marker declaration.
- BJ007: 14 publishable manifests carry `files`/`license`/`description`/`repository`; internal packages stay private.
- BJ008: changeset scaffolding with fixed `["@tuvren/*"]` lockstep group; release lane never publishes.

### 4.2 Epic BK (Kernel Substrate Hardening) — all 11 tickets VERIFIED
High-rigor pass on the BL-gating tickets: BK002 (leaseless-run expiry: predicate, horizon exclusion, lineage retention, authority + conformance-plan encoding), BK004 (ADR-044 seam closure: `screenValueForSecretPatterns` applied in `ai-sdk-provider-bridge-utils.ts:340` before durable/canonical surfaces, structural `secretPatternAbsence` detector derived from the same `SECRET_VALUE_PATTERNS` list), BK006 (SQLite LIMIT guard, 16 MiB gRPC decode ceiling, 30 s RPC timeout, per-connection concurrency cap 64, walk-back depth cap 10 000 — with Rust tests present). Lighter pass on BK001/003/005/007–011: all claimed artifacts exist. Live confirmation at HEAD: `bun run compatibility:check` passes (the mid-epic known-red evidence drift is resolved).

## 5. Publish-blocking hand-offs to KRT-BL003 (documented deferrals, not defects)

1. **Private-package dependency topology.** Publishable packages regular-depend on `private: true` packages, which would break registry install resolution: `@tuvren/sdk` → `@tuvren/runtime`, `@tuvren/kernel-protocol`, `@tuvren/kernel-runtime` (all private); backends → `kernel-protocol`/`kernel-runtime`; `@tuvren/runner-react` and `@tuvren/provider-bridge-ai-sdk` → `@tuvren/provider-api` (private); `@tuvren/kernel-grpc-client` → `kernel-protocol`. ADR-057 item 5 requires `@tuvren/runtime` to be registry-published while documented/marked internal; the same treatment must extend to `kernel-protocol`, `kernel-runtime`, and `provider-api` (publish as internal-marked packages, never advertised host-installable), or the edges must be restructured. KRT-BL003 resolves this.
2. **`@tuvren/core/security` becomes a published contract.** `SECRET_VALUE_PATTERNS` et al. (net-new via KRT-BK004) will be locked in by the freeze; explicitly included in the §3 candidate (12 exports, stable) with this sign-off note.
3. **Tarball completeness.** `files: ["dist"]` ships no LICENSE and (for most packages) no README despite `license: "Apache-2.0"`; KRT-BL003 must add license/readme material to published tarballs.
4. **`.changeset/config.json` `access: "restricted"`** must flip to `"public"` before the first real publish.
5. **Tilde range enforcement.** All `@tuvren/core` peer ranges are `workspace:*` in-tree; the publish lane must materialize the ADR-037 tilde range and fail if it cannot (the BJ008 release-lane validator currently also tolerates caret).
6. **`@tuvren/telemetry-semconv` internal marking.** Per the §2.6 retraction, its manifest description and README must state the published-internal posture (engine dependency of `@tuvren/runtime`, not host-installable, not semver-guaranteed) before the first publish; onboarding docs (KRT-BL004) must not list it among the stable leaf packages.

## 6. Verification

- `bun run check` — exit 0 at the audited commit (all authority gates incl. the ADR-057 host boundary gate pass; affected typecheck/test/lint clean).
- `bun run compatibility:check` — exit 0.
