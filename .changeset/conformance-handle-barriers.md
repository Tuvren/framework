---
"@tuvren/kernel-testkit": minor
---

Hold every started operation that enters an armed transaction-entry barrier, and identify entries by operation handle. The `run` helper no longer accepts a participant label. The Rust kernel's `conformance` feature applies the same handle-based behavior and removes the participant argument from `BarrierControl::operation`.
