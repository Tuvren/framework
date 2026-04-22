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

import type {
  AgentConfig,
  ApprovalRequest,
  ApprovalResponse,
  InputSignal,
  KrakenModelResponse,
  KrakenToolDefinition,
  ToolRegistry,
  ToolResultPart,
} from "@kraken/framework-runtime-api";
import type { HashString } from "@kraken/shared-core-types";
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
  tools?: KrakenToolDefinition[];
}

export interface PausedIterationState {
  iterationCount: number;
  response: KrakenModelResponse;
  toolExecutionMode: ToolExecutionMode;
  toolResults: ToolResultPart[];
}

export interface PauseContext {
  activeConfig: AgentConfig;
  activeDriverId: string;
  activeToolRegistry: ToolRegistry;
  approval: ApprovalRequest;
  carriedStateUpdates: ExtensionStateUpdate[];
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
