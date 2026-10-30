---
"@tuvren/core": patch
"@tuvren/runtime": patch
"@tuvren/sdk": minor
---

Preserve the first fatal execution error and expose later failures in the optional `subsequentErrors` field of a failed execution result.
Resolve `awaitResult()` when a projected error code is not snake_case by using `execution_failed` in the typed result while preserving the native code in the event stream.
Validate plain JSON Schema inputs supplied through `defineTool` and `jsonSchema`, rejecting invalid tool calls before execution.
Allow host validators to reject input without supplying diagnostic details.
