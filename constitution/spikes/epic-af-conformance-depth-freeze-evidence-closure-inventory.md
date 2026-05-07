# Epic AF Conformance Depth and Freeze Evidence Closure Inventory

## Status

Epic AF is closed in current repo reality.

## Decision

TypeScript is freeze-ready for the currently promoted framework, provider, and
kernel surfaces.

This closure does not activate Rust framework product work. Rust framework
remains unsupported for promoted framework checks until a later TechSpec and
Tasks revision explicitly opens that implementation line, defines advertised
capabilities, and produces its own shared-runner evidence.

## Delivered Scope

- `KRT-AF001` produced the generated conformance gap plan from the Epic AD
  docs-to-authority matrix, covering 14 promoted surfaces, one explicitly
  excluded package-topology surface, and 38 planned check IDs. The promoted set
  includes the selected portable subset of the former framework state-schema
  implementation-local surface.
- `KRT-AF002` promoted runtime lifecycle negative and interleaving behavior into
  boundary-owned framework conformance plans with required evidence.
- `KRT-AF003` promoted selected ReAct driver, extension hook, loop-policy, and
  `aroundModel` behavior into shared-runner evidence while leaving local driver
  implementation details out of portable authority.
- `KRT-AF004` expanded provider, structured-output, tool execution, approval,
  paused-run, and malformed-input boundary coverage without depending on
  AI SDK-specific mechanics as semantic authority.
- `KRT-AF005` closed the remaining orchestration leftovers through promoted
  handoff and worker-forwarded event-source checks.
- `KRT-AF006` expanded kernel edge-state coverage through the optional
  `kernel.edge-validation` capability, keeping Rust non-applicable where it
  does not advertise the extension.
- `KRT-AF007` wired freshness and authority guardrails so generated gap-plan
  drift, missing promoted check IDs, missing required evidence, incompatible
  compatibility evidence, and forbidden implementation/runner/Markdown oracle
  sources fail validation.
- `KRT-AF008` refreshed compatibility evidence and ran the freeze validation
  gates listed below.

## Evidence Anchors

- Gap plan: `constitution/spikes/epic-af-conformance-gap-plan.md`
- Gap plan source: `constitution/spikes/epic-af-conformance-gap-plan.json`
- Gap plan generator: `tools/scripts/epic-af-conformance-gap-plan.ts`
- Framework plans and scenarios: `boundaries/framework/conformance/plans/`;
  `boundaries/framework/conformance/scenarios/`
- Kernel plans: `boundaries/kernel/conformance/plans/`
- Framework adapter observations:
  `boundaries/framework/implementations/typescript/conformance-adapter/src/`
- Kernel adapter observations:
  `boundaries/kernel/implementations/typescript/conformance-adapter/src/`
- Compatibility matrix: `reports/compatibility/compatibility-matrix.json`
- Check-level evidence: `reports/compatibility/evidence/`

## Compatibility Evidence

The refreshed shared-runner evidence records:

| Implementation | Status | Applicable / Total | Non-applicable |
| --- | --- | ---: | ---: |
| `typescript-framework` | pass | 265 / 265 | 0 |
| `typescript-kernel-memory` | pass | 53 / 55 | 2 |
| `typescript-kernel-sqlite` | pass | 55 / 55 | 0 |
| `typescript-providers` | pass | 28 / 28 | 0 |
| `rust-kernel` | pass | 41 / 55 | 14 |
| `rust-framework` | pass | 0 / 265 | 265 |

Rust kernel remains capability-scoped for optional kernel extensions. Rust
framework remains an unsupported/non-applicable framework line, not a partially
implemented product surface.

## Freeze Validation

- `bun run conformance`: pass
- `bun run compatibility:evidence`: pass
- `bun run codegen`: pass
- `bun run interop-smoke`: pass
- `bun run release-check`: pass
- `bun run verify`: pass

`bun run release-check` reported the local Bun runtime version as a drift note,
not as a failing release gate. The substantive validation lanes above completed
successfully with the refreshed Epic AF evidence.

## Closure Notes

- TypeScript freeze-readiness is recorded only for the surfaces promoted into
  the current authority packet, conformance plan, adapter capability, and
  compatibility evidence set.
- Later driver, backend, provider, language, and host protocol expansion still
  requires a future TechSpec and Tasks revision. This includes Rust framework
  product work, future non-ReAct drivers, future official peer backends,
  provider-native tools, first-class Tuvren provider packages, and additional
  host protocols.
- Future semantic changes must update authority packets, plans, generated
  artifacts, guardrails, and compatibility evidence together.
