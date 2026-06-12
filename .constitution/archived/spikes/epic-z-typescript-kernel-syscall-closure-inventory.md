# Epic Z TypeScript Kernel Syscall Closure Inventory

## Status

Epic Z is closed in current repo reality.

## Delivered Scope

- `@tuvren/kernel-runtime` exists under `boundaries/kernel/implementations/typescript/runtime-kernel`.
- The package exports `createRuntimeKernel()` as the boundary-owned TypeScript adapter from `RuntimeBackend` to `RuntimeKernel`.
- The package now owns the TypeScript syscall, lineage, rollback, checkpoint, recovery, and observe semantics that were previously planned as a gap.
- Playground local memory and SQLite modes now obtain syscall behavior from `@tuvren/kernel-runtime` instead of a private host-local kernel implementation.
- Private playground-local kernel logic is reduced to host-owned inspectors and host wiring in `boundaries/hosts/implementations/typescript/playground/src/lib/playground-host.ts` and related playground helpers.

## Evidence Anchors

- Runtime-kernel package entrypoint: `boundaries/kernel/implementations/typescript/runtime-kernel/src/index.ts`
- Runtime-kernel implementation: `boundaries/kernel/implementations/typescript/runtime-kernel/src/lib/runtime-kernel.ts`
- Playground host import and local-kernel wiring: `boundaries/hosts/implementations/typescript/playground/src/lib/playground-host.ts`
- Playground package dependency: `boundaries/hosts/implementations/typescript/playground/package.json`
- Playground tests using `createRuntimeKernel()`: `boundaries/hosts/implementations/typescript/playground/test/playground.test.ts`

## Closure Notes

- Epic Z is no longer an implementation gap and must not remain in active scope.
- Future work on TypeScript kernel behavior should start from the boundary-owned `@tuvren/kernel-runtime` package and the closure state above, not from private host code or the pre-closure plan text.
- Any remaining playground-specific helpers are host concerns only; they are not semantic authority for kernel behavior.
