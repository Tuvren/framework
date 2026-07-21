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
  TuvrenSandboxExecutor,
} from "@tuvren/core/capabilities";
import {
  TOOL_INPUT_VALIDATION_FAILED,
  TOOL_INVOCATION_RATE_LIMITED,
  TOOL_RESULT_VALIDATION_FAILED,
} from "@tuvren/core/errors";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { ContextManifest } from "@tuvren/core/execution";
import type {
  AroundToolHandler,
  TuvrenExtension,
} from "@tuvren/core/extensions";
import type { ToolCallPart, ToolResultPart } from "@tuvren/core/messages";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResponse,
  PendingToolCall,
  ToolRegistry,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";
import {
  createBindingResolver,
  isClientEndpointTool,
} from "./binding-resolver.js";
import { runWithTimeout } from "./execution-timeouts.js";
import {
  buildSharedExports,
  type ExtensionStateUpdate,
} from "./extension-runtime.js";
import type { ServerRateLimiter } from "./server-rate-limiter.js";
import {
  applyApprovalDecisionMetadata,
  composeAbortSignals,
  createAroundToolContext,
  createBatchScopedEnvironment,
  createErrorToolResult,
  createExecutionFailureResult,
  createPendingToolCall,
  createRejectedToolResult,
  createToolExecutionContext,
  createToolStartBarrier,
  createValidationErrorToolResult,
  emitToolAuditEvent,
  emitToolStartIfNeeded,
  evaluateApprovalPolicy,
  getAroundToolHandlers,
  isApprovalRequestValidationError,
  isExecutableApprovalDecision,
  normalizeAroundToolResult,
  normalizeError,
  settleToolStartIfNeeded,
  stageAndEmitResult,
  stageAndEmitResults,
  stageImmediateResults,
  stageImmediateResultsWhileExecuting,
  ToolPauseSignal,
  toExecutableToolCall,
  validateToolInput,
  validateToolOutput,
  zipStagedToolResults,
} from "./tool-execution-helpers.js";
import { resolveToolDefinition } from "./tool-registry.js";

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
 * ADR-046 / framework spec §4.21.
 */
