### ADR-004 The Framework Public Surface Remains Library-First and Driver-Neutral

- **Status:** accepted
- **Context:** Tuvren Runtime is a framework product for developers to embed, while Kraken remains the engine identity behind it. The architecture’s host boundary is an embedding surface.
- **Decision:** The primary TypeScript framework surface remains a library API centered on `TuvrenRuntime`, `ExecutionHandle`, typed events, driver selection, provider ports, and backend ports.
- **Consequences:** HTTP, WebSocket, CLI, editor, and protocol adapters are secondary packages layered over the library API. This does not weaken the protocol-first kernel boundary because the library surface sits above it, and it prevents the first driver from becoming the only host-facing abstraction.

