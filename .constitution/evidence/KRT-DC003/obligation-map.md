# KRT-DC003 obligation map

The legacy plan is byte-for-byte unchanged. The syscall plan adds memory-applicable public observations under `tuvren.kernel.run-liveness.syscall` version `0.1.0`.

Table 1 maps every legacy assertion. Assertion numbers are 1-based. Syscall claims have separate `kernel.syscall.run-liveness.*` identities. They never satisfy a legacy check ID: the legacy checks retain obligations that the syscall plan cannot observe.

| Legacy planId | checkId | Assertion (1-based) | New claimId or removal reason |
| --- | --- | --- | --- |
| tuvren.kernel.run-liveness | kernel.run-liveness.lease_renewal | 1.resultField | kernel.syscall.run-liveness.lease_renewal: assertion 2 reads the native renewed expiry; assertions 8 and 9 observe exclusion after original expiry and inclusion after renewed expiry. |
| tuvren.kernel.run-liveness | kernel.run-liveness.lease_renewal | 2.resultField | kernel.syscall.run-liveness.lease_renewal: assertion 3 and wrongOwner.schemaValid require the native run_lease_owner_mismatch envelope. |
| tuvren.kernel.run-liveness | kernel.run-liveness.lease_renewal | 3.resultField | kernel.syscall.run-liveness.lease_renewal: assertion 4 and staleToken.schemaValid require the native run_lease_token_mismatch envelope. |
| tuvren.kernel.run-liveness | kernel.run-liveness.expired_listing | 1.resultField | kernel.syscall.run-liveness.expired_listing: assertions 3-5 require exactly one expired running record, runexpired; fresh, paused, failed, and completed controls coexist. |
| tuvren.kernel.run-liveness | kernel.run-liveness.expired_listing | 2.resultField | SPEC-DC003-01: no catalogued raw run-record read. The trace confirms a paused run still blocks its branch after expiry; it cannot directly read paused status. |
| tuvren.kernel.run-liveness | kernel.run-liveness.expired_listing | 3.resultField | kernel.syscall.run-liveness.expired_listing: assertions 3 and 4 require exactly runexpired, excluding runpaused without an adapter-computed boolean. |
| tuvren.kernel.run-liveness | kernel.run-liveness.stale_preemption | 1.resultField | SPEC-DC003-01: raw failed status remains on the unchanged legacy check; replacement creation and expiry exclusion are weaker public observations, not an equivalent status inspector. |
| tuvren.kernel.run-liveness | kernel.run-liveness.stale_preemption | 2.resultField | SPEC-DC003-01: no syscall returns the stored run preemptionReason. Sending a reason is not proof of persistence; keep this legacy obligation. |
| tuvren.kernel.run-liveness | kernel.run-liveness.stale_preemption | 3.resultField | kernel.syscall.run-liveness.stale_preemption: assertion 4 checks native uncommittedStagedResults cardinality; assertion 12 checks native staging is empty. |
| tuvren.kernel.run-liveness | kernel.run-liveness.stale_preemption | 4.resultField | SPEC-DC003-01: no syscall exposes cleared owner/token/expiry after preemption. Exclusion from expired listing and a replacement run do not prove these fields were removed. |
| tuvren.kernel.run-liveness | kernel.run-liveness.stale_preemption | 5.resultField | kernel.syscall.run-liveness.stale_preemption: assertion 5 compares the native recovery head with the native branch head; assertions 6 and 11 prove a checkpoint advanced lineage. |
| tuvren.kernel.run-liveness | kernel.run-liveness.stale_preemption | 6.resultField | kernel.syscall.run-liveness.stale_preemption: assertions 7-10 compare native consumed results, task identity, and node contents with the staged records observed before preemption. |
| tuvren.kernel.run-liveness | kernel-restart-af.expired-running-requires-preemption | 1.resultField | SPEC-DC003-01: duplicate raw failed-status obligation remains legacy; public replacement behavior is covered by kernel.syscall.run-liveness.stale_preemption. |
| tuvren.kernel.run-liveness | kernel-restart-af.expired-running-requires-preemption | 2.resultField | SPEC-DC003-01: duplicate persisted preemptionReason obligation remains legacy. |
| tuvren.kernel.run-liveness | kernel-restart-af.expired-running-requires-preemption | 3.resultField | SPEC-DC003-01: duplicate cleared-lease obligation remains legacy. |
| tuvren.kernel.run-liveness | kernel-restart-af.paused-run-excluded-from-stale-preemption | 1.resultField | SPEC-DC003-01: duplicate raw paused-status obligation remains legacy; kernel.syscall.run-liveness.expired_listing proves branch blocking after expiry. |
| tuvren.kernel.run-liveness | kernel-restart-af.paused-run-excluded-from-stale-preemption | 2.resultField | kernel.syscall.run-liveness.paused_run_excluded_from_expiry: assertions 3 and 4 exclude paused work from the exact expired membership. |
| tuvren.kernel.run-liveness | kernel.run-liveness.clock_skew_preemption | 1.resultField | MOVED: kernel.shared-backend (ADR-0076 STOP rule); shared backend expiry under worker clock skew is outside kernel.memory. |
| tuvren.kernel.run-liveness | kernel.run-liveness.clock_skew_preemption | 2.resultField | MOVED: kernel.shared-backend (ADR-0076 STOP rule); shared backend expiry under worker clock skew is outside kernel.memory. Remove workerClockWouldExpire during that migration: it only compares constants and proves no kernel behavior. |
| tuvren.kernel.run-liveness | kernel.run-liveness.clock_skew_preemption | 3.resultField | MOVED: kernel.shared-backend (ADR-0076 STOP rule); shared backend expiry under worker clock skew is outside kernel.memory. |
| tuvren.kernel.run-liveness | kernel.run-liveness.clock_skew_preemption | 4.resultField | MOVED: kernel.shared-backend (ADR-0076 STOP rule); shared backend expiry under worker clock skew is outside kernel.memory. |
| tuvren.kernel.run-liveness | kernel.run-liveness.clock_skew_preemption | 5.resultField | MOVED: kernel.shared-backend (ADR-0076 STOP rule); shared backend expiry under worker clock skew is outside kernel.memory. |
| tuvren.kernel.run-liveness | kernel.run-liveness.clock_skew_preemption | 6.resultField | MOVED: kernel.shared-backend (ADR-0076 STOP rule); shared backend expiry under worker clock skew is outside kernel.memory. |
| tuvren.kernel.run-liveness | kernel.run-liveness.clock_skew_preemption | 7.resultField | MOVED: kernel.shared-backend (ADR-0076 STOP rule); shared backend expiry under worker clock skew is outside kernel.memory. |
| tuvren.kernel.run-liveness | kernel.run-liveness.clock_skew_preemption | 8.resultField | MOVED: kernel.shared-backend (ADR-0076 STOP rule); shared backend expiry under worker clock skew is outside kernel.memory. |
| tuvren.kernel.run-liveness | kernel.run-liveness.clock_skew_preemption | 9.resultField | MOVED: kernel.shared-backend (ADR-0076 STOP rule); shared backend expiry under worker clock skew is outside kernel.memory. |
| tuvren.kernel.run-liveness | kernel.run-liveness.clock_skew_preemption | 10.resultField | MOVED: kernel.shared-backend (ADR-0076 STOP rule); shared backend expiry under worker clock skew is outside kernel.memory. |

