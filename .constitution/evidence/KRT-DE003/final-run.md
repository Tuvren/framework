# KRT-DE003 final run

Recorded from the certified `kernel.memory` run at 1f5df2a (certificates and control run in `../KRT-DE006/`).

| Implementation | Check | Status | Assertions |
| --- | --- | --- | --- |
| TypeScript memory | `kernel.syscall.concurrent_writer.a_first` | pass | 22/22 |
| TypeScript memory | `kernel.syscall.concurrent_writer.b_first` | pass | 22/22 |

The stale-head mutant `kernel.accept-stale-head-update` was activated and killed in the TypeScript control run linked to the certificate (`../KRT-DE006/negative-controls-summary.json`). The sequential-contender failure is pinned by `typescript/kernel/conformance-adapter/test/concurrent-writer-syscall.test.ts`, which `bun run verify:kernel` runs.
