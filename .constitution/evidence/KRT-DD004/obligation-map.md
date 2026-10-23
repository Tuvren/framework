# KRT-DD004 Rust composite obligation map

Every instance-bound dispatch now goes through the Rust syscall routing table or fails with an adapter protocol error. An unknown syscall cannot fall through into a legacy composite. Legacy requests without an instance retain their handlers and plans. No authority assertion, expected value, fixture, or plan changed.

The shared harness runs the syscall manifest with `--capability kernel.syscall`. The certification wrapper also runs the original manifest, preserving the legacy codec obligations required by OD-16. Its test target runs the Rust Cargo contracts and both added tooling suites, with explicit harness, authority, schema, and Rust-source cache inputs. The duplicate coverage is intentional during migration: do not sum the two lane counts as distinct checks.

Table 1. Composite obligations and their syscall disposition

| Legacy operation or obligation | Syscall replacement | Disposition and evidence |
| --- | --- | --- |
| `kernel.protocol.deterministic-hashing`: opaque-object hash | `kernel.store.put` and `kernel.store.get`; `kernel.syscall.protocol.deterministic_hashing*` | Shared plans retain committed expected hashes. Rust wrong-hash mutation activates and fails 18 designated assertions. |
| `kernel.protocol.deterministic-hashing`: deterministic record and identity encodings | Identity assertions on returned records in the syscall plans, plus the original legacy codec checks | Legacy codec coverage remains under OD-16. No successful implementation output generated expectations. |
| `kernel.protocol.schema-roundtrip` | `kernel.schema.register`, `kernel.schema.get`, `kernel.tree.create`, `kernel.tree.incorporate`, `kernel.tree.manifest` in the schema-roundtrip traces | Syscall plans check implementation-returned records. Legacy codec roundtrips remain in the original lane. |
| `kernel.protocol.modify-composition` | `kernel.verdicts.compose`; `kernel.syscall.protocol.modify_composition` and its `f-verdict-composition` fixture check | Tagged kernel records cross the bridge losslessly; the shared harness owns comparisons. |
| `kernel.protocol.canonical-rejection` | No promoted decoder syscall | Legacy-only obligation retained under OD-16. The canonical decoder is not invented as a kernel syscall. |
| `kernel.logical.diff-paths` | `kernel.tree.diff`; `kernel.syscall.logical.diff_paths` | Native order is returned unchanged; no adapter sorting or expected-path derivation. |
| `kernel.logical.branch-list` | `kernel.branch.create`, `kernel.branch.get`, `kernel.branch.list`; `kernel.syscall.logical.branch_list` | Actual records replace composite verdicts in the syscall lane. |
| `kernel.logical.thread-list` | `kernel.thread.create`, `kernel.thread.list`; `kernel.syscall.logical.thread_list` | Native page order and opaque cursors are preserved. |
| `kernel.logical.recovery-state`, which echoes fixture data in the legacy handler | `kernel.run.recover`, `kernel.staging.current`, `kernel.node.get`, `kernel.tree.resolve`; `kernel.syscall.logical.recovery_state` | Live retained state supplies completed-step identity, consumed work, and uncommitted work. The fixture-echo handler is unreachable from instance-bound dispatch. The drop-staged mutant fails three designated syscall assertions. |
| `kernel.lineage.cross-thread-rejection` | `kernel.branch.create` against a captured foreign root; `kernel.syscall.lineage.cross_thread_rejection` | The native error code crosses unchanged. |
| `kernel.turn.lateral-head-guard` | `kernel.turn.updateHead` as a native routing entry | The helper remains legacy-only. There is no promoted syscall assertion claiming this unregistered helper's exact legacy result object. No authority obligation was deleted. |
| `kernel.run-liveness.lease-renewal` | `kernel.runLiveness.createLeasedRun`, `kernel.runLiveness.renewLease`, `kernel.runLiveness.listExpired`; `kernel.syscall.run-liveness.lease_renewal` | The plan checks lease values, owner errors, stale-token errors, and live-lease exclusion. |
| `kernel.run-liveness.expired-listing`, including paused-run exclusion | `kernel.runLiveness.listExpired` with plan-driven clock changes; `kernel.syscall.run-liveness.expired_listing` | The native run records are the observations. |
| `kernel.run-liveness.stale-preemption`, including expired-running recovery | `kernel.runLiveness.preemptExpired`, `kernel.staging.current`, `kernel.run.recover`, `kernel.branch.get`, `kernel.node.get`; `kernel.syscall.run-liveness.stale_preemption` | The plan observes preserved staged work and checkpoint lineage. |
| `kernel.reclamation.reclaim-probe`: unreachable release and archived-branch release | `kernel.maintenance.reclaim`, `kernel.store.has`, `kernel.store.get`, `kernel.branch.get`, `kernel.branch.list`; `kernel.syscall.reclamation.reachability` | The plan drives the fork, rewind, and sweep and checks raw storage results. |
| `kernel.reclamation.reclaim-probe`: reachable and shared-object retention | The same reachability trace, including actual live roots and post-sweep reads | The reachable-delete mutant activates inside reclamation and fails the designated retention assertion. |
| `kernel.reclamation.reclaim-probe`: active-lease grace | `kernel.syscall.reclamation.grace_window_holds_under_active_lease` | Actual leased-run state and independent clock controls replace adapter-computed grace verdicts. |
| `kernel.reclamation.reclaim-probe`: leaseless administrative expiry | `kernel.syscall.reclamation.leaseless_run_within_admin_expiry_still_pins_reclamation` and `kernel.syscall.reclamation.leaseless_run_past_admin_expiry_does_not_pin_reclamation` | Both sides of the authority boundary pass without plan changes. |
| `kernel.reclamation.erasure-probe`: ciphertext and referencing lineage retention | `kernel.syscall.reclamation.ciphertext_retention_and_unchanged_lineage` | The syscall trace returns actual stored ciphertext, branch heads, turn nodes, and trees before and after reclamation. |
| `kernel.reclamation.erasure-probe`: adapter-held key deletion and inability to decrypt | No kernel obligation under ADR-0079 and kernel specification §9.4 | Removed from the syscall path. Host crypto-shredding remains outside kernel certification; the legacy probe remains reachable only through legacy plans. |