## Specification findings

SPEC-DC003-01: The operation catalog exposes leased creation, renewal, expired listing, and preemption, but no public run-record inspector. `run.recover` returns recovery data only. No catalogued syscall returns paused/failed status, persisted preemption reason, or cleared lease metadata after completion. These legacy assertions remain unmigrated. The syscall plan makes no replacement claim for these fields, and no profile is declared complete. No syscall check or step advertises any of the five legacy check IDs. `kernel.syscall.run-liveness.lease_renewal`, `.expired_listing`, and `.stale_preemption` describe only their observed syscall assertions. `kernel.syscall.run-liveness.paused_run_excluded_from_expiry` covers paused-list exclusion, without claiming raw paused status. No replacement claim exists for `kernel-restart-af.expired-running-requires-preemption`: all three legacy assertions remain unmigrated. Three of six `kernel.run-liveness.stale_preemption` assertions remain unmigrated.

SPEC-DC003-02: The preemption catalog lists only the injected-fault error. It omits the native `kernel_runtime_run_lease_not_expired` rejection needed to assert an attempted premature takeover. Within the permitted scope, the existing mutant is re-designated to live-lease exclusion from expiry listing. Its memory implementation deliberately lists at a far-future caller clock, so this is a real memory defect and needs no shared clock. Direct rejection of premature `preemptExpired` remains unclaimed pending catalog authority. No catalog or native API was invented.

