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

// biome-ignore-all lint/performance/noBarrelFile: This package subpath is the intentional focused contract surface.

/**
 * `@tuvren/core/lifecycle` — data-lifecycle: the crypto-shredding payload
 * codec contract (ADR-051, SPK-BF002 / KRT-BF005). The behavior-free
 * identity codec and the envelope discriminant the runtime read seam
 * depends on live here on the ABI tier (ADR-057, so the runtime never
 * imports `@tuvren/sdk`); the batteries-included AES-256-GCM codec
 * implementation lives in `@tuvren/sdk`.
 *
 * @packageDocumentation
 */

export {
  createIdentityPayloadCodec,
  ENVELOPE_MAGIC,
  type ErasedPayload,
  IDENTITY_PAYLOAD_CODEC,
  isErasedPayload,
  isPayloadEnvelope,
  type PayloadCodec,
  type PayloadCodecContext,
  type PayloadDecryptResult,
} from "../lib/payload-codec.js";
