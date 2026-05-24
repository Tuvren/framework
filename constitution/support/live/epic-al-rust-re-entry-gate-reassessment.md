# Epic AL Rust Re-entry Gate Reassessment

This record is the KRT-AL003 output. It restates the staged-gate posture from
ADR-033 and TechSpec §5.4 against fresh evidence produced by the canonical
verification path on the AL closure branch, names the exact evidence each gate
relies on, names the remaining productization blockers the staged gates do not
purport to cover, and states plainly whether Rust framework/product work may
resume.

- Authored under KRT-AL003 as a planning chore. Hand-authored Markdown,
  surface-level. No generator script.
- This document is planning evidence under `constitution/support/live/`. It does
  not extend the live constitutional authority chain. The active authority chain
  is still `constitution/PRD.md`, `constitution/Architecture.md`,
  `constitution/TechSpec.md`, and `constitution/Tasks.md`.
- Evidence cited here is freshly produced by `bun run verify` on the AL closure
  branch (`epic-al-portability-gate-closure`) and supersedes the historical
  AG-era freeze-readiness claim. AG evidence remains valid historical evidence
  for the promoted subset but is no longer the governing readiness contract.

## 1. Staged-gate definitions under reassessment

Per ADR-033 and `§5.4`, three gates govern whether the TypeScript line is
productized enough and whether a non-TypeScript framework/product implementation
line may resume:

| Gate | Definition | Canonical lane |
| --- | --- | --- |
| `product proof gate` | The high-level SDK plus serious REPL proving host prove the documented runtime surface end to end through automated scenarios rather than private playground harness evidence. | `proving-host:interop-smoke`, `proving-host:scenario-sqlite`, `proving-host:scenario-postgres` (all wired into `tools/scripts/verify.ts`). |
| `platform gate` | Package naming/topology normalization plus PostgreSQL backend stand at product depth alongside SQLite, with conformance and reload proof in the canonical verification path. | `nx run-many -t test -p backend-postgres,kernel-typescript-postgres-conformance-runner,...`, `proving-host:scenario-postgres`, `boundary-owned conformance suites`. |
| `portability gate` | The intended portable surface is packet/plan/runner-owned under fresh checks instead of implementation-local tests, AG-UI and the AI SDK bridge remain the only standing exceptions, and the canonical verification path enforces those constraints. | `portability:check` (`tools/scripts/portability-gate.ts`), `authority packet validation`, `conformance plan validation`, `adapter protocol validation`, `vocabulary-check verification`, `shared conformance runner meta-conformance`, `machine authority guardrails`, `docs-to-authority freeze gate`, `Epic AF conformance gap plan freshness`, `boundary-owned conformance suites`. |

The gates are evaluated together by `bun run verify`. A single failing step is
sufficient to invalidate the gate it belongs to.

## 2. Evidence inventory under fresh execution

The branch `epic-al-portability-gate-closure` at the parent commit of this
assessment was driven through `bun run verify` end to end. Per-step evidence
locations and binding intent below.

### 2.1 Product proof gate evidence

| Verify step | Underlying target | Evidence artifact | Notes |
| --- | --- | --- | --- |
| `cross-language proving-host interop smoke` | `host-repl:interop-smoke` | `reports/compatibility/evidence/tuvren.framework.kernel-interop-smoke.typescript-framework__rust-kernel.json` | Drives the serious REPL host against the real Rust kernel transport, producing cross-language interop evidence. Equivalent to the lasting `product proof gate` for kernel-interop semantics. |
| `Node-backed proving-host SQLite reload scenario` | `host-repl:scenario-sqlite` | REPL host scenario output (recorded as proving-host scenario success in the verify log). | Exercises durable threads, branching, streaming, approvals, steering, cancellation, orchestration, extensions, structured output, and SQLite-backed reload through the host-facing SDK. |
| `PostgreSQL-backed proving-host reload scenario` | `host-repl:scenario-postgres` | REPL host scenario output against the `devenv`-provisioned PostgreSQL service. | Same scenario surface as the SQLite lane but against PostgreSQL; this is the platform-gate component of the proving-host lane. |

The TypeScript AI SDK bridge-backed provider scenarios remain a TypeScript
product-proof obligation rather than a cross-language portability claim. They
are covered by the proving-host scenario lanes and the
`providers-bridge-ai-sdk` workspace tests.

### 2.2 Platform gate evidence

