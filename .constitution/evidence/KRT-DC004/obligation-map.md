# KRT-DC004 obligation map

KRT-DC004 migrates the in-process checkpoint recovery obligations to `spec/conformance/kernel/plans/kernel-restart-recovery-syscall.json`. The legacy plan and composite handlers stay unchanged. The stable claim `kernel.crash-recovery.in_process_fault_points` appears in both syscall checks and every trace step. Architecture Decision Records ADR-0075, ADR-0076 decisions 4–6, and ADR-0079 govern the migration.

The kernel packet registers the plan as an authoritative source, conformance plan, and verification path. Its additive version changes from `0.13.0` to `0.14.0`. Applicability requires `kernel.syscall` and `kernel.restart-recovery`. Both checks declare `kernel.protocol` and `kernel.fault-injection`, covering every catalog capability their steps use.

Table 1. Legacy obligations and their syscall replacements

| Legacy observation under `kernel.crash-recovery.in_process_fault_points` | Syscall replacement | Authority and expectation source |
| --- | --- | --- |
| `beforeCommit.injectedErrorCode` | `before_commit` faulted-checkpoint native error assertion and root assertion 1 | ADR-0076: armed token matches the typed fault; native code is `kernel_persistence_fault_injected`. |
| `beforeCommit.headMatchesExpectedCheckpoint` | `before_commit` assertions 3–5, 9–10, 14 | §5.5: durable head and recovered hash equal the captured baseline checkpoint. |
| `beforeCommit.lineageConsistent` | `before_commit` assertions 14, 16–17 | Captured baseline node stays identical; public `node.walkBack` returns exactly the baseline and root. |
| `beforeCommit.pendingMessageCommitted = false` | `before_commit` assertion 15 | Public `tree.resolve` equals the earlier baseline message list; the pending message is absent. |
| `beforeCommit.recoveryStateConsistent` | `before_commit` assertions 6–8, 11–13 | §5.7: baseline step remains complete; consumed baseline results and intact pending staging equal earlier captures. |
| `beforeCommit.visibleCommittedMessageCount = 1` | `baselineMessages` cardinality and `before_commit` assertion 15 | Exact captured list equality replaces adapter counting. |
| `afterCommitBeforeAck.injectedErrorCode` | `after_commit_before_ack` faulted-checkpoint native error assertion and root assertion 1 | ADR-0076: typed fault carries the armed token after commit. |
| `afterCommitBeforeAck.headMatchesExpectedCheckpoint` | `after_commit_before_ack` assertions 3–5, 9, 18–20 | §5.5: changed durable head is captured before recovery; recovery matches that head, whose parent is the earlier baseline. |
| `afterCommitBeforeAck.lineageConsistent` | `after_commit_before_ack` assertions 19, 26–28 | Public lineage has exactly three nodes; its baseline node and root match earlier captures. |
| `afterCommitBeforeAck.pendingMessageCommitted = true` | `after_commit_before_ack` assertions 20–22, 25 | The node tree equals the pre-fault incorporated tree; consumed work and visible messages equal earlier pending captures. |
| `afterCommitBeforeAck.recoveryStateConsistent` | `after_commit_before_ack` assertions 6–8, 22–24 | §5.7: pending step is complete; consumed staging matches the pre-fault capture; both staging surfaces are empty. |
| `afterCommitBeforeAck.visibleCommittedMessageCount = 2` | `pendingMessages` cardinality and `after_commit_before_ack` assertion 25 | Exact captured list equality replaces adapter counting. |
| Reaching the requested fault point | Both checks, assertion 1; runner activation tracker | Matching arming token, typed error, and `faultActivated`; missing activation rejects the run. |
| Unsupported physical fault points | Parameterized public harness tests in `recovery-syscall-plans.test.ts` | Requests for all three remaining catalog points yield `unsupported`, never a silent skip or semantic pass. |

Both traces create a baseline checkpoint, stage pending work, prepare its tree through the public `tree.incorporate` surface, arm a checkpoint-scoped throw fault, attempt `completeStep`, and call public `run.recover`. The faulted `completeStep` omits `treeHash`, exercising kernel incorporation and tree storage inside the checkpoint transaction under §5.5 steps 1b and 2. The committed node's `turnTreeHash` must equal the earlier `capture.pendingTree`, providing an independent determinism check. Expected hashes come from earlier observations; the adapter selects no head and computes no boolean.

