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

import type { EpochMs, HashString } from "@tuvren/core";
import type {
  CapabilityPolicyEngine,
  PolicyCapabilityMetadata,
  TuvrenSandboxExecutor,
} from "@tuvren/core/capabilities";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  CapabilityPolicyContextInputs,
  ContextManifest,
  SanitizeToolResultHook,
} from "@tuvren/core/execution";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { ToolCallPart, ToolResultPart } from "@tuvren/core/messages";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResponse,
  ToolRegistry,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";

import type { ExtensionStateUpdate } from "./extension-runtime.js";
import type { ServerRateLimiter } from "./server-rate-limiter.js";
import { runToolBatch } from "./tool-execution-batch.js";
import {
  resolveExecutableToolCall,
  resolveResumeDecision,
} from "./tool-execution-resolution.js";

/**
 * Ambient services, identity, and policy seams a tool batch needs to execute.
 *
 * Built once per iteration by the runtime host (see
 * `createToolBatchEnvironment` in `runtime-core-runner.ts` /
 * `runtime-core-hosts.ts`) and passed to {@link executeToolBatch} and
 * {@link resumeToolBatch}. It bundles the durable staging seam
 * ({@link ToolBatchEnvironment.stageResult | stageResult}), the event
 * publication seam (`publishEvent` / `publishCustom`), abort and lease
 * fencing (`signal`), and the optional capability-orchestration seams
 * (policy engine, server rate limiter, sandbox executors) defined by
 * ADR-0046 / framework spec §4.21.
 */
export interface ToolBatchEnvironment {
  /** Name of the active agent whose iteration requested this tool batch. */
  activeAgent: string;
  /** Kernel branch that owns the batch's durable writes. */
  branchId: string;
  /**
   * Optional invocation-time policy engine per ADR-0046 §4.21.
   * When present, every tool invocation is checked before dispatch. A denied
   * invocation surfaces as `tool.result` with `isError: true` rather than
   * being executed. When absent, all invocations are admitted (default).
   */
  capabilityPolicyEngine?: CapabilityPolicyEngine;
  /**
   * Extensions whose `aroundTool` handlers wrap tool execution (framework
   * spec §6.6/§9) and whose returned state updates are collected into
   * {@link ToolBatchOutcome.updates}.
   */
  extensions: TuvrenExtension[];
  /**
   * Iteration-loop counter of the turn issuing this batch; surfaced to
   * `aroundTool` contexts for observability.
   */
  iterationCount: number;
  /**
   * Context manifest snapshot at batch time. Supplies per-extension state
   * and shared exports exposed (as clones) to `aroundTool` handlers.
   */
  manifest: ContextManifest;
  /**
   * Cap on concurrently executing calls within a parallel batch. Larger
   * batches run in waves of this size: every `tool.start` of a wave is
   * emitted before any `tool.result` of that wave (framework spec §6.4).
   */
  maxParallelToolCalls: number;
  /** Clock used to timestamp emitted `tool.start`/`tool.result`/`tool.audit` events. */
  now: () => EpochMs;
  /**
   * Per-capability policy metadata keyed by capabilityId. Built by the runtime
   * from TuvrenToolDefinition policy fields for the wired invocation-time check.
   * Populated when capabilityPolicyEngine is set. BB001–BB004.
   */
  policyCapabilityMetadata?: ReadonlyMap<string, PolicyCapabilityMetadata>;
  /**
   * Session-level policy context inputs from AgentConfig.policyContextInputs.
   * Used to populate the CapabilityPolicyContext for the wired invocation-time
   * check. BB001–BB004.
   */
  policyContextInputs?: CapabilityPolicyContextInputs;
  /** Publishes a tool- or extension-emitted custom event onto the turn stream. */
  publishCustom: (event: { data: unknown; name: string }) => void;
  /**
   * Publishes a framework stream event (`tool.start`, `tool.result`,
   * `tool.audit`) onto the turn's event stream.
   */
  publishEvent: (event: TuvrenStreamEvent) => void;
  /**
   * Reports a non-fatal error (for example an `aroundTool` handler that threw
   * after its `next()` call already produced a result) without failing the
   * batch or the run.
   */
  reportSoftError: (error: Error) => void;
  /**
   * Optional sandbox executor registry keyed by endpoint id. When a tool
   * declares metadata.sandbox.endpointId, the gateway looks up the executor
   * here and calls it instead of tool.execute. (AX004)
   */
  resolveSandboxExecutor?: (
    endpointId: string
  ) => TuvrenSandboxExecutor | undefined;
  /** Kernel run this batch executes under; stamped onto `tool.audit` events. */
  runId: string;
  /**
   * Host sanitization seam threaded from `AgentConfig.sanitizeToolResult`
   * (ADR-0064). Applied inside `stageAndEmitResult` before both durable
   * staging and `tool.result` event emission — see that function's doc for
   * the full ordering guarantee.
   */
  sanitizeToolResult?: SanitizeToolResultHook;
  /**
   * Optional per-tenant rate limiter for the Tuvren-server execution class.
   * Each runtime instance creates its own limiter from AgentConfig.serverExecution,
   * so invocations from one tenant cannot consume another tenant's budget. (AX003)
   */
  serverExecutionRateLimiter?: ServerRateLimiter;
  /**
   * Batch-level abort signal. It aborts on turn cancellation, on loss of the
   * run-liveness lease, and on the wall-clock deadline; once aborted, no
   * further retry attempt starts and the batch-scoped staging fence refuses
   * to commit results under the dead owner (ADR-0052 / KRT-BG004).
   */
  signal?: AbortSignal;
  /**
   * Durably stages one completed tool result before the batch as a whole
   * returns, so partial batch progress is crash-recoverable and recovery can
   * skip completed calls by `callId` (framework spec §8.6). `orderIndex` is
   * the position of the originating call in the model's tool-call order,
   * which keeps durable conversation order deterministic even when parallel
   * results complete out of order.
   *
   * @returns The content hash of the staged `{ role: "tool" }` message.
   */
  stageResult: (
    result: ToolResultPart,
    orderIndex: number,
    updates?: ExtensionStateUpdate[]
  ) => Promise<HashString>;
  /** Kernel thread the run belongs to. */
  threadId: string;
  /** Registry used to resolve each requested tool call by name (spec §8.5). */
  toolRegistry: ToolRegistry;
  /** Turn this batch belongs to; stamped onto `tool.audit` events. */
  turnId: string;
}

