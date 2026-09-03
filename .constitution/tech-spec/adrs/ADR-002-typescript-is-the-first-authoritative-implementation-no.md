---
id: ADR-0002
status: accepted
date: 2026-09-03
certainty: assumed
assumption: "Migrated; the decision's ruling reference was not found in the status line."
---
### ADR-002 TypeScript Is the First Authoritative Implementation, Not the Long-Term Kernel Monopoly

- **Status:** accepted
- **Context:** The project needs a fast path to validating the kernel and framework semantics, but the protocol must remain suitable for future Rust, Wasm, or other implementations.
- **Decision:** Use TypeScript `6.0.2` for the first authoritative implementation of the framework and kernel protocol. Treat it as the reference implementation of the protocol, not as a license to collapse protocol boundaries into JavaScript-only assumptions.
- **Consequences:** The implementation can progress quickly, while future Rust or Wasm implementations remain possible if they pass the same protocol fixtures and semantic test suites.

