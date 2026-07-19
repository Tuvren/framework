# TypeScript binding appendix for `tuvren.framework.host-session`

This appendix records how the TypeScript `@tuvren/host-session` package
realizes the `tuvren.framework.host-session` authority packet
(`spec/host/session/typespec/main.tsp`, issue #99). The packet itself is the
cross-implementation authority for the duplex session frame vocabulary; this
document describes implementation-specific projection details that future
TypeScript maintainers need but that are not part of the cross-language
contract.

## Binding root

- Package: `@tuvren/host-session`
- Implementation root: `typescript/host/session`
- Bundler: `tsup` per the existing package convention (see
  `typescript/streaming/sse` and `typescript/host/repl` for the sibling
  project layout this package mirrors)
- Release posture: every export is tagged `@experimental` per ADR-056 — the
  whole package is still settling, and signatures may change without a major
  version bump until an export graduates by losing its tag

## Frame envelope projection

`spec/host/session/typespec/main.tsp` is the settled wire vocabulary for
`SessionOutboundFrame` (`event` | `client_invocation` | `session_rejection`)
and `SessionInboundFrame` (`client_result` | `approval_response` | `steer` |
`cancel`). `typescript/host/session/src/lib/session-frame-shapes.ts`
hand-authors the matching TypeScript projection — this package follows this
repository's convention of hand-authoring binding types rather than
generating TypeScript from the JSON Schema artifacts under
`spec/host/session/artifacts/json-schema/`.

The frame envelope types deliberately do not redeclare payload types already
owned elsewhere:

- `TuvrenStreamEvent` (`SessionEventFrame.event`) comes from
  `@tuvren/core/events`.
- `ApprovalResponse` (`SessionApprovalResponseFrame.response`) comes from
  `@tuvren/core/tools`.
- `InputSignal` (`SessionSteerFrame.signal`) comes from
  `@tuvren/core/execution`.
- `ClientInvocationEnvelope`, `ClientReportedResult`,
  `AttachedClientEndpoint`, and `ClientEndpointCapabilityAdvertisement` come
  from `@tuvren/core/capabilities` (ADR-046/ADR-047).

Only the frame envelopes themselves — transport-only wrappers around those
shared payloads — are declared in this package.

## `DuplexSessionBinding` binding

`createDuplexSessionBinding(handle, options?)` in
`typescript/host/session/src/lib/duplex-session-binding.ts` is the binding
surface hosts compose against. It is not part of the TypeSpec packet (which
only defines wire shapes); it is a TypeScript-only ergonomics layer, the same
way `ExecutionHandle` method signatures are binding-only per
`spec/host/bindings/typescript.md`.

- `outbound(): AsyncIterable<SessionOutboundFrame>` mirrors
  `ExecutionHandle.events()` single-consumer semantics: it throws if called a
  second time on the same binding.
- `dispatchInbound(frame: unknown): void` is fire-and-forget. Every
  structural or state rejection surfaces as a `session_rejection` frame on
  `outbound()` instead of throwing, echoing the offending frame's
  `correlationId` (or `"unknown"` when the frame did not carry a usable one).
  Two narrow exceptions: an unexpected non-`TuvrenRuntimeError` failure from
  the underlying handle propagates to the caller rather than being masked as
  a rejection, and a frame arriving after the outbound stream has reached a
  terminal state has no remaining consumer, so its rejection frame is
  unobservable. Once the stream is terminal the binding also settles every
  still-pending client dispatch by rejecting it (`duplex_session_closed`) —
  a session that can no longer deliver a `client_result` must not leave the
  runtime awaiting one. Connection-lifecycle policy beyond that (timeouts,
  disconnect detach) is issue #102's scope.
- `clientEndpoint: AttachedClientEndpoint` is what a host wires into
  `AgentConfig.clientEndpoints`.
- `currentHandle(): ExecutionHandle` exposes the execution handle currently
  backing the binding, for host/test observability only.

### Handle-replacement re-bridge duty

`ExecutionHandle.resolveApproval()` returns a **new** handle rather than
mutating the paused one (see `spec/host/bindings/typescript.md`
`ExecutionHandle` binding and
`typescript/runtime/src/lib/runtime-execution-handle.ts`). The binding owns
re-bridging that replacement into the same outbound queue so a host never has
to notice the handle swap on the wire:

1. The binding starts draining `handle.events()` immediately on construction.
2. When that handle's own `events()` stream ends, the binding inspects
   `handle.status().phase`. If the handle ended **not** paused (`completed`
   or `failed`), the outbound queue closes — the session is over.
3. If the handle ended **paused**, the outbound queue is left open: a
   replacement may still arrive. It does, once an inbound `approval_response`
   frame calls `currentHandle.resolveApproval(response)`. The binding swaps
   its tracked handle to the replacement, starts draining the replacement's
   `events()` into the *same* outbound queue, and leaves `sessionId`
   unchanged. Events emitted by the original handle and the replacement
   therefore interleave onto the wire without a gap, duplication, or
   reordering at the swap boundary.
4. `resolveApproval`, `steer`, and `cancel` are all wrapped in the same
   try/catch: a thrown `TuvrenRuntimeError` (for example
   `invalid_approval_resolution`, which can also surface from `cancel()`
   racing an already-applied approval) is translated into a
   `session_rejection` frame with `code: "session_frame_wrong_state"` and
   `details.runtimeErrorCode` set to the underlying runtime error code,
   rather than propagating out of `dispatchInbound`.

### Two staleness layers

The `capability_result_stale` rejection code is deliberately narrower than —
and independent from — the lease-token echo check the runtime's
`ClientEndpointBoundary` performs for every accepted dispatch:

- **Session-level (this package):** `dispatchInbound` for a `client_result`
  frame looks up a pending call by `result.callId` in an in-memory table
  populated by `clientEndpoint.dispatch()`. No matching entry (for example, a
  duplicate or very-late result after the session already resolved that
  call) produces a `capability_result_stale` rejection at the session
  boundary, before the result ever reaches the runtime.
- **Boundary-level (runtime-owned, not this package):** once a `callId`
  match is found, this binding resolves the pending promise with the
  `ClientReportedResult` **verbatim** — it does not itself validate
  `leaseToken`. The runtime's `ClientEndpointBoundary` is the sole owner of
  the lease-token echo check that determines whether a result actually
  enters durable lineage.

A host or test should not conflate the two: a session-level
`capability_result_stale` rejection means "this binding never dispatched (or
already settled) that `callId`"; a boundary-level lease mismatch means "the
runtime is discarding an otherwise-routable result as a stale
late-completion."

