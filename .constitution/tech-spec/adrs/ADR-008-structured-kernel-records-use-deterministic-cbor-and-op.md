### ADR-008 Structured Kernel Records Use Deterministic CBOR and Opaque Objects Hash Raw Bytes

- **Status:** accepted
- **Context:** Kernel identity needs a compact, deterministic, multi-language-friendly encoding. Canonical JSON is human-readable, but it carries JSON number and ECMAScript canonicalization constraints that are not ideal for durable kernel identity.
- **Decision:** Structured kernel records are encoded as deterministic CBOR before hashing. Opaque stored objects are hashed from raw bytes without re-encoding.
- **Consequences:** The kernel’s identity format is binary, deterministic, and language-neutral. JSON remains a debugging, export, and tooling format, not the canonical storage identity format.

