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
  type HashString,
  TuvrenLineageError,
  TuvrenRuntimeError,
} from "@tuvren/core";
import type {
  AgentConfig,
  ContextEngineeringHelpers,
  HandoffContextPlan,
  HandoffSourceContext,
} from "@tuvren/core/execution";
import type { RunnerRegistry, RuntimeRunner } from "@tuvren/core/runner";
import type { RuntimeKernel } from "@tuvren/kernel-protocol";
import type { PayloadCodecBinding } from "./payload-codec-seam.js";
import { materializeRunner } from "./runner-registry.js";
import {
  DEFAULT_AGENT_SCHEMA,
  DEFAULT_AGENT_SCHEMA_ID,
} from "./runtime-core.js";
import {
  materializeContextMessages as materializeRuntimeContextMessages,
  resolveHandoffSourceContext as resolveRuntimeHandoffSourceContext,
} from "./runtime-core-context.js";
import {
  createPendingKernelHash,
  encodeKernelRecord,
} from "./runtime-core-facade-utils.js";
import {
  loadHeadState as loadRuntimeHeadState,
  readRecoveredActiveAgentName as readRuntimeRecoveredActiveAgentName,
  readRecoveredRuntimeStatus as readRuntimeRecoveredRuntimeStatus,
  resolveExecutionSchemaId as resolveRuntimeExecutionSchemaId,
  resolveParentTurnId as resolveRuntimeParentTurnId,
} from "./runtime-core-head-state.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type { DurableRuntimeStatus } from "./runtime-core-recovery.js";
import { assertFrameworkSchemaCompatibility } from "./runtime-core-response.js";
import { createFrozenSnapshot } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { ExecutionSessionRequest } from "./runtime-execution-types.js";

/**
 * Extracts the quoted message hash from the error text thrown when a context
 * message hash cannot be materialized.
 */
const MISSING_CONTEXT_MESSAGE_HASH_PATTERN = /"(.+)"/;

/**
 * Capabilities the facade-ops functions borrow from the runtime core: the
 * kernel handle, agent-config cloning, and optional host-supplied resolution
 * hooks for agent configs and parent turn ids.
 */
export interface FacadeOpsDependencies {
  cloneAgentConfigForRequest(config: AgentConfig): AgentConfig;
  kernel: RuntimeKernel;
  resolveAgentConfig?(name: string): AgentConfig | undefined;
  resolveParentTurnIdOption?: (
    threadId: string,
    branchId: string
  ) => Promise<string | null> | string | null;
}

/**
 * Resolves the {@link HandoffSourceContext} an agent handoff exposes to the
 * target agent, binding kernel record encoding, pending-hash computation, and
 * frozen config snapshots into the underlying context resolution.
 */
export function resolveHandoffSourceContextFacade(
  dependencies: Pick<
    FacadeOpsDependencies,
    "cloneAgentConfigForRequest" | "kernel"
  >,
  plan: HandoffContextPlan,
  headState: HeadState,
  loopState: LoopState,
  targetConfig: AgentConfig,
  helpers: ContextEngineeringHelpers
): HandoffSourceContext {
  return resolveRuntimeHandoffSourceContext(
    {
      cloneAgentConfigForRequest: (config) =>
        dependencies.cloneAgentConfigForRequest(config),
      createFrozenAgentConfig: (config) => createFrozenSnapshot(config),
      createPendingKernelHash: (value) => createPendingKernelHash(value),
      encodeMessageRecord: (message) => encodeKernelRecord(message, "message"),
      putKernelRecord: async (record) =>
        await dependencies.kernel.store.put(record),
    },
    plan,
    headState,
    loopState,
    targetConfig,
    helpers
  );
}

/**
 * Materializes context messages from their hashes, converting any
 * materialization failure into a lineage error.
 *
 * @throws TuvrenLineageError with code `missing_message` when a hash cannot
 *   be materialized; the missing hash (extracted from the quoted segment of
 *   the original error message) is carried in `details.hash`.
 */
export function materializeContextMessagesFacade(
  hashes: HashString[],
  helpers: ContextEngineeringHelpers
) {
  try {
    return materializeRuntimeContextMessages(hashes, helpers);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "context message missing";
    const hash = message.match(MISSING_CONTEXT_MESSAGE_HASH_PATTERN)?.[1];

    throw new TuvrenLineageError(message, {
      code: "missing_message",
      details: {
        hash,
      },
    });
  }
}

/**
 * Loads the current {@link HeadState} (head turn tree, messages, manifest)
 * for a branch from the kernel, decoding payloads through the codec binding.
 */
