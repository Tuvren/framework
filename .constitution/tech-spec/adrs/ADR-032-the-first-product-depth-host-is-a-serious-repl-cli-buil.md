### ADR-032 The First Product-Depth Host Is a Serious REPL CLI Built on the High-Level SDK

- **Status:** accepted
- **Context:** The project needs a product-depth proof that host developers can build serious operator-facing tools on Tuvren Runtime without private seams. The current playground harness proves many behaviors, but it is explicitly a local host harness rather than the lasting proving bar for the SDK surface.
- **Decision:** The first product-depth host is a serious REPL CLI built on the same high-level host-facing SDK surface that downstream hosts are expected to use. The proving host is not a separate product ontology and may not rely on private runtime shortcuts, implementation-local syscall seams, or test-only orchestration paths to claim readiness.
- **Consequences:** Host-proof claims require end-to-end validation through the REPL host. Package naming/topology normalization is scheduled immediately before the proving-host build so the CLI experience informs public-surface curation rather than the other way around.

