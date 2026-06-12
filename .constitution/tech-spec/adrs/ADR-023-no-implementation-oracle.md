### ADR-023 No Implementation Oracle

- **Status:** accepted
- **Context:** Several deferred shared contract surfaces (`runtime-api`, `driver-api`, `event-stream`, `core-types`, callable seams) still describe their cross-language meaning by pointing at a TypeScript or Rust implementation file. That posture turns the implementation language into the silent oracle, which is exactly the failure mode CAP-P0-037 forbids.
- **Decision:** No cross-implementation semantic claim, conformance assertion, or compatibility claim may cite any file under `boundaries/<area>/contracts/<surface>/implementations/<lang>/`, `boundaries/<area>/implementations/<lang>/`, or any other implementation-language source tree as authority. Implementation-language files may host bindings, adapters, generated projections, local tests, and optimization logic; they may not define portable truth.
- **Consequences:** Every surface that currently relies on a TypeScript or Rust file as authority must promote to a boundary-owned authority packet (ADR-026) or be explicitly classified as implementation-specific in the Epic Y inventory. Existing `@tuvren/runtime-api` and other facade packages remain valid binding projections, but the phrase "semantic anchor" no longer attaches to any TypeScript package; the anchor is the authority packet manifest.

