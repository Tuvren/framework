# Durable reopen obligation map

The two legacy checks use the same composite operation. The syscall checks execute a checkpoint, stage pending work, restart the adapter, and open the retained storage. Their assertions read syscall results and captured values.

| Legacy obligation | Syscall claim | Observation |
| --- | --- | --- |
| Committed state remains visible, including one committed message | `kernel.syscall.reopen.committed_state` | The recovered tree contains the captured committed message and has length 1. |
| Pending work isn't promoted | `kernel.syscall.reopen.pending_state` | The recovered staging equals the captured pending staging; the committed message differs from the pending object. |
| Checkpoint lineage survives | `kernel.syscall.reopen.checkpoint_lineage` | The walk contains the captured checkpoint and root in order. |
| Recovery uses the committed checkpoint as its head | `kernel.syscall.reopen.recovery_head` | The recovered run and branch heads equal the captured checkpoint hash. |
| The last completed step is retained | `kernel.syscall.reopen.completed_step` | Recovery returns `baseline` as the last completed step. |
| One pending staged result is retained | `kernel.syscall.reopen.pending_count` | Recovery returns one uncommitted staged result. |

`kernel-restart-af.invalid-staged-result-reexecutes` uses the pending-state, pending-count, and completed-step observations above. Its legacy assertions don't demonstrate an actual reexecution or an invalid staged result. The syscall check preserves those observed obligations and doesn't claim that stronger behavior. The pending-state and pending-count claims have a designated drop-uncommitted control; the other four claims have recorded reasons in `spec/conformance/kernel/kernel-persistent-reopen-undetected.json`. None is added to `kernel.memory`.
