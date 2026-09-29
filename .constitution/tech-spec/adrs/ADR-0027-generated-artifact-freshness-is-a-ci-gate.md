---
id: ADR-0027
status: accepted
date: 2026-06-12
certainty: assumed
assumption: "Migrated; the decision's ruling reference was not found in the status line."
---
### ADR-0027 Generated Artifact Freshness Is a CI Gate

- **Status:** accepted. Amended by ADR-0071: when Nx is removed, the `bun run codegen` lane becomes Bazel actions that produce each generated artifact, plus a test that diffs the output against the checked-in file and a `bazel run` target that writes it back. The gate's requirements (fail on a differing, missing or undeclared-source artifact) are unchanged, and the authority packets' `regenerateCommand` fields and the command allowlist change in the same change.
- **Context:** Generated JSON Schema, OpenAPI, Protobuf descriptors and bindings, CDDL-derived validators, conformance plans, compatibility schemas, and telemetry outputs are functionally an authority change when they drift from their authority sources. Today drift is caught only by ad hoc review.
- **Decision:** Every generated artifact named by an Authority Packet manifest is regenerated and diff-checked in CI through the existing `bun run codegen` lane plus authority-packet-aware verification. CI fails when the generated artifact differs from the regeneration output, when the generated artifact is missing, or when a declared source is missing. The same gate applies to checked-in generated language bindings, when present.
- **Consequences:** `tools/scripts` gains an authority-packet freshness verifier wired into the existing repo-global verification flow. Authority packet manifests must declare every generated artifact subject to this gate; an undeclared generated artifact is not authoritative and may be deleted by the verifier. Implementations that depend on stale generated bindings must regenerate before merge.

