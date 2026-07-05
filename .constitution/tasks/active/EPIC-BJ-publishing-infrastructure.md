# Epic BJ — Publishing Infrastructure (KRT)

**Status:** Active. Governed by PRD v0.12.0 CAP-P0-070 (published stable SDK with an explicitly marked experimental boundary), CAP-P0-071/CAP-P0-072 (two-funnel content/telemetry separation and construction-time funnel routing); TechSpec v0.32.0 ADR-056 (TSDoc `@experimental` as the canonical experimental-surface marker), ADR-057 (`@tuvren/sdk` becomes the composition tier, `@tuvren/runtime` demoted to internal engine), ADR-058 (construction-time funnel-routing `TelemetryDestination` contract with one-directional failure isolation).

This epic realizes part of the retired Epic BI's intent (`.constitution/archived/EPIC-BI-sdk-stabilization-publication.md` — retired unexecuted, with a ticket absorption map recorded in its supersession note): BI's experimental-marker ticket and its publication-scaffolding ambitions are re-scoped here under ADR-056/057/058's amended decisions. This epic does not perform an actual registry publish — that remains Epic BL.

**Total: 32 points.**

#### KRT-BJ001 SDK Composition-Tier Migration (ADR-057)
- **Type:** Chore
- **Effort:** 5
- **Dependencies:** None
- **Category:** Tech-Debt
- **Capability / Contract Mapping:** PRD CAP-P0-070; TechSpec ADR-057 (amends ADR-037/040/054)
- **Scope (In-Scope Files):**
  - `typescript/runtime/src/index.ts` (root export barrel — strip curated `@tuvren/core` re-exports and `createTuvren`)
  - `typescript/runtime/src/lib/create-tuvren.ts` (move to sdk)
  - `typescript/sdk/src/index.ts` (new root export of `createTuvren` + curated re-exports)
  - `typescript/runtime/package.json` (remove `@tuvren/sdk` from `peerDependencies`/`peerDependenciesMeta`)
  - `typescript/sdk/package.json` (add `@tuvren/runtime` as a regular `dependencies` entry)
  - `typescript/runtime/README.md` (mark internal/engine-only) — verify existence before editing; create alongside if absent
  - `spec/conformance/engine/plans/runtime-api-batteries-included.json` (retarget assertions to the sdk surface; drop string-kind cases)
- **Scope (Out-of-Scope Files):**
  - `typescript/host/repl/**` (covered by KRT-BJ002)
  - `typescript/core/src/**` (host-facing contract types already live here per the audit in ADR-057; no type migration needed)
- **Verification Command:** `bun run nx run sdk:typecheck && bun run nx run framework-runtime:typecheck && bun run conformance`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:**
  - STOP if any intermediate commit state leaves `runtime` peer-depending on `sdk` while `sdk` depends on `runtime` (dependency cycle); land the peer-dep removal and the new dependency edge in the same commit.
  - STOP if a host-facing contract type is found to originate only in `@tuvren/runtime` (contradicting the ADR-057 audit) rather than already existing on a `@tuvren/core` subpath; escalate instead of inventing a new home for it.
