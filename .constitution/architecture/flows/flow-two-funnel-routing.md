### 4.19 Two-Funnel Emission and Construction-Time Routing (Split Topology, Telemetry-Destination Failure)

- **Maps to PRD capability:** CAP-P0-071, CAP-P0-072 (contract), CAP-P1-073 (destination realizations, deferred)

One turn emits both funnels. The host chose a split topology at construction: the content funnel persists to the tenant-owned store while the telemetry funnel routes to a centralized telemetry destination. The flow shows the happy path and the load-bearing unhappy path — the telemetry destination failing mid-turn without the session noticing.

```mermaid
sequenceDiagram
participant Host as Host Integration Boundary
participant SDK as Curated Host-Facing SDK Surface
participant Framework as Framework Shared Services
participant Kernel as Kernel Boundary
participant Content as Durable State Boundary (content funnel, tenant-owned)
participant Telemetry as Telemetry & Observability Boundary (telemetry funnel)
participant Dest as Telemetry Destination (centralized, host-selected)

Note over SDK: Construction time: host supplies funnel routing —<br/>content → tenant store, telemetry → centralized destination<br/>(unified and mixed-substrate topologies are the same seam)
Host->>SDK: start turn
SDK->>Framework: execute turn
Framework->>Kernel: checkpoint syscalls (funnel-unaware, scope-free)
Kernel->>Content: commit lineage, messages, state (content funnel)
Content-->>Kernel: durable commit acknowledged
Framework->>Telemetry: canonical activity records (telemetry funnel)
Telemetry->>Dest: deliver correlated telemetry records
Note over Telemetry,Dest: unhappy path: destination unreachable mid-turn
Dest--xTelemetry: delivery failure
Telemetry->>Telemetry: degrade telemetry only — drop or bounded-buffer,<br/>surface an operational signal; never propagate to the session
Kernel->>Content: subsequent content commits proceed unaffected
Framework-->>Host: turn completes with identical session behavior
Note over Content,Dest: one-directional invariant: content never depends on Dest;<br/>no content payload reaches Dest absent an explicit routing decision
```

- **Failure isolation asserted by this flow:** the telemetry-destination outage changes telemetry completeness, never turn outcome, checkpoint atomicity, or recovery behavior. Conformance evaluates the same turn with the destination healthy and unavailable and asserts identical session results.
- **Topology equivalence:** rerunning this flow under the unified topology (both funnels to one store) or a mixed-substrate topology changes only the routing seam configuration at the SDK surface; every arrow below the SDK is identical, which is the architectural content of CAP-P0-072.
