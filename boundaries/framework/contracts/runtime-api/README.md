# Runtime API Contract Root

This contract root owns the boundary authority packet for `runtime-api` plus
implementation subtrees.

The cross-implementation authority is `spec/authority-packet.json`, backed by
neutral TypeSpec sources under `spec/typespec/`, generated JSON Schema
artifacts under `artifacts/json-schema/`, and conformance plans under
`boundaries/framework/conformance/plans/`.

The TypeScript package implementation for `@tuvren/runtime-api` lives under
`implementations/typescript/` and is a binding projection of the packet.
