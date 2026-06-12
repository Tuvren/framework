# Epic AC Framework Orchestration Authority Closure Inventory

## Status

Epic AC is closed in current repo reality.

## Delivered Scope

- `tuvren.framework.runtime-api` now references promoted orchestration conformance alongside the existing runtime-api lifecycle and callable plan family.
- The runtime-api authority source now declares shared orchestration operations for launch preconditions, run-local lifecycle locality, event-surface boundaries, execution-surface inheritance, and nested descendant attribution.
- The TypeScript binding appendix explicitly owns the TypeScript-only orchestration handle ergonomics while machine-owned semantics live in the packet and shared conformance plans.
- The TypeScript framework adapter now advertises `framework.orchestration` and executes native `runtime-core` orchestration behavior through shared-runner operations.
- Compatibility evidence and the compatibility matrix now report `framework.orchestration` for the TypeScript framework line, while Rust remains unsupported or non-applicable unless it advertises the capability.
- The promoted packet-owned subset covers launch preconditions, run-local lifecycle locality, subtree event boundaries including child subtree availability, failed and successful `awaitResult()` behavior, handed-off descendant agent attribution, execution-surface inheritance, and nested descendant attribution. Static config snapshotting and extension scoping remain local implementation evidence only.

## Evidence Anchors

- Epic AC authority inventory: `constitution/spikes/epic-ac-framework-orchestration-authority-inventory.md`
- Runtime-api Authority Packet: `boundaries/framework/contracts/runtime-api/spec/authority-packet.json`
- Runtime-api binding appendix: `boundaries/framework/contracts/runtime-api/spec/bindings/typescript.md`
- Shared orchestration plan: `boundaries/framework/conformance/plans/runtime-api-orchestration.json`
- TypeScript framework adapter capability declaration: `boundaries/framework/implementations/typescript/conformance-adapter/adapter.json`
- TypeScript framework shared evidence: `reports/compatibility/evidence/shared-conformance-runner.typescript-framework.json`
- Compatibility matrix: `reports/compatibility/compatibility-matrix.json`

## Closure Notes

- Epic AC must not remain in active scope once the packet, plans, adapter capability, and compatibility evidence above are checked in together.
- Shared-runner data is the grading surface. TypeScript `runtime-core` tests remain implementation evidence only.
- Future orchestration work should extend the runtime-api packet, shared plans, adapter observations, and compatibility evidence together rather than reintroducing TypeScript-local semantic oracles.