export interface ToolBatchEnvironment {
  /** Name of the active agent whose iteration requested this tool batch. */
  activeAgent: string;
  /** Kernel branch that owns the batch's durable writes. */
  branchId: string;
  /**
   * Optional invocation-time policy engine per ADR-046 §4.21.
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
  now(): EpochMs;
  /**
   * Per-capability policy metadata keyed by capabilityId. Built by the runtime
   * from TuvrenToolDefinition policy fields for the wired invocation-time check.
   * Populated when capabilityPolicyEngine is set. BB001–BB004.
   */
  policyCapabilityMetadata?: ReadonlyMap<
    string,
    import("@tuvren/core/capabilities").PolicyCapabilityMetadata
  >;
  /**
   * Session-level policy context inputs from AgentConfig.policyContextInputs.
   * Used to populate the CapabilityPolicyContext for the wired invocation-time
   * check. BB001–BB004.
   */
  policyContextInputs?: import("@tuvren/core/execution").CapabilityPolicyContextInputs;
  /** Publishes a tool- or extension-emitted custom event onto the turn stream. */
  publishCustom(event: { data: unknown; name: string }): void;
  /**
   * Publishes a framework stream event (`tool.start`, `tool.result`,
   * `tool.audit`) onto the turn's event stream.
   */
  publishEvent(event: TuvrenStreamEvent): void;
  /**
   * Reports a non-fatal error (for example an `aroundTool` handler that threw
   * after its `next()` call already produced a result) without failing the
   * batch or the run.
   */
  reportSoftError(error: Error): void;
  /**
   * Optional sandbox executor registry keyed by endpoint id. When a tool
   * declares metadata.sandbox.endpointId, the gateway looks up the executor
   * here and calls it instead of tool.execute. (AX004)
   */
  resolveSandboxExecutor?(
    endpointId: string
  ): TuvrenSandboxExecutor | undefined;
  /** Kernel run this batch executes under; stamped onto `tool.audit` events. */
  runId: string;
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
   * to commit results under the dead owner (ADR-052 / KRT-BG004).
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
  stageResult(result: ToolResultPart, orderIndex: number): Promise<HashString>;
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
  releaseTurn(): void;
  /**
   * True once the call has either emitted `tool.start` or been marked as
   * never-starting; the wave barrier counts settled calls, not emissions.
   */
  settled: boolean;
  /** Resolves when it is this call's turn to emit `tool.start`. */
  waitForTurn(): Promise<void>;
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
  markSettled(): void;
  /** Resolves once every call in the wave has settled. */
  waitUntilReady(): Promise<void>;
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
      completedResultHashes: HashString[];
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
 * Result of the synchronous resolve/validate/approve phase for one call
 * (framework spec §8.6 steps 1-3): admitted for execution, pending host
 * approval, or already decided with an immediate (usually error) result.
 */
type ResolvedToolBatchStep =
  | { executable: ExecutableToolCall }
  | { pendingToolCall: PendingToolCall }
  | { result: ToolResultPart };

/**
 * Executes a batch of model-requested tool calls — the runtime's Tool
 * Execution Gateway entry point for a fresh batch.
 *
 * Each call is first resolved through the gateway pipeline (registry lookup,
 * input validation, invocation-time capability policy per ADR-046 §4.21,
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
export async function executeToolBatch(
  toolCalls: ToolCallPart[],
  environment: ToolBatchEnvironment,
  mode: ToolExecutionMode
): Promise<ToolBatchOutcome> {
  return await runToolBatch(
    toolCalls.length,
    environment,
    mode,
    async (index) => {
      return await resolveExecutableToolCall(toolCalls[index], environment);
    }
  );
}

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
export async function resumeToolBatch(
  request: ApprovalRequest,
  response: ApprovalResponse,
  environment: ToolBatchEnvironment,
  mode: ToolExecutionMode
): Promise<ToolBatchOutcome> {
  const responseMap = new Map<string, ApprovalDecision>();
  for (const decision of response.decisions) {
    responseMap.set(decision.callId, decision);
  }
  return await runToolBatch(
    request.toolCalls.length,
    environment,
    mode,
    async (index) => {
      const pendingToolCall = request.toolCalls[index];
      const decision = responseMap.get(pendingToolCall.callId);

      if (decision === undefined) {
        return undefined;
      }

      return await resolveResumeDecision(
        pendingToolCall,
        decision,
        environment
      );
    }
  );
}

/**
 * Shared driver behind {@link executeToolBatch} and {@link resumeToolBatch}:
 * routes to the sequential or parallel strategy, with `resolveStep` supplying
 * either fresh-resolution or approval-decision semantics per call index.
 * A step resolving to `undefined` (undecided resume call) is skipped.
 */
async function runToolBatch(
  totalCalls: number,
  environment: ToolBatchEnvironment,
  mode: ToolExecutionMode,
  resolveStep: (index: number) => Promise<ResolvedToolBatchStep | undefined>
): Promise<ToolBatchOutcome> {
  if (mode === "sequential") {
    return await runSequentialToolBatch(totalCalls, environment, resolveStep);
  }

  const resolvedSteps = await resolveToolBatchSteps(totalCalls, resolveStep);
  return await runParallelToolBatch(resolvedSteps, environment);
}

/**
 * Runs the resolve/validate/approve phase for every call up front (framework
 * spec §8.6: parallel mode performs steps 1-3 synchronously for all calls
 * before any execution starts). Resolution is sequential and in call order,
 * so audit events from this phase are deterministically ordered.
 */
async function resolveToolBatchSteps(
  totalCalls: number,
  resolveStep: (index: number) => Promise<ResolvedToolBatchStep | undefined>
): Promise<Array<ResolvedToolBatchStep | undefined>> {
  const resolvedSteps: Array<ResolvedToolBatchStep | undefined> = [];

  for (let index = 0; index < totalCalls; index += 1) {
    resolvedSteps[index] = await resolveStep(index);
  }

  return resolvedSteps;
}

/**
 * Parallel-mode strategy: splits pre-resolved steps into immediate results,
 * pending approvals, and executable calls, then runs the executable set
 * concurrently while staging immediate results alongside it.
 *
 * Results are collected per original call index (`orderedResults`) so the
 * final outcome preserves model tool-call order even though completion order
 * is nondeterministic. Approval pauses from individual calls are merged: the
 * outcome's `approval.toolCalls` accumulates every pending call while
 * auto-approved siblings still contribute completed results (framework spec
 * §6.4 mixed-approval batch ordering).
 */
async function runParallelToolBatch(
  resolvedSteps: Array<ResolvedToolBatchStep | undefined>,
  environment: ToolBatchEnvironment
): Promise<ToolBatchOutcome> {
  const totalCalls = resolvedSteps.length;
  const orderedResults = Array.from(
    { length: totalCalls },
    (): StagedToolResult[] => []
  );
  const immediateResults = Array.from(
    { length: totalCalls },
    (): ToolResultPart[] => []
  );
  const pendingToolCalls: PendingToolCall[] = [];
  const updates: ExtensionStateUpdate[] = [];
  const executable: OrderedExecutableToolCall[] = [];

  for (const [index, resolved] of resolvedSteps.entries()) {
    if (resolved === undefined) {
      continue;
    }

    if ("pendingToolCall" in resolved) {
      pendingToolCalls.push(resolved.pendingToolCall);
      continue;
    }

    if ("result" in resolved) {
      immediateResults[index].push(resolved.result);
      continue;
    }

    executable.push({
      executable: resolved.executable,
      index,
    });
  }

  const executableOutcomes =
    executable.length === 0
      ? await stageImmediateResults(
          environment,
          immediateResults,
          orderedResults,
          createToolStartBarrier(0)
        ).then(() => [] as SingleToolOutcome[])
      : await stageImmediateResultsWhileExecuting(
          environment,
          immediateResults,
          orderedResults,
          executable,
          executeConcurrentToolCalls
        );

  for (const [outcomeIndex, outcome] of executableOutcomes.entries()) {
    updates.push(...outcome.updates);
    const resultIndex = executable[outcomeIndex]?.index;

    if (resultIndex === undefined) {
      continue;
    }

    if (outcome.approval !== undefined) {
      pendingToolCalls.push(...outcome.approval.toolCalls);
      orderedResults[resultIndex].push(
        ...zipStagedToolResults(
          outcome.approval.completedResults,
          outcome.completedResultHashes
        )
      );
      continue;
    }

    orderedResults[resultIndex].push({
      hash: outcome.resultHash,
      result: outcome.result,
    });
  }

  return buildToolBatchOutcome(orderedResults, pendingToolCalls, updates);
}

/**
 * Sequential-mode strategy: resolves and fully executes one call at a time in
 * model order, emitting each call's `tool.start`/`tool.result` pair before
 * moving on. The first call that requires approval — whether from resolution
 * (declarative policy, risk-based policy gate) or from an `aroundTool` pause —
 * stops the batch; later calls are not resolved or executed and are left for
 * the resume path (framework spec §8.6 sequential execution).
 */
async function runSequentialToolBatch(
  totalCalls: number,
  environment: ToolBatchEnvironment,
  resolveStep: (index: number) => Promise<ResolvedToolBatchStep | undefined>
): Promise<ToolBatchOutcome> {
  const orderedResults = Array.from(
    { length: totalCalls },
    (): StagedToolResult[] => []
  );
  const pendingToolCalls: PendingToolCall[] = [];
  const updates: ExtensionStateUpdate[] = [];

  for (let index = 0; index < totalCalls; index += 1) {
    const resolved = await resolveStep(index);

    if (resolved === undefined) {
      continue;
    }

    if ("pendingToolCall" in resolved) {
      pendingToolCalls.push(resolved.pendingToolCall);
      break;
    }

    if ("result" in resolved) {
      const resultHashes = await stageAndEmitResults(
        environment,
        [resolved.result],
        index,
        createToolStartBarrier(0)
      );
      orderedResults[index].push(
        ...zipStagedToolResults([resolved.result], resultHashes)
      );
      continue;
    }

    const outcome = await executeSingleTool(
      resolved.executable,
      index,
      environment,
      createToolStartBarrier(1)
    );
    updates.push(...outcome.updates);

    if (outcome.approval !== undefined) {
      pendingToolCalls.push(...outcome.approval.toolCalls);
      orderedResults[index].push(
        ...zipStagedToolResults(
          outcome.approval.completedResults,
          outcome.completedResultHashes
        )
      );
      break;
    }

    orderedResults[index].push({
      hash: outcome.resultHash,
      result: outcome.result,
    });
  }

  return buildToolBatchOutcome(orderedResults, pendingToolCalls, updates);
}

/**
 * Flattens per-call-index staged results into the final index-aligned
 * `results`/`resultHashes` arrays and, when any calls are still pending,
 * wraps them in an `ApprovalRequest` whose `completedResults` mirrors the
 * completed set.
 */
function buildToolBatchOutcome(
  orderedResults: StagedToolResult[][],
  pendingToolCalls: PendingToolCall[],
  updates: ExtensionStateUpdate[]
): ToolBatchOutcome {
  const stagedResults = orderedResults.flat();
  const results = stagedResults.map((entry) => entry.result);
  const resultHashes = stagedResults.map((entry) => entry.hash);

  return pendingToolCalls.length === 0
    ? { resultHashes, results, updates }
    : {
        approval: {
          completedResults: results,
          toolCalls: pendingToolCalls,
        },
        resultHashes,
        results,
        updates,
      };
}

/**
 * Runs the gateway admission pipeline for one freshly requested call and
 * classifies it as executable, pending approval, or immediately decided.
 *
 * Pipeline order (framework spec §8.6 steps 1-3, extended by ADR-046 §4.21):
 *
 * 1. Registry lookup — unknown tool becomes an error result.
 * 2. Input validation against `inputSchema` — failure becomes a
 *    `TOOL_INPUT_VALIDATION_FAILED` result; an `input_validated` audit event
 *    is emitted either way (except for tuvren-client tools, KRT-AZ005).
 * 3. Invocation-time capability policy, when a policy engine is configured —
 *    denial becomes an error result with a `policy_denied` audit event;
 *    `requiresApproval` routes the call into the pending-approval flow
 *    (BB002 risk-based gate).
 * 4. Tuvren-server rate limit (AX003) — exhaustion becomes a
 *    `TOOL_INVOCATION_RATE_LIMITED` result with a `rate_limited` audit event.
 * 5. Sandbox executor resolution for tools declaring
 *    `metadata.sandbox.endpointId` (AX004).
 * 6. Declarative approval policy from `tool.approval` (spec §8.4) — `true`
 *    routes the call into the pending-approval flow.
 *
 * Only calls that clear every gate become {@link ExecutableToolCall}s
 * carrying the validated input.
 */
async function resolveExecutableToolCall(
  toolCall: ToolCallPart,
  environment: ToolBatchEnvironment
): Promise<
  | { executable: ExecutableToolCall }
  | { pendingToolCall: PendingToolCall }
  | { result: ToolResultPart }
> {
  const tool = resolveToolDefinition(environment.toolRegistry, toolCall.name);

  if (tool === undefined) {
    return {
      result: createErrorToolResult(
        toolCall,
        `Tool "${toolCall.name}" is not registered.`
      ),
    };
  }

  const validation = validateToolInput(tool, toolCall.input);
  // Tuvren-client tools carry partial observability: canAudit is false, so
  // tool.audit events must not be emitted for them. The isClientEndpointTool
  // guard gates all audit-event emission points in this function. (KRT-AZ005)
  const isClientTool = isClientEndpointTool(tool);

  if (!isClientTool) {
    emitToolAuditEvent(
      environment,
      toolCall.callId,
      toolCall.name,
      "input_validated",
      {
        validationPassed: validation.valid,
      }
    );
  }

  if (!validation.valid) {
    return {
      result: createValidationErrorToolResult(
        toolCall,
        TOOL_INPUT_VALIDATION_FAILED,
        "Tool input failed validation.",
        validation.details
      ),
    };
  }

  // Invocation-time policy check per ADR-046 §4.21 (Epic BB: context populated).
  if (environment.capabilityPolicyEngine !== undefined) {
    const resolver = createBindingResolver();
    const binding = resolver.resolveFromToolDefinition(tool);
    const inputs = environment.policyContextInputs ?? {};
    const policyContext = {
      allowedResidencies: inputs.allowedResidencies,
      availableCredentialScopes: inputs.availableCredentialScopes,
      capabilityMetadata: environment.policyCapabilityMetadata,
      modelId: "",
      permissions: [] as string[],
      providerId: "",
      userPresent: inputs.userPresent,
    };
    const decision = environment.capabilityPolicyEngine.evaluateInvocation(
      binding,
      policyContext
    );
    if (!decision.admitted) {
      if (!isClientTool) {
        emitToolAuditEvent(
          environment,
          toolCall.callId,
          toolCall.name,
          "policy_denied"
        );
      }
      return {
        result: createErrorToolResult(
          toolCall,
          decision.reason ?? "invocation denied by capability policy"
        ),
      };
    }
    // BB002: risk-based approval gate. When the policy engine signals that
    // this capability requires explicit approval (e.g. high-risk class), gate
    // execution through the existing pending-approval flow. The framework
    // owns this decision above runner discretion per §4.21 / ADR-046.
    if (decision.requiresApproval === true) {
      return {
        pendingToolCall: createPendingToolCall(
          toolCall,
          validation.value,
          decision.reason
        ),
      };
    }
  }

  // Rate-limit check for Tuvren-server execution class per §4.21 / AX003.
  // Client endpoint tools are not subject to server-side rate limiting.
  if (
    !isClientTool &&
    environment.serverExecutionRateLimiter !== undefined &&
    !environment.serverExecutionRateLimiter.tryAcquire()
  ) {
    emitToolAuditEvent(
      environment,
      toolCall.callId,
      toolCall.name,
      "rate_limited"
    );
    return {
      result: createValidationErrorToolResult(
        toolCall,
        TOOL_INVOCATION_RATE_LIMITED,
        `Tool "${tool.name}" invocation rejected: server execution rate limit exceeded.`
      ),
    };
  }

  // Resolve sandbox executor for tools declared with metadata.sandbox.endpointId.
  // The resolver produces endpoint.id = "sandbox:<endpointId>"; we strip the
  // prefix before the lookup so AgentConfig.sandboxExecutors is keyed by the
  // raw endpointId the host declared in metadata.sandbox.endpointId. (AX004)
  const binding = createBindingResolver().resolveFromToolDefinition(tool);
  let sandboxExecutor: TuvrenSandboxExecutor | undefined;
  if (
    binding.endpoint.kind === "tuvren-sandbox" &&
    environment.resolveSandboxExecutor !== undefined
  ) {
    sandboxExecutor = environment.resolveSandboxExecutor(binding.endpoint.id);
  }

  const toolContext = createToolExecutionContext(
    toolCall,
    tool,
    environment,
    environment.signal
  );
  const approvalRequired =
    tool.approval === undefined
      ? false
      : await evaluateApprovalPolicy(
          tool.approval,
          validation.value,
          toolContext
        );

  if (approvalRequired) {
    return {
      pendingToolCall: createPendingToolCall(toolCall, validation.value),
    };
  }

  return {
    executable: {
      input: validation.value,
      sandboxExecutor,
      tool,
      toolCall,
    },
  };
}

/**
 * Detects a tool `execute` return value that is already a complete
 * `ToolResultPart` for this exact call (matching `callId` and tool name).
 * Such direct results pass through as-is — letting a tool set `isError` or
 * shape its own part — instead of being wrapped as a plain `output` value.
 * Client-endpoint tools rely on this to surface typed error results
 * (see `buildClientEndpointTools` in tool-registry.ts).
 */
function isDirectToolResult(
  value: unknown,
  toolCall: ExecutableToolCall
): value is ToolResultPart {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "tool_result" &&
    "callId" in value &&
    value.callId === toolCall.toolCall.callId &&
    "name" in value &&
    value.name === toolCall.tool.name &&
    "output" in value
  );
}

