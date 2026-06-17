### Epic BI — SDK Stabilization + npm Publication (KRT)

**Status:** Active. Fifth epic of the SaaS-Readiness block. Realizes ADR-054 (public SDK API stability + registry publication; experimental capabilities subpath) for PRD CAP-P0-070. **Gated to run after Epics BE and BF** so the frozen public surface already accounts for scope binding and erasure (freeze-after-tenancy+GC, resolved fork Q3). Mostly tooling, config, and docs; sized at the lower end of the epic heuristic.

**KRT-BI001 Public-Surface API Audit of the Stable Core**
- **Type:** Chore
- **Effort:** 5
- **Dependencies:** KRT-BE006, KRT-BF006
- **Capability / Contract Mapping:** PRD `CAP-P0-070`; TechSpec ADR-054
- **Description:** Audit the public surface of the stable core (`@tuvren/core` subpaths, the Durable-Read Surface, `ExecutionHandle`/`awaitResult`, `createTuvren`, and the published leaf packages) after tenancy and data-lifecycle land; confirm no `Kraken*` internal type leaks and that the construction-time scope binding requires no public read-signature change.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the stable-core public surface after Epics BE and BF land
When the API audit runs
Then no Kraken* internal type is exported on the public surface
And no Durable-Read or createTuvren signature requires a scope parameter
And the audited surface is recorded as the freeze candidate
```

**KRT-BI002 Mark Advanced Capabilities Experimental**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-BI001
- **Capability / Contract Mapping:** PRD `CAP-P0-070`; TechSpec ADR-054
- **Description:** Mark the `@tuvren/core/capabilities` advanced classes as experimental in types and documentation and exclude them from the stability guarantee.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the @tuvren/core/capabilities advanced classes are still settling
When the stable core is defined
Then those classes carry an explicit experimental marker in types and docs
And they are excluded from the semver stability guarantee
```

**KRT-BI003 Semver Freeze + API-Stability Gate**
- **Type:** Chore
- **Effort:** 5
- **Dependencies:** KRT-BI002
- **Capability / Contract Mapping:** PRD `CAP-P0-070`; TechSpec ADR-054
- **Description:** Freeze the stable-core public API under semantic versioning and add an API-surface snapshot/diff guard to the canonical verification path so an unintended breaking change to the stable core fails CI while experimental-surface changes do not.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the frozen stable-core public API snapshot
When a change alters an exported stable-core signature
Then the API-stability gate fails the verification path
And a change confined to the experimental surface does not trip the gate
```

**KRT-BI004 Registry Publication Pipeline**
- **Type:** Chore
- **Effort:** 5
- **Dependencies:** KRT-BI003
- **Capability / Contract Mapping:** PRD `CAP-P0-070`; TechSpec ADR-054, ADR-037 (peer-dep version-skew safety)
- **Description:** Establish the registry publication pipeline (versioning, peer-dependency version-skew safety, provenance) and publish the curated packages to the public registry.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the frozen stable core and the publication pipeline
When the packages are published to the registry
Then leaf packages peer-depend on a single @tuvren/core version
And published artifacts carry provenance
And a consumer can install and issue a first Turn from the published packages
```

**KRT-BI005 Adopter Onboarding for the Stable/Experimental Boundary**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-BI004
- **Capability / Contract Mapping:** PRD `CAP-P0-070`; TechSpec ADR-054
- **Description:** Provide adopter-facing onboarding that documents the stable core, the experimental boundary, and the install plus first-Turn path against the published packages.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the published packages
When an adopter reads the onboarding
Then the stable core and experimental surfaces are clearly delineated
And the documented install and first-Turn path works against the published packages
```
