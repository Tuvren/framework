### ADR-031 Raw Compatibility Status Uses Four Truthful States

- **Status:** accepted
- **Context:** Treating unsupported or non-applicable suites as `pass`, especially with `applicableChecks === 0`, makes compatibility evidence overstate readiness and hides whether a suite actually exercised a boundary.
- **Decision:** Raw compatibility status is exactly `pass`, `fail`, `unsupported`, or `not_applicable`. `pass` requires `applicableChecks > 0`, `failedChecks === 0`, and `passedChecks === applicableChecks`. `fail` means `failedChecks > 0`. `unsupported` means the suite is relevant to the implementation boundary but the implementation advertises no capabilities required by the suite. `not_applicable` means the suite does not target the implementation boundary, surface, or authority packet. `status: "pass"` with `applicableChecks === 0` is invalid.
- **Consequences:** Compatibility reporting must preserve the difference between "nothing to run because this implementation does not support the suite" and "the suite does not apply here." `reportStatus` may remain a presentation/classification field, but it must not contradict raw `status`.

