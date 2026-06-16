### 4.17 Tenant Offboarding and Right-to-Erasure (Crypto-Shredding + Reclamation)

- **Maps to PRD capability:** CAP-P0-066 (reachability-based reclamation mechanism), CAP-P0-067 (crypto-shredding erasure of sensitive untrusted-edge payloads), in service of CAP-P0-064/CAP-P0-065 (scope + isolation-by-construction)

This flow shows how a host satisfies retention limits or a right-to-erasure / tenant-offboarding obligation without rewriting immutable committed lineage. Erasure is performed by destroying host-held keys (crypto-shredding); reclamation releases only durable state unreachable from live lineage. Both operate within the Scope the host bound at construction, so offboarding a tenant is dropping its Scope plus destroying its keys.

```mermaid
sequenceDiagram
participant Host as Host (owns tenancy + retention policy)
participant Keys as Host Key Store (host-owned)
participant Framework as Framework Shared Services
participant Kernel as Kernel Boundary
participant State as Durable State Boundary (scoped)

Note over Host: Retention policy or erasure request targets one Scope (a tenant)
Host->>Keys: destroy the Scope's payload-encryption key(s)
Note over Keys: sensitive untrusted-edge payloads (provider/client/MCP/tool results, carried continuity artifacts) become unrecoverable ciphertext — lineage hash structure unchanged
Host->>Framework: request reclamation for the Scope (mechanism call; host supplied the retention decision)
Framework->>Kernel: invoke reachability reclamation for the Scope
Kernel->>State: mark state reachable from live roots (non-archived branch heads, thread roots, active-run staged work)
Note over Kernel,State: grace-windowed — never sweeps state a live execution lease may still reference
Kernel->>State: sweep only unreachable durable state within the Scope
State-->>Kernel: reclaimed; reachable lineage and audit shape preserved
Kernel-->>Framework: reclamation summary (released vs retained)
Framework-->>Host: durable state reduced; erased payloads unrecoverable; remaining history still verifiable
Note over Host,State: full offboarding = destroy keys + drop the Scope partition; isolation-by-construction makes this per-Scope
```
