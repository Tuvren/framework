# KRT-CR002 recovery-plan proof

The runtime now derives an interrupted-iteration plan from durable decoded messages. It normalizes committed preemption results with protocol-valid uncommitted staging, matches fulfillment only by `ToolResultPart.callId`, preserves the original assistant and missing calls, and distinguishes re-inference, resumed-batch, and completed-batch outcomes.

The tests cover committed partial results, uncommitted staged results through the configured codec, no assistant message, completed batches, erased and unreadable assistant state, and both task ID formats. The cold-crash characterization reproduces reactive checkpointing and pins current pre-M4 model re-invocation behavior.

Unreadable interrupted state raises `TuvrenRecoveryError` with code `runtime_recovery_interrupted_iteration_unreadable` and the recovered Turn and stale Run IDs. No provider stream state or kernel protocol change is used.

Lead verification passed runtime typecheck, all 528 runtime tests, runtime lint, formatting, and the locked repository check.
