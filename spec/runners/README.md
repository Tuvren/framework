# Runners port — engine-seam stub (87-M3)

This directory is the future home of the full execution-model (runner)
port contract. The full authority lifts at **M6** (issue #87 §13); this
stub only declares the engine↔runners seam that the engine compiles
against today, per the M3 gate ("only the engine↔port interface seams
… as minimal stubs").

Engine-facing seam surface (measured at 87-M3.4):

- `@tuvren/core/driver` vocabulary — neutral authority:
  `spec/core/authority-packet.json` + `spec/core/typespec/main.tsp`.
- `@tuvren/driver-react` (`boundaries/framework/implementations/typescript/drivers/react`),
  the reference execution-model implementation the engine links today.

Interim full authority until M6:

- `boundaries/framework/contracts/driver-api/spec/` (TypeSpec + bindings)
- `boundaries/framework/contracts/react-driver/spec/authority-packet.json`

This stub is a pointer, not an oracle: cross-language semantic truth
lives in the referenced authority packets, generated artifacts, and
conformance plans — never in this file.
