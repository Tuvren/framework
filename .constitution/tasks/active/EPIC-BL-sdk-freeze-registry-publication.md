# Epic BL — SDK Freeze and Registry Publication (KRT)

**Status:** Active — the freeze-candidate audit (KRT-BL001) hard-depends on all of Epic BJ (Publishing Infrastructure) plus the surface- and security-affecting subset of Epic BK (Kernel Substrate Hardening) — specifically KRT-BK002/BK004/BK006, the tickets that change the public surface or its security posture. The remaining BK hardening (BK003, BK005, BK007–BK011) is sequenced into the same block by the "harden → then freeze" decision from this block's pre-planning interview, but it changes no frozen public surface and is not a hard BL prerequisite (see KRT-BL001's Dependencies for the exact gate). Governing authority: PRD CAP-P0-070 (`.constitution/prd/capabilities.md`), ADR-054 (`.constitution/tech-spec/adrs/ADR-054-public-sdk-api-stability-and-registry-publication.md`) as amended by ADR-056 (`.constitution/tech-spec/adrs/ADR-056-tsdoc-experimental-is-the-canonical-experimental-surfa.md`) and ADR-057 (`.constitution/tech-spec/adrs/ADR-057-tuvren-sdk-becomes-the-composition-tier-runtime-demoted.md`), with ADR-058 (`.constitution/tech-spec/adrs/ADR-058-construction-time-funnel-routing-telemetry-destination.md`) folded in as a pre-freeze surface addition.

This epic absorbs the freeze/publication half of the retired Epic BI (`.constitution/archived/EPIC-BI-sdk-stabilization-publication.md`), which it supersedes with corrected starting assumptions: BI was written when `@tuvren/runtime` was still the presumptive host-facing composition entrypoint and assumed the packages were nearly publishable. The 2026-07-04 audit refuted that — no `@experimental` markers exist anywhere in `typescript/core/src` (`grep -rn "@experimental" typescript/core/src` returns nothing; `typescript/core/src/capabilities/index.ts` is a 43-line untagged type-only barrel), no API-snapshot/diff tooling exists, and no registry-publication pipeline exists — and ADR-057 additionally redrew the freeze boundary itself: `@tuvren/sdk` (not `@tuvren/runtime`) now hosts `createTuvren` and is the snapshot target, `@tuvren/runtime` is demoted to an internal, unguaranteed engine package, and the Reference Host (`typescript/host/repl`) must be re-pointed off `@tuvren/runtime` (KRT-BJ002) before this epic's freeze audit can certify a surface the first-party host actually exercises. This epic starts from that corrected state rather than BI's now-stale premise.

**Total: 16 points.**

