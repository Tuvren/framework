# Epic X TypeScript Topology Normalization Inventory

This file is the frozen input for Epic X implementation. It verifies the live
repository state behind `constitution/spikes/epic-x-typescript-topology-normalization-plan.md`
and records the concrete move set plus the rewire hotspots that must stay in
scope until Epic X closes.

## Status

- Recorded against live repo state on 2026-04-30.
- Scope matches `KRT-X001` in `constitution/Tasks.md`.
- This is an implementation input, not a closure inventory.

## Impacted TypeScript Package Roots

### Boundary-root testkits to relocate

- `boundaries/kernel/testkit/` -> `boundaries/kernel/implementations/typescript/testkit/`
- `boundaries/framework/testkit/` -> `boundaries/framework/implementations/typescript/testkit/`
- `boundaries/providers/testkit/` -> `boundaries/providers/implementations/typescript/testkit/`

Tracked TypeScript package assets present at each boundary-root testkit:

- `package.json`
- `project.json`
- `src/`
- `test/`
- `smoke/`
- `tsconfig.json`
- `tsconfig.lib.json`
- `tsconfig.typecheck.json`
- `tsconfig.dts.json`
- `tsconfig.tsup.json`
- `tsup.config.ts`

Generated or local-only language-specific outputs also present and required to
leave the old roots during relocation:

- `dist/`
- `node_modules/`
- `tsconfig.lib.tsbuildinfo`

### Contract roots mixing neutral and TypeScript assets

- `boundaries/kernel/contracts/protocol/` (`@tuvren/kernel-protocol`)
- `boundaries/framework/contracts/runtime-api/` (`@tuvren/runtime-api`)
- `boundaries/framework/contracts/driver-api/` (`@tuvren/driver-api`)
- `boundaries/framework/contracts/event-stream/` (`@tuvren/event-stream`)
- `boundaries/framework/contracts/tool-contracts/` (`@tuvren/tool-contracts`)
- `boundaries/providers/contracts/provider-api/` (`@tuvren/provider-api`)
- `boundaries/shared/contracts/core-types/` (`@tuvren/core-types`)

Tracked TypeScript package assets present at one or more contract roots:

- `package.json`
- `project.json`
- `src/`
- `test/`
- `smoke/`
- `bench/` (`kernel-protocol` only)
- `tsconfig.json`
- `tsconfig.lib.json`
- `tsconfig.typecheck.json`
- `tsconfig.dts.json`
- `tsconfig.tsup.json`
- `tsup.config.ts`

Language-neutral assets that must remain at contract roots:

- `spec/`
- `artifacts/`
- root `README.md` files to be added by Epic X where missing

Generated or local-only language-specific outputs also present and required to
leave the old roots during relocation:

- `dist/`
- `node_modules/`
- `tsconfig.lib.tsbuildinfo`
- `tsconfig.tsbuildinfo` (`core-types`)

## Stable Workspace Package Names

- `@tuvren/kernel-testkit`
- `@tuvren/framework-testkit`
- `@tuvren/provider-testkit`
- `@tuvren/core-types`
- `@tuvren/kernel-protocol`
- `@tuvren/runtime-api`
- `@tuvren/driver-api`
- `@tuvren/event-stream`
- `@tuvren/tool-contracts`
- `@tuvren/provider-api`

Epic X keeps these names unchanged. Consumers resolve them through workspace
names, not by old directory paths.

## Stable Nx Project Names

- `kernel-testkit`
- `framework-testkit`
- `providers-testkit`
- `shared-core-types`
- `kernel-contract-protocol`
- `framework-runtime-api`
- `framework-driver-api`
- `framework-event-stream`
- `framework-tool-contracts`
- `provider-api`

Epic X changes each project root but keeps each project identity stable.

## Verified Consumer Manifests

### Testkit consumers

- `@tuvren/kernel-testkit`
  - `boundaries/kernel/implementations/typescript/backend-memory/package.json`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/package.json`
  - `boundaries/kernel/implementations/typescript/conformance-runner/package.json`
- `@tuvren/framework-testkit`
  - `boundaries/framework/implementations/typescript/conformance-runner/package.json`
  - `boundaries/framework/implementations/typescript/runtime-core/package.json`
  - `boundaries/framework/implementations/typescript/stream-agui/package.json`
  - `boundaries/framework/implementations/typescript/stream-core/package.json`
  - `boundaries/framework/implementations/typescript/stream-sse/package.json`
  - `boundaries/hosts/implementations/typescript/playground/package.json`
- `@tuvren/provider-testkit`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/package.json`
  - `boundaries/providers/implementations/typescript/conformance-runner/package.json`

### Contract package consumers

