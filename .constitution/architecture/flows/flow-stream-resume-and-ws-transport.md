### 4.21 Stream Resume and WebSocket Carriage

- **Maps to PRD capability:** CAP-P0-019, CAP-P0-020, CAP-P1-021

```mermaid
sequenceDiagram
  participant Peer as Remote Session Peer
  participant Transport as WS Transport (carriage only)
  participant Binding as Session Binding (Host Integration Boundary)
  participant Stream as Event Stream Adapter Layer
  participant Kernel as Kernel Boundary

  Note over Stream,Kernel: Sequencing is wire-level; the canonical stream and kernel are unchanged
  Kernel-->>Stream: durable checkpoint anchor (turnNodeHash, observability-gated)
  Stream->>Stream: sequence each event per turn, mint opaque cursor {turnId, turnNodeHash?, sequence}
  Stream->>Stream: record sequenced frame into bounded host-owned replay window

  Note over Peer,Transport: First connection
  Peer->>Transport: {kind: "handshake", protocolVersion: "1", authToken?}
  Transport->>Transport: validate carriage only (4000/4001/4002/4003 close vocabulary)
  Transport-->>Peer: {kind: "handshake_ack", sessionId, resumeStatus: "none"}
  Binding-->>Transport: outbound session frame {kind: "event", event}
  Transport-->>Peer: {kind: "frame", cursor, frame} — cursor rides only event frames
  Binding-->>Transport: outbound session frame {kind: "client_invocation", invocation}
  Transport-->>Peer: {kind: "frame", frame} — no cursor: not a replayable surface

  Note over Peer,Transport: Disconnect mid-turn (laptop sleep, tab reload)
  Peer->>Transport: {kind: "handshake", protocolVersion: "1", cursor: last observed}
  alt replay window retains the cursor position
    Transport-->>Peer: {kind: "handshake_ack", resumeStatus: "resumed"}
    Transport-->>Peer: replayed {kind: "frame", cursor, frame} strictly before any live frame
  else position evicted, anchor lineage unretained, or turn unknown
    Transport-->>Peer: {kind: "handshake_ack", resumeStatus: "out-of-window" | "unknown-turn"}
    Note over Peer,Kernel: Snapshot fallback — durable kernel state is truth; the stream layer never reconstructs evicted events
  end

  Note over Peer,Transport: Connection-level policy stays out of the frame vocabulary
  Transport->>Peer: {kind: "ping"} on the heartbeat interval
  Peer->>Transport: any inbound message counts as liveness; silent window closes 4004
  Transport->>Transport: outbound budget check against the sink's buffered-amount report
  Note over Transport: overflow closes 4005 rather than dropping — a drop would create a sequence gap the cursor cannot explain
  Peer->>Transport: post-handshake message with unrecognized kind
  Transport->>Binding: dispatchInbound(message) — surfaces as session_rejection, the socket never closes for frame-level problems
```
