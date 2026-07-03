# TypeScript binding appendix for `tuvren.framework.event-stream-sse`

This appendix records how the TypeScript stream-sse package realizes the
`tuvren.framework.event-stream-sse` authority packet. The packet itself is the
cross-implementation authority; this document describes implementation-specific
projection details that future TypeScript maintainers need but that are not
part of the cross-language contract.

## Binding root

- Package: `@tuvren/stream-sse`
- Implementation root: `boundaries/framework/implementations/typescript/stream-sse`
- Bundler: `tsup` per the existing package convention

## Projection rules

- The generated `DecodedSseEvent` JSON Schema under `artifacts/json-schema/` is
  the canonical shape. The TypeScript package re-exports the equivalent type
  via its own `index.ts`; the re-export must remain structurally compatible
  with the generated schema.
- Byte traces in `spec/conformance/streaming/fixtures/event-stream-sse-traces.json`
  use native JSON string escapes for non-printable characters (`\r`, `\n`,
  `﻿`). The TypeScript SSE decoder consumes these traces as UTF-8 bytes
  without additional processing.
- The TypeScript implementation uses `ReadableStream<Uint8Array>` for incoming
  byte traces and emits `DecodedSseEvent` objects. The `ReadableStream` choice
  is implementation-specific and not part of the cross-language contract; a
  Rust implementation may use any equivalent byte-source abstraction.

## Conformance adapter status

The shared certification harness dispatches `event-stream-sse.decode-trace` and
`event-stream-sse.report-wire-compliance` operations against any adapter that
declares the `framework.event-stream-sse` capability. The TypeScript framework
adapter at `typescript/conformance-adapter/`
declares that capability and routes both operations through
`framework-adapter-event-stream-sse.ts`, which delegates to `decodeSseStream`
and `reportSseWireCompliance` from `@tuvren/stream-sse`. Every check in
`event-stream-sse.json` therefore runs as applicable evidence on the
TypeScript framework lane and contributes to the checked-in compatibility
matrix.
