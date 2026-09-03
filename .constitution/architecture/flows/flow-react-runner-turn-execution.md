---
job: JOB-01
capabilities: [CAP-001, CAP-002, CAP-004, CAP-006, CAP-007, CAP-008, CAP-012, CAP-019, CAP-020, CAP-030, CAP-033, CAP-069]
boundaries: [BND-01, BND-03, BND-05, BND-04, BND-06, BND-07, BND-17, BND-18, BND-19]
view: sequence
certainty: assumed
assumption: "Migrated from markdown; not yet exercised by an integration test."
---
### 4.1 ReAct Runner Turn Execution with Durable Checkpointing

- **Maps to PRD capability:** CAP-P0-001, CAP-P0-002, CAP-P0-004, CAP-P0-006, CAP-P0-007, CAP-P0-008, CAP-P0-012, CAP-P0-019, CAP-P0-020, CAP-P0-030, CAP-P0-033

```mermaid
sequenceDiagram
participant Host as Host Integration Boundary
participant Framework as Framework Shared Services
participant Context as Context Assembly and Engineering
participant Runner as Runner Runtime
participant Ext as Extension Runtime
participant Provider as Provider Gateway
participant Kernel as Kernel Boundary
participant State as Durable State Boundary
participant Events as Event Stream Adapter Layer

Host->>Framework: executeTurn(input signal, runner selection)
Framework->>Kernel: create Turn and input Run
Kernel->>State: atomically stage input message, manifest, runtime status
Kernel-->>Framework: committed TurnNode / updated head
Framework->>Events: emit turn.start and iteration.start
Framework->>Context: assemble active messages + manifest
Framework->>Runner: execute iteration with active context
Runner->>Ext: collect prompts / aroundModel wrappers
Runner->>Provider: stream canonical prompt
Provider-->>Runner: normalized response stream + final response
Runner-->>Framework: assistant message, tool intents, loop decision, state updates
Framework->>Kernel: stage message + manifest and checkpoint iteration
Kernel->>State: atomically commit staged results into new TurnNode / TurnTree
Kernel-->>Framework: new head committed
Framework->>Events: emit canonical lifecycle and state events
Framework-->>Host: continue iteration or end turn with durable history preserved; awaitResult resolves on terminal phase
```

