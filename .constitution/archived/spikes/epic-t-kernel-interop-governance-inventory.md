# Epic T Kernel Interop Governance Inventory

This file closes Epic T against current repo reality. Epic T introduces the
first governed kernel-only process-boundary transport surface; it does not
implement a Rust kernel or a TypeScript remote-kernel client.

## Status

- Epic T is closed in current repo reality.
- `KRT-T001` through `KRT-T003` are complete.
- Epic U is now the next active implementation line.
- Epic U still owns the root Cargo workspace and first Rust kernel
  implementation.
- Epic V still owns real TypeScript framework to Rust kernel interop evidence
  and compatibility-ledger interop entries.

## Delivered Governance Surface

- The kernel interop surface inventory lives in
  `constitution/spikes/epic-t-kernel-interop-surface-inventory.md`.
- Root Buf v2 configuration now lives in `buf.yaml` with `STANDARD` lint and
  `FILE` breaking policy.
- Root Buf generation configuration now lives in `buf.gen.yaml`.
- Devenv now declares the native Buf and Protobuf-ES generator CLIs through
  `pkgs.buf` and `pkgs.protoc-gen-es`.
- `@tuvren/runtime-core` declares `@bufbuild/protobuf@2.11.0` so generated
  Protobuf-ES bindings can typecheck from their consuming implementation tree.
- The authored Protobuf authority lives under
  `boundaries/kernel/interop/grpc/proto/`.
- Generated TypeScript bindings are emitted under the consuming framework
  implementation tree at
  `boundaries/framework/implementations/typescript/runtime-core/src/lib/generated/kernel-interop/`
  and are intentionally ignored by source control.
- Generated TypeScript bindings are typechecked through
  `boundaries/framework/implementations/typescript/runtime-core/tsconfig.kernel-interop.generated.json`
  during kernel interop codegen because the normal runtime-core typecheck
  excludes the generated subtree.

## Transport Scope

- The active proto package is `tuvren.kernel.interop.v1`.
- The initial services mirror the current kernel-only `RuntimeKernel` groups:
  store, schema, tree, node, thread, branch, staging, run, turn, and verdicts.
- Flexible kernel payloads such as records, verdict metadata, observe payloads,
  interrupt payloads, and error details travel as deterministic kernel CBOR
  bytes.
- Path values, verdicts, and staged-result outcomes use Protobuf `oneof`
  envelopes to preserve kernel union semantics in the transport authority.
- `node.walkBack` is server-streaming; all other initial RPCs are unary.
- `KernelErrorPayload` gives the transport a stable error envelope without
  leaking language-native exception shapes.

## Target Wiring

- `kernel-interop-grpc` now exposes `lint`, `breaking`, `codegen`, and
  `interop-smoke` targets.
- The Buf-backed Nx targets now assume the repo shell is already provisioned
  through `.envrc` / `devenv`, keeping root `bun run codegen`,
  `bun run interop-smoke`, and verify usable without wrapping every command in
  an extra `devenv shell --` hop.
- Root `bun run codegen` and `bun run interop-smoke` now include
  `kernel-interop-grpc`.
- `tools/scripts/verify.ts` now includes interop code generation plus the
  governance smoke lane.
- The first breaking check refreshes `origin/master` before deciding whether
  the against branch has no prior `.proto` baseline; once this change lands,
  later proto changes compare against the existing baseline through Buf `FILE`
  compatibility instead of relying on stale local refs.

## Validation Evidence

- `buf lint`
- `protoc-gen-es --version`
- `bun tools/scripts/kernel-interop-governance.ts breaking`
- `bun tools/scripts/kernel-interop-governance.ts codegen`
- `bun run nx run kernel-interop-grpc:interop-smoke --skipNxCache`
- `bun tools/scripts/verify.ts`

## Residual Transitional Truth

- No generated language bindings are checked in.
- The compatibility matrix still records no interop pass entries because no
  Rust kernel service exists yet.
- `interop-smoke` is a governance and generation smoke target in Epic T. Epic V
  upgrades interop evidence to real TypeScript framework to Rust kernel runtime
  scenarios.
