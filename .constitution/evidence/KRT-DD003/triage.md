# KRT-DD003 triage

Rust passes 110 of 110 applicable checks, with 27 not applicable. The core syscall plan passes all 10 checks, including both fault controls. The extended syscall plan passes 36 applicable checks; seven edge-validation checks remain excluded. Evidence: a local run log (not retained) and a local run log (not retained) in the EPIC-DD worktree.

The kernel implements the seven edge validators. An exploratory run with `kernel.edge-validation` enabled passes every promoted edge syscall check. That capability also selects seven deprecated checks using `kernel.protocol.edge-validation`, which has no Rust adapter binding. The worker rules forbid adding adapter scenarios. The final manifest retains its prior exclusion rather than inventing a composite or claiming an unsupported adapter surface. This is a capability-coverage limitation for the lead to reconcile; it is not a missing kernel validator. The experimental failures remain recorded in this table.

M1 recorded 52 failures at backend clock control in `DD002-triage.md`. Each of those check IDs passes in the final M2 evidence. M2 supplies both explicit clocks before initialization. No clock default masks missing configuration.

Every failed conformance check observed during M2 appears in the table. Repeated failures appear for each run. The shared harness classifications are refined into the four human triage classes required by ADR-0081. No assertion or authority plan changed.

| Run and evidence | Check | Classification | Failure | Disposition |
| --- | --- | --- | --- | --- |
| a local run log (not retained) | `kernel.syscall.logical.recovery_state` | verification | kernel.turn.create.result: data must have required property 'parentTurnId' | Fixed nullable parent input and required nullable parent output; final check passes. |
| a local run log (not retained) | `kernel.syscall.reclamation.ciphertext_retention_and_unchanged_lineage` | verification | adapter_invalid_encoding: expected text argument parentTurnId | Fixed nullable parent input and required nullable parent output; final check passes. |
| a local run log (not retained) | `kernel.syscall.reclamation.grace_window_holds_under_active_lease` | verification | adapter_invalid_encoding: expected text argument parentTurnId | Fixed nullable parent input and required nullable parent output; final check passes. |
| a local run log (not retained) | `kernel.syscall.reclamation.leaseless_run_past_admin_expiry_does_not_pin_reclamation` | verification | adapter_invalid_encoding: expected text argument parentTurnId | Fixed nullable parent input and required nullable parent output; final check passes. |
| a local run log (not retained) | `kernel.syscall.reclamation.leaseless_run_within_admin_expiry_still_pins_reclamation` | verification | adapter_invalid_encoding: expected text argument parentTurnId | Fixed nullable parent input and required nullable parent output; final check passes. |
| a local run log (not retained) | `kernel.syscall.reclamation.reachability` | verification | adapter_invalid_encoding: expected text argument parentTurnId | Fixed nullable parent input and required nullable parent output; final check passes. |
| a local run log (not retained) | `kernel.syscall.run-liveness.expired_listing` | verification | adapter_invalid_encoding: expected text argument parentTurnId | Fixed nullable parent input and required nullable parent output; final check passes. |
| a local run log (not retained) | `kernel.syscall.run-liveness.lease_renewal` | verification | adapter_invalid_encoding: expected text argument parentTurnId | Fixed nullable parent input and required nullable parent output; final check passes. |
| a local run log (not retained) | `kernel.syscall.run-liveness.stale_preemption` | verification | adapter_invalid_encoding: expected text argument parentTurnId | Fixed nullable parent input and required nullable parent output; final check passes. |
| a local run log (not retained) | `kernel.syscall.controls.after_commit_before_ack` | verification | typed fault has no matching armed token and storage boundary | Fixed protocol error metadata encoding; the harness confirms the armed token and point. |
| a local run log (not retained) | `kernel.syscall.controls.before_commit` | verification | typed fault has no matching armed token and storage boundary | Fixed protocol error metadata encoding; the harness confirms the armed token and point. |
| a local run log (not retained) | `kernel-protocol-af.branch-set-head-rejects-lateral-lineage` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.run-begin-step-rejects-out-of-order-step` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.run-complete-rejects-missing-event-object` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.run-create-rejects-busy-branch` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.schema-register-rejects-duplicate-path` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.tree-create-rejects-missing-required-path` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.tree-diff-rejects-schema-mismatch` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel.syscall.kernel-protocol-af.branch-set-head-rejects-lateral-lineage` | implementation | kernel.run.complete emitted undeclared native error run_steps_incomplete | Removed an extra completion precondition absent from machine authority. The unchanged traces and revised native regression pass. |
| a local run log (not retained) | `kernel.syscall.reclamation.reachability` | verification | kernel.branch.setHead.result: data/archiveBranch must NOT have additional properties | Project branch observations to the catalog fields; stored archive metadata remains in the kernel. |
| a local run log (not retained) | `kernel.syscall.run-liveness.expired_listing` | implementation | kernel.run.complete emitted undeclared native error run_steps_incomplete | Removed an extra completion precondition absent from machine authority. The unchanged traces and revised native regression pass. |
| a local run log (not retained) | `kernel-protocol-af.branch-set-head-rejects-lateral-lineage` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.run-begin-step-rejects-out-of-order-step` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.run-complete-rejects-missing-event-object` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.run-create-rejects-busy-branch` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.schema-register-rejects-duplicate-path` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.tree-create-rejects-missing-required-path` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |
| a local run log (not retained) | `kernel-protocol-af.tree-diff-rejects-schema-mismatch` | verification | adapter_operation_not_implemented: rust kernel adapter does not implement kernel.protocol.edge-validation | The experimental capability enables an unimplemented deprecated composite. Do not claim the capability. The seven promoted syscall checks all pass experimentally; retain the prior capability exclusions pending the legacy migration. |