/**
 * Translates one host approval decision for a paused call into either an
 * {@link ExecutableToolCall} or an immediate result.
 *
 * - `reject` (and unknown decision types) produce the canonical rejection
 *   result without executing.
 * - `approve` executes with the original pending input; input validation is
 *   not repeated because the input already passed it before the pause.
 * - `edit` requires `editedInput`, which is re-validated against the tool's
 *   `inputSchema`; failures produce a `TOOL_INPUT_VALIDATION_FAILED` result
 *   annotated with the decision, and successes carry an
 *   {@link EditedApprovalAudit} into the result metadata.
 *
 * For `approve`/`edit`, the invocation-time capability policy is re-checked
 * for hard denials against current (not pause-time) policy context inputs
 * (BB005); the risk-based `requiresApproval` gate is intentionally skipped
 * since the host just approved this call. A tool that disappeared from the
 * registry between pause and resume produces an error result.
 */
function resolveResumeDecision(
  pendingToolCall: PendingToolCall,
  decision: ApprovalDecision,
  environment: ToolBatchEnvironment
): { executable: ExecutableToolCall } | { result: ToolResultPart } {
  if (decision.type === "reject" || !isExecutableApprovalDecision(decision)) {
    return {
      result: createRejectedToolResult(pendingToolCall, decision),
    };
  }

  const tool = resolveToolDefinition(
    environment.toolRegistry,
    pendingToolCall.name
  );

  if (tool === undefined) {
    return {
      result: createErrorToolResult(
        {
          callId: pendingToolCall.callId,
          input: pendingToolCall.input,
          name: pendingToolCall.name,
          type: "tool_call",
        },
        `Tool "${pendingToolCall.name}" is not registered.`,
        {
          decisionType: decision.type,
        },
        decision,
        decision.type === "edit"
          ? {
              editedInput: decision.editedInput,
              originalInput: pendingToolCall.input,
            }
          : undefined
      ),
    };
  }

  // BB005: re-evaluate invocation-time policy on the resume path. Inputs
  // come from the current agent config (environment.policyContextInputs),
  // not a snapshot captured at pause time. Static dimensions therefore
  // produce the same decision as pre-pause unless the host mutates config
  // between pause and resume. The guard is meaningful for context-sensitive
  // custom engines that consult external mutable state (e.g. live credential
  // validity) independently of policyContextInputs.
  // The risk-based approval path (requiresApproval) is intentionally not
  // re-raised here: the host has just approved this specific invocation,
  // so we honour that approval and only check for hard denials.
  if (environment.capabilityPolicyEngine !== undefined) {
    const resolver = createBindingResolver();
    const binding = resolver.resolveFromToolDefinition(tool);
    const inputs = environment.policyContextInputs ?? {};
    const policyContext = {
      allowedResidencies: inputs.allowedResidencies,
      availableCredentialScopes: inputs.availableCredentialScopes,
      capabilityMetadata: environment.policyCapabilityMetadata,
      modelId: "",
      permissions: [] as string[],
      providerId: "",
      userPresent: inputs.userPresent,
    };
    const resumeDecision =
      environment.capabilityPolicyEngine.evaluateInvocation(
        binding,
        policyContext
      );
    if (!resumeDecision.admitted) {
      if (!isClientEndpointTool(tool)) {
        emitToolAuditEvent(
          environment,
          pendingToolCall.callId,
          pendingToolCall.name,
          "policy_denied"
        );
      }
      return {
        result: createErrorToolResult(
          {
            callId: pendingToolCall.callId,
            input: pendingToolCall.input,
            name: pendingToolCall.name,
            type: "tool_call",
          },
          resumeDecision.reason ?? "invocation denied by capability policy"
        ),
      };
    }
  }

  if (decision.type === "approve") {
    return {
      executable: {
        approvalDecision: decision,
        input: pendingToolCall.input,
        tool,
        toolCall: {
          callId: pendingToolCall.callId,
          input: pendingToolCall.input,
          name: pendingToolCall.name,
          type: "tool_call",
        },
      },
    };
  }

  const input = decision.editedInput;

  if (decision.editedInput === undefined) {
    return {
      result: createErrorToolResult(
        {
          callId: pendingToolCall.callId,
          input,
          name: pendingToolCall.name,
          type: "tool_call",
        },
        `Approval decision "edit" for tool "${pendingToolCall.name}" requires editedInput.`,
        {
          decisionType: decision.type,
        },
        decision
      ),
    };
  }

  const validation = validateToolInput(tool, input);

  if (!validation.valid) {
    return {
      result: createValidationErrorToolResult(
        {
          callId: pendingToolCall.callId,
          input,
          name: pendingToolCall.name,
          type: "tool_call",
        },
        TOOL_INPUT_VALIDATION_FAILED,
        "Approved tool input failed validation.",
        {
          decisionType: decision.type,
          validation: validation.details,
        },
        decision,
        {
          editedInput: input,
          originalInput: pendingToolCall.input,
        }
      ),
    };
  }

  return {
    executable: {
      approvalAudit: {
        editedInput: input,
        originalInput: pendingToolCall.input,
      },
      approvalDecision: decision,
      input: validation.value,
      tool,
      toolCall: {
        callId: pendingToolCall.callId,
        input,
        name: pendingToolCall.name,
        type: "tool_call",
      },
    },
  };
}