| Verify step | Underlying target | Evidence artifact | Notes |
| --- | --- | --- | --- |
| `transition-line targeted tests` | `nx run-many -t test -p WORKSPACE_TEST_PROJECTS` (includes `backend-postgres`, `backend-sqlite`, `backend-memory`, `kernel-typescript-conformance-runner`, `framework-typescript-conformance-runner`, `providers-typescript-conformance-runner`) | Project-local test reports plus shared-runner evidence files under `reports/compatibility/evidence/`. | Backend test lanes plus the TypeScript conformance-runner adapters. |
| `boundary-owned conformance suites` | `bun run conformance` → `nx run-many -t conformance -p kernel-typescript-conformance-runner,kernel-typescript-sqlite-conformance-runner,kernel-typescript-postgres-conformance-runner,kernel-rust-conformance-runner,framework-typescript-conformance-runner,framework-rust-conformance-runner,providers-typescript-conformance-runner` | `reports/compatibility/evidence/shared-conformance-runner.typescript-kernel-memory.json`, `shared-conformance-runner.typescript-kernel-sqlite.json`, plus the TypeScript PostgreSQL kernel runner evidence emitted under the same root, `shared-conformance-runner.typescript-framework.json`, `shared-conformance-runner.typescript-providers.json`, `shared-conformance-runner.rust-kernel.json`, `shared-conformance-runner.rust-framework.json`. | PostgreSQL kernel conformance runs through the shared runner alongside memory and SQLite, treated as a first-class backend rather than a best-effort optional backend. |
| `PostgreSQL-backed proving-host reload scenario` | See §2.1. | See §2.1. | The PostgreSQL backend platform-gate evidence overlaps with the proving-host lane because the platform-gate requirement is that PostgreSQL is reachable end-to-end through the host SDK. |
| `Rust workspace tests` and `Rust Nx target tests` | `cargo test --workspace` plus `nx run-many -t test -p framework-rust-conformance-runner,kernel-rust-kernel,kernel-rust-grpc-service` | Rust crate test reports. | The Rust kernel and Rust framework adapters remain capability-scoped to the surfaces they currently advertise; this lane confirms the Rust kernel transport keeps passing the kernel interop surface but does not promote a Rust framework product line. |

### 2.3 Portability gate evidence

| Verify step | Underlying target | Evidence | Notes |
| --- | --- | --- | --- |
| `Epic AL portability gate` | `bun run portability:check` → `tools/scripts/portability-gate.ts` | Nine expected packets enforced after Epic AS (`shared-core`, kernel-protocol, kernel-interop-grpc, framework-event-stream-sse, framework-react-driver, framework-interop-rust-kernel, providers-provider-api, providers-mcp, telemetry-semconv) plus two standing exceptions (AG-UI projection, AI SDK bridge), and eleven required authoritative sources (kernel CDDL, consolidated core TypeSpec, SSE TypeSpec, SSE fixtures, SSE conformance plan, MCP conformance plan, kernel interop services proto, kernel interop types proto, framework rust-kernel interop suite manifest, framework rust-kernel interop suite schema, telemetry semconv YAML). | Replaces the AF gap plan freshness check as the canonical portability proxy. |
| `authority packet validation` | `tools/scripts/authority-packet/validate-authority-packets.ts` | Nine packets validate against `tools/schemas/authority-packet.schema.json`; the `telemetry` boundary added in AL002 is enforced; every packet has an executable verification path (`schema-validation`, `openapi-validation`, `conformance-plan`, `interop-smoke`, or `vocabulary-check`). | The §4.11 manifest contract now reads as enforced rather than aspirational. |
| `conformance plan validation` | `tools/conformance/plan-compiler/validate-plans.ts` | Nineteen conformance plans validated against `tools/conformance/plan-compiler/conformance-plan.schema.json`, including `tool-contracts-extended.json` (now referenced through the consolidated core packet) and `event-stream-sse.json`. | ADR-030 decisive-assertion guarantee remains intact: `evidenceField` cannot be the only decisive assertion. |
| `adapter protocol validation` | `tools/conformance/adapter-protocol/validate-adapter-protocol.ts` | Implementation adapter JSON-RPC manifests including the AL002 update that wires the framework adapters to the tool-contracts surface now carried by the consolidated core packet. | §4.13 contract intact. |
| `shared conformance runner meta-conformance` | `tools/conformance/meta-conformance/run.ts` | Meta-conformance runs the shared assertion-evaluator against curated golden traces — twenty-one plans plus one thousand scripted golden cases. | Guards the runner against assertion-evaluator regressions that would otherwise mask conformance drift. |
| `vocabulary-check verification` | `tools/conformance/vocabulary/validate-vocabulary.ts` | The telemetry semconv attribute identifiers in the resolved `otel-attributes.json` match the source IDs in `telemetry/semconv/tuvren-runtime.yaml`. | New AL002 runner. The `vocabulary-check` verification path kind is now genuinely runnable, not just declared. |
| `machine authority guardrails` | `tools/scripts/authority-guardrails/authority-guardrails.ts` | Plan self-certification rule, plan-evidence oracle shape rule, runner oracle literal rule, forbidden-vocabulary rule, forbidden-authority-evidence rule, and freshness-drift rule all pass. Freshness drift now groups checks by regenerate command so multi-artifact regenerators (telemetry codegen, kernel-interop codegen) cannot mask drift on artifacts past the first. | Counter-cheating guardrail intact. |
| `docs-to-authority freeze gate` | `tools/scripts/docs-authority-freeze-gate.ts --check` | Two hundred thirty-three normative claims in `docs/KrakenKernelSpecification.md` plus `docs/KrakenFrameworkSpecification.md` mapped to packet/plan/runner evidence. | Continues to anchor the documentation-to-authority bridge from Epic AD. |
| `Epic AF conformance gap plan freshness` | `tools/scripts/epic-af-conformance-gap-plan.ts --check` | Surface-by-surface AF promotion record stays in sync with the on-disk plan files (after the AL002 tool-check relocation under `tool-contracts-af.*` prefix). | Confirms the AF closure was not invalidated by AL002's plan reshuffle. |
| `boundary-owned conformance suites` | `bun run conformance` | See §2.2; the shared runner emits assertion-evaluated evidence rather than implementation-self-reported summaries. | The portability gate consumes runner-observed evidence, not adapter-self-attestation. |

