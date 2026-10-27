# KRT-DE005 Rust triage

> Working record kept as triaged at the time. Paths under `.cache/` were worker-local run artifacts and are not retained. Later commits superseded the per-ordering results described here: Rust releases contenders in list order (28d066c), and the race assertions are unconditional per ordering (d70213f). The final certified state, control outcomes, and comparison are in `../KRT-DE006/`.

## Review findings on the M3 and M2 fixes

The Rust barrier releases handles in list order. It waits for each preceding handle to acquire the kernel state lock or leave the gate before releasing the next handle. The gate remains outside the state lock. An acknowledgement records lock acquisition and doesn't wait for another release. Cancellation and closure wake a waiting release.

The Rust branch-winner test passed 20 independent runs for each order. A won 20 of 20 runs when released first, and B won 20 of 20 runs when released first. The shared runner also passed 20 repetitions of each checked-in plan with the expected applied branch: assertion 6 for `a_first` and assertion 10 for `b_first`.

The review found that `b_first` started B then A but released A then B. That gave both plans the same branch release order. The `b_first` plan now starts A then B and releases B then A, so the plans exercise both contender orderings as ADR-0077 requires. Its conditional assertions identify the corresponding winning branch.

The compiler rejects additional or repeated starts while a barrier has unreleased participants. Rust stdio continues after invalid UTF-8 frames and shuts down instances before joining pending await requests at EOF. Both adapters report a gate cancellation or destruction as an outer `adapter_host_error`, preserving the reason. They do not place the harness interruption in a native operation outcome. A cancellation before native syscall entry retains `operation_cancelled_before_entry`; an outcome completed before cancellation is preserved.

The stale-head mutant no longer designates assertions 10 and 11 for either writer check. Assertions 6 and 7 remain designated. The TypeScript and Rust manifests already declare `storage: "none"`. The refreshed TypeScript control detected all 13 mutants. Rust's claimed profile control failed seven required-check selections, so its three detected mutants are diagnostic and its remaining ten mutants are unsupported. The generated per-mutant reports are in `DE003-negative-controls.json` and `DE006-evidence/negative-controls.json`.

The refreshed comparison at `DE006-evidence/comparison-review/` found zero unsanctioned disagreements, 251 sanctioned differences across 20 checks, and seven coverage differences. Earlier comparison directories remain historical. Both profile evidence files remain uncertified: the runner has no generator for a complete certificate with matching verifier digests and a passing negative-control run. Rust also lacks `kernel.edge-validation`, which produces seven missing-check findings and one missing-capability finding in the full profile.

The final verification results follow. All repository commands ran through the worktree's `direnv exec` environment.

| Command | Exit | Outcome |
| --- | --- | --- |
| `bun run check` | 0 | Authority, affected project, Rust lint, and workspace tests passed. |
| `bun run verify:kernel` | 1 | Compatibility validation reported the Rust profile failure and a check ID topology mismatch. |
| `bun run conformance` | 1 | Rust profile certification failed. TypeScript detected all 13 mutants; Rust reported three diagnostic detections and ten unsupported mutants. |
| `bun run lint` | 0 | Workspace lint passed. |
| `bun tools/scripts/authority-guardrails/authority-guardrails.ts` | 0 | Authority guardrails passed. |
| `cargo fmt --all -- --check` | 0 | Rust formatting passed. |
| `cargo clippy -p tuvren-kernel-rust --all-targets --no-default-features -- -D warnings` | 0 | Production-feature lint passed. |
| `cargo clippy -p tuvren-kernel-rust --all-targets --features conformance -- -D warnings` | 0 | Conformance-feature lint passed. |
| `cargo clippy -p tuvren-kernel-rust-conformance-adapter --all-targets -- -D warnings` | 0 | Adapter lint passed. |
| `bun run compatibility:evidence` | 0 | The compatibility generator completed with the Rust failure retained. |
| `bun run verify` | 1 | The Rust certification lane stopped the release gate on its eight profile findings. |

The Rust kernel and adapter tests, TypeScript barrier and operation-handle tests, and plan compiler tests passed. `git diff --check` passed. No dependencies or wire contract shapes were added. The test seam adds an acquisition acknowledgement and interruption tracking to the existing operation context.

The following review-fix record predates these findings and remains for history.

## Review fix and certified adapter outcome

The Rust certifying adapter manifest now declares protocol 0.2.0 and `kernel.barrier`. The matching mutant manifest and initialization response make the same capability claim. Under OD-18's interim decision, capabilities and storage kind determine method-family applicability. Both hosts return `adapter_method_not_implemented` for unsupported `subscribe`, `pull`, and `openInstance` requests, and no conformance plan uses those actions.

The focused run with the certified Rust manifest passed both writer checks. Its evidence is `.cache/de-review-evidence-XuUHU4/rust.json` in the worktree. `a_first` applied assertions 10-13: the first-started writer returned the lateral conflict, the second succeeded, and the persisted head matched the second. `b_first` applied assertions 6-9: the first-started writer succeeded, the second returned the lateral conflict, and the persisted head matched the first. Both entry receipts preceded release. This is an actual run against the 0.2.0 manifest, not the temporary relay described in the historical section.

