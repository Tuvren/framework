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
  DriverRegistry,
  RuntimeDriver as KrakenDriver,
} from "@tuvren/core/driver";
import type {
  AgentConfig,
  ContextEngineeringHelpers,
  HandoffContextPlan,
  HandoffSourceContext,
} from "@tuvren/core/execution";
import type { RuntimeKernel as KrakenKernel } from "@tuvren/kernel-protocol";
import { materializeDriver } from "./driver-registry.js";
import type { PayloadCodecBinding } from "./payload-codec-seam.js";
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

const MISSING_CONTEXT_MESSAGE_HASH_PATTERN = /"(.+)"/;

export interface FacadeOpsDependencies {
  cloneAgentConfigForRequest(config: AgentConfig): AgentConfig;
  kernel: KrakenKernel;
  resolveAgentConfig?(name: string): AgentConfig | undefined;
  resolveParentTurnIdOption?: (
    threadId: string,
    branchId: string
  ) => Promise<string | null> | string | null;
}

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

export async function loadHeadStateFacade(
  kernel: KrakenKernel,
  payloadCodecBinding: PayloadCodecBinding,
  branchId: string
): Promise<HeadState> {
  return await loadRuntimeHeadState(kernel, payloadCodecBinding, branchId);
}

export async function readRecoveredActiveAgentNameFacade(
  kernel: KrakenKernel,
  turnTreeHash: HashString
): Promise<string | undefined> {
  return await readRuntimeRecoveredActiveAgentName(kernel, turnTreeHash);
}

export async function readRecoveredRuntimeStatusFacade(
  kernel: KrakenKernel,
  turnTreeHash: HashString
): Promise<DurableRuntimeStatus | undefined> {
  return await readRuntimeRecoveredRuntimeStatus(kernel, turnTreeHash);
}

export async function resolveExecutionSchemaIdFacade(
  kernel: KrakenKernel,
  ensureSchemaId: (schemaId?: string) => Promise<string>,
  request: ExecutionSessionRequest
): Promise<string> {
  return await resolveRuntimeExecutionSchemaId(
    kernel,
    async (schemaId) => await ensureSchemaId(schemaId),
    request
  );
}

export async function resolveParentTurnIdFacade(
  kernel: KrakenKernel,
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
  kernel: KrakenKernel,
  handle: RuntimeExecutionHandle,
  turnNodeHash: HashString
): Promise<void> {
  await kernel.turn.updateHead(handle.turnId, turnNodeHash);
  await kernel.branch.setHead(handle.request.branchId, turnNodeHash);
}

export function materializeDriverFacade(
  driverRegistry: DriverRegistry,
  driverId: string
): KrakenDriver {
  const driverEntry = driverRegistry.resolve(driverId);

  if (driverEntry === undefined) {
    throw new TuvrenRuntimeError(`driver "${driverId}" is not registered`, {
      code: "unknown_driver",
      details: {
        driverId,
      },
    });
  }

  return materializeDriver(driverEntry);
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
  kernel: KrakenKernel,
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
