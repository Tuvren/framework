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
 * Batteries-included implementations of the host-key-encrypted untrusted-edge
 * payload codec contract (ADR-051, SPK-BF002). The contract itself —
 * {@link PayloadCodec}, {@link PayloadCodecContext},
 * {@link PayloadDecryptResult}, `ErasedPayload`, `isErasedPayload` — is owned
 * by `@tuvren/core/lifecycle`; this module ships the identity (plaintext
 * passthrough) codec and the AES-256-GCM envelope codec a host can plug in
 * without writing its own. A host may instead implement {@link PayloadCodec}
 * directly over a KMS/HSM. The runtime never persists, derives, escrows, or
 * caches keys — key bytes live only transiently inside a codec call.
 *
 * The default codec is built on the Web Crypto API (`crypto.subtle`), a
 * platform-neutral standard available in Node, Bun, and browsers, so this
 * package stays free of any host-runtime dependency.
 */

import {
  ENVELOPE_MAGIC,
  isPayloadEnvelope,
  type PayloadCodec,
  type PayloadCodecContext,
  type PayloadDecryptResult,
} from "@tuvren/core/lifecycle";

// The behavior-free identity codec and the envelope discriminant now live on the
// `@tuvren/core` ABI tier (ADR-057, breaking the sdk⇄runtime cycle). The public
// `@tuvren/sdk` surface re-publishes the identity helpers straight from
// `@tuvren/core/lifecycle` in the package barrel (`src/index.ts`) rather than
// funnelling them through this implementation module, which keeps this file a
// real module (not a lint-flagged barrel) while leaving the host-facing surface
// unchanged.

// ── Keyring contract ─────────────────────────────────────────────────────────

/**
 * Host-owned key custody. Resolves an opaque `keyRef` to raw key bytes, or
 * `undefined` once the host has destroyed/rotated-away the key. Destroying a key
 * is exactly: make `resolve(keyRef)` return `undefined`. The host owns the
 * keyring lifecycle entirely (in-memory map, KMS/HSM callback, etc.).
 */
export interface PayloadKeyring {
  /**
   * Resolves an opaque key reference to raw key bytes.
   *
   * @param keyRef - The opaque reference recorded in the payload envelope (or
   *   chosen by `resolveKeyRef` on encrypt).
   * @returns The raw key bytes (32 bytes for the AES-256-GCM codec), or
   *   `undefined` when the key has been destroyed or rotated away —
   *   synchronously or as a promise.
   */
  resolve(
    keyRef: string
  ): Promise<Uint8Array | undefined> | Uint8Array | undefined;
}

// ── Envelope wire format ─────────────────────────────────────────────────────
//
// A self-describing AEAD envelope serialized as the durable blob. The 4-byte
// magic lets the runtime detect an envelope on read and pass non-envelope bytes
// through unchanged, so plaintext (identity codec) and ciphertext (real codec)
// can coexist during migration. CBOR-encoded kernel records never begin with
// this magic (a CBOR map/array major-type byte is 0x80–0xBF, never 0x54 'T'),
// so the discriminant cannot collide with a plaintext record.
//
//   [0..4)  magic        "TVE1" (0x54 0x56 0x45 0x31)
//   [4]     version      u8  (= 1)
//   [5]     algId        u8  (1 = AES-256-GCM)
//   [6..8)  keyRefLen    u16 LE
//   [8..]   keyRef       utf8 bytes
//   [.]     ivLen        u8
//   [.]     iv           bytes
//   [.]     ciphertext   remaining bytes (Web Crypto AES-GCM output: the GCM
//                        auth tag is appended to the ciphertext, so it is not a
//                        separate field)
//
// AAD is NOT stored: the decryptor reconstructs it from its own
// PayloadCodecContext, so a ciphertext moved to a different Scope/edge fails
// the GCM tag check.

// ENVELOPE_MAGIC and isPayloadEnvelope are imported from @tuvren/core/lifecycle
// (single source of truth for the discriminant); serialize/parse below consume it.
const ENVELOPE_VERSION = 1;
const ALG_AES_256_GCM = 1;
const AES_256_GCM_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BITS = 128;

interface ParsedEnvelope {
  algId: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  keyRef: string;
}

function serializeEnvelope(parts: {
  algId: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  keyRef: string;
}): Uint8Array {
  const keyRefBytes = new TextEncoder().encode(parts.keyRef);
  const total =
    ENVELOPE_MAGIC.length +
    2 + // version + algId
    2 + // keyRefLen
    keyRefBytes.length +
    1 + // ivLen
    parts.iv.length +
    parts.ciphertext.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  out.set(ENVELOPE_MAGIC, offset);
  offset += ENVELOPE_MAGIC.length;
  out[offset++] = ENVELOPE_VERSION;
  out[offset++] = parts.algId;
  view.setUint16(offset, keyRefBytes.length, true);
  offset += 2;
  out.set(keyRefBytes, offset);
  offset += keyRefBytes.length;
  out[offset++] = parts.iv.length;
  out.set(parts.iv, offset);
  offset += parts.iv.length;
  out.set(parts.ciphertext, offset);
  return out;
}