- **Description:** Perform the coordinated ADR-057 migration as one unit: relocate `createTuvren` and its curated re-exports from `@tuvren/runtime`'s root export to `@tuvren/sdk`'s root export; correct the currently inverted dependency edge between the two packages; retire the ADR-040 string-kind backend/runner shorthands so `CreateTuvrenOptions` accepts constructed instances/factories only (`backend`, `runner` required, no `"memory"|"sqlite"|"postgres"` tags, no implicit `"react"` runner default); strip `@tuvren/runtime`'s public surface of curated `@tuvren/core` re-exports so it carries no host-facing convenience aliases; mark `@tuvren/runtime` as an internal engine package in its README and `package.json` description; move the `runtime-api-batteries-included` conformance check set's target surface from `@tuvren/runtime` to `@tuvren/sdk` with assertions updated for the instances-only option shape.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the ADR-057 composition-tier migration
When the workspace is built after the migration
Then @tuvren/sdk's root export includes createTuvren and the curated @tuvren/core re-exports
And @tuvren/runtime's root export carries no host-facing re-exports and no createTuvren
And @tuvren/sdk depends on @tuvren/runtime as a regular dependency, not a peer dependency
And @tuvren/runtime no longer lists @tuvren/sdk in its peerDependencies
And CreateTuvrenOptions accepts only constructed backend/runner instances, with no string-kind shorthand
And the workspace typecheck and conformance lanes pass with no dependency cycle
```

##### KRT-BJ001 Deviations & Justifications
- **Touched Files (out of the declared In-Scope list):**
  - `typescript/core/src/lib/payload-codec.ts`, `typescript/core/src/lifecycle/index.ts` — relocated `IDENTITY_PAYLOAD_CODEC`, `createIdentityPayloadCodec`, `ENVELOPE_MAGIC`, and `isPayloadEnvelope` down into `@tuvren/core` (re-exported via `@tuvren/core/lifecycle`).
  - `typescript/sdk/src/lib/payload-codec.ts` — dropped the relocated identity-codec definitions; imports the discriminant/guard from `@tuvren/core/lifecycle`; keeps only the batteries-included `createAesGcmPayloadCodec`. (The identity helpers are re-published on the `@tuvren/sdk` surface from the package barrel `src/index.ts`, not from this implementation module — the surface-continuity re-export was relocated to the barrel by the KRT-BJ003 corrections below, which removed a `noBarrelFile` lint violation this file otherwise carried.)
  - `typescript/runtime/src/lib/runtime-core.ts`, `typescript/runtime/src/lib/payload-codec-seam.ts` — repointed their `IDENTITY_PAYLOAD_CODEC` / `isPayloadEnvelope` source imports from `@tuvren/sdk` to `@tuvren/core/lifecycle`.
  - `typescript/conformance-adapter/src/framework-adapter-batteries-included.ts` — repointed `createTuvren` to the sdk surface and rewrote `buildBackendSpec` to construct real `RuntimeBackend`/runner instances (instances-only `CreateTuvrenOptions`).
  - `typescript/runtime/smoke/package-exports.ts` — rewritten to assert the engine-only surface and that the curated host-facing symbols are absent from `@tuvren/runtime`.
  - `typescript/runtime/package.json`, `typescript/sdk/package.json` — dep-topology beyond the single peer-dep line: pruned runtime's now-unused `@tuvren/backend-*` / `@tuvren/runner-react` / `@tuvren/mcp-client` / `@tuvren/kernel-runtime` deps; added sdk's regular `@tuvren/kernel-protocol` + `@tuvren/kernel-runtime` deps and a `@tuvren/backend-memory` devDep.
  - `typescript/runtime/test/{durable-reads,durable-reads.scope-isolation}.test.ts` — repointed `IDENTITY_PAYLOAD_CODEC` to `@tuvren/core/lifecycle` (stay in runtime; they import runtime-internal `../src/lib/*`).
  - `typescript/sdk/test/{tenant-offboarding,payload-codec.context-engineering-rewrite,payload-codec.crypto-shredding,conversation-state.shreddable-continuity}.test.ts` — `git mv`'d from `typescript/runtime/test/` and repointed (`createAesGcmPayloadCodec`/`createTuvren` → sdk source; runtime engine + shared test helpers via `../../runtime/...`).
- **Justification:** ADR-057 removes the peer-dep and adds `sdk → runtime`, but `@tuvren/runtime` still consumed `IDENTITY_PAYLOAD_CODEC`/`isPayloadEnvelope` from `@tuvren/sdk` in **source**, which turns the flipped edge into a genuine `sdk ⇄ runtime` package cycle (Nx `^build` follows source-import edges, test files included). The load-bearing fix is the codec relocation into `@tuvren/core` (the identity codec is the exact analogue of the already-in-core `NoopTelemetrySink`); the runtime source/test repoints and the four test moves are the mechanical consequence of eliminating every `@tuvren/sdk` import from the runtime project (proven: `framework-runtime:exports-smoke` now builds the full graph with no circular-dependency error). The conformance-adapter and smoke edits are the mandatory ripple of the instances-only option shape and the engine-only surface. The dep-pruning realizes the audit's `[E-03]` watch-item (the runtime 10-dep fan-in that made every SDK consumer transitively install all three backends + the React runner). None of these trips BJ001's STOP conditions: the peer-dep removal and the new dependency edge land in the same commit, and no host-facing contract type was found to originate only in `@tuvren/runtime`.
- **In-Scope file intentionally left unchanged:** `spec/conformance/engine/plans/runtime-api-batteries-included.json` needed no structural change — its `input.backend` string is the *adapter's* backend selector, not a `createTuvren` option, so the twelve lifecycle checks now prove the sdk surface without edits.
- **Milestone-coupling note (execution-discovered):** BJ001's `bun run conformance` acceptance clause cannot be green until BJ002 lands, because the shared `framework-typescript-conformance-adapter` package statically imports `@tuvren/repl-host` (`src/framework-adapter-secret-isolation.ts:35`) and its proving-host adapter execs the built REPL CLI, so every certification's `^build` requires `host-repl:build` — which fails until BJ002 repoints the host. BJ001 is validated by the host-independent gates (`sdk`/`framework-runtime` typecheck, the `exports-smoke` cycle proof, and the full `sdk` + `framework-runtime` test suites); the `conformance` gate is restored jointly with BJ002.

#### KRT-BJ002 Reference Host Re-Point to the Host Import Contract
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-BJ001
- **Category:** Tech-Debt
- **Capability / Contract Mapping:** PRD CAP-P0-070; TechSpec ADR-057 §3/§6
- **Scope (In-Scope Files):**
  - `typescript/host/repl/package.json` (drop `@tuvren/runtime`, add `@tuvren/sdk`)
  - `typescript/host/repl/src/cli.ts`
  - `typescript/host/repl/src/lib/repl-types.ts`
  - `typescript/host/repl/src/lib/repl-replay.ts`
  - `typescript/host/repl/src/lib/proof-extension.ts`
  - `typescript/host/repl/src/lib/repl-config.ts`
  - `typescript/host/repl/src/lib/repl-scenarios-support.ts`
  - `typescript/host/repl/src/lib/repl-builtin-tools.ts`
  - `typescript/host/repl/src/lib/repl-scenarios.ts`
  - `typescript/host/repl/src/lib/repl-host.ts`
  - `typescript/host/repl/src/lib/repl-provider.ts`
  - `typescript/host/repl/src/lib/repl-transcript.ts`
  - `typescript/host/repl/src/lib/repl-live-output.ts`
  - `typescript/host/repl/src/lib/repl-headless-mode.ts`
  - `typescript/host/repl/src/lib/repl-shell.ts`

  (this list is the full 14-file `@tuvren/runtime`-importing set confirmed by `grep -rl "@tuvren/runtime" typescript/host/repl/src`; `gemini-cli.ts` and `index.ts` under the same root did not match and are excluded)
- **Scope (Out-of-Scope Files):**
  - `typescript/sdk/**` (already re-pointed in KRT-BJ001)
  - `typescript/host/repl/src/lib` files outside the 14 enumerated above
- **Verification Command:** `bun run nx run host-repl:typecheck && bun run nx run host-repl:test`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:**
  - STOP if any of the 14 files needs a symbol that is not re-exported from `@tuvren/sdk` or a `@tuvren/core` subpath and has no leaf-package instance equivalent; escalate rather than reintroducing a `@tuvren/runtime` import.
- **Description:** Re-point every Reference Host module that currently imports `@tuvren/runtime` to import `createTuvren` and curated primitives from `@tuvren/sdk` (or `@tuvren/core` subpaths where the sdk does not re-export them) and to construct leaf-package instances (backends, runner, stream adapters, provider bridge) directly; update `typescript/host/repl/package.json` to drop the `@tuvren/runtime` dependency and add `@tuvren/sdk`. This makes the Reference Host the first proof that the ADR-057 host import contract is exercised by first-party code, not just documented.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the Reference Host under typescript/host/repl
When its source is re-pointed to the host import contract
Then none of the 14 enumerated modules imports @tuvren/runtime
And typescript/host/repl/package.json no longer depends on @tuvren/runtime and depends on @tuvren/sdk
And the host-repl typecheck and test lanes pass unchanged in behavior
```

##### KRT-BJ002 Deviations & Justifications
- **Blocker discovered during execution → ADR-059.** ADR-057 §6 assumed the re-point was "import `createTuvren` + primitives from sdk/core + leaf instances," because its grounding audit checked host-facing *types* only. Execution found the Reference Host also consumes engine *factory functions* from `@tuvren/runtime` with no `@tuvren/sdk`/`@tuvren/core` or leaf home: `createOrchestrationRuntime` (multi-agent — `createTuvren` is single-agent and cannot express it), `createRunnerRegistry`, `createTuvrenRuntime` (the primary *synchronous* `createReplHost` path), `createGrpcRuntimeKernel` (rust-grpc mode, runtime-only), and `createRuntimeKernel` (kernel-runtime, also forbidden by §3). This tripped BJ002's STOP condition. Resolution (user decision, recorded as **ADR-059**, amends ADR-057 §3/§6): dedicated homes — a new opt-in `@tuvren/sdk/advanced` subpath for the four composition/local-kernel factories, and a new published leaf `@tuvren/kernel-grpc-client` for the gRPC kernel; the host contract is extended to allow both. The host re-points with no behavior change.
- **Touched files beyond the declared In-Scope list (the 14 host `src/` files + host `package.json`):**
  - **New leaf `@tuvren/kernel-grpc-client`** (`typescript/kernel/grpc-client/`): `src/index.ts`, `src/lib/grpc-kernel-client.ts` + `-codec.ts` (`git mv`'d from `typescript/runtime/src/lib/runtime-kernel-grpc*.ts`), `package.json`, `project.json`, `tsup.config.ts`, `tsconfig{,.lib,.tsup,.dts}.json`, `tsconfig.kernel-interop.generated.json` (`git mv`'d from runtime).
  - **Codegen retargeting** (kernel-interop output moves runtime → leaf): `buf.gen.yaml`, `tools/scripts/kernel-interop-governance.ts` (path constants), `spec/interop/project.json` (codegen outputs/inputs), `spec/interop/authority-packet.json` (generatedArtifacts / bindingProjections / forbiddenAuthoritySources / verificationPaths / freshnessChecks — re-validated), `nx.json` (interop-smoke inputs), `.gitignore`, `tsconfig.base.json` (source-path entries for the new leaf + `@tuvren/sdk/advanced`).
  - **New subpath `@tuvren/sdk/advanced`**: `typescript/sdk/src/advanced.ts`; `typescript/sdk/package.json` (`./advanced` export); `typescript/sdk/tsup.config.ts` (entry); `typescript/sdk/src/index.ts` (biome re-ordering only).
  - **`@tuvren/runtime` reductions**: `src/index.ts` (drop gRPC re-exports), `project.json` (drop the `kernel-interop-grpc` codegen `dependsOn`), `package.json` (drop `@connectrpc/connect`, `@connectrpc/connect-node`, `@bufbuild/protobuf`), `smoke/package-exports.ts` (assert gRPC factory absent).
  - **Host beyond the 14 src files**: `test/repl-test-helpers.ts` + `test/repl.test.ts` (same `@tuvren/runtime`→`@tuvren/sdk`/`@tuvren/telemetry-semconv` repoint), `tsconfig.{lib,dts,typecheck}.json` (swap the runtime reference for the new deps); `package.json` also gained `@tuvren/mcp-client` + `@tuvren/telemetry-semconv` (leaf symbols the host imports directly). `repl-host.ts`: the broken (post-BJ001) `createReplHostUsingCreateTuvren` fixed to instances-only, and the now-duplicate `createTuvrenBackendConfig` folded into `createBackend`.
  - **Authority**: `.constitution/tech-spec/adrs/ADR-059-*.md` (new), plus `tech-spec/changelog.md` (v0.33.0), `guidelines.md` (§5.8.2 items 4/5/7 + package tree), `stack.md` (target-state posture).
- **Justification:** All out-of-scope touches are the mechanical realization of the ADR-059 decision (new homes + codegen relocation + host re-point) plus the correctness ripple it forces (authority-packet + tsconfig + nx.json path retargeting; host test/tsconfig files that import the same surface). None reintroduces a forbidden host→`@tuvren/runtime`/kernel-package import; the host→sdk→runtime edge keeps `@tuvren/runtime` internal.
- **Forward ripple recorded:** `@tuvren/kernel-grpc-client` is a new **publishable** leaf, so KRT-BJ007 (publication metadata) and KRT-BJ008 (release tooling) must include it, and the KRT-BJ003 host-boundary gate must **allow** `@tuvren/sdk/advanced` + `@tuvren/kernel-grpc-client` while blocking `@tuvren/runtime`/`@tuvren/kernel-protocol`/`@tuvren/kernel-runtime`.

#### KRT-BJ003 Automated Host-Boundary Check
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-BJ002
- **Category:** DX
- **Capability / Contract Mapping:** PRD CAP-P0-070; TechSpec ADR-057 §3
- **Scope (In-Scope Files):**
  - `tools/scripts/host-boundary-gate.ts` (new — sibling to `tools/scripts/portability-gate.ts`)
  - `tools/scripts/check.ts` (register the new gate id in `AUTHORITY_GATE_STEPS`/`INNER_LOOP_AUTHORITY_GATE_IDS`)
  - `tools/scripts/verify.ts` (wire the gate into the canonical verification path alongside the existing portability/authority-packet gates)
  - `package.json` (root — add an npm script entry if the gate is also exposed standalone, matching the `portability-gate`/`release-check` convention)
- **Scope (Out-of-Scope Files):**
  - `typescript/host/repl/src/**` (already migrated in KRT-BJ002; this ticket only adds the guard)
  - `tools/scripts/authority-guardrails/authority-guardrails.ts` (a distinct, unrelated gate family — do not fold this check into it)
- **Verification Command:** `bun run check`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:**
  - STOP if enforcing the check against current documentation examples would require rewriting doc content outside this epic's file scope; narrow the gate to `typescript/host/**` and file a follow-up for docs instead of silently excluding the whole documentation-examples clause.
- **Description:** Add a new fail-loud gate script, following the existing `portability-gate.ts` pattern (license header, explicit rationale comment, deterministic exit code), that scans `typescript/host/**` (and documentation code examples where present) for imports of `@tuvren/runtime`, `@tuvren/kernel-protocol`, or `@tuvren/kernel-runtime`, and fails the run if any are found. Wire the new gate into `check.ts`'s cheap authority-gate step list and into `verify.ts`'s canonical verification path so the ADR-057 host import contract cannot silently regress.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the host-boundary gate registered in the canonical verification path
When a file under typescript/host/** imports @tuvren/runtime, @tuvren/kernel-protocol, or @tuvren/kernel-runtime
Then bun run check and bun run verify fail loudly identifying the offending file and import
And when no such import exists, the gate passes with exit 0 as part of bun run check
```

##### KRT-BJ003 Deviations & Justifications
- **Gate design (in-scope, as specified):** `tools/scripts/host-boundary-gate.ts` recursively walks `typescript/host/**` (skipping `dist`/`node_modules`/`generated`/`coverage`/`.tmp*`), strips `//` and `/* */` comments per line (so a doc comment mentioning `from "@tuvren/runtime"` cannot trip it), matches module specifiers only in `from`/`import`/`require` positions (so the `runtimeVersion: "@tuvren/runtime@0.0.0"` transcript strings in host source are ignored), and fails loud with `file:line:specifier` + `process.exitCode = 1`. A specifier is forbidden when it equals or is a subpath of `@tuvren/runtime`, `@tuvren/kernel-protocol`, or `@tuvren/kernel-runtime`; the prefix rule intentionally lets the ADR-059 leaf `@tuvren/kernel-grpc-client` and the `@tuvren/sdk/advanced` subpath through. Wired into `AUTHORITY_GATE_STEPS` (verify.ts, id `ADR-057 host import boundary gate`), `INNER_LOOP_AUTHORITY_GATE_IDS` (check.ts), and a root `host-boundary:check` script. Proven both ways: green on the clean tree (26 files) and fail-loud against a temporary probe carrying exact/subpath/dynamic-import/export-from violations while ignoring the allowed leaf/subpath, comment mentions, and transcript strings.
- **STOP condition — documentation-examples clause narrowed (as sanctioned):** the ticket's Description mentions "documentation code examples where present"; per the STOP condition, the gate is scoped to `typescript/host/**` only. Verified no doc example under `docs/`/`README.md` currently imports a forbidden specifier, so nothing is silently excluded and no doc rewrite was needed; a docs-example lane can be added later without changing this gate's contract.
- **Prerequisite green-check corrections (execution-discovered; touched files owned by KRT-BJ001/BJ002).** BJ003's verification command is `bun run check`, which runs the full inner-loop authority gate plus `nx affected`. Running it surfaced two latent red gates that M1/M2 had not caught because their narrower per-ticket verify commands (`sdk`/`framework-runtime`/`host-repl` targets + `conformance`) never ran `lint` or the workspace-test-coverage gate. Both were fixed as a prerequisite corrective commit so BJ003's `bun run check` acceptance is honestly green:
  - **BJ001 fallout — `sdk:lint` (`noBarrelFile`).** BJ001's surface-continuity re-export block in `typescript/sdk/src/lib/payload-codec.ts` tripped biome `lint/performance/noBarrelFile` (only the package-root barrel `src/index.ts` carries the sanctioned `biome-ignore-all` for that rule). Fix: removed the re-export from the implementation module and re-published the identity helpers (`createIdentityPayloadCodec`, `IDENTITY_PAYLOAD_CODEC`, `isPayloadEnvelope`) on the `@tuvren/sdk` surface directly from `@tuvren/core/lifecycle` in `src/index.ts`; repointed the four sdk tests that imported those moved symbols (`payload-codec.test.ts`, `payload-codec.crypto-shredding.test.ts`, `payload-codec.context-engineering-rewrite.test.ts`, `conversation-state.shreddable-continuity.test.ts`) to `@tuvren/core/lifecycle`. The public `@tuvren/sdk` export surface is byte-identical; only the internal source of the re-export changed.
  - **BJ002 fallout — `kernel-grpc-client` test-lane coverage.** The new `@tuvren/kernel-grpc-client` leaf declared a `test` target but shipped no tests and was not registered in any verify lane, so `validate-workspace-test-coverage` failed (that gate allows only cargo-covered exclusions, so a TS leaf must be registered). Fix: added genuine package-local round-trip tests for the relocated transport codec (`typescript/kernel/grpc-client/test/grpc-kernel-client-codec.test.ts`, 14 tests over verdict/path-value/kernel-record/enum/error transforms — a surface that previously had zero coverage anywhere), a `tsconfig.typecheck.json` so the `test/` dir is typechecked (mirroring the sibling kernel packages), and registered `kernel-grpc-client` in `WORKSPACE_TEST_PROJECTS` (`tools/scripts/verify.ts`).
- **Justification:** the gate itself lands exactly within the declared In-Scope files. The corrective touches are prerequisites for the ticket's own `bun run check` acceptance to pass and are corrections to earlier milestones' files (documented here because they were discovered during BJ003); none changes a public contract — the sdk surface is preserved and the leaf gains only tests + a typecheck config + a lane registration.

#### KRT-BJ004 Funnel-Routing Contract (ADR-058)
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BJ001
- **Category:** Feature-Evolution
- **Capability / Contract Mapping:** PRD CAP-P0-071, CAP-P0-072; TechSpec ADR-058 §1-§4
- **Scope (In-Scope Files):**
  - `typescript/core/src/telemetry/index.ts` (add `TelemetryDestination` contract type, `deliver` signature, operational-signal callback shape)
  - `typescript/core/src/telemetry/telemetry-destination.ts` (new lib file backing the destination contract, consistent with the existing barrel-re-export pattern seen in `typescript/core/src/capabilities/index.ts`)
  - `typescript/sdk/src/index.ts` (widen the `telemetry` option on `CreateTuvrenOptions` — sink | destination | route object — per this epic's KRT-BJ001 relocation)
  - `typescript/runtime/src/lib/runtime-core-telemetry.ts` (failure isolation: catch `TelemetryDestination.deliver`/`TuvrenTelemetrySink` errors at the boundary, convert to operational signal, never propagate into session/content-funnel path)
  - `spec/core/authority-packet.json` (`telemetry` binding section, line ~232) and `spec/core/bindings/typescript.md` (line ~246) — declare the new `/telemetry` `TelemetryDestination` binding
- **Scope (Out-of-Scope Files):**
  - Concrete destination adapter packages (deferred per ADR-058 §6, out of this epic entirely — named deferred Epic BO)
  - `typescript/providers/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge-utils.ts` (the ADR-044 secret-screening gap named in ADR-058's context is KRT-BK004's scope, not this ticket's)
- **Verification Command:** `bun run nx run shared-core:typecheck && bun run nx run sdk:typecheck && bun run nx run framework-runtime:typecheck`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:**
  - STOP if implementing failure isolation would require the Kernel syscall surface or the gRPC interop layer to become funnel-aware (a proto change); ADR-058 §5 explicitly forbids this — escalate instead of adding one.
  - STOP if the `telemetry` option widening breaks an existing `TuvrenTelemetrySink`-only construction call; the union must stay backward-compatible per ADR-058's consequences.
- **Description:** Introduce the `TelemetryDestination` contract on `@tuvren/core/telemetry` as a durable delivery target distinct from the existing push-based `TuvrenTelemetrySink`, with buffering/backpressure policy owned by the destination descriptor and delivery failures surfaced only through an operational-signal channel, never thrown into the caller. Widen the `telemetry` option on `CreateTuvrenOptions` (now homed on `@tuvren/sdk` per KRT-BJ001) to accept a sink, a destination, or a route object combining both, giving hosts a construction-time funnel-routing seam for split, unified, or mixed-substrate topologies. Extend the one-directional failure-isolation invariant already implemented for sinks in `runtime-core-telemetry.ts` to destinations, so a destination delivery failure degrades telemetry only and never fails, blocks, or delays a content-funnel commit or kernel checkpoint. Declare the new binding in the core authority packet so cross-language conformance has a machine-readable anchor.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the TelemetryDestination contract on @tuvren/core/telemetry
When a host constructs createTuvren with telemetry as a sink, a destination, or a route object
Then the construction succeeds for all three shapes without a signature-breaking change to the sink-only form
And a TelemetryDestination.deliver failure is caught at the telemetry boundary and surfaced as an operational signal
And the same failure never throws into, blocks, or delays a content-funnel commit or kernel checkpoint
And the core authority packet's telemetry binding lists the new TelemetryDestination contract
```

#### KRT-BJ005 Funnel-Isolation Conformance Check Set
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-BJ004
- **Category:** Feature-Evolution
- **Capability / Contract Mapping:** PRD CAP-P0-071, CAP-P0-072; TechSpec ADR-058 §5
- **Scope (In-Scope Files):**
  - `spec/conformance/telemetry/plans/framework-operational-telemetry.json` (extend with the new funnel-isolation checks, following the existing `checkId`/`assertions` shape at line ~15)
  - `spec/conformance/telemetry/scenarios/operational-telemetry-scenarios.json` (add destination healthy/unavailable scenario fixtures)
  - `tools/conformance/harness/run.ts` (add shared-runner-owned assertion kinds only if the existing `resultField`/lineage assertion kinds cannot express destination-health equivalence or the no-content-payload check — do not add grading logic to adapters)
- **Scope (Out-of-Scope Files):**
  - Any `<lang>/conformance-adapter/**` implementation (adapters must not receive `checkId`, grade pass/fail, or write compatibility evidence per the repository's conformance rules)
  - `typescript/core/src/telemetry/**` (contract itself is KRT-BJ004's scope, not this ticket's)
- **Verification Command:** `bun run conformance`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:**
  - STOP if a proposed assertion would require an adapter to compute pass/fail or map a protocol failure into `$.result.error`; keep grading in the shared runner per the repository's conformance rules.
- **Description:** Add three new checks to the telemetry conformance plan per ADR-058 §5: (a) a destination healthy-vs-unavailable session-result equivalence check (the flow §4.19 unhappy path — same turn produces identical session results regardless of destination health); (b) a no-content-payload-on-telemetry-funnel check under default routing; (c) a failure-to-operational-signal mapping check (a destination delivery failure surfaces a signal rather than an exception or a silent drop). All assertions are shared-runner-owned and evaluate implementation-emitted events/results, never adapter-side grading.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the extended telemetry conformance plan
When a turn runs with a healthy telemetry destination versus an unavailable one
Then the session result is identical between the two runs
And no content-funnel payload appears in the telemetry funnel's emitted records under default routing
And a simulated destination delivery failure produces an operational signal rather than a thrown exception or a silent drop
And bun run conformance reports these checks passing without adapter-side pass/fail grading
```

#### KRT-BJ006 Experimental Markers on the Capabilities Surface (ADR-056)
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** None
- **Category:** Docs
- **Capability / Contract Mapping:** PRD CAP-P0-070; TechSpec ADR-056
- **Scope (In-Scope Files):**
  - `typescript/core/src/capabilities/index.ts` (add `@experimental` TSDoc tag to every re-exported type: `AttachedClientEndpoint`, `Binding`, `Capability`, `CapabilityInvocationAttribution`, `CapabilityObservation`, `CapabilityPolicyContext`, `CapabilityPolicyEngine`, `ClientDispatchResult`, `ClientEndpointBoundary`, `ClientEndpointCapabilityAdvertisement`, `ClientInvocationEnvelope`, `ClientReportedResult`, `Endpoint`, `EndpointKind`, `ExecutionClass`, `ExposureDecision`, `InvocationDecision`, `InvocationLifecycleState`, `InvocationOwner`, `PolicyCapabilityMetadata`, `ToolSurface`, `TuvrenSandboxExecutor`, plus a subpath-level experimental notice in the file's module doc comment)
  - `spec/core/authority-packet.json` (record the marker declaration in the core authority packet's surface listing)
- **Scope (Out-of-Scope Files):**
  - `typescript/core/src/lib/capability-shapes.ts` (the canonical declaration site — ADR-056 tags the re-export barrel, not necessarily the underlying declaration; do not duplicate tags there unless the freeze-gate tooling requires it)
  - The freeze/diff gate implementation itself (that is KRT-BL002's scope in Epic BL; this ticket only applies the markers)
- **Verification Command:** `bun run nx run shared-core:typecheck && bun run lint`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:**
  - STOP if any export under `typescript/core/src/capabilities/index.ts` cannot be given an individual `@experimental` tag (e.g., a re-export syntax that only allows a whole-statement comment) without restructuring the barrel; escalate rather than silently leaving an export untagged, since ADR-056's consistency floor treats an untagged export under a declared-experimental subpath as a defect.
- **Description:** Apply the ADR-056 canonical experimental-surface marker — a TSDoc `@experimental` release tag on the individual export — to every current export of `@tuvren/core/capabilities`, plus a subpath-level experimental notice in the module doc comment so the boundary is visible without reading each export's docs. Record the marker declaration (which exports/subpath carry `@experimental` and why) in the core authority packet's surface listing so conformance plans, generated docs, and the Epic BL freeze-gate expectations read from one authored source.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the @tuvren/core/capabilities subpath
When its exports are reviewed after this ticket
Then every currently exported type carries an individual @experimental TSDoc tag
And the subpath's module documentation carries a subpath-level experimental notice
And the core authority packet's surface listing records the marker declaration
```

#### KRT-BJ007 Package Manifest Publication Readiness
- **Type:** Chore
- **Effort:** 5
- **Dependencies:** KRT-BJ001
- **Category:** Feature-Evolution
- **Capability / Contract Mapping:** PRD CAP-P0-070; TechSpec ADR-057 §5 (stable-core enumeration), ADR-054 (precedent)
- **Scope (In-Scope Files):**
  - `typescript/core/package.json`
  - `typescript/sdk/package.json`
  - `typescript/backend-memory/package.json`, `typescript/backend-postgres/package.json`, `typescript/backend-sqlite/package.json` (verify exact directory names before editing — backends were referenced via workspace name `@tuvren/backend-*` in `typescript/runtime/package.json`)
  - `typescript/runners/react/package.json`
  - `typescript/providers/bridge-ai-sdk/package.json`
  - `typescript/streaming/core/package.json`, `typescript/streaming/sse/package.json`, `typescript/streaming/agui/package.json`
  - `typescript/tools/mcp-client/package.json`
  - `typescript/telemetry/otel/package.json`, `typescript/telemetry/semconv/package.json`
  - Internal-stays-private set (no `files`/publication fields added, `private: true` retained): `typescript/runtime/package.json`, `typescript/testkit/package.json`, `typescript/certification/package.json`, `typescript/kernel/testkit/package.json`, `typescript/kernel/certification/package.json`, `typescript/providers/testkit/package.json`, `typescript/providers/certification/package.json`, `typescript/host/repl/package.json`, `typescript/core-types/package.json`, `typescript/kernel/protocol/package.json`, `typescript/kernel/runtime/package.json`
- **Scope (Out-of-Scope Files):**
  - `rust/**/Cargo.toml` (Rust publication readiness is not part of this ticket's TypeScript-scoped manifests)
  - Any actual `npm publish`/registry credential wiring (Epic BL)
- **Verification Command:** `bun run lint && bun run nx run shared-core:typecheck`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:**
  - STOP if a package directory named in this ticket does not exist as listed; re-verify the real path with `ls typescript/**/package.json` before editing rather than guessing a plausible name.
  - STOP if any package intended to stay private per ADR-057's stable-core enumeration is found to be a runtime dependency of a to-be-published package in a way that would force it to also publish; escalate the topology question rather than flipping its private flag as a side effect.
- **Description:** For every publishable TypeScript package in the ADR-057 stable-core set (`@tuvren/core`, `@tuvren/sdk`, and the leaf packages — backends, stream adapters, ReAct runner, AI SDK provider bridge, MCP client, telemetry packages), add a `files` allowlist scoped to `dist` and essential metadata, a `license` field matching the root `LICENSE` (Apache-2.0), a `description`, and a `repository` field. Decide the `private` flag per package: internal-only packages (testkits, certification wrappers, conformance-adapters, `@tuvren/runtime`, `@tuvren/repl-host`, kernel protocol/runtime packages) keep `private: true` and receive no publication fields. Establish the versioning baseline that will replace the current `0.0.0` placeholder at actual publish time (a version scheme decision, not a version bump performed in this ticket).
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the ADR-057 stable-core package set
When each publishable package.json is reviewed after this ticket
Then it declares a files allowlist, license, description, and repository field
And its license value matches the root LICENSE (Apache-2.0)
And every package outside the stable-core set retains private: true with no publication fields added
And bun run lint passes with no manifest-schema regressions
```

