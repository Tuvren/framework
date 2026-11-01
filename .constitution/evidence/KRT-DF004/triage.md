# KRT-DF004 triage

Adapted from the prior DF004 triage for the state at commit 2962a85.

Both backends passed the four supported crash boundaries with a token-matched receipt, SIGKILL of the same supervised epoch, and recovery. The unknown-commit-outcome boundary is unsupported. Missing and premature receipts invalidate the run. The incomplete-checkpoint mutant is activated and killed by the designated after-commit assertion on both backends.

The current pre-commit recovery tests query the pending TurnNode identity and observe its absence; the earlier statement that the candidate was not directly observable is obsolete. The remaining pre-commit detecting-control gaps are recorded in `spec/conformance/kernel/kernel-process-crash-undetected.json`.

Review found that `before_commit` fired at the first branch read of the checkpoint, before any write, so no point held between the last checkpoint write and COMMIT. It now holds after all checkpoint writes and before COMMIT (OD-25). Re-measured on SQLite and PostgreSQL: the incomplete-checkpoint mutant's activation count rises from 1 at arming (the baseline checkpoint) to 2 at faultReached (the armed attempt), and recovery still passes every `before_commit` assertion, so this mutant is undetected at this point. A defective backend that commits a checkpoint write outside the transaction has no test yet, because the public seams cannot commit independently inside the native transaction (SQLite holds BEGIN IMMEDIATE, and repositories reject escaped handles and nested transactions). The two intermediate-boundary reasons describe the absence of controls that commit independent writes inside SQLite's locked transaction.