#### KRT-BL001 Public-Surface Freeze-Candidate Audit
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-BJ003, KRT-BJ005, KRT-BJ006, KRT-BJ008, KRT-BK002, KRT-BK004, KRT-BK006
- **Category:** Feature-Evolution
- **Capability / Contract Mapping:** PRD CAP-P0-070; TechSpec ADR-054, ADR-056, ADR-057, ADR-058
- **Scope (In-Scope Files):** `typescript/core/src/index.ts`, `typescript/core/src/capabilities/index.ts`, `typescript/sdk/src/index.ts`, `typescript/sdk/src/lib/` (audit read-only), `typescript/runtime/src/lib/create-tuvren.ts` (post-BJ001 location: `typescript/sdk/`), `typescript/runtime/src/lib/durable-reads.ts`, `typescript/runtime/src/lib/runtime-execution-handle.ts`, `.constitution/tech-spec/adrs/ADR-054-public-sdk-api-stability-and-registry-publication.md`, `.constitution/tech-spec/adrs/ADR-057-tuvren-sdk-becomes-the-composition-tier-runtime-demoted.md`, `.constitution/tech-spec/adrs/ADR-058-construction-time-funnel-routing-telemetry-destination.md` (audit findings recorded as a new report under `.constitution/reports/`)
- **Scope (Out-of-Scope Files):** `typescript/runtime/src/index.ts` root re-export surface (retirement of curated re-exports is KRT-BJ001's scope, not this ticket's), any leaf-package internals not already published, `typescript/host/repl/**` (re-pointing the Reference Host is KRT-BJ002's scope; this audit only confirms it landed)
- **Verification Command:** `bun run check`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP and escalate if a `Kraken*`-named type is found reachable from `@tuvren/core` (root or subpath) or `@tuvren/sdk` root; STOP if any Durable-Read or `ExecutionHandle`/`awaitResult` signature still requires a caller-supplied scope parameter (violates ADR-048 construction-time binding); STOP if the ADR-057 host-import-contract boundary check (KRT-BJ003) has not landed yet — this audit assumes it exists as an automated gate, not a manual claim.
- **Description:** Re-run the public-surface audit against the ADR-057-amended stable-core enumeration: `@tuvren/core` (root plus subpaths) minus the `@experimental`-tagged `@tuvren/core/capabilities` surface, `@tuvren/sdk` (including its now-hosted `createTuvren` root export), the Durable-Read Surface, the `ExecutionHandle`/`awaitResult` surface, and the published leaf packages. Confirm the 2026-07-04 finding of zero `Kraken*` leaks still holds, confirm no read signature demands a `scope` argument, and confirm the ADR-058 funnel-routing seam (`telemetry` accepting `TuvrenTelemetrySink | TelemetryDestination | { sink?; destination? }`) is present on `CreateTuvrenOptions` before the surface is declared frozen-ready. Record the audited surface as the freeze candidate that KRT-BL002 snapshots.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the ADR-057-amended stable-core enumeration audited after Epics BJ and BK land
When the freeze-candidate audit runs across @tuvren/core, @tuvren/sdk, the Durable-Read Surface, and ExecutionHandle/awaitResult
Then no Kraken* internal type is reachable from the audited public surface
And no audited read signature requires a caller-supplied scope parameter
And the createTuvren telemetry option is confirmed to accept the ADR-058 funnel-routing union
And the audited surface is recorded as the freeze candidate for the snapshot gate
```

#### KRT-BL002 API-Surface Snapshot / Freeze Gate
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BL001
- **Category:** Feature-Evolution
- **Capability / Contract Mapping:** PRD CAP-P0-070; TechSpec ADR-054, ADR-056
- **Scope (In-Scope Files):** `tools/scripts/api-freeze-gate.ts` (new API-snapshot tool), `tools/scripts/authority-guardrails/` (consultation only, for existing gate wiring patterns), `package.json` (`check`/`verify`/`codegen` script wiring), `typescript/sdk/project.json`, `typescript/core/project.json` (Nx target wiring for the new gate), a new committed snapshot artifact location (e.g. `tools/scripts/__snapshots__/api-surface/` (new))
- **Scope (Out-of-Scope Files):** `typescript/runtime/**` (never snapshotted per ADR-057), any leaf package other than `@tuvren/core`/`@tuvren/sdk`, `spec/**` authority packets (this is implementation tooling, not authority)
- **Verification Command:** `bun run check`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if neither an api-extractor-class tool nor a TSDoc-aware tsc/`.d.ts`-walker can mechanically distinguish an `@experimental`-tagged export from an untagged (stable) export in this codebase's build output — do not ship a prose-only or manually-maintained freeze list as a fallback; STOP if wiring the gate into `bun run check` or `bun run verify` would require snapshotting `@tuvren/runtime` (contradicts ADR-057).
- **Description:** Choose and implement the TSDoc-aware API-surface extraction tool (api-extractor-class vs. a custom tsc/`.d.ts`-type-checker-driven walker), implement the ADR-056 diff table exactly (`@experimental` gained on a previously-untagged export blocks; `@experimental` removed is allowed and recorded as semver-minor; signature changes on `@experimental` exports are unguarded; signature changes on untagged exports are blocked unless declared semver-major), enforce the ADR-056 consistency floor for any subpath declared wholly experimental, and wire the resulting gate into the canonical `bun run check`/`bun run verify` path. The snapshot targets `@tuvren/sdk` and `@tuvren/core` only, per ADR-057's amendment that `@tuvren/runtime` is no longer a semver-guaranteed surface.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the frozen @tuvren/sdk and @tuvren/core surface snapshot from KRT-BL001's audited candidate
When a change removes the @experimental tag from a previously tagged export
Then the gate allows the change and records it as semver-minor
When a change alters the signature of an untagged (stable) export without a declared semver-major
Then the gate fails the verification path
When a change alters the signature of an @experimental-tagged export
Then the gate does not block the change
When an export under a subpath declared wholly experimental lacks the @experimental tag
Then the gate fails the build under the ADR-056 consistency floor
```

##### KRT-BL002 Deviations & Justifications
- **Touched Files:** `tools/scripts/lib/api-freeze-model.ts` (new), `tools/scripts/lib/api-freeze-model.test.ts` (new), `tools/scripts/check.ts`, `tools/scripts/verify.ts`
- **Justification:** The ticket scope names `tools/scripts/api-freeze-gate.ts` and "package.json (`check`/`verify` script wiring)". (1) The ADR-056 diff table was extracted into a pure `lib/` module with a bun-test file so the classification semantics are unit-testable independently of compiler extraction — the same split KRT-BK005 used (`lib/regenerate-command-argv.ts` + test); it is part of the named tool, not a second tool. (2) Since Epic BK, the canonical gate lists live in `tools/scripts/verify.ts` (`AUTHORITY_GATE_STEPS`) and `tools/scripts/check.ts` (`INNER_LOOP_AUTHORITY_GATE_IDS`), not in `package.json` command strings; wiring the gate into the `check`/`verify` path therefore requires those two files. `package.json` gained only the `api-freeze` / `api-freeze:check` script entries the ticket anticipated.

- **Post-review fixes (M2 review round 1 — one P1, two P2s, all resolved):** (P1) value-export signatures no longer member-expand lib.d.ts/primitive types, which embedded TS-internal symbol-ID counters (`__@iterator@49`) that shifted on unrelated edits and produced false BLOCKED findings; member expansion is now restricted to object types declared in-repo, residual well-known-symbol names are ID-normalized, and the baseline was regenerated (verified: the reviewer's `isScope` reproduction now flags exactly the 2 genuinely affected exports). (P2) exclusively-`experimental-signature-changed` drift now keeps the check lane green per ADR-056's "ALLOWED, not gated" row, with opportunistic snapshot refresh via `bun run api-freeze`. (P2) the Nx `api-freeze-check` target inputs now include every `typescript/**/package.json` (the gate parses them all for source-path mapping), excluding `node_modules`/`dist`. Also: codepoint (locale-independent) snapshot key ordering; drift findings print even when the consistency floor trips. **Known residual (review "Investigate" flag):** nothing asserts that every type referenced from a stable signature is itself an audited export — a non-exported referenced helper type could change shape ungated; KRT-BL003 should keep this in view before the first publish (same blind-spot class as api-extractor's "forgotten export" warning).

#### KRT-BL003 Registry Publication Pipeline + First Publish
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BL002
- **Category:** Feature-Evolution
- **Capability / Contract Mapping:** PRD CAP-P0-070; TechSpec ADR-054, ADR-057, ADR-037 (`.constitution/tech-spec/adrs/ADR-037-consolidate-shared-primitives-into-tuvren-core-with-sub.md`, peer-dependency version-skew safety)
- **Scope (In-Scope Files):** `typescript/core/package.json`, `typescript/sdk/package.json`, published leaf-package `package.json` files (`typescript/providers/*/package.json`, backend/runner/stream-adapter packages under `typescript/*`), a new publication workflow/script (e.g. `tools/scripts/publish-registry.ts` (new) or a CI workflow file under `.github/workflows/` (new), depending on the KRT-BJ008 release-tooling shape this ticket consumes), `package.json` root (workspace publish orchestration script entry)
- **Scope (Out-of-Scope Files):** `typescript/runtime/package.json` published as a **host-facing** artifact (it remains published for `@tuvren/sdk`'s own dependency resolution per ADR-057 item 5, but must not be advertised or documented as host-installable), `typescript/host/repl/**` (consumed as the onboarding example in KRT-BL004, not modified here)
- **Verification Command:** `bun run verify`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if publication would make `@tuvren/runtime` install-and-import-ready as a host-facing package (ADR-057 item 5 requires it stay internal/unguaranteed even though it is registry-published for `@tuvren/sdk`'s own dependency graph); STOP if any leaf package would peer-depend on `@tuvren/core` with a version range other than the ADR-037 tilde range at publish time; STOP if the frozen KRT-BL002 snapshot has not passed on the exact commit being published.
- **Description:** Using the release tooling established by KRT-BJ008, build provenance-carrying publication of the curated package set (`@tuvren/core`, `@tuvren/sdk`, published leaf packages, and `@tuvren/runtime` as an internal transitive dependency only) to the public registry. Leaf packages peer-depend on a single `@tuvren/core` version using the ADR-037 tilde range. Execute the first real publish and verify a consumer can install the published packages fresh and issue a first Turn by calling `createTuvren` from the published `@tuvren/sdk` root export (ADR-057 item 1).
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the frozen @tuvren/sdk and @tuvren/core surface and the registry publication pipeline
When the curated package set is published to the registry
Then leaf packages peer-depend on a single @tuvren/core version using the ADR-037 tilde range
And published artifacts carry provenance
And @tuvren/runtime is published only as a transitive dependency, never documented as host-installable
And a consumer installing the published packages fresh can issue a first Turn via createTuvren imported from @tuvren/sdk
```

##### KRT-BL003 Deviations & Justifications
- **Touched Files:** `.changeset/config.json`; `typescript/kernel/protocol/package.json`, `typescript/kernel/runtime/package.json`, `typescript/providers/provider-api/package.json` (private→published-internal flips); every workspace `package.json` version field + generated `CHANGELOG.md` files (changeset lane output); new `LICENSE`/`README.md` files in all 19 publishable package directories; `bun.lock`
- **Justification:** All six KRT-BL001 §5 publish-blocking hand-offs land here, and each names files beyond the ticket's literal list. (1) The `access: "restricted"` → `"public"` flip is the recorded BJ008 hand-off. (2) ADR-057 item 5's published-internal treatment must extend beyond `@tuvren/runtime` to `kernel-protocol`, `kernel-runtime`, and `provider-api` (KRT-BL001 §5.1): they are regular dependencies of the published set, and leaving them private makes every registry install unresolvable. `provider-api` additionally reclassifies its `@tuvren/core` edge from `dependencies` to `peerDependencies` — as a published package, a regular dep would bundle a second core instance in consumer trees, violating ADR-037's single-instance guarantee. (3) Version fields move `0.0.0` → `0.1.0` through the KRT-BJ008 release lane (fixed lockstep group); the lane initially computed `1.0.0`, rewritten to `0.1.0` per the operator's explicit launch-version decision (2026-07-11) — the ADR-054 semver discipline and the KRT-BL002 gate apply identically at `0.x`. (4) LICENSE/README tarball completeness is KRT-BL001 §5.3 (npm includes both regardless of the `files` allowlist). All manifest edits stay within the ticket's own subject matter (publication readiness of the curated package set); no runtime/source behavior changed.
- **Additional touched file:** `typescript/kernel/testkit/test/kernel-testkit.test.ts` — its fault-injection-seam guard greps the repo for `@tuvren/kernel-testkit` references outside sanctioned paths; the changeset-generated `typescript/kernel/certification/CHANGELOG.md` dependency-bump line ("- @tuvren/kernel-testkit@0.1.0") tripped it during `bun run verify`. Added `CHANGELOG.md:` to the test's exclusion list (release notes are documentation, not a production import path).
- **Deferred drift note:** `typescript/host/repl` hardcodes `"@tuvren/runtime@0.0.0"` as its transcript `runtimeVersion` label (`cli.ts:477`, `repl-replay.ts:455`). Writer and comparator share the constant, so nothing fails, but the label is stale post-release; the repl is out-of-scope here (KRT-BL004 cites it, KRT-BJ002 owned its imports) — flagged for the epic close-out hand-offs.

#### KRT-BL004 Adopter Onboarding for the Stable/Experimental Boundary
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-BL003, KRT-BJ002
- **Category:** Docs
- **Capability / Contract Mapping:** PRD CAP-P0-070; TechSpec ADR-054, ADR-056, ADR-057, ADR-058
- **Scope (In-Scope Files):** `docs/guides/publishing-and-adopter-onboarding.md` (new, following the existing convention of `docs/guides/add-a-driver.md` and `docs/guides/add-a-language.md`), `typescript/sdk/README.md`, `typescript/runtime/README.md` (updated per ADR-057 item 5 to state it is an internal engine package consumed via `@tuvren/sdk`), `typescript/host/repl/README.md` if present (cited as the living example, not rewritten here beyond a pointer)
- **Scope (Out-of-Scope Files):** `typescript/host/repl/src/**` (re-pointing those modules off `@tuvren/runtime` is KRT-BJ002's scope, cited here only as the living example this onboarding points to), `.constitution/**` authority files (onboarding is adopter-facing docs, not constitutional authority)
- **Verification Command:** `bun run nx run host-repl:test`
- **Expected Success Output:** `exit 0`
- **STOP Conditions:** STOP if the documented install-and-first-Turn path is verified against anything other than the actually-published registry packages from KRT-BL003 (no pre-publish mocks or workspace-link substitutes in the final verification pass); STOP if the onboarding recommends importing `@tuvren/runtime` directly anywhere in the host import contract examples.
- **Description:** Write adopter-facing onboarding documenting: the stable core vs. `@experimental`-tagged surfaces and what the badge means for upgrade safety (ADR-056); the host import contract of `{@tuvren/core, @tuvren/sdk, chosen leaf adapters}` and the explicit prohibition on importing `@tuvren/runtime` or kernel packages directly (ADR-057 item 3); the three ADR-058 funnel-routing topologies (split, unified, mixed-substrate) with one `createTuvren({ telemetry })` example per topology; and an install-plus-first-Turn walkthrough verified against the packages actually published in KRT-BL003. Cite the re-pointed Reference Host (`typescript/host/repl`, once KRT-BJ002 lands) as the living example a reader can clone and run.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the packages published in KRT-BL003 and the re-pointed Reference Host from KRT-BJ002
When an adopter follows the onboarding guide
Then the stable core and @experimental surfaces are delineated using the ADR-056 badge semantics
And the host import contract shown never imports @tuvren/runtime or a kernel package directly
And all three ADR-058 funnel-routing topologies (split, unified, mixed) appear with a working createTuvren example
And the documented install-and-first-Turn path succeeds against the actually-published registry packages
And the Reference Host is cited as a runnable example of the documented contract
```
