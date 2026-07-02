# Tools port — engine-seam stub (87-M3)

This directory is the future home of the full tool + capability port
contract (execution classes, binding, policy). The full authority lifts
at **M5** (issue #87 §13); this stub only declares the engine↔tools
seam that the engine compiles against today, per the M3 gate ("only the
engine↔port interface seams … as minimal stubs").

Engine-facing seam surface (measured at 87-M3.4):

- `@tuvren/core/tools` and `@tuvren/core/capabilities` vocabulary —
  neutral authority: `spec/core/authority-packet.json` +
  `spec/core/typespec/main.tsp`.
- `@tuvren/mcp-client` (`boundaries/providers/implementations/typescript/mcp-client`),
  the MCP bus-driver the engine links today.

Interim full authority until M5:

- `boundaries/framework/contracts/tool-contracts/spec/` (TypeSpec)
- `boundaries/providers/contracts/mcp/spec/authority-packet.json`
  (moves cross-port into `spec/tools/` at M5 per issue §13)

This stub is a pointer, not an oracle: cross-language semantic truth
lives in the referenced authority packets, generated artifacts, and
conformance plans — never in this file.
