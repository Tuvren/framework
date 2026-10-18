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

/* oxlint-disable jsdoc/check-tag-names -- Preserve the standard TypeScript @packageDocumentation tag on this public entrypoint. */

/**
 * `@tuvren/core/tools` — the tool contract surface: `TuvrenToolDefinition`
 * (KrakenFrameworkSpecification §8.1), the approval request/response types
 * (§1.7), tool registry/dispatch/execution types, and their guards.
 *
 * @packageDocumentation
 */

/* oxlint-enable jsdoc/check-tag-names */

export {
  assertApprovalRequest,
  assertApprovalResponse,
  assertApprovalResponseForRequest,
  assertTuvrenToolDefinition,
  isApprovalRequest,
  isApprovalResponse,
  isApprovalResponseForRequest,
  isTuvrenToolDefinition,
} from "../lib/runtime-contract-guards.js";
export type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResponse,
} from "../lib/runtime-data-contract-shapes.js";
export type {
  ApprovalPolicy,
  AroundToolContext,
  AroundToolHandler,
  AroundToolResult,
  AroundToolSpec,
  CustomSchema,
  ExecuteFunction,
} from "../lib/runtime-contract-shapes.js";
export type {
  PendingToolCall,
  RenderedToolDefinition,
  ToolCallPart,
} from "../lib/runtime-data-contract-shapes.js";
export type {
  ToolDispatchContext,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "../lib/runtime-contract-shapes.js";
export type {
  ToolResultPart,
  TuvrenJsonSchema,
} from "../lib/runtime-data-contract-shapes.js";
export type { ValidationErrorPayload } from "../lib/runtime-event-contract-shapes.js";
export type {
  TuvrenToolDefinition,
  TuvrenToolResultBatch,
  ValidationResult,
} from "../lib/runtime-contract-shapes.js";
