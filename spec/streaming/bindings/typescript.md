# TypeScript Binding Appendix

`@tuvren/core/events` (`typescript/core/src/events/`) is the TypeScript
binding projection for `tuvren.framework.event-stream`.
`AsyncIterable<TuvrenStreamEvent>` and TypeScript union ergonomics are
binding conveniences only. (The deprecated `@tuvren/event-stream` shim
that formerly re-exported this vocabulary was retired at 87-M8.1c.)

Portable packet artifacts project `Uint8Array` event payloads as `uint8[]`
JSON arrays while preserving the same event field semantics as the TypeScript
binding.
