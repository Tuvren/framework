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
 * `@tuvren/core/messages` — the message contract surface
 * (KrakenFrameworkSpecification §1.1–1.2): `TuvrenMessage` and its content
 * part types, the JSON value/schema primitives, model config/prompt/
 * response types, and the message and model-response guards.
 *
 * @packageDocumentation
 */

export {
  assertTuvrenMessage,
  assertTuvrenModelResponse,
  isTuvrenMessage,
  isTuvrenModelResponse,
} from "../lib/runtime-contract-guards.js";
export type {
  ApprovalDecisionType,
  ContentPart,
  FilePart,
  ReasoningPart,
  StructuredPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  TuvrenJsonSchema,
  TuvrenJsonValue,
  TuvrenMessage,
  TuvrenModelConfig,
  TuvrenModelResponse,
  TuvrenPrompt,
} from "../lib/runtime-contract-shapes.js";