/**
 * Executes one admitted call through the `aroundTool` chain with the tool's
 * retry budget, then durably stages and emits its outcome.
 *
 * The retry budget is `1 + (maxRetries ?? 1)` attempts only when the tool
 * declares `idempotent: true` and is not marked `nonRetryable` (AX002/BB004);
 * everything else gets exactly one attempt. Retries stop immediately once
 * `environment.signal` aborts (lease loss, cancellation, deadline —
 * KRT-BG004 / ADR-052), and each attempt after the first emits a
 * `retry_attempt` audit event (non-client tools only).
 *
 * Outcome handling:
 * - A completed result is annotated with approval-decision metadata (resume
 *   path), staged via `stageAndEmitResult`, and returned with its hash.
 * - An approval pause — returned by the chain or thrown as
 *   {@link ToolPauseSignal} from a nested `next()` — stages any
 *   `completedResults` it carries and returns the approval arm.
 * - When all attempts fail, the last error becomes an `isError: true`
 *   execution-failure result; tool failures never fail the run (framework
 *   spec §8.6).
 *
 * In all paths the call's {@link ToolStartState} is settled so the wave
 * barrier and the `tool.start` turn chain cannot deadlock on a call that
 * never started.
 *
 * @param orderIndex - Original batch position, used as the durable staging
 *   order key.
 * @param toolStartState - Wave-ordering state; the default value used by the
 *   sequential path emits immediately without turn chaining.
 * @throws An `invalid_approval_request` error from a malformed `aroundTool`
 *   approval propagates (it is an extension programming error, not a tool
 *   failure). Staging failures from the batch-scoped authority fence also
 *   propagate.
 */
