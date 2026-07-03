# Host port — authority

The host port is physically consolidated here at 87-M9.1, lifted from
`boundaries/framework/contracts/runtime-api/` (the `runtime-api` contract
root) plus one loose sibling file, `client-endpoint-integration.md`, that
lived directly under `boundaries/framework/contracts/`.

This is the **host port — singular**, the neutral runtime-facing surface a
host developer programs against (`TuvrenRuntime`, execution operations,
messages, approval, orchestration handles, and the client-endpoint
attachment contract). It is not the same tree as `typescript/host/`
(the arrived home of the formerly-plural `boundaries/hosts/`) — that
directory holds concrete first-party host *implementations* (the
reference REPL shell today); this port holds the neutral contract those
implementations bind against.

- `typespec/` — the reviewed TypeSpec source (`main.tsp`, namespace
  `Tuvren.Framework.RuntimeApi`) for the neutral runtime-operation and
  message/payload surface.
- `bindings/` — the TypeScript binding appendix (`typescript.md`) covering
  binding-only surfaces (`ExecutionHandle`, `OrchestrationHandle`) that are
  not emitted as JSON Schema artifacts.
- `artifacts/json-schema/` — the reviewed JSON Schema outputs generated
  from the TypeSpec source (regenerated via `host-spec:codegen`, 39
  schemas).
- `client-endpoint-integration.md` — the `AttachedClientEndpoint`
  host-integration contract: what a host developer implements to attach a
  conforming client endpoint (browser extension, desktop app, device
  agent, client-side MCP runner) to a runtime instance. It imports symbols
  from `@tuvren/core/capabilities`, so its capability-orchestration
  vocabulary (execution classes, exposure/invocation policy, observation
  limits) is documented and owned at `spec/tools/` — this file is the
  host-attachment half of that contract, not a second copy of it.

**The runtime-api vocabulary has no standalone authority packet.** It was
absorbed into `tuvren.shared.core` per ADR-037 (Epic AP): the `messages`,
`events`, `execution`, `tools`, `provider`, and `extensions` binding
sections of `spec/core/authority-packet.json` cover this surface, with
`spec/host/typespec/main.tsp` cited as one of that packet's
authoritative sources. The old `boundaries/framework/contracts/runtime-api/spec/README.md`
claimed a standalone `authority-packet.json` declaring
`tuvren.framework.runtime-api` existed in this tree — that claim was
stale-false (no such file was ever present after the ADR-037
consolidation) and is not carried forward here.

Conformance plans for this surface live at `spec/conformance/engine/`
(the `runtime-api-{lifecycle,lifecycle-extended,callables,
callables-extended,orchestration,batteries-included}.json` plan family,
packet-owned by `tuvren.shared.core`) — this port only points at them, it
does not restate or duplicate them.

**87-M9.2 correction:** the TypeScript package implementation,
`@tuvren/runtime-api` at `boundaries/framework/contracts/runtime-api/implementations/typescript/`,
was **retired**, not moved to `typescript/host/...` as this milestone's
earlier note anticipated. Measurement at M9.2 found the package was a pure
re-export barrel over `@tuvren/core/{execution,events,messages,provider,
tools}` with zero original definitions — the same shape as the retired
`@tuvren/driver-api` (87-M6.1c) and `@tuvren/event-stream` (87-M8.1c)
shims — so the M6.1c/M8.1c retirement pattern applies instead of a
physical move: its 7 live type-position consumer imports were rewired to
the matching `@tuvren/core/*` subpaths, its unique behavioral test
coverage (guard functions with no other dedicated coverage) was ported to
`typescript/core/test/runtime-contract-guards*.test.ts`, and the package
tree plus this contract root were removed. See
`MIGRATION_INVENTORY.md`'s M9.2 addendum for the full accounting.

The reference host shell, `@tuvren/repl-host`, now lives at
`typescript/host/repl/` (moved at 87-M9.3; Nx project name `host-repl`
and npm name `@tuvren/repl-host` unchanged).

This is a pointer, not an oracle: cross-language semantic truth lives in
the referenced authority packet, generated artifacts, and conformance
plans — never in this file.