Table 2. Added family coverage and deferred obligations

| Family or obligation | Checks | Disposition |
| --- | --- | --- |
| Scope own-content and own-enumeration | `kernel.syscall.scope-isolation.own_content`, `kernel.syscall.scope-isolation.own_enumeration` | Both pass in Rust. Instances own independent retained stores. |
| Shared-substrate cross-scope reads and enumeration | The three legacy `kernel.scope-isolation.*` obligations | Not certified by the Rust syscall lane. The trace contract lacks a shared-substrate multi-instance construction seam, and Rust has no shared substrate. Recorded as S1 in `DD004-triage.md`; no replacement verdict was fabricated. |
| Retained-process recovery before commit | `kernel.syscall.crash-recovery.before_commit` | Pass. Native fault activation token, unchanged head, durable uncommitted work, retry, and final lineage are observed. |
| Retained-process recovery after commit before acknowledgment | `kernel.syscall.crash-recovery.after_commit_before_ack` | Pass. The native committed head and consumed staging survive the typed fault. |
| Writer race | Legacy `kernel.crash-recovery.concurrent_writer` and the orchestration epic's reviewed scheduling trace | Deferred to the orchestration epic. No sequential adapter scenario stands in for simultaneous native entry. |
| Persistent reopen, process crash, and shared backend | Their durable/shared capability-gated plans | Unsupported for the process-local Rust kernel; no serialization or durability claim added. |
| Seven protocol edge checks requiring `kernel.edge-validation` | Listed individually in the disagreement report and triage table | Remain outside Rust applicability. This pre-existing coverage difference is explicit, not a removed obligation. |

Table 3. Tests and authority retained or replaced

| Artifact | Action | Reason |
| --- | --- | --- |
| Existing Rust syscall contract tests | Retained | They validate public transport behavior, lossless encoding, native errors, instance lifetimes, and fault controls. |
| Rust composite entry from instance-bound dispatch | Rejected by a new public-protocol test | Prevent fixture echoes and adapter verdicts from supplying syscall evidence. |
| Routing for every operation in all four memory plans | Added public-protocol assertion | A missing binding produces a different protocol error from a routed call with an invalid handle. The full harness then tests valid behavior. |
| Rust representative mutant controls | Added shared-runner integration test | Require a passing control, positive activation count, and a failing designated semantic assertion for all three mutants. |
| All four Rust memory families | Added shared-runner integration test | Assert every check in each authoritative plan appears with passing shared-harness evidence. |
| Cross-implementation comparison | Added synthetic tests and generated actual report | Detect changed observations, outcomes, and applicability; ignore JSON object key order while preserving array order. |
| Language-neutral mutant manifest | Retained unchanged | The three Rust controls reuse its IDs, signals, profiles, and designated assertions. No language-specific assertion IDs or duplicate controls were introduced. |
| Authority plans and expectations | Retained unchanged | Migration cannot weaken a plan to certify Rust. |
| Existing legacy unit tests | None removed | This milestone removes access to composites from the syscall dispatch path, not the legacy compatibility lane. Their retained obligations remain executable. |

Verification evidence lives under a local run log (not retained) and a local run log (not retained). The epic lead can file the generated report using its `manifest.json`; the worker does not write `.constitution/`.
