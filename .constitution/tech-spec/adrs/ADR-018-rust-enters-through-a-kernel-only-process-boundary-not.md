### ADR-018 Rust Enters Through a Kernel-Only Process Boundary, Not FFI

- **Status:** accepted
- **Context:** The first non-TypeScript implementation needs a durable, inspectable, versioned seam that can later serve more than one language pair. FFI would couple early Rust work to the current embedding model and make versioning, observability, and process isolation harder.
- **Decision:** The first Rust phase is limited to the kernel boundary and exposes that boundary through a process transport contract rather than FFI. The framework remains TypeScript-first until the kernel transport and parity story are routine.
- **Consequences:** The first Rust implementation proves language-neutral kernel semantics without forcing an immediate Rust framework port. Performance optimization through tighter embedding can be reconsidered later only after the process-boundary contract is proven.