/**
 * Aggregate outcome of a tool batch.
 *
 * `results` and `resultHashes` are index-aligned and follow the original
 * tool-call order, regardless of the order in which parallel calls actually
 * completed. When `approval` is present the batch paused for host approval
 * (framework spec §4.8): `approval.toolCalls` lists the calls awaiting a
 * decision and `approval.completedResults` echoes the results that already
 * completed before the pause (the same entries as `results`).
 */
export interface ToolBatchOutcome {
  /**
   * Pending-approval request when at least one call requires a host decision;
   * absent when every call produced a result.
   */
  approval?: ApprovalRequest;
  /** Durable staging hashes, index-aligned with `results`. */
  resultHashes: HashString[];
  /** Completed tool results in original tool-call order. */
  results: ToolResultPart[];
  /** Extension state updates returned by `aroundTool` handlers, to be merged
   * into the iteration checkpoint (framework spec §8.6 step 4). */
  updates: ExtensionStateUpdate[];
}

/**
 * Audit trail for an `edit` approval decision: the input the model originally
 * requested and the input the host substituted. Recorded in the resulting
 * `ToolResultPart`'s `output.approval` metadata by
 * {@link applyApprovalDecisionMetadata | applyApprovalDecisionMetadata} so the
 * substitution stays visible in durable history.
 */
export interface EditedApprovalAudit {
  /** Input actually executed, as supplied by the host's edit decision. */
  editedInput: unknown;
  /** Input the model originally requested before the edit. */
  originalInput: unknown;
}

/**
 * A tool call that passed resolution, input validation, policy admission, and
 * the approval gate, and is therefore ready to run through the `aroundTool`
 * chain and the tool's `execute` function (framework spec §8.6 steps 4-5).
 */
export interface ExecutableToolCall {
  /**
   * Present only on the resume path when the host edited the input; carries
   * the original/edited pair for result metadata.
   */
  approvalAudit?: EditedApprovalAudit;
  /**
   * The host decision that admitted this call on the resume path; absent for
   * calls that were auto-approved on first execution. Exposed to `aroundTool`
   * contexts so approval wrappers can pass through without re-requesting
   * approval (framework spec §4.8).
   */
  approvalDecision?: ApprovalDecision;
  /** Validated (and possibly schema-coerced) input the tool will receive. */
  input: unknown;
  /** Sandbox executor resolved from metadata.sandbox.endpointId. (AX004) */
  sandboxExecutor?: TuvrenSandboxExecutor;
  /** Resolved tool definition from the registry. */
  tool: TuvrenToolDefinition;
  /**
   * The tool-call part carried into events and results. On an edit resume its
   * `input` reflects the edited input, while `input` above holds the
   * validated value actually passed to `execute`.
   */
  toolCall: ToolCallPart;
}

