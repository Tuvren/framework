# DC001 removed obligations

These rows record each removed legacy assertion and required evidence path.

| planId | checkId | assertion or evidence | reason |
| --- | --- | --- | --- |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | assertion 7: `{"kind":"resultField","field":"$.crashRecovery.midCommit.injectedErrorCode","equals":"kernel_persistence_fault_injected"}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | assertion 8: `{"kind":"resultField","field":"$.crashRecovery.midCommit.headMatchesExpectedCheckpoint","equals":true}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | assertion 9: `{"kind":"resultField","field":"$.crashRecovery.midCommit.lineageConsistent","equals":true}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | assertion 10: `{"kind":"resultField","field":"$.crashRecovery.midCommit.pendingMessageCommitted","equals":true}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | assertion 11: `{"kind":"resultField","field":"$.crashRecovery.midCommit.recoveryStateConsistent","equals":true}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | assertion 12: `{"kind":"resultField","field":"$.crashRecovery.midCommit.visibleCommittedMessageCount","equals":2}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | evidence `crashRecovery.midCommit.injectedErrorCode` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | evidence `crashRecovery.midCommit.headMatchesExpectedCheckpoint` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | evidence `crashRecovery.midCommit.lineageConsistent` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | evidence `crashRecovery.midCommit.pendingMessageCommitted` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | evidence `crashRecovery.midCommit.recoveryStateConsistent` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.durable_fault_points | evidence `crashRecovery.midCommit.visibleCommittedMessageCount` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | assertion 7: `{"kind":"resultField","field":"$.crashRecovery.midCommit.injectedErrorCode","equals":"kernel_persistence_fault_injected"}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | assertion 8: `{"kind":"resultField","field":"$.crashRecovery.midCommit.headMatchesExpectedCheckpoint","equals":true}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | assertion 9: `{"kind":"resultField","field":"$.crashRecovery.midCommit.lineageConsistent","equals":true}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | assertion 10: `{"kind":"resultField","field":"$.crashRecovery.midCommit.pendingMessageCommitted","equals":true}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | assertion 11: `{"kind":"resultField","field":"$.crashRecovery.midCommit.recoveryStateConsistent","equals":true}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | assertion 12: `{"kind":"resultField","field":"$.crashRecovery.midCommit.visibleCommittedMessageCount","equals":2}` | ADR-0076 decision 4 retires mid-commit; the TypeScript observation duplicated after-commit-before-ack and proved no distinct boundary. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | evidence `crashRecovery.midCommit.injectedErrorCode` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | evidence `crashRecovery.midCommit.headMatchesExpectedCheckpoint` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | evidence `crashRecovery.midCommit.lineageConsistent` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | evidence `crashRecovery.midCommit.pendingMessageCommitted` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | evidence `crashRecovery.midCommit.recoveryStateConsistent` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |
| tuvren.kernel.restart-recovery | kernel.crash-recovery.in_process_fault_points | evidence `crashRecovery.midCommit.visibleCommittedMessageCount` | Removed with the retired mid-commit assertion; no distinct activation evidence exists. |

All other legacy assertions remain. Go, Python, Dart, and Rust may continue emitting the retired field; the shared plan no longer asserts it. SQLite/PostgreSQL backend hooks and docs/guides remain follow-ups outside this fix scope.

## Scope and follow-ups

The memory backend no longer advertises `mid-commit` or exposes a `midCommit` hook. The following paths retain those names and require a separate change:

- `typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts`
- `typescript/kernel/backends/postgres/src/lib/postgres-backend.ts`
- `typescript/kernel/backends/postgres/test/backend-postgres-initialization.test.ts`
- `docs/guides/add-a-kernel-backend.md`

Strict syscall clocks require explicit initialization. The M1 core and extended syscall plans initialize both domains before native operations; the legacy plans remain unchanged apart from the retired obligations listed above.
