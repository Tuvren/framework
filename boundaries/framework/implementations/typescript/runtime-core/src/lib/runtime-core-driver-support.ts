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

import {
  assertDriverExecutionResult,
  type DriverExecutionContext,
  type RuntimeDriver as KrakenDriver,
} from "@tuvren/driver-api";
import type {
  ContextManifest,
  HandoffContextBuilder,
  HandoffContextPlan,
  RuntimeResolution,
} from "@tuvren/runtime-api";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import { formatToolResultTaskId } from "./runtime-core-response.js";
import { normalizeError } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { ToolBatchEnvironment } from "./tool-execution.js";

export interface RuntimeCoreDriverSupportHost {
  cloneAgentConfigForRequest(
    config: LoopState["activeConfig"]
  ): LoopState["activeConfig"];
  createContextEngineeringHelpers(
    messageHashes: HeadState["messageHashes"],
    messages: HeadState["messages"]
  ): {
    helpers: HandoffContextPlan["sourceContext"]["helpers"];
  };
  createFrozenSnapshot<T>(value: T): T;
  defaultMaxParallelToolCalls(): number;
  now(): number;
  publishCustomEvent(
    handle: RuntimeExecutionHandle,
    event: { data: unknown; name: string },
    loopState: LoopState
  ): void;
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: Parameters<RuntimeExecutionHandle["publish"]>[0],
    loopState: LoopState
  ): void;
  publishProjectedError(
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ): void;
  resolveActiveMaxParallelToolCalls(
    loopState: LoopState,
    defaultMaxParallelToolCalls: number
  ): number;
  resolveDefaultHandoffContextBuilder(mode: string): HandoffContextBuilder;
  resolveTargetAgent(targetAgent: string): LoopState["activeConfig"];
  stageToolResultMessage(
    runId: string,
    result: ToolBatchEnvironment["stageResult"] extends (
      result: infer TResult,
      orderIndex: number
    ) => Promise<unknown>
      ? TResult
      : never,
    orderIndex: number
  ): Promise<string>;
}

export function createToolBatchEnvironment(
  host: RuntimeCoreDriverSupportHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  manifest: ContextManifest,
  iterationCount: number,
  runId: string
): ToolBatchEnvironment {
  return {
    activeAgent: loopState.activeConfig.name,
    branchId: handle.request.branchId,
    extensions: loopState.activeConfig.extensions ?? [],
    iterationCount,
    manifest,
    maxParallelToolCalls: host.resolveActiveMaxParallelToolCalls(
      loopState,
      host.defaultMaxParallelToolCalls()
    ),
    now: () => host.now(),
    publishCustom: (event) => {
      host.publishCustomEvent(handle, event, loopState);
    },
    publishEvent: (event) => {
      host.publishEvent(handle, event, loopState);
    },
    reportSoftError: (error) => {
      host.publishProjectedError(handle, error, false, loopState);
    },
    runId,
    signal: handle.abortSignal,
    stageResult: async (result, orderIndex) => {
      return await host.stageToolResultMessage(runId, result, orderIndex);
    },
    threadId: handle.request.threadId,
    toolRegistry: loopState.activeToolRegistry,
    turnId: handle.turnId,
  };
}

export function createDriverHandoffContextPlan(
  host: RuntimeCoreDriverSupportHost,
  input: {
    builder?: HandoffContextBuilder;
    mode?: string;
    payload?: unknown;
    reason: string;
    targetAgent: string;
  },
  headState: HeadState,
  loopState: LoopState
): HandoffContextPlan {
  const mode = input.mode ?? "preserve_trace";
  const builder =
    input.builder ?? host.resolveDefaultHandoffContextBuilder(mode);
  const helperBundle = host.createContextEngineeringHelpers(
    headState.messageHashes,
    headState.messages
  );
  const resolvedTargetAgent = host.resolveTargetAgent(input.targetAgent);

  return {
    builder,
    mode,
    reason: input.reason,
    sourceContext: {
      handoffIntent: {
        payload: structuredClone(input.payload),
        reason: input.reason,
        targetAgent: input.targetAgent,
      },
      helpers: helperBundle.helpers,
      manifest: structuredClone(headState.manifest),
      messages: structuredClone(headState.messages),
      sourceAgent: host.createFrozenSnapshot(
        host.cloneAgentConfigForRequest(loopState.activeConfig)
      ),
      targetAgent: host.createFrozenSnapshot(
        host.cloneAgentConfigForRequest(resolvedTargetAgent)
      ),
    },
    targetAgent: input.targetAgent,
  } satisfies HandoffContextPlan;
}

export async function executeDriver(
  driver: KrakenDriver,
  context: DriverExecutionContext
): Promise<
  | Awaited<ReturnType<KrakenDriver["execute"]>>
  | { resolution: RuntimeResolution }
> {
  try {
    const result = await driver.execute(context);
    assertDriverExecutionResult(result, "driverResult");
    return result;
  } catch (error: unknown) {
    return {
      resolution: {
        error: normalizeError(error),
        fatality: "hard",
        type: "fail",
      } satisfies RuntimeResolution,
    };
  }
}

export function formatToolResultTask(
  orderIndex: number,
  callId: string
): string {
  return formatToolResultTaskId(orderIndex, callId);
}
