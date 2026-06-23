### Epic BG — Backend-Authoritative Lease Clock + Side-Effect-Once (KRT)

**Status:** Active. Third epic of the SaaS-Readiness block. Realizes ADR-050 (backend-authoritative lease clock for shared multi-worker backends) and ADR-052 (side-effect-once under preemption via an idempotency envelope) for PRD CAP-P0-068. Depends on Epic BE for the scoped multi-worker backend and shared test harness. Refines the already-sound lease/fencing model rather than rebuilding it.

**KRT-BG001 Authority Alignment for Backend-Clock + Side-Effect-Once**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-BE001
- **Capability / Contract Mapping:** PRD `CAP-P0-068`; TechSpec ADR-050, ADR-052; `docs/KrakenKernelSpecification.md` §5.2; `docs/KrakenFrameworkSpecification.md` "Running Lease Ownership"
- **Description:** Classify the new kernel §5.2 backend-authoritative lease-clock note and the framework "Running Lease Ownership" side-effect-once / client-result-as-proposal notes in the docs-to-authority coverage matrix, and register the run-liveness authority-packet plus conformance-plan entries for the backend-clock and side-effect-once surfaces.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given kernel §5.2 and framework "Running Lease Ownership" add backend-clock and side-effect-once semantics
When the freeze gate runs
Then both spec additions are classified in the coverage matrix
And the run-liveness authority packet references the new conformance entries
```

**KRT-BG002 PostgreSQL Backend-Time Lease Clock + Capability Bit**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BG001
- **Capability / Contract Mapping:** PRD `CAP-P0-068`; TechSpec ADR-050; `docs/KrakenKernelSpecification.md` §5.2, §9.1
- **Description:** Make `@tuvren/backend-postgres` stamp `lease_expires_at` and evaluate expiry using server time within the lease transaction; add a `BackendCapability` shared-lease-clock bit. Memory and single-file SQLite advertise non-support and keep the in-process clock. The renewal margin is measured in backend time on both sides.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a PostgreSQL-backed multi-worker deployment
When a lease is stamped and later checked for expiry
Then both use the database server clock, not a worker wall clock
And the BackendCapability advertises shared-lease-clock support
And single-writer embedded backends advertise non-support and use the in-process clock
```

**KRT-BG003 Idempotency Envelope on Server + Client Dispatch**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BG001
- **Capability / Contract Mapping:** PRD `CAP-P0-068`; TechSpec ADR-052
- **Description:** Add the idempotency identity derived from `(runId, callId, fencingToken)` to the Tuvren-server tool dispatch path and the Client Endpoint Boundary dispatch envelope so an external system or client environment can deduplicate a retried effect. Reuse the existing `idempotent` / `nonRetryable` / `maxRetries` metadata; no new tool-definition fields.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a side-effecting invocation dispatched under a run lease
When the dispatch envelope is constructed
Then it carries an idempotency identity derived from runId, callId, and fencingToken
And the same logical call re-dispatched after recovery presents the same identity
```

**KRT-BG004 No-Retry-on-Authority-Loss + Client-Result-as-Proposal**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BG002, KRT-BG003
- **Capability / Contract Mapping:** PRD `CAP-P0-068`; TechSpec ADR-052; `docs/KrakenFrameworkSpecification.md` "Running Lease Ownership"
- **Description:** On loss of execution authority, do not retry an in-flight `nonRetryable` invocation; treat a client-reported result as a proposal that commits only under a valid run fencing token, so a stale or late client report cannot mutate committed history.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a worker loses its run lease while a nonRetryable invocation is in flight
When recovery proceeds
Then the in-flight nonRetryable invocation is not retried under the dead owner
And a client-reported result arriving under a stale fencing token is rejected and does not mutate committed history
```

**KRT-BG005 Preemption-Under-Clock-Skew Conformance**
- **Type:** Security
- **Effort:** 5
- **Dependencies:** KRT-BG004
- **Capability / Contract Mapping:** PRD `CAP-P0-068`; TechSpec ADR-050, ADR-052; Architecture flow §4.18
- **Description:** Add conformance simulating worker clock skew plus preemption against PostgreSQL, proving no duplicated non-idempotent side effect and no stale-client commit, per Architecture §4.18.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given two workers and a PostgreSQL backend with simulated clock skew
When one worker is preempted while a non-idempotent call is in flight
Then the side effect occurs at most once via the idempotency identity
And no stale client report is committed
And per-run evidence is recorded
```
