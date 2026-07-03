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
  `typescript/runtime/src/lib/generated/tuvren-runtime-telemetry.ts` and
  `rust/kernel/src/generated/tuvren_runtime_telemetry.rs`.

Engine-facing seam surface (measured at 87-M3.4, still current):

- `@tuvren/core/telemetry` vocabulary — neutral authority:
  `spec/core/authority-packet.json` + `spec/core/typespec/main.tsp`.
- The generated semconv binding
  `typescript/runtime/src/lib/generated/tuvren-runtime-telemetry.ts`
  (emitted by the `telemetry-spec:codegen` target).

Conformance plans live at `spec/conformance/telemetry/plans/`
(`framework-operational-telemetry`, `invocation-lifecycle-observation`),
scenarios at `spec/conformance/telemetry/scenarios/`. The shared
`schemas/fixture-set.schema.json` stays at
`boundaries/framework/conformance/schemas/` (no single port owner, per
87-M8.4).

Still deferred to a later milestone (87-M8.2b): the OTel sink
implementation package `@tuvren/telemetry-otel`
(`boundaries/framework/implementations/typescript/telemetry-otel`), which
moves to an idiomatic `typescript/telemetry/...` subpath.

This directory is a pointer, not an oracle: cross-language semantic truth
lives in the referenced authority packet, generated artifacts, and
conformance plans — never in this file.
