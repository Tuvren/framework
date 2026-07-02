# Providers port — engine-seam stub (87-M3)

This directory is the future home of the full provider port contract.
The full authority lifts at **M4** (issue #87 §13); this stub only
declares the engine↔providers seam that the engine compiles against
today, per the M3 gate ("only the engine↔port interface seams … as
minimal stubs").

Engine-facing seam surface (measured at 87-M3.4):

- `@tuvren/core/provider` vocabulary — neutral authority:
  `spec/core/authority-packet.json` + `spec/core/typespec/main.tsp`.

Interim full authority until M4:

- `boundaries/providers/contracts/provider-api/spec/authority-packet.json`

This stub is a pointer, not an oracle: cross-language semantic truth
lives in the referenced authority packets, generated artifacts, and
conformance plans — never in this file.
