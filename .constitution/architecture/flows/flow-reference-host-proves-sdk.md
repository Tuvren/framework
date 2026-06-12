### 4.7 Reference Host Proves the SDK End to End Without Private Seams

- **Maps to PRD capability:** CAP-P0-005, CAP-P0-010, CAP-P0-016, CAP-P0-019, CAP-P0-020, CAP-P0-023, CAP-P0-026, CAP-P0-027, CAP-P0-042, CAP-P0-043, CAP-P0-044, CAP-P0-045, CAP-P0-046, CAP-P0-047, CAP-P0-048, CAP-P0-049, CAP-P1-022, CAP-P1-024

```mermaid
sequenceDiagram
participant Operator as Reference Host Operator
participant Host as Reference Host
participant SDK as Curated Host-Facing SDK Surface
participant Framework as Framework Shared Services
participant Driver as Driver Runtime
participant Tooling as Tool Execution Gateway
participant Orch as Orchestration Runtime
participant Kernel as Kernel Boundary
participant State as Durable State Boundary
participant SSE as Event Stream Adapter Layer

Operator->>Host: start or resume thread, issue command, inspect status, request thread list, read messages
Host->>SDK: construct runtime via Batteries-Included Composition (one factory)
SDK->>Framework: assemble and start a runtime instance
Host->>Framework: executeTurn / awaitResult / steer / resolveApproval / cancel / listThreads / readBranchMessages via host-facing SDK
Framework->>Driver: run active turn over durable state
Driver->>Tooling: execute or pause tool batches
Driver->>Orch: spawn workers or hand off control when requested
Framework->>Kernel: checkpoint progress; perform structural enumeration and reads for durable-read queries
Kernel->>State: durably commit thread, branch, and turn state; serve enumeration within advertised capability
Framework->>SSE: publish canonical stream and SSE projection
SSE-->>Host: ordered host-consumable runtime events
Host-->>Operator: real-time control, inspection, durable reload, and durable-read responses without private runtime shortcuts
```

