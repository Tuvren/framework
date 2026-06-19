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

import type { AGUIEvent } from "@ag-ui/core";
import type {
  AgentConfig,
  ApprovalResponse,
  ExecutionHandle,
  ExecutionStatus,
  HashString,
  InputSignal,
  TuvrenProvider,
  TuvrenRuntime,
  TuvrenRuntimeTelemetryAttributeKey,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
} from "@tuvren/runtime";
import type { TuvrenSseFrame } from "@tuvren/stream-sse";

export type ReplBackendMode = "memory" | "postgres" | "sqlite";
export type ReplKernelMode = "rust-grpc" | "typescript-local";
export type ReplProviderMode =
  | "aimock-anthropic"
  | "aimock-google"
  | "aimock-openai"
  | "ai-sdk-google"
  | "ai-sdk-mock"
  | "fixture";
export type ReplScenarioName =
  | "approval"
  | "branching"
  | "cancel"
  | "extension"
  | "metadata"
  | "orchestration"
  | "reload"
  | "steering"
  | "streaming"
  | "structured"
  | "tools";

export interface ReplConfig {
  aimockBaseUrl?: string;
  backend: ReplBackendMode;
  googleApiKey?: string;
  kernelGrpcBaseUrl?: string;
  kernelMode?: ReplKernelMode;
  modelId?: string;
  postgresDatabase?: string;
  postgresSchemaName?: string;
  providerMode: ReplProviderMode;
  scenario: ReplScenarioName;
  /**
   * Host-bound tenancy partition identity (ADR-048, KRT-BE008). When set, the
   * host constructs both the durable backend and the runtime against this Scope,
   * so durable state is isolated and operational telemetry plus the recorded
   * transcript are correlated to it. Defaults to the single-tenant default Scope.
   */
  scope?: string;
  sqlitePath?: string;
  systemPrompt?: string;
}

export interface ReplTurnInput {
  branchId: string;
  config?: AgentConfig;
  signal: InputSignal;
  threadId: string;
}

export interface ReplThreadSummary {
  branchId: string;
  headTurnNodeHash?: HashString;
  rootTurnNodeHash: HashString;
  rootTurnTreeHash: HashString;
  threadId: string;
}

export interface ReplStreamProjection {
  agui: AGUIEvent[];
  canonical: TuvrenStreamEvent[];
  sse: TuvrenSseFrame[];
}

export interface ReplTelemetryEvidence {
  attributes: Record<string, string | string[] | null>;
  observedKeys: TuvrenRuntimeTelemetryAttributeKey[];
  schemaUrl: string;
}

export interface ReplScenarioReport {
  backend: ReplBackendMode;
  checks: Record<string, boolean>;
  error?: {
    code?: string;
    message: string;
  };
  events: {
    aguiTypes: string[];
    canonicalTypes: string[];
    sseEvents: string[];
  };
  kernelMode: ReplKernelMode;
  providerMode: ReplProviderMode;
  scenario: ReplScenarioName;
  status: ExecutionStatus;
  telemetry: ReplTelemetryEvidence;
  thread: ReplThreadSummary;
}

export interface ReplScenarioMatrixReport {
  backend: ReplBackendMode;
  kernelMode: ReplKernelMode;
  modelId?: string;
  providerMode: ReplProviderMode;
  reports: ReplScenarioReport[];
  scenarios: ReplScenarioName[];
  summary: {
    allChecksPassed: boolean;
    failedScenarioCount: number;
    failedScenarios: ReplScenarioName[];
    passedScenarioCount: number;
  };
}

export interface ReplHost {
  approve(handle: ExecutionHandle, response: ApprovalResponse): ExecutionHandle;
  branchFromHead(input: {
    branchId?: string;
    threadId: string;
    turnNodeHash: HashString;
  }): Promise<{
    branchId: string;
    headTurnNodeHash: HashString;
    threadId: string;
  }>;
  cancel(handle: ExecutionHandle): void;
  config: ReplConfig;
  createThread(): Promise<ReplThreadSummary>;
  dispose?(): Promise<void>;
  executeTurn(input: ReplTurnInput): ExecutionHandle;
  project(handle: ExecutionHandle): Promise<ReplStreamProjection>;
  provider: TuvrenProvider;
  readBranchMessages(branchId: string): Promise<unknown[]>;
  runtime: TuvrenRuntime;
  steer(handle: ExecutionHandle, signal: InputSignal): void;
}

export interface ReplScenarioExecutionPlan {
  config?: Omit<AgentConfig, "name">;
  model?: TuvrenProvider;
  signal: InputSignal;
  tools?: TuvrenToolDefinition[];
}
