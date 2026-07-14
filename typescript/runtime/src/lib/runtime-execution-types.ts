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

/**
 * Input for starting one turn-execution session: the thread/branch
 * coordinates the turn commits against, the active {@link AgentConfig}, and
 * the incorporated {@link InputSignal}. `runnerId`, `schemaId`, and `tools`
 * override the runtime's registered defaults when present; `parentTurnId`
 * names the preceding semantic turn per `turn.create`'s legality rules
 * (KrakenKernelSpecification §5.3).
 */
export interface ExecutionSessionRequest {
  branchId: string;
  config: AgentConfig;
  parentTurnId?: string | null;
  runnerId?: string;
  schemaId?: string;
  signal: InputSignal;
  threadId: string;
  tools?: TuvrenToolDefinition[];
}

/**
 * Snapshot of the iteration in flight when an approval pause interrupts the
 * loop: the model response that requested the tools, the tool results
 * gathered before the pause, and the {@link ToolExecutionMode} to resume
 * under (KrakenFrameworkSpecification §8).
 */
export interface PausedIterationState {
  iterationCount: number;
  response: TuvrenModelResponse;
  toolExecutionMode: ToolExecutionMode;
  toolResults: ToolResultPart[];
}

/**
 * Everything the runtime persists at an approval pause so the turn can
 * resume later in a fresh process: the pending {@link ApprovalRequest}, the
 * active config/runner/tool-registry, extension state updates carried across
 * the pause, and the paused run/turn-node coordinates
 * (KrakenFrameworkSpecification §4, approval resume).
 */
export interface PauseContext {
  activeConfig: AgentConfig;
  activeRunnerId: string;
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

/**
 * Pairs the host's {@link ApprovalResponse} with the stored
 * {@link PauseContext} to continue a paused turn. Resume continues the
 * existing semantic turn: `beforeTurn`/`afterTurn` hooks are not re-fired
 * (KrakenFrameworkSpecification §4).
 */
export interface ResumeContext {
  approval: ApprovalResponse;
  pauseContext: PauseContext;
  pausedRunId: string;
  pausedTurnNodeHash: HashString;
}
