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

// biome-ignore-all lint/performance/noBarrelFile: This package root is the intentional SDK surface.
// @tuvren/sdk — the TypeScript libc/SDK tier: executable developer helpers
// extracted from the behavior-free @tuvren/core ABI package (GH issue #87 M2).
// Depends only on @tuvren/core; everything here is convenience implementation,
// never contract authority.

// Payload-codec implementations (contract lives in @tuvren/core/lifecycle).
export {
  type AesGcmPayloadCodecOptions,
  createAesGcmPayloadCodec,
  createIdentityPayloadCodec,
  IDENTITY_PAYLOAD_CODEC,
  isPayloadEnvelope,
  type PayloadKeyring,
} from "./lib/payload-codec.js";
// Schema-authoring helpers (tool contracts live in @tuvren/core/tools).
export {
  asSchema,
  defineTool,
  type FlexibleSchema,
  jsonSchema,
  type LazySchema,
  type Schema,
  type StandardSchema,
  schemaSymbol,
  standardSchema,
  type ZodSchema,
  zodSchema,
} from "./lib/schema-authoring.js";
