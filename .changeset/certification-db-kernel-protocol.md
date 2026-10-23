---
"@tuvren/kernel-runtime": patch
"@tuvren/kernel-protocol": patch
---

Return unique tree.diff changedPaths in ascending unsigned UTF-8 byte order, including paths with supplementary Unicode characters. Document the canonical result order in the kernel protocol and forward native diff results through the TypeScript conformance adapter without sorting.
