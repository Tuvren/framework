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
- **Carried-forward review follow-ups (from the BF003 + BF005 milestone reviews; non-blocking there, addressed here):**
  - Add reclamation coverage for a *structurally shared Object* — one Object referenced by both a swept (archived) node and a kept (live) node must be retained (proves the keep-closure set-union, not just exclusive-lineage release). Construct the divergent lineages with the fork pattern (`branch.create` + `parentTurnId` chaining from a shared non-root ancestor) so the two referencing nodes are distinct content-addressed hashes and the rollback rewind does not collide turn-parent chains at the root.
  - Add reclamation coverage for an Object *older than the grace horizon* that is referenced by a node *newer than the horizon* (exercises the grace-window reference closure across the horizon, not only reachability with an unbounded horizon).
  - Harden `validateCommittedState`: add an observe-annotation referential check so the sweep's safety for `observeAnnotations.turnNodeHash` is enforced by an invariant rather than argued from `sweepRuns` deleting annotations with their run. Pre-existing validator gap (the only reference class it does not check); currently safe by construction.
  - Add erasure coverage for the *encrypted context-engineering rewrite path* — the BF005 integration suite exercises the AES-GCM codec through `stageMessage` and the head-state/durable read seams, but the context-engineering flush/handoff `putKernelRecord` path (`runtime-core-transition-support.ts` → `runtime-core-context.ts`) is only exercised under the identity codec. Add one integration test that drives a real codec through a compaction/handoff rewrite and asserts the rewritten message lands in the store as a `TVE1` envelope, the resolved tree hash matches the canonical (post-store) hash via the provisional→canonical remap, and the head-state read decrypts it. Invariant is sound by inspection today (provisional plaintext hash is a transient map key; canonical ciphertext hash is what lands in the tree) but is argued rather than proven for that path.
- **M7 review triage (independent `/reviewing-milestone-commits` over `8c1e1eb`): APPROVE.** All four acceptance criteria and all four carried-forward follow-ups verified genuinely proven (not vacuously asserted), with no adapter-grading or kernel/codec-leak boundary violations and the two `memory-backend-state.ts` copies in sync. One actionable finding fixed in `bcf7282a`: the §9.4 freeze-gate flip over-promoted the §9.4 `false` *non-support* row (the `kernel_capability_unsupported` rejection) to `authority-backed-conformance-covered`, but the promoted plan's `kernel.reclamation` applicability only exercises capability-bearing backends, so that rejection is not portable-conformance-covered — it is now left to the canonical capability-gate classifier (§9 → KRT-AM010, ADR-034). Two non-blocking observations recorded, no action required: (a) the postgres `memory-backend-state.ts` copy carries the new observe-annotation invariant but no direct unit test, consistent with the pre-existing parity-tested pattern; (b) the read-side `resolveHandoffSourceContextFacade` `putKernelRecord` is unwrapped, but it is the materialized-view resolver — the flush/store seam encrypts, so encrypted rewrites are not bypassed (pre-existing M5/M6 wiring, out of BF007 scope).
