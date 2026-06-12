# Epic AB Run Liveness Recovery Closure Inventory

## Status

Epic AB is closed in current repo reality.

## Delivered Scope

- `kernel.run-liveness` is normalized as an optional advertised extension rather than a silent widening of the frozen 28-operation base.
- The TypeScript memory and SQLite kernel backends advertise and support `kernel.run-liveness`.
- Shared framework stale-recovery conformance is already promoted alongside kernel run-liveness evidence.
- Rust remains non-applicable unless it advertises `kernel.run-liveness`.

## Evidence Anchors

- Kernel run-liveness plan: `boundaries/kernel/conformance/plans/kernel-run-liveness.json`
- TypeScript memory kernel evidence: `reports/compatibility/evidence/shared-conformance-runner.typescript-kernel-memory.json`
- TypeScript SQLite kernel evidence: `reports/compatibility/evidence/shared-conformance-runner.typescript-kernel-sqlite.json`
- TypeScript framework evidence with promoted stale-recovery checks: `reports/compatibility/evidence/shared-conformance-runner.typescript-framework.json`
- Compatibility matrix capability entries: `reports/compatibility/compatibility-matrix.json`
- TypeScript framework adapter capability declaration: `boundaries/framework/implementations/typescript/conformance-adapter/adapter.json`

## Closure Notes

- Epic AB belongs in the closed/current-reality section with Z and AA, not in the active critical path.
- Run-liveness remains extension-scoped: implementations that do not advertise it must not inherit support claims by implication.
- Future work may extend liveness coverage, but it should start from the promoted extension posture and shared evidence already present in the repository.
