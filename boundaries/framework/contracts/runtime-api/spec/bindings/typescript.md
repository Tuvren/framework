# TypeScript Binding Appendix

`@tuvren/runtime-api` and `@tuvren/runtime-core` are TypeScript binding
projections for `tuvren.framework.runtime-api`. TypeScript function signatures,
`Promise`, `AsyncIterable`, `AbortSignal`, `Uint8Array`, and language-native
errors are binding conveniences only.

Portable packet artifacts project TypeScript `Uint8Array` values as `uint8[]`
JSON arrays. Host-facing callable surfaces such as `ExecutionHandle` remain
binding-only and are not emitted as JSON Schema artifacts.