async function executeSingleTool(
  toolCall: ExecutableToolCall,
  orderIndex: number,
  environment: ToolBatchEnvironment,
  startBarrier: ToolStartBarrier,
  toolStartState: ToolStartState = {
    emitted: false,
    releaseTurn() {
      return undefined;
    },
    settled: false,
    waitForTurn() {
      return Promise.resolve();
    },
  }
): Promise<SingleToolOutcome> {
  // Idempotent retry per §4.21 / AX002. Non-idempotent tools are never
  // retried. maxRetries defaults to 1 when idempotent is true and unset.
  // BB004: nonRetryable overrides idempotent: true — policy governs retry.
  // KRT-BG004 (ADR-052): on loss of execution authority an in-flight invocation
  // marked nonRetryable is never re-run under the dead owner — its budget is
  // structurally one attempt, and a recovering owner picks up only durably
  // staged completed results by callId (§4.9). The abort-break below additionally
  // abandons retries of retryable tools the instant authority is lost.
  const maxAttempts =
    toolCall.tool.idempotent === true && toolCall.tool.nonRetryable !== true
      ? 1 + (toolCall.tool.maxRetries ?? 1)
      : 1;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Do not retry when the environment signal is already aborted. Loss of
    // execution authority (run lease lost via createRunLeaseLostError), turn
    // cancellation, and the wall-clock deadline all abort this signal, so no
    // further attempt runs under a dead owner. (KRT-BG004 / ADR-052; §4.9)
    if (attempt > 0 && environment.signal?.aborted) {
      break;
    }

    // Emit a retry_attempt audit event for each attempt after the first.
    // Guard for tuvren-client tools: canAudit is false for the class, and
    // buildClientEndpointTools never sets idempotent, so maxAttempts is always
    // 1 for client tools. The guard makes the canAudit:false invariant structural
    // rather than incidental. (AX005, KRT-AZ005)
    if (attempt > 0 && !isClientEndpointTool(toolCall.tool)) {
      emitToolAuditEvent(
        environment,
        toolCall.toolCall.callId,
        toolCall.tool.name,
        "retry_attempt",
        { attempt }
      );
    }

    try {
      const sharedExports = buildSharedExports(
        environment.extensions,
        environment.manifest
      );
      const outcome = await runAroundToolHandlers(
        getAroundToolHandlers(environment.extensions, toolCall.tool.name),
        0,
        toolCall,
        environment,
        sharedExports,
        toolStartState,
        startBarrier
      );

      if (outcome.approval !== undefined) {
        const completedResultHashes = await stageAndEmitResults(
          environment,
          outcome.approval.completedResults,
          orderIndex,
          startBarrier
        );
        return {
          approval: outcome.approval,
          completedResultHashes,
          updates: outcome.updates,
        };
      }

      const result = applyApprovalDecisionMetadata(
        outcome.result,
        toolCall.approvalDecision,
        toolCall.approvalAudit
      );
      const resultHash = await stageAndEmitResult(
        environment,
        result,
        orderIndex,
        startBarrier
      );

      return {
        resultHash,
        result,
        updates: outcome.updates,
      };
    } catch (error: unknown) {
      if (error instanceof ToolPauseSignal) {
        await settleToolStartIfNeeded(toolStartState, startBarrier);
        const completedResultHashes = await stageAndEmitResults(
          environment,
          error.approval.completedResults,
          orderIndex,
          startBarrier
        );
        return {
          approval: error.approval,
          completedResultHashes,
          updates: error.updates,
        };
      }

      if (isApprovalRequestValidationError(error)) {
        await settleToolStartIfNeeded(toolStartState, startBarrier);
        throw error;
      }

      lastError = error;
      // Continue to next attempt if retries remain; fall through to
      // failure path after the loop when this was the last attempt.
    }
  }

  const result = createExecutionFailureResult(
    toolCall.toolCall,
    lastError,
    toolCall.approvalDecision,
    toolCall.approvalAudit
  );
  await settleToolStartIfNeeded(toolStartState, startBarrier);
  const resultHash = await stageAndEmitResult(
    environment,
    result,
    orderIndex,
    startBarrier
  );

  return {
    resultHash,
    result,
    updates: [],
  };
}