The conditional assertions encode only the two alternatives in the §5.5 all-or-nothing recovery invariant. Their predicate reads the native recovered step identifier. Unconditional assertions 8–9 pin each physical point to its required alternative, so a conditional cannot permit the opposite outcome. The baseline branch applies at `before-commit`; the committed branch applies at `after-commit-before-ack`. Public harness tests check branch application and token-matched activation across both points.

The three unsupported catalog points are exercised as isolated copies of the same trace. Adding unsupported points to the registered memory plan makes the entire unmutated run `unsupported`, preventing ADR-0079 baseline qualification. The isolated tests preserve explicit runner reporting while the registered memory plan certifies its two reachable points.

Table 2. Negative controls

| Mutant | Designated detection | Activation proof |
| --- | --- | --- |
| `kernel.drop-uncommitted-staged-result-on-recovery` | `kernel.syscall.logical.recovery_state.3.resultField`; `kernel.crash-recovery.in_process_fault_points.5.resultField`; `kernel.syscall.crash-recovery.before_commit.6.resultField` and `.12.resultField` | Existing testkit signal proves the nonempty recovery branch executed. |
| `kernel.promote-staged-before-checkpoint` | `kernel.crash-recovery.in_process_fault_points.2.resultField` through `.6.resultField`; `kernel.syscall.crash-recovery.before_commit.8.resultField` and `.9.resultField` | Existing testkit signal proves aborted checkpoint writes were promoted. |
| `kernel.fault-seam-never-fires` | Runner rejection `missing_fault_activation`, with both legacy recovery/concurrent-writer claims, both protocol control claims, and both M4 syscall point claims | Existing instrumentation signal proves the seam was disabled; an isolated mutated recovery trace proves rejection on this plan. |

Table 3. Removed assertions and tests

| Location | Removed coverage | Reason and replacement |
| --- | --- | --- |
| `typescript/kernel/testkit/test/kernel-conformance.test.ts` | Recovery-state literal fields and two staged-result length assertions in the logical-fixture test | Redundant with `typescript/kernel/certification/test/kernel-typescript-conformance.test.ts:258`: `expect(kernelProtocolLogicalFixtures).toEqual(fixtures.logical)` compares the complete exported logical fixtures with the validated authority fixtures. Public syscall recovery traces separately test runtime recovery behavior. Branch-list and tree-change fixture coverage stays. |
| `typescript/kernel/testkit/test/kernel-mutants.test.ts` | `the fault-seam mutant disarms every fault plan it receives` | It tests mutant wiring against a fake backend and checks the wrapper counter. Actual mutated recovery traces now prove missing-activation rejection; the negative-control gate also requires real mutant activation. |

Backend rollback, archival movement, fault-selector, occurrence, retry, and concurrent-writer unit tests stay because these traces do not replace their obligations. Concurrent-writer migration and durable process restart are outside KRT-DC004.

No recovery reconciliation or adapter behavior change is required. No dependency, public API, observation shape, contract shape, or production pattern is introduced. Packet registration and generated compatibility evidence are necessary companion changes outside the ticket's listed implementation directories. The requested reports were written by the worker and filed here by the lead under the worker rules; the epic lead owns any constitutional evidence reconciliation.

Verification completes with exit 0 for `bun run check`, `bun run verify:kernel`, `bun run conformance`, `bun run verify`, `bun run lint`, and the authority guardrails command. `bun run compatibility:evidence` also exits 0. The full release gate checks the refreshed evidence and formatter output. All 13 negative controls activate and are killed against an unmutated 133/133 passing baseline. See triage.md in this directory for earlier verification failures, per-mutant outcomes, and command results.


## Claim designation audit

The M4 review audit covers every check and step claim in all six `*-syscall.json` kernel plans. The restored control entries are additive: recovery-state and legacy fault assertions remain designated alongside the M4 assertions. The fault-seam control retains both legacy recovery/concurrent-writer claims and both protocol control claims, plus both M4 point claims.

Across 65 checks, all 72 distinct claim IDs are accounted for: 33 have a designated detector and 39 have an explicit undetected reason. The reclamation/scope claims are listed in `KRT-DC002/obligation-map.md`; the liveness claims are listed in `KRT-DC003/obligation-map.md`. The protocol claims without detectors are listed in table 5. No claim is unaccounted for. An instrumentation detector uses the expected runner rejection rather than a semantic assertion.

The saved mutation report verifies detection for all 33 designated claims against the passing 133/133 unmutated baseline. Each detector activates and produces a designated failure for that claim, or the expected instrumentation rejection. The machine-readable audit and mutation report are retained at local run logs (not retained).

