### Epic BC — Tooling Restructuring Closeout (KRT)

**Status:** Active, final epic of the Tooling block. Proves the whole tooling aspect is finished end to end and states the model in the framework specification.

**KRT-BC001 Cross-Class Integration Conformance**
- **Type:** Feature
- **Effort:** 8
- **Dependencies:** `KRT-BA005`, `KRT-BB006`
- **Capability / Contract Mapping:** PRD `CAP-P0-056` through `CAP-P1-063`; TechSpec §4.21, §5.7
- **Description:** Add a `capability-orchestration-integration` check set exercising one agent segment that uses all four execution classes and at least one MCP binding under each applicable class, asserting the conceptual invariant holds across classes, policy applies at both decision points, and per-class observation limits are honored simultaneously.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given all four execution classes, bindings, policy, and observation are implemented
When the cross-class integration check set is added
Then one agent segment exercises provider-native, provider-mediated, Tuvren-server, and Tuvren-client capabilities plus MCP bindings
And the conceptual invariant holds for every invocation across the segment
And exposure-time and invocation-time policy apply and per-class observation limits are honored simultaneously
And bun run conformance includes the new integration check set automatically
```

**KRT-BC002 Framework-Spec "Capability Orchestration" Section**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** `KRT-BC001`
- **Capability / Contract Mapping:** TechSpec ADR-046, §5.7.1
- **Description:** Add a normative "Capability Orchestration" section to `docs/KrakenFrameworkSpecification.md` (minor bump) describing the model (Tool Surface vs Capability, the four execution classes, bindings and endpoints, exposure-time and invocation-time policy, per-class observation limits, MCP-as-binding, and the conceptual invariant) so future drivers inherit it.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the capability-orchestration model is implemented and integration-conformance passes
When the framework specification's Capability Orchestration section is added
Then docs/KrakenFrameworkSpecification.md describes the model, the four execution classes, bindings/endpoints, policy, observation limits, and the conceptual invariant
And the section is normative so future drivers inherit the model
And the framework specification version is bumped
```

**KRT-BC003 Capability Surface Portability Inventory + Authority-Packet Finalization**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** `KRT-BC001`
- **Capability / Contract Mapping:** TechSpec §5.7; Architecture Authority Packet Surface
- **Description:** Finalize the authority packets and conformance plans for the capability surface and add them to the portability inventory (`.constitution/reports/epic-al-portability-inventory.json`) so the capability-orchestration surface is a tracked portable surface under the portability gate.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the capability-orchestration contracts and conformance plans exist
When the portability inventory and authority packets are finalized
Then the capability-orchestration surface is recorded in the portability inventory as a tracked portable surface
And its authority packets reference the capability-orchestration conformance plans
And the portability gate evaluates the capability surface
```

**KRT-BC004 Tooling Block Closeout: `verify` + Finished DoD**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** `KRT-BC002`, `KRT-BC003`
- **Capability / Contract Mapping:** TechSpec §5.7
- **Description:** Run `bun run verify` from a clean checkout, refresh compatibility evidence for the capability-orchestration lanes, and validate the block-level "tooling is finished" definition of done: all four execution classes orchestrated with honest per-class limits, MCP-as-binding across classes, exposure/invocation policy, cross-class invariant, and framework-spec coverage.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the entire Tooling block is implemented and conformance passes
When the closeout runs
Then bun run verify exits zero from a clean checkout
And fresh compatibility evidence reflects the capability-orchestration lanes
And the block-level finished definition of done in §5 is satisfied across all four execution classes
```