### 2.4 Verification summary citation

`.claude-tmp/al003-verify.log` (not checked in; transient) is the per-step log
captured during AL003 evidence collection. The summary at the end of that log
records the per-step pass/fail and durations for the gate-bearing steps above
and is the literal artifact this assessment depends on.

## 3. Standing exceptions confirmed unchanged

The standing exceptions from ADR-033 and Tasks.md remain narrowly scoped to two
named TypeScript implementation surfaces and are enforced by the portability
gate:

| Surface | Implementation root | Why it is implementation-specific | Enforcement |
| --- | --- | --- | --- |
| AG-UI projection (`@tuvren/stream-agui`) | `boundaries/framework/implementations/typescript/stream-agui` | AG-UI is a host UI integration projection of the canonical event stream; cross-language AG-UI projection is not part of the active portable surface. | `tools/scripts/portability-gate.ts` `STANDING_EXCEPTION_SURFACES[0]` forbids `ag-ui`, `stream-agui`, or `event-stream-agui` from becoming a portable packet surface. |
| TypeScript AI SDK bridge (`@tuvren/provider-bridge-ai-sdk`) | `boundaries/providers/implementations/typescript/bridge-ai-sdk` | The neutral provider contract (`tuvren.providers.provider-api`) is portable; the TypeScript-only AI SDK adapter is a binding projection of that contract, not a portable surface on its own. | `STANDING_EXCEPTION_SURFACES[1]` forbids `bridge-ai-sdk`, `ai-sdk-bridge`, or `provider-bridge-ai-sdk` from becoming a portable packet surface. |

Neither exception inflated during AL002. The portability gate refuses to start
if either surface accidentally acquires a top-level packet, and refuses to
finish if either surface is silently removed from the exception list.

## 4. Remaining productization items the staged gates do not cover

The staged gates pass and Rust framework/product work may resume through a
new epic that explicitly reopens that scope. The following items are recorded
explicitly so the next planning step does not mistake them for either passed
gates or for blockers of the existing staged gates:

- **§8.E5 SSE adapter capability** — The TypeScript framework conformance adapter
  now declares `framework.event-stream-sse` and implements
  `event-stream-sse.decode-trace` plus
  `event-stream-sse.report-wire-compliance`, so the nineteen SSE plan checks run
  as applicable evidence on the TypeScript framework lane. The Rust framework
  adapter still declares no capabilities and remains outside the reopened product
  scope until a future epic resumes Rust framework/product work. This does not
  change the portability gate's pass verdict because the surface, packet, plan,
  fixtures, runner, and TypeScript adapter wiring are in place for the active
  product line.
- **§8.E6 tool-argument streaming completeness assertion** — AL002 promoted
  the tool-contract binding section and plan under the consolidated core packet,
  but did not add a decisive assertion over concatenated `ToolCallArgsDelta`
  payloads. The portable surface for tool argument streaming is owned by the
  canonical event stream rather than by tool-contracts proper; a future ticket may
  add a `resultField` assertion in `runtime-api-callables-extended` or expose
  `$.events` in a way that allows a decisive completeness check.
