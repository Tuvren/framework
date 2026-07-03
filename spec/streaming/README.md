# Streaming port — authority

The event-stream port authority is physically consolidated here as of
87-M8.1a (lifted from `boundaries/framework/contracts/event-stream/` and
`boundaries/framework/contracts/event-stream-sse/`, merging both contract
roots' READMEs into this file):

- `typespec/` — the reviewed TypeSpec source (`main.tsp`) for the neutral
  stream-event shape.
- `bindings/` — language-specific binding appendices (`typescript.md`).
- `artifacts/json-schema/` — the reviewed JSON Schema outputs generated
  from the TypeSpec source (regenerated via `streaming-spec:codegen`).
- `sse/` — the Server-Sent Events wire-projection sub-surface, with its
  own `typespec/`, `bindings/`, `artifacts/json-schema/`, and standalone
  `authority-packet.json` (packetId `tuvren.framework.event-stream-sse`).
  Sub-surface nesting follows the `spec/tools/mcp/` precedent (87-M5.1c):
  a sub-surface authority packet nests under the port root it extends.

**The neutral stream-event contract has no packet of its own.** It is
`tuvren.shared.core` authority (`spec/core/authority-packet.json`,
`events` binding section, ADR-037). The old
`boundaries/framework/contracts/event-stream/README.md` claimed the
cross-implementation authority was `spec/authority-packet.json`; that
file never existed and the claim was stale — do not reintroduce it. Only
`event-stream-sse` has a standalone packet, now at
`spec/streaming/sse/authority-packet.json`.

Conformance plans live at `spec/conformance/streaming/plans/` (three
plans: `event-stream-core`, `event-stream-extended`,
`event-stream-sse`), fixtures live at
`spec/conformance/streaming/fixtures/` (`stream-events.json`,
`event-stream-sse-traces.json`), and the shared scenario fixture is at
`spec/conformance/streaming/scenarios/event-stream-scenarios.json`.

The TypeScript package implementation for `@tuvren/event-stream` still
lives at `boundaries/framework/contracts/event-stream/implementations/`
(a shim retiring at 87-M8.1c) and the SSE decoder implementation lives
at `typescript/streaming/sse` (moved to the idiomatic TypeScript tree at
87-M8.1b); both are binding projections of the packets above, not
authority.

This is a pointer, not an oracle: cross-language semantic truth lives in
the referenced authority packets, generated artifacts, and conformance
plans — never in this file.
