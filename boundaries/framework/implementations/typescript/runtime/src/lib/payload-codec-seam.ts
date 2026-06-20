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
 * The single shared crypto-shredding seam (ADR-051, SPK-BF002 / KRT-BF005).
 *
 * Untrusted-edge results (provider, tool, MCP, and client-endpoint outputs) all
 * materialize as durable `TuvrenMessage` records. This helper wraps the host
 * `PayloadCodec` so that every message blob is encrypted immediately before it
 * reaches `kernel.store.put` / `kernel.staging.stage`, and decrypted at the
 * durable-read materialization path — in exactly one auditable place rather than
 * scattered across the four producing edges. Structural records (context
 * manifests, turn lineage, runtime status, canonical events) are not message
 * content and are never routed through this seam, so they stay plaintext and the
 * kernel can still walk lineage after a payload is shredded.
 *
 * Because the kernel hashes the ciphertext envelope it receives, destroying the
 * key leaves every object hash, TurnNode, eventHash, and branch structure
 * byte-identical while rendering the plaintext unrecoverable.
 */

import type { Scope } from "@tuvren/core";
import {
  isPayloadEnvelope,
  type PayloadCodec,
  type PayloadDecryptResult,
} from "@tuvren/core/lifecycle";

/**
 * The stable AAD/record-kind tag bound into every message envelope. The four
 * conceptual producing edges collapse to this single tag because they all
 * persist as durable messages, and it must be identical on the write and read
 * seams so AEAD verification succeeds.
 */
export const MESSAGE_PAYLOAD_EDGE = "message";

/**
 * The runtime-resolved codec plus the Scope it is bound to. Threaded to each
 * message write/read seam so encryption is symmetric and Scope-bound.
 */
export interface PayloadCodecBinding {
  codec: PayloadCodec;
  scope: Scope;
}

/**
 * Encrypt an already-encoded message record before it is stored. With the
 * default identity codec this returns the bytes unchanged (no envelope), so
 * no-codec hosts persist plaintext exactly as before BF005.
 */
export async function encryptMessageRecord(
  binding: PayloadCodecBinding,
  record: Uint8Array
): Promise<Uint8Array> {
  return await binding.codec.encrypt(record, {
    edge: MESSAGE_PAYLOAD_EDGE,
    scope: binding.scope,
  });
}

/**
 * Decrypt a stored message blob at a read seam. Bytes that are not a payload
 * envelope are returned verbatim as `available` — this keeps the default
 * identity codec a pure passthrough and lets a real codec read pre-BF005
 * plaintext (migration) without tripping over the envelope parser. A genuine
 * envelope whose key the host has destroyed yields a typed `erased` result.
 */
export async function decryptStoredMessage(
  binding: PayloadCodecBinding,
  stored: Uint8Array
): Promise<PayloadDecryptResult> {
  if (!isPayloadEnvelope(stored)) {
    return { plaintext: stored, status: "available" };
  }
  return await binding.codec.decrypt(stored, {
    edge: MESSAGE_PAYLOAD_EDGE,
    scope: binding.scope,
  });
}
