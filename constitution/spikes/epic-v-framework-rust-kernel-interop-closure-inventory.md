# Epic V Framework To Rust Kernel Interop Closure Inventory

## Status

Epic V is closed in current repo reality.

## Delivered Scope

- Added `createGrpcRuntimeKernel()` to `@tuvren/runtime-core`, including
  governed proto-to-contract mapping, deterministic CBOR payload handling,
  `int64` safe-integer guards, stable transport error decoding, and
  `node.walkBack()` async iteration.
- Extended the private playground host with `kernelMode` and
  `kernelGrpcBaseUrl`, allowing the same host harness to target either the
  local TypeScript kernel or the live Rust gRPC kernel.
- Added the framework-owned interop suite manifest
  `tuvren.framework.kernel-interop-smoke` under
  `boundaries/framework/interop/rust-kernel/`.
- Added the real `host-playground:interop-smoke` lane that starts the Rust gRPC
  service on an ephemeral port and runs the full deterministic playground
  matrix through the remote-kernel path.
- Upgraded the compatibility ledger to include `generatedAtMs`,
  `sourceRevision`, the `rust-kernel` implementation entry, and the
  `typescript-framework__rust-kernel` interop entry with measured evidence.
- Fixed the Rust gRPC richer-error encoding so Connect clients receive a proper
  `google.rpc.Status` envelope with typed `KernelErrorPayload` details.
- Aligned local and Rust kernel checkpoint semantics around `run.complete(...)`
  event-hash checkpointing, and aligned runtime-core head advancement with the
  latest durable run checkpoint.
- Proved reload across a fresh TypeScript host attached to the same live Rust
  kernel process, while keeping the Rust kernel baseline explicitly
  process-local and in-memory.
- Split repo verification so cross-language interop smoke is exercised as its
  own lane in `tools/scripts/verify.ts`.

## Residual Limits

- The Rust kernel baseline still has no durable storage adapter. Cross-process
  reload is proven only while the same Rust kernel process remains alive.
- Epic V does not widen the kernel transport to cover host protocols, provider
  bridges, or framework-owned execution controls.
- The compatibility matrix is still an internal measured-readiness artifact, not
  a public support policy.

## Epic W Start Gate

Epic W may begin only if its activation keeps the kernel seam narrow, treats the
Epic V transport and compatibility evidence as the upstream authority, and does
not reopen the Rust-kernel storage baseline or proto-governance decisions
without a new TechSpec revision.

## Evidence

- `bun run nx run framework-runtime-core:exports-smoke --skipNxCache`
- `bun run nx run host-playground:test --skipNxCache`
- `bun run nx run host-playground:interop-smoke --skipNxCache`
- `bun tools/scripts/compatibility-report.ts`
- `bun tools/scripts/verify.ts`
