### ADR-019 Multi-Implementation Compatibility Is Proven by Shared Suites and a Generated Ledger

- **Status:** accepted
- **Context:** Comparing TypeScript and Rust directly would make the first implementation the oracle and hide which semantic surfaces actually pass or fail.
- **Decision:** Implementations prove parity by running the same boundary-owned conformance suites and interop-smoke checks, then publishing their status to a generated compatibility ledger under `reports/compatibility/`.
- **Consequences:** Compatibility claims become inspectable and versioned. The ledger records implementation reality without becoming semantic authority itself, and CI can separate repo-global, language-native, and cross-language validation lanes cleanly.

