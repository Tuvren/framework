# KRT-DC002 obligation map

Milestone M2 adds `tuvren.kernel.reclamation.syscall` and `tuvren.kernel.scope-isolation.syscall`, version `0.1.0`. Both enforce certification and require `kernel.syscall` plus their family capability. Legacy plans and composite handlers remain unchanged. This is a partial migration: cross-scope negative observations require lifecycle authority and runner support described below.

| Legacy planId | Legacy checkId | Assertion | ClaimId or removal reason |
| --- | --- | --- | --- |
| tuvren.kernel.scope-isolation | kernel.scope-isolation.store_has_is_scope_confined | 1.resultField: storeHas.sameScopeObservesOwnContent | `kernel.syscall.scope-isolation.own_content`: native `store.has`, with independently checked read-back bytes and digest. |
| tuvren.kernel.scope-isolation | kernel.scope-isolation.store_has_is_scope_confined | 2.resultField: storeHas.crossScopeObservesOtherContent | DC002-S01: not migrated; unchanged legacy obligation remains active. A second scope on a shared substrate cannot be selected through the catalogued, scope-free store syscalls. |
| tuvren.kernel.scope-isolation | kernel.scope-isolation.store_get_is_scope_confined | 1.resultField: storeGet.sameScopeReturnsObject | `kernel.syscall.scope-isolation.own_content`: native `store.get` returns the seeded bytes; the runner verifies their digest against the reported store hash. |
| tuvren.kernel.scope-isolation | kernel.scope-isolation.store_get_is_scope_confined | 2.resultField: storeGet.crossScopeReturnsNull | DC002-S01: not migrated; unchanged legacy obligation remains active. The runner has one fixed instance per trace and no supported secondary-instance action. |
| tuvren.kernel.scope-isolation | kernel.scope-isolation.enumeration_is_scope_confined | 1.resultField: enumeration.sameScopeThreadVisible | `kernel.syscall.scope-isolation.own_enumeration`: native `thread.list`, exact cardinality, thread identity, and root-hash read-back. |
| tuvren.kernel.scope-isolation | kernel.scope-isolation.enumeration_is_scope_confined | 2.resultField: enumeration.crossScopeThreadVisible | DC002-S01: not migrated; unchanged legacy obligation remains active. No claim of cross-scope enumeration isolation is made by the syscall plan. |
| tuvren.kernel.reclamation | kernel.reclamation.unreachable_past_grace_is_released | 1.resultField: reclaim.unreachablePastGraceReleased | `kernel.syscall.reclamation.unreachable_past_grace_is_released`: prove orphan presence, reclaim, then read null; require released-object counts. |
| tuvren.kernel.reclamation | kernel.reclamation.unreachable_past_grace_is_released | 2.resultField: reclaim.archivedBranchReleased | `kernel.syscall.reclamation.unreachable_past_grace_is_released`: capture the archive branch produced by rollback; read back null for its branch, exclusive node, and payload; inspect branch-list cardinality and release counts. |
| tuvren.kernel.reclamation | kernel.reclamation.reachable_from_live_root_is_retained | 1.resultField: reclaim.reachableFromLiveRootRetained | `kernel.syscall.reclamation.reachable_from_live_root_is_retained`: read the retained bytes, node chain, tree manifest, thread root, and branch head. Verify node identities, object digest, and reference closure. |
| tuvren.kernel.reclamation | kernel.reclamation.reachable_from_live_root_is_retained | 2.resultField: reclaim.sharedObjectRetainedViaLiveRoot | `kernel.syscall.reclamation.shared_object_retained_via_live_root`: first prove the abandoned node references both shared and exclusive objects, then verify only the exclusive payload disappears after rollback and reclaim. |
| tuvren.kernel.reclamation | kernel.reclamation.grace_window_holds_under_active_lease | 1.resultField: reclaim.graceWindowHeldUnderActiveLease | `kernel.syscall.reclamation.grace_window_holds_under_active_lease`: create an explicit leased run at 20, write orphans at 10 and 30, reclaim at 40 before expiry 1000; the older orphan disappears and the newer one remains. Staged work remains readable and recoverable. |
| tuvren.kernel.reclamation | kernel.reclamation.erasure_payload_unrecoverable_after_key_destruction | 1.resultField: erasure.recoverableBeforeErasure | Removed as a kernel obligation by the owner's ruling. Decryption and key availability belong to the host. The narrower `kernel.syscall.reclamation.ciphertext_retention_and_unchanged_lineage` checks opaque ciphertext read-back and digest. |
| tuvren.kernel.reclamation | kernel.reclamation.erasure_payload_unrecoverable_after_key_destruction | 2.resultField: erasure.unrecoverableAfterErasure | Removed as a kernel obligation by the owner's ruling. The syscall trace has no keyring, encryption codec, key-destruction operation, or plaintext-recovery assertion. Legacy compatibility behavior stays unchanged as instructed. |
| tuvren.kernel.reclamation | kernel.reclamation.erasure_preserves_referencing_lineage | 1.resultField: erasure.lineageStructurallyIntactAfterErasure | `kernel.syscall.reclamation.ciphertext_retention_and_unchanged_lineage`: retain ciphertext and compare nodes, walk, tree manifest, and branch head before and after reclamation; verify identities and reference closure. This does not claim execution of host key destruction. |
| tuvren.kernel.reclamation | kernel.reclamation.leaseless_run_past_admin_expiry_does_not_pin_reclamation | 1.resultField: reclaim.leaselessRunPastAdminExpiryDoesNotPinReclamation | `kernel.syscall.reclamation.leaseless_run_past_admin_expiry_does_not_pin_reclamation`: leaseless running run created at 0, orphan written at 10, reclaim at 86405000, then null orphan read and retained root identity. The 24-hour default comes from the authority packet's KRT-BK002 ruling. |
| tuvren.kernel.reclamation | kernel.reclamation.leaseless_run_within_admin_expiry_still_pins_reclamation | 1.resultField: reclaim.leaselessRunWithinAdminExpiryStillPinsReclamation | `kernel.syscall.reclamation.leaseless_run_within_admin_expiry_still_pins_reclamation`: leaseless running run created at 0, orphan written at 10, reclaim at 1000, then exact bytes, digest, and retained root identity. |

