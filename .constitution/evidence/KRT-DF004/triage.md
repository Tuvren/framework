# KRT-DF004 triage

Adapted from the prior DF004 triage for the state at commit 44e9481.

Both backends passed the four supported crash boundaries with a token-matched receipt, SIGKILL of the same supervised epoch, and recovery. The unknown-commit-outcome boundary is unsupported. Missing and premature receipts invalidate the run. The incomplete-checkpoint mutant is activated and killed by the designated after-commit assertion on both backends.

The current pre-commit recovery tests query the pending TurnNode identity and observe its absence; the earlier statement that the candidate was not directly observable is obsolete. The remaining pre-commit detecting-control gaps are recorded in `spec/conformance/kernel/kernel-process-crash-undetected.json`. At `before_commit`, the staged-clear interception executes, but killing before commit rolls back the mutation and the defective partial commit does not activate. The baseline head and staging remain intact. The two intermediate-boundary reasons describe the absence of controls that commit independent writes inside SQLite's locked transaction.
