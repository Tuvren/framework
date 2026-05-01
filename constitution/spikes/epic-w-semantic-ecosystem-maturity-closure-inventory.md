# Epic W Semantic Ecosystem Maturity Closure Inventory

## Outcome

Epic W is closed in current repo reality. The repository now treats semantic
evidence as named, boundary-owned checks rather than as suite-level smoke
success or TypeScript-local test lore.

## Delivered Artifacts

- `constitution/spikes/epic-w-semantic-coverage-matrix.md`
- Assertion-bearing conformance manifests:
  - `boundaries/framework/conformance/plans/event-stream-core.json`
  - `boundaries/kernel/conformance/scenarios/suite-manifest.json`
  - `boundaries/providers/conformance/scenarios/suite-manifest.json`
  - `boundaries/framework/interop/rust-kernel/scenarios/suite-manifest.json`
- Structured conformance runner evidence for:
  - `typescript-framework`
  - `typescript-kernel`
  - `typescript-providers`
  - `rust-kernel`
- Compatibility evidence hardening in:
  - `reports/compatibility/compatibility-matrix.json`
  - `reports/compatibility/compatibility-matrix.schema.json`
  - `reports/compatibility/evidence/*`

## Mature Semantic Surfaces

- Kernel deterministic hashing and schema/identity roundtrip are now named
  checks under `tuvren.kernel.protocol-seed@0.2.0` with passing measured
  evidence from both `typescript-kernel` and `rust-kernel`.
- Kernel logical diff, branch listing, recovery-state shape, cross-thread
  lineage rejection, and lateral turn-head rejection are now named checks
  under `tuvren.kernel.protocol-seed@0.2.0` with passing measured evidence
  from `rust-kernel`; `typescript-kernel` no longer claims those checks until
  it can prove them through real implementation behavior rather than
  fixture-only or backend-local evidence.
- Framework canonical stream sequencing, paused/failed terminal semantics, SSE
  framing, and AG-UI projection/fallback/error mapping are now named checks
  under `tuvren.framework.stream-events@0.2.0`.
- Provider-neutral prompt/response fixtures plus AI SDK bridge generate, stream,
  structured-output, and stable-failure normalization semantics are now named
  checks under `tuvren.providers.api-fixtures@0.2.0`.
- TypeScript-framework to Rust-kernel interop now records named scenario checks
  for streaming, structured output, tools, approvals, cancel, metadata,
  branching, steering, and reload under
  `tuvren.framework.kernel-interop-smoke@0.2.0`.
- Compatibility reporting now records `checkIds` and `checkSummary` for every
  implementation and interop result instead of only suite-level status.
- Checked-in compatibility artifacts now use deterministic sentinel metadata
  plus scrubbed interop telemetry attribute values so regenerated evidence is
  reviewable without run-specific churn.

## Deferred or Local-Only Surfaces

- ReAct loop-policy edge cases, extension hook sequencing, handoff builders,
  and the deepest parallel tool-batching rules remain TypeScript implementation
  tests today. They are documented in the Epic W coverage matrix as deferred
  semantic promotion work rather than hidden authority.
- SQLite migration shape, health/invariant checks, corruption probes, and index
  plan assertions remain official-backend local validation, not current
  cross-language semantic authority.
- Provider-family-specific metadata quirks and the real Gemini lane remain
  implementation-local validation instead of shared ecosystem authority.

## Future Implementation-Line Gate

Any later TechSpec revision that wants to authorize Rust framework work, a new
driver, a new official backend, or another language line must cite:

- passing `tuvren.kernel.protocol-seed@0.2.0` evidence for the participating
  implementation
- passing `tuvren.framework.stream-events@0.2.0` and
  `tuvren.providers.api-fixtures@0.2.0` evidence for any implementation that
  claims those surfaces
- passing `tuvren.framework.kernel-interop-smoke@0.2.0` evidence for any
  framework-to-kernel cross-language pair it depends on
- the Epic W coverage matrix classification for any still-deferred semantic
  surface it wants to rely on

No future activation may cite object existence, package exports, or coarse smoke
success alone as proof of semantic readiness.