## Negative controls

The shared runner evaluates the assertions. Activation remains the testkit mutant's native-entry signal; no adapter verdict is introduced.

| Mutant | Designated detection | Migration |
| --- | --- | --- |
| kernel.delete-object-reachable-through-live-root | `kernel.syscall.reclamation.reachability.8.resultField` | Migrated. The retained shared payload must equal its original bytes. |
| kernel.never-sweep-eligible-objects | `kernel.syscall.reclamation.reachability.1.resultField`, `.2.resultField`, `.4.resultField`; `kernel.syscall.reclamation.grace_window_holds_under_active_lease.1.resultField`; `kernel.syscall.reclamation.leaseless_run_past_admin_expiry_does_not_pin_reclamation.1.resultField` | Migrated. Direct null reads expose failure to release eligible storage. |
| kernel.sweep-inside-grace-window | `kernel.syscall.reclamation.grace_window_holds_under_active_lease.2.resultField`; `kernel.syscall.reclamation.leaseless_run_within_admin_expiry_still_pins_reclamation.1.resultField` | Migrated. Direct retained-byte reads expose premature sweeping. |
| kernel.resolve-object-across-scopes | Unchanged legacy `kernel.scope-isolation.store_has_is_scope_confined.2.resultField` and `kernel.scope-isolation.store_get_is_scope_confined.2.resultField` | DC002-S01 blocks migration. A legacy kill is not a syscall kill. |

The own-scope content/enumeration and ciphertext/unchanged-lineage claims have no dedicated detecting mutant in the supplied set. They remain explicitly undetected claims, with ordinary passing evidence only. Wrong-hash controls cover protocol integrity separately; no broader mutation coverage is claimed.

## Removed unit tests

`typescript/kernel/conformance-adapter/test/mutant-adapter.test.ts` generates tests only for controls without `kernel.syscall.*` claims. The manifest migration therefore removes these six generated tests from discovery without changing their generator:

