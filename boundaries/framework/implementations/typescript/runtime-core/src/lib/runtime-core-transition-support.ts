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

import { type HashString, TuvrenRuntimeError } from "@tuvren/core-types";
import type { RuntimeKernel as KrakenKernel } from "@tuvren/kernel-protocol";
import type {
  AgentConfig,
  HandoffContextBuilder,
  RuntimeResolution,
  ToolRegistry,
  TuvrenMessage,
} from "@tuvren/runtime-api";
import {
  createLastOutputOnlyHandoffContextBuilder,
  createPreserveTraceHandoffContextBuilder,
} from "./handoff-builders.js";
import {
  createContextEngineeringHelpers as createRuntimeContextEngineeringHelpers,
  type HelperBundle,
} from "./runtime-core-context.js";
import type { RuntimeCoreContextOpsHost } from "./runtime-core-context-ops.js";
import { applyHandoff as applyRuntimeHandoffFacade } from "./runtime-core-context-ops.js";
import { loadHeadStateFacade } from "./runtime-core-facade-ops.js";
import {
  cloneAgentConfigForRequest,
  createPendingKernelHash,
  encodeKernelRecord,
} from "./runtime-core-facade-utils.js";
import type { LoopState } from "./runtime-core-loop.js";
import { createFrozenSnapshot } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

export function resolveRuntimeCoreDefaultHandoffContextBuilder(
  handoffContextBuilder: HandoffContextBuilder | undefined,
  mode: string
): HandoffContextBuilder {
  switch (mode) {
    case "last_output_only":
      return createLastOutputOnlyHandoffContextBuilder();
    case "preserve_trace":
      return (
        handoffContextBuilder ?? createPreserveTraceHandoffContextBuilder()
      );
    default:
      throw new TuvrenRuntimeError(
        `handoff mode "${mode}" requires an explicit builder`,
        {
          code: "invalid_handoff_mode",
          details: {
            mode,
          },
        }
      );
  }
}

export function createRuntimeCoreContextHelperBundle(
  kernel: KrakenKernel,
  messageHashes: HashString[],
  messages: TuvrenMessage[]
): HelperBundle {
  return createRuntimeContextEngineeringHelpers(
    {
      cloneAgentConfigForRequest: (config) =>
        cloneAgentConfigForRequest(config),
      createFrozenAgentConfig: (config) => createFrozenSnapshot(config),
      createPendingKernelHash: (value) => createPendingKernelHash(value),
      encodeMessageRecord: (message) => encodeKernelRecord(message, "message"),
      putKernelRecord: async (record) => await kernel.store.put(record),
    },
    messageHashes,
    messages
  );
}

export async function applyRuntimeCoreTerminalAgentTransitionIfNeeded(
  dependencies: {
    contextOps: RuntimeCoreContextOpsHost;
    kernel: KrakenKernel;
  },
  handle: RuntimeExecutionHandle,
  schemaId: string,
  resolution: RuntimeResolution,
  loopState: LoopState,
  stableHeadTurnNodeHash?: HashString
): Promise<boolean> {
  if (resolution.type !== "handoff") {
    return false;
  }

  let handoff:
    | {
        activeConfig: AgentConfig;
        activeToolRegistry: ToolRegistry;
      }
    | undefined;

  try {
    handoff = await applyRuntimeHandoffFacade(
      dependencies.contextOps,
      handle,
      schemaId,
      resolution.contextPlan,
      loopState,
      loopState.carriedStateUpdates
    );
  } catch (error: unknown) {
    if (stableHeadTurnNodeHash !== undefined) {
      await dependencies.kernel.branch.setHead(
        handle.request.branchId,
        stableHeadTurnNodeHash
      );
      const restoredHeadState = await loadHeadStateFacade(
        dependencies.kernel,
        handle.request.branchId
      );
      handle.updateStatus({
        activeAgent: loopState.activeConfig.name,
        manifest: restoredHeadState.manifest,
      });
    }

    throw error;
  }

  loopState.activeConfig = handoff.activeConfig;
  loopState.activeToolRegistry = handoff.activeToolRegistry;
  loopState.carriedStateUpdates = [];
  return true;
}
