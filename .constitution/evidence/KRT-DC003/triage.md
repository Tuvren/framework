# KRT-DC003 triage

Table 1 records development and verification failures. V means verification, S means specification gap, E means environment, and I means an implementation observation.

| Run or evidence | Check or failure | Class | Resolution |
| --- | --- | --- | --- |
| `.cache/dc003-test-first.log`, exit 1 | Missing syscall plan and lease controls still designated to legacy assertions | V | Expected test-first failure. Added the plan and migrated designations. |
| Initial plan assessment | lease_renewal, expired_listing: resultField incorrectly addressed native error state | V | Used the state observation domain, then schemaValid for optional expected error envelopes. |
| Initial plan assessment | lease_renewal token comparison and stale_preemption head, staging, lineage, and recovery comparisons used an incomplete context root | V | Corrected expected operands to `$.result.trace.*`. |
| Intermediate negative-control report `.cache/verification/run-3584484-ThT7Wh/0.log` | Lease designated syscall assertions absent because registration had not yet been written | V | Completed all authority-packet registration collections. |
| Intermediate lease negative-control report `.cache/verification/run-3586491-I8mY0b/0.log` | accept-stale-owner-after-takeover: absent expected error-code operands and absent expired-list element invalidated the mutant run | V | Existing schemaValid assertions require the exact canonical error code without dereferencing an absent expected error. Array assertions read the native collection with cardinality. |
| Intermediate negative-control report `.cache/verification/run-3595378-3Sd9Fz/3.log` | sweep-inside-grace-window: expired_listing and stale_preemption indexed absent expired-run records, invalidating an otherwise detected mutant | V | Replaced indexed membership reads with every plus explicit length; empty native lists fail semantically. |
| `.cache/dc003-check.log`, exit 1 | kernel-testkit/test/kernel-mutants.test.ts: designated renewal assertion lacked the control's live-lease claim | V | Added the live-lease claim to the renewal check and its steps. `check` retry passes. |
| `.cache/dc003-verify-kernel.log`, exit 1 | Compatibility matrix TypeScript memory/SQLite/PostgreSQL check IDs and Rust/Go/Python/Dart non-applicable inventories were stale | V | Refresh with `bun run compatibility:evidence`, then rerun verification. |
| `.cache/dc003-expectation-test-first.log`, exit 1 | Harness projected createInstance forwards check.input, which contained expected error schemas | V | Move schemas to fixture.expected and require all schemaValid expectations to use that runner-only source. No harness or adapter code changes. |
| `.cache/dc003-check-final.log`, exit 1 | TypeScript pins the expanded vector inventory and Rust verifies every_committed_vector_matches_the_rust_encoder_and_identity_recipes; placing error schemas beside codec vectors changed the inventory from 54 to 55 | V | Put non-codec expectations under `fixtures/run-liveness/errors.json`; preserve all 54 codec vectors and their existing inventory assertions. |
| SPEC-DC003-01; obligation map table 1 | Native run metadata after pause/preemption is not exposed by a catalogued syscall | S | Preserve the unchanged legacy obligations. Do not claim direct failed/paused status, persisted preemption reason, or removed lease fields from weaker observations. Orchestrator owns the follow-up authority decision. |
| SPEC-DC003-02; obligation map | Catalog omits `kernel_runtime_run_lease_not_expired`, preventing a direct premature-preemption rejection assertion | S | Re-designate the existing memory mutant to live-lease expiry listing; do not add an unapproved error or operation shape. |
| ADR-0076 STOP rule; obligation map table 1 | Clock-skew preemption needs a shared backend clock | S | Move all 10 legacy clock-skew assertions to kernel.shared-backend; legacy plan remains unchanged. Remove the constant-comparison workerClockWouldExpire assertion when that family migrates. |

The full conformance lane exits 0. The unmutated memory control passes 131/131 applicable checks (135 total, 4 excluded). All 13 mutants activate and are killed: zero survived, equivalent, unsupported, or invalid. Negative controls retain the existing report mode. Raw report: `(local path, not retained)`. No unmutated conformance failure remains. No E failure or ENOSPC occurred.

## Final negative controls

Table 2 records every per-mutant outcome. Raw artifacts contain all failed assertions, operands, observations, and replay commands.

