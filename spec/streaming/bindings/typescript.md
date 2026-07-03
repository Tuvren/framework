# TypeScript Binding Appendix

`@tuvren/event-stream` is the TypeScript binding projection for
`tuvren.framework.event-stream`. `AsyncIterable<TuvrenStreamEvent>` and
TypeScript union ergonomics are binding conveniences only.

Portable packet artifacts project `Uint8Array` event payloads as `uint8[]`
JSON arrays while preserving the same event field semantics as the TypeScript
binding.
