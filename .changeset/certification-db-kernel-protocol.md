---
"@tuvren/kernel-runtime": patch
"@tuvren/kernel-protocol": patch
---

Return unique tree.diff changedPaths in ascending unsigned UTF-8 byte order, including paths with supplementary Unicode characters. Document the canonical result order in the kernel protocol and forward native diff results through the TypeScript conformance adapter without sorting.

Emit the canonical turn_node_thread_mismatch, run_lease_owner_mismatch, and run_lease_token_mismatch error codes from @tuvren/kernel-runtime. Native errors now reach conformance unchanged; consumers matching the previous kernel_runtime-prefixed codes must update their handlers.
