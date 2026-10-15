# KRT-CR005 M6 documentation and freeze proof

Framework specification section 4.9 now defines the reactive-checkpoint head after successful stale preemption. It requires recovery to match durable results by `callId`, skip the runner, dispatch only missing calls, retain original call identity and idempotency keys, include missing `nonRetryable` calls, avoid a duplicate assistant message, and fail unreadable or erased interrupted assistant state with `runtime_recovery_interrupted_iteration_unreadable`.

The specification cites the kernel stale-preemption check and the three promoted lifecycle checks. The direct patch changeset covers only `@tuvren/runtime`.

The authority-freeze generator classified 267 claims and modified six of the seven allowed report files. The kernel-backend provider-local report remained byte-identical. No other constitution path changed. Lead verification passed the full conformance fleet, freeze generation and freshness check, direct changeset coverage, and repository diff validation.

Milestone review narrowed two claims. Reactive checkpointing applies when the interrupted batch has durable staged work; empty staging stops without a checkpoint. The four shared checks certify the preemption head, runner suppression, missing-call dispatch, and key preservation. Runtime tests separately cover an erased assistant payload and a single original assistant message. External-system deduplication remains an integration obligation rather than a tested claim. Regenerated freeze outputs and changeset verification pass after the correction.
