---
id: ADR-0078
status: accepted
date: 2026-10-22
certainty: assumed
assumption: "Synthesized from two independent designs that converged on hexadecimal byte tagging and runner-side identity recomputation; settles by ruling when the owner approves this pass."
---
### ADR-0078 Lossless Observation Encoding and Kernel Content Integrity

- **Status:** accepted.
- **Context:** Kernel records carry byte strings and safe integers (`spec/kernel/cddl/kernel-records.cddl:6-16`). The reference encoder distinguishes `Uint8Array` from arrays and rejects unsafe or noncanonical numbers (`typescript/kernel/protocol/src/lib/kernel-record-identity.ts:99,198`). Identity is type-specific: opaque objects hash raw bytes, TurnNodes hash an identity projection that excludes `hash`, and TurnTrees hash `{manifest, schemaId}` (`kernel-record-identity.ts:473`; `kernel-identity.ts:52,952`). Fixtures currently carry bytes as integer arrays (`spec/conformance/kernel/fixtures/kernel-protocol-deterministic.json`). Nothing in the runner checks that observed records are canonical or that they hash to their identities.
- **Decision:**
  1. **Encoding profile.** `tools/schemas/conformance-observation-encoding.schema.json` is referenced by every catalog.
     - Bytes are `{"$bytes": "<lowercase hex>"}`, with exact-length validation where the schema fixes a length.
     - Kernel record numbers, and every field a binding schema types as an integer, are JSON numbers within the safe-integer domain. For these fields, fractions, non-finite values, negative zero, and out-of-range values are rejected before any lossy conversion.
     - Other numeric fields keep the domain their binding schema admits. A `float64` field such as `TelemetryAttributeValue.number` (`spec/core/typespec/main.tsp`) crosses as a finite JSON number, and non-finite values and negative zero are handled as that schema specifies.
     - Absent optional fields are omitted, and `null` appears only where the CDDL allows it.
     - Hashes are lowercase 64-character hex. Handles and identifiers are separate string types.
     - Duplicate keys are rejected before ordinary JSON parsing.
     - Array order is preserved.
     - Arbitrary `KernelRecord` values use a recursive tagged union with explicit map and byte nodes, so user data cannot collide with transport tags.

     Fixtures migrate from integer arrays to `$bytes`.
  2. **Identity recipes.** `spec/conformance/kernel/identity-recipes.json` declares, per record type, the field projection, the deterministic CBOR profile (exact ordering rule, not just "canonical"), and the hash algorithm.
  3. **Runner-computed integrity.** New assertion kinds: `digest` hashes observed bytes and compares against a path; `canonicalCbor` encodes an observed record under the recipe and compares against observed bytes; `identity` recomputes a record's identity from observed fields; `referenceWalk` traverses declared references (parent chains, manifests, branch heads, staging consumption). Native inspectors return records and stored bytes, never summary flags. Where an implementation exposes stored canonical bytes, canonical-byte checks are separate from decoded-value checks.
  4. **Independence from the production encoder.** Committed vectors remain the authority. The runner's encoder is verifier tooling, pinned to those vectors and cross-validated by the Rust encoder before a recipe is promoted, so the verifier and the TypeScript production encoder cannot share one blind spot. Vectors cover byte strings versus integer arrays, large safe integers, absent optional fields, interrupted staged results, and map ordering.
  5. **Generated record schemas.** JSON Schema generated from `kernel-records.cddl` lets `schemaValid` assertions check observed records in every language.
- **Alternatives considered:**
  - Both designs chose lowercase hex over base64 (it matches the existing `*CborHex` fixtures and the CDDL patterns) and runner-side identity recomputation. Fable proposed `{"$int"}` for integers beyond 2^53. Codex's rejection of out-of-range integers was chosen because the CDDL restricts the domain to safe integers. Codex's recursive tagged union for arbitrary records was adopted over plain schema-directed JSON for values whose shape the schema does not fix.
  - Integer arrays for bytes. Rejected: they are untyped, large, and indistinguishable from real arrays.
- **Consequences:** Assumed until observed. This is a content-consistency guarantee, not proof of honesty: a fabricating adapter can still hash invented records. That residual is bounded by the trust model (ADR-0075) and negative controls (ADR-0079). Every language binding needs the encoding helpers. Rust becomes the second encoder for vector cross-validation.