/**
 * Runs the executable calls of a parallel batch in waves of
 * `environment.maxParallelToolCalls` (framework spec §6.4).
 *
 * All waves share one batch abort controller wrapped into a batch-scoped
 * environment (see `createBatchScopedEnvironment`): the first call whose
 * execution throws past `executeSingleTool` aborts the whole batch, fencing
 * sibling event publication and result staging. Waves run to completion one
 * after another; the first wave reuses the caller's start barrier (which also
 * gates immediate-result emission), later waves create their own.
 */
async function executeConcurrentToolCalls(
  executable: OrderedExecutableToolCall[],
  environment: ToolBatchEnvironment,
  startBarrier: ToolStartBarrier
): Promise<SingleToolOutcome[]> {
  const batchAbortController = new AbortController();
  const scopedEnvironment = createBatchScopedEnvironment(
    environment,
    batchAbortController.signal
  );
  const outcomes: SingleToolOutcome[] = [];

  for (
    let index = 0;
    index < executable.length;
    index += environment.maxParallelToolCalls
  ) {
    const wave = executable.slice(
      index,
      index + environment.maxParallelToolCalls
    );
    const waveStartBarrier =
      index === 0 ? startBarrier : createToolStartBarrier(wave.length);

    outcomes.push(
      ...(await executeToolCallWave(
        wave,
        scopedEnvironment,
        waveStartBarrier,
        batchAbortController
      ))
    );
  }

  return outcomes;
}

