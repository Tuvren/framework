# KRT-DC002 triage

The following entries cover failures observed while migrating M2. Classification follows Architecture Decision Record 0081: verification, implementation, specification, or environment. Expected mutant failures prove sensitivity and do not count as baseline defects.

| ID | Classification | Observed failure | Evidence | Disposition |
| --- | --- | --- | --- | --- |
| DC002-V01 | Verification | The test-first contract test could not load the absent syscall plans. | Initial `bun test typescript/kernel/conformance-adapter/test/memory-lifecycle-plans.test.ts`, exit 1, `ENOENT`. | Expected red phase. Added the artifacts; the test passes. |
| DC002-V02 | Verification | Draft leaseless-run assertions read `result.updatedAtMs`, which the catalog's public RunRecord observation does not expose. | Certification assessment reported two `observation-path` violations. | Removed the invalid assertions. Run creation and the runner's explicit clocks drive the horizon; no catalog or native result was changed. |
| DC002-V03 | Verification | All three reclamation mutants activated but were invalid because designated syscall assertions were absent from the selected run. | local run logs (not retained), initial control report: 3 activated, 3 invalid. | Registered both plans in `conformancePlans` and added an integration contract test through the shared negative-control runner. All three are killed after registration. |
| DC002-V04 | Verification | Authority validation rejected both registered plans because they were missing from `verificationPaths`. | First `bun run check`, exit 1; run log not retained. | Added the executable verification-path entries beside EPIC-DB registrations. |
| DC002-V05 | Verification | Testkit control validation assumed claim IDs were check IDs and rejected a grouped reachability trace. | Second `bun run check`, exit 1; a local run log (not retained), `kernel-mutants.test.ts:380`. | Validate declared check/step `claimIds` and retain the check-ID fallback for unchanged legacy plans. The focused testkit and lifecycle contract suite passes. |
| DC002-V06 | Verification | Lint rejected an independent plan load awaited inside a loop. | Second `bun run check`, exit 1; a local run log (not retained), `memory-lifecycle-plans.test.ts:26`. | Load plans with `Promise.all` before inspecting them. |
| DC002-V07 | Verification | Kernel verification rejected stale compatibility inventories for Rust, Go, Python, and Dart after adding seven syscall checks. | First `bun run verify:kernel`, exit 1; a local run log (not retained), run log not retained. | Refreshed generated evidence with `bun run compatibility:evidence` (exit 0); the repeated `bun run verify:kernel` passes. No semantic downgrade. |
| DC002-V08 | Verification | The dropped-staging mutant made the grace trace dereference missing `uncommittedStagedResults.0.objectHash`, so an implementation mutation became a verification failure and invalidated an otherwise detected control. | First full `bun run conformance`, exit 0 in report mode; the initial negative-control report (not retained); the regression test failed before the assertion change and passes afterward (a local run log (not retained)). | Replaced the indexed read with an exact-cardinality `every` assertion comparing complete staged records. The regression test now requires this recovery mutant and the three reclamation controls to be killed; it passes. |
| DC002-V09 | Verification | `kernel.lease-takeover-before-expiry` cannot evaluate its designated clock-skew checks on the memory profile because the shared-clock capability is absent. | First full negative-control report; activation false, outcome invalid, zero designated failures. | Pre-existing limitation from EPIC-DB and outside KRT-DC002. Retain the report-mode invalid outcome and route to KRT-DC003; do not count a kill or weaken the profile. |
| DC002-S01 | Specification | Cross-scope isolation requires two scoped instances over one retained substrate. The catalog has no lifecycle control, the plan has no instance selector, and the trace runner dispatches every action against one fixed instance. | `spec/conformance/kernel/operations.json`; `tools/schemas/conformance-plan.schema.json`; `tools/conformance/harness/run.ts:642`; pinned lifecycle shapes in `.constitution/tech-spec/contracts/conformance-certification.md`. | Unresolved within worker scope. Promote only own-scope positive observations; retain all legacy cross-scope assertions and their mutant designations. Required follow-up: authorize catalogued lifecycle controls and shared-runner multi-instance support without adding scope arguments to kernel syscalls. The epic lead must record the decision; this worker does not edit `.constitution/`. |
| DC002-I01 | Implementation | `delete-object-reachable-through-live-root`, `never-sweep-eligible-objects`, and `sweep-inside-grace-window` fail designated syscall assertions after activation. | Passing lifecycle integration contract test; shared negative-control runner artifacts. | Expected injected defects, detected and killed. No production implementation defect was found. |

