### ADR-009 SHA-256 Is the Canonical Hash Algorithm

- **Status:** accepted
- **Context:** Durable identity must work cleanly across TypeScript, Python, Go, Rust, Bun, Node.js, Deno, and edge/Wasm-friendly environments with minimal dependency friction.
- **Decision:** Kraken uses SHA-256 as the canonical hash algorithm for both opaque object bytes and deterministic-CBOR structured records.
- **Consequences:** Hash identity uses ubiquitous primitives available in WebCrypto and standard libraries. Faster alternatives such as BLAKE3 are intentionally not used for canonical identity in v0.1.

