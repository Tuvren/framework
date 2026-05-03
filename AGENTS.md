# Repository Guidelines

## Structure
Keep this architecture-first, multi-language runtime monorepo organized by boundary.

- Put runtime code and semantic assets under `boundaries/`.
- Use `boundaries/framework/`, `kernel/`, `providers/`, `hosts/`, and `shared/` for their named runtime areas only.
- Keep language-neutral assets at boundary, contract, conformance, and interop roots.
- Put language-specific packages only under `implementations/<lang>/`.
- Put boundary testkits only under `boundaries/<area>/implementations/<lang>/testkit/`.
- Do not put `package.json`, `Cargo.toml`, `src/`, `dist/`, `test/`, `bench/`, `smoke/`, `tsconfig*.json`, generated bindings, or language tooling output at boundary or contract roots.

## Authority
Treat machine-readable authority as the source of cross-language truth.

- Read `docs/KrakenKernelSpecification.md` before changing kernel behavior.
- Read `docs/KrakenFrameworkSpecification.md` before changing framework behavior.
- Keep `constitution/TechSpec.md`, `constitution/Tasks.md`, and `constitution/spikes/` aligned with implementation scope.
- Keep `contracts/`, `conformance/`, `interop/`, generated artifacts, and compatibility evidence aligned when semantics change.
- Do not make Markdown, implementation source, or runner code the oracle for cross-implementation behavior.
- Cite or derive semantic claims from authority packets, generated artifacts, conformance plans, interop assets, or measured evidence.
- Add or extend an authority packet when a surface lacks one; do not invent cross-language truth in an implementation path.

## Tooling
Use native tools as ecosystem truth and Nx as a wrapper.

- Use `bun` for package management and TypeScript runtime entry points.
- Use Cargo for Rust workspace truth.
- Use Buf for protobuf governance.
- Use TypeSpec, Weaver, and other generator CLIs for their artifact families.
- Use Nx for target routing and developer ergonomics, not as the canonical contract authority.
- Prefer native commands behind Nx targets when adding cross-language build, test, codegen, or interop lanes.
- Make generators leave checked-in artifacts formatter-clean; do not rely on a one-off manual format after regeneration.
- Encode generated-artifact prerequisites in Nx targets when source imports gitignored or derived files.

## Commands
- Run `bun run lint`, `format`, `typecheck`, `codegen`, `interop-smoke`, and `verify` for repo checks.
- Run `bun run conformance` for active conformance lanes.
- Run `bun run compatibility:evidence` only to refresh checked-in compatibility evidence, including intentional red lanes.
- Run `bun run verify` before claiming broad workspace readiness.
- Run `bun run nx run <project>:test`, `:typecheck`, or `:build` for narrow TypeScript checks.

## Code
Keep public naming and boundaries clean.

- Use `Tuvren` for product and host-developer APIs.
- Use `Kraken` for engine internals only.
- Do not make ordinary library consumers type `Kraken*`.
- Keep host/framework controls above the kernel transport seam.
- Keep kernel interop protocol-only and data-only.
- Derive generated TypeScript and Rust helpers from owned sources.
- Keep package entrypoints small and explicit.

## Conformance
Keep semantic decisions in shared plans and shared runner code.

- Use `tools/conformance/runner/run.ts` as the shared semantic conformance engine.
- Put adapter hosts under `boundaries/<area>/implementations/<lang>/conformance-adapter/`.
- Keep implementation `conformance-runner/` projects as wrappers only.
- Do not add assertions, pass/fail grading, required-evidence grading, compatibility evidence writing, check IDs, or check-scoped evidence to adapters or implementation runners.
- Do not let adapters receive `checkId`, call `emitEvidence`, decide pass/fail, replay fixtures as implementation proof, or map adapter/protocol failures into `$.result.error`.
- Select promoted checks by capability or surface requirement, not by language, adapter ID, implementation ID, or runner name.
- Treat every conformance plan `evidence` entry as required evidence.
- Keep ReAct-specific behavior in ReAct authority packets and plans, not neutral driver plans.
- Keep authority fixture validation separate from implementation conformance.
- Use implementation-emitted events for event-stream conformance.
- Make assertion names match the data source the runner actually evaluates; do not claim evidence coverage from an assertion that reads events, state, result, or fixture data instead.
- Fail normal `conformance`, `codegen`, and `verify` gates when structured evidence has `status: "fail"`.
- Compute canonical encodings (CBOR bytes, hash digests, schema signatures) with the TypeScript reference implementation and commit the result under `boundaries/<area>/conformance/fixtures/`. The committed JSON is authority; the generator is tooling. Cross-validate against another language's reference encoder before promotion once a second implementation exists, and prefer agreement between implementations over single-language computation.

## Tests And PRs
Validate the narrowest relevant target first, then broaden.

- Keep package-local tests near the package they verify.
- Keep reusable behavioral assets under boundary-owned `conformance/` or `interop/`.
- Do not make root `tests/` an authority home or reusable semantic fixture source.
- Give every claimed scenario matrix an automated check path.
- Validate public behavior and durable state, not object existence or generic completion.
- Align specs, contracts, implementations, tests, docs, and constitution together when review exposes a mismatch.
- Use disposable state or explicit cleanup for persistent smoke targets.
- Keep `AGENTS.md` durable; remove branch-specific guidance before merge.
