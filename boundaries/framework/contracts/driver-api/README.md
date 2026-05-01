# Driver API Contract Root

This contract root owns the boundary authority packet for `driver-api` plus
implementation subtrees.

The cross-implementation authority is `spec/authority-packet.json`, backed by
neutral TypeSpec sources under `spec/typespec/`, generated JSON Schema
artifacts under `artifacts/json-schema/`, and conformance plans under
`boundaries/framework/conformance/plans/`.

The TypeScript package implementation for `@tuvren/driver-api` lives under
`implementations/typescript/` and is a binding projection of the packet.
