# Providers port — authority

The provider port contract is authoritative here as of 87-M4.1 (lifted
from `boundaries/providers/contracts/provider-api/`, merging that
contract root's README and its spec README into this file):

- `typespec/` — the reviewed TypeSpec source (`main.tsp`), the
  machine-readable contract projection for this surface.
- `authority-packet.json` — the packet for `tuvren.providers.provider-api`.
- `bindings/` — language-binding appendices (TypeScript today).
- `artifacts/` — the reviewed JSON Schema and OpenAPI outputs generated
  from the TypeSpec source.

Certification assets live at `spec/conformance/providers/` (plans,
fixtures, scenarios, schemas — moved in the same commit).

The engine-facing seam vocabulary remains `@tuvren/core/provider`
(authority `spec/core`). The `@tuvren/provider-api` TypeScript binding
package still lives at
`boundaries/providers/contracts/provider-api/implementations/typescript`
until 87-M4.2 moves the provider implementation packages to
`typescript/providers/`.

MCP is deliberately **not** part of this port: it is re-categorized as a
tool bus-driver and migrates to `spec/tools/` at M5 (issue #87 §13).
