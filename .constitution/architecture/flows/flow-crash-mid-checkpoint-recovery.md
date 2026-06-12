### 4.11 Crash Mid-Checkpoint and Clean Recovery (Fault-Injection-Verified)

- **Maps to PRD capability:** CAP-P0-005, CAP-P0-006 (and the sharpened Reliability NFR: resume-or-fail-clean under fault injection)

```mermaid
sequenceDiagram
participant Verify as Recovery Verification Harness
participant Framework as Framework Shared Services
participant Kernel as Kernel Boundary
participant Fault as Fault-Injection Seam
participant State as Durable State Boundary
participant NewProc as Recovered Runtime Instance

Framework->>Kernel: checkpoint iteration (stage results + manifest + status)
Kernel->>Fault: begin atomic checkpoint commit
Verify->>Fault: inject crash mid-commit
Fault--xState: commit interrupted before durable completion
Note over Fault,State: atomic commit either fully lands or does not land; no torn TurnNode
NewProc->>Kernel: restart and open the same branch
Kernel->>State: read last durable committed TurnNode + recoverable staged work
State-->>Kernel: committed head + any recoverable staged results
Kernel-->>NewProc: distinguish committed progress from incomplete work
NewProc->>Framework: resume only unfinished work, or fail the run cleanly
Framework-->>Verify: recovered head is consistent; no partial or corrupt lineage
Note over Verify,NewProc: conformance asserts resume-or-fail-clean across every supported backend capability
```

