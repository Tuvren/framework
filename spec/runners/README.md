# Runners port — authority

The execution-model (runner) port authority is physically consolidated
here as of 87-M6.1b (lifted from `boundaries/framework/contracts/driver-api/`
and `boundaries/framework/contracts/react-driver/`, merging both contract
roots' READMEs into this file):

- `typespec/` — the reviewed TypeSpec source (`main.tsp`) for the neutral
  runner operation and payload surface.
- `bindings/` — language-specific binding appendices (`typescript.md`,
  `rust.md`).
- `artifacts/json-schema/` — the reviewed JSON Schema outputs generated
  from the TypeSpec source (regenerated via `runners-spec:codegen`).
- `react/authority-packet.json` — the ReAct-specific conformance
  authority, packetId `tuvren.framework.react-runner`. Sub-surface
  nesting follows the `spec/tools/mcp/` precedent (87-M5.1c): a
  sub-surface authority packet nests under the port root it extends.

**The neutral execution-model contract has no packet of its own.** It is
`tuvren.shared.core` authority (`spec/core/authority-packet.json`,
`runner` binding section, ADR-037). The old `boundaries/framework/contracts/driver-api/`
READMEs claimed a standalone `tuvren.framework.driver-api` packet existed;
that claim was stale and is not carried over here — do not reintroduce it.

Conformance plans live at `spec/conformance/runners/plans/` (four plans:
`runner-api-core`, `runner-api-extended`, `react-runner-callables`,
`react-runner-extended`) with the shared scenario fixture at
`spec/conformance/runners/scenarios/runner-api-scenarios.json`.

The driver→runner identity rename (packetId, planId, checkId, capability,
and filenames in this port) landed at 87-M6.4b. The names above are
canonical; the provenance and stale-packet notes elsewhere in this README
are kept only as historical record of the pre-rename state.

The ReAct execution-model implementation lives at
`typescript/runners/react` (`@tuvren/runner-react`, migrated as a runner
at 87-M6.2).

This is a pointer, not an oracle: cross-language semantic truth lives in
the referenced authority packets, generated artifacts, and conformance
plans — never in this file.
