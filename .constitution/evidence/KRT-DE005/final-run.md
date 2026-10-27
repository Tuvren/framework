# KRT-DE005 final run

Recorded from the certified `kernel.memory` run at 1f5df2a (certificates and control run in `../KRT-DE006/`).

| Implementation | Check | Status | Assertions |
| --- | --- | --- | --- |
| Rust | `kernel.syscall.concurrent_writer.a_first` | pass | 22/22 |
| Rust | `kernel.syscall.concurrent_writer.b_first` | pass | 22/22 |

Both entry receipts precede release in each ordering, and the release-order winner held in 20 of 20 native runs per ordering (`rust/kernel/tests/barrier_release_order.rs`). The adapter answers requests while operations run (`rust/kernel-conformance-adapter/tests/operation_handles.rs`). The Rust stale-head mutant is unsupported, with a per-port reason in `../KRT-DE006/negative-controls-summary.json`.
