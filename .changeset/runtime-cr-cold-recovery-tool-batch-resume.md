---
"@tuvren/runtime": patch
---

Resume interrupted tool batches after stale-run recovery by dispatching only missing calls with their original call identity. Recovery reports `runtime_recovery_interrupted_iteration_unreadable` when the interrupted assistant state is unreadable or erased.
