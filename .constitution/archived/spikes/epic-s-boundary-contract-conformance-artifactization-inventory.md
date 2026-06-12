# Epic S Boundary Contract and Conformance Artifactization Inventory

This file closes Epic S against current repo reality. Epic S promotes selected
machine-readable contract sources, adds kernel record grammar, and makes the
TypeScript line consume boundary-owned conformance suites through
implementation-scoped runners.

## Status

- Epic S is closed in current repo reality.
- `KRT-S001` through `KRT-S004` are complete.
- Epic T is now the next active implementation line.
- Epic T still owns `.proto` authorship, Buf governance, generated transport
  bindings, and the first real `interop-smoke` lane.

## Contract Promotion Inventory

- Promoted now:
  - `boundaries/framework/contracts/tool-contracts/spec/typespec/`
  - `boundaries/providers/contracts/provider-api/spec/typespec/`
- Authored kernel grammar now:
  - `boundaries/kernel/contracts/protocol/spec/cddl/kernel-records.cddl`
- Deferred from this epic:
  - `runtime-api`, `event-stream`, and `driver-api` TypeSpec promotion because
    Epic S's target tree selected the focused tool/provider facades first
  - `core-types` promotion because shared growth remains intentionally minimal
  - `.proto`, Buf, Cargo, Rust, and interop-smoke work because Epic T/U own
    those seams

## Delivered Artifacts

- `@tuvren/tool-contracts` now owns TypeSpec-authored serializable tool,
  approval, validation, and tool-result-batch payload shapes.
- `@tuvren/provider-api` now owns TypeSpec-authored provider prompt, response,
  stream chunk, content part, structured-output, and rendered-tool payload
  shapes.
- Both promoted packages emit reviewed JSON Schema 2020-12 artifacts and
  OpenAPI 3.1 component catalogs under package-owned `artifacts/` directories.
- Kernel protocol CDDL now covers canonical record families, manifests, staged
  results, run records, stored records, and recovery-shaped payloads as grammar
  only.

## Conformance Runner Split

- TypeScript implementation-scoped conformance runner projects now exist under:
  - `boundaries/framework/implementations/typescript/conformance-runner/`
  - `boundaries/kernel/implementations/typescript/conformance-runner/`
  - `boundaries/providers/implementations/typescript/conformance-runner/`
- Root `bun run conformance` now targets those TypeScript runners instead of
  the transitional testkit package targets.
- Compatibility report generation now records measured evidence from the
  implementation-scoped runners.
- The existing testkit packages remain helper/facade packages for current
  implementation tests and do not own compatibility evidence.

## Validation Evidence

- `bunx --bun tsp compile boundaries/framework/contracts/tool-contracts/spec/typespec --pretty false`
- `bunx --bun tsp compile boundaries/providers/contracts/provider-api/spec/typespec --pretty false`
- `bunx --bun cddl validate boundaries/kernel/contracts/protocol/spec/cddl/kernel-records.cddl`
- `bun run nx run-many -t conformance -p kernel-typescript-conformance-runner,framework-typescript-conformance-runner,providers-typescript-conformance-runner --skipNxCache`
- `bun run nx run-many -t codegen -p framework-tool-contracts,provider-api,compatibility-reporting --skipNxCache`
- Focused package tests for `framework-tool-contracts`, `provider-api`, and
  `kernel-contract-protocol`

## Residual Transitional Truth

- OpenAPI artifacts are component catalogs for reviewed shape projection only;
  they do not introduce HTTP endpoints or host-facing runtime APIs.
- CDDL remains record grammar, not behavioral authority over recovery, lineage,
  or runtime policy.
- The TypeScript testkit packages are still useful helper packages. Later
  epics may shrink or republish them, but Epic S only demotes them from
  compatibility-evidence authority.
