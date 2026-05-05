# Epic W Semantic Coverage Matrix

## Purpose

This matrix records where the shared semantic system now lives after Epic W,
which surfaces were promoted into boundary-owned suites, and which areas remain
implementation-specific or intentionally deferred.

## Matrix

| Surface | Human Authority | Boundary-Owned Coverage | Prior Implementation Evidence | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Kernel deterministic hashing and identity | `docs/KrakenKernelSpecification.md` sections on objects, records, and identity | `tuvren.kernel.protocol-seed@0.2.0` -> `kernel.protocol.deterministic_hashing`, `kernel.protocol.schema_roundtrip` | TS kernel runner fixture/hash tests, Rust kernel baseline | Promoted | Now check-level evidence in both TS and Rust runners |
| Kernel logical diff and branch listing | `docs/KrakenKernelSpecification.md` tree and branch semantics | `tuvren.kernel.protocol-seed@0.2.0` -> `kernel.logical.diff_paths`, `kernel.logical.branch_list` | TS and Rust kernel baselines | Promoted | These checks are boundary-owned and now measured through native kernel adapters in both current implementation lines |
| Kernel recovery-state shape | `docs/KrakenKernelSpecification.md` recovery and run ownership | `tuvren.kernel.protocol-seed@0.2.0` -> `kernel.logical.recovery_state` | TS and Rust kernel baselines | Promoted | Recovery proof now names required assertions instead of suite-only pass/fail, and both current kernel adapters emit the required evidence |
| Kernel lineage rejection | `docs/KrakenKernelSpecification.md` lineage proofs and cross-thread rejection | `tuvren.kernel.protocol-seed@0.2.0` -> `kernel.lineage.cross_thread_rejection` | TS and Rust kernel baselines | Promoted | The shared suite owns the semantic authority and both current kernel adapters now claim passing measured evidence for this check |
| Canonical framework event sequencing | `docs/KrakenFrameworkSpecification.md` event stream contract | `tuvren.framework.stream-events@0.2.0` -> `framework.stream.completed_turn_sequence`, `framework.stream.failed_turn_terminal_error`, `framework.stream.paused_turn_approval_shape` | Framework conformance fixture test, stream adapter tests | Promoted | Boundary suite now names the event-order and terminal-state assertions explicitly |
| SSE projection semantics | `docs/KrakenFrameworkSpecification.md` host stream projections | `tuvren.framework.stream-events@0.2.0` -> `framework.stream.sse_projection`, `framework.stream.sse_eager_subscription` | `stream-sse` implementation tests | Promoted | Moved from adapter-local tests into boundary-owned framework evidence |
| AG-UI projection semantics | `docs/KrakenFrameworkSpecification.md` host stream projections | `tuvren.framework.stream-events@0.2.0` -> `framework.stream.agui_projection`, `framework.stream.agui_failed_turn_error_projection`, `framework.stream.agui_paused_turn_fallback` | `stream-agui` implementation tests | Promoted | Includes paused-turn fallback and failure mapping semantics |
| Provider prompt/response fixture contract | `docs/KrakenFrameworkSpecification.md` provider-neutral prompt and response semantics | `tuvren.providers.api-fixtures@0.2.0` -> `providers.fixture.*` checks | Provider testkit fixture tests | Promoted | Fixture corpus is still boundary-owned; evidence is now check-level |
| AI SDK bridge generate/stream/structured/failure semantics | `docs/KrakenFrameworkSpecification.md` provider contract and structured output sections | `tuvren.providers.api-fixtures@0.2.0` -> `providers.bridge.*` checks | `bridge-ai-sdk` implementation tests, playground lanes | Promoted | Shared provider-facing semantics now sit in provider conformance evidence instead of only package tests |
| TS framework <-> Rust kernel streaming, structured output, tools, approvals, cancel, metadata, branching, steering, reload | `docs/KrakenFrameworkSpecification.md`, `docs/KrakenKernelSpecification.md` | `tuvren.framework.kernel-interop-smoke@0.2.0` -> `framework.interop.*` checks | Playground interop-smoke JSON report | Promoted | Interop evidence now names scenario-level semantic checks, not only suite success |
| Compatibility reporting | `constitution/TechSpec.md` sections `3.6`, `4.10`, `4.8` | `reports/compatibility/compatibility-matrix.json`, suite evidence files | Prior suite-level matrix and command-level evidence files | Promoted | Matrix now records `checkIds` and `checkSummary` for every implementation and interop result, and the checked-in artifacts use deterministic sentinel metadata plus scrubbed interop telemetry values so reruns do not create review-noise churn |
| ReAct loop-policy edge cases, extension hook sequencing, handoff builders, parallel tool batching internals | `docs/KrakenFrameworkSpecification.md` | No boundary-owned suite yet | `runtime-core` and `driver-react` TypeScript implementation tests | Deferred with rationale | Still valuable, but not yet promoted into a language-neutral framework suite; later framework-line activation must decide whether each is shared semantic authority or implementation-local machinery |
| SQLite migration layout, health probes, index-plan assertions, corruption detection | `docs/KrakenKernelSpecification.md` backend freedom posture | No boundary-owned cross-language suite | `backend-sqlite` implementation tests | Implementation-specific | These are official-backend guarantees, not current cross-language semantic authority for a future framework line |
| AI SDK provider-family metadata quirks and real Gemini lane behavior | `docs/KrakenFrameworkSpecification.md` provider-neutral semantics | Interop and provider suites cover neutral metadata continuity only | Playground aimock/Gemini lanes, bridge package tests | Implementation-specific | Provider-family quirks remain local validation, not shared ecosystem authority |

## Summary

- Promoted shared suites now cover named kernel, framework, provider, stream,
  and interop semantics with assertion-bearing evidence.
- Remaining gaps are explicit instead of hidden inside TypeScript package
  tests.
- Future implementation-line work must cite the promoted suites and the closure
  inventory rather than treating the old TypeScript-local tests as implicit
  authority.