- `kernel.delete-object-reachable-through-live-root activates through its detecting checks on memory`: replaced by the shared negative-control run and the contract test requiring activation and designated syscall failure.
- `kernel.delete-object-reachable-through-live-root alters a designated observation before the adapter reports it`: response inequality alone does not prove the authority assertion detects the defect; the shared runner now grades the direct retained-byte assertion.
- `kernel.never-sweep-eligible-objects activates through its detecting checks on memory`: replaced by the shared negative-control run and the contract test requiring activation and designated syscall failure.
- `kernel.never-sweep-eligible-objects alters a designated observation before the adapter reports it`: replaced by direct post-reclaim reads graded by the shared runner.
- `kernel.sweep-inside-grace-window activates through its detecting checks on memory`: replaced by the shared negative-control run and the contract test requiring activation and designated syscall failure.
- `kernel.sweep-inside-grace-window alters a designated observation before the adapter reports it`: replaced by direct retained-byte reads after a clock-driven reclaim.

Runtime reclamation unit tests remain unchanged because that directory is outside this ticket's worker scope. Some overlap with the migrated traces; backend capability rejection, no-op reclamation, and old-object/new-node reachability still cover behavior these traces do not replace.

## Decisions and drift

- DC002-S01: The pinned adapter contract names `createInstance {input, storageRef?, scope?, clock?}` and `openInstance {storageRef, scope?}`. The plan schema names `openInstance`, but the runner's trace loop dispatches every step against one fixed instance. The kernel catalog has no lifecycle control for creating/selecting a second scope. Adding a scope parameter to a store syscall would contradict scope-free syscall authority. No selector, preseeded adapter scenario, new operation, or contract shape was invented. Required closure: authorize lifecycle/catalog and shared-runner work for two scoped instances over one harness-owned substrate, then migrate the remaining three negative observations and cross-scope mutant.
- The control contract test also runs the dropped-staging recovery mutant. Exact-cardinality record quantification detects missing staged work without unresolved indexed operands, preserving valid negative-control classification.
- Reclamation has no STOP finding: backend and worker clocks are explicitly set through `kernel.clock.set`; leased runs use `kernel.runLiveness.createLeasedRun`. Administrative expiry uses the existing catalogued `kernel.run.create` and the authority packet's 24-hour rule.
- The testkit manifest validator reads declared check and step `claimIds` instead of assuming claim IDs equal check IDs. Legacy plans retain their check-ID fallback. This follows the pinned claim shape and introduces no contract.
- Every needed syscall is already bound in the routing table at M1. No bridge changes, dependencies, conventions, or contract shapes were introduced. Plan structure follows EPIC-DB.
- `spec/kernel/authority-packet.json` registration is explicitly authorized by the task. The required `bun run compatibility:evidence` refresh changes the compatibility matrix and seven kernel evidence files. This records final assertion outcomes and the seven added checks without changing other implementations.
- `.constitution/` is read-only. The epic lead must carry this finding into its decisions and evidence during reconciliation.

## Verified outcome

All seven added checks pass on the TypeScript memory, SQLite, and PostgreSQL kernels. Their full applicable suites pass 128, 129, and 130 checks respectively. The final negative-control run proves activation and kills for the three migrated reclamation controls. Cross-scope resolution is killed by the unchanged legacy assertions only. Full results are in `DC002-negative-controls.json`; the unrelated lease-takeover control remains invalid because of a capability gap.


## Claim designation audit

The M4 review audit lists each remaining undetected syscall claim explicitly. Existing passing observations remain ordinary conformance evidence.

| Claim ID | Status | Reason |
| --- | --- | --- |
| `kernel.syscall.reclamation.ciphertext_retention_and_unchanged_lineage` | Undetected | The supplied controls contain no ciphertext-retention or unchanged-lineage mutant; host key destruction remains outside the kernel claim. |
| `kernel.syscall.scope-isolation.own_content` | Undetected | The cross-scope mutant is designated against legacy cross-scope reads; no supplied mutant targets these own-scope content observations. |
| `kernel.syscall.scope-isolation.own_enumeration` | Undetected | The cross-scope mutant targets legacy store reads; no supplied mutant targets these own-scope enumeration observations. |
