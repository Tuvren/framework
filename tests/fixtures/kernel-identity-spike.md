# Kernel Identity Spike

This spike records the verified baseline for Epic B before protocol contracts depend on it.

## Deterministic CBOR

- Library: `cbor-x@1.6.4`
- Encoder profile:
  - `tagUint8Array: false`
  - `useTag259ForMaps: false`
  - `useRecords: false`
  - `variableMapSize: true`
- Determinism rule:
  - Recursively sort plain-object keys before encoding.
  - Sort map keys by the bytewise lexicographic order of their deterministic CBOR encodings, following RFC 8949 core deterministic encoding requirements.
  - Preserve the sorted order during encoding by materializing canonical object state as ordered `Map` instances before CBOR encoding.
  - Reject values outside the restricted kernel record profile before encoding.
  - Convert safe integers outside the 32-bit fast path into `bigint` just before encoding so `cbor-x` emits CBOR integers instead of float64.
  - Disable `Uint8Array` tagging so kernel records stay within the v0.1 no-CBOR-tags rule and hash the same byte stream across runtimes.

## SHA-256

- Hash API: `globalThis.crypto.subtle.digest("SHA-256", bytes)`
- Hash string format: lowercase hexadecimal

## Fixture Strategy

- Keep reusable valid and invalid kernel-record fixtures in `tests/fixtures/kernel-record-fixtures.ts`.
- Lock one canonical record to both expected CBOR bytes and expected SHA-256 output.
- Prove insertion-order independence by encoding multiple object-construction variants and asserting identical bytes after canonicalization.
