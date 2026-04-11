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

// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public contract surface.
// This package is intentionally a focused import home over the shared runtime
// contract family. `@kraken/framework-runtime-api` remains the semantic anchor,
// while tool and approval consumers depend on this narrower surface.
export type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResponse,
  AroundToolContext,
  AroundToolHandler,
  AroundToolResult,
  AroundToolSpec,
  CustomSchema,
  ExecuteFunction,
  KrakenJsonSchema,
  KrakenToolDefinition,
  KrakenToolResultBatch,
  PendingToolCall,
  RenderedToolDefinition,
  ToolCallPart,
  ToolDispatchContext,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
  ToolResultPart,
  ValidationErrorPayload,
  ValidationResult,
} from "@kraken/framework-runtime-api";
export {
  assertApprovalRequest,
  assertApprovalResponse,
  assertApprovalResponseForRequest,
  assertKrakenToolDefinition,
  isApprovalRequest,
  isApprovalResponse,
  isApprovalResponseForRequest,
  isKrakenToolDefinition,
} from "@kraken/framework-runtime-api";
