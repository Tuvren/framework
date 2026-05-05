# TypeScript Binding Appendix

`@tuvren/core-types` is the TypeScript binding projection for
`tuvren.shared.core-types`. TypeScript classes, predicates, `unknown`, and
language-native `Error` inheritance are binding conveniences only.

Where the packet carries portable file/media payloads, TypeScript `Uint8Array`
values are projected as `uint8[]` JSON arrays in emitted artifacts.
