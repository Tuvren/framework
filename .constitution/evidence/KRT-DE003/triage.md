# Concurrent writer review-fix triage

> Working record kept as triaged at the time. Paths under `.cache/` were worker-local run artifacts and are not retained. Later commits superseded the per-ordering results described here: Rust releases contenders in list order (28d066c), and the race assertions are unconditional per ordering (d70213f). The final certified state, control outcomes, and comparison are in `../KRT-DE006/`.

Ticket: KRT-DE003, milestone M2, reviewed together with the M3 Rust adapter. This report supersedes the previous M2 triage where it described participant argument injection, one retained TypeScript kernel, and a 0.1.0 Rust manifest.

| Finding | Disposition | Evidence or limitation |
| --- | --- | --- |
| Participant identity was injected into native start arguments. | Fixed | The runner sends the catalogued arguments unchanged. It resolves participant handles from each start's `handleCapture` and refuses release without all corresponding entry receipts. The controllers hold every started operation entering the armed seam. The compiler requires participant handle captures and validates start projections; the runner validates resolved start input. |
| The first-outcome error branch was not exercised. | Fixed | `a_first` releases in start order and `b_first` reverses it. The TypeScript memory run applies assertions 6-9 for `a_first` and 10-13 for `b_first`. Both pass. Rust's focused run applies 10-13 for `a_first` and 6-9 for `b_first`; both pass. Rust thread scheduling does not promise a winner from list order. |
| Stale-read activation precondition described a removed path. | Fixed | The manifest describes the public `setHead` validation/pointer-write split across two transactions and the retained stale-pointer backend mutation. The TypeScript mutant activated 13 times and was killed. |
| TypeScript contenders shared one kernel instance. | Fixed | Each started syscall receives a distinct runtime kernel over one shared backend. Rust's per-operation clones share the same `Arc<Mutex<KernelState>>`. |
| The outcome enum assertion and fixture entry repeated the protocol contract. | Removed | A missing first outcome fails conditional operand resolution; a malformed await outcome is rejected by the adapter client. Contract probes exercise both cases. |
| Receipt and release echo assertions repeated runner-supplied data. | Removed | The runner enforces arming acknowledgement and both handle-correlated receipts before release; assertion 5 checks the held head. |
| Runtime-pass test checked only for static conditional assertions. | Removed | The race test checks the applied branch in runtime evidence. |
| Mutant inline comment duplicated the code. | Removed | The mutation is unchanged. |
| Rust did not advertise protocol 0.2.0 or `kernel.barrier`. | Fixed | Both Rust manifests and initialization agree. Both certified-manifest writer checks pass. Unsupported `subscribe`, `pull`, and `openInstance` methods return typed protocol errors in both hosts, and no plan uses them. |
| Compatibility topology ignored protocol-version exclusion. | Fixed | The topology reader and runner use the same capability-and-protocol selection function. A regression in `tools/scripts/lib/conformance-contract.test.ts` covers versions 0.1.0 and 0.2.0 plus a missing capability. |

The transaction-entry seam remains before the memory backend's exclusive lock, as directed by OD-17. Receipts prove overlapping entry to that seam. They don't prove simultaneous compare-and-set decisions. The standard `bun run conformance` output is `.cache/de-review-evidence-XuUHU4/conformance-final.log`; the focused TypeScript and Rust evidence files are in the same directory.

The TypeScript unmutated control passed 135 checks and the Rust control passed 60 under its `kernel.syscall` selection. The report at `../KRT-DE006/negative-controls-summary.json` records activation counts, designated failures, collateral failures, and unsupported reasons. The outcome table uses activation counts in parentheses.

| Mutant | TypeScript | Rust |
| --- | --- | --- |
| `kernel.accept-noncanonical-cbor` | killed (1) | unsupported (0) |
| `kernel.accept-stale-head-update` | killed (13) | unsupported (0) |
| `kernel.accept-stale-owner-after-takeover` | killed (4) | unsupported (0) |
| `kernel.delete-object-reachable-through-live-root` | killed (6) | killed (1) |
| `kernel.drop-uncommitted-staged-result-on-recovery` | killed (5) | killed (3) |
| `kernel.fault-seam-never-fires` | killed (7) | unsupported (0) |
| `kernel.lease-takeover-before-expiry` | killed (3) | unsupported (0) |
| `kernel.never-sweep-eligible-objects` | killed (25) | unsupported (0) |
| `kernel.noncanonical-changed-paths-order` | killed (2) | unsupported (0) |
| `kernel.promote-staged-before-checkpoint` | killed (4) | unsupported (0) |
| `kernel.resolve-object-across-scopes` | killed (6) | unsupported (0) |
| `kernel.sweep-inside-grace-window` | killed (18) | unsupported (0) |
| `kernel.wrong-opaque-object-hash` | killed (86) | killed (24) |

