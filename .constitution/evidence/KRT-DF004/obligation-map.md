# KRT-DF004 obligation map

The legacy plan remains unchanged. Its `kernel.crash-recovery.durable_fault_points` check contains separate before-commit and after-commit-before-ack obligations. The new claims are `kernel.syscall.process-crash.before_commit`, `kernel.syscall.process-crash.after_turn_node_write_before_head`, `kernel.syscall.process-crash.after_head_move_before_staging_clear`, and `kernel.syscall.process-crash.after_commit_before_ack`.

| Legacy obligation | New process-crash evidence |
| --- | --- |
| `beforeCommit.injectedErrorCode` | `before_commit` assertions 1–2: the armed token has a matching faultReached receipt followed by SIGKILL of that same supervised epoch. Process death supersedes the legacy thrown fault. |
| `beforeCommit.headMatchesExpectedCheckpoint` | `before_commit` assertions 3–5 and 9–10 compare the reopened and recovered heads and node with the captured baseline checkpoint. |
| `beforeCommit.lineageConsistent` | `before_commit` assertions 14 and 16–17, 20 require the baseline node and the baseline-to-root lineage. |
| `beforeCommit.pendingMessageCommitted = false` | `before_commit` assertions 15, 18, and 21 require the baseline-only visible tree and exclude the pending object. |
| `beforeCommit.recoveryStateConsistent` | `before_commit` assertions 6–8, 11–13, and 19 compare recovery, current staging, baseline consumption, pending staging, and last completed step. |
| `beforeCommit.visibleCommittedMessageCount = 1` | `before_commit` assertion 18 requires one message; baseline setup also verifies its exact object hash. |
| `afterCommitBeforeAck.injectedErrorCode` | `after_commit_before_ack` assertions 1–2 require the receipt and same-epoch forced death instead of a thrown fault. |
| `afterCommitBeforeAck.headMatchesExpectedCheckpoint` | `after_commit_before_ack` assertions 3–7 require recovered and reopened heads to match, the head to advance beyond the observed baseline, and the new node to point back to the baseline. |
| `afterCommitBeforeAck.lineageConsistent` | `after_commit_before_ack` assertions 16–19 require the recovered head, baseline, and root in order. |
| `afterCommitBeforeAck.pendingMessageCommitted = true` | `after_commit_before_ack` assertions 13–15 require both the captured baseline and pending object hashes in the visible tree. |
| `afterCommitBeforeAck.recoveryStateConsistent` | `after_commit_before_ack` assertions 8–12 require the original step sequence, pending as the last completed step, consumed pending staging, and empty uncommitted/current staging. |
| `afterCommitBeforeAck.visibleCommittedMessageCount = 2` | `after_commit_before_ack` assertion 13 requires exactly two messages. |

The two additional pre-commit boundaries use the same unconditional rollback assertions as `before_commit`. No `when` assertion is used for these authority-determined outcomes. The uninstrumentable `commit-outcome-unknown` point is not claimed by either backend. The current trace tests the candidate pending TurnNode and observes its absence after pre-commit crashes. Remaining detecting-control gaps are recorded in triage.md and `spec/conformance/kernel/kernel-process-crash-undetected.json`.

Each faulted trace also evaluates `kill.1.faultActivated` and `kill.2.processExit` immediately after the kill step and before respawn; the same evidence is repeated in the check-level assertions.
