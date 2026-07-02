# Streaming port — engine-seam stub (87-M3)

This directory is the future home of the canonical event-stream
contract. The full authority lifts at **M8** (issue #87 §13); this stub
only declares the engine↔streaming seam that the engine compiles
against today, per the M3 gate ("only the engine↔port interface seams
… as minimal stubs").

Engine-facing seam surface (measured at 87-M3.4):

- `@tuvren/core/events` vocabulary — neutral authority:
  `spec/core/authority-packet.json` + `spec/core/typespec/main.tsp`.

Interim full authority until M8:

- `boundaries/framework/contracts/event-stream/spec/` (TypeSpec + bindings)
- `boundaries/framework/contracts/event-stream-sse/spec/authority-packet.json`

This stub is a pointer, not an oracle: cross-language semantic truth
lives in the referenced authority packets, generated artifacts, and
conformance plans — never in this file.
