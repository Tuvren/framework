---
"@tuvren/core": patch
"@tuvren/runtime": patch
---

Preserve the first fatal execution error and expose later failures in the optional `subsequentErrors` field of a failed execution result.
Resolve `awaitResult()` when a fatal or subsequent error code is absent or not snake_case by using `execution_failed` in the typed result while preserving the published error in the event stream.
Preserve subsequent execution errors in failed orchestration results and resolve child initialization failures with invalid error codes using the same fallback.
Document the at-least-once tool dispatch and recovery contract for hosts, including idempotency requirements.
