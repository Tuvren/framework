# Core port — authority

The shared, behavior-free vocabulary of the framework is authoritative
here: messages and content shapes, events, errors, execution-result
types, tool and capability contracts, lifecycle and provider type
surfaces.

- `typespec/` — the reviewed TypeSpec source (`main.tsp`), the
  machine-readable contract projection for this surface.
- `authority-packet.json` — the packet for `tuvren.shared.core`, the
  consolidated shared-primitive packet that also owns several surfaces
  whose files live at other ports (runner-api, event-stream, tool
  contracts, host runtime-api — see those ports' READMEs for the
  pointer in the other direction).
- `bindings/` — language-binding appendices.
- `artifacts/` — the reviewed JSON Schema outputs generated from the
  TypeSpec source, plus the hand-authored capability schemas kept here
  until TypeSpec coverage is promoted (ADR-046).

There is no `spec/conformance/core/` lane: core vocabulary is exercised
through the consuming ports' plans (engine, kernel, providers, tools,
runners, streaming, telemetry), each binding checks to
`tuvren.shared.core` or to their own packets as applicable.

The TypeScript reference implementation is `@tuvren/core` at
`typescript/core/` (behavior-free by design; executable helpers live in
`@tuvren/sdk` at `typescript/sdk/`). This README is a pointer, not an
oracle — cross-language truth lives in the packet, the TypeSpec source,
and the committed conformance plans that bind to it.
