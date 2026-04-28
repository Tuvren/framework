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
import type { HashString } from "@tuvren/core-types";
import type { TuvrenStreamEvent } from "@tuvren/event-stream";
import type {
  AgentConfig,
  ApprovalResponse,
  ExecutionHandle,
  ExecutionStatus,
  InputSignal,
  TuvrenRuntime,
} from "@tuvren/runtime-api";
import type { TuvrenSseFrame } from "@tuvren/stream-sse";

export type PlaygroundBackendMode = "memory" | "sqlite";
export type PlaygroundProviderMode = "fixture" | "ai-sdk-mock";
export type PlaygroundScenarioName =
  | "approval"
  | "branching"
  | "cancel"
  | "metadata"
  | "reload"
  | "steering"
  | "streaming"
  | "structured"
  | "tools";

export interface PlaygroundConfig {
  backend: PlaygroundBackendMode;
  providerMode: PlaygroundProviderMode;
  scenario: PlaygroundScenarioName;
  sqlitePath?: string;
}

export interface PlaygroundTurnInput {
  branchId: string;
  config?: AgentConfig;
  signal: InputSignal;
  threadId: string;
}

export interface PlaygroundThreadSummary {
  branchId: string;
  headTurnNodeHash?: HashString;
  rootTurnNodeHash: HashString;
  rootTurnTreeHash: HashString;
  threadId: string;
}

export interface PlaygroundStreamProjection {
  agui: AGUIEvent[];
  canonical: TuvrenStreamEvent[];
  sse: TuvrenSseFrame[];
}

export interface PlaygroundScenarioReport {
  backend: PlaygroundBackendMode;
  checks: Record<string, boolean | number | string>;
  events: {
    aguiTypes: string[];
    canonicalTypes: string[];
    sseEvents: string[];
  };
  providerMode: PlaygroundProviderMode;
  scenario: PlaygroundScenarioName;
  status: ExecutionStatus;
  thread: PlaygroundThreadSummary;
}

export interface PlaygroundHost {
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
  config: PlaygroundConfig;
  createThread(): Promise<PlaygroundThreadSummary>;
  executeTurn(input: PlaygroundTurnInput): ExecutionHandle;
  project(handle: ExecutionHandle): Promise<PlaygroundStreamProjection>;
  readBranchMessages(branchId: string): Promise<unknown[]>;
  readBranchStatus(branchId: string): Promise<unknown | null>;
  runtime: TuvrenRuntime;
  steer(handle: ExecutionHandle, signal: InputSignal): void;
}
