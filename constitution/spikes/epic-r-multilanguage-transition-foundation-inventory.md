# Epic R Multilanguage Transition Foundation Inventory

This file closes Epic R against current repo reality. Epic R formalizes the
language-agnostic artifact foundation that later Epics S and T extend; it does
not pull TypeSpec, CDDL, Buf, or Rust implementation work forward out of those
epics.

## Status

- Epic R is closed in current repo reality.
- `KRT-R001` through `KRT-R004` are complete.
- Epic S is now the next active implementation line.
- Epic T still owns `.proto` authorship, Buf governance, and the first real
  `interop-smoke` execution lane.

## Delivered Foundation

- Repo-global authority homes now exist under `telemetry/` and
  `reports/compatibility/`.
- Boundary-owned conformance roots now exist under:
  - `boundaries/framework/conformance/`
  - `boundaries/kernel/conformance/`
  - `boundaries/providers/conformance/`
- Boundary-owned future contract-authority homes now exist under:
  - `boundaries/framework/contracts/tool-contracts/{spec,artifacts}/`
  - `boundaries/kernel/contracts/protocol/{spec,artifacts}/`
  - `boundaries/providers/contracts/provider-api/{spec,artifacts}/`
  - `boundaries/shared/contracts/core-types/{spec,artifacts}/`
- The future kernel interop authority home now exists under
  `boundaries/kernel/interop/grpc/proto/`.
- Each new `spec/` and `artifacts/` home includes an authority note that
  records present ownership, intended authored-source family, and reviewed
  artifact posture.

## Seeded Conformance Assets

- Framework conformance now has a boundary-owned fixture schema, stream-event
  fixture set, and suite manifest under `boundaries/framework/conformance/`.
- Kernel conformance now has a boundary-owned fixture schema, canonical turn
  tree fixture, deterministic protocol fixture, logical protocol fixture, and
  suite manifest under `boundaries/kernel/conformance/`.
- Provider conformance now has a boundary-owned fixture schema, provider
  fixture corpus, and suite manifest under `boundaries/providers/conformance/`.
- The current TypeScript testkits now consume those boundary-owned assets as
  transitional runners instead of remaining the root authority for the suites.

## Canonical Target Vocabulary

- The active repo-wide target vocabulary now includes `lint`, `typecheck`,
  `conformance`, and `codegen`.
- Current Nx projects expose cacheable `lint` targets scoped to their project
  roots with Biome.
- `framework-testkit`, `kernel-testkit`, and `providers-testkit` now expose
  canonical `conformance` targets that exercise the shared boundary-owned
  assets.
- `telemetry-semconv` and `compatibility-reporting` now expose canonical
  `codegen` targets.
- `interop-smoke` remains reserved for Epic T rather than being backfilled with
  a fake green placeholder lane.
- `tools/scripts/verify.ts` and `tools/scripts/release-check.ts` now use
  transition-neutral naming and include the new conformance and codegen lanes.

## Telemetry And Compatibility Outputs

- `telemetry/semconv/tuvren-runtime.yaml` is now the authored semantic-
  convention source for runtime identity and correlation attributes.
- `telemetry/semconv/registry_manifest.yaml` and
  `tools/generators/telemetry/README.md` document the generation path.
- `telemetry/semantic-conventions.md`,
  `telemetry/otel-attributes.json`, and the generated TypeScript helper at
  `boundaries/framework/implementations/typescript/runtime-core/src/lib/generated/tuvren-runtime-telemetry.ts`
  are now derived outputs of that source.
- `reports/compatibility/compatibility-matrix.schema.json` defines the
  generated compatibility-ledger shape.
- `reports/compatibility/compatibility-matrix.json` is now generated from
  measured TypeScript conformance evidence only, with concrete evidence files
  under `reports/compatibility/evidence/`.
- `interop` remains `[]` until later epics provide real interop-smoke evidence.

## Validation Evidence

- `bun run nx run-many -t typecheck -p framework-testkit,providers-testkit,kernel-testkit`
- `bun run conformance`
- `devenv shell bun run codegen`

## Residual Transitional Truth

- The current TypeScript testkits still exist, but they now operate as
  transitional runners over boundary-owned language-agnostic assets.
- Full TypeSpec and CDDL promotion remains Epic S work.
- Real `.proto` authorship, Buf config, and first `interop-smoke` execution
  remain Epic T work.
- Rust helper generation is configured as part of the telemetry path, but no
  generated Rust helper is checked in until a Rust implementation tree exists.
