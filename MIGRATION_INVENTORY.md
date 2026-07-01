# Migration Inventory — Epic #87 (Sovereign Polyglot Framework Restructure)

Tracks GitHub issue [#87](https://github.com/Tuvren/runtime/issues/87), milestone M0 ("Ground rules"). This file is the machine-checkable, 100%-coverage ledger of every contract, driver, runner, hook, script, and implementation touched by the restructure: `old path → new path → status → content hash → notes`. It is deleted at cutover (M10) per issue §12.

Out of scope for this ledger (not part of the physical migration surface): `.constitution/` (a separate, non-frozen governance tree rewritten by M10's own DoD, not relocated by this restructure), `docs/*` (issue §1/§5: "timeless semantic authority" that survives unmoved), and `tests/` (empty root scaffold — `.gitkeep` only, no content to migrate).

## Schema

| Column | Meaning |
|---|---|
| `old_path` | Repo-relative path today. Directory-granularity for uniform boilerplate trees; file/subpath-granularity for anything §12 names explicitly. |
| `new_path` | Destination under `spec/<port>/` or `<lang>/...`, or "no move" for teardown-only/unaffected roots. Where the exact idiomatic subpath is a future milestone's decision (not yet made), this is marked `(idiomatic subpath decided at M<n>)` rather than guessed now — deciding it early would violate the issue's own "vertical, no long red valley" sequencing (§11). |
| `status` | `pending` \| `in-progress` \| `migrated` \| `not-applicable` (no move planned; still enumerated for 100% coverage, never silently omitted, per invariant §10.4 — no deletion without a proven successor). |
| `content_hash` | The **git blob SHA** (files) or **git tree SHA** (directories) via `git rev-parse HEAD:<path>`, captured at this baseline commit — not a separately computed SHA-256. Git already computes this for every path, and it composes directly with the primary move mechanism (`git mv`): a pure rename preserves file blob hashes exactly, so post-move equivalence is a one-line hash comparison instead of a bespoke hashing step. Rows where content is genuinely *transformed* (not moved), e.g. M2's sort of `@tuvren/core` into contract vs. executable tiers, are proven by a documented transformation note instead of expecting hash equality. |
| `notes` | Multi-home/ambiguous cases named in §12, cross-port moves, and any decision rationale. |

All hashes below were captured at the M0 baseline commit on branch `feat/epic-87-sovereign-polyglot-framework` (recorded in the Baseline section appended by M0.2).

## Kernel (→ `spec/kernel/`, `spec/conformance/kernel/`, `spec/interop/`, `rust/kernel`, `typescript/kernel/...`) — M1

| old_path | new_path | status | content_hash | notes |
|---|---|---|---|---|
| `boundaries/kernel/contracts/protocol` (whole port dir, superset — catches `README.md` + `artifacts/README.md`, 17 lines total, not covered by the two subpath rows below) | `spec/kernel/` + `typescript/kernel/...` | pending | `928e71f14ddffae716216aeb7dfba4a21690f7a4` | superset row added after review found the loose READMEs uncovered |
| `boundaries/kernel/contracts/protocol/spec` | `spec/kernel/` | pending | `54c93bf1a6ba68707d10ad8fa9907837037ef18f` | authority-packet.json + CDDL grammar |
| `boundaries/kernel/conformance` | `spec/conformance/kernel/` | pending | `f2f68e8d61b732322e25eea65305038f7b302b97` | fixtures/plans/scenarios/schemas |
| `boundaries/kernel/interop/grpc` | `spec/interop/` | pending | `d4d157701ab00e70308f8cb6a6e368526c5942bc` | IPC transport contract (proto/grammar only); see Multi-home §A for the generated-bindings drift this move must reconcile first |
| `boundaries/kernel/contracts/protocol/implementations/typescript` (`@tuvren/kernel-protocol`) | `typescript/kernel/...` (idiomatic subpath decided at M1) | pending | `93f42db9beea88125e29d9405d6a0022685d84da` | |
| `boundaries/kernel/implementations/typescript/runtime-kernel` (`@tuvren/kernel-runtime`) | `typescript/kernel/...` (idiomatic subpath decided at M1) | pending | `a076dc74ba2c41be0b2c073a173528e2c53cc1e4` | |
| `boundaries/kernel/implementations/typescript/backend-memory` | `typescript/kernel/...` (idiomatic subpath decided at M1) | pending | `1df450bf69a8f0a7731087d516076f865a1d0a70` | storage driver |
| `boundaries/kernel/implementations/typescript/backend-sqlite` | `typescript/kernel/...` (idiomatic subpath decided at M1) | pending | `0379ca0526484840ff47264b46e1d39fbbc70104` | storage driver |
| `boundaries/kernel/implementations/typescript/backend-postgres` | `typescript/kernel/...` (idiomatic subpath decided at M1) | pending | `ef4e50e413bb4fde3494c5b1743a447fd2fc41d8` | storage driver; carries the postgres-hermeticity decision, see Multi-home §B |
| `boundaries/kernel/implementations/typescript/testkit` (`@tuvren/kernel-testkit`) | `typescript/kernel/...` (idiomatic subpath decided at M1) | pending | `58ce3126e96482d157fefa7ba11fbfc2784465b4` | |
| `boundaries/kernel/implementations/typescript/conformance-adapter` | `typescript/kernel/...` (idiomatic subpath decided at M1) | pending | `9dd3199d3f562c649c89ba3c4d99d36de50bca6a` | one of the 8 `conformance-runner`-family dirs, see Multi-home §C |
| `boundaries/kernel/implementations/typescript/conformance-runner` (`@tuvren/kernel-typescript-conformance-runner`) | `typescript/kernel/...` (idiomatic subpath decided at M1) | pending | `c85bf3433068264535d94b2289dbd6ac80a217b7` | project ID in `package.json`'s `conformance` script |
| `boundaries/kernel/implementations/typescript/conformance-runner-sqlite` | `typescript/kernel/...` (idiomatic subpath decided at M1) | pending | `8cf1b1f3326a3a123f8273f5b108b5dc410651c9` | project ID `kernel-typescript-sqlite-conformance-runner` |
| `boundaries/kernel/implementations/typescript/conformance-runner-postgres` | `typescript/kernel/...` (idiomatic subpath decided at M1) | pending | `2501318c103572544df6cbd76fa52f22915cf112` | project ID `kernel-typescript-postgres-conformance-runner`; Nx-driven, transitionally non-hermetic per invariant §10.5, see Multi-home §B |
| `boundaries/kernel/implementations/rust/kernel` (`tuvren-kernel-rust`) | `rust/kernel` | pending | `aaf4f36450aa61283faa58643c2e05dab005bce3` | Cargo workspace member; `path =` dependency reference in root `Cargo.toml` must move with it |
| `boundaries/kernel/implementations/rust/grpc-service` | `rust/kernel/...` (idiomatic subpath decided at M1) | pending | `63aec672d50c68e221d01a692074a72a21fca420` | |
| `boundaries/kernel/implementations/rust/conformance-adapter` | `rust/kernel/...` (idiomatic subpath decided at M1) | pending | `bab725336fdc6cc49f1e3ee1fbf37baad705c09f` | |
| `boundaries/kernel/implementations/rust/conformance-runner` (`kernel-rust-conformance-runner`) | `rust/kernel/...` (idiomatic subpath decided at M1) | pending | `f0b937c3042e2c4168ad30ecd0f3c45cc950bb39` | project ID in `conformance` script |

## Core / ABI (→ `spec/core/` + TypeScript libc/SDK tier) — M2

| old_path | new_path | status | content_hash | notes |
|---|---|---|---|---|
| `boundaries/shared/contracts/core/implementations/typescript/src/errors` | `spec/core/` (contracts) | pending | `1ecc9c117f4b97326aa9a7d9256554fc2cd42b79` | pure types, per M2 DoD |
| `boundaries/shared/contracts/core/implementations/typescript/src/messages` | `spec/core/` (contracts) | pending | `c2c96565913caa0381cc2aa46feb5cc064453241` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/events` | `spec/core/` (contracts) | pending | `d17119b90bf18bf6200db2240c443814c576e5f5` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/execution` | `spec/core/` (contracts) | pending | `a43354c5b61c99956cd412b7bff7c410f8883d4e` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/tools` | `spec/tools/` (M5, pure type-surface only) | pending | `9219414da2ca938c97465a36f33745974b0b7ce5` | re-exports `defineTool` from `src/lib/schema-authoring.ts` — see the `src/lib` row below and Multi-home §D for where the executable helper actually lives |
| `boundaries/shared/contracts/core/implementations/typescript/src/lib` (15 files: `schema-authoring.ts`, `payload-codec.ts`, `tuvren-error.ts`, `scope.ts`, `kernel-records.ts`, driver/runtime contract guards/predicates/shapes, `capability-error-codes.ts`, `capability-shapes.ts`) | split between `spec/core/` (pure predicates/shapes/guards) and TypeScript libc/SDK tier (`schema-authoring.ts`'s `defineTool`, `payload-codec.ts`) | pending | `92e552689bd4674bf58b77f0d69a81e542125c3c` | this is where M2's "sort, don't split" executable-vs-contract decision actually has to happen file-by-file — see Multi-home §D (corrected: the executable helpers live here, not in `src/tools`) |
| `boundaries/shared/contracts/core/implementations/typescript/src/driver` | `spec/runners/` (M6 rename target) | pending | `742ebd2aa77fa05a32d679b901754ad629294d5c` | "driver" here means execution-model per M6's inversion, not resource adapter |
| `boundaries/shared/contracts/core/implementations/typescript/src/provider` | `spec/providers/` (M4) | pending | `7797c38b224b019cd9bc2b2d5a4a63aa748cff31` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/extensions` | `spec/extensions/` (M7) | pending | `bfa11ded81c200febb00a3dd163421c9ac4e024e` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/telemetry` | `spec/telemetry/` (M8) | pending | `9ddf7e69d30873500607115d725cf372b16e3998` | see Multi-home §A for the telemetry 3-home reconciliation |
| `boundaries/shared/contracts/core/implementations/typescript/src/capabilities` | `spec/tools/` (M5) | pending | `16c2dd586ff333fa9c286cc8311ee34b6a3da41a` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/lifecycle` | `spec/core/` (contracts) | pending | `9ebaa250d48b5926750c756076fae071222ad1dc` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/index.ts` (root export) | `spec/core/` + libc/SDK re-export | pending | `6d24e8e9d3d171955b7e1a12a6a75001d99beab2` | |
| `boundaries/shared/contracts/core` (whole port dir: artifacts/spec/README, not just `src/`) | `spec/core/` | pending | `87129aea2a17660eef2b6a5851f68abc1f8c0b3a` | superset of the `src/` subpath rows above |
| `boundaries/shared/contracts/core-types` (`@tuvren/core-types`) | `spec/core/` (sibling package, per §12) | pending | `74cc79ea321f488a45a7af49148ed70bc33f0b09` | named explicitly in §12 as a multi-home case |
| `boundaries/framework/contracts` (whole port-group dir, superset — catches `client-endpoint-integration.md` as a loose sibling file not covered by any per-port row below) | split across `spec/<port>/` per the per-port rows | pending | `3e2341e41b51cd0f983728824b8ac44cfa38edbf` | superset row added after review found the loose contract doc uncovered |
| `boundaries/framework/contracts/client-endpoint-integration.md` (174-line `AttachedClientEndpoint` host-integration contract; imports from `@tuvren/core/capabilities`) | `spec/host/` (M9, TBD exact home given its `capabilities` dependency — may also need a `spec/tools/` cross-reference) | pending | `fe68f71f670608bed8f2a047c951e573ea56be35` | loose sibling of the six per-port contract dirs; not a `tool-contracts` file itself despite the capabilities import |
| `boundaries/framework/contracts/driver-api` (`@tuvren/driver-api`, deprecated shim) | `spec/runners/` (M6) | pending | `a572ed22b6bc1517244113b2bd27e0c40ff1e4d1` | named explicitly in §12; consolidates with `react-driver` at M6 |
| `boundaries/framework/contracts/event-stream` (`@tuvren/event-stream`, deprecated shim) | `spec/streaming/` (M8) | pending | `d612b813a2cef253d31980d5b003e367456ce6f2` | named explicitly in §12 |
| `boundaries/framework/contracts/runtime-api` (`@tuvren/runtime-api`, deprecated shim) | `spec/host/` or engine seam (M3/M9, TBD) | pending | `3fbb820f296bcb222a9b014d8517901b7bed3079` | named explicitly in §12 |
| `boundaries/framework/contracts/tool-contracts` (`@tuvren/tool-contracts`, deprecated shim) | `spec/tools/` (M5) | pending | `3975de9363276f47ddd33f0d76add7e5e32870b3` | named explicitly in §12 |
| `boundaries/framework/implementations/typescript/runtime-core` (`@tuvren/runtime-core`, deprecated shim, `index.ts`-only) | retired, no successor (M3) | pending | `ce06734ccfc533f725319c9b002c97fb39221f72` | named explicitly in §12; retired per M3 DoD — retirement is not a bare deletion because `runtime/` is the proven successor already carrying the real generated content (see Multi-home §A) |

## Framework-wide conformance (cross-port) — split across M2/M5/M6/M8

`boundaries/framework/conformance` (whole tree, 27 git-tracked files: `fixtures/{event-stream-sse-traces,stream-events}.json`; 20 files under `plans/`; `scenarios/{driver-api,event-stream,operational-telemetry,runtime-api}-scenarios.json`; `schemas/fixture-set.schema.json`) — content_hash `d1a5c7141199c0e354d6bbe7bb70e138d966b48d`. This entire tree was omitted from the first draft of this ledger; added after independent review found it unaccounted for. Unlike the kernel/providers conformance trees (each a single directory-level row because they map to one port apiece), framework's conformance spans several future ports and must be broken out by filename prefix so each future milestone knows which plans it owns:

| Plan/fixture/scenario prefix | Destination | Milestone |
|---|---|---|
| `driver-api-*`, `react-driver-*` | `spec/conformance/runners/` | M6 |
| `event-stream-*` (excl. `-sse`), `event-stream-sse*`, `event-stream-sse-traces.json`, `stream-events.json` | `spec/conformance/streaming/` | M8 |
| `runtime-api-*` (batteries-included, callables, callables-extended, lifecycle, lifecycle-extended, orchestration, scenarios) | `spec/conformance/` engine seam | M3 |
| `tool-contracts-extended.json`, `capability-orchestration-integration.json`, `capability-policy.json` | `spec/conformance/tools/` | M5 |
| `framework-operational-telemetry.json`, `invocation-lifecycle-observation.json`, `operational-telemetry-scenarios.json` | `spec/conformance/telemetry/` | M8 |
| `tuvren-client-execution-class.json`, `tuvren-server-execution-class.json` | `spec/conformance/tools/` (execution class is a tools/MCP-boundary concept per M5) | M5 |
| `schemas/fixture-set.schema.json` | `spec/conformance/` (shared schema, no single port owner) | shared |

status: pending for the whole tree; will flip to `migrated` piecemeal as each owning milestone lands, cross-referenced back to this table.

## Engine (Kraken) + libc/SDK — M3

| old_path | new_path | status | content_hash | notes |
|---|---|---|---|---|
| `boundaries/framework/implementations/typescript/runtime` (`@tuvren/runtime`) | `typescript/...` (idiomatic subpath decided at M3) | pending | `cf1315aa96ab28708c33e40581844d6d151ac7c4` | today's concrete engine package; `createTuvren` already lives here, not in `@tuvren/core` |
| `boundaries/framework/implementations/typescript/testkit` (`@tuvren/framework-testkit`) | `typescript/...` (idiomatic subpath decided at M3) | pending | `c5bc9506caab5ec66e7a82a7b95b58bdd59e7f19` | |
| `boundaries/framework/implementations/typescript/conformance-adapter` | `typescript/...` (idiomatic subpath decided at M3) | pending | `8711f534ecb1ce9c3fc345f6ccb6c80400870768` | |
| `boundaries/framework/implementations/typescript/conformance-runner` (`@tuvren/framework-typescript-conformance-runner`) | `typescript/...` (idiomatic subpath decided at M3) | pending | `9857778929297712ff66536dc624ebe87ab29505` | project ID in `conformance` script |
| `boundaries/framework/implementations/typescript/conformance-runner-batteries-included` (project.json only, no package.json) | `typescript/...` (idiomatic subpath decided at M3) | pending | `2a1e66fced18fc486faae910bcdc5f768ea6f224` | project ID `framework-batteries-included-conformance-runner` |
| `boundaries/framework/implementations/rust/conformance-adapter` | `rust/...` (idiomatic subpath decided at M3, note: framework adapter is an explicit not-implemented stub per §6) | pending | `d0de85d4809c012265cccfab3bab8b437081e857` | |
| `boundaries/framework/implementations/rust/conformance-runner` (`framework-rust-conformance-runner`) | `rust/...` (idiomatic subpath decided at M3) | pending | `96c2acaedd470158ee5076890a951fb7a5ea965b` | project ID in `conformance` script; certifies a not-implemented stub today |

## Providers — M4

| old_path | new_path | status | content_hash | notes |
|---|---|---|---|---|
| `boundaries/providers/contracts/provider-api` (`@tuvren/provider-api`) | `spec/providers/` | pending | `1502175d9f7da18ffa8bebeb8a72707030bfd12b` | |
| `boundaries/providers/conformance` | `spec/conformance/providers/` | pending | `8b089e33f3404f6ab901b3cf9f7aaadbea20ea61` | |
| `boundaries/providers/implementations/typescript/bridge-ai-sdk` (`@tuvren/provider-bridge-ai-sdk`) | `typescript/providers/...` (idiomatic subpath decided at M4) | pending | `9d87eb0fea894c991798544a910e39c2444da3b1` | |
| `boundaries/providers/implementations/typescript/testkit` (`@tuvren/provider-testkit`) | `typescript/providers/...` (idiomatic subpath decided at M4) | pending | `2b139f8e52a6746fb6cba4a8e3af3884fcf4f0fc` | |
| `boundaries/providers/implementations/typescript/conformance-adapter` | `typescript/providers/...` (idiomatic subpath decided at M4) | pending | `96d7bc7a36fe50e7116c607c5da04b7ae534db11` | |
| `boundaries/providers/implementations/typescript/conformance-runner` (`@tuvren/providers-typescript-conformance-runner`) | `typescript/providers/...` (idiomatic subpath decided at M4) | pending | `6e44d8472c919f08c6bab485128641a1a707592b` | project ID in `conformance` script |
| `boundaries/providers/contracts/mcp` | `spec/tools/` (**cross-port move**, M5 — not M4) | pending | `a37841418925943402a15e38bf72df781003bf73` | leaves providers for tools per M5 DoD: execution class is decided by who invokes the server, not by the protocol |
| `boundaries/providers/implementations/typescript/mcp-client` (`@tuvren/mcp-client`) | `typescript/tools/...` (**cross-port move**, M5, idiomatic subpath TBD) | pending | `d68469e575b9a8e1eda7d0fb7929c8eb834bfc24` | the MCP bus-driver; stays in the providers implementations tree until M5 physically moves it |

## Tools + capabilities + MCP — M5

Authority sources are the `spec/tools/` destination rows already listed above (`core/src/tools`, `core/src/capabilities`, `framework/contracts/tool-contracts`, `providers/contracts/mcp`, `providers/implementations/typescript/mcp-client`). No standalone tool-driver packages exist today beyond MCP — `drivers/` (see M6 row below) contains only the ReAct runner, so Exa/Slack-style tool drivers (issue §4) are illustrative future adapters, not part of this move.

## Runners (driver→runner rename) — M6

| old_path | new_path | status | content_hash | notes |
|---|---|---|---|---|
| `boundaries/framework/contracts/react-driver` | `spec/runners/` | pending | `7817365fa5fb2819f8da2179339d5be728bad8f9` | consolidates with `driver-api` (see Core/ABI section) into one runner port |
| `boundaries/framework/implementations/typescript/drivers` (contains only `react/`, package `@tuvren/driver-react`) | `typescript/runners/react` (idiomatic subpath decided at M6) | pending | `511dc9d87b3ba3a96b042aa9f79cb8a44477f0e7` | repo-wide `driver→runner` rename lands here (code, docs, glossary, conformance); today's only execution-model adapter |
| `tools/conformance/runner` (the shared conformance engine) | `tools/` (renamed off "runner" terminology to "certification harness"; exact name TBD at M6) | pending | `5ba709cfebcc386d4b9e584cbb5341611ac4db56` | disambiguates from the M6 "runner" = execution-model meaning; per §5, other `tools/*` unchanged, this stays under `tools/`, just renamed |
| 8 `conformance-runner`-family directories (kernel×2, framework×3, providers×1 already tabled above; batteries-included and sqlite/postgres variants) | renamed off "runner" terminology alongside the M6 sweep | pending | — (see individual rows above) | see Multi-home §C: the 8 script IDs in `package.json`'s `conformance` list and the 8 runner-named directories are independent sets that happen to both total 8 today |

## Extensions — M7 (extraction only, no new behavioral coverage)

| old_path | new_path | status | content_hash | notes |
|---|---|---|---|---|
| `boundaries/shared/contracts/core/implementations/typescript/src/extensions` | `spec/extensions/` | pending | (see Core/ABI row above) | type-surface |
| `boundaries/framework/implementations/typescript/runtime/src/lib/extension-runtime.ts` | `typescript/...` (stays alongside engine, port-authored from this + the two rows above) | pending | *(captured at M7 start — file-level hash deferred since M7 hasn't started)* | runtime facade |
| `boundaries/hosts/implementations/typescript/repl/src/lib/proof-extension.ts` | `typescript/host/...` | pending | *(captured at M7 start)* | REPL proof shim |

## Streaming + Telemetry — M8

| old_path | new_path | status | content_hash | notes |
|---|---|---|---|---|
| `boundaries/framework/contracts/event-stream-sse` | `spec/streaming/` | pending | `0fd1f0db303e111f57787800f7f8944c6c71baba` | |
| `boundaries/framework/implementations/typescript/stream-core` (`@tuvren/stream-core`) | `typescript/streaming/...` (idiomatic subpath decided at M8) | pending | `77db7471794a1eb7847df2f7a2bb1622ba01e504` | |
| `boundaries/framework/implementations/typescript/stream-sse` (`@tuvren/stream-sse`) | `typescript/streaming/...` (idiomatic subpath decided at M8) | pending | `fd3ff32ec7d815cef546f44c1c856a6985417c89` | |
| `boundaries/framework/implementations/typescript/stream-agui` (`@tuvren/stream-agui`) | `typescript/streaming/...` (idiomatic subpath decided at M8) | pending | `4c0f26350999ec6b3118c9e3517cefc9d6b0795b` | |
| `boundaries/telemetry/semconv/spec` | `spec/telemetry/` | pending | `377baba85c33e716f97e672aad8b571de3125e3b` | vocabulary authority — home 1 of 3, see Multi-home §A |
| `telemetry/` (top-level: `project.json`, `otel-attributes.json`, `semantic-conventions.md`, `semconv/`) | `spec/telemetry/` (authority parts) + `typescript/telemetry/` (generated sink) | pending | `30476ea556fcca921fe1d8961a74f6ea82c6cb9e` | home 2 of 3; its Nx `outputs` target is the stale one, see Multi-home §A |
| `boundaries/framework/implementations/typescript/telemetry-otel` (`@tuvren/telemetry-otel`) | `typescript/telemetry/...` (idiomatic subpath decided at M8) | pending | `80833c8c02a2e2e5724223cb331429fbed1e6f2d` | home 3 of 3 — the OTel syslog driver |
| `boundaries/framework/interop/rust-kernel` | `spec/conformance/interop/` | pending | `3fbea254571ac42865b147c56a02a766a32fdad8` | this is conformance, not transport — distinct from `spec/interop/` (kernel §M1) |

## Host — M9

| old_path | new_path | status | content_hash | notes |
|---|---|---|---|---|
| `boundaries/hosts` (plural) | `spec/host` (singular port) | pending | *(directory contains only the repl row below — no separate top-level hash needed)* | naming collision flagged in §12: plural boundary vs. singular port |
| `boundaries/hosts/implementations/typescript/repl` (`@tuvren/repl-host`) | `typescript/host/...` (idiomatic subpath decided at M9) | pending | `5763605cf0994eb9abb5676b1c243300630b261a` | reference shell; only first-party host migrated per §9 non-goals |

## Not moved by this restructure (still enumerated for 100% coverage)

| old_path | new_path | status | content_hash | notes |
|---|---|---|---|---|
| `reports/compatibility` | `reports/compatibility` (unchanged) | not-applicable | `df11c28d0a334231bbfdababc3e123149e212c80` | generated evidence tree; explicitly stays top-level per §15, not `spec/` (authority-only). The harness (renamed `tools/conformance/runner`) continues writing into it through M8/M10 |
| `docs/KrakenKernelSpecification.md` | unchanged | not-applicable | `53543f0664d21c9e54188ccc48152596d9351d9e` | timeless semantic authority, survives per §1/§5 |
| `docs/KrakenFrameworkSpecification.md` | unchanged | not-applicable | `d449d2341c14f92e8f2dea9c13844980dc1aefd6` | |
| `docs/KrakenKernelDesignRationale.md` | unchanged | not-applicable | `ea1e8bc12e91a77b53df5adeb6d5aff6821edf22` | |
| `docs/KrakenFrameworkDesignRationale.md` | unchanged | not-applicable | `4b443633146068066de2260504e01d0468c4edfc` | |
| `docs/perf-benchmarks.md` | unchanged | not-applicable | `9ada000a202aac99f34a57440db4d9e2ad67f8b5` | |
| `tests/` | unchanged | not-applicable | `f9c80aba7548da2a5cc9044837fcc0b75fb4b4ab` | empty scaffold (`.gitkeep` only); not an authority home per `CLAUDE.md` |
| `boundaries/` (root, post-teardown) | deleted | pending | — | deletion is the *sum* of every `migrated` row above reaching that state, per invariant §10.4 — never deleted as a bulk action with unmigrated children remaining |
| `MIGRATION_INVENTORY.md` (this file) | deleted at cutover | pending | — | per §12, deleted once M10 completes |

## Multi-home / ambiguous cases (§12 call-outs, verified against current disk state)

### §A — Telemetry's three homes, including a *confirmed* generated-bindings drift

Verified directly (not assumed from the issue text):

- `telemetry/project.json` line 19's Nx `outputs` target names `boundaries/framework/implementations/typescript/runtime-core/src/lib/generated/tuvren-runtime-telemetry.ts`.
- That path **does not exist** — `runtime-core/src/lib/generated/` contains only the gitignored `kernel-interop/` protobuf output (confirmed via `git check-ignore`), not the telemetry file.
- The telemetry file is actually git-tracked (confirmed via `git ls-files`) at `boundaries/framework/implementations/typescript/runtime/src/lib/generated/tuvren-runtime-telemetry.ts` (hash `0a03de0a1108512c990ec44a15771d5f8fe8df86`).
- Kernel-interop generated bindings are confirmed gitignored in **both** `runtime/` and `runtime-core/` copies (`.gitignore` lines 14–15); only the generator config `runtime/tsconfig.kernel-interop.generated.json` is checked in (`runtime-core/tsconfig.kernel-interop.generated.json` does not exist at all, only a build-artifact `.tsbuildinfo`).
- **M1 action** (interop) and **M8 action** (telemetry) must each reconcile config-vs-disk-reality before moving anything, per the issue's own M1 DoD text. This inventory baselines the verified on-disk truth so neither milestone moves the wrong (stale-config) target.

### §B — Postgres hermeticity (kernel backend + conformance runner)

`boundaries/kernel/implementations/typescript/backend-postgres` and `.../conformance-runner-postgres` are devenv-managed and non-idempotent (per `AGENTS.md`/`CLAUDE.md`: `devenv up -d` a second time fails). Default plan (M1.6): keep this lane Nx-driven, outside the hermetic Bazel graph, per invariant §10.5's explicit sanctioned exception. Recorded here rather than silently excluded.

### §C — Two independent "eights"

The `conformance` script in `package.json` lists exactly 8 project IDs; there are exactly 8 `conformance-runner`-family directories tabled above (kernel-TS ×3 incl. sqlite/postgres, kernel-rust ×1, framework-TS ×2 incl. batteries-included, framework-rust ×1, providers-TS ×1). These are **independent sets that currently happen to both total 8** — per issue §14, they need not stay equal, and the M6 "runner"→"certification harness" rename must not assume a 1:1 mapping between them.

### §D — `tools`/`capabilities` split (core → spec vs. libc)

`core/src/tools` (the port's public export surface) mixes pure type surface with a re-export of the executable `defineTool` schema-authoring helper — but the helper's actual implementation, along with `payload-codec.ts` and 13 other files, lives one level down in `core/src/lib` (see the dedicated row in the Core/ABI section above, corrected after review — the first draft of this ledger mistakenly attached this note to `src/tools` instead of `src/lib`). The pure-type portion targets `spec/core/` (or `spec/tools/` once M5 exists); the executable portion (`schema-authoring.ts`, `payload-codec.ts`) targets the TypeScript libc/SDK tier per M2's DoD ("executable helpers... never `spec/core`"). The exact file-level split of `src/lib`'s 15 files (some, like `driver-contract-guards.ts`/`runtime-contract-guards.ts`, look like they could also be executable predicate logic rather than pure types) is an M2 implementation decision, not resolved here — flagged so M2 doesn't treat the whole directory as one indivisible unit.

## Naming-map addenda

None. Every path discovered during this inventory pass matches an existing pattern in issue §15's naming map; no proposed additions to §15 are required as of this baseline.

## Baseline (M0.2)

Captured on branch `feat/epic-87-sovereign-polyglot-framework` at commit `c910a0dfb20083e881211285ffd3f06296a1ab23`, 2026-07-01T07:26:55Z, after `bun run services:up` (devenv-managed Postgres) followed by `bun run verify` (the full phased release gate defined in `tools/scripts/verify.ts`).

**Result: green. Exit code 0.** All 26 phases passed:

| Phase | Result |
|---|---|
| workspace lint | pass (1.8s) |
| Rust workspace formatting | pass (0.8s) |
| docs-to-authority freeze gate | pass (0.2s) |
| Epic AL portability gate | pass (0.2s) |
| Epic AF conformance gap plan freshness | pass (0.1s) |
| authority packet validation | pass (0.4s) |
| conformance plan validation | pass (2.1s) |
| adapter protocol validation | pass (0.4s) |
| shared conformance runner meta-conformance | pass (0.7s) |
| vocabulary-check verification | pass (0.4s) |
| machine authority guardrails | pass (6.3s) |
| Rust workspace lint | pass (2.9s) |
| Rust workspace tests | pass (3.4s) |
| Rust kernel conformance runner | pass (2.1s) |
| Rust kernel gRPC interop smoke | pass (3.8s) |
| telemetry, compatibility, and interop code generation | pass (4.6s) |
| kernel interop governance smoke | pass (3.8s) |
| workspace typecheck | pass (0.7s) |
| transition-line targeted builds | pass (0.9s) |
| transition-line targeted tests | pass (0.8s) |
| boundary-owned conformance suites (all 8 `conformance` project IDs) | pass (2.1s) |
| cross-language proving-host interactive/headless interop smoke | pass (76.6s) |
| package export smoke tests | pass (1.3s) |
| Bun and Node portability import checks | pass (3.8s) |
| Node-backed proving-host SQLite interactive/headless scenario | pass (2.3s) |
| PostgreSQL-backed proving-host interactive/headless scenario | pass (17.3s) |

This is the equivalence baseline every subsequent milestone's re-certification is measured against: any milestone that leaves the tree unable to reproduce this same all-green result (modulo the physical paths it deliberately moved) is not done.