The final compatibility evidence refresh passed both Rust checks, applying assertions 6-9 for `a_first` and 10-13 for `b_first`. An earlier compatibility refresh applied 10-13 in both orderings, and the focused run applied the opposite branches. Rust's barrier marks all requested entries released before notifying the waiting threads, so release-list order does not guarantee which thread acquires the memory lock first. These runs show both outcomes are possible; no winner is assumed by the plan.

The Rust adapter gives each started operation a cloned `InMemoryKernel` through `for_operation`. The clones share `Arc<Mutex<KernelState>>`, as shown in `rust/kernel/src/memory.rs` and `rust/kernel/src/memory/conformance.rs`. The seam remains outside that lock and proves transaction-entry overlap, not concurrent head decisions. The stale-head mutant remains unsupported in Rust; it has no demonstrated equivalent split-transaction mutation seam. The existing Tokio and Serde lockfile-versus-guidelines version drift is unchanged.

The topology reader and the shared runner now use the same capability and protocol selection function. The regression test checks that a 0.1.0 manifest excludes handle checks and that a 0.2.0 manifest includes them when its capabilities match.

## Historical M3 results before the review fix

The following records describe the earlier 0.1.0 manifest and temporary exploratory run. They are retained as historical evidence and are superseded by the review-fix results above.

The transaction-entry seam is before the memory kernel's exclusive state lock. The receipts establish that both writers reached the persistence path before release. They don't establish simultaneous head decisions inside the lock. The focused race used a temporary 0.2.0 manifest for an exploratory run, not a certificate. A temporary relay adds `kernel.barrier` to the initialization response and forwards all operation frames unchanged. The Rust binary and barrier seam provide the observations.

The following table records the outcomes and their disposition.

| Check | Ordering | Outcome | Classification (V/I/S/E) | Evidence | Action |
| --- | --- | --- | --- | --- | --- |
| Adapter contract, test-first baseline | Both writers | Failed before implementation: barrier operation missing | V | `cargo test -p tuvren-kernel-rust-conformance-adapter --test operation_handles`, initial run exit 101 | Implemented native feature-gated seam, concurrent host and control bindings; final contract tests pass. |
| Adapter malformed frame, test-first baseline | Not applicable | Failed before implementation: duplicate nested key returned null request id | V | Same initial test run, `malformed_correlated_requests_do_not_poison_the_session` | Preserve a uniquely parseable request id on rejected frames; final contract test passes. |
| Concurrent writer | `a_first` | Pass | — | `.cache/de005-writer-final.json`, `kernel.syscall.concurrent_writer.a_first` | No assertion changed; both receipts and final head validated by the shared runner. |
| Concurrent writer | `b_first` | Pass | — | `.cache/de005-writer-final.json`, `kernel.syscall.concurrent_writer.b_first` | No assertion changed; both receipts and final head validated by the shared runner. |
| Protocol 0.2.0 scope | Not applicable | The pinned protocol includes subscriptions, pull, and storage reattachment. The M1 TypeScript host also lacks these methods. Rust has no defined live event channel or durable storage. | S | `.constitution/tech-spec/contracts/conformance-certification.md`; `tools/conformance/adapter-protocol/protocol.schema.json`; `tools/conformance/adapter-protocol/stdio-host.ts` | Don't claim the complete 0.2.0 protocol from its handle subset or fabricate stream observations. The manifest remains at 0.1.0 pending an authority ruling on capability-gated applicability and channel definitions. |
| Direct clock and fault controls, test-first baseline | Not applicable | Failed before implementation: `setClock` returned `adapter_method_not_implemented` | V | `.cache/de005-controls-test-first.log`; exit 101 | Bound `setClock` and `armFault` to the same instance controls as the catalogued operations. The added protocol test passes. |
| `kernel.accept-stale-head-update` negative control | Both writers | Unsupported for Rust | V | `rust/kernel/src/memory/transaction.rs`, `rust/kernel/src/memory/journal.rs`, and the TypeScript `createNonAtomicHeadUpdateSeams` reference | Rust has no repository wrapper that can intercept and defer branch writes; reproducing the reference split without adding a new mutation seam or schedule instrumentation has not been demonstrated. Existing designation remains unsupported. |
| Compatibility topology check | Both writers | Failed after advertising `kernel.barrier` in a 0.1.0 manifest | V | `.cache/de005-compatibility-check.log`; `readLivePlanChecks` in `tools/scripts/compatibility-report.ts` ignores protocol version while `selectChecks` excludes handle steps for 0.1.0. | Keep the capability unclaimed until the manifest can claim 0.2.0. The topology-reader defect is outside the worker's permitted paths and remains for the epic lead. |
| Authority guardrails | Not applicable | Failed on a syscall literal in the adapter's internal unit test | V | Initial `bun tools/scripts/authority-guardrails/authority-guardrails.ts` run, exit 1 | The test obtains a binding from the routing table. The rerun exits 0. |
| Adapter build during development | Not applicable | Failed on a `Condvar::wait_while` predicate type | V | Initial post-change adapter test build, exit 101 | Replaced the method reference with a closure. The adapter suite passes. |
| `direnv` during development | Not applicable | One `cargo fmt` attempt reported that the worktree path didn't exist | E | First retry returned exit 1. An immediate path check found the worktree and the next command exited 0. | Transient environment failure; no files were removed. |
| Baseline Cargo pins | Not applicable | The lockfile resolves Tokio 1.53.1 and Serde 1.0.229, while the technical guidelines name Tokio 1.52.1 and Serde 1.0.228. | S | `Cargo.lock`; `.constitution/tech-spec/guidelines.md` stack specification | This predates KRT-DE005. No dependency or lockfile changed; reconcile the pins outside this milestone. |

