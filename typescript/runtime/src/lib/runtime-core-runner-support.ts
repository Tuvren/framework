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
  ContextManifest,
  HandoffContextBuilder,
  HandoffContextPlan,
  RuntimeResolution,
} from "@tuvren/core/execution";
import {
  assertRunnerExecutionResult,
  type RunnerExecutionContext,
  type RuntimeRunner,
} from "@tuvren/core/runner";
import { TUVREN_SANDBOX_ENDPOINT_ID_PREFIX } from "./binding-resolver.js";
import { buildCapabilityMetadataFromTools } from "./capability-policy-engine.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import { formatToolResultTaskId } from "./runtime-core-response.js";
import { normalizeError } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import { createServerRateLimiter } from "./server-rate-limiter.js";
import type { ToolBatchEnvironment } from "./tool-execution.js";

/**
 * Host capabilities backing the tool-batch environment and handoff-plan
 * helpers in this module: config cloning and freezing, context-engineering
 * helper construction, parallelism resolution, event and error publication,
 * fencing-token access, and tool-result staging. Implemented by the
 * runtime-core orchestration layer.
 */
export interface RuntimeCoreRunnerSupportHost {
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
  /**
   * Active run lease fencing token for this handle, or undefined when no
   * run-liveness lease is held. Feeds the side-effect-once idempotency identity
   * placed on the tool batch environment (ADR-052).
   */
  getActiveFencingToken(handle: RuntimeExecutionHandle): string | undefined;
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

/**
 * Assembles the {@link ToolBatchEnvironment} passed to `executeToolBatch`
 * for one iteration.
 *
 * The server-execution rate limiter is created lazily on the first iteration
 * and cached on the loop state so a single budget spans the whole turn (it
 * is intentionally not re-evaluated on agent handoff). Capability policy
 * metadata and context inputs are included so the invocation-time policy
 * check can run inside tool-call resolution (BB001–BB004), and sandbox
 * executor lookup strips the "sandbox:" endpoint-id prefix added by the
 * binding resolver so `AgentConfig.sandboxExecutors` stays keyed by raw
 * endpoint ids (AX004). The environment also carries the active run-lease
 * fencing token for side-effect-once idempotency (ADR-052).
 */
export function createToolBatchEnvironment(
  host: RuntimeCoreRunnerSupportHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  manifest: ContextManifest,
  iterationCount: number,
  runId: string
): ToolBatchEnvironment {
  // Create the rate limiter once per turn (lazily on first iteration) and
  // cache it on loopState so the same budget applies across all iterations.
  // Intentional scoping: the limiter is fixed to the initiating agent's config
  // for the turn's lifetime and is not re-evaluated on agent handoff. See the
  // ServerExecutionConfig.rateLimit doc for multi-agent handoff semantics.
  const rateLimitConfig = loopState.activeConfig.serverExecution?.rateLimit;
  if (
    rateLimitConfig !== undefined &&
    loopState.serverExecutionRateLimiter === undefined
  ) {
    loopState.serverExecutionRateLimiter =
      createServerRateLimiter(rateLimitConfig);
  }

  // BB001–BB004: build capability metadata and expose policy context inputs
  // for the wired invocation-time policy check in resolveExecutableToolCall.
  const policyEngine = loopState.activeConfig.capabilityPolicyEngine;
  const policyCapabilityMetadata =
    policyEngine === undefined
      ? undefined
      : buildCapabilityMetadataFromTools(loopState.activeToolRegistry.list());
  const policyContextInputs =
    loopState.activeConfig.policyContextInputs ?? undefined;

  return {
    activeAgent: loopState.activeConfig.name,
    branchId: handle.request.branchId,
    capabilityPolicyEngine: policyEngine ?? undefined,
    policyCapabilityMetadata,
    policyContextInputs,
    extensions: loopState.activeConfig.extensions ?? [],
    fencingToken: host.getActiveFencingToken(handle),
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
    resolveSandboxExecutor:
      loopState.activeConfig.sandboxExecutors === undefined
        ? undefined
        : (endpointId: string) => {
            // binding-resolver prefixes the id with TUVREN_SANDBOX_ENDPOINT_ID_PREFIX
            // ("sandbox:") — strip it so AgentConfig.sandboxExecutors is keyed
            // by the raw endpointId declared in metadata.sandbox.endpointId. (AX004)
            const rawId = endpointId.startsWith(
              TUVREN_SANDBOX_ENDPOINT_ID_PREFIX
            )
              ? endpointId.slice(TUVREN_SANDBOX_ENDPOINT_ID_PREFIX.length)
              : endpointId;
            return loopState.activeConfig.sandboxExecutors?.get(rawId) as
              | import("@tuvren/core/capabilities").TuvrenSandboxExecutor
              | undefined;
          },
    serverExecutionRateLimiter: loopState.serverExecutionRateLimiter,
    signal: handle.abortSignal,
    stageResult: async (result, orderIndex) => {
      return await host.stageToolResultMessage(runId, result, orderIndex);
    },
    threadId: handle.request.threadId,
    toolRegistry: loopState.activeToolRegistry,
    turnId: handle.turnId,
  };
}

/**
 * Builds the {@link HandoffContextPlan} a runner receives from
 * `handoff.createContextPlan`.
 *
 * Defaults the mode to "preserve_trace", resolves a default context builder
 * when none is supplied, resolves the target agent config by name, and
 * packages a source context of cloned messages, manifest, and handoff
 * intent plus frozen source/target agent-config snapshots so the plan
 * cannot mutate live loop state.
 */
export function createRunnerHandoffContextPlan(
  host: RuntimeCoreRunnerSupportHost,
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

/**
 * Executes a runner against its execution context and asserts the shape of
 * its result, converting any thrown error (including a result-shape
 * violation) into a hard "fail" resolution instead of propagating the
 * exception into the iteration loop.
 */
export async function executeRunner(
  runner: RuntimeRunner,
  context: RunnerExecutionContext
): Promise<
  | Awaited<ReturnType<RuntimeRunner["execute"]>>
  | { resolution: RuntimeResolution }
> {
  try {
    const result = await runner.execute(context);
    assertRunnerExecutionResult(result, "runnerResult");
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

/**
 * Formats the staging task id for a tool result; a thin alias over
 * {@link formatToolResultTaskId} for host wiring.
 */
export function formatToolResultTask(
  orderIndex: number,
  callId: string
): string {
  return formatToolResultTaskId(orderIndex, callId);
}
