# Spike Report: KRT-BF002 Crypto-Shredding Envelope + Host-Key Custody

## 1. Context & Objective
- **Triggering upstream file/section:** `.constitution/tech-spec/adrs/ADR-051-data-lifecycle-reachability-reclamation-and-crypto-shr.md`; Architecture Data Lifecycle, Reclamation & Erasure Model
- **Target:** The host-key-encrypted untrusted-edge payload envelope that makes sensitive payloads erasable by key destruction (crypto-shredding) while leaving the lineage hash structure intact, with keys held entirely by the host.

## 2. Codebase Baseline
- **Current State:** _To be filled during execution._ Untrusted-edge payloads (provider/tool/MCP/client results, carried continuity artifacts) are currently stored as plaintext blobs via `store.put`; the kernel is oblivious to payload content.
- **Discovered Constraints:** _To be filled during execution._ Kernel must remain data-only (ADR-001); the encrypt/decrypt seam lives at the framework edges, not the kernel.

## 3. Options & Trade-offs
- Envelope shape: per-payload key reference vs. per-subject/per-scope key reference.
- Seam placement: encrypt-on-write/decrypt-on-read at each edge (Provider Gateway, Tool Execution Gateway, MCP Client, Client Endpoint Boundary) vs. a shared payload-codec.
- Erased-read behavior: typed erased/unavailable result vs. structural placeholder.
- Key custody: host-provided keyring/callback (runtime stores only ciphertext + key reference); the runtime never persists or manages keys.

## 4. Execution Directives
- **Chosen Option:** _To be filled during execution._
- **Why it fits:** _To be filled during execution._
- **Downstream Backlog Impact:** Unlocks `KRT-BF005` (and is reused by `KRT-BH002`).
