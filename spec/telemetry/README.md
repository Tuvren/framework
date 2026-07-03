# Telemetry port — semconv authority

The telemetry semantic-convention vocabulary is physically consolidated here
as of 87-M8.2a (lifted from `boundaries/telemetry/semconv/spec/` and the
top-level `telemetry/` tree):

- `authority-packet.json` — the port authority packet (packetId
  `tuvren.telemetry.semconv`).
- `semconv/` — the authored OpenTelemetry semantic-convention source
  (`tuvren-runtime.yaml`, `registry_manifest.yaml`) consumed by Weaver.
- `artifacts/` — the reviewed derived outputs regenerated via the
  `telemetry-spec:codegen` target: `otel-attributes.json` and
  `semantic-conventions.md`.
- `project.json` — the Nx project `telemetry-spec`, driving the Weaver-based
  codegen that also emits the generated per-language helpers at
  `typescript/telemetry/semconv/src/lib/generated/tuvren-runtime-telemetry.ts`
  and `rust/kernel/src/generated/tuvren_runtime_telemetry.rs`.

Engine-facing seam surface (measured at 87-M3.4, current as of 87-M8.2b):

- `@tuvren/core/telemetry` vocabulary — neutral authority:
  `spec/core/authority-packet.json` + `spec/core/typespec/main.tsp`.
- The generated semconv binding now lives in its own leaf package,
  `@tuvren/telemetry-semconv` at `typescript/telemetry/semconv`
  (`src/lib/generated/tuvren-runtime-telemetry.ts`, emitted by the
  `telemetry-spec:codegen` target). `@tuvren/runtime` depends on the package
  and keeps re-exporting the same symbols from its public entrypoint for
  backward compatibility.

Conformance plans live at `spec/conformance/telemetry/plans/`
(`framework-operational-telemetry`, `invocation-lifecycle-observation`),
scenarios at `spec/conformance/telemetry/scenarios/`. The shared
`fixture-set.schema.json` lives at `spec/conformance/schemas/` (shared
asset, no single port owner — moved there at 87-M8.4).

87-M8.2b closed the deferred OTel sink move: the implementation package
`@tuvren/telemetry-otel` now lives at `typescript/telemetry/otel` (Nx project
name `framework-telemetry-otel` unchanged).

This directory is a pointer, not an oracle: cross-language semantic truth
lives in the referenced authority packet, generated artifacts, and
conformance plans — never in this file.
