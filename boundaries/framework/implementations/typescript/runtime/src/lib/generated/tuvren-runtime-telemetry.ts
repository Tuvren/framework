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

export interface TuvrenRuntimeTelemetryAttributeDefinition {
  readonly brief: string;
  readonly examples: readonly string[];
  readonly stability: string;
  readonly type: string;
}

export const TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL = "https://tuvren.dev/schemas/telemetry/0.1.0";

export const TUVREN_RUNTIME_TELEMETRY_ATTRIBUTES: Readonly<
  Record<string, TuvrenRuntimeTelemetryAttributeDefinition>
> = Object.freeze({
  "tuvren.runtime.backend.id": {
    brief: "The backend implementation identifier selected by the runtime.",
    examples: ["sqlite"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.branch.id": {
    brief: "The Tuvren runtime branch identifier.",
    examples: ["branch_main"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.capability.execution_class": {
    brief: "The execution class of the capability invocation per ADR-046 (tuvren-server, provider-native, provider-mediated, tuvren-client).",
    examples: ["tuvren-server","provider-native"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.capability.owner": {
    brief: "The owner dimension of the capability invocation (tuvren or provider). Added additively per ADR-046 AW006.",
    examples: ["tuvren","provider"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.checkpoint.hash": {
    brief: "The current checkpoint hash observed during runtime progression.",
    examples: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.driver.id": {
    brief: "The active driver identifier for the runtime execution.",
    examples: ["react"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.error.code": {
    brief: "The stable Tuvren runtime error code associated with a failed telemetry span.",
    examples: ["runtime_error"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.parent_checkpoint.hash": {
    brief: "The parent checkpoint hash that the current checkpoint extends from.",
    examples: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.provider.id": {
    brief: "The provider bridge or provider identifier used for model work.",
    examples: ["ai-sdk-openai"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.resumed_from.hash": {
    brief: "The checkpoint hash that a resumed execution continued from.",
    examples: ["cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.run.id": {
    brief: "The Tuvren runtime run identifier.",
    examples: ["run_main"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.thread.id": {
    brief: "The Tuvren runtime thread identifier.",
    examples: ["thread_main"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.tool_call.id": {
    brief: "The current tool call identifier when the execution is inside tool work.",
    examples: ["tool_call_1"],
    stability: "development",
    type: "string",
  },
  "tuvren.runtime.turn.id": {
    brief: "The Tuvren runtime turn identifier.",
    examples: ["turn_main"],
    stability: "development",
    type: "string",
  },
});

export type TuvrenRuntimeTelemetryAttributeKey =
  "tuvren.runtime.backend.id" |
  "tuvren.runtime.branch.id" |
  "tuvren.runtime.capability.execution_class" |
  "tuvren.runtime.capability.owner" |
  "tuvren.runtime.checkpoint.hash" |
  "tuvren.runtime.driver.id" |
  "tuvren.runtime.error.code" |
  "tuvren.runtime.parent_checkpoint.hash" |
  "tuvren.runtime.provider.id" |
  "tuvren.runtime.resumed_from.hash" |
  "tuvren.runtime.run.id" |
  "tuvren.runtime.thread.id" |
  "tuvren.runtime.tool_call.id" |
  "tuvren.runtime.turn.id";

export const TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS: readonly TuvrenRuntimeTelemetryAttributeKey[] =
  Object.freeze([
    "tuvren.runtime.backend.id",
    "tuvren.runtime.branch.id",
    "tuvren.runtime.capability.execution_class",
    "tuvren.runtime.capability.owner",
    "tuvren.runtime.checkpoint.hash",
    "tuvren.runtime.driver.id",
    "tuvren.runtime.error.code",
    "tuvren.runtime.parent_checkpoint.hash",
    "tuvren.runtime.provider.id",
    "tuvren.runtime.resumed_from.hash",
    "tuvren.runtime.run.id",
    "tuvren.runtime.thread.id",
    "tuvren.runtime.tool_call.id",
    "tuvren.runtime.turn.id",
  ]);
