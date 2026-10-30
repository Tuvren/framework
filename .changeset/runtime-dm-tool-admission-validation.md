---
"@tuvren/core": patch
"@tuvren/runtime": patch
---

Preserve the first fatal execution error and expose later failures in the optional `subsequentErrors` field of a failed execution result.
Resolve `awaitResult()` when a projected error code is not snake_case by using `execution_failed` in the typed result while preserving the native code in the event stream.