The first run reports 99/108 passing, the second reports 112/124, and the third reports 117/124. The third run has only the seven deprecated composite failures. The final run reports 110/110 passing after retaining the unsupported capability exclusion. The catalog, plans, fixtures, harness, inventory states, and authority files remain unchanged.

Further findings:

- Verification: the first broad `bun run check` fails discovery parity because M1 preserved failing compatibility evidence beside an inventory entry that declares `pass`. Refresh compatibility evidence after the Rust checks pass.
- Verification: M1's missing liveness and reclamation syscall bindings were hidden behind the clock failure. Add routing data to the existing public APIs. Expose the catalog's optional reclaim time through `maintenance_reclaim_at`; return ordered-path-chunk count from the native summary. Rust has no chunk storage, so that native count is zero.
- Verification: the first contract run fails three new assertions against the M1 artifact. It establishes missing clock enforcement, unsupported fault controls, and absent typed fault activation.
- Verification: an intermediate implementation fails to compile because it used `KernelRecord::String` and `Result::is_err_or`. Use the repository's `KernelRecord::Text` and the verified Rust `Result::is_ok_and` API.
- Verification: an intermediate contract assertion expects an absent recovery field. The catalog requires `lastCompletedStepId: null` before any completed step; correct the assertion.
- Verification: an intermediate native-test compile fails because the changed completion regression does not import `RunStatus`. Qualify the type.
- Environment: no service failure was observed during the focused conformance runs. The worker did not start, stop, or reset services.

The conformance feature is enabled only by the Rust adapter dependency. The production gRPC dependency graph excludes it. Plain kernel construction remains uninstrumented even when a workspace build unifies the feature. Fault controls operate on a private transaction draft under the instance storage lock, select occurrence once after successful work, and inject before publishing or after publishing. Intermediate durable-write phases and block mode return `kernel_fault_point_unsupported`. No persistence or process-crash profile is claimed.

Local implementation conventions introduced: a feature-gated test-control module; a transaction-draft wrapper around the existing Rust public actions; a checkpoint-write counter used only by the conformance feature; protocol error-metadata encoding distinct from tagged domain records. No package or version dependency was added. Existing `tuvren-kernel-rust` dependency enables `conformance` through Cargo CLI. The public optional reclaim-time method and complete reclamation summary follow catalog shapes. Test-only validation and lock errors use `kernel_test_clock_invalid`, `kernel_test_clock_required`, `kernel_test_fault_invalid`, `kernel_test_controls_required`, and `kernel_test_controls_poisoned`; these do not extend cross-language syscall error contracts.