- **§8.E1, E2, E7, E9, E11 future productization items** — Recorded in
  `constitution/support/live/epic-al-portable-surface-conformance-gap-inventory.md`
  §8 as expert-grade observations. None are gate-blocking under ADR-033 and
  none belong to AL002's promotion scope.
- **Pre-existing latent lint and typecheck issues from Epic AK** — AL003
  surfaced five post-AK issues during fresh canonical-lane execution and
  fixed them in place so the verify lane is genuinely green rather than
  green-by-stale-cache. The fixes are scoped to: dropping the unused
  `PostgresBackendSnapshot` interface, replacing `TransactionSql<{}>` with
  `TransactionSql<Record<string, never>>` in the PostgreSQL persistence
  helpers, adding the missing `TurnTreeSchema` import in the kernel
  TypeScript conformance adapter host, retrying `assertDevenvPostgresReady`
  on a 30-second budget so the `backend-postgres:test` lane does not race
  the `devenv up -d postgres` detached startup, and applying Biome's safe
  formatting fixes that had drifted on the AK-landed files. They are not
  new portability work; they are integration fixes that prevent the AL003
  reassessment from inheriting silent regressions from Epic AK.
- **Proving-host interop-smoke E2BIG environmental sensitivity (resolved)**
  — Prior to AL003, `tools/scripts/repl-host-interop-smoke.ts` rebuilt
  sixteen workspace packages by chaining `bunx --bun tsup` subprocesses
  inline. On Nix/devenv shells, Bun's accumulated `posix_spawn` state hit
  `E2BIG` at the host-repl tsup invocation, causing the smoke to exit
  without a parseable scenario report and leaving the codegen step unable
  to produce fresh compatibility evidence. AL003 reroutes the smoke's
  pre-build to `bun run nx run host-repl:build --skipNxCache`, letting Nx
  orchestrate the workspace build graph (including the implicit
  `kernel-interop-grpc:codegen` dependency wired from `runtime-core`'s
  project manifest). Nx isolates each per-package tsup invocation inside a
  fresh subprocess and removes the E2BIG sensitivity entirely, so the
  canonical verify lane now produces fresh interop-smoke evidence without
  any environmental workaround.

## 5. Verdict

Under the fresh evidence captured by `bun run verify` on the AL closure branch:

- **`product proof gate`** — **passed**. The serious REPL proving host clears
  cross-language interop, SQLite reload, and PostgreSQL reload through the
  host-facing SDK, with assertion-evaluated runner evidence.
- **`platform gate`** — **passed**. Memory, SQLite, and PostgreSQL all clear
  backend tests, shared-runner kernel conformance, and (for SQLite and
  PostgreSQL) the proving-host reload lane. PostgreSQL is a first-class
  backend in the canonical verification path rather than an optional
  best-effort backend.
- **`portability gate`** — **passed**. Nine packets, twenty-one plans, two
  standing exceptions, and eleven required authoritative sources are enforced
  by `tools/scripts/portability-gate.ts`. The canonical verification path
  consumes this gate as the decisive portability proxy in place of the
  historical `docs:af-gap-plan:check` proxy.

The combined verdict matches ADR-033's reopening condition: Rust framework and
Rust product-line work may resume **only** through a new epic that explicitly
reopens that scope, names the line, preserves the staged gates as prerequisites
under fresh evidence, and adds only the line-specific evidence that goes
beyond those gates. AL003 does not itself reopen Rust framework/product work,
does not assert that the existing Rust kernel and Rust framework-conformance
adapters cover a Rust framework product line, and does not authorize a Rust
provider, Rust driver, Rust backend, Rust host, or additional host protocol.

Per ADR-033 and `§5.4`, the next planning step that reopens Rust framework or
product work is a fresh epic decision. AL003 closes the staged-gate
preconditions; it does not preempt the planning decision that would actually
schedule that work.

## 6. Hand-off

This record, together with the AL001 portable-surface conformance gap inventory
and the AL002 closure status appended to that inventory, is the audit trail for
Epic AL.

- AL001 inventory:
  `constitution/support/live/epic-al-portable-surface-conformance-gap-inventory.md`
  (with §9b KRT-AL002 closure status appended).
- AL003 reassessment: this file.

After AL003 lands, the active critical path in `constitution/Tasks.md` reverts
to "no active forward path: Rust framework/product, additional host protocols,
additional driver families, and broader provider-family expansion all require
a new epic that explicitly reopens that scope under the staged gates that AL
just satisfied."