## Negative controls and undetected obligations

The shared runner must pass the same unmutated memory configuration before counting either lease control. The contract test also requires positive activation counts and at least one designated failure from the syscall family.

Table 2 records the lease designations.

| Mutant | Claim | Designated assertions |
| --- | --- | --- |
| kernel.lease-takeover-before-expiry | kernel.syscall.run-liveness.live_lease_excluded_from_expiry | kernel.syscall.run-liveness.expired_listing.2.resultField; kernel.syscall.run-liveness.lease_renewal.8.resultField |
| kernel.accept-stale-owner-after-takeover | kernel.syscall.run-liveness.lease_renewal | kernel.syscall.run-liveness.lease_renewal.3.schemaValid; kernel.syscall.run-liveness.lease_renewal.4.schemaValid |

The first control proves live leases are not listed as takeover candidates before expiry, including after renewal. It does not certify shared-backend clock authority or a direct nonexpired preemption attempt. The second control proves native owner/token rejection after token rotation; it does not add cross-worker takeover semantics.

Undetected: the remaining expired-listing membership cases and the complete stale-preemption checkpoint/recovery claim have no dedicated designated mutant in this ticket. Existing controls produce some collateral failures, but collateral failures are not counted as detection. Raw run metadata and the shared-clock obligations remain outside the promoted coverage as specified in table 1.

## Removed unit tests

Table 3 lists each removed test and its replacement.

| File | Test | Reason |
| --- | --- | --- |
| typescript/kernel/runtime/test/runtime-kernel-run-liveness.test.ts | runLiveness.createLeasedRun returns a leased running record | Native creation status/owner and fencing rotation are exercised by lease_renewal; a truthy token adds no behavioral proof. |
| typescript/kernel/runtime/test/runtime-kernel-run-liveness.test.ts | runLiveness.renewLease rotates the fencing token for the same owner | lease_renewal checks native expiry, token rotation, stale token, competing owner, and observed expiry boundaries. |
| typescript/kernel/runtime/test/runtime-kernel-run-liveness.test.ts | runLiveness.listExpired excludes paused and non-expired runs | expired_listing covers fresh, expired, paused, failed, and completed runs and checks exact membership through the shared runner. |
| typescript/kernel/runtime/test/runtime-kernel-run-liveness.test.ts | runLiveness.preemptExpired checkpoints staged work and returns recovery state | stale_preemption observes advanced lineage, native consumed records, emptied staging, recovery consistency, and exclusion after preemption. |
| typescript/kernel/conformance-adapter/test/mutant-adapter.test.ts | kernel.accept-stale-owner-after-takeover activates through its detecting checks on memory | Replaced by shared-runner activation plus designated semantic failure; direct composite dispatch is obsolete. |
| typescript/kernel/conformance-adapter/test/mutant-adapter.test.ts | kernel.accept-stale-owner-after-takeover alters a designated observation before the adapter reports it | Response inequality alone is not certification; the shared runner grades native observations. |
| typescript/kernel/conformance-adapter/test/mutant-adapter.test.ts | kernel.lease-takeover-before-expiry activates through its detecting checks on memory | The old generated test expected no activation because its check needed shared-lease-clock. The syscall contract proves positive activation and detection instead. |

