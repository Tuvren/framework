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
import type { InputSignal } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import { updateContextManifest } from "./context-manifest.js";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

/**
 * Host seam for the durable state-commit operations in this module.
 *
 * Provides the kernel-run lifecycle (create/begin/complete tracked runs and
 * steps), record staging (messages, manifests, turn lineage, runtime
 * status), branch-head advancement, lease synchronization, and
 * observability/event publication used by {@link incorporateInput},
 * {@link incorporateSteering}, and
 * {@link commitPendingExtensionStateUpdates}.
 */
export interface RuntimeCoreStateCommitHost {
  advanceTurnAndBranchHead(
    handle: RuntimeExecutionHandle,
    turnNodeHash: HashString
  ): Promise<void>;
  collectInitialExtensionStateUpdates(
    extensions: LoopState["activeConfig"]["extensions"] | undefined,
    manifest: HeadState["manifest"]
  ): ExtensionStateUpdate[];
  completeTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    status: "completed" | "failed" | "paused"
  ): Promise<{ turnNodeHash?: HashString }>;
  createId(): string;
  createTrackedRun(
    handle: RuntimeExecutionHandle,
    runId: string,
    turnId: string,
    branchId: string,
    schemaId: string,
    startTurnNodeHash: HashString,
    steps: Array<{
      deterministic: boolean;
      id: string;
      sideEffects: boolean;
    }>
  ): Promise<void>;
  emitStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: HeadState["manifest"]
  ): Promise<void>;
  kernelRunBeginStep(runId: string, stepId: string): Promise<void>;
  kernelRunCompleteStep(
    runId: string,
    stepId: string,
    eventHash: HashString
  ): Promise<{
    lease?: { fencingToken: string; leaseExpiresAtMs: number };
    turnNodeHash?: HashString;
  }>;
  loadHeadState(branchId: string): Promise<HeadState>;
  now(): number;
  publishEvent(
    handle: RuntimeExecutionHandle,
    event: { messageId?: HashString; timestamp: number; type: string },
    loopState: LoopState
  ): void;
  stageManifest(
    runId: string,
    manifest: HeadState["manifest"],
    warningContext?: {
      handle: RuntimeExecutionHandle;
      loopState: LoopState;
    }
  ): Promise<HashString>;
  stageMessage(
    runId: string,
    message: TuvrenMessage,
    taskId: string
  ): Promise<HashString>;
  stageRuntimeStatus(
    runId: string,
    status: { activeAgent?: string; state: "running" },
    taskId: string
  ): Promise<HashString>;
  stageTurnLineage(
    runId: string,
    turnId: string,
    taskId: string
  ): Promise<HashString>;
  storeEventRecord(event: Record<string, unknown>): Promise<HashString>;
  syncRunLeaseStateFromStepResult(
    handle: RuntimeExecutionHandle,
    runId: string,
    stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: number } }
  ): void;
}

/**
 * Durably incorporate the turn's input signal as a user message.
 *
 * Runs a single-step tracked kernel run (`incorporate_input`) that stages
 * the user message, an updated context manifest seeded with initial
 * extension state, the turn lineage record, and a `running` runtime status,
 * then completes the step with an `input_received` event. When the step
 * yields a new turn node, the turn and branch head advance and state
 * observability is emitted for iteration 0.
 *
 * @param host - Capability seam for kernel runs, staging, and observability.
 * @param handle - Execution handle; its request supplies the branch and
 *   input signal.
 * @param schemaId - Kernel tree schema identifier for the tracked run.
 * @param loopState - Active loop state; supplies the agent name and
 *   extensions.
 */
export async function incorporateInput(
  host: RuntimeCoreStateCommitHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState
): Promise<void> {
  const runId = host.createId();
  const headState = await host.loadHeadState(handle.request.branchId);
  const userMessage: TuvrenMessage = {
    parts: handle.request.signal.parts,
    role: "user",
  };
  const manifest = updateContextManifest(
    headState.manifest,
    [userMessage],
    host.collectInitialExtensionStateUpdates(
      loopState.activeConfig.extensions ?? [],
      headState.manifest
    ),
    [0]
  );

  await host.createTrackedRun(
    handle,
    runId,
    handle.turnId,
    handle.request.branchId,
    schemaId,
    headState.branchHeadHash,
    [
      {
        deterministic: false,
        id: "incorporate_input",
        sideEffects: false,
      },
    ]
  );
  await host.kernelRunBeginStep(runId, "incorporate_input");
  await host.stageMessage(runId, userMessage, "input_message");
  await host.stageManifest(runId, manifest, {
    handle,
    loopState,
  });
  await host.stageTurnLineage(runId, handle.turnId, "turn_lineage");
  await host.stageRuntimeStatus(
    runId,
    {
      activeAgent: loopState.activeConfig.name,
      state: "running",
    },
    "runtime_status"
  );
  const stepResult = await host.kernelRunCompleteStep(
    runId,
    "incorporate_input",
    await host.storeEventRecord({
      turnId: handle.turnId,
      type: "input_received",
    })
  );
  host.syncRunLeaseStateFromStepResult(handle, runId, stepResult);
  await host.completeTrackedRun(handle, runId, "completed");

  if (stepResult.turnNodeHash !== undefined) {
    await host.advanceTurnAndBranchHead(handle, stepResult.turnNodeHash);
    await host.emitStateObservability(
      handle,
      loopState,
      stepResult.turnNodeHash,
      0,
      manifest
    );
  }
}