// version(1) + algId(1) + keyRefLen(2) — the fixed header that follows the magic.
const ENVELOPE_FIXED_HEADER_BYTES = 4;

function parseEnvelope(bytes: Uint8Array): ParsedEnvelope {
  if (!isPayloadEnvelope(bytes)) {
    throw new TypeError("payload envelope magic mismatch");
  }
  // `subarray` silently *clamps* an out-of-range slice instead of throwing, so a
  // truncated or over-claimed length field would yield a garbage `keyRef`/`iv`
  // rather than an error. On read that garbage keyRef fails to resolve and the
  // decrypt path would return `{ status: "erased" }` — making storage
  // corruption indistinguishable from a legitimate crypto-shredding event on a
  // compliance-critical surface. Bounds-check every length-prefixed field and
  // throw (a structural integrity error, never an erased read) so corruption can
  // never masquerade as erasure.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = ENVELOPE_MAGIC.length;
  if (bytes.length < offset + ENVELOPE_FIXED_HEADER_BYTES) {
    throw new TypeError("malformed payload envelope: truncated header");
  }
  const version = bytes[offset++];
  if (version !== ENVELOPE_VERSION) {
    throw new TypeError(`unsupported payload envelope version ${version}`);
  }
  const algId = bytes[offset++];
  const keyRefLen = view.getUint16(offset, true);
  offset += 2;
  if (offset + keyRefLen > bytes.length) {
    throw new TypeError(
      "malformed payload envelope: keyRef length out of range"
    );
  }
  const keyRef = new TextDecoder().decode(
    bytes.subarray(offset, offset + keyRefLen)
  );
  offset += keyRefLen;
  if (offset + 1 > bytes.length) {
    throw new TypeError("malformed payload envelope: missing iv length");
  }
  const ivLen = bytes[offset++];
  if (offset + ivLen > bytes.length) {
    throw new TypeError("malformed payload envelope: iv length out of range");
  }
  const iv = bytes.subarray(offset, offset + ivLen);
  offset += ivLen;
  const ciphertext = bytes.subarray(offset);
  return { algId, ciphertext, iv, keyRef };
}

const AAD_DOMAIN_PREFIX = new TextEncoder().encode("tuvren.payload.v1");

function buildAad(context: PayloadCodecContext): Uint8Array {
  // Bind the Scope and the payload-class (edge) tag into AAD, length-prefixed so
  // the encoding is an *injective* function of (scope, edge). A delimiter-joined
  // string is ambiguous: a host-supplied Scope is only validated as a non-empty
  // string, so a Scope containing the delimiter could forge the AAD of a
  // *different* (scope, edge) pair once more than one edge tag exists, silently
  // defeating cross-Scope replay protection on a security primitive.
  // Length-prefixing removes that ambiguity for free. AAD is reconstructed from
  // the read context, never read from the envelope, so a ciphertext moved to a
  // different Scope/edge fails the GCM tag check.
  const encoder = new TextEncoder();
  const scopeBytes = encoder.encode(context.scope);
  const edgeBytes = encoder.encode(context.edge);
  const out = new Uint8Array(
    AAD_DOMAIN_PREFIX.length + 4 + scopeBytes.length + 4 + edgeBytes.length
  );
  const view = new DataView(out.buffer);
  let offset = 0;
  out.set(AAD_DOMAIN_PREFIX, offset);
  offset += AAD_DOMAIN_PREFIX.length;
  view.setUint32(offset, scopeBytes.length, true);
  offset += 4;
  out.set(scopeBytes, offset);
  offset += scopeBytes.length;
  view.setUint32(offset, edgeBytes.length, true);
  offset += 4;
  out.set(edgeBytes, offset);
  return out;
}

// Web Crypto's BufferSource parameters require a concrete ArrayBuffer-backed
// view; the generic `Uint8Array<ArrayBufferLike>` (modern TS default, which may
// be SharedArrayBuffer-backed) does not satisfy that. Copy into a fresh
// ArrayBuffer so the crypto calls type-check and never alias caller memory.
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== AES_256_GCM_KEY_BYTES) {
    throw new TypeError(
      `AES-256-GCM key must be ${AES_256_GCM_KEY_BYTES} bytes, received ${key.length}`
    );
  }
  return await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    "AES-GCM",
    false,
    ["decrypt", "encrypt"]
  );
}

