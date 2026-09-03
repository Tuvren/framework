# Spike Report: KRT-BF002 Crypto-Shredding Envelope + Host-Key Custody

> **Path note (2026-07, epic #87 PR review):** This is a point-in-time
> spike baseline; its body is preserved verbatim below and is not
> rewritten. Paths cited as `boundaries/providers/implementations/typescript`
> now live under `typescript/providers/` (bridge-ai-sdk) and
> `typescript/tools/mcp-client/` (the MCP client moved ports at 87-M5).
> None of these location shifts change the spike's findings.

## 1. Context & Objective
- **Triggering upstream file/section:** `.constitution/tech-spec/adrs/ADR-051-data-lifecycle-reachability-reclamation-and-crypto-shr.md`; Architecture "Data Lifecycle, Reclamation & Erasure Model" + Secret Isolation Model; Architecture flow §4.17 (`.constitution/architecture/flows/flow-tenant-offboarding-erasure.md`).
- **Target:** The host-key-encrypted untrusted-edge payload envelope that makes sensitive payloads erasable by key destruction (crypto-shredding) while leaving the lineage hash structure intact, with keys held entirely by the host. This unlocks the implementation ticket **KRT-BF005** and is reused by **KRT-BH002** (carried provider-continuity artifacts as shreddable references).

## 2. Codebase Baseline

Verified against the current repository:

- **Where untrusted-edge payloads enter durable storage.** Sensitive untrusted-edge payloads — provider results, tool results, MCP-tool results, client-endpoint results, and carried provider-continuity artifacts — reach the kernel as **opaque content-addressed blobs**, never as structured kernel records. The two write seams are:
  - `kernel.store.put(blob, mediaType?)` → `RuntimeKernel.store.put` (`runtime-kernel.ts:384`) → `putObject(tx, blob, now, mediaType)`, which hashes the bytes (SHA-256, ADR-009) and persists a `StoredObject { hash, bytes, byteLength, mediaType, createdAtMs }`. Used in the runtime via `storeRecord` / `putKernelRecord` (`runtime-core-hosts.ts:563`, `runtime-core-transition-support.ts:82`, `runtime-core-facade-ops.ts:91`).
  - `kernel.staging.stage(runId, blob, taskId, objectType, status, interruptPayload?)` (`runtime-kernel.ts:346`) → `putObject(...)` then a `StoredStagedResult` referencing the resulting `objectHash`. Used for run-scoped staged work (`runtime-core-hosts.ts:555`).
  - Canonical events are likewise stored as objects and referenced by `eventHash` on `TurnNode` / run completion (`runtime-core-hosts.ts:484,574,820`).
- **The kernel is already oblivious to payload content (ADR-001).** `StoredObject.bytes` is a byte string the kernel only hashes and returns; it never inspects structure. `store.get(hash)` returns the bytes verbatim; `store.has(hash)` is a pure existence check. There is **no per-record schema** on stored objects — the kernel cannot tell ciphertext from plaintext. This is the property crypto-shredding relies on: the kernel can hold ciphertext exactly as it holds plaintext today.
- **Content addressing is `(scope, hash)` after Epic BE.** A `Scope` is bound at backend construction (`MemoryBackendOptions.scope`, SQLite file-per-scope, PostgreSQL scope-keyed snapshot row); identical content under two scopes is two independent durable objects with no cross-scope dedup. So a per-scope encryption key gives per-scope crypto-shredding for free, and full offboarding is "drop the scope partition + destroy the scope's key(s)" (§4.17).
- **The four edges that produce these payloads** (the Secret Isolation Model's credential-bearing edges, and exactly the places ADR-051 names for the encrypt/decrypt seam):
  - **Provider Gateway** — provider request/response artifacts and `providerContinuity` artifacts; the AI-SDK bridge (`boundaries/providers/implementations/typescript`).
  - **Tool Execution Gateway** — `ToolResultPart` payloads from host-defined tools (`tool-execution.ts`, `tool-execution-helpers.ts`; `ToolResultPart` in `runtime-contract-shapes.ts:66`).
  - **MCP Client Container** — results from MCP-server-backed tools (`boundaries/providers/implementations/typescript` MCP client; classified as a binding mechanism, not an execution class).
  - **Client Endpoint Boundary** — leased client-endpoint dispatch results (`client-endpoint-boundary.ts`).
- **Discovered constraints.**
  - The kernel must stay data-only (ADR-001): the encrypt/decrypt seam lives at the framework edges, never inside the kernel or backends. The kernel keeps storing/serving opaque bytes.
  - The lineage hash must not change on erasure. Therefore the hash must be computed over the **ciphertext envelope** that is what `store.put` receives — not over the plaintext. Destroying the key leaves the same envelope bytes (and thus the same hash and the same TurnNode/eventHash references) intact; only the *recoverability* of the plaintext is destroyed.
  - The runtime must never persist, derive, escrow, or manage keys (ADR-051): durable state may contain only ciphertext + a `keyRef`. Key custody is entirely host-side, consistent with how credentials are already confined to the Provider/MCP edges and excluded from durable, canonical-stream, telemetry, and transcript surfaces (Epic BD Secret Isolation).
  - Back-compatibility: today's single-tenant, no-codec hosts must keep storing plaintext and reading it back unchanged. The codec must be opt-in with a plaintext default.

## 3. Options & Trade-offs

### Crypto model (resolved with the product owner)
- **Chosen — interface-first contract + optional default AES-256-GCM codec.** Define a host-supplied `PayloadCodec` interface as the contract (the runtime calls it; it ships no mandatory crypto), and additionally ship `createAesGcmPayloadCodec({ keyring })` — a default AEAD codec built on `node:crypto` AES-256-GCM that consumes host-supplied key bytes from a host keyring. Most faithful to "the host owns keys" while staying batteries-included: a host can adopt the default with a key map, or implement the interface over a KMS/HSM. The default codec is just one implementation of the interface, so the interface stays the authority.
- **Rejected — pure host callback only.** Maximally flexible but gives no out-of-the-box path; every adopter must wire crypto before they can shred. Recorded as the degenerate case of the chosen model (a host that implements `PayloadCodec` directly without the default).
- **Rejected — built-in AES-GCM only (no interface).** Simplest host API but bakes a single crypto choice into the runtime and blocks KMS/HSM custody. The chosen model subsumes it (the default codec) without the lock-in.

### Envelope shape
- **Chosen — per-payload self-describing AEAD envelope, serialized as the stored blob.** `store.put` receives the serialized envelope; the kernel hashes and stores it as a normal object. Shape:
  ```
  PayloadEnvelope (v1) = {
    v: 1,
    alg: "AES-256-GCM",        // codec algorithm tag (enables future agility)
    keyRef: string,             // host's opaque key reference (resolved by the keyring)
    iv: bytes,                  // 96-bit GCM nonce, unique per encryption
    ciphertext: bytes,          // AEAD ciphertext of the plaintext payload
    tag: bytes,                 // GCM authentication tag
    aad?: bytes                 // optional additional authenticated data (edge + scope binding)
  }
  ```
  Self-describing (`alg`, `v`) so decrypt needs no out-of-band state and future algorithm agility is possible. `keyRef` is the only key-related datum stored — never the key.
- **keyRef granularity — per-Scope by default, per-subject permitted.** Recommend the host resolve `keyRef` to a per-Scope key so destroying one key shreds all of that scope's untrusted-edge payloads and composes directly with §4.17 offboarding (drop scope + destroy scope key). The interface does not constrain this: a host that needs per-subject right-to-erasure inside a shared scope can map `keyRef` to a subject id and destroy that subject's key. The runtime treats `keyRef` as opaque.
- **Rejected — separate key-reference sidecar record.** Adding a new kernel record type to carry the key reference violates "no new kernel record semantics" (ADR-051) and ADR-001. Folding `keyRef` into the opaque envelope keeps the kernel oblivious.

### Seam placement
- **Chosen — one shared payload-codec helper, encrypt at the four write-edges, decrypt at the durable-read materialization path.** A single helper performs encrypt-on-write immediately before `kernel.store.put` / `kernel.staging.stage` at the four producing edges (Provider Gateway, Tool Execution Gateway, MCP Client Container, Client Endpoint Boundary), and decrypt-on-read immediately after `kernel.store.get` **where these payloads are actually re-read** — the durable-read / head-state reconstruction path (`durable-reads.ts`, `runtime-core-head-state.ts`), not the four edge files (the edges only *write*). Writers and the read path share one codec implementation, so a payload encrypted at any edge is decrypted symmetrically wherever lineage materializes it; no edge can write ciphertext that some other read path then surfaces undecrypted. The `PayloadCodecContext` passed to the helper names the edge and the Scope so the codec/keyring can choose the `keyRef` and bind AAD.
- **Rejected — per-edge bespoke encryption.** Four divergent implementations risk inconsistent AAD/keyRef handling and a missed edge (a silent plaintext leak). A shared helper is auditable in one place, mirroring the shared secret-screening helper from Epic BD.
- **Rejected — encrypt inside the kernel/backends.** Violates ADR-001; would make the kernel key-aware.

### Erased-read behavior
- **Chosen — typed `ErasedPayload` result.** `decrypt` returns a discriminated result: `{ kind: "available"; plaintext }` or `{ kind: "erased"; keyRef; reason }`. When the host has destroyed the key the keyring yields no key and the codec returns `erased`; the edge surfaces a typed erased/unavailable result to callers (e.g. a tool/provider result marked erased) rather than throwing. Reading shredded lineage is a normal, total operation.
- **Rejected — crash/throw on missing key.** Makes historical reads of legitimately-erased subjects fail unpredictably; turns a compliance success into an availability incident.
- **Rejected — structural placeholder substituted into lineage.** Would change what `store.get` returns vs. what was hashed and risk hash/structure confusion. The envelope bytes (and hash) stay intact; only the decoded *result* is typed-erased.

### Key custody
- **Chosen — host-provided keyring (map or callback); runtime stores only ciphertext + keyRef.** `createAesGcmPayloadCodec({ keyring })` where `keyring` resolves `keyRef → key bytes | undefined`. The host owns the keyring lifecycle entirely (in-memory map, KMS/HSM callback, etc.). "Erase a subject/scope" = the host removes/rotates-away the key so `keyring.resolve(keyRef)` returns `undefined`. The runtime never persists, caches durably, derives, or escrows keys; key bytes live only transiently in the codec call. This keeps ADR-001 and the Secret Isolation Model intact.

## 4. Execution Directives
- **Chosen Option:** Interface-first `PayloadCodec` contract + optional `createAesGcmPayloadCodec({ keyring })` default (AES-256-GCM via `node:crypto`); per-payload self-describing AEAD envelope (`{ v, alg, keyRef, iv, ciphertext, tag, aad? }`) serialized as the stored blob and hashed by the kernel; one shared codec helper wired at the Provider Gateway, Tool Execution Gateway, MCP Client Container, and Client Endpoint Boundary; typed `ErasedPayload` on decrypt; host-held keyring resolving `keyRef → key`. Codec is opt-in via `createTuvren({ payloadCodec })` with a plaintext/identity default so existing hosts are unchanged.
- **Why it fits:** The kernel keeps storing opaque content-addressed bytes (ADR-001 preserved), so hashing the ciphertext envelope means erasure (key destruction) leaves every hash, TurnNode, eventHash, and branch structure byte-identical while rendering the plaintext unrecoverable — exactly the crypto-shredding invariant in ADR-051 and the §4.17 flow. Keys never enter durable state; only ciphertext + an opaque `keyRef` do, so key custody stays host-owned and the Secret Isolation Model holds. Per-Scope `keyRef` composes with ADR-049 isolation-by-construction so tenant offboarding is "destroy the scope key + drop the scope partition," and the shared edge helper keeps the seam auditable in one place. The typed erased result makes reading shredded lineage total rather than fatal.
- **Implementation notes to confirm during KRT-BF005 execution:**
  - Place the `PayloadCodec` interface, `PayloadEnvelope`/`ErasedPayload`/`PayloadCodecContext` types, and `createAesGcmPayloadCodec` in `@tuvren/core` (public host-facing contract) and re-export from `@tuvren/runtime`; keep the entrypoint small and explicit.
  - Implement one shared helper (`encryptForStore` / `decryptFromStore`); wire `encryptForStore` at the four edges' `store.put`/`staging.stage` write points and `decryptFromStore` at the durable-read materialization path (`durable-reads.ts`, `runtime-core-head-state.ts`) where stored payloads are actually re-read — confirm every read site that materializes an untrusted-edge payload runs decrypt, so no writer is left emitting ciphertext that another read path surfaces undecrypted. Default codec = identity (no envelope) so no-codec hosts store plaintext exactly as today.
  - The AAD should bind at least the edge kind and the Scope so a ciphertext from one edge/scope cannot be silently replayed into another; document the AAD layout with the envelope.
  - Use a fresh 96-bit IV per encryption; never reuse `(key, iv)`.
  - Assert in tests that the kernel only ever receives the ciphertext envelope (no plaintext on durable, canonical-stream, telemetry, or transcript surfaces) and that destroying the key yields a typed erased read while the referencing lineage hash structure is byte-identical.
- **Downstream Backlog Impact:** Unlocks **KRT-BF005** (implements this envelope at the four edges) and **KRT-BF006** (tenant-offboarding: destroy scope key + reclaim + drop scope partition). The envelope and codec are reused by **KRT-BH002** (carried provider-continuity artifacts modeled as shreddable references). The data-lifecycle conformance in **KRT-BF007** proves erasure renders payloads unrecoverable while lineage stays structurally intact.
