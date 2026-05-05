# TypeScript Binding Appendix

`@tuvren/provider-api` is the TypeScript binding projection for
`tuvren.providers.provider-api`. The package intentionally re-exports the
focused `@tuvren/runtime-api/provider` type surface rather than re-declaring
its own prompt validators.

Portable packet artifacts therefore mirror the transport-oriented provider
binding payloads, including `Uint8Array` values projected as `uint8[]` JSON
arrays and optional string fields that remain type-valid even when the broader
runtime layer applies stricter durable-message predicates elsewhere.