#### KRT-BJ008 Release Versioning Pipeline Scaffolding
- **Type:** Chore
- **Effort:** 5
- **Dependencies:** KRT-BJ007
- **Category:** Feature-Evolution
- **Capability / Contract Mapping:** PRD CAP-P0-070; TechSpec ADR-057 (peer-dep consequences), ADR-037 (single-core-version peer-dep model)
- **Scope (In-Scope Files):**
  - `tools/scripts/release-lane.ts` (new — a release lane script sibling to `tools/scripts/release-check.ts`)
  - `tools/scripts/release-check.ts` (extend or reference from the new lane; verify current contents before assuming its scope)
  - `package.json` (root — add a `release` or `release:check` script entry following the existing `"release-check": "bun tools/scripts/release-check.ts"` convention at line 44)
  - Changeset-class tooling config (new — e.g. `.changeset/config.json`, only if the chosen changeset-class tool requires a config file; verify no existing `.changeset/` directory before creating one)
- **Scope (Out-of-Scope Files):**
  - Any actual `npm publish` invocation or registry credential/token handling (explicitly deferred to Epic BL)
  - `rust/**/Cargo.toml` version fields (Rust release tooling is out of scope for this TypeScript-scoped ticket)
- **Verification Command:** `bun run nx run shared-core:typecheck && bun tools/scripts/release-check.ts`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:**
  - STOP if the chosen changeset-class tool's default multi-version-per-leaf model would require leaf packages to peer-dep divergent `@tuvren/core` versions; ADR-037's single-instance guarantee (one `@tuvren/core` version across leaves) must not be weakened — configure the tool to enforce a single core version, or escalate if it cannot.
  - STOP before wiring any real registry publish step; this ticket is scaffolding only.
- **Description:** Introduce changeset-class release-versioning tooling (recording per-package change intents and computing version bumps) configured to honor the ADR-037 peer-dependency single-instance model, so every leaf package's peer-dependency on `@tuvren/core` resolves to one version across a release. Add a release lane script that runs the versioning computation and manifest updates without invoking an actual registry publish, leaving the real publish step for Epic BL.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the changeset-class release tooling scaffolded by this ticket
When the release lane script runs against a set of pending package changes
Then it computes version bumps for the affected publishable packages
And every leaf package's @tuvren/core peer-dependency resolves to a single consistent version
And no step in the lane invokes an actual registry publish
And bun tools/scripts/release-check.ts exits 0 against the scaffolded configuration
```