- `@tuvren/core-types`
  - `boundaries/framework/contracts/driver-api/package.json`
  - `boundaries/framework/contracts/runtime-api/package.json`
  - `boundaries/framework/implementations/typescript/drivers/react/package.json`
  - `boundaries/framework/implementations/typescript/runtime-core/package.json`
  - `boundaries/framework/implementations/typescript/stream-agui/package.json`
  - `boundaries/framework/implementations/typescript/stream-core/package.json`
  - `boundaries/hosts/implementations/typescript/playground/package.json`
  - `boundaries/kernel/contracts/protocol/package.json`
  - `boundaries/kernel/implementations/typescript/backend-memory/package.json`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/package.json`
  - `boundaries/kernel/implementations/typescript/conformance-runner/package.json`
  - `boundaries/kernel/testkit/package.json`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/package.json`
  - `boundaries/providers/implementations/typescript/conformance-runner/package.json`
- `@tuvren/kernel-protocol`
  - `boundaries/framework/implementations/typescript/runtime-core/package.json`
  - `boundaries/hosts/implementations/typescript/playground/package.json`
  - `boundaries/kernel/implementations/typescript/backend-memory/package.json`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/package.json`
  - `boundaries/kernel/implementations/typescript/conformance-runner/package.json`
  - `boundaries/kernel/testkit/package.json`
- `@tuvren/runtime-api`
  - `boundaries/framework/contracts/driver-api/package.json`
  - `boundaries/framework/contracts/event-stream/package.json`
  - `boundaries/framework/contracts/tool-contracts/package.json`
  - `boundaries/framework/implementations/typescript/drivers/react/package.json`
  - `boundaries/framework/implementations/typescript/runtime-core/package.json`
  - `boundaries/hosts/implementations/typescript/playground/package.json`
  - `boundaries/providers/contracts/provider-api/package.json`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/package.json`
- `@tuvren/driver-api`
  - `boundaries/framework/implementations/typescript/drivers/react/package.json`
  - `boundaries/framework/implementations/typescript/runtime-core/package.json`
- `@tuvren/event-stream`
  - `boundaries/framework/implementations/typescript/stream-agui/package.json`
  - `boundaries/framework/implementations/typescript/stream-core/package.json`
  - `boundaries/framework/implementations/typescript/stream-sse/package.json`
  - `boundaries/framework/testkit/package.json`
  - `boundaries/hosts/implementations/typescript/playground/package.json`
- `@tuvren/tool-contracts`
  - no workspace package consumers; validation remains package-local plus codegen
- `@tuvren/provider-api`
  - `boundaries/framework/implementations/typescript/drivers/react/package.json`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/package.json`
  - `boundaries/providers/testkit/package.json`

## Rewire Hotspots That Must Stay In Scope

### Root workspace and alias configuration

- root `package.json` workspace globs
- root `tsconfig.base.json` path aliases
- root `nx.json` namedInputs for moved testkits and moved contract projects

### Stable-script path references

- `tools/scripts/portability-check.ts`
- `tools/scripts/playground-interop-smoke.ts`

### Direct source or dist path references in package-local TS configs

These currently point at the old boundary-root testkits or contract roots and
must be updated during relocation:

- `boundaries/kernel/implementations/typescript/backend-memory/tsconfig*.json`
- `boundaries/kernel/implementations/typescript/backend-sqlite/tsconfig*.json`
- `boundaries/kernel/implementations/typescript/conformance-runner/tsconfig.typecheck.json`
- `boundaries/framework/implementations/typescript/runtime-core/tsconfig*.json`
- `boundaries/framework/implementations/typescript/drivers/react/tsconfig*.json`
- `boundaries/framework/implementations/typescript/stream-core/tsconfig*.json`
- `boundaries/framework/implementations/typescript/stream-sse/tsconfig*.json`
- `boundaries/framework/implementations/typescript/stream-agui/tsconfig*.json`
- `boundaries/framework/implementations/typescript/conformance-runner/tsconfig.typecheck.json`
- `boundaries/providers/implementations/typescript/bridge-ai-sdk/tsconfig*.json`
- `boundaries/providers/implementations/typescript/conformance-runner/tsconfig.typecheck.json`
- `boundaries/hosts/implementations/typescript/playground/tsconfig*.json`

### Direct imports that bypass workspace package handles

- `boundaries/kernel/implementations/typescript/conformance-runner/src/kernel-typescript-conformance.ts`
- `boundaries/kernel/implementations/typescript/conformance-runner/test/kernel-typescript-conformance.test.ts`
- `boundaries/framework/implementations/typescript/conformance-runner/test/framework-typescript-conformance.test.ts`
- `boundaries/providers/implementations/typescript/conformance-runner/test/providers-typescript-conformance.test.ts`

### Contract-root tests that intentionally read neutral assets

These stay package-local but need new relative paths after the TypeScript test
roots move under `implementations/typescript/`:

- `boundaries/kernel/contracts/protocol/test/kernel-cddl.test.ts`
- `boundaries/framework/contracts/tool-contracts/test/tool-contracts.test.ts`
- `boundaries/providers/contracts/provider-api/test/provider-api.test.ts`

## Deferred Neutral-Source Gaps

The following contract surfaces still have no authored language-neutral source
after topology normalization and remain explicitly deferred beyond Epic X:

- `boundaries/framework/contracts/runtime-api/`
- `boundaries/framework/contracts/driver-api/`
- `boundaries/framework/contracts/event-stream/`
- `boundaries/shared/contracts/core-types/`