The conformance run produced the following negative-control outcomes. Numbers in parentheses are activation counts. The TypeScript control passed 135 checks, and the Rust control passed 58 checks. Rust's 0.1.0 manifest excludes the writer-race checks from this unfiltered run.

| Mutant | TypeScript | Rust |
| --- | --- | --- |
| `kernel.accept-noncanonical-cbor` | Killed (1) | Unsupported |
| `kernel.accept-stale-head-update` | Killed (13) | Unsupported |
| `kernel.accept-stale-owner-after-takeover` | Killed (4) | Unsupported |
| `kernel.delete-object-reachable-through-live-root` | Killed (6) | Killed (1) |
| `kernel.drop-uncommitted-staged-result-on-recovery` | Killed (5) | Killed (3) |
| `kernel.fault-seam-never-fires` | Killed (7) | Unsupported |
| `kernel.lease-takeover-before-expiry` | Killed (3) | Unsupported |
| `kernel.never-sweep-eligible-objects` | Killed (25) | Unsupported |
| `kernel.noncanonical-changed-paths-order` | Killed (2) | Unsupported |
| `kernel.promote-staged-before-checkpoint` | Killed (4) | Unsupported |
| `kernel.resolve-object-across-scopes` | Killed (6) | Unsupported |
| `kernel.sweep-inside-grace-window` | Killed (18) | Unsupported |
| `kernel.wrong-opaque-object-hash` | Killed (86) | Killed (24) |

The machine-readable results are in `.cache/verification/run-278304-APBauQ/0.log` within the worktree. The Rust report gives a per-port reason for each unsupported mutant. The triage table describes the stale-head limitation.

The following verification commands passed after the final source changes. All repository commands used `direnv exec` for this worktree.

| Command | Exit status | Outcome |
| --- | --- | --- |
| `bun run check` | 0 | Authority, affected project, Rust lint, and Rust workspace test gates pass. |
| `bun run verify:kernel` | 0 | Kernel, compatibility freshness, and TypeScript memory, SQLite, and PostgreSQL lanes pass. |
| `bun run conformance` | 0 | All 11 conformance projects complete. Both language-specific negative-control reports complete. |
| `bun run lint` | 0 | Full workspace lint passes. |
| `bun tools/scripts/authority-guardrails/authority-guardrails.ts` | 0 | Authority guardrails pass. |
| `bun run compatibility:evidence` and `bun run compatibility:check` | 0 | The refreshed evidence is formatter-clean and passes freshness. No generated files differ from the baseline. |
| `cargo fmt --all -- --check` | 0 | Rust formatting passes. |
| `cargo clippy -p tuvren-kernel-rust --all-targets --no-default-features -- -D warnings` | 0 | Production-feature lint passes. |
| `cargo clippy -p tuvren-kernel-rust --all-targets --features conformance -- -D warnings` | 0 | Conformance-feature lint passes. |
| `cargo clippy -p tuvren-kernel-rust-conformance-adapter --all-targets --target-dir .cache/de005-production-target -- -D warnings` | 0 | Adapter lint passes. |
| `cargo test -p tuvren-kernel-rust-conformance-adapter --target-dir .cache/de005-production-target` | 0 | One unit test and 23 integration tests pass. |
| `cargo test -p tuvren-kernel-rust --features conformance` | 0 | Rust kernel feature tests pass. |
| `bun run verify` | 0 | Full release gate passes, including all 853 tooling tests and the interop and proving-host scenarios. |
| `git diff --check` | 0 | No whitespace errors. |

A standalone import probe fails with `E0433` against the feature-disabled kernel and compiles with `conformance` enabled. Symbol inspection finds no barrier symbols in the production library and finds them in the conformance library. No production transaction logic or journal cost changes.

Review-fix negative-control run: the Rust control passed 60 applicable checks, three supported mutants activated and were killed, and ten controls were unsupported. The machine-readable results are `../KRT-DE006/negative-controls-summary.json`.

Review-fix verification: `bun run check`, `bun run verify:kernel`, `bun run conformance`, `bun run lint`, the authority guardrails, `cargo fmt --all -- --check`, adapter tests, kernel Clippy with and without `conformance`, adapter Clippy, `bun run compatibility:evidence`, and `bun run verify` all exited 0. The full release gate ran 857 tooling tests and the SQLite and PostgreSQL proving-host scenarios successfully.
