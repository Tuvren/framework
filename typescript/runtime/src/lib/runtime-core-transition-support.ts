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

import { type HashString, TuvrenRuntimeError } from "@tuvren/core";
import type {
  AgentConfig,
  HandoffContextBuilder,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { ToolRegistry } from "@tuvren/core/tools";
import type { RuntimeKernel } from "@tuvren/kernel-protocol";
import {
  createLastOutputOnlyHandoffContextBuilder,
  createPreserveTraceHandoffContextBuilder,
} from "./handoff-builders.js";
import {
  encryptMessageRecord,
  type PayloadCodecBinding,
} from "./payload-codec-seam.js";
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

/**
 * Resolve the handoff context builder for a handoff mode.
 *
 * `last_output_only` always uses the built-in last-output-only builder (an
 * explicit builder is ignored); `preserve_trace` prefers the explicit
 * builder and falls back to the built-in preserve-trace builder.
 *
 * @throws TuvrenRuntimeError with code `invalid_handoff_mode` for any other
 *   mode, which requires an explicit builder resolved elsewhere.
 */
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

/**
 * Build the context-engineering helper bundle over the current message
 * window.
 *
 * Wires the kernel store and payload codec into the helpers: message
 * rewrites are encoded, encrypted through the crypto-shredding seam
 * (KRT-BF005), and stored via `kernel.store.put`, with provisional pending
 * hashes remapped to the canonical post-store hashes.
 *
 * @param messageHashes - Ordered hashes of the current head messages.
 * @param messages - The decoded messages matching `messageHashes`.
 */
export function createRuntimeCoreContextHelperBundle(
  kernel: RuntimeKernel,
  payloadCodecBinding: PayloadCodecBinding,
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
      // Crypto-shredding seam (KRT-BF005): encrypt context-engineering message
      // rewrites before storage, symmetric with staged messages. The provisional
      // hash is remapped to the canonical post-store hash, so a non-deterministic
      // ciphertext hash is absorbed by the helper's resolveHashes step.
      putKernelRecord: async (record) =>
        await kernel.store.put(
          await encryptMessageRecord(payloadCodecBinding, record)
        ),
    },
    messageHashes,
    messages
  );
}

/**
 * Apply a terminal `handoff` resolution by switching the active agent.
 *
 * Returns `false` without side effects for non-handoff resolutions. For a
 * handoff, the context plan is applied through the context-ops host; on
 * success the loop state's active config, tool registry, and client
 * endpoint boundary are replaced and carried state updates are cleared, and
 * the function returns `true` so the loop continues under the new agent.
 *
 * If applying the handoff throws and a stable head hash is provided, the
 * branch head is rolled back to `stableHeadTurnNodeHash` and the handle's
 * status manifest is restored from the rolled-back head before the error is
 * rethrown.
 *
 * @param stableHeadTurnNodeHash - Branch-head hash to restore on failure;
 *   when omitted, failures propagate without rollback.
 * @returns Whether a handoff transition was applied (loop should continue).
 */
export async function applyRuntimeCoreTerminalAgentTransitionIfNeeded(
  dependencies: {
    contextOps: RuntimeCoreContextOpsHost;
    kernel: RuntimeKernel;
    payloadCodecBinding: PayloadCodecBinding;
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
        clientEndpointBoundary:
          | import("@tuvren/core/capabilities").ClientEndpointBoundary
          | undefined;
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
        dependencies.payloadCodecBinding,
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
  loopState.clientEndpointBoundary = handoff.clientEndpointBoundary;
  loopState.carriedStateUpdates = [];
  return true;
}
