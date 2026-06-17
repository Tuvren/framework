### Epic BH — Conversation-State Ownership Hardening (KRT)

**Status:** Active. Fourth epic of the SaaS-Readiness block. Realizes ADR-053 (Tuvren is the unconditional conversation-state owner) for PRD CAP-P0-069, and delivers the ADR-055 baseline-bridge `providerExecuted`/`dynamic` fidelity audit. Depends on Epic BF for the shreddable payload envelope. Mostly internal behavior plus the bridge audit; sized at the lower end of the epic heuristic.

**KRT-BH001 Authority Alignment for Conversation-State Ownership**
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** KRT-BE001
- **Capability / Contract Mapping:** PRD `CAP-P0-069`; TechSpec ADR-053; `docs/KrakenFrameworkSpecification.md` conversation-state-ownership note
- **Description:** Classify the framework conversation-state-ownership spec note in the coverage matrix and reference it from the provider-api authority packet with its conformance entry.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given the framework spec adds the conversation-state-ownership note
When the freeze gate runs
Then the note is classified in the coverage matrix
And the provider-api authority packet references the conversation-state-ownership conformance entry
```

**KRT-BH002 Reconstruct-from-DAG Proof + Shreddable Continuity Artifacts**
- **Type:** Feature
- **Effort:** 5
- **Dependencies:** KRT-BH001, KRT-BF005
- **Capability / Contract Mapping:** PRD `CAP-P0-069`; TechSpec ADR-053, ADR-051
- **Description:** Prove the Provider Gateway reconstructs a provider request from durable lineage alone, and store carried continuity artifacts as shreddable host-key-encrypted references (reuse the BF005 envelope), never depending on provider-held state.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a multi-turn conversation with provider continuity artifacts
When the provider request for the next turn is built
Then it is reconstructed from durable lineage without relying on any provider-held state
And carried continuity artifacts are stored as host-key-encrypted shreddable references
```

**KRT-BH003 Close the AY005 Multi-Turn providerContinuity Round-Trip**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** KRT-BH002
- **Capability / Contract Mapping:** PRD `CAP-P0-069`; AY005 gap (TechSpec changelog v0.29.3)
- **Description:** Close the known AY005 gap: prove extraction of `providerContinuity` from a response and re-injection into the next prompt across a real multi-turn test.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a provider response carrying continuity metadata
When the next turn's prompt is constructed
Then the continuity metadata is extracted into lineage and re-injected into the next prompt
And a multi-turn test asserts the round-trip end to end
```

**KRT-BH004 Correctness-Neutral Caching Proof**
- **Type:** Feature
- **Effort:** 3
- **Dependencies:** KRT-BH002
- **Capability / Contract Mapping:** PRD `CAP-P0-069`; TechSpec ADR-053
- **Description:** Prove provider-side caching is correctness-neutral: a cache miss changes cost, not outcome; the reconstructable request and the canonical result are identical with or without a cache hit.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a turn that would benefit from provider-side caching
When the cache misses versus hits
Then the produced canonical result is identical
And only cost or latency differs
```

**KRT-BH005 Bridge providerExecuted/dynamic Fidelity Audit**
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** KRT-BH001
- **Capability / Contract Mapping:** TechSpec ADR-055; provider-native execution class
- **Description:** Audit the AI SDK bridge's `providerExecuted`/`dynamic` round-trip against the `parseToolCall` landmine (vercel/ai #10888): confirm provider-executed tool calls and results attribute to the provider-native execution class without spurious validation errors and that per-class observation limits hold; record findings and apply any fix or guard.
- **Acceptance Criteria (Gherkin):**
```gherkin
Given a provider-executed tool call with providerExecuted and dynamic set
When it flows through the AI SDK bridge into the runtime
Then it is attributed to the provider-native execution class
And no spurious validation error is injected
And the per-class observation limits (no cancel, retry, or audit) hold
```
