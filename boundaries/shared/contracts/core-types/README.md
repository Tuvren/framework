# Core Types Contract Root

This contract root owns the boundary authority packet for `core-types` plus
implementation subtrees.

The cross-implementation authority is `spec/authority-packet.json`, backed by
neutral TypeSpec sources under `spec/typespec/` and generated JSON Schema
artifacts under `artifacts/json-schema/`.

The TypeScript package implementation for `@tuvren/core-types` lives under
`implementations/typescript/` and is a binding projection of the packet.
