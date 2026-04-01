# Kernel Identity Spike

This spike records the verified baseline for Epic B before protocol contracts depend on it.

## Deterministic CBOR

- Library: `cbor-x@1.6.4`
- Encoder profile:
  - `useRecords: false`
  - `variableMapSize: true`
- Determinism rule:
  - Recursively sort plain-object keys before encoding.
  - Reject values outside the restricted kernel record profile before encoding.
  - Convert safe integers outside the 32-bit fast path into `bigint` just before encoding so `cbor-x` emits CBOR integers instead of float64.

## SHA-256

- Hash API: `globalThis.crypto.subtle.digest("SHA-256", bytes)`
- Hash string format: lowercase hexadecimal

## Fixture Strategy

- Keep reusable valid and invalid kernel-record fixtures in `tests/fixtures/kernel-record-fixtures.ts`.
- Lock one canonical record to both expected CBOR bytes and expected SHA-256 output.
- Prove insertion-order independence by encoding multiple object-construction variants and asserting identical bytes after canonicalization.
