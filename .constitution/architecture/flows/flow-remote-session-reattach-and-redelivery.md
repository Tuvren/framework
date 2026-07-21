### 4.22 Remote Session Reattach, Invocation Redelivery, and Result Sanitization

- **Maps to PRD capability:** CAP-P0-019, CAP-P0-061, CAP-P1-063, CAP-P0-055

```mermaid
sequenceDiagram
  participant Peer as Remote Session Peer
  participant Carriage as Carriage Binding (WS)
  participant Session as Session Lifecycle Seam
  participant Binding as Session Binding
  participant Endpoint as Client Endpoint Boundary
  participant Gateway as Tool Execution Gateway
  participant Kernel as Kernel Boundary

  Note over Session,Binding: One claim, one sequencer, one replay window — for the session's whole life
  Session->>Binding: claim the single outbound stream (exactly once, ever)
  Session->>Session: wrap in ONE sequencer; record every sequenced frame into ONE replay window

  Note over Peer,Carriage: Healthy dispatch
  Binding-->>Session: {kind: "client_invocation", invocation{callId, leaseToken, idempotencyKey}}
  Session->>Session: mark callId unanswered
  Session->>Carriage: forward (unsequenced — not a replayable surface)
  Carriage-->>Peer: client_invocation
  Peer-->>Carriage: {kind: "client_result", result{callId, leaseToken}}
  Carriage->>Binding: dispatchInbound(result)
  Binding->>Endpoint: resolve pending dispatch by callId
  Session->>Session: clear callId from unanswered set

  Note over Peer,Carriage: Link drops with an invocation still outstanding
  Carriage--xPeer: connection lost
  Carriage->>Session: detach(reason)
  Session->>Session: start disconnect grace window — pending dispatches are NOT failed yet

  alt reattach inside the grace window
    Peer->>Carriage: handshake{sessionId, cursor: last observed}
    Carriage->>Session: attach(sink) — at most one live sink; a second concurrent attach is a programming error
    Session->>Session: cancel grace timer
    Session-->>Peer: replay sequenced event frames from cursor (numbering never restarted — one sequencer)
    Session-->>Peer: REDELIVER unanswered client_invocation frames (original callId + leaseToken)
    Note over Peer: idempotencyKey suppresses the duplicate SIDE EFFECT; the framework guarantees at-least-once presentation only
    Session-->>Peer: resume live forwarding
    Note over Session: session_rejection frames are NOT redelivered — advisory replies the peer can re-request
  else grace window expires with no reattach
    Session->>Endpoint: settle pending dispatches with capability_binding_unavailable
    Session->>Endpoint: detach endpoint — later invocations are refused, not dispatched into a dead link
  end

  Note over Peer,Session: Connected but unresponsive is a DIFFERENT failure from a dropped link
  Session->>Session: dispatchTimeoutMs elapses with the link healthy
  Session->>Endpoint: settle with capability_dispatch_timeout ({code, error}, not a code-less throw)

  Note over Endpoint,Kernel: Whatever the outcome, durability is the last gate
  Endpoint->>Gateway: client-reported result (a proposal, not yet durable)
  Gateway->>Gateway: apply host sanitizeToolResult(result, ctx{callId, executionClass, toolName})
  Note over Gateway: framework guarantees the seam and its ORDERING only — never content inspection
  Gateway->>Kernel: stage the SCRUBBED result under valid execution authority
  Gateway-->>Session: emit canonical tool.result — also the scrubbed form
  Note over Kernel: content-addressed and immutable — the unscrubbed value never left the runtime
```