export async function loadHeadStateFacade(
  kernel: RuntimeKernel,
  payloadCodecBinding: PayloadCodecBinding,
  branchId: string
): Promise<HeadState> {
  return await loadRuntimeHeadState(kernel, payloadCodecBinding, branchId);
}

/**
 * Reads the active agent name recorded in a checkpointed turn tree, used
 * when recovering an expired execution.
 *
 * @returns The recorded agent name, or `undefined` when the tree carries none.
 */
export async function readRecoveredActiveAgentNameFacade(
  kernel: RuntimeKernel,
  turnTreeHash: HashString
): Promise<string | undefined> {
  return await readRuntimeRecoveredActiveAgentName(kernel, turnTreeHash);
}

/**
 * Reads the durable runtime status recorded in a checkpointed turn tree,
 * used when recovering an expired execution.
 *
 * @returns The recorded {@link DurableRuntimeStatus}, or `undefined` when the
 *   tree carries none.
 */
export async function readRecoveredRuntimeStatusFacade(
  kernel: RuntimeKernel,
  turnTreeHash: HashString
): Promise<DurableRuntimeStatus | undefined> {
  return await readRuntimeRecoveredRuntimeStatus(kernel, turnTreeHash);
}

/**
 * Resolves the kernel schema id an execution session should run under,
 * ensuring the schema is registered via the provided `ensureSchemaId`
 * callback (see {@link ensureSchemaIdFacade}).
 */
export async function resolveExecutionSchemaIdFacade(
  kernel: RuntimeKernel,
  ensureSchemaId: (schemaId?: string) => Promise<string>,
  request: ExecutionSessionRequest
): Promise<string> {
  return await resolveRuntimeExecutionSchemaId(
    kernel,
    async (schemaId) => await ensureSchemaId(schemaId),
    request
  );
}

/**
 * Resolves the parent turn id for a new turn, honoring an explicit parent
 * turn id and the host-supplied `resolveParentTurnIdOption` hook before
 * falling back to kernel lineage.
 *
 * @returns The parent turn id, or `null` when the turn has no parent.
 */
export async function resolveParentTurnIdFacade(
  kernel: RuntimeKernel,
  resolveParentTurnIdOption: FacadeOpsDependencies["resolveParentTurnIdOption"],
  threadId: string,
  branchId: string,
  explicitParentTurnId?: string | null
): Promise<string | null> {
  return await resolveRuntimeParentTurnId(
    kernel,
    resolveParentTurnIdOption,
    threadId,
    branchId,
    explicitParentTurnId
  );
}

export async function advanceTurnAndBranchHeadFacade(
  kernel: RuntimeKernel,
  handle: RuntimeExecutionHandle,
  turnNodeHash: HashString
): Promise<void> {
  await kernel.turn.updateHead(handle.turnId, turnNodeHash);
  await kernel.branch.setHead(handle.request.branchId, turnNodeHash);
}

export function materializeRunnerFacade(
  runnerRegistry: RunnerRegistry,
  runnerId: string
): RuntimeRunner {
  const runnerEntry = runnerRegistry.resolve(runnerId);

  if (runnerEntry === undefined) {
    throw new TuvrenRuntimeError(`runner "${runnerId}" is not registered`, {
      code: "unknown_runner",
      details: {
        runnerId,
      },
    });
  }

  return materializeRunner(runnerEntry);
}

export function resolveFailureActiveConfigFacade(
  requestConfig: AgentConfig,
  activeAgentName: string,
  resolveAgentConfig: FacadeOpsDependencies["resolveAgentConfig"]
): AgentConfig {
  const resolvedActiveConfig = resolveAgentConfig?.(activeAgentName);

  if (resolvedActiveConfig !== undefined) {
    return resolvedActiveConfig;
  }

  if (activeAgentName === requestConfig.name) {
    return requestConfig;
  }

  return {
    name: activeAgentName,
  };
}

export async function ensureSchemaIdFacade(
  kernel: RuntimeKernel,
  schemaId?: string
): Promise<string> {
  const resolvedSchemaId = schemaId ?? DEFAULT_AGENT_SCHEMA_ID;
  const existing = await kernel.schema.get(resolvedSchemaId);

  if (existing !== null) {
    assertFrameworkSchemaCompatibility(existing);
    return existing.schemaId;
  }

  if (resolvedSchemaId !== DEFAULT_AGENT_SCHEMA_ID) {
    throw new TuvrenRuntimeError(
      `schema "${resolvedSchemaId}" is not registered`,
      {
        code: "unknown_schema",
        details: {
          schemaId: resolvedSchemaId,
        },
      }
    );
  }

  return await kernel.schema.register(DEFAULT_AGENT_SCHEMA);
}