| Mutant | Activations | Outcome | Designated failures | Collateral failures | Raw evidence |
| --- | --- | --- | --- | --- | --- |
| kernel.accept-noncanonical-cbor | 1 | killed | 1 | 0 | `(local path, not retained)` |
| kernel.accept-stale-head-update | 1 | killed | 3 | 0 | `(local path, not retained)` |
| kernel.accept-stale-owner-after-takeover | 4 | killed | 2 | 5 | `(local path, not retained)` |
| kernel.delete-object-reachable-through-live-root | 6 | killed | 1 | 4 | `(local path, not retained)` |
| kernel.drop-uncommitted-staged-result-on-recovery | 4 | killed | 2 | 5 | `(local path, not retained)` |
| kernel.fault-seam-never-fires | 5 | killed | 0 | 15 | `(local path, not retained)` |
| kernel.lease-takeover-before-expiry | 3 | killed | 2 | 3 | `(local path, not retained)` |
| kernel.never-sweep-eligible-objects | 25 | killed | 5 | 9 | `(local path, not retained)` |
| kernel.noncanonical-changed-paths-order | 2 | killed | 1 | 2 | `(local path, not retained)` |
| kernel.promote-staged-before-checkpoint | 2 | killed | 5 | 0 | `(local path, not retained)` |
| kernel.resolve-object-across-scopes | 6 | killed | 2 | 0 | `(local path, not retained)` |
| kernel.sweep-inside-grace-window | 18 | killed | 2 | 13 | `(local path, not retained)` |
| kernel.wrong-opaque-object-hash | 86 | killed | 18 | 21 | `(local path, not retained)` |

Table 3 groups every failed check from that run, including collateral failures. All failures are expected injected defects or the expected instrumentation rejection. Each row counts every failing assertion in its raw evidence from table 2.

| Mutant | Failed check | Class | Failing assertions |
| --- | --- | --- | --- |
| kernel.accept-noncanonical-cbor | kernel.protocol.canonical_rejection | I (injected) | 1 |
| kernel.accept-stale-head-update | kernel.crash-recovery.concurrent_writer | I (injected) | 3 |
| kernel.accept-stale-owner-after-takeover | kernel.run-liveness.lease_renewal | I (injected) | 2 |
| kernel.accept-stale-owner-after-takeover | kernel.syscall.run-liveness.lease_renewal | I (injected) | 5 |
| kernel.delete-object-reachable-through-live-root | kernel.reclamation.reachable_from_live_root_is_retained | I (injected) | 2 |
| kernel.delete-object-reachable-through-live-root | kernel.syscall.reclamation.reachability | I (injected) | 3 |
| kernel.drop-uncommitted-staged-result-on-recovery | kernel.logical.recovery_state | I (injected) | 1 |
| kernel.drop-uncommitted-staged-result-on-recovery | kernel.syscall.logical.recovery_state | I (injected) | 4 |
| kernel.drop-uncommitted-staged-result-on-recovery | kernel.syscall.reclamation.grace_window_holds_under_active_lease | I (injected) | 1 |
| kernel.drop-uncommitted-staged-result-on-recovery | kernel.crash-recovery.in_process_fault_points | I (injected) | 1 |
| kernel.fault-seam-never-fires | kernel.syscall.controls.after_commit_before_ack | V (expected rejection) | 3 |
| kernel.fault-seam-never-fires | kernel.syscall.controls.before_commit | V (expected rejection) | 3 |
| kernel.fault-seam-never-fires | kernel.crash-recovery.concurrent_writer | I (injected) | 2 |
| kernel.fault-seam-never-fires | kernel.crash-recovery.in_process_fault_points | I (injected) | 7 |
| kernel.lease-takeover-before-expiry | kernel.syscall.run-liveness.expired_listing | I (injected) | 4 |
| kernel.lease-takeover-before-expiry | kernel.syscall.run-liveness.lease_renewal | I (injected) | 1 |
| kernel.never-sweep-eligible-objects | kernel.reclamation.grace_window_holds_under_active_lease | I (injected) | 1 |
| kernel.never-sweep-eligible-objects | kernel.reclamation.leaseless_run_past_admin_expiry_does_not_pin_reclamation | I (injected) | 1 |
| kernel.never-sweep-eligible-objects | kernel.reclamation.reachable_from_live_root_is_retained | I (injected) | 1 |
| kernel.never-sweep-eligible-objects | kernel.reclamation.unreachable_past_grace_is_released | I (injected) | 2 |
| kernel.never-sweep-eligible-objects | kernel.syscall.reclamation.grace_window_holds_under_active_lease | I (injected) | 1 |
| kernel.never-sweep-eligible-objects | kernel.syscall.reclamation.leaseless_run_past_admin_expiry_does_not_pin_reclamation | I (injected) | 1 |
| kernel.never-sweep-eligible-objects | kernel.syscall.reclamation.reachability | I (injected) | 7 |
| kernel.noncanonical-changed-paths-order | kernel.logical.diff_paths | I (injected) | 1 |
| kernel.noncanonical-changed-paths-order | kernel.syscall.logical.diff_paths | I (injected) | 2 |
| kernel.promote-staged-before-checkpoint | kernel.crash-recovery.in_process_fault_points | I (injected) | 5 |
| kernel.resolve-object-across-scopes | kernel.scope-isolation.store_get_is_scope_confined | I (injected) | 1 |
| kernel.resolve-object-across-scopes | kernel.scope-isolation.store_has_is_scope_confined | I (injected) | 1 |
| kernel.sweep-inside-grace-window | kernel.reclamation.grace_window_holds_under_active_lease | I (injected) | 1 |
| kernel.sweep-inside-grace-window | kernel.reclamation.leaseless_run_within_admin_expiry_still_pins_reclamation | I (injected) | 1 |
| kernel.sweep-inside-grace-window | kernel.syscall.reclamation.grace_window_holds_under_active_lease | I (injected) | 2 |
| kernel.sweep-inside-grace-window | kernel.syscall.reclamation.leaseless_run_within_admin_expiry_still_pins_reclamation | I (injected) | 2 |
| kernel.sweep-inside-grace-window | kernel-restart-af.expired-running-requires-preemption | I (injected) | 1 |
| kernel.sweep-inside-grace-window | kernel.run-liveness.expired_listing | I (injected) | 1 |
| kernel.sweep-inside-grace-window | kernel.run-liveness.stale_preemption | I (injected) | 1 |
| kernel.sweep-inside-grace-window | kernel.syscall.run-liveness.expired_listing | I (injected) | 3 |
| kernel.sweep-inside-grace-window | kernel.syscall.run-liveness.lease_renewal | I (injected) | 1 |
| kernel.sweep-inside-grace-window | kernel.syscall.run-liveness.stale_preemption | I (injected) | 2 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-all-ones-bytes | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-all-ordered-paths | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-all-single-paths | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-all-zero-bytes | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-deep-path-schema | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-empty-bytes | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-large-bytes | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-many-staged-results | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-mixed-status-staged | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-multi-path-schema | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-non-utf8-bytes | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-single-byte | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-staged-failed | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-staged-interrupted | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-with-event-hash | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-with-prev-turn | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.protocol.deterministic_hashing.f-zero-turn-tree-hash | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-all-ones-bytes | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-all-ordered-paths | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-all-single-paths | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-all-zero-bytes | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-deep-path-schema | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-empty-bytes | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-large-bytes | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-many-staged-results | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-mixed-status-staged | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-multi-path-schema | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-non-utf8-bytes | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-single-byte | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-staged-failed | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-staged-interrupted | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-with-event-hash | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-with-prev-turn | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.protocol.deterministic_hashing.f-zero-turn-tree-hash | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.reclamation.grace_window_holds_under_active_lease | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.reclamation.leaseless_run_within_admin_expiry_still_pins_reclamation | I (injected) | 1 |
| kernel.wrong-opaque-object-hash | kernel.syscall.scope-isolation.own_content | I (injected) | 1 |

