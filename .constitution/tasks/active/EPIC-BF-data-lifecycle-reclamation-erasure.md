### Epic BF — Data Lifecycle: Reclamation + Crypto-Shredding Erasure (KRT)

**Status:** Active. Second epic of the SaaS-Readiness block. Realizes ADR-051 (kernel reachability reclamation primitive + crypto-shredding erasure of host-key-encrypted untrusted-edge payloads) for PRD CAP-P0-066/067. Depends on Epic BE (reclamation and erasure are per-scope). Sized to the ~3k–8k LoC epic heuristic; the kernel primitive plus the multi-edge envelope make this the largest SaaS-readiness epic.

**KRT-BF001 Authority Alignment for the Reclamation Primitive**
- **Type:** Chore
- **Effort:** 5
- **Dependencies:** KRT-BE001
- **Capability / Contract Mapping:** PRD `CAP-P0-066`; TechSpec ADR-051; `docs/KrakenKernelSpecification.md` §9.4, §9.1
- **Description:** Align machine authority for the kernel §9.4 `maintenance.reclamation` capability: add the `maintenance.reclamation` `BackendCapability` bit and the maintenance operation to the kernel-protocol authority packet (and the gRPC interop projection if the operation crosses the process boundary), update the kernel operation-count and capability-descriptor artifacts, classify §9.4 and the framework data-lifecycle notes in the coverage matrix, and register a reclamation conformance plan stub.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given docs/KrakenKernelSpecification.md v0.12 adds the §9.4 maintenance.reclamation capability
When the kernel-protocol authority and freeze gate run
Then the new capability and operation are declared in the authority packet and classified in the coverage matrix
And the syscall-count and capability-descriptor artifacts reflect the new capability-gated primitive
```

**KRT-BF002 Spike: Crypto-Shredding Envelope + Host-Key Custody**
- **Type:** Spike
- **Effort:** 3
- **Dependencies:** KRT-BF001
- **Capability / Contract Mapping:** PRD `CAP-P0-067`; TechSpec ADR-051
- **Description:** Design the host-key-encrypted untrusted-edge payload envelope: the key-reference shape, the encrypt-on-write/decrypt-on-read seam at the provider, tool, MCP, and client edges, the typed erased-read result, and confirmation that key custody stays host-owned. Output `.constitution/spikes/SPK-BF002.md`. No production code.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given sensitive untrusted-edge payloads must be erasable without rewriting lineage
When the spike completes
Then SPK-BF002.md records the envelope shape, the edge seam, and the erased-read result
And it confirms encryption keys remain host-held and out of the runtime
And it names the implementation ticket it unlocks (KRT-BF005)
```

**KRT-BF003 Kernel Reachability Reclamation Primitive (Memory)**
- **Type:** Feature
- **Effort:** 8
- **Dependencies:** KRT-BF001, KRT-BE006
- **Capability / Contract Mapping:** PRD `CAP-P0-066`; TechSpec ADR-051; `docs/KrakenKernelSpecification.md` §9.4
- **Description:** Implement the reachability mark-and-sweep reclamation primitive in the kernel over the memory backend: mark from live roots (non-archived branch heads, thread roots, active-run staged work) within the scope, sweep only the unreachable remainder, grace-windowed against active execution leases; capability-gated.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a scope with reachable lineage and orphaned objects past the grace window
When reclamation runs
Then unreachable objects are released
And no object reachable from a live root is released
And no object newer than the oldest active execution lease is released
```

**KRT-BF004 Reclamation on SQLite + PostgreSQL; Capability Advertisement**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BF003
- **Capability / Contract Mapping:** PRD `CAP-P0-066`; TechSpec ADR-051; `docs/KrakenKernelSpecification.md` §9.1, §9.4
- **Description:** Implement reclamation on the SQLite and PostgreSQL backends and advertise `maintenance.reclamation` through `BackendCapability`; a backend that cannot reclaim advertises non-support and rejects reclamation with `kernel_capability_unsupported`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given SQLite and PostgreSQL backends advertising maintenance.reclamation
When reclamation runs after branch archival
Then unreferenced objects and archived branches are reclaimed within the scope
And a backend advertising non-support rejects reclamation with kernel_capability_unsupported
```

**KRT-BF005 Host-Key-Encrypted Untrusted-Edge Payload Envelope**
- **Type:** Security
- **Effort:** 8
- **Dependencies:** KRT-BF002
- **Capability / Contract Mapping:** PRD `CAP-P0-067`; TechSpec ADR-051; Architecture Secret Isolation / Data Lifecycle models
- **Description:** Implement the crypto-shredding envelope at the provider, tool, MCP, and client edges per SPK-BF002: encrypt sensitive payloads under a host-held key before `store.put`, decrypt on read, and surface a typed erased/unavailable result when the key is destroyed. Keys are never managed by the runtime; the kernel stores only opaque ciphertext blobs.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a sensitive tool or provider result stored under a host-held key
When the host destroys that key
Then the payload is unrecoverable
And the lineage hash structure referencing it is unchanged
And reading the erased payload yields a typed erased result rather than a crash
```

**KRT-BF006 Framework Maintenance Surface + Tenant-Offboarding Flow**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BF004, KRT-BF005
- **Capability / Contract Mapping:** PRD `CAP-P0-066`, `CAP-P0-067`; Architecture flow §4.17
- **Description:** Expose the host-facing maintenance surface that drives reclamation per scope and the tenant-offboarding flow (destroy the scope's keys plus reclaim, then drop the scope partition) per Architecture §4.17. Retention policy remains host-supplied; the runtime owns only the mechanism.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a host requests offboarding for scope A
When it destroys scope A's keys and invokes reclamation for scope A
Then scope A's sensitive payloads are unrecoverable and its unreferenced state is reclaimed
And no other scope is affected
```

**KRT-BF007 Data-Lifecycle Conformance**
- **Type:** Security
- **Effort:** 5
- **Dependencies:** KRT-BF006
- **Capability / Contract Mapping:** PRD `CAP-P0-066`, `CAP-P0-067`; TechSpec ADR-051
- **Description:** Add conformance proving reclamation never releases reachable state and never races an active lease, and that erasure preserves lineage structure while rendering payloads unrecoverable, evaluated per backend capability.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the data-lifecycle conformance plan
When it runs against the reclamation-capable backends
Then it proves no reachable state is released and the grace window holds under an active lease
And it proves an erased payload is unrecoverable while the referencing lineage remains structurally intact
```
