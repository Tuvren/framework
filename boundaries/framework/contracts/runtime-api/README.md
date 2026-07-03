# Runtime API Contract Root (tombstone — 87-M9.1)

This tree's neutral authority content moved to `spec/host/` at 87-M9.1:
the TypeSpec source (`spec/typespec/` → `spec/host/typespec/`), the
TypeScript binding appendix (`spec/bindings/` → `spec/host/bindings/`),
and the generated JSON Schema artifacts (`artifacts/json-schema/` →
`spec/host/artifacts/json-schema/`). See `spec/host/README.md` for the
current authority disposition — this surface was never backed by a
standalone `authority-packet.json` (it was absorbed into
`tuvren.shared.core` per ADR-037); the claim in this root's prior README
that one existed here was stale and has been corrected at `spec/host/`.

The conformance plans that certify this surface's behavior moved earlier,
at 87-M3.4, to `spec/conformance/engine/` — independently of this
root's own authority disposition (see that directory's README for the
naming ruling).

The only content still live under this contract root is
`implementations/typescript/` (`@tuvren/runtime-api`), a binding
projection of the packet above. That package's physical move to
`typescript/host/...` is 87-M9.2 scope; this root is retired once that
milestone completes.