/**
 * Durably incorporate a queued steering signal as a user message mid-turn.
 *
 * Runs a single-step tracked kernel run (`incorporate_steering`) staging the
 * steering message and updated manifest, completes it with a
 * `steering_incorporated` event, and advances the turn and branch head when
 * a new turn node is produced. Afterwards the handle's status manifest is
 * updated and a `steering.incorporated` stream event carrying the staged
 * message hash is published.
 *
 * @param signal - The steering input signal whose parts become the user
 *   message.
 */
export async function incorporateSteering(
  host: RuntimeCoreStateCommitHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  signal: InputSignal,
  loopState: LoopState
): Promise<void> {
  const runId = host.createId();
  const headState = await host.loadHeadState(handle.request.branchId);
  const steeringMessage: TuvrenMessage = {
    parts: signal.parts,
    role: "user",
  };
  const manifest = updateContextManifest(
    headState.manifest,
    [steeringMessage],
    [],
    []
  );

  await host.createTrackedRun(
    handle,
    runId,
    handle.turnId,
    handle.request.branchId,
    schemaId,
    headState.branchHeadHash,
    [
      {
        deterministic: false,
        id: "incorporate_steering",
        sideEffects: false,
      },
    ]
  );
  await host.kernelRunBeginStep(runId, "incorporate_steering");
  const steeringMessageHash = await host.stageMessage(
    runId,
    steeringMessage,
    "steering_message"
  );
  await host.stageManifest(runId, manifest, {
    handle,
    loopState,
  });
  const stepResult = await host.kernelRunCompleteStep(
    runId,
    "incorporate_steering",
    await host.storeEventRecord({
      messageId: steeringMessageHash,
      turnId: handle.turnId,
      type: "steering_incorporated",
    })
  );
  host.syncRunLeaseStateFromStepResult(handle, runId, stepResult);
  await host.completeTrackedRun(handle, runId, "completed");

  if (stepResult.turnNodeHash !== undefined) {
    await host.advanceTurnAndBranchHead(handle, stepResult.turnNodeHash);
    await host.emitStateObservability(
      handle,
      loopState,
      stepResult.turnNodeHash,
      handle.status().iterationCount,
      manifest
    );
  }

  handle.updateStatus({
    manifest,
  });
  host.publishEvent(
    handle,
    {
      messageId: steeringMessageHash,
      timestamp: host.now(),
      type: "steering.incorporated",
    },
    loopState
  );
}

/**
 * Durably fold pending extension state updates into the context manifest.
 *
 * No-op when `updates` is empty. Otherwise runs a single-step tracked kernel
 * run (`commit_extension_state`) staging the manifest updated with the given
 * extension state, completes it with an `extension_state_committed` event,
 * advances the turn and branch head when a new turn node is produced, and
 * updates the handle's status manifest.
 *
 * The caller owns resetting {@link LoopState.carriedStateUpdates}; this
 * function does not mutate the array it receives.
 *
 * @param updates - Extension state updates to commit; may be empty.
 * @param iterationCount - Iteration attributed in the emitted state
 *   observability.
 */
export async function commitPendingExtensionStateUpdates(
  host: RuntimeCoreStateCommitHost,
  handle: RuntimeExecutionHandle,
  schemaId: string,
  loopState: LoopState,
  updates: ExtensionStateUpdate[],
  iterationCount: number
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const headState = await host.loadHeadState(handle.request.branchId);
  const manifest = updateContextManifest(headState.manifest, [], updates);
  const runId = host.createId();

  await host.createTrackedRun(
    handle,
    runId,
    handle.turnId,
    handle.request.branchId,
    schemaId,
    headState.branchHeadHash,
    [
      {
        deterministic: false,
        id: "commit_extension_state",
        sideEffects: false,
      },
    ]
  );
  await host.kernelRunBeginStep(runId, "commit_extension_state");
  await host.stageManifest(runId, manifest, {
    handle,
    loopState,
  });
  const stepResult = await host.kernelRunCompleteStep(
    runId,
    "commit_extension_state",
    await host.storeEventRecord({
      turnId: handle.turnId,
      type: "extension_state_committed",
    })
  );
  host.syncRunLeaseStateFromStepResult(handle, runId, stepResult);
  await host.completeTrackedRun(handle, runId, "completed");

  if (stepResult.turnNodeHash !== undefined) {
    await host.advanceTurnAndBranchHead(handle, stepResult.turnNodeHash);
    await host.emitStateObservability(
      handle,
      loopState,
      stepResult.turnNodeHash,
      iterationCount,
      manifest
    );
  }

  handle.updateStatus({
    manifest,
  });
}