// ── AES-256-GCM codec ────────────────────────────────────────────────────────

/** Options for {@link createAesGcmPayloadCodec}. */
export interface AesGcmPayloadCodecOptions {
  /** Host-owned key custody resolving `keyRef → key bytes | undefined`. */
  keyring: PayloadKeyring;
  /**
   * Maps a codec context to the `keyRef` used for encryption. Defaults to the
   * per-Scope key (`context.scope`), which makes "destroy the Scope key" shred
   * all of that Scope's untrusted-edge payloads. Override to key per subject for
   * intra-Scope right-to-erasure.
   */
  resolveKeyRef?: (context: PayloadCodecContext) => string;
}

/**
 * Batteries-included AEAD codec (AES-256-GCM via the Web Crypto API). Consumes
 * host-supplied key bytes from the keyring; never stores or caches them. A fresh
 * 96-bit IV is generated per encryption — `(key, iv)` is never reused.
 *
 * - `encrypt` throws if the keyring cannot resolve a key (you cannot protect a
 *   payload without a key).
 * - `decrypt` returns `{ status: "erased" }` when the key is gone (shredded),
 *   and throws only on a present-key integrity failure (tampering / wrong key).
 *
 * @param options - The keyring (required) and an optional `resolveKeyRef`
 *   override; the default keys per Scope.
 * @returns A `PayloadCodec` with id `"aes-256-gcm"` suitable for
 *   `createTuvren`'s `payloadCodec` option.
 *
 * @example
 * ```ts
 * const keys = new Map<string, Uint8Array>();
 * const codec = createAesGcmPayloadCodec({
 *   keyring: { resolve: (keyRef) => keys.get(keyRef) },
 * });
 * // Crypto-shred a Scope by destroying its key:
 * keys.delete(scope);
 * ```
 */
export function createAesGcmPayloadCodec(
  options: AesGcmPayloadCodecOptions
): PayloadCodec {
  const { keyring } = options;
  const resolveKeyRef =
    options.resolveKeyRef ?? ((context: PayloadCodecContext) => context.scope);

  return {
    async decrypt(
      stored: Uint8Array,
      context: PayloadCodecContext
    ): Promise<PayloadDecryptResult> {
      const envelope = parseEnvelope(stored);
      if (envelope.algId !== ALG_AES_256_GCM) {
        throw new TypeError(
          `unsupported payload envelope algorithm ${envelope.algId}`
        );
      }
      if (envelope.iv.length !== GCM_IV_BYTES) {
        // A structurally well-formed envelope can still carry a wrong-size IV
        // under corruption; reject it as an integrity error (never an erased
        // read) instead of leaning on Web Crypto's generic rejection.
        throw new TypeError(
          `malformed payload envelope: iv must be ${GCM_IV_BYTES} bytes, received ${envelope.iv.length}`
        );
      }
      const key = await keyring.resolve(envelope.keyRef);
      if (key === undefined) {
        return {
          keyRef: envelope.keyRef,
          reason: "key_unavailable",
          status: "erased",
        };
      }
      const cryptoKey = await importAesKey(key);
      // Web Crypto throws (rejects) on an authentication failure — a present key
      // with a mismatched tag/AAD is an integrity error, not an erased read.
      const plaintext = await crypto.subtle.decrypt(
        {
          additionalData: toArrayBuffer(buildAad(context)),
          iv: toArrayBuffer(envelope.iv),
          name: "AES-GCM",
          tagLength: GCM_TAG_BITS,
        },
        cryptoKey,
        toArrayBuffer(envelope.ciphertext)
      );
      return { plaintext: new Uint8Array(plaintext), status: "available" };
    },
    async encrypt(
      plaintext: Uint8Array,
      context: PayloadCodecContext
    ): Promise<Uint8Array> {
      const keyRef = resolveKeyRef(context);
      const key = await keyring.resolve(keyRef);
      if (key === undefined) {
        throw new TypeError(
          `payload keyring cannot resolve keyRef "${keyRef}" for encryption`
        );
      }
      const cryptoKey = await importAesKey(key);
      const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
      const ciphertext = await crypto.subtle.encrypt(
        {
          additionalData: toArrayBuffer(buildAad(context)),
          iv: toArrayBuffer(iv),
          name: "AES-GCM",
          tagLength: GCM_TAG_BITS,
        },
        cryptoKey,
        toArrayBuffer(plaintext)
      );
      return serializeEnvelope({
        algId: ALG_AES_256_GCM,
        ciphertext: new Uint8Array(ciphertext),
        iv,
        keyRef,
      });
    },
    id: "aes-256-gcm",
  };
}
