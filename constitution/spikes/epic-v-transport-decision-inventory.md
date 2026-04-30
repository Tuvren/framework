# Epic V Transport Decision Inventory

## Status

Epic V transport selection is closed in current repo reality.

## Selected Transport Posture

- The TypeScript framework now talks to the governed Rust kernel service
  through Connect RPC `2.1.1` using `createClient()` from
  `@connectrpc/connect` plus `createGrpcTransport()` from
  `@connectrpc/connect-node`.
- The repo keeps the existing `@bufbuild/protobuf@2.11.0` and
  `protoc-gen-es@2.11.0` pins. Epic V did not need a Protobuf-ES version bump
  to activate the Rust-kernel lane.
- Generated TypeScript bindings stay under the consuming framework
  implementation tree at
  `boundaries/framework/implementations/typescript/runtime-core/src/lib/generated/kernel-interop/`.
- The reusable remote-kernel seam lives below `TuvrenRuntime` in
  `@tuvren/runtime-core` as `createGrpcRuntimeKernel()`. No host-facing public
  runtime surface was renamed or widened.

## Scope Boundaries

- The first remote-kernel seam remains kernel-only. It does not absorb host,
  driver, provider, or execution-handle protocol semantics.
- The private playground host selects `kernelMode: "typescript-local" |
  "rust-grpc"` plus `kernelGrpcBaseUrl`; `TuvrenRuntime` stays unchanged.
- Epic V proves reload only across a fresh TypeScript host attached to the same
  live Rust kernel process. It does not claim Rust-side durable restart
  persistence because the Rust kernel baseline remains in-memory.

## Evidence

- `bun run nx run kernel-interop-grpc:codegen --skipNxCache`
- `bun run nx run framework-runtime-core:exports-smoke --skipNxCache`
- `bun run nx run host-playground:test --skipNxCache`
- `bun run nx run host-playground:interop-smoke --skipNxCache`
- `bun tools/scripts/compatibility-report.ts`