The final outcome does not turn an unmutated red check green. Corrected V failures are recorded in table 1; S gaps remain explicit in the obligation map. The orchestrator owns constitutional triage and any follow-up decisions.

## Final verification

Table 4 records command exit statuses. Earlier V failures and their fixes are in table 1.

| Command | Exit status | Outcome and log |
| --- | --- | --- |
| `bun test typescript/kernel/conformance-adapter/test/memory-lifecycle-plans.test.ts` | 1 during red phases; 0 after plan fixes | Development contract test reached 4 pass; the added expectation-source regression and all 5 family tests pass in the final check lane. |
| `bun test typescript/kernel/conformance-adapter/test/memory-lifecycle-plans.test.ts --test-name-pattern 'lease error expectations'` | 1, expected | Test-first regression exposed adapter-visible expected schemas; fixed with fixture.expected. `.cache/dc003-expectation-test-first.log`. |
| `bun run check` | Attempts: 1, 0, 1, 0 | Final source and artifact checks pass. `.cache/dc003-check-final-retry.log`. The two corrected failures were the claim designation and codec inventory placement. |
| `bun run compatibility:evidence` | 0 | Refreshed eight generated compatibility files. `.cache/dc003-compatibility-evidence.log`. |
| `bun run verify:kernel` | Attempts: 1, 0 | Initial stale compatibility evidence was corrected. Final memory, SQLite, PostgreSQL, and portable kernel lanes pass. `.cache/dc003-verify-kernel-final.log`. |
| `bun run conformance` | 0 | Fleet passes; memory control 131/131 applicable, all 13 mutants killed with activation. `.cache/dc003-conformance.log`. |
| `bun run lint` | 0, repeated | Full workspace lint passes standalone and in verify. `.cache/dc003-lint-final.log`. |
| `bun tools/scripts/authority-guardrails/authority-guardrails.ts` | 0, repeated | Guardrails pass standalone and in verify. `.cache/dc003-guardrails-final.log`. |
| `bun run verify` | 0 | Every phase passes, including 813 tooling acceptance tests, code generation, Rust/Go/Python/Dart lanes, both host scenarios, and interop smoke. `.cache/dc003-verify.log`. |
| `git diff --check` | 0 | No whitespace errors. |
| `git diff --exit-code -- spec/conformance/kernel/plans/kernel-run-liveness.json` | 0 | Legacy plan unchanged. |

The full verify gate repeats the same 77 expected failed mutant checks and the same 13 killed outcomes. Table 3 uses that final gate's retained evidence. No remaining unmutated I or E finding exists; the two S gaps and the shared-backend STOP remain explicit. No commit, service lifecycle operation, agent invocation, dependency addition, or .constitution edit occurred.