/**
 * Executes one wave of calls concurrently while keeping `tool.start` events
 * in call order.
 *
 * Each call gets a {@link ToolStartState} chained to its predecessor's turn
 * promise, so starts are emitted sequentially in wave order even though the
 * executions themselves overlap. All calls are awaited via
 * `Promise.allSettled`; the first rejection aborts the batch controller (so
 * siblings stop publishing/staging) and is rethrown to the caller after every
 * call has settled.
 */
async function executeToolCallWave(
  executable: OrderedExecutableToolCall[],
  environment: ToolBatchEnvironment,
  startBarrier: ToolStartBarrier,
  batchAbortController: AbortController
): Promise<SingleToolOutcome[]> {
  let previousTurn = Promise.resolve();
  const toolStartStates = executable.map(() => {
    let releaseTurn: (() => void) | undefined;
    const turnPromise = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const waitForTurn = previousTurn;
    previousTurn = turnPromise;

    return {
      emitted: false,
      releaseTurn() {
        releaseTurn?.();
        releaseTurn = undefined;
      },
      settled: false,
      waitForTurn() {
        return waitForTurn;
      },
    } satisfies ToolStartState;
  });

  const outcomes = executable.map((toolCall, index) =>
    executeSingleTool(
      toolCall.executable,
      toolCall.index,
      environment,
      startBarrier,
      toolStartStates[index]
    ).catch((error: unknown) => {
      if (!batchAbortController.signal.aborted) {
        batchAbortController.abort(normalizeError(error));
      }

      throw error;
    })
  );
  const settledOutcomes = await Promise.allSettled(outcomes);
  const successfulOutcomes: SingleToolOutcome[] = [];

  for (const outcome of settledOutcomes) {
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }

    successfulOutcomes.push(outcome.value);
  }

  return successfulOutcomes;
}

/**
 * Result of {@link applyOutputValidation}: the (possibly coerced) value to
 * forward, or a ready-made validation-failure outcome.
 */
type OutputValidationResult =
  | { ok: true; resolved: unknown }
  | { ok: false; outcome: RawSingleToolOutcome };

/**
 * Validates a tool's raw `execute` output against its `outputSchema` when one
 * is declared (AX001, ADR-046 §4.21).
 *
 * Tools without an `outputSchema` pass through untouched, as do direct
 * `ToolResultPart` returns flagged `isError: true` (error payloads are not
 * held to the success schema). For direct results, only the inner `output`
 * value is validated and the validated (possibly coerced) value is spliced
 * back in — mirroring how the input path forwards `validation.value`. An
 * `output_validated` audit event is emitted for non-client tools whether
 * validation passes or fails; failure yields a
 * `TOOL_RESULT_VALIDATION_FAILED` error result.
 */
function applyOutputValidation(
  toolCall: ExecutableToolCall,
  output: unknown,
  environment: ToolBatchEnvironment
): OutputValidationResult {
  if (toolCall.tool.outputSchema === undefined) {
    return { ok: true, resolved: output };
  }
  const isDirectResult = isDirectToolResult(output, toolCall);
  const isErrorResult =
    isDirectResult && (output as ToolResultPart).isError === true;
  if (isErrorResult) {
    return { ok: true, resolved: output };
  }
  const valueToValidate = isDirectResult
    ? (output as ToolResultPart).output
    : output;
  const outputValidation = validateToolOutput(
    toolCall.tool.outputSchema,
    valueToValidate
  );
  // Tuvren-client tools: canAudit is false — suppress audit events. (KRT-AZ005)
  if (!isClientEndpointTool(toolCall.tool)) {
    emitToolAuditEvent(
      environment,
      toolCall.toolCall.callId,
      toolCall.tool.name,
      "output_validated",
      {
        validationPassed: outputValidation.valid,
      }
    );
  }
  if (!outputValidation.valid) {
    return {
      ok: false,
      outcome: {
        result: createValidationErrorToolResult(
          toolCall.toolCall,
          TOOL_RESULT_VALIDATION_FAILED,
          "Tool output failed validation.",
          outputValidation.details
        ),
        updates: [],
      },
    };
  }
  // Forward the (potentially coerced) validated value, mirroring the
  // input path which uses validation.value at resolveExecutableToolCall.
  const resolved = isDirectResult
    ? { ...(output as ToolResultPart), output: outputValidation.value }
    : outputValidation.value;
  return { ok: true, resolved };
}