### Structural validation vs. schema validation

`dispatchInbound` performs a purely structural, TypeScript-level guard before
any routing: the raw value must be an object, `protocolVersion` must be
`"1"`, `sessionId` must match this binding's `sessionId`, `correlationId`
must be a non-empty string, `kind` must be one of the four inbound kinds, and
the kind-specific payload field must be present with correct primitive
shape (for example, `client_result` requires a `result` object carrying
non-empty `callId`/`leaseToken` strings and a `content` property; `steer`
requires a non-empty `signal.parts` array). This is deliberately cheap and
does not validate the full generated JSON Schema for these frames
(`spec/host/session/artifacts/json-schema/`) — full schema-level conformance
runs in the shared conformance lane, against the generated schema, not
inside this binding. A frame that fails this structural guard produces a
`session_frame_invalid` rejection and never reaches `steer`/`cancel`/
`resolveApproval`/the client-result pending-call table; the binding remains
fully functional for subsequent valid frames afterward.

## Conformance adapter status

As of this writing, no conformance-adapter operation exercises
`@tuvren/host-session` yet; this appendix will be updated once a shared
duplex-session conformance plan and adapter wiring land (tracked outside this
package's scope per the repository's `spec/host/session/typespec` and
`spec/host/session/artifacts` ownership split).
