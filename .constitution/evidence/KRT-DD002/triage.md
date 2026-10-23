KRT-DD002 triage (2026-10-23)

The shared harness reports 108 applicable Rust checks: 56 pass, 52 fail, and 29 are not applicable. All observed failures stop at `kernel.clock.set` for the backend domain, before syscall assertions run. The Rust kernel exposes one `InMemoryKernelOptions.now` callback, without independent backend and worker clock seams. The adapter rejects unsupported backend clock control instead of aliasing clocks or acknowledging an unused control.

Evidence: a local run log (not retained), a local run log (not retained), a local run log (not retained), and a local run log (not retained) in the EPIC-DD worktree. Replay: `bun tools/conformance/harness/run.ts --adapter rust/kernel-conformance-adapter/adapter.json --summary-only`. The harness adds packet plans to explicit `--plan` selections; this exploratory evidence therefore includes the packet suite.

Each row identifies an observed failed check. I1 means implementation finding: add separate clock injection in M2, then rerun the unchanged plans. No failure is waived.

| Failed check | Classification | Disposition |
| --- | --- | --- |
| `kernel.syscall.lineage.cross_thread_rejection` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.logical.branch_list` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.logical.diff_paths` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.logical.recovery_state` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.logical.thread_list` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-all-ones-bytes` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-all-ordered-paths` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-all-single-paths` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-all-zero-bytes` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-deep-path-schema` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-empty-bytes` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-large-bytes` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-many-staged-results` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-mixed-status-staged` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-multi-path-schema` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-non-utf8-bytes` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-single-byte` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-staged-failed` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-staged-interrupted` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-with-event-hash` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-with-prev-turn` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.deterministic_hashing.f-zero-turn-tree-hash` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.modify_composition` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.modify_composition.f-verdict-composition` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-all-ones-bytes` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-all-ordered-paths` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-all-single-paths` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-all-zero-bytes` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-deep-path-schema` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-empty-bytes` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-large-bytes` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-many-staged-results` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-mixed-status-staged` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-multi-path-schema` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-non-utf8-bytes` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-single-byte` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-staged-failed` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-staged-interrupted` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-with-event-hash` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-with-prev-turn` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.schema_roundtrip.f-zero-turn-tree-hash` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.protocol.tree_manifest_identity` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.reclamation.ciphertext_retention_and_unchanged_lineage` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.reclamation.grace_window_holds_under_active_lease` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.reclamation.leaseless_run_past_admin_expiry_does_not_pin_reclamation` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.reclamation.leaseless_run_within_admin_expiry_still_pins_reclamation` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.reclamation.reachability` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.run-liveness.expired_listing` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.run-liveness.lease_renewal` | implementation | I1: blocked on M2 clock seam |
| `kernel.syscall.run-liveness.stale_preemption` | implementation | I1: blocked on M2 clock seam |

Additional findings and verification failures are classified separately.

| Finding | Classification | Disposition |
| --- | --- | --- |
| Rust fault arming has no public kernel seam; core before-commit and after-commit-before-ack checks require `kernel.fault-injection`. | implementation | I2: M2; do not simulate faults or claim the capability. |
| Seven extended syscall rejection checks require `kernel.edge-validation`, which the Rust manifest does not claim. | verification | V1: M3 capability coverage. Native contract tests cover canonical errors, but the harness excludes these seven checks. |
| All protocol syscalls referenced by the two plans have public Rust APIs and routing entries (20 core and 16 extended distinct operations). | implementation | No missing-public-syscall stop condition. Clock and fault controls remain findings I1 and I2. |
| M1 protocol-plan acceptance depends on clock and fault work scheduled in M2, despite the ticket declaring no dependencies. | specification | S1: lead must reconcile milestone sequencing; acceptance remains incomplete. |
| Ticket acceptance could imply changing the legacy fixture-echo recovery composite. | specification | Resolved by explicit user instruction: preserve legacy composites; syscall `run.recover` reads live kernel state. |
| Initial check stopped on adapter manifest formatting. | verification | Fixed with Oxfmt; subsequent check passed. |
| Initial guardrail rejected tuple routing-table entries as operation branches. | verification | Fixed with a Rust `routing!` data macro using recognized key-to-binding entries; the routing scan passes. |
| Initial combined Rust test run changed the expectation for the distinct branch-set-head active-run guard. | verification | Corrected the test to retain `branch_has_active_run`; the catalogued run-create guard emits `kernel_runtime_branch_already_active`. |
| First verify:kernel run reports stale compatibility topology and declared capabilities. | verification | Refresh required after adding `kernel.syscall`; subsequent command outcomes are recorded below. |

No environment failure was observed in conformance. PostgreSQL-backed TypeScript checks pass. Rust memory certification, durable profiles, and negative-control coverage are not claimed by this milestone.

Code decisions: preserve native diff iteration over `BTreeMap` and test unsigned UTF-8 order and uniqueness; never sort in the adapter. Forward native payload code, message, and details. Keep transport failures outside `OperationOutcome`. Encode bytes and arbitrary records with ADR-0078 tags. Check numeric tokens before floating-point conversion.

Dependencies and conventions: no dependency or lockfile version was added. `serde_json` enables its existing `raw_value` feature through Cargo CLI. Adapter-local conventions are the `Observation` encoding trait, record-field macros, the `routing!` table macro, opaque instance handles, and JSON-text encoding of the native thread cursor tuple. No cross-language contract shape was introduced. Native node/run storage timestamps are omitted from protocol observations because the closed catalog shapes exclude them.

