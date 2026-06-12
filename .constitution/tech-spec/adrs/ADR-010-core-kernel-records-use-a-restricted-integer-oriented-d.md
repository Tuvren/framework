### ADR-010 Core Kernel Records Use a Restricted Integer-Oriented Data Model

- **Status:** accepted
- **Context:** Cross-language deterministic encoding gets riskier when floats, tags, and broad dynamic types are allowed into core kernel records.
- **Decision:** Core kernel records are restricted to maps with string keys, arrays, text, byte strings, booleans, nulls, and integers. Floating-point values are not allowed in normative kernel records. Persisted timestamps are signed Unix epoch millisecond integers.
- **Consequences:** Deterministic CBOR encoding remains simple and predictable. Float-bearing data, if ever needed, must live in opaque objects, extension state, or higher-layer provider/application payloads, not in core kernel records.

