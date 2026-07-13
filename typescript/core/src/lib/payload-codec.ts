/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Host-key-encrypted untrusted-edge payload envelope (ADR-051, SPK-BF002).
 *
 * Crypto-shredding lets a host satisfy right-to-erasure on a content-addressed,
 * immutable Merkle-lineage runtime *without rewriting committed history*: the
 * runtime stores only ciphertext + an opaque `keyRef`, the host owns the keys,
 * and "erase" means the host destroys the key so the ciphertext becomes
 * permanently unrecoverable. Because the durable object's hash is computed over
 * the ciphertext envelope (not the plaintext), key destruction leaves every
 * object hash, TurnNode, eventHash, and branch structure byte-identical while
 * rendering the plaintext unrecoverable.
 *
 * The contract here is the authority; `@tuvren/sdk` ships
 * `createAesGcmPayloadCodec`, one batteries-included implementation of it. A
 * host may instead implement {@link PayloadCodec} directly over a KMS/HSM. The
 * runtime never persists, derives, escrows, or caches keys — key bytes live
 * only transiently inside a codec call.
 */

// ── Codec context ────────────────────────────────────────────────────────────

/**
 * Non-secret binding context the runtime passes to the codec on every encrypt
 * and decrypt. The codec MAY use it to choose a `keyRef` and to derive
 * Additional Authenticated Data (AAD). The same context fields must be supplied
 * on decrypt as on encrypt for a given payload, otherwise AEAD verification
 * fails — this is the mechanism that prevents a ciphertext from being silently
 * replayed into a different Scope or payload class.
 */
export interface PayloadCodecContext {
  /**
   * A stable domain tag for the payload class being protected (e.g. the durable
   * record kind such as `"message"`). It is bound into AAD, so it MUST be
   * identical on the write seam and the matching read seam. It is the "edge
   * kind" binding from SPK-BF002; the conceptual producing edge (provider, tool,
   * MCP, client) is informational and collapses to a single stable record-kind
   * tag because all four edges materialize as durable messages.
   */
  edge: string;
  /**
   * The host-bound Scope (ADR-048/049) the payload belongs to. Bound into AAD
   * and used as the default `keyRef` by `@tuvren/sdk`'s `createAesGcmPayloadCodec`, so a
   * per-Scope key composes directly with tenant offboarding (destroy the Scope
   * key → every untrusted-edge payload in that Scope is shredded).
   */
  scope: string;
}

// ── Decrypt result ───────────────────────────────────────────────────────────

/**
 * Typed outcome of a decrypt. Reading a crypto-shredded payload is a normal,
 * total operation: when the host has destroyed the key the codec returns
 * `erased` rather than throwing, so historical reads of legitimately-erased
 * subjects never turn a compliance success into an availability incident.
 */
export type PayloadDecryptResult =
  | { plaintext: Uint8Array; status: "available" }
  | { keyRef: string; reason: string; status: "erased" };

/**
 * A typed erased marker surfaced to callers when durable content cannot be
 * recovered because its key was destroyed. Distinguishable from any
 * `TuvrenMessage` by its `kind` discriminant (messages carry `role`, never
 * `kind`).
 */
export interface ErasedPayload {
  keyRef: string;
  kind: "erased";
  reason: string;
}

/**
 * True when `value` is an {@link ErasedPayload} marker: `kind` is exactly
 * `"erased"` and `keyRef`/`reason` are strings.
 */
export function isErasedPayload(value: unknown): value is ErasedPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "erased" &&
    typeof (value as ErasedPayload).keyRef === "string" &&
    typeof (value as ErasedPayload).reason === "string"
  );
}

// ── Codec contract ───────────────────────────────────────────────────────────

/**
 * The host-supplied encrypt/decrypt contract the runtime calls at the untrusted
 * write/read seams. Identity is the default (plaintext passthrough); a host opts
 * in to crypto-shredding by supplying a real codec via `createTuvren`.
 */
export interface PayloadCodec {
  decrypt(
    stored: Uint8Array,
    context: PayloadCodecContext
  ): Promise<PayloadDecryptResult>;
  encrypt(
    plaintext: Uint8Array,
    context: PayloadCodecContext
  ): Promise<Uint8Array>;
  /** Stable identifier, e.g. `"identity"` or `"aes-256-gcm"`. */
  readonly id: string;
}

// ── Identity codec (default) ─────────────────────────────────────────────────

/**
 * The default codec: no envelope, plaintext stored and returned verbatim. A
 * runtime with no `payloadCodec` behaves exactly as it did before BF005, so
 * existing single-tenant hosts are unaffected and stored data stays plaintext.
 *
 * This is the payload-codec analogue of {@link isErasedPayload} and
 * `NoopTelemetrySink`: a behavior-free default the *runtime* depends on to fill
 * an unset seam. It lives on `@tuvren/core` (the ABI tier) — not `@tuvren/sdk` —
 * so the runtime can reference it without importing the composition tier, which
 * would otherwise create a `@tuvren/sdk ⇄ @tuvren/runtime` dependency cycle
 * (ADR-057). The batteries-included AES-256-GCM codec stays in `@tuvren/sdk`.
 */
export const IDENTITY_PAYLOAD_CODEC: PayloadCodec = {
  decrypt(stored) {
    return Promise.resolve({ plaintext: stored, status: "available" });
  },
  encrypt(plaintext) {
    return Promise.resolve(plaintext);
  },
  id: "identity",
};

/**
 * Returns the shared {@link IDENTITY_PAYLOAD_CODEC} instance — a factory
 * spelling for call sites that expect to construct their codec.
 */
export function createIdentityPayloadCodec(): PayloadCodec {
  return IDENTITY_PAYLOAD_CODEC;
}

// ── Envelope discriminant ─────────────────────────────────────────────────────
//
// The 4-byte magic that prefixes every AEAD envelope written by a real codec
// (the wire format itself and its (de)serialization live with the AES codec in
// `@tuvren/sdk`). The runtime read seam calls {@link isPayloadEnvelope} to detect
// an envelope and pass non-envelope (plaintext / identity-codec) bytes through
// unchanged, so plaintext and ciphertext can coexist during migration. The magic
// and its predicate live here — a single source of truth shared by the runtime
// read seam and the sdk codec — so the detection can never drift from the writer.
// CBOR-encoded kernel records never begin with this magic (a CBOR map/array
// major-type byte is 0x80–0xBF, never 0x54 'T'), so it cannot collide with a
// plaintext record.

/** The 4-byte AEAD envelope magic, ASCII `"TVE1"` (see block comment above). */
export const ENVELOPE_MAGIC = Uint8Array.of(0x54, 0x56, 0x45, 0x31); // "TVE1"

/**
 * True when `bytes` begins with {@link ENVELOPE_MAGIC}, i.e. the stored
 * payload is a codec-written AEAD envelope rather than plaintext bytes.
 * Lets the runtime read seam pass identity-codec/plaintext data through
 * unchanged so plaintext and ciphertext can coexist during migration.
 */
export function isPayloadEnvelope(bytes: Uint8Array): boolean {
  return (
    bytes.length >= ENVELOPE_MAGIC.length &&
    bytes[0] === ENVELOPE_MAGIC[0] &&
    bytes[1] === ENVELOPE_MAGIC[1] &&
    bytes[2] === ENVELOPE_MAGIC[2] &&
    bytes[3] === ENVELOPE_MAGIC[3]
  );
}