Retained: `run.completeStep returns the rotated lease token for leased running runs` covers token rotation performed by completeStep. The liveness migration does not exercise that path. Other runtime tests and legacy adapter tests remain when their behavior has not migrated.

## Code decisions and scope

- All clock values are plan literals. Both backend and worker domains are set explicitly; the traces keep them equal and make no clock-skew claim. Expired listing probes 19 ms and 21 ms around the 20 ms lease. Creation expiry assertions read the kernel-returned `createLeasedRun` results and require 20 ms in both renewal and listing traces. Listing assertion 7 independently requires the persisted expired record to report 20 ms. Expected values are plan literals, so the compiler no-echo rule is satisfied without reading forwarded arguments.
- Every check declares `kernel.protocol` and `kernel.run-liveness`, covering every step operation capability. `kernel.syscall` gates the plan.
- Exact error-code expectations are JSON Schemas in fixture.expected, read only by the runner. Existing `schemaValid` assertions reject a successful renewal without unresolved error-path operands. Projected instance creation and explicit syscall arguments never send those schemas to the adapter. A contract test prevents moving expectations into check.input, which instance creation forwards.
- Nonempty array membership uses `every` with explicit length. Preemption assertion 8 reads `consumedStagedResults` with length 1 and every task ID equal to `assistant_message`. A dropped result fails with resolved operands and receives implementation classification.
- No liveness boolean or arithmetic comparison between plan constants is asserted. Native fields, errors, cardinalities, and independent observations supply the evidence.
- Register the plan in all three authority-packet collections, following DB/DC precedent. This required registration is outside the ticket YAML path list but explicitly requested by the milestone brief.
- Remove runtime tests only as authorized by the milestone brief. No runtime, adapter, testkit, catalog, or shared harness behavior changes.
- Add `spec/conformance/kernel/fixtures/run-liveness/errors.json` as a required scope extension: it holds the expected canonical error schemas outside adapter-visible instance input. The fixture uses the existing input/expected split.
- Dependencies introduced: none. New public operations, protocols, or contract shapes: none. New path convention: non-codec liveness expectations live under fixtures/run-liveness/, separating them from the 54 pinned top-level codec vectors. The family uses the existing schemaValid assertion with runner-owned expected error schemas, explicit clocks, captures, and trace observations.
- Compatibility evidence may require regeneration because packet plans and control designations change. Reports under reports/compatibility are the permitted generated scope extension.
- No .constitution file was changed. The orchestrator owns incorporation of this map and triage into constitutional evidence.