Scope drift: the user explicitly authorized gRPC error-code alignment, extending the YAML ticket path list to `rust/kernel-grpc-service`. No `.constitution/` file, conformance plan, operation catalog, or kernel specification was edited. No commit, branch change, service lifecycle command, or agent delegation occurred.

Final verification findings are recorded after preserving red compatibility evidence.

| Finding | Classification | Disposition |
| --- | --- | --- |
| V2: The annotation binding initially expected byte tags, but the catalog requires tagged records and the Rust API accepts canonical CBOR bytes. | verification | Fixed through the public Rust encoder. The extended recovery contract test failed first, then passed; it also verifies signals. |
| V3: Guardrails scans required failure replay commands as authority citations. It flags `rust/kernel` and `rust/kernel-conformance-adapter` in the refreshed evidence, across three authority packets. | verification | Unresolved outside M1's allowed paths. Preserve replay evidence. The lead must fix the scanner's treatment of diagnostic fields. Final guardrail exit is 1. |
| V4: Refreshed Rust evidence has status `fail`, but `tools/conformance/certification/certified-projects.json` lists Rust as `pass`. | verification | Unresolved outside M1's allowed paths. `check`, the final `conformance` preflight, `verify:kernel`, and `verify` fail on discovery/compatibility parity. Resolve native findings and refresh, or have the lead reconcile discovery state. |

The required guardrail exit-zero condition cannot be met within M1's allowed paths while retaining required failure replay evidence. No evidence was removed or assertion weakened. Compatibility refresh exits 0 and changes only the Rust evidence and compatibility matrix. The full conformance run reaches every inventory lane and reports only the Rust lane failing; a later run stops at V4 before dispatch. TypeScript negative controls report 13 activated, 13 detected, 0 survived, and 0 invalid. Their expected mutant assertion failures are successful negative-control detections, not additional defects.

The verification commands produced these outcomes. Logs are under a local run log (not retained) in the EPIC-DD worktree.

| Command | Exit status | Outcome and log |
| --- | --- | --- |
| `cargo test -p tuvren-kernel-rust-conformance-adapter --test syscall_contract` | 101 initially; 0 finally | Test-first baseline: four failures. Final six tests pass, including numeric-token, annotation, signal, recovery, and lifecycle checks. |
| `cargo test -p tuvren-kernel-rust --test kernel_baseline turn_update_head_accepts_lateral` | 101 initially | The old lateral guard rejected a legal descendant; the final workspace run passes the revised test. |
| `cargo test -p tuvren-kernel-rust --test kernel_baseline protocol_diff_and_step_errors_use_catalog_codes` | 101 initially | The old step code differed from the catalog; the final workspace run passes both code checks. |
| `cargo test -p tuvren-kernel-rust -p tuvren-kernel-rust-conformance-adapter` | 101, then 0 | Corrected the distinct branch-set-head guard expectation; kernel and adapter tests pass. |
| `cargo test -p tuvren-kernel-rust-conformance-adapter --test syscall_contract recovery_reads_live_kernel_state_and_native_errors_are_unchanged` | 101 initially; 0 in the final suite | V2 annotation conversion regression. |
| `cargo test --workspace` | 0 | 89 tests pass; `cargo-test-final.log`. |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | 0 | `clippy-final.log`. |
| `cargo fmt --all -- --check` | 0 | Also passes as the Rust formatting step of full verification. |
| `bun run check` | 1, 0, 0, 1 | Initial formatting fixed. Two runs pass, including workspace Clippy and tests. Final run stops on V4; `check-after-evidence.log`. |
| `bun run conformance` | 1 | Full lane: Rust 108 applicable, 56 pass, 52 fail, 29 not applicable; all other inventory lanes pass or are unsupported as declared. `conformance.log`. Final rerun stops on V4; `conformance-after-evidence.log`. |
| `bun tools/conformance/harness/run.ts --adapter rust/kernel-conformance-adapter/adapter.json --plan spec/conformance/kernel/plans/kernel-protocol-core-syscall.json --plan spec/conformance/kernel/plans/kernel-protocol-extended-syscall.json --evidence-out a local run log (not retained) --summary-only` | 1 | Packet plans are additive. Protocol core: 8 applicable, 0 pass, 8 fail, 2 fault checks excluded. Protocol extended: 36 applicable, 0 pass, 36 fail, 7 edge checks excluded. |
| `bun tools/conformance/harness/run.ts --adapter rust/kernel-conformance-adapter/adapter.json --evidence-out a local run log (not retained) --summary-only` | 1 | Final source measurement: 56/108 pass; the same 52 failed check IDs as the full conformance run. `rust-final.log`. |
| `bun run verify:kernel` | 1 twice | First: stale evidence. Final: V4 compatibility parity; `verify-kernel-final.log`. |
| `bun run compatibility:evidence` | 0 | Truthful red evidence refreshed; `compatibility-evidence.log`. |
| `bun run lint` | 0 | Two direct runs pass; full verification also passes workspace lint. `lint-final.log`. |
| `bun tools/scripts/authority-guardrails/authority-guardrails.ts` | 1, 0, 1 | Routing syntax fixed; final failure is V3. `guardrails-verified.log`. |
| `bun run verify` | 1 | Lint, formatting, authority validation, and meta-conformance pass. Discovery parity fails on V4; `verify.log`. |

The two protocol syscall plans do not pass. Their assertions remain unchanged. Clock failures prevent shared-plan validation of the new bindings; native and adapter contract tests provide narrower evidence only. M1 acceptance is incomplete pending I1, I2, and capability coverage reconciliation. No public protocol syscall API was invented. The ticket's requested `.constitution/` triage artifact is not written because worker rules forbid changes there; this file is the authorized replacement for the lead to reconcile.
