---
"@tuvren/core": patch
"@tuvren/runtime": patch
---

Preserve the first fatal execution error and expose later failures in the optional `subsequentErrors` field of a failed execution result.
Map an absent or non-snake_case error code to `execution_failed` in the typed result and its `subsequentErrors`, keeping the published error in the event stream, so `awaitResult()` resolves where a non-snake_case code previously prevented it.
Preserve subsequent execution errors in failed orchestration results and resolve child initialization failures with invalid error codes using the same fallback.
Document the at-least-once tool dispatch and recovery contract for hosts, including idempotency requirements.
