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
| `boundaries/kernel/contracts/protocol` (port-root `README.md` + `artifacts/README.md` only, 17 lines total, not covered by the row below — `implementations/typescript` remains under `boundaries/` until M1.4, see that row) | `spec/kernel/README.md` (merged with the nested `spec/README.md` below) + `spec/kernel/artifacts/README.md` | migrated (M1.3) | merged, not a pure move — see notes | `artifacts/README.md` pure move, blob unchanged (`22b7cf36fd71f28174c0f033a83b065bcf5a338b`); port-root `README.md` rewritten as `spec/kernel/README.md` (new blob `62dcc8728cc39048b0449fb34fc07932d53f42d1`) folding in the nested `spec/README.md`'s CDDL-promotion note (that file is `git rm`'d, its content preserved in the merged README, not duplicated) |
| `boundaries/kernel/contracts/protocol/spec` | `spec/kernel/` | migrated (M1.3) | tree changed — see notes | `cddl/kernel-records.cddl` pure move, blob unchanged (`694acf4bf065578ed15dd6c1b453d496079effaa`); `authority-packet.json` content-edited (internal path references updated to the new `spec/kernel/` and `spec/conformance/kernel/` locations; `bindingProjections`/`forbiddenAuthoritySources` implementation paths untouched, still M1.4), new blob `32c8941d0098120b615c1fdd173bbc5ec9cb0bdd`; nested `spec/README.md` merged into `spec/kernel/README.md` per the row above |
| `boundaries/kernel/conformance` | `spec/conformance/kernel/` | migrated (M1.3) | `0c49c4ef66fd1d10984695f5b725df7129dd9c48` | fixtures/plans/scenarios/schemas; pure `git mv`, content-identical — tree SHA verified equal to the pre-move HEAD (`cb869829`, M1.2's close), not the stale M0 baseline snapshot recorded here originally, which predates M1.1 adding `fixtures/BUILD.bazel` into this same tree (legitimate baseline drift, not a discrepancy) |
| `boundaries/kernel/interop/grpc` | `spec/interop/` | migrated (M1.5) | tree changed — see notes | IPC transport contract (proto/grammar only). Content-edited, not a pure move: `authority-packet.json`'s internal proto/`generatedArtifacts`/`bindingProjections`/`forbiddenAuthoritySources`/`verificationPaths`/`freshnessChecks` paths recomputed for `spec/interop/`, and its stale `runtime-core` references corrected to the actual current package `runtime` (confirmed via M0's Multi-home §A baselining — `buf.gen.yaml` and `tools/scripts/kernel-interop-governance.ts` already pointed at `runtime`, only the authority-packet.json, `project.json`'s `codegen` inputs/outputs, and `nx.json`'s `interop-smoke` target defaults still named the dead `runtime-core` shim); `project.json`'s `root`/`$schema`/lint-command path recomputed for its new depth-2 home (no other `spec/<port>/` directory carries a `project.json` today, but this one drives real `buf generate`/`breaking`/`interop-smoke` tooling with no other sanctioned home per §5's tree, so it stays co-located with the authority content it governs, mirroring its pre-move co-location). New tree hash `a2254347f56d7486ba6bbbf7b814d32168d8593f` (`git write-tree --prefix=spec/interop/`, recomputed after confirming the edited content was actually staged — an earlier `git add` invocation silently failed on a stale pathspec and the first hash taken was computed against pre-edit content). External consumers fixed: `buf.yaml`'s module path, `rust/kernel-grpc-service/build.rs`'s `proto_root`, `tools/scripts/kernel-interop-governance.ts`'s `PROTO_ROOT`, `nx.json`'s `interop-smoke`/rust-`test` target-default globs (added `spec/interop/**/*`, kept `boundaries/*/interop/**/*` since `boundaries/framework/interop/rust-kernel` is still unmoved, M8's job), and `.constitution/reports/epic-al-portability-inventory.json`'s `tuvren.kernel.interop-grpc` `packetPath` + 2 `sourcePath` entries (a real `portability:check` failure, not a static-grep find — the AL portability gate hard-fails on stale inventory paths). See Multi-home §A: the *telemetry* half of that drift (a different, unrelated stale `outputs` target) stays M8's job, untouched here. |
| `boundaries/kernel/contracts/protocol/implementations/typescript` (`@tuvren/kernel-protocol`) | `typescript/kernel/protocol` | migrated (M1.4b) | `62239c9a8ac39c54173d2135faf7ed9c9df0d1e1` | content-edited (project.json root/schema/inputs, tsconfig* extends/rootDir/references/paths, test-file relative CDDL and core-types imports) — see notes below the table for the shared M1.4b reference-sweep summary |
| `boundaries/kernel/implementations/typescript/runtime-kernel` (`@tuvren/kernel-runtime`) | `typescript/kernel/runtime` | migrated (M1.4b) | `dc495d1d7f8e9e1a33a59f100661ebb24aa37557` | renamed `runtime-kernel` → `runtime` (idiomatic; the package/npm name `@tuvren/kernel-runtime` is unchanged) |
| `boundaries/kernel/implementations/typescript/backend-memory` | `typescript/kernel/backends/memory` | migrated (M1.4b) | `84becb10199c458b70b965defa1a407d6cc41b32` | storage driver; nested one level deeper under a new `backends/` grouping folder (matches issue §4's own "storage drivers (backends: memory / sqlite / postgres)" wording) |
| `boundaries/kernel/implementations/typescript/backend-sqlite` | `typescript/kernel/backends/sqlite` | migrated (M1.4b) | `18a709885c12ce204881d7aeed98911d1fdef3f2` | storage driver; also fixed a hardcoded `.tmp-tests/boundaries/kernel/...` path inside `test/backend-sqlite-test-helpers.ts` that mirrored the package's own old on-disk depth |
| `boundaries/kernel/implementations/typescript/backend-postgres` | `typescript/kernel/backends/postgres` | migrated (M1.4b) | `770b1d2474c49748ddf7bef85b308c223c84a8e4` | storage driver; decided (M1.6) to stay Nx-driven, outside the Bazel graph — see Multi-home §B |
| `boundaries/kernel/implementations/typescript/testkit` (`@tuvren/kernel-testkit`) | `typescript/kernel/testkit` | migrated (M1.4b) | `6b92b9106a4690b9582e257257da20886a21a0bb` | also broadened `test/kernel-testkit.test.ts`'s fault-injection-containment ripgrep search from `boundaries` only to `boundaries typescript`, since the surface it guards now spans both trees |
| `boundaries/kernel/implementations/typescript/conformance-adapter` | `typescript/kernel/conformance-adapter` | migrated (M1.4b) | `7b0f82f81958373e270ca147d424552fa0def748` | one of the 8 `conformance-runner`-family dirs, see Multi-home §C |
| `boundaries/kernel/implementations/typescript/conformance-runner` (`@tuvren/kernel-typescript-conformance-runner`) | `typescript/kernel/conformance-runner` | migrated (M1.4b) | `441334e0178baccaf090fa7b1f8af440f78f45ab` | project ID in `package.json`'s `conformance` script |
| `boundaries/kernel/implementations/typescript/conformance-runner-sqlite` | `typescript/kernel/conformance-runner-sqlite` | migrated (M1.4b) | `9c993e69801d811b21c82e508656da02695f96f4` | project ID `kernel-typescript-sqlite-conformance-runner` |
| `boundaries/kernel/implementations/typescript/conformance-runner-postgres` | `typescript/kernel/conformance-runner-postgres` | migrated (M1.4b) | `cab72dddbf9403a4ebc0f77d3648709638cf9455` | project ID `kernel-typescript-postgres-conformance-runner`; decided (M1.6) to stay Nx-driven, transitionally non-hermetic per invariant §10.5, see Multi-home §B |
| `boundaries/kernel/implementations/rust/kernel` (`tuvren-kernel-rust`) | `rust/kernel` | migrated (M1.4a) | `04dcd517e99de1844b893d48214ba4faa96f1c86` | Cargo workspace member; `path =` in root `Cargo.toml` updated. Tree content-edited, not a pure move: `project.json`'s `root`/`$schema` updated, and `tests/kernel_baseline.rs`'s `include_str!` fixture path recomputed for the new (shallower) depth. Compared against pre-M1.4 HEAD (`68f2e864`), not the stale M0 baseline recorded here originally, which predates M1.1's `BUILD.bazel` addition |
| `boundaries/kernel/implementations/rust/grpc-service` | `rust/kernel-grpc-service` | migrated (M1.4a) | `b670f36e6bcffb11e32274445b2cd93899867e61` | Cargo workspace member; sibling to `rust/kernel`, not nested under it (avoids a `rust/kernel/kernel` double-nest). Content-edited: `project.json`'s `root`/`$schema` updated, `build.rs`'s `proto_root` recomputed (at M1.4a still pointed at `boundaries/kernel/interop/grpc/proto`, correct at the time since that tree hadn't moved yet; M1.5 subsequently re-pointed it to `../../spec/interop/proto`) |
| `boundaries/kernel/implementations/rust/conformance-adapter` | `rust/kernel-conformance-adapter` | migrated (M1.4a) | `15c3293f6f48c1023400a4c78bfafc027e999939` | Pure move — no `project.json` wrapper exists for this crate, and `adapter.json`/`main.rs`/`Cargo.toml` were untouched by this commit, so the tree hash matches the pre-M1.4 HEAD (`68f2e864`) exactly, not the stale M0 baseline recorded here originally (M1.3 had already edited this crate's `adapter.json` `authorityPackets` path, which is why the two differ) |
| `boundaries/kernel/implementations/rust/conformance-runner` (`kernel-rust-conformance-runner`) | `rust/kernel-conformance-runner` | migrated (M1.4a) | `b2caee98eb5796d14726cc121977e809682640a5` | project ID in `conformance` script. Content-edited: `project.json`'s `root`/`$schema`/`inputs`/adapter-path command arg updated, `src/main.rs`'s diagnostic message path updated |

All 10 M1.4b TypeScript rows above are content-edited, not pure moves — every package's own `project.json` (`root`/`$schema`/`cwd`/inputs) needed updating, and most also had `tsconfig*.json` `extends`/`rootDir`/`references`/`paths` entries recomputed for the new depth (kernel packages moved from nested inside `boundaries/` to a root-level `typescript/kernel/` tree, so every cross-package and cross-boundary relative reference's up-count and, for cross-boundary targets, an explicit `boundaries/` segment needed recomputing). The sweep also touched ~17 files **outside** the kernel tree that reference these packages by relative path from their own unmoved locations: `boundaries/framework/contracts/{driver-api,event-stream,runtime-api,tool-contracts}/implementations/typescript/tsconfig.typecheck.json`, `boundaries/framework/implementations/typescript/{conformance-adapter (3 files),drivers/react,runtime-core (2 files),runtime (3 files)}`, `boundaries/hosts/implementations/typescript/repl/{tsconfig.dts,tsconfig.lib,tsconfig.typecheck}.json`, and `boundaries/providers/{contracts/provider-api/implementations/typescript,implementations/typescript/bridge-ai-sdk}/tsconfig.typecheck.json` — none of those rows change (their own locations are unaffected), but they are recorded here since `bun run check`'s affected-typecheck lane initially caught one real miss (`framework-adapter-batteries-included.ts`/`framework-adapter-runtime.ts`) that a plain path-string grep sweep alone did not, because those referenced the kernel packages via relative paths without the literal `boundaries/kernel` substring.

## Core / ABI (→ `spec/core/` + TypeScript libc/SDK tier) — M2

**M2.1 sort decision (recorded before any M2 move, per the M2 DoD's "before this milestone starts" requirement).** Two tracks run in parallel and the rows below name both: (a) the **authority** track — the neutral contract form (TypeSpec `main.tsp`, `authority-packet.json`, `bindings/typescript.md`) lifts from `boundaries/shared/contracts/core/spec/` to root `spec/core/` at M2.2; (b) the **physical TS source** track — the `@tuvren/core` implementation moves to `typescript/core` at M2.3 (npm name and all 11 subpath exports unchanged), `@tuvren/core-types` moves to `typescript/core-types` (M0's `spec/core/` destination guess for it is corrected here: §5's layout rule forbids language-bearing code in `spec/`), and the executable helpers extract to a **new libc/SDK-tier package `@tuvren/sdk` at `typescript/sdk`** at M2.4. The SDK home cannot be `@tuvren/runtime` (the issue's "concrete libc surface today") because `typescript/kernel/conformance-adapter/src/host.ts` and `@tuvren/mcp-client` (whose only `@tuvren` dep is `core`) consume the helpers — routing them through the engine package would invert layering; a small SDK package that depends only on `@tuvren/core` preserves direction for every consumer (runtime, adapters, mcp-client, repl). Extraction purifies the ABI package: `zod` + `@standard-schema/spec` are `@tuvren/core`'s only (peer) dependencies and exist solely for `schema-authoring.ts`, so they leave with it. See Multi-home §D (resolved) for the file-by-file classification. The M2 DoD's required enumeration is complete: every `@tuvren/core/*` subpath row below now names its destination tier, `core-types`'s destination is corrected, and the four deprecated shims (`runtime-api`, `driver-api`, `event-stream`, `tool-contracts` — rows further below) were measured at M2.1 to have **zero remaining import sites** (`runtime-core`: one), so their only migration-relevant content is authority, consumed at their owning milestones (M6/M8/M3-or-M9/M5 respectively) — no consumer-rewrite work hides behind them.

| old_path | new_path | status | content_hash | notes |
|---|---|---|---|---|
| `boundaries/shared/contracts/core/implementations/typescript/src/errors` | `typescript/core/src/errors` (physical, M2.3); vocabulary owned by `spec/core` authority (M2.2) | pending | `1ecc9c117f4b97326aa9a7d9256554fc2cd42b79` | pure types, per M2 DoD |
| `boundaries/shared/contracts/core/implementations/typescript/src/messages` | `typescript/core/src/messages` (M2.3); vocabulary → `spec/core` (M2.2) | pending | `c2c96565913caa0381cc2aa46feb5cc064453241` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/events` | `typescript/core/src/events` (M2.3); vocabulary → `spec/core` (M2.2) | pending | `d17119b90bf18bf6200db2240c443814c576e5f5` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/execution` | `typescript/core/src/execution` (M2.3); vocabulary → `spec/core` (M2.2) | pending | `a43354c5b61c99956cd412b7bff7c410f8883d4e` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/tools` | `typescript/core/src/tools` (M2.3); its executable re-exports (`asSchema`, `defineTool`, `jsonSchema`, `zodSchema`, `standardSchema`, `schemaSymbol`, and the `Schema`/`FlexibleSchema`/`LazySchema`/`StandardSchema`/`ZodSchema` authoring types) leave for `@tuvren/sdk` (M2.4); tools-port *authority* consolidates at `spec/tools` (M5) | pending | `9219414da2ca938c97465a36f33745974b0b7ce5` | after M2.4 this subpath exports only the contract surface (guards + shapes from `runtime-contract-guards`/`-shapes`) |
| `boundaries/shared/contracts/core/implementations/typescript/src/lib` (15 files) | 13 files stay in `@tuvren/core` at `typescript/core/src/lib` (M2.3); `schema-authoring.ts` moves wholesale to `@tuvren/sdk` (M2.4); `payload-codec.ts` splits intra-file — contract portion stays, implementation portion → `@tuvren/sdk` (M2.4) | pending | `92e552689bd4674bf58b77f0d69a81e542125c3c` | **§D resolved at M2.1** — see Multi-home §D for the file-by-file classification and the intra-file split boundary for `payload-codec.ts` |
| `boundaries/shared/contracts/core/implementations/typescript/src/driver` | `typescript/core/src/driver` (M2.3); execution-model *authority* consolidates at `spec/runners` (M6); the subpath's driver→runner rename is M6's | pending | `742ebd2aa77fa05a32d679b901754ad629294d5c` | "driver" here means execution-model per M6's inversion, not resource adapter |
| `boundaries/shared/contracts/core/implementations/typescript/src/provider` | `typescript/core/src/provider` (M2.3); provider-port *authority* → `spec/providers` (M4) | pending | `7797c38b224b019cd9bc2b2d5a4a63aa748cff31` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/extensions` | `typescript/core/src/extensions` (M2.3); extension-port *authority* → `spec/extensions` (M7) | pending | `bfa11ded81c200febb00a3dd163421c9ac4e024e` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/telemetry` | `typescript/core/src/telemetry` (M2.3); telemetry *authority* → `spec/telemetry` (M8) | pending | `9ddf7e69d30873500607115d725cf372b16e3998` | see Multi-home §A for the telemetry 3-home reconciliation |
| `boundaries/shared/contracts/core/implementations/typescript/src/capabilities` | `typescript/core/src/capabilities` (M2.3); capability *authority* → `spec/tools` (M5) | pending | `16c2dd586ff333fa9c286cc8311ee34b6a3da41a` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/lifecycle` | `typescript/core/src/lifecycle` (M2.3); after M2.4 it exports only the payload-codec *contract* surface (`PayloadCodec`, `PayloadCodecContext`, `PayloadDecryptResult`, `ErasedPayload`, `isErasedPayload`) — the codec implementations move to `@tuvren/sdk` | pending | `9ebaa250d48b5926750c756076fae071222ad1dc` | |
| `boundaries/shared/contracts/core/implementations/typescript/src/index.ts` (root export) | `typescript/core/src/index.ts` (M2.3), minus any executable re-exports that leave at M2.4 | pending | `6d24e8e9d3d171955b7e1a12a6a75001d99beab2` | |
| `boundaries/shared/contracts/core` (whole port dir: artifacts/spec/README, not just `src/`) | authority parts (`spec/` subdir) → `spec/core/` (M2.2); implementation (`implementations/typescript`) → `typescript/core` (M2.3); port-root README/artifacts follow the M1.3 merge pattern into `spec/core/` | pending | `87129aea2a17660eef2b6a5851f68abc1f8c0b3a` | superset of the `src/` subpath rows above |
| `boundaries/shared/contracts/core-types` (`@tuvren/core-types`) | `typescript/core-types` (M2.3) | pending | `74cc79ea321f488a45a7af49148ed70bc33f0b09` | named explicitly in §12 as a multi-home case. **M2.1 correction:** M0's `spec/core/` destination guess violated §5's "no language-bearing code in `spec/`" rule — this is a TS package (387 lines: `kernel-records`/`tuvren-error` mirrors + tests). Six packages declare it as a dependency but zero `@tuvren/core-types` import sites exist; the only real consumer is `typescript/kernel/protocol/test/kernel-contract-deterministic.test.ts` importing a test fixture via deep relative path (recompute at M2.3). Flagged as a consolidation candidate for a future epic — merging it into `@tuvren/core` is a semantic change outside this restructure's scope |
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
- **M1.5 resolved the interop half.** `spec/interop/authority-packet.json`'s `generatedArtifacts`/`bindingProjections`/`forbiddenAuthoritySources`/`freshnessChecks` and `spec/interop/project.json`'s `codegen` inputs/outputs, plus `nx.json`'s `interop-smoke` target defaults, all named the dead `runtime-core` shim instead of the real `runtime` package that `buf.gen.yaml` and `tools/scripts/kernel-interop-governance.ts` already correctly targeted — confirmed and fixed as part of the M1.5 move (see the Kernel table row above). The telemetry half (`telemetry/project.json`'s `outputs` still naming `runtime-core/src/lib/generated/tuvren-runtime-telemetry.ts`, which does not exist) remains untouched, deliberately, for M8.

### §B — Postgres hermeticity (kernel backend + conformance runner)

`boundaries/kernel/implementations/typescript/backend-postgres` and `.../conformance-runner-postgres` are devenv-managed and non-idempotent (per `AGENTS.md`/`CLAUDE.md`: `devenv up -d` a second time fails). **Decided (M1.6):** the postgres backend and its conformance runner (now at `typescript/kernel/backends/postgres` and `typescript/kernel/conformance-runner-postgres` since M1.4b) stay Nx-driven, outside the hermetic Bazel graph, per invariant §10.5's explicit sanctioned exception ("may run Nx-driven transitionally... until M1's hermeticity decision lands"). This decision *is* that landing: no `BUILD.bazel` target exists or is planned for either package for the remainder of this epic; postgres conformance keeps running exactly as it does today (`bun run nx run kernel-typescript-postgres-conformance-runner:conformance`, requiring `bun run services:up` first). Nothing else migrated so far needed this exception — `typescript/kernel/protocol`, `typescript/kernel/runtime`, and `rust/kernel` are the only packages M1's own DoD requires to certify under Bazel (`typescript/kernel/protocol/BUILD.bazel`, `typescript/kernel/runtime/BUILD.bazel`, `rust/kernel/BUILD.bazel`); the memory/sqlite backends and every conformance-adapter/runner package (postgres included) remain Nx-only for now, which is consistent with M1 being a tracer-bullet slice, not a full-coverage Bazel migration. Recorded here and in `MODULE.bazel`'s module docstring rather than silently excluded; folded into the M1.7 closing `gh issue comment 87` as part of M1's overall close-out.

### §C — Two independent "eights"

The `conformance` script in `package.json` lists exactly 8 project IDs; there are exactly 8 `conformance-runner`-family directories tabled above (kernel-TS ×3 incl. sqlite/postgres, kernel-rust ×1, framework-TS ×2 incl. batteries-included, framework-rust ×1, providers-TS ×1). These are **independent sets that currently happen to both total 8** — per issue §14, they need not stay equal, and the M6 "runner"→"certification harness" rename must not assume a 1:1 mapping between them.

### §D — `tools`/`capabilities` split (core → spec vs. libc) — **RESOLVED at M2.1**

The classification axis (from issue §3's own line: "core — the ABI... Contract-only, no behavior. Executable helpers currently bundled — schema-authoring, payload codecs — are not ABI"): **contract-derived validation** (type guards, predicates, error classes — the TS expression of the contract's validation semantics, which every language reimplements from `spec/core`) **is ABI and stays in `@tuvren/core`**; **behavior that does work beyond validating shapes** (schema conversion/authoring over external libraries, cryptography) **is libc and moves to `@tuvren/sdk`**. File-by-file, verified by reading export signatures and bodies (not filename-guessed):

| `src/lib` file | Classification | Destination |
|---|---|---|
| `capability-shapes.ts`, `driver-contract-shapes.ts`, `runtime-contract-shapes.ts`, `driver-contracts.ts` (barrel) | pure types, zero functions | stays (`@tuvren/core`) |
| `capability-error-codes.ts` | const error-code strings (data) | stays |
| `kernel-records.ts`, `scope.ts`, `tuvren-error.ts` | types/constants + is/assert guards + `TuvrenError` class family (the "errors" vocabulary is explicitly ABI per issue §3) | stays |
| `driver-contract-guards.ts`, `runtime-contract-guards.ts`, `runtime-contract-predicates.ts`, `runtime-content-approval-predicates.ts`, `runtime-context-manifest-predicates.ts` | is/assert contract guards and predicates only — no I/O, no library coupling, no policy | stays |
| `schema-authoring.ts` (388 lines) | executable: `defineTool`, `asSchema`, `jsonSchema`, `zodSchema`, `standardSchema` factories + `schemaSymbol`, plus the `Schema`/`FlexibleSchema`/`LazySchema`/`StandardSchema`/`ZodSchema` authoring types that carry the `zod`/`@standard-schema/spec` coupling | **moves wholesale** to `@tuvren/sdk` (M2.4). Nothing else in `core/src/lib` imports from it (verified), so the move is clean; core's only peer deps (`zod`, `@standard-schema/spec`) leave with it |
| `payload-codec.ts` (447 lines) | **intra-file split**, per the file's own docstring ("The contract here is the authority; `createAesGcmPayloadCodec` is one batteries-included implementation of it"): contract portion (`PayloadCodec`, `PayloadCodecContext`, `PayloadDecryptResult`, `ErasedPayload`, `isErasedPayload`) stays — `runtime-contract-shapes.ts` imports `ErasedPayload`, confirming it is vocabulary; implementation portion (`createAesGcmPayloadCodec`, `createIdentityPayloadCodec`, `IDENTITY_PAYLOAD_CODEC`, `isPayloadEnvelope` + envelope parsing/magic-byte internals, `AesGcmPayloadCodecOptions`, `PayloadKeyring`) → `@tuvren/sdk` (M2.4) | split |

Consumer blast radius of the extraction (measured): `defineTool`-family symbols are used by 11 files (framework conformance-adapter ×2, runtime src+tests ×5, providers conformance-adapter, `mcp-client`, repl ×2), importing via `@tuvren/core/tools`; payload-codec implementations by 8 files (runtime src ×3 + tests ×4, `typescript/kernel/conformance-adapter/src/host.ts`), via `@tuvren/core/lifecycle`. The kernel adapter and `mcp-client` consumers are why the SDK tier must be a standalone package below `@tuvren/runtime` (see the M2.1 preamble in the Core/ABI section).

## Naming-map addenda

None at M0 baseline. Every path discovered during the inventory pass matched an existing pattern in issue §15's naming map.

**M1.4b addendum** — concrete idiomatic subpaths decided under `typescript/kernel/` (§15 left these as "idiomatic subpath decided at M1"):
- `typescript/kernel/protocol` (was `contracts/protocol/implementations/typescript`)
- `typescript/kernel/runtime` (was `implementations/typescript/runtime-kernel`; package name `@tuvren/kernel-runtime` unchanged)
- `typescript/kernel/backends/{memory,sqlite,postgres}` (was `implementations/typescript/backend-{memory,sqlite,postgres}`; grouped under a new `backends/` folder per issue §4's own "storage drivers (backends: memory / sqlite / postgres)" wording)
- `typescript/kernel/testkit`, `typescript/kernel/conformance-adapter`, `typescript/kernel/conformance-runner{,-sqlite,-postgres}` (flat siblings, names unchanged)

**M2.1 addendum** — concrete homes decided for the M2 (core/ABI) milestone (§15 patterns: "boundary-owned `contracts/` → `spec/<port>/`", "`boundaries/<area>/implementations/<lang>/…` → `<lang>/…`"):
- `spec/core/` (was `boundaries/shared/contracts/core/spec/`) — the neutral authority: TypeSpec `main.tsp`, `authority-packet.json`, `bindings/typescript.md`
- `typescript/core` (was `boundaries/shared/contracts/core/implementations/typescript`; npm name `@tuvren/core` and all 11 subpath exports unchanged)
- `typescript/core-types` (was `boundaries/shared/contracts/core-types/implementations/typescript`; npm name `@tuvren/core-types` unchanged; corrects M0's `spec/core/` guess per §5's no-language-code-in-spec rule)
- `typescript/sdk` — **new package `@tuvren/sdk`**, the TypeScript libc/SDK tier born at M2.4 to receive the extracted executable helpers (`schema-authoring.ts` + payload-codec implementations). Not in §15's starter map (the map has no libc row); added here as the naming-map addendum the M0 DoD anticipated. Depends only on `@tuvren/core`; M3's libc/SDK milestone may grow or fold this surface, but its tier position (above core, below/independent of the engine) is fixed by its consumers (kernel conformance-adapter, `mcp-client`)

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

## M1 close (M1.7) — equivalence proof against the M0.2 baseline

M1 ("Tracer bullet — kernel") is closed. All of its DoD bullets are met:

- `spec/kernel` + `spec/conformance/kernel` exist and are authoritative (M1.3).
- The Rust kernel (`tuvren-kernel-rust`, now `rust/kernel`) and the TypeScript kernel line (`@tuvren/kernel-protocol` at `typescript/kernel/protocol`, `@tuvren/kernel-runtime` at `typescript/kernel/runtime`) build and certify under Bazel (`rust/kernel/BUILD.bazel`, `typescript/kernel/protocol/BUILD.bazel`, `typescript/kernel/runtime/BUILD.bazel` — proven in M1.1/M1.2, re-proven live at every subsequent sub-commit's review gate through M1.6).
- The IPC (gRPC) kernel transport is mapped to `spec/interop/`, with its generated-bindings config drift (stale `@tuvren/runtime-core` references vs. the real `@tuvren/runtime` package) reconciled (M1.5). The literal "generated bindings relocate to the `typescript/` generated area" end-state is deferred until `@tuvren/runtime` itself moves in M3 — see M1.5's own inventory row and Multi-home §A for why treating this as M3-gated, not M1-blocking, is the correct reading.
- The stateful PostgreSQL conformance lane's reconciliation with Bazel hermeticity is decided: it stays Nx-driven, outside the hermetic graph, permanently for this epic, per invariant §10.5's sanctioned exception (M1.6, see Multi-home §B).
- Old and new paths produce equivalent results: **proven below.** Inventory updated: every kernel-section row above is `migrated`, none remain `pending`.

**Equivalence proof.** Re-ran `bun run services:up` (idempotent, no-op — already running) followed by `bun run verify` at commit `131d2db61963d7bf7f583b9c7ab89c3a35922728` (M1.6, HEAD immediately before this closing commit). First run surfaced a real (if purely cosmetic) regression: `workspace lint` failed on 4 files last touched by M1.3 (`tools/conformance/plan-compiler/index.ts`, `tools/conformance/vocabulary/validate-vocabulary.ts`, `tools/scripts/authority-packet/validate-authority-packets.ts`, `tools/scripts/docs-authority-freeze-gate.ts`) — sed-based edits from M1.3's `SPEC_ROOT`-scanning additions had left syntactically valid but non-biome-formatted content (unwrapped-vs-wrapped line breaks) that no narrower `bun run check`/`bun run codegen` lint pass had caught, because those run scoped per-project lint targets rather than `verify`'s full-repo `bunx --bun @biomejs/biome check .`. Fixed via `bunx --bun @biomejs/biome check --write` on the 4 files; diff-reviewed and confirmed purely cosmetic (line-wrap changes only, zero logic/string-value changes). Re-ran `bun run verify` clean:

**Result: green. Exit code 0.** All 26 phases passed — the identical phase set and count as the M0.2 baseline, modulo the physical paths M1 deliberately moved (kernel authority/conformance into `spec/`, kernel adapters into `rust/kernel*` and `typescript/kernel/*`, the gRPC interop contract into `spec/interop/`) and modulo timing variance. No phase was skipped, added, or renamed. This is the equivalence proof M1's own DoD requires.

**Decision recorded at M1's close (folded in from M1.6):** the PostgreSQL kernel backend and its conformance runner (`typescript/kernel/backends/postgres`, `typescript/kernel/conformance-runner-postgres`) stay permanently Nx-driven, outside Bazel's hermetic graph, for the reasons detailed in Multi-home §B and `MODULE.bazel`'s module docstring. This is the landing of invariant §10.5's "until M1's hermeticity decision lands" grace period.
