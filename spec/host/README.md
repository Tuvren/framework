# Host port — authority

The host port is physically consolidated here at 87-M9.1, lifted from
`boundaries/framework/contracts/runtime-api/` (the `runtime-api` contract
root) plus one loose sibling file, `client-endpoint-integration.md`, that
lived directly under `boundaries/framework/contracts/`.

This is the **host port — singular**, the neutral runtime-facing surface a
host developer programs against (`TuvrenRuntime`, execution operations,
messages, approval, orchestration handles, and the client-endpoint
attachment contract). It is not the same tree as `boundaries/hosts/`
(plural) — that directory holds concrete first-party host *implementations*
(the reference REPL shell today); this port holds the neutral contract
those implementations bind against.

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

The TypeScript package implementation for `@tuvren/runtime-api` still
lives at `boundaries/framework/contracts/runtime-api/implementations/typescript/`
as of this milestone; it is a binding projection of the packet above, not
authority, and its physical move to `typescript/host/...` is 87-M9.2
scope, not this one.

The reference host shell, `@tuvren/repl-host`, still lives at
`boundaries/hosts/implementations/typescript/repl/` — it moves at 87-M9.3.

This is a pointer, not an oracle: cross-language semantic truth lives in
the referenced authority packet, generated artifacts, and conformance
plans — never in this file.
