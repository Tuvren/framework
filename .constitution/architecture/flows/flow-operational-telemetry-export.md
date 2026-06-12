### 4.12 Operational Telemetry Capture and Vendor-Neutral Export

- **Maps to PRD capability:** CAP-P0-052, CAP-P1-053

```mermaid
sequenceDiagram
participant Framework as Framework Shared Services
participant Driver as Driver Runtime
participant Tooling as Tool Execution Gateway
participant Kernel as Kernel Boundary
participant Telemetry as Telemetry & Observability Boundary
participant Export as Vendor-Neutral Export Edge
participant Obs as External Observability Tooling

Framework->>Telemetry: turn/run/iteration telemetry (keyed to thread, branch, turn, run)
Driver->>Telemetry: model interaction telemetry
Tooling->>Telemetry: tool call + approval telemetry
Kernel->>Telemetry: checkpoint + recovery telemetry
Telemetry->>Telemetry: correlate records by runtime lineage; apply redaction (no secrets)
Telemetry->>Export: emit canonical telemetry vocabulary
Export->>Obs: project into vendor-neutral telemetry without coupling to any one vendor
Note over Telemetry,Obs: telemetry vocabulary is portable authority; export format is an ecosystem projection
```