The Bun async test API was checked against [Bun writing tests documentation](https://bun.com/docs/test/writing-tests). Execution uses the pinned Bun 1.4.2 and existing library versions. Exa tools were unavailable; repository catalogs and public bindings supplied API authority.

## Verification outcome

The three test-first regressions failed before the artifact changes and pass afterward. Every required final gate exits 0. The unmutated memory control passes 133/133 applicable checks; all 13 mutants activate and are killed. Full verification repeats the same successful mutation results.

Table 4 records verification commands and statuses.

| Command | Exit | Outcome |
| --- | --- | --- |
| `bun test typescript/kernel/conformance-adapter/test/memory-lifecycle-plans.test.ts --test-name-pattern 'liveness syscall claims\|expired listing probes\|preemption task assertion'` | 1 | Expected test-first failure: all three regressions fail against the original plan. |
| `bun test typescript/kernel/conformance-adapter/test/memory-lifecycle-plans.test.ts --test-name-pattern 'liveness syscall claims\|expired listing probes\|preemption task assertion'` | 0 | All three regressions pass after the fixes. |
| `bun test typescript/kernel/conformance-adapter/test/memory-lifecycle-plans.test.ts` | 0 | 8 tests pass; 2334 assertions; both lease controls fail their exact designated assertions. |
| `bun tools/conformance/plan-compiler/validate-plans.ts` | 0 | 41 plans validate; liveness syscall plan has zero certification violations. Existing report-mode violations remain outside this fix. |
| `bun run check` | 0 | Authority gates, formatting, affected typecheck, tests, and lint pass. |
| `bun run compatibility:check` | 0 | Compatibility check passes; evidence was nevertheless refreshed because assertion IDs changed. |
| `bun run compatibility:evidence` | 0 | Regenerated the three TypeScript kernel evidence files: memory, SQLite, PostgreSQL. |
| `bun run verify:kernel` | 0 | Kernel authority, typecheck, testkit, compatibility, and conformance pass. |
| `bun run conformance` | 0 | 133/133 unmutated memory checks pass; all 13 mutants activate and are killed; zero survived, equivalent, unsupported, or invalid. |
| `bun run lint` | 0 | Full workspace lint passes. |
| `bun tools/scripts/authority-guardrails/authority-guardrails.ts` | 0 | Authority guardrails pass. |
| `bun run verify` | 0 | Full verification passes, including 813 tooling tests, 42 workspace test projects, all 13 negative controls, exports, portability, and proving-host scenarios. |
| `git diff --check` | 0 | No whitespace errors. |

Table 5 records each mutant outcome from the direct conformance run.

| Mutant | Activations | Outcome | Designated failures |
| --- | --- | --- | --- |
| kernel.accept-noncanonical-cbor | 1 | killed | 1 |
| kernel.accept-stale-head-update | 1 | killed | 3 |
| kernel.accept-stale-owner-after-takeover | 4 | killed | 2 |
| kernel.delete-object-reachable-through-live-root | 6 | killed | 1 |
| kernel.drop-uncommitted-staged-result-on-recovery | 5 | killed | 2 |
| kernel.fault-seam-never-fires | 7 | killed | 0 (expected missing-fault-activation rejection) |
| kernel.lease-takeover-before-expiry | 3 | killed | 2 |
| kernel.never-sweep-eligible-objects | 25 | killed | 5 |
| kernel.noncanonical-changed-paths-order | 2 | killed | 1 |
| kernel.promote-staged-before-checkpoint | 4 | killed | 2 |
| kernel.resolve-object-across-scopes | 6 | killed | 2 |
| kernel.sweep-inside-grace-window | 18 | killed | 2 |
| kernel.wrong-opaque-object-hash | 86 | killed | 18 |

Raw per-mutant evidence is retained at `.cache/dc003-review-fix/negative-controls.json`. Command logs are retained under `.cache/dc003-review-fix/`. The final diff contains the syscall plan, control manifest, lifecycle regression tests, and three generated TypeScript kernel evidence files. This external obligation map is also updated. No `.constitution/` files changed, no commit was created, and no services were started, stopped, or reset.

Dependencies, patterns, conventions, and contract shapes introduced beyond the specification: none. Existing specification gaps SPEC-DC003-01 and SPEC-DC003-02 remain explicit; no profile is declared complete.


## Claim designation audit

The M4 review audit lists each remaining undetected syscall claim explicitly. Existing passing observations remain ordinary conformance evidence.

| Claim ID | Status | Reason |
| --- | --- | --- |
| `kernel.syscall.run-liveness.expired_listing` | Undetected | The premature-takeover control detects live-lease inclusion, not the complete expired-record membership claim; no dedicated membership mutant is designated. |
| `kernel.syscall.run-liveness.paused_run_excluded_from_expiry` | Undetected | The supplied controls contain no mutant that includes paused runs in expiry listing. |
| `kernel.syscall.run-liveness.stale_preemption` | Undetected | The supplied controls contain no designated mutant for the complete stale-preemption checkpoint and recovery claim; collateral failures do not count as detection. |
