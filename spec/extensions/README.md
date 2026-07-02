# Extensions port — engine-seam stub (87-M3)

This directory is the future home of the hook/extension port contract.
The authority is authored at **M7** from existing material only (issue
#87 §13); this stub only declares the engine↔extensions seam that the
engine compiles against today, per the M3 gate ("only the engine↔port
interface seams … as minimal stubs").

Engine-facing seam surface (measured at 87-M3.4):

- `@tuvren/core/extensions` vocabulary — neutral authority:
  `spec/core/authority-packet.json` + `spec/core/typespec/main.tsp`.

No standalone extensions authority packet exists today; the extension
type surface is core-owned vocabulary plus the engine's
`extension-runtime.ts` facade. M7 consolidates that existing material
here without inventing new behavior.

This stub is a pointer, not an oracle: cross-language semantic truth
lives in the referenced authority packets, generated artifacts, and
conformance plans — never in this file.
