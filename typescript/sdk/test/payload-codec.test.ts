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

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { PayloadCodecContext } from "@tuvren/core/lifecycle";
import {
  createIdentityPayloadCodec,
  IDENTITY_PAYLOAD_CODEC,
  isPayloadEnvelope,
} from "@tuvren/core/lifecycle";
import {
  createAesGcmPayloadCodec,
  type PayloadKeyring,
} from "../src/lib/payload-codec.js";

const SCOPE = "tenant.acme";
const CONTEXT: PayloadCodecContext = { edge: "message", scope: SCOPE };
const CANNOT_RESOLVE_KEYREF = /cannot resolve keyRef/;
const TRUNCATED_HEADER = /truncated header/;
const KEYREF_LEN_OUT_OF_RANGE = /keyRef length out of range/;
const IV_LEN_OUT_OF_RANGE = /iv length out of range/;

/** In-memory keyring whose entries the host can destroy to simulate erasure. */
function createDestroyableKeyring(initial?: Record<string, Uint8Array>): {
  destroy(keyRef: string): void;
  keyring: PayloadKeyring;
} {
  const keys = new Map<string, Uint8Array>(Object.entries(initial ?? {}));
  return {
    destroy(keyRef) {
      keys.delete(keyRef);
    },
    keyring: {
      resolve(keyRef) {
        return keys.get(keyRef);
      },
    },
  };
}

const PLAINTEXT = new TextEncoder().encode(
  JSON.stringify({ role: "tool", secret: "social-security-number" })
);

describe("identity payload codec", () => {
  test("passes plaintext through unchanged on encrypt and decrypt", async () => {
    const codec = createIdentityPayloadCodec();
    expect(codec).toBe(IDENTITY_PAYLOAD_CODEC);

    const stored = await codec.encrypt(PLAINTEXT, CONTEXT);
    // No envelope: the bytes stored are byte-identical to the plaintext.
    expect(stored).toEqual(PLAINTEXT);
    expect(isPayloadEnvelope(stored)).toBe(false);

    const result = await codec.decrypt(stored, CONTEXT);
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.plaintext).toEqual(PLAINTEXT);
    }
  });
});

