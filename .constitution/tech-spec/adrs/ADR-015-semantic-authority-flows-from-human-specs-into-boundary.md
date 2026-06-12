### ADR-015 Semantic Authority Flows from Human Specs into Boundary-Owned Machine Artifacts

- **Status:** accepted
- **Context:** The multi-language transition needs machine-readable contract, conformance, and interop assets, but those assets cannot become an unreviewed parallel spec.
- **Decision:** `docs/` and `.constitution/` remain the human semantic authorities. Boundary-owned machine-readable assets under `contracts/`, `conformance/`, and `interop/` are downstream authority layers that must be updated in lockstep when they become normative.
- **Consequences:** Generated code, helper wrappers, and compatibility reports are evidence or implementation support, not semantic source of truth. Contract or behavior drift must be resolved by updating the human and machine artifacts together.

