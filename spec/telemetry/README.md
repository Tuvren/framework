# Telemetry port — engine-seam stub (87-M3)

This directory is the future home of the semconv vocabulary. The full
authority lifts at **M8** (issue #87 §13, three-home reconciliation);
this stub only declares the engine↔telemetry seam that the engine
compiles against today, per the M3 gate ("only the engine↔port
interface seams … as minimal stubs").

Engine-facing seam surface (measured at 87-M3.4):

- `@tuvren/core/telemetry` vocabulary — neutral authority:
  `spec/core/authority-packet.json` + `spec/core/typespec/main.tsp`.
- The generated semconv binding
  `typescript/runtime/src/lib/generated/tuvren-runtime-telemetry.ts`
  (emitted by the `telemetry-semconv:codegen` target).

Interim full authority until M8:

- `boundaries/telemetry/semconv/spec/authority-packet.json`

This stub is a pointer, not an oracle: cross-language semantic truth
lives in the referenced authority packets, generated artifacts, and
conformance plans — never in this file.