No `.constitution/` file, kernel specification, plan, catalog, fixture, shared harness, or gRPC source changed. No commit, push, branch change, reset, stash, service lifecycle action, or agent delegation occurred.

All required verification gates pass. The final commands produce these results:

| Command | Exit | Outcome | Log |
| --- | --- | --- | --- |
| `bun run check` before refresh | 1 | Inherited failing evidence conflicts with the inventory `pass` state. | a local run log (not retained) |
| `bun run compatibility:evidence` | 0 | Refreshes the matrix and Rust evidence to `pass`; the discovery inventory needs no edit. | a local run log (not retained) |
| `bun run check` after refresh | 0 | Authority, discovery, affected targets, workspace Clippy, and 97 Rust tests pass. | a local run log (not retained) |
| `bun run conformance` | 0 | Rust passes 110/110 applicable checks; all inventory lanes finish as declared. TypeScript controls detect all 13 mutants. | a local run log (not retained) |
| `bun run verify:kernel` | 0 | Kernel authority, typechecks, tests, compatibility, and memory/SQLite/PostgreSQL conformance pass. | a local run log (not retained) |
| `bun run verify` | 0 | Full release gate passes, including 823 tooling acceptance tests, 42 project test targets, all boundary conformance, code generation, interop, export/portability, SQLite, and PostgreSQL proving hosts. | a local run log (not retained) |
| `bun run lint` | 0 | Full workspace lint passes. | a local run log (not retained) |
| `bun tools/scripts/authority-guardrails/authority-guardrails.ts` | 0 | Green evidence removes the M1 replay-path false positives. No scanner patch is needed. | a local run log (not retained) |
| `cargo test --workspace` | 0 | 97 tests pass; the final `check` repeats them after the last source changes. | a local run log (not retained), a local run log (not retained) |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | 0 | Passes with every feature enabled. | a local run log (not retained) |
| `cargo fmt --all -- --check` | 0 | Rust formatting passes. | a local run log (not retained) |
| `cargo build --offline -p tuvren-kernel-rust-grpc-service --target-dir a local run log (not retained) | 0 | Isolated production gRPC build passes without the feature. | a local run log (not retained) |
| `rustc` production API rejection probe | 1, expected | Both `testkit` and `with_test_controls` are unavailable in the production dependency. The probe's assertion script exits 0. | a local run log (not retained) |
| Shared harness with both protocol syscall plans | 0 | Packet plans are additive. Core 10/10 and extended 36/36 applicable checks pass, with seven extended capability exclusions. | a local run log (not retained) |

The production dependency graph assertion also runs automatically in the adapter contract tests. A separate native regression proves that ordinary kernel instances remain uninstrumented when a workspace build enables the feature through the adapter. Clock configuration uses `OnceLock<AtomicI64>`; missing configuration has an explicit `Option` state.

The expected assertion failures from the 13 activated TypeScript negative controls are successful detections, not additional implementation defects. Their outcome table and retained report path appear in a local run log (not retained). No Rust negative-control coverage or durability profile is claimed by this milestone.

Changed worktree files:

- `reports/compatibility/compatibility-matrix.json`
- `reports/compatibility/evidence/certification-harness.kernel-rust-certification.json`
- `rust/kernel-conformance-adapter/Cargo.toml`
- `rust/kernel-conformance-adapter/adapter.json`
- `rust/kernel-conformance-adapter/src/host_syscalls.rs`
- `rust/kernel-conformance-adapter/src/main.rs`
- `rust/kernel-conformance-adapter/src/observation_encoding.rs`
- `rust/kernel-conformance-adapter/src/syscall_values.rs`
- `rust/kernel-conformance-adapter/tests/syscall_contract.rs`
- `rust/kernel/Cargo.toml`
- `rust/kernel/src/lib.rs`
- `rust/kernel/src/memory.rs`
- `rust/kernel/src/types.rs`
- `rust/kernel/tests/kernel_baseline.rs`
- `rust/kernel/src/memory/conformance.rs`
- `rust/kernel/src/testkit.rs`
- `rust/kernel/tests/test_controls.rs`

The additional authorized report is `triage.md`. Logs and isolated build/probe artifacts remain under a local run log (not retained). The final working tree contains no `.constitution/` changes.
