### ADR-030 Adapter Evidence Is Not a Semantic Oracle

- **Status:** accepted
- **Context:** Promoted checks can appear to pass while relying on adapter-provided `evidence` fields, implementation-local verifier helpers, fake-kernel harness output, or check-result proxy fields. That recreates an implementation oracle inside the adapter even when the shared runner owns formal pass/fail mechanics.
- **Decision:** Adapter-supplied `Observation.evidence` is diagnostic and provenance material only. A promoted conformance pass must be decided from runner-observed `Observation.result`, `Observation.events`, `Observation.state`, schema validity over those domains, error-envelope shape, event ordering, terminality, or explicit absence of runner-observed events. `evidenceField` assertions may exist only as diagnostics and can never be the only semantic proof for a promoted check.
- **Consequences:** Authority Packet-referenced promoted plans must reject evidence-only checks. Promoted adapters must not return semantic verdict fields through evidence, import semantic verifier/assertion helpers, or use implementation-local `/test/` harnesses as the main proof path unless that harness is promoted as a boundary-owned testkit with a bounded contract.

