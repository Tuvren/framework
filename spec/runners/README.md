# Runners port — authority

The execution-model (runner) port authority is physically consolidated
here as of 87-M6.1b (lifted from `boundaries/framework/contracts/driver-api/`
and `boundaries/framework/contracts/react-driver/`, merging both contract
roots' READMEs into this file):

- `typespec/` — the reviewed TypeSpec source (`main.tsp`) for the neutral
  runner/driver operation and payload surface.
- `bindings/` — language-specific binding appendices (`typescript.md`,
  `rust.md`).
- `artifacts/json-schema/` — the reviewed JSON Schema outputs generated
  from the TypeSpec source (regenerated via `runners-spec:codegen`).
- `react/authority-packet.json` — the ReAct-specific conformance
  authority, packetId `tuvren.framework.react-driver`. Sub-surface
  nesting follows the `spec/tools/mcp/` precedent (87-M5.1c): a
  sub-surface authority packet nests under the port root it extends.

**The neutral execution-model contract has no packet of its own.** It is
`tuvren.shared.core` authority (`spec/core/authority-packet.json`,
`driver` binding section, ADR-037). The old `boundaries/framework/contracts/driver-api/`
READMEs claimed a standalone `tuvren.framework.driver-api` packet existed;
that claim was stale and is not carried over here — do not reintroduce it.

Conformance plans live at `spec/conformance/runners/plans/` (four plans:
`driver-api-core`, `driver-api-extended`, `react-driver-callables`,
`react-driver-extended`) with the shared scenario fixture at
`spec/conformance/runners/scenarios/driver-api-scenarios.json`.

Filenames and all identities (packetId, planId, checkId, capability) in
this port deliberately retain their driver-era names as of 87-M6.1b; the
driver→runner identity rename lands at 87-M6.4. Do not rename any
identity or file based on this README.

The ReAct execution-model implementation lives at
`typescript/runners/react` (`@tuvren/runner-react`, migrated as a runner
at 87-M6.2).

This is a pointer, not an oracle: cross-language semantic truth lives in
the referenced authority packets, generated artifacts, and conformance
plans — never in this file.
