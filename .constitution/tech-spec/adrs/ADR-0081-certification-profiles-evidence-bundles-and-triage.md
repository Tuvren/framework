---
id: ADR-0081
status: accepted
date: 2026-10-22
certainty: assumed
assumption: "Synthesized from two independent designs after the owner asked that findings be triaged into verification versus implementation defects in the 2026-10-22 session; settles by ruling when the owner approves this pass."
---
### ADR-0081 Certification Profiles, Evidence Bundles, and Triage

- **Status:** accepted. Amends ADR-0031: zero applicable checks is never `pass`.
- **Context:** The harness sets raw status to `pass` whenever zero checks fail, including when zero checks apply (`tools/conformance/harness/run.ts:881`). Evidence validation uses the same rule (`tools/scripts/lib/conformance-contract.ts`). `tools/conformance/certification/certified-projects.json` lists `framework-rust-certification`, whose adapter declares no capabilities and records 0 applicable checks of 523. Adapter manifests choose their own packets and capabilities, so an adapter can narrow its suite by omission (`tools/conformance/harness/run-plans.ts:115`). Failure records keep assertion statuses and short messages, but not resolved operands, raw observations, or replay data (`tools/conformance/harness/assertion-engine/index.ts:498`).
- **Decision:**
  1. **Profiles are authority.** Each port declares certification profiles at `spec/conformance/<port>/profiles.json`, validated by `tools/schemas/certification-profile.schema.json` and referenced by the authority packet. A profile names its required capabilities, `claimIds`, required evidence, fault coverage (ADR-0076), and negative controls (ADR-0079). An adapter manifest claims profiles. It cannot drop an obligation by withholding a capability: a claimed profile with a non-applicable required check fails.
  2. **Fleet versus certified.** `certified-projects.json` becomes a discovery inventory with truthful states. A separate certified list names the project and profile pairs that must certify. The Rust framework stays in the inventory as `unsupported` until it claims a profile.
  3. **Certificate.** A certificate is the evidence bundle of one complete, unfiltered, unsharded-or-fully-aggregated run for an exact implementation, backend, and profile. It contains:
     - digests of the implementation artifact, adapter manifest, harness, authority packet, plans, catalogs, fixtures, profiles, and control manifest;
     - toolchain and backend versions and an environment fingerprint;
     - the selection inventory, with a reason for every exclusion;
     - per-check results with process exits, schedules, and storage identity;
     - the id of the negative-control run at the same plan versions.

     A filtered or exploratory run, or one without a passing control run, is `uncertified`. The bundle schema is `tools/schemas/certification-evidence.schema.json`. It extends the existing evidence contract, and compatibility reporting reads it.
  4. **Failure artifacts.** Every failed check records:
     - the plan, check, and step ids and versions;
     - the operation and its fully resolved arguments;
     - the raw observation;
     - for each assertion, the expected and actual operands, the paths read, and where the expected value came from;
     - the harness frame log with arrival times;
     - the adapter stderr tail, exit code, or signal;
     - the fault state and storage identity;
     - a replay command.
  5. **Preliminary classification by the runner:**
     - `adapter_protocol`: malformed frame, timeout, handshake failure, or observation schema violation;
     - `verification`: compile error, unresolved operand, negative-control mismatch, or a fault point that was never reached;
     - `implementation`: a valid observation that fails a resolved assertion;
     - `environment`: storage provisioning or service failure.

     The runner never assigns `specification_gap`. A generated disagreement report lists checks where valid observations from two or more implementations differ and no authority rule decides between them.
  6. **Human triage.** Each failure gets a triage entry in the owning epic's `.constitution/evidence/<EPIC-ID>/certification-triage.yaml`, written by the epic lead, with one of four classes, an evidence pointer, an owner, and a resolution:
     - **V (verification):** a binding, plan, catalog, runner, double, or instrumentation misrepresents established authority. Fixed inside the migrating epic.
     - **I (implementation):** a valid observation violates unambiguous machine authority. Filed as an issue with the replay command.
     - **S (specification gap):** the authority is absent, contradictory, or ambiguous, including conflicts between accepted machine artifacts. Goes to the open-decisions register before any code changes.
     - **E (environment):** made deterministic or fixed in the harness.

     Entries may be pending or multi-cause. Cross-language agreement is a signal, never a verdict, and TypeScript behavior does not decide semantics. A classification never turns a red result green.
- **Alternatives considered:** Fable placed profiles inside the authority packet. Codex placed them in a packet-referenced file under `spec/conformance/<port>/`. The separate file was chosen to match the catalog and the control manifest. Fable's runner pre-classification and generated disagreement report were adopted on top of the Codex bundle contents. A summary-only certificate was rejected by both designs because it overstates scope.
- **Consequences:** Assumed until observed. The compatibility matrix is generated from complete bundles. The certified fleet shrinks to truthful entries before it grows. Evidence volume grows, so successful-run transcripts stay outside the repository; the checked-in evidence keeps the summary and digests.
