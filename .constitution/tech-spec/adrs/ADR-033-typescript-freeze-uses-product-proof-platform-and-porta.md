### ADR-033 TypeScript Freeze Uses Product Proof, Platform, and Portability Gates

- **Status:** accepted
- **Context:** The AG closure proves an important subset of promoted semantics, but it does not by itself prove that the full TypeScript line is productized enough to freeze or that Rust can resume safely against the intended portable scope.
- **Decision:** TypeScript freeze uses three staged gates:
  - `product proof gate`: the high-level SDK plus serious REPL host prove the documented runtime surface end to end;
  - `platform gate`: package naming/topology normalization and PostgreSQL land at product depth;
  - `portability gate`: the intended portable surface is packet/plan/runner-owned under fresh evidence, with AG-UI and the TypeScript AI SDK bridge implementation remaining the main allowed implementation-specific exceptions.
- **Consequences:** Rust framework/product work remains blocked until all three gates pass. Conformance expands immediately/by subsystem during TypeScript product-building, then becomes the main driver during the portability gate closure. Per the KRT-AL003 re-entry reassessment at `.constitution/reports/epic-al-rust-re-entry-gate-reassessment.md`, all three gates currently pass under fresh canonical-lane evidence; reopening Rust framework/product, additional driver families, additional host protocols, additional official backends, or broader provider-family expansion still requires a new epic that explicitly reopens that scope, names the line, preserves the staged gates as prerequisites under fresh evidence, and adds only the line-specific evidence that goes beyond those gates.