Table 4. Audit totals by syscall plan

| Plan | Claims | Designated | Undetected with reason | Unaccounted |
| --- | --- | --- | --- | --- |
| `kernel-protocol-core-syscall.json` | 12 | 5 | 7 | 0 |
| `kernel-protocol-extended-syscall.json` | 43 | 17 | 26 | 0 |
| `kernel-reclamation-syscall.json` | 7 | 6 | 1 | 0 |
| `kernel-restart-recovery-syscall.json` | 3 | 3 | 0 | 0 |
| `kernel-run-liveness-syscall.json` | 5 | 2 | 3 | 0 |
| `kernel-scope-isolation-syscall.json` | 2 | 0 | 2 | 0 |

Table 5. Protocol claims without designated detectors

| Claim ID | Status | Reason |
| --- | --- | --- |
| `kernel.syscall.lineage.cross_thread_rejection` | Undetected | The supplied controls contain no mutant that accepts a cross-thread node in branch lineage. |
| `kernel.syscall.logical.branch_list` | Undetected | The supplied controls contain no branch-enumeration omission or pagination mutant. |
| `kernel.syscall.protocol.modify_composition` | Undetected | The supplied controls contain no verdict-composition mutant. |
| `kernel.syscall.protocol.node_identity_walk` | Undetected | The supplied controls contain no TurnNode identity or lineage-walk corruption mutant. |
| `kernel.syscall.protocol.schema_canonical_cbor` | Undetected | The noncanonical-CBOR control targets decoder acceptance, not schema encoding; no schema-encoding mutant is designated. |
| `kernel.syscall.protocol.schema_roundtrip` | Undetected | The supplied controls contain no schema registration or roundtrip corruption mutant. |
| `kernel.syscall.protocol.tree_manifest_identity` | Undetected | The supplied controls contain no tree-manifest or TurnTree identity corruption mutant. |
| `kernel.syscall.kernel-protocol-af.branch-set-head-rejects-lateral-lineage` | Undetected | The supplied controls contain no mutant that bypasses this native validation or rejection; the legacy stale-head control does not designate this syscall assertion. |
| `kernel.syscall.kernel-protocol-af.run-begin-step-rejects-out-of-order-step` | Undetected | The supplied controls contain no mutant that bypasses this native validation or rejection; the legacy stale-head control does not designate this syscall assertion. |
| `kernel.syscall.kernel-protocol-af.run-complete-rejects-missing-event-object` | Undetected | The supplied controls contain no mutant that bypasses this native validation or rejection; the legacy stale-head control does not designate this syscall assertion. |
| `kernel.syscall.kernel-protocol-af.run-create-rejects-busy-branch` | Undetected | The supplied controls contain no mutant that bypasses this native validation or rejection; the legacy stale-head control does not designate this syscall assertion. |
| `kernel.syscall.kernel-protocol-af.schema-register-rejects-duplicate-path` | Undetected | The supplied controls contain no mutant that bypasses this native validation or rejection; the legacy stale-head control does not designate this syscall assertion. |
| `kernel.syscall.kernel-protocol-af.tree-create-rejects-missing-required-path` | Undetected | The supplied controls contain no mutant that bypasses this native validation or rejection; the legacy stale-head control does not designate this syscall assertion. |
| `kernel.syscall.kernel-protocol-af.tree-diff-rejects-schema-mismatch` | Undetected | The supplied controls contain no mutant that bypasses this native validation or rejection; the legacy stale-head control does not designate this syscall assertion. |
| `kernel.syscall.logical.thread_list` | Undetected | The supplied controls contain no thread-enumeration omission or pagination mutant. |
| `kernel.syscall.protocol.modify_composition.f-verdict-composition` | Undetected | The supplied controls contain no verdict-composition mutant for this fixture. |
| `kernel.syscall.protocol.schema_roundtrip.f-all-ones-bytes` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-all-ordered-paths` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-all-single-paths` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-all-zero-bytes` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-deep-path-schema` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-empty-bytes` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-large-bytes` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-many-staged-results` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-mixed-status-staged` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-multi-path-schema` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-non-utf8-bytes` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-single-byte` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-staged-failed` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-staged-interrupted` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-with-event-hash` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-with-prev-turn` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
| `kernel.syscall.protocol.schema_roundtrip.f-zero-turn-tree-hash` | Undetected | The supplied controls contain no schema-roundtrip corruption mutant for this fixture; hashing controls do not designate roundtrip assertions. |
