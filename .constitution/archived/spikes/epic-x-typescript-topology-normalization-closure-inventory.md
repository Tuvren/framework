# Epic X TypeScript Topology Normalization Closure Inventory

Epic X is closed in current repo reality.

This file records what landed, which topology gaps it closed, what remains
deferred, and where the new authority now lives.

## Closed Gaps

- **Gap A closed:** the TypeScript-only boundary-root testkits no longer occupy
  language-neutral slots.
  - `boundaries/kernel/implementations/typescript/testkit/`
  - `boundaries/framework/implementations/typescript/testkit/`
  - `boundaries/providers/implementations/typescript/testkit/`
- **Gap B closed:** the TypeScript package guts for the seven moved contract
  packages now live under contract-owned `implementations/typescript/`
  subtrees instead of at contract roots.
  - `@tuvren/core-types`
  - `@tuvren/kernel-protocol`
  - `@tuvren/runtime-api`
  - `@tuvren/driver-api`
  - `@tuvren/event-stream`
  - `@tuvren/tool-contracts`
  - `@tuvren/provider-api`
- **Gap D closed:** the topology rule is now explicit in repo guidance and
  architecture language instead of only implied by transition planning.

## Stable Identities Preserved

- Package names did not change.
- Nx project names did not change.
- Public TypeScript export surfaces did not change.
- Boundary-owned conformance fixtures, suite manifests, and generated artifact
  contents did not change beyond path rewiring and regeneration from the same
  authored sources.

## Root And Tooling Rewires

- Root `package.json` workspace discovery now resolves contract package roots
  under `boundaries/*/contracts/*/implementations/*`.
- Root `tsconfig.base.json` path aliases now point at the relocated TypeScript
  implementation roots.
- Root `nx.json` namedInputs now watch implementation-tree testkits.
- `tools/scripts/portability-check.ts` and
  `tools/scripts/playground-interop-smoke.ts` now use the relocated package
  roots.
- Moved contract projects keep their stable Nx identities while codegen for
  `framework-tool-contracts` and `provider-api` still executes from the
  language-neutral contract roots so TypeSpec sources and artifact destinations
  remain boundary-owned.

## Guardrail Authority

- Root operating guidance: `AGENTS.md`
- Logical-risk mitigation note: `constitution/Architecture.md` section `6`
- Physical rule and ADR: `constitution/TechSpec.md` ADR-022 and the Epic X
  status sections

## Deferred Gap

- **Gap C remains deferred:** Epic X did not author a language-neutral source
  for these surfaces.
  - `boundaries/framework/contracts/runtime-api/`
  - `boundaries/framework/contracts/driver-api/`
  - `boundaries/framework/contracts/event-stream/`
  - `boundaries/shared/contracts/core-types/`

Those roots now carry explicit placeholder documentation and clean
`implementations/typescript/` subtrees, but promoting them to TypeSpec, CDDL,
or another neutral source remains a later epic.

## Validation Run

- `bun install`
- `bun run typecheck`
- `bun run codegen`
- `bun run conformance`
- `bun run interop-smoke`
- `bun run release-check`
- `bun run verify`