/**
 * Recursively runs the `aroundTool` middleware chain around the tool's actual
 * execution (framework spec §6.6/§9.5; executor flow step 4 in §8.6).
 *
 * Base case (`index === handlers.length`): emits `tool.start` (turn-ordered
 * within the wave), invokes `tool.execute` — or the resolved sandbox executor
 * for `tuvren-sandbox` tools (AX004) — under the tool's `timeout` with a
 * timeout-abort composed into the execution context's signal, then applies
 * output validation and normalizes the return value into a `ToolResultPart`
 * (direct results pass through; plain values are wrapped).
 *
 * Handler case: invokes the handler with an isolated {@link AroundToolContext}
 * and a `next()` that recurses to the rest of the chain, honoring any
 * replacement context the handler passes (input/tool overrides). Handler
 * semantics:
 *
 * - A pause verdict from the handler, or a nested pause surfacing through
 *   `next()`, propagates as {@link ToolPauseSignal} with accumulated
 *   extension state updates.
 * - Handler results are normalized via `normalizeAroundToolResult`, merging
 *   returned `state` into the update list.
 * - A handler that throws after its `next()` already produced a result is
 *   reported as a soft error and the nested result is kept (the executed
 *   tool's outcome is not discarded for an observer bug).
 * - A handler that throws before producing a result yields an execution
 *   failure result for the call, except `invalid_approval_request` errors,
 *   which propagate as extension programming errors.
 * - Handler timeouts (`extension.timeout`) behave like handler throws.
 */
async function runAroundToolHandlers(
  handlers: Array<{
    extensionName: string;
    handler: AroundToolHandler;
    receiver: object;
    timeout?: number;
  }>,
  index: number,
  toolCall: ExecutableToolCall,
  environment: ToolBatchEnvironment,
  sharedExports: Record<string, Record<string, unknown>>,
  toolStartState: ToolStartState,
  startBarrier: ToolStartBarrier
): Promise<RawSingleToolOutcome> {
  if (index >= handlers.length) {
    const timeoutController = new AbortController();
    const startPromise = emitToolStartIfNeeded(
      toolCall,
      environment,
      toolStartState,
      startBarrier
    );
    let output: unknown;

    const executionContext = createToolExecutionContext(
      toolCall.toolCall,
      toolCall.tool,
      environment,
      composeAbortSignals(environment.signal, timeoutController.signal)
    );
    // Sandbox tools (endpoint.kind === "tuvren-sandbox") use the registered
    // sandbox executor instead of tool.execute. (AX004)
    const executeFunction =
      toolCall.sandboxExecutor === undefined
        ? (input: unknown) => toolCall.tool.execute(input, executionContext)
        : (input: unknown) =>
            (toolCall.sandboxExecutor as TuvrenSandboxExecutor).execute(
              input,
              executionContext
            );

    try {
      output = await runWithTimeout(
        () => executeFunction(toolCall.input),
        toolCall.tool.timeout,
        () =>
          new Error(
            `tool "${toolCall.tool.name}" timed out after ${toolCall.tool.timeout}ms`
          ),
        {
          onTimeout: (error) => {
            timeoutController.abort(error);
          },
        }
      );
    } catch (error: unknown) {
      await startPromise;
      throw error;
    }

    await startPromise;

    // Output validation per §4.21 / AX001. Extracted to applyOutputValidation
    // to keep runAroundToolHandlers below the cognitive-complexity threshold.
    const validation = applyOutputValidation(toolCall, output, environment);
    if (!validation.ok) {
      return validation.outcome;
    }
    const resolvedOutput = validation.resolved;

    if (isDirectToolResult(resolvedOutput, toolCall)) {
      return {
        result: resolvedOutput as ToolResultPart,
        updates: [],
      };
    }

    return {
      result: {
        callId: toolCall.toolCall.callId,
        name: toolCall.tool.name,
        output: resolvedOutput,
        type: "tool_result",
      },
      updates: [],
    };
  }

  const { extensionName, handler, receiver, timeout } = handlers[index];
  const nestedUpdates: ExtensionStateUpdate[] = [];
  let nestedResult: ToolResultPart | undefined;
  const timeoutController = new AbortController();
  const context = createAroundToolContext(
    toolCall,
    extensionName,
    environment,
    sharedExports,
    composeAbortSignals(environment.signal, timeoutController.signal)
  );

  try {
    const handlerResult = await runWithTimeout(
      () =>
        handler.call(receiver, context, async (nextContext) => {
          const outcome = await runAroundToolHandlers(
            handlers,
            index + 1,
            toExecutableToolCall(toolCall, nextContext),
            environment,
            sharedExports,
            toolStartState,
            startBarrier
          );

          if (outcome.approval !== undefined) {
            throw new ToolPauseSignal(outcome.approval, outcome.updates);
          }

          nestedUpdates.push(...outcome.updates);
          nestedResult = outcome.result;
          return outcome.result;
        }),
      timeout,
      () =>
        new Error(
          `aroundTool handler for extension "${extensionName}" timed out after ${timeout}ms`
        ),
      {
        onTimeout: (error) => {
          timeoutController.abort(error);
        },
      }
    );

    return await normalizeAroundToolResult(
      extensionName,
      handlerResult,
      nestedUpdates,
      nestedResult,
      context,
      environment,
      toolStartState,
      startBarrier
    );
  } catch (error: unknown) {
    if (error instanceof ToolPauseSignal) {
      throw new ToolPauseSignal(error.approval, [
        ...nestedUpdates,
        ...error.updates,
      ]);
    }

    if (isApprovalRequestValidationError(error)) {
      throw error;
    }

    if (nestedResult !== undefined) {
      environment.reportSoftError(normalizeError(error));
      return {
        result: nestedResult,
        updates: nestedUpdates,
      };
    }

    return {
      result: createExecutionFailureResult(
        toolCall.toolCall,
        error,
        toolCall.approvalDecision,
        toolCall.approvalAudit
      ),
      updates: nestedUpdates,
    };
  }
}