/**
 * An {@link ExecutableToolCall} paired with its position in the original
 * model-issued tool-call order, used to stage results at the right
 * `orderIndex` when parallel execution completes out of order.
 */
export interface OrderedExecutableToolCall {
  executable: ExecutableToolCall;
  /** Zero-based position of the call in the original batch. */
  index: number;
}

/** A completed tool result together with its durable staging hash. */
export interface StagedToolResult {
  /** Content hash returned by {@link ToolBatchEnvironment.stageResult}. */
  hash: HashString;
  result: ToolResultPart;
}

/**
 * Per-call mutable coordination state for `tool.start` emission within a
 * parallel wave.
 *
 * Each call in a wave gets one of these, chained so that `waitForTurn`
 * resolves only after the previous call in the wave has emitted (or settled
 * past) its own `tool.start`. This yields deterministic, call-ordered
 * `tool.start` events even though the calls execute concurrently. `emitted`
 * guards against double emission when `aroundTool` handlers invoke `next()`
 * more than once or the wrapper chain re-enters the base executor; `settled`
 * additionally covers calls that never emit `tool.start` (pause before
 * execution, pre-execution failure) but must still release the barrier.
 */
export interface ToolStartState {
  /** True once this call's `tool.start` event has been published. */
  emitted: boolean;
  /** Unblocks the next call in the wave's `tool.start` turn order. */
  releaseTurn: () => void;
  /**
   * True once the call has either emitted `tool.start` or been marked as
   * never-starting; the wave barrier counts settled calls, not emissions.
   */
  settled: boolean;
  /** Resolves when it is this call's turn to emit `tool.start`. */
  waitForTurn: () => void | Promise<void>;
}

/**
 * Countdown latch enforcing the wave-ordering invariant of framework spec
 * §6.4: within a parallel wave, every `tool.start` is emitted before any
 * `tool.result`.
 *
 * Created with the number of calls in the wave; each call decrements it via
 * `markSettled` (after emitting `tool.start`, or on the never-start paths),
 * and result staging/emission waits on `waitUntilReady` until the count
 * reaches zero. A barrier created with `0` is immediately ready, which is how
 * immediate (non-executing) results bypass the gate when there is nothing to
 * wait for.
 */
export interface ToolStartBarrier {
  /** Records that one call of the wave has settled its `tool.start` phase. */
  markSettled: () => void;
  /** Resolves once every call in the wave has settled. */
  waitUntilReady: () => Promise<void>;
}

/**
 * Execution mode for a tool batch. The runner chooses the mode per batch;
 * the shared framework core owns the ordering and durability semantics once
 * a mode is chosen (framework spec §6.4/§8.6). Defaults to `"parallel"` when
 * the runner does not specify one (see `runtime-core-iteration.ts`).
 */
export type ToolExecutionMode = "parallel" | "sequential";

/**
 * Outcome of one call after staging: either a completed result with its
 * durable hash, or a pause carrying an `ApprovalRequest` plus the hashes of
 * sibling results that completed (and were staged) before the pause. Both
 * arms carry the extension state updates collected from the `aroundTool`
 * chain.
 */
export type SingleToolOutcome =
  | {
      approval?: never;
      resultHash: HashString;
      result: ToolResultPart;
      updates: ExtensionStateUpdate[];
    }
  | {
      approval: ApprovalRequest;
      /**
       * The staged (sanitized, ADR-0064) forms of the sibling results that
       * completed before the pause, paired with their durable hashes. Carried
       * as pairs — not bare hashes — so downstream in-memory consumers see
       * exactly what was durably staged, never the pre-sanitization parts
       * still reachable via `approval.completedResults`.
       */
      completedStagedResults: StagedToolResult[];
      result?: never;
      updates: ExtensionStateUpdate[];
    };

/**
 * Pre-staging outcome of the `aroundTool` chain for one call: a result or an
 * approval pause, without durable hashes. {@link executeSingleTool} stages
 * the result (producing a {@link SingleToolOutcome}) after the chain returns.
 */
