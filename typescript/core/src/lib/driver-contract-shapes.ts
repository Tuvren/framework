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

import type { EpochMs, HashString } from "./kernel-records.js";
import type {
  AgentConfig,
  ApprovalResponse,
  ContextManifest,
  HandoffContextBuilder,
  HandoffContextMode,
  HandoffContextPlan,
  RuntimeResolution,
  ToolRegistry,
  TuvrenMessage,
  TuvrenStreamEvent,
} from "./runtime-contract-shapes.js";

export interface DriverRuntimePort {
  emit(event: TuvrenStreamEvent): Promise<void> | void;
  now(): EpochMs;
}

export interface DriverHandoffPort {
  createContextPlan(input: {
    builder?: HandoffContextBuilder;
    mode?: HandoffContextMode;
    payload?: unknown;
    reason: string;
    targetAgent: string;
  }): HandoffContextPlan;
}

export interface DriverExecutionContext {
  branchId: string;
  config: Readonly<AgentConfig>;
  handoff: DriverHandoffPort;
  iterationCount: number;
  manifest: Readonly<ContextManifest>;
  messages: readonly TuvrenMessage[];
  runtime: DriverRuntimePort;
  schemaId: string;
  signal?: AbortSignal;
  threadId: string;
  toolRegistry: Readonly<ToolRegistry>;
  turnId: string;
}

export interface DriverResumeContext extends DriverExecutionContext {
  approval: ApprovalResponse;
  resumedFrom?: HashString;
}

export type DriverToolExecutionMode = "parallel" | "sequential";

export type DriverAssistantEventReconciliation =
  "allow_final_sequence_divergence";

export interface DriverExtensionStateUpdate {
  extensionName: string;
  state: Record<string, unknown>;
}

export interface DriverExecutionResult {
  assistantEventReconciliation?: DriverAssistantEventReconciliation;
  messages?: TuvrenMessage[];
  partial?: boolean;
  resolution: RuntimeResolution;
  stateUpdates?: DriverExtensionStateUpdate[];
  toolExecutionMode?: DriverToolExecutionMode;
}

export interface RuntimeDriver {
  execute(context: DriverExecutionContext): Promise<DriverExecutionResult>;
  readonly id: string;
  resume?(context: DriverResumeContext): Promise<DriverExecutionResult>;
}

export interface RuntimeDriverFactory {
  create(): RuntimeDriver;
  readonly id: string;
}

export interface DriverRegistry {
  list(): Array<RuntimeDriver | RuntimeDriverFactory>;
  register(driver: RuntimeDriver | RuntimeDriverFactory): void;
  resolve(driverId: string): RuntimeDriver | RuntimeDriverFactory | undefined;
}
