---
id: ADR-0080
status: accepted
date: 2026-10-22
certainty: settled
evidence:
  kind: ruling
  ref: "Owner ruling in the 2026-10-22 Claude Code session: tree.diff changedPaths has a canonical order and adapter-side sorting is removed."
  date: 2026-10-22
---
### ADR-0080 tree.diff Changed Paths Have a Canonical Order

- **Status:** accepted.
- **Context:** The kernel specification says `manifest`, `resolve`, and `diff` results are deterministic (docs/KrakenKernelSpecification.md, TurnTree conformance target) but never fixes the order of `changedPaths`. The TypeScript and Python adapters sort the result before reporting it (`typescript/kernel/conformance-adapter/src/host-protocol-logical-scenarios.ts:311`, `python/kernel-conformance-adapter/src/tuvren_kernel_adapter/operations_runtime.py:105`). The plan then compares an ordered array (`spec/conformance/kernel/plans/kernel-protocol-core.json:83`). Implementation order is never observed.
- **Decision:** `tree.diff` returns `changedPaths` without duplicates, in ascending order of the path strings compared as unsigned bytes of their UTF-8 encoding. This is a protocol obligation of every kernel implementation. The kernel specification, the authority packet, and the plans state it, adapters stop sorting, and implementations that return another order are implementation findings.
- **Alternatives considered:** Set semantics with a separate same-input determinism check. Rejected by the owner: a canonical order is stronger for gRPC interop and cross-language comparison. No second design was requested; the owner ruled in the session.
- **Consequences:** Assumed until observed. Kernels that already return paths in another order change behavior. The kernel specification gains the ordering sentence in a minor revision. The negative-control set includes a non-canonical-order mutant (ADR-0079).
