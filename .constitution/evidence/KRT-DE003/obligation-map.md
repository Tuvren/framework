# Concurrent writer obligation map

> Working record kept as triaged at the time. Paths under `.cache/` were worker-local run artifacts and are not retained. Later commits superseded the per-ordering results described here: Rust releases contenders in list order (28d066c), and the race assertions are unconditional per ordering (d70213f). The final certified state, control outcomes, and comparison are in `../KRT-DE006/`.

Ticket: KRT-DE003, milestone M2, review fixes applied on top of M3. The enforcing plan is `spec/conformance/kernel/plans/kernel-concurrent-writer-syscall.json`. Both `kernel.syscall.concurrent_writer.a_first` and `kernel.syscall.concurrent_writer.b_first` retain their claim IDs. The legacy restart-recovery plan remains unchanged.

| Legacy obligation or evidence | Claim or disposition | Observable proof |
| --- | --- | --- |
| `crashRecoveryConcurrency.singleWriterRejected` | Both syscall claims | When the first outcome is a result, assertions 6 and 7 require the second to be the typed lateral conflict. When the first outcome is an error, assertions 10 and 11 require that conflict and a successful second outcome. |
| `crashRecoveryConcurrency.finalHeadIsCommittedSibling` | Both syscall claims | Assertions 1-4 establish the common head, sibling ancestry, and distinct checkpoint hashes. Assertion 8 or 12 requires the successful result to name its own target. |
| `crashRecoveryConcurrency.finalHeadMatchesWinner` | Both syscall claims | Assertion 9 or 13 compares the persisted head with the successful outcome's returned head. |
| `crashRecoveryConcurrency.typedLateralConflictObserved` and `losingErrorCode` | Both syscall claims | Assertion 6 or 10 checks the raw native error against the lateral-conflict fixture schema. |
| `crashRecoveryConcurrency.retryAfterLossErrorCode` | Retained as legacy diagnostics | The syscall claims require the initial losing attempt to return the typed conflict; a retry cannot satisfy them. |
| `faultPlanConcurrentWriter.injectedErrorCode`, `writerAdvancedHead`, and `writerProducedSiblingHead` | Retained in the unchanged legacy check | The syscall plan separately checks both candidate lineages and the final head. |
| Both contenders enter and remain held | Both syscall claims | The runner requires both implementation-entry receipts before release. Assertion 5 checks the held branch head against the base checkpoint. A sequential control cannot produce the second receipt. |
| Receipt echoes and release ordering | Orchestration, not semantic assertions | The runner correlates receipts with the handles captured by the named start steps and releases handles in plan order. Echo comparisons and arrival inequalities do not claim semantic coverage. |
| Outcome discriminator enum | Removed as redundant | The protocol client rejects malformed await outcomes, and an unresolved conditional path fails the assertion engine. The deleted enum fixture entry and assertion add no independent coverage. |

Both assertions of each conditional branch are accompanied by the winning target and final-head checks. The `a_first` plan releases first-started then second-started; `b_first` reverses that order. The TypeScript memory race test verifies that the result branch applies for the first ordering and the error branch applies for the second. Neither assertion assumes which writer a scheduler chooses.

The stale-read mutant's syscall designations are `.6.schemaValid`, `.7.resultField`, `.10.schemaValid`, and `.11.resultField` under each claim. Its three legacy designations remain unchanged. The public `setHead` mutation validates in one transaction and commits captured pointer writes in another without revalidating direction. The legacy backend path also accepts a stale pointer update. A barrier-free public test observes the split and proves activation.

The seam remains `kernel.persistence.before-transact`, before the memory backend's exclusive lock. It proves overlapping transaction entry and held contenders, not simultaneous compare-and-set decisions. The TypeScript adapter constructs a distinct kernel for each started operation over one shared backend. Rust's `for_operation` clones an `InMemoryKernel` over the same `Arc<Mutex<KernelState>>`.

The compiler requires barrier participant starts to declare `handleCapture` and checks start arguments against the catalog. The runner validates resolved start arguments, rejects release without both matching receipts, and preserves cancellation-before-release ordering. Contract tests cover either winner, malformed and missing outcomes, double success, double conflict, wrong errors, an advanced held head, and a final head that differs from the winner.

Measured evidence is `.cache/de-review-evidence-XuUHU4/typescript.json` and `.cache/de-review-evidence-XuUHU4/rust.json`. The TypeScript control applied assertions 6-9 for `a_first` and 10-13 for `b_first`. The Rust focused run applied 10-13 for `a_first` and 6-9 for `b_first`. All four checks passed.

The final refreshed compatibility evidence also passes all four writer checks. For both TypeScript and Rust, the recorded `a_first` outcome applies assertions 6-9 and `b_first` applies assertions 10-13. The earlier Rust focused run observed the reverse winners, so those ordering results are not a guarantee.
