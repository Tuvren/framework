---
id: ADR-0079
status: accepted
date: 2026-10-22
certainty: assumed
assumption: "Synthesized from two independent designs plus an adversarial review of the mutation model; settles by ruling when the owner approves this pass."
---
### ADR-0079 Negative Controls Gate Conformance Certification

- **Status:** accepted.
- **Context:** No conformance lane runs a known-bad implementation. `tools/conformance/meta-conformance/run.ts` checks the assertion engine, plan compiler, evidence-only guardrails, and evidence contract, but never whether a plan detects a defective implementation. A naive gate ("every mutant fails some check") is satisfied by startup failures, missing capabilities, malformed observations, or one universally broken mutant. The harness converts adapter exceptions into failed assertions (`tools/conformance/harness/run.ts:605`).
- **Decision:**
  1. **Behavioral mutants.** A mutant is a test-only defective build of a reference implementation. It wraps the backend or kernel and alters behavior before observation; it is never a production flag. Mutation code lives in the language's testkit (`typescript/kernel/testkit` first). A non-certifying adapter manifest selects a mutant by id. Observation-path corruption (a lying adapter) is a separate, smaller control set that tests runner rejection, not implementation observability.
  2. **Control manifest.** `spec/conformance/<port>/negative-controls.json`, validated by `tools/schemas/negative-control-manifest.schema.json`, declares per mutant: `mutantId`, the authority rule and `claimIds` it violates, activation preconditions, applicable profiles, and the designated assertions that must fail.
  3. **Valid detection.** A kill counts only when:
     - the unmutated control passes under the same configuration;
     - activation is proven, meaning the mutated branch executed;
     - at least one designated semantic assertion fails.

     Failures outside the designated set are reported as collateral, not as kills. Build errors, startup failures, timeouts, protocol failures, and capability gaps are `invalid` runs. Outcomes are reported separately as activated, killed, survived, equivalent, unsupported, and invalid.
  4. **Gate.** For each migrated profile, every mutant in the manifest must be killed. Every promoted `claimId` must have at least one designated detecting mutant, or be listed as undetected with a reason. Every conditional-assertion branch must be exercised somewhere in the fleet. Coverage is measured rule to assertion. The gate runs inside the existing `bun run conformance` lane and is enforcing per profile once that profile has migrated.
  5. **Baseline first.** The first control run targets the current, unmigrated plans. Its undetected list is the measured justification and the worklist for the rewrites.
  6. **Initial kernel set:**
     - wrong opaque-object hash;
     - accept one noncanonical CBOR encoding;
     - non-canonical `changedPaths` order (ADR-0080);
     - drop an uncommitted staged result on recovery;
     - promote staged work before a checkpoint;
     - expose a new head with an incomplete checkpoint (durable profiles);
     - accept a stale competing head update;
     - permit lease takeover before expiry;
     - accept a stale owner after takeover;
     - resolve an object across scopes on a shared substrate;
     - delete an object reachable through another live root;
     - sweep an unreachable object inside the active-lease grace window;
     - never sweep eligible objects;
     - fault seam never fires;
     - expire leases on the worker clock (shared-backend profile only).

     Later additions: lateral lineage rejection, incorporation and diff membership, verdict composition, pagination, delayed subscription, ignored cancellation, unbounded buffering. Representative controls are reproduced in Rust. Erasure key handling is excluded from the kernel set (owner ruling; crypto-shredding is outside the kernel per docs/KrakenKernelSpecification.md:946).
- **Alternatives considered:**
  - Fable proposed exact set equality between failed checks and a `mustFail` list. Codex proposed designated detecting claims with activation proof. Exact equality was rejected because one defect legitimately cascades into collateral failures. Designated assertions with activation proof and an invalid-run class were chosen. Fable's baseline run against current plans and its `fault-ignored` mutant were adopted.
  - Fake adapters as the only controls. Rejected by both designs: they exercise transport grading, not the implementation.
- **Consequences:** Assumed until observed. Mutation coverage is bounded evidence of sensitivity to the listed defects, not completeness. Each new kernel family adds its mutants in the same change that migrates it.