describe("AES-256-GCM payload codec", () => {
  test("encrypts to a self-describing envelope that hides the plaintext", async () => {
    const { keyring } = createDestroyableKeyring({
      [SCOPE]: new Uint8Array(randomBytes(32)),
    });
    const codec = createAesGcmPayloadCodec({ keyring });

    const stored = await codec.encrypt(PLAINTEXT, CONTEXT);

    expect(codec.id).toBe("aes-256-gcm");
    expect(isPayloadEnvelope(stored)).toBe(true);
    // The plaintext (and the secret substring) must not appear in the blob.
    expect(Buffer.from(stored).includes(Buffer.from(PLAINTEXT))).toBe(false);
    expect(Buffer.from(stored).toString("utf8")).not.toContain(
      "social-security-number"
    );
  });

  test("round-trips ciphertext back to the exact plaintext", async () => {
    const { keyring } = createDestroyableKeyring({
      [SCOPE]: new Uint8Array(randomBytes(32)),
    });
    const codec = createAesGcmPayloadCodec({ keyring });

    const stored = await codec.encrypt(PLAINTEXT, CONTEXT);
    const result = await codec.decrypt(stored, CONTEXT);

    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.plaintext).toEqual(PLAINTEXT);
    }
  });

  test("uses a fresh IV per encryption (no (key, iv) reuse)", async () => {
    const { keyring } = createDestroyableKeyring({
      [SCOPE]: new Uint8Array(randomBytes(32)),
    });
    const codec = createAesGcmPayloadCodec({ keyring });

    const first = await codec.encrypt(PLAINTEXT, CONTEXT);
    const second = await codec.encrypt(PLAINTEXT, CONTEXT);
    // Same plaintext + key but distinct ciphertext (distinct IV/tag).
    expect(first).not.toEqual(second);
  });

  test("returns a typed erased result when the host has destroyed the key", async () => {
    const { destroy, keyring } = createDestroyableKeyring({
      [SCOPE]: new Uint8Array(randomBytes(32)),
    });
    const codec = createAesGcmPayloadCodec({ keyring });

    const stored = await codec.encrypt(PLAINTEXT, CONTEXT);
    // Crypto-shred: destroy the key. The ciphertext envelope stays intact.
    destroy(SCOPE);

    const result = await codec.decrypt(stored, CONTEXT);
    expect(result.status).toBe("erased");
    if (result.status === "erased") {
      expect(result.keyRef).toBe(SCOPE);
      expect(result.reason).toBe("key_unavailable");
    }
  });

  test("rejects a ciphertext replayed under a different Scope (AAD binding)", async () => {
    const otherScope = "tenant.globex";
    const { keyring } = createDestroyableKeyring({
      [SCOPE]: new Uint8Array(randomBytes(32)),
      [otherScope]: new Uint8Array(randomBytes(32)),
    });
    const codec = createAesGcmPayloadCodec({ keyring });

    const stored = await codec.encrypt(PLAINTEXT, CONTEXT);
    // Decrypt under a different Scope context: AAD differs → GCM tag mismatch.
    // (keyRef in the envelope still points at SCOPE, so a key is present and the
    // failure is an integrity error rather than an erased read.)
    await expect(
      codec.decrypt(stored, { edge: "message", scope: otherScope })
    ).rejects.toThrow();
  });

  test("cannot encrypt without a resolvable key", async () => {
    const { keyring } = createDestroyableKeyring();
    const codec = createAesGcmPayloadCodec({ keyring });

    await expect(codec.encrypt(PLAINTEXT, CONTEXT)).rejects.toThrow(
      CANNOT_RESOLVE_KEYREF
    );
  });

  test("supports per-subject keyRef resolution", async () => {
    const subjectKeyRef = "subject.42";
    const { destroy, keyring } = createDestroyableKeyring({
      [subjectKeyRef]: new Uint8Array(randomBytes(32)),
    });
    const codec = createAesGcmPayloadCodec({
      keyring,
      resolveKeyRef: () => subjectKeyRef,
    });

    const stored = await codec.encrypt(PLAINTEXT, CONTEXT);
    expect((await codec.decrypt(stored, CONTEXT)).status).toBe("available");

    destroy(subjectKeyRef);
    expect((await codec.decrypt(stored, CONTEXT)).status).toBe("erased");
  });

  test("rejects a tampered ciphertext under a present key (integrity error, not erased)", async () => {
    const { keyring } = createDestroyableKeyring({
      [SCOPE]: new Uint8Array(randomBytes(32)),
    });
    const codec = createAesGcmPayloadCodec({ keyring });

    const stored = await codec.encrypt(PLAINTEXT, CONTEXT);
    // Flip a byte inside the GCM-protected ciphertext/tag region. The key is
    // present, so this is an integrity failure (throws), never an erased read.
    const tampered = new Uint8Array(stored);
    const last = tampered.length - 1;
    // Flip to a guaranteed-different byte without a bitwise operator.
    tampered[last] = tampered[last] === 0xff ? 0x00 : 0xff;

    await expect(codec.decrypt(tampered, CONTEXT)).rejects.toThrow();
  });

  test("rejects a truncated-header envelope instead of treating it as erased", async () => {
    const { keyring } = createDestroyableKeyring();
    const codec = createAesGcmPayloadCodec({ keyring });
    // Valid magic but no version/algId/keyRefLen — a truncated header.
    const forged = Uint8Array.of(0x54, 0x56, 0x45, 0x31, 1);
    expect(isPayloadEnvelope(forged)).toBe(true);

    await expect(codec.decrypt(forged, CONTEXT)).rejects.toThrow(
      TRUNCATED_HEADER
    );
  });

  test("rejects an over-claimed keyRef length instead of masquerading as erased", async () => {
    const { keyring } = createDestroyableKeyring({
      [SCOPE]: new Uint8Array(randomBytes(32)),
    });
    const codec = createAesGcmPayloadCodec({ keyring });
    // keyRefLen = 255 (LE) but only one trailing byte follows. `subarray` would
    // silently clamp this to a garbage keyRef that fails to resolve and report a
    // false "erased"; the bounds check must throw instead.
    const forged = Uint8Array.of(
      0x54,
      0x56,
      0x45,
      0x31, // "TVE1"
      1, // version
      1, // algId = AES-256-GCM
      0xff, // keyRefLen low byte (255)
      0x00, // keyRefLen high byte
      0x61 // a single trailing byte, far short of 255
    );

    await expect(codec.decrypt(forged, CONTEXT)).rejects.toThrow(
      KEYREF_LEN_OUT_OF_RANGE
    );
  });

  test("rejects an iv length that overflows the blob", async () => {
    const { keyring } = createDestroyableKeyring({
      [SCOPE]: new Uint8Array(randomBytes(32)),
    });
    const codec = createAesGcmPayloadCodec({ keyring });
    // keyRefLen = 0, ivLen = 200, but no iv bytes follow.
    const forged = Uint8Array.of(
      0x54,
      0x56,
      0x45,
      0x31, // "TVE1"
      1, // version
      1, // algId
      0x00, // keyRefLen low
      0x00, // keyRefLen high (0 → empty keyRef)
      200 // ivLen claiming 200 bytes that do not exist
    );

    await expect(codec.decrypt(forged, CONTEXT)).rejects.toThrow(
      IV_LEN_OUT_OF_RANGE
    );
  });

  test("binds AAD injectively: delimiter-ambiguous (scope, edge) pairs do not cross-decrypt", async () => {
    // The collision only exists when the unit-separator (0x1f) appears *inside*
    // a field. Under the old "prefix<US>scope<US>edge" join these two contexts
    // produce byte-identical AAD (<US> = 0x1f):
    //   { scope: "x",      edge: "y<US>z" } -> prefix<US>x<US>y<US>z
    //   { scope: "x<US>y", edge: "z"      } -> prefix<US>x<US>y<US>z
    // so a ciphertext written for the first would decrypt under the second,
    // defeating the cross-binding guarantee. Pin one keyRef so the only
    // difference between encrypt and decrypt is the AAD (the stored keyRef
    // resolves on both sides).
    const keyRef = "shared-key";
    const { keyring } = createDestroyableKeyring({
      [keyRef]: new Uint8Array(randomBytes(32)),
    });
    const codec = createAesGcmPayloadCodec({
      keyring,
      resolveKeyRef: () => keyRef,
    });

    const stored = await codec.encrypt(PLAINTEXT, {
      edge: "y\u001fz",
      scope: "x",
    });
    // Length-prefixed AAD makes these distinct bindings (scopeLen 1 vs 3), so the
    // GCM tag check fails (present key -> integrity error, not erased). The old
    // delimiter join produced identical AAD and would have decrypted cleanly.
    await expect(
      codec.decrypt(stored, { edge: "z", scope: "x\u001fy" })
    ).rejects.toThrow();
  });
});
