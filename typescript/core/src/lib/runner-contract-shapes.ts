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

export interface RunnerRuntimePort {
  emit(event: TuvrenStreamEvent): Promise<void> | void;
  now(): EpochMs;
}

export interface RunnerHandoffPort {
  createContextPlan(input: {
    builder?: HandoffContextBuilder;
    mode?: HandoffContextMode;
    payload?: unknown;
    reason: string;
    targetAgent: string;
  }): HandoffContextPlan;
}

export interface RunnerExecutionContext {
  branchId: string;
  config: Readonly<AgentConfig>;
  handoff: RunnerHandoffPort;
  iterationCount: number;
  manifest: Readonly<ContextManifest>;
  messages: readonly TuvrenMessage[];
  runtime: RunnerRuntimePort;
  schemaId: string;
  signal?: AbortSignal;
  threadId: string;
  toolRegistry: Readonly<ToolRegistry>;
  turnId: string;
}

export interface RunnerResumeContext extends RunnerExecutionContext {
  approval: ApprovalResponse;
  resumedFrom?: HashString;
}

export type RunnerToolExecutionMode = "parallel" | "sequential";

export type RunnerAssistantEventReconciliation =
  "allow_final_sequence_divergence";

export interface RunnerExtensionStateUpdate {
  extensionName: string;
  state: Record<string, unknown>;
}

export interface RunnerExecutionResult {
  assistantEventReconciliation?: RunnerAssistantEventReconciliation;
  messages?: TuvrenMessage[];
  partial?: boolean;
  resolution: RuntimeResolution;
  stateUpdates?: RunnerExtensionStateUpdate[];
  toolExecutionMode?: RunnerToolExecutionMode;
}

export interface RuntimeRunner {
  execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult>;
  readonly id: string;
  resume?(context: RunnerResumeContext): Promise<RunnerExecutionResult>;
}

export interface RuntimeRunnerFactory {
  create(): RuntimeRunner;
  readonly id: string;
}

export interface RunnerRegistry {
  list(): Array<RuntimeRunner | RuntimeRunnerFactory>;
  register(driver: RuntimeRunner | RuntimeRunnerFactory): void;
  resolve(driverId: string): RuntimeRunner | RuntimeRunnerFactory | undefined;
}
