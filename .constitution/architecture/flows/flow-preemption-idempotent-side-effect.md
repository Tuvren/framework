### 4.18 Stale-Execution Preemption Without a Duplicated Side Effect

- **Maps to PRD capability:** CAP-P0-068 (side-effect-once under preemption), supported by the Backend-Authoritative Lease Clock Model and the Side-Effect-Once Under Preemption Model

This flow shows the one failure a single-process runtime never had to consider: in a shared-backend, multi-worker deployment, a paused worker is preempted while a non-idempotent external call is in flight. Durable writes are already protected by run-status and fencing checks; this flow shows how the backend-authoritative lease clock plus the idempotency envelope prevent the *external side effect* from happening twice.

```mermaid
sequenceDiagram
participant A as Worker A (run lease holder)
participant Ext as External Side-Effecting System
participant State as Durable State Boundary (shared; authoritative clock)
participant B as Worker B (recovering worker)

A->>State: hold run lease (owner, fencing token, expiry in backend time)
A->>Ext: dispatch non-idempotent call with idempotency identity (runId, callId, fencingToken)
Note over A: Worker A pauses (GC / partition) before the call returns
State-->>State: lease expires in backend time (not worker wall clock)
B->>State: observe expired lease (backend clock), preempt
State-->>B: mark A's run failed, install new fencing token, return recovery state
B->>State: create replacement run from recovered durable head
A-->>A: resumes; in-flight call to Ext returns
A->>State: attempt to commit result under old fencing token
State--xA: rejected — stale fencing token (durable write fenced)
Note over A: framework does NOT retry the in-flight non-idempotent call; handle aborts
B->>Ext: re-dispatch same logical call with same idempotency identity
Ext-->>B: deduplicated by idempotency identity — effect occurred once
B->>State: commit result under valid fencing token
Note over A,State: any late client-reported result from A is a proposal; under a stale token it can never mutate committed history
```