No reclamation grace STOP condition occurred. `kernel.clock.set`, native leased-run creation, and catalogued maintenance calls drive the required states. No environment failure was observed. The memory, SQLite, and PostgreSQL baselines pass all seven added checks. Full-suite applicable counts are 128, 129, and 130 respectively, with zero failures. Final command outcomes are appended after all gates complete.

## Final negative-control outcomes

The shared runner is in report mode. The unmutated memory control passes 128 of 128 applicable checks. Twelve mutants activate and are killed; the pre-existing lease-takeover control is invalid. The complete records, per-assertion failures, activation counts, collateral failures, and replay commands are in `DC002-negative-controls.json` beside this report.

| Mutant | Classification | Activated | Outcome | Designated failures | Disposition |
| --- | --- | --- | --- | --- | --- |
| kernel.accept-noncanonical-cbor | Implementation (injected) | true | killed | 1 | Expected injected defect detected. |
| kernel.accept-stale-head-update | Implementation (injected) | true | killed | 3 | Expected injected defect detected. |
| kernel.accept-stale-owner-after-takeover | Implementation (injected) | true | killed | 2 | Expected injected defect detected. |
| kernel.delete-object-reachable-through-live-root | Implementation (injected) | true | killed | 1 | Killed by designated KRT-DC002 syscall assertions. |
| kernel.drop-uncommitted-staged-result-on-recovery | Implementation (injected) | true | killed | 2 | Expected injected defect detected. |
| kernel.fault-seam-never-fires | Verification | true | killed | 0 | Expected missing-activation rejection. |
| kernel.lease-takeover-before-expiry | Verification | false | invalid | 0 | DC002-V09: unchanged capability gap, not a kill. |
| kernel.never-sweep-eligible-objects | Implementation (injected) | true | killed | 5 | Killed by designated KRT-DC002 syscall assertions. |
| kernel.noncanonical-changed-paths-order | Implementation (injected) | true | killed | 1 | Expected injected defect detected. |
| kernel.promote-staged-before-checkpoint | Implementation (injected) | true | killed | 5 | Expected injected defect detected. |
| kernel.resolve-object-across-scopes | Implementation (injected) | true | killed | 2 | Killed by legacy assertions only; DC002-S01 blocks syscall migration. |
| kernel.sweep-inside-grace-window | Implementation (injected) | true | killed | 1 | Killed by designated KRT-DC002 syscall assertions. |
| kernel.wrong-opaque-object-hash | Implementation (injected) | true | killed | 18 | Expected injected defect detected. |

## Final verification

All required command exits are zero on the final implementation. Earlier red phases and corrections are listed in the triage table. `bun run conformance` exits zero because its negative-control gate remains in report mode; this does not turn the invalid lease control into a kill.

| Command | Final exit | Outcome |
| --- | --- | --- |
| `bun run check` | 0 | Authority and formatting gates plus affected typecheck, tests, and lint pass. |
| `bun run verify:kernel` | 0 | Kernel authority, typecheck, testkit, compatibility, and seven conformance projects pass. |
| `bun run conformance` | 0 | Eleven conformance projects pass; 12 mutants killed and one pre-existing invalid control. |
| `bun run lint` | 0 | Full workspace lint passes. |
| `bun tools/scripts/authority-guardrails/authority-guardrails.ts` | 0 | Authority guardrails pass. |
| `bun run compatibility:evidence` | 0 | Regenerated final assertion evidence and matrix; eight generated kernel-report files changed. |
| `bun test typescript/kernel/conformance-adapter/test/memory-lifecycle-plans.test.ts` | 0 | Two contract tests, 425 expectations; certification rules and four mutant kills pass. |
| `bun test typescript/kernel/testkit/test/kernel-mutants.test.ts typescript/kernel/conformance-adapter/test/memory-lifecycle-plans.test.ts` | 0 | Seventeen focused tests passed before the recovery regression extension; final `check` reran both package test suites. |
| `git diff --check` | 0 | No whitespace errors. |

No commit, dependency, public contract, service lifecycle change, or `.constitution/` edit was made. New plan conventions follow EPIC-DB. KRT-DC002 remains incomplete because the cross-scope negative observations and mutant designations have not migrated.