TypeScript has 13 activated kills and no survived, equivalent, unsupported, or invalid runs. Rust has three activated kills and ten unsupported controls; none survived or was invalid. The stale-head mutant fired its syscall designations `.6.schemaValid` and `.7.resultField` in both writer claims, alongside three retained legacy designations. Its error-branch designations `.10.schemaValid` and `.11.resultField` remain mapped to the actual conditional checks; the baseline exercises that branch.

The pinned plan catalog requires tagged `$map` input for `kernel.tree.create`, while the existing serial tree-identity plan projects a plain fixture map. Start validation exposes that pre-existing discrepancy in the generated handle-parity test. That test converts the same fixture data to the catalogued tagged form for the generated start, while the original serial plan remains unchanged. This does not weaken catalog validation; correcting the source serial plan and fixture representation is outside these findings.

The lockfile/guidelines Tokio and Serde version mismatch recorded in DE005 predates these fixes. No dependency was added. The TypeScript protocol error code `adapter_method_not_implemented` adopts the Rust host's existing convention, which the pinned error envelope permits but does not name. The feature-gated Rust `BarrierControl::operation` and private TypeScript testkit `run` helper no longer accept participant labels. A changeset records the testkit API change and notes the Rust feature change; the JavaScript changeset tooling doesn't version the Rust crate.

No file under `.constitution/` was edited. The work remains uncommitted and no service lifecycle command was run.

The final compatibility evidence under `reports/compatibility/evidence/` records 135 passing TypeScript checks and 116 passing Rust checks. Both languages apply assertions 6-9 for `a_first` and 10-13 for `b_first` in that run; both writer checks pass for each language.

## Final verification

All repository commands ran through `direnv exec` for this worktree. The final release log is `.cache/de-review-evidence-XuUHU4/verify-final.log`.

| Command | Exit status | Outcome |
| --- | --- | --- |
| `bun run check` | 0 | Authority, affected projects, Rust workspace lint, and Rust tests pass. |
| `bun run verify:kernel` | 0 | Compatibility freshness and memory, SQLite, and PostgreSQL kernel lanes pass. |
| `bun run conformance` | 0 | All 11 project lanes pass. TypeScript kills all 13 mutants; Rust kills its three supported mutants and reports ten unsupported. |
| `bun run lint` | 0 | Full workspace lint passes. |
| `bun tools/scripts/authority-guardrails/authority-guardrails.ts` | 0 | Authority guardrails pass. |
| `cargo fmt --all -- --check` | 0 | Rust formatting passes. |
| `cargo clippy -p tuvren-kernel-rust --all-targets --no-default-features -- -D warnings` | 0 | Feature-disabled kernel lint passes. |
| `cargo clippy -p tuvren-kernel-rust --all-targets --features conformance -- -D warnings` | 0 | Conformance-feature kernel lint passes. |
| `cargo clippy -p tuvren-kernel-rust-conformance-adapter --all-targets -- -D warnings` | 0 | Rust adapter lint passes. |
| `cargo test -p tuvren-kernel-rust-conformance-adapter --test operation_handles` | 0 | All nine adapter operation-handle tests pass. |
| `bun run compatibility:evidence` | 0 | Compatibility evidence was refreshed from the final source. |
| `bun run verify` | 0 | All release phases pass, including 857 tooling tests, conformance, interop, and SQLite and PostgreSQL proving-host scenarios. |
| Focused harness, compiler, compatibility, and race tests | 0 | 83 tests pass after the orchestration refactor. |

An initial `bun run check` returned 1 because the existing tree-identity fixture projected a plain map into a start argument and because the new tests had lint errors. The generated parity test input was changed to the catalogued tagged form and the test lint was fixed; the rerun passes. Two initial `bun run lint` attempts returned 1 for an unregistered test file and Biome complexity/style rules. The regression was moved into an existing covered suite and the functions were refactored; the final full lint passes. An exploratory unscoped Oxlint invocation over tools returned 1 because it applied rules outside the repository's configured lint inventory; the configured full lint passes.