export type RawSingleToolOutcome =
  | {
      approval?: never;
      result: ToolResultPart;
      updates: ExtensionStateUpdate[];
    }
  | {
      approval: ApprovalRequest;
      result?: never;
      updates: ExtensionStateUpdate[];
    };

/**
 * Executes a batch of model-requested tool calls — the runtime's Tool
 * Execution Gateway entry point for a fresh batch.
 *
 * Each call is first resolved through the gateway pipeline (registry lookup,
 * input validation, invocation-time capability policy per ADR-0046 §4.21,
 * server-execution rate limit, sandbox-executor resolution, declarative
 * approval policy), then executed under the chosen mode:
 *
 * - `"parallel"`: all calls are resolved up front; executable calls run
 *   concurrently in waves of `environment.maxParallelToolCalls`, with all
 *   `tool.start` events of a wave emitted before any of its `tool.result`
 *   events. Immediate outcomes (unknown tool, invalid input, policy denial)
 *   are staged as soon as they are known. Approval-gated calls pause the
 *   batch without blocking their auto-approved siblings.
 * - `"sequential"`: calls resolve and execute one at a time in order; the
 *   first approval-gated call stops the batch, returning the results of the
 *   calls completed so far (framework spec §8.6).
 *
 * Every completed result is durably staged via `environment.stageResult`
 * before the batch returns, so a crash mid-batch loses no completed call.
 * Individual tool failures become `isError: true` results — they never fail
 * the run.
 *
 * @param toolCalls - Tool-call parts from the model response, in model order.
 * @param environment - Per-iteration services and policy seams.
 * @param mode - Runner-chosen execution mode for this batch.
 * @returns The batch outcome; `approval` is set when at least one call is
 *   pending a host decision, alongside any already-completed results.
 * @see resumeToolBatch for continuing a paused batch after host decisions.
 */
export const executeToolBatch = async (
  toolCalls: ToolCallPart[],
  environment: ToolBatchEnvironment,
  mode: ToolExecutionMode
): Promise<ToolBatchOutcome> =>
  await runToolBatch(
    toolCalls.length,
    environment,
    mode,
    async (index) =>
      await resolveExecutableToolCall(toolCalls[index], environment)
  );

/**
 * Resumes a batch that paused for approval, applying the host's decisions to
 * the still-pending calls (framework spec §4.8 "Approval Resume").
 *
 * Decisions are matched to pending calls by `callId`. `approve` re-executes
 * the call with its original input; `edit` re-validates `editedInput` and
 * executes with the validated value while recording an
 * {@link EditedApprovalAudit}; `reject` (or any unrecognized decision type)
 * produces a canonical rejection `ToolResultPart` without executing. Pending
 * calls with no matching decision are skipped entirely — they contribute
 * neither a result nor a new pending entry to this outcome. Before an
 * approved call runs, the invocation-time capability policy is re-evaluated
 * for hard denials (BB005), but a `requiresApproval` verdict is not re-raised
 * because the host just approved this specific invocation.
 *
 * Execution then follows the same mode semantics as
 * {@link executeToolBatch}; `mode` should be the mode recorded when the batch
 * originally paused (see `runtime-core-tool-resume.ts`).
 *
 * @param request - The `ApprovalRequest` captured at pause time.
 * @param response - Host decisions keyed by `callId`.
 * @param environment - Per-iteration services and policy seams.
 * @param mode - Execution mode recorded for the paused batch.
 * @returns Outcome of the resumed calls; `approval` reappears if an
 *   `aroundTool` handler pauses again during the resume.
 */
export const resumeToolBatch = async (
  request: ApprovalRequest,
  response: ApprovalResponse,
  environment: ToolBatchEnvironment,
  mode: ToolExecutionMode
): Promise<ToolBatchOutcome> => {
  const responseMap = new Map<string, ApprovalDecision>();
  for (const decision of response.decisions) {
    responseMap.set(decision.callId, decision);
  }
  return await runToolBatch(
    request.toolCalls.length,
    environment,
    mode,
    (index) => {
      const pendingToolCall = request.toolCalls[index];
      const decision = responseMap.get(pendingToolCall.callId);

      return decision === undefined
        ? undefined
        : resolveResumeDecision(pendingToolCall, decision, environment);
    }
  );
};
