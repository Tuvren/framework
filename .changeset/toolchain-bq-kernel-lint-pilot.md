---
"@tuvren/kernel-protocol": minor
"@tuvren/kernel-runtime": minor
"@tuvren/sdk": minor
---

Apply lint cleanup to the kernel protocol and runtime. Protocol repository and syscall callables use property signatures, which reject implementations with narrower input parameters under strict function checking. Protocol `hashKernelRecord` and `hashTurnTreeIdentity` report invalid inputs through Promise rejection instead of synchronous throws; validation codes, messages, order, and canonical identities are preserved.

The SDK re-exports `RuntimeBackend`, `RuntimeKernel`, and `RuntimeKernelRunLiveness`; their callable properties enforce the same strict input-parameter variance.

Runtime `verdicts.compose` reports malformed-input failures through Promise rejection instead of synchronous throws. Verdict priority, returned values, and error values are preserved. Runtime async iteration remains lazy and sequential, preserving transaction writes and lineage reads.
