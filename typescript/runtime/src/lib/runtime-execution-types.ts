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

import type { HashString } from "@tuvren/core";
import type { AgentConfig, InputSignal } from "@tuvren/core/execution";
import type { ToolResultPart } from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import type {
  ApprovalRequest,
  ApprovalResponse,
  ToolRegistry,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import type { ToolExecutionMode } from "./tool-execution.js";

export interface ExecutionSessionRequest {
  branchId: string;
  config: AgentConfig;
  driverId?: string;
  parentTurnId?: string | null;
  schemaId?: string;
  signal: InputSignal;
  threadId: string;
  tools?: TuvrenToolDefinition[];
}

export interface PausedIterationState {
  iterationCount: number;
  response: TuvrenModelResponse;
  toolExecutionMode: ToolExecutionMode;
  toolResults: ToolResultPart[];
}

export interface PauseContext {
  activeConfig: AgentConfig;
  activeDriverId: string;
  activeToolRegistry: ToolRegistry;
  approval: ApprovalRequest;
  carriedStateUpdates: ExtensionStateUpdate[];
  /** Preserved client endpoint boundary from the paused turn (KRT-AZ001). */
  clientEndpointBoundary?: import("@tuvren/core/capabilities").ClientEndpointBoundary;
  pausedIteration: PausedIterationState;
  pausedRunId: string;
  pausedTurnNodeHash: HashString;
  pauseReason: string;
}

export interface ResumeContext {
  approval: ApprovalResponse;
  pauseContext: PauseContext;
  pausedRunId: string;
  pausedTurnNodeHash: HashString;
}
