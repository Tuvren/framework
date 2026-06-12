# Epic Y Shared Conformance Engine Closure Inventory

## Status

Closed in current repo reality for KRT-Y014 through KRT-Y023.

## Shared Runner

- `tools/conformance/runner/run.ts` is the only semantic conformance runner.
- `tools/conformance/runner/assertion-engine/` owns generic assertions and required evidence.
- `tools/conformance/runner/adapter-client.ts` owns JSON-RPC stdio adapter execution and adapter-error isolation.
- `tools/conformance/meta-conformance/run.ts` covers assertion operators, path references, missing paths, required evidence, adapter-error isolation, and a 1,000-check scale probe.

## Adapter Hosts

- TypeScript framework/ReAct/runtime: `boundaries/framework/implementations/typescript/conformance-adapter/`
- TypeScript kernel: `boundaries/kernel/implementations/typescript/conformance-adapter/`
- TypeScript providers: `boundaries/providers/implementations/typescript/conformance-adapter/`
- Rust kernel: `boundaries/kernel/implementations/rust/conformance-adapter/`
- Rust framework: `boundaries/framework/implementations/rust/conformance-adapter/`

Remaining `conformance-runner/` projects are native or Nx wrappers only. They do not evaluate assertions, grade pass/fail, enforce required evidence, or write compatibility evidence.

## Authority Packets And Plans

- Framework authority packets remain the promoted source for runtime, driver, event-stream, and ReAct checks.
- `tuvren.kernel.protocol` now owns the current kernel protocol plan.
- `tuvren.providers.provider-api` now owns the current provider bridge plan.
- Provider fixture-shape checks are authority fixture validation, not implementation conformance evidence.

## Current Evidence Posture

- TypeScript framework: green through native observations and trace plans.
- TypeScript kernel: green for `kernel.protocol` and the current promoted `kernel.logical` checks through native `@tuvren/kernel-runtime` observations.
- TypeScript providers: green for provider bridge observations.
- Rust kernel: green through the native Rust adapter and shared runner.
- Rust framework: red because native Rust framework/runtime/ReAct behavior is not implemented.

Checked-in compatibility evidence uses `reports/compatibility/evidence/shared-conformance-runner.<implementationId>.json`.

## Guardrails

`tools/scripts/authority-guardrails/authority-guardrails.ts` now discovers every current `conformance-runner/src` and `conformance-adapter/src` root under `boundaries/` and scans TypeScript and Rust sources for check IDs, grading/evidence-writer tokens, forbidden operation literals outside routing, fixture self-certification, and forbidden authority evidence.

## Deferred Gaps

- Rust framework product behavior remains deferred beyond Epic Y.
- Additional future surfaces still need authority packets before they can claim cross-implementation conformance.
- Normal `conformance`, `codegen`, and `verify` lanes remain red when they evaluate checked-in red evidence; `compatibility:evidence` is the intentional red-evidence refresh lane.
