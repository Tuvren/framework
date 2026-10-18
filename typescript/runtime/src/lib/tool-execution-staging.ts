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

import type { ExecutionClass } from "@tuvren/core/capabilities";
import { TOOL_RESULT_SANITIZATION_FAILED } from "@tuvren/core/errors";
import type {
  SanitizeToolResultContext,
  SanitizeToolResultHook,
} from "@tuvren/core/execution";
import type { ToolCallPart, ToolResultPart } from "@tuvren/core/messages";
import type { ApprovalDecision, PendingToolCall } from "@tuvren/core/tools";

import { buildToolAttribution } from "./capability-attribution.js";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import { cloneValue, normalizeError } from "./tool-execution-helpers.js";
import type {
  EditedApprovalAudit,
  OrderedExecutableToolCall,
  SingleToolOutcome,
  StagedToolResult,
  ToolBatchEnvironment,
  ToolStartBarrier,
} from "./tool-execution.js";

/**
 * Approval provenance recorded on a `ToolResultPart`'s `output.approval`
 * field: the decision type, its optional host message, and — for `edit`
 * decisions — the original/edited input pair.
 */
interface ApprovalResultMetadata {
  editedInput?: unknown;
  message?: string;
  originalInput?: unknown;
  type: string;
}

/**
 * Derives the {@link ApprovalResultMetadata} for a result produced under a
 * host decision. `edit` decisions always yield metadata (with cloned
 * original/edited inputs when an audit is available); other decision types
 * yield metadata only when the host attached a message. Returns `undefined`
 * when there is nothing worth recording.
 */
const createApprovalResultMetadata = (
  decision: ApprovalDecision | undefined,
  audit: EditedApprovalAudit | undefined
): ApprovalResultMetadata | undefined => {
  if (decision === undefined) {
    return undefined;
  }

  if (decision.type === "edit") {
    return {
      ...(audit === undefined
        ? {}
        : {
            editedInput: cloneValue(audit.editedInput),
            originalInput: cloneValue(audit.originalInput),
          }),
      ...(decision.message === undefined ? {} : { message: decision.message }),
      type: decision.type,
    };
  }

  if (decision.message === undefined) {
    return undefined;
  }

  return {
    message: decision.message,
    type: decision.type,
  };
};

/**
 * Type guard for decisions that lead to execution (`approve` or `edit`);
 * `reject` and unknown decision types fail the guard and produce rejection
 * results instead.
 */
export const isExecutableApprovalDecision = (
  decision: ApprovalDecision
): decision is ApprovalDecision & { type: "approve" | "edit" } =>
  decision.type === "approve" || decision.type === "edit";

/**
 * Wraps a successful result's output as `{ approval, result }` when the call
 * was executed under an `approve`/`edit` decision that carries reportable
 * metadata (a host message, or the original/edited input pair of an edit).
 *
 * Plain approvals without a message produce no metadata and the result passes
 * through unchanged, as do rejections (those never reach this function with a
 * produced result). This is how a host's `ApprovalDecision.message` is folded
 * into the resulting `ToolResultPart` per framework spec §4.8.
 */
export const applyApprovalDecisionMetadata = (
  result: ToolResultPart,
  decision: ApprovalDecision | undefined,
  audit: EditedApprovalAudit | undefined
): ToolResultPart => {
  const approval = createApprovalResultMetadata(decision, audit);

  if (
    approval === undefined ||
    decision === undefined ||
    decision.type === "reject" ||
    !isExecutableApprovalDecision(decision)
  ) {
    return result;
  }

  return {
    ...result,
    output: {
      approval,
      result: result.output,
    },
  };
};

/**
 * Builds the canonical `isError: true` result for a pending call the host
 * rejected (or answered with an unrecognized decision type). The output
 * carries the decision type and either the host's message or a default
 * rejection message; the call is never executed (framework spec §4.8).
 */
export const createRejectedToolResult = (
  toolCall: PendingToolCall,
  decision: ApprovalDecision
): ToolResultPart => {
  const message =
    decision.message ??
    (decision.type === "reject"
      ? `Tool "${toolCall.name}" was rejected during approval.`
      : `Tool "${toolCall.name}" was blocked by approval decision "${decision.type}".`);

  return {
    callId: toolCall.callId,
    isError: true,
    name: toolCall.name,
    output: {
      decisionType: decision.type,
      error: message,
    },
    type: "tool_result",
  };
};

/**
 * Builds the `isError: true` result for a call whose execution (or
 * `aroundTool` chain) threw after exhausting its retry budget. The error
 * message is surfaced in `output.error`, with approval provenance attached
 * when the call ran under a host decision. Tool failures become results —
 * they never fail the run (framework spec §8.6).
 */
export const createExecutionFailureResult = (
  toolCall: ToolCallPart,
  error: unknown,
  decision: ApprovalDecision | undefined,
  audit: EditedApprovalAudit | undefined
): ToolResultPart => {
  const message =
    error instanceof Error ? error.message : `Tool "${toolCall.name}" failed.`;
  const approval = createApprovalResultMetadata(decision, audit);

  return {
    callId: toolCall.callId,
    isError: true,
    name: toolCall.name,
    output: {
      error: message,
      ...(approval === undefined ? {} : { approval }),
    },
    type: "tool_result",
  };
};

/**
 * Builds a generic `isError: true` result for a call decided without
 * execution — unknown tool, capability-policy denial, or a malformed resume
 * decision. `details` lands next to `output.error` when provided, and
 * approval provenance is attached when a host decision led here.
 */
export const createErrorToolResult = (
  toolCall: ToolCallPart,
  message: string,
  details?: unknown,
  decision?: ApprovalDecision,
  audit?: EditedApprovalAudit
): ToolResultPart => {
  const approval = createApprovalResultMetadata(decision, audit);

  return {
    callId: toolCall.callId,
    isError: true,
    name: toolCall.name,
    output: {
      ...(details === undefined
        ? { error: message }
        : { details, error: message }),
      ...(approval === undefined ? {} : { approval }),
    },
    type: "tool_result",
  };
};

/**
 * Builds an `isError: true` result carrying a machine-readable `output.code`
 * for typed rejections: `TOOL_INPUT_VALIDATION_FAILED`,
 * `TOOL_RESULT_VALIDATION_FAILED`, and `TOOL_INVOCATION_RATE_LIMITED`.
 * Validator diagnostics ride in `output.details`, and approval provenance is
 * attached on the resume path.
 */
export const createValidationErrorToolResult = (
  toolCall: ToolCallPart,
  code: string,
  message: string,
  details?: unknown,
  decision?: ApprovalDecision,
  audit?: EditedApprovalAudit
): ToolResultPart => {
  const approval = createApprovalResultMetadata(decision, audit);
  return {
    callId: toolCall.callId,
    isError: true,
    name: toolCall.name,
    output: {
      code,
      ...(details === undefined
        ? { error: message }
        : { details, error: message }),
      ...(approval === undefined ? {} : { approval }),
    },
    type: "tool_result",
  };
};

/**
 * Pure application of the ADR-0064 host sanitization hook to a single
 * {@link ToolResultPart}: builds the {@link SanitizeToolResultContext},
 * invokes the hook, and re-stamps `callId`/`name`/`type` onto whatever the
 * hook returns.
 *
 * Correlation identity is load-bearing and framework-owned, never host
 * policy: kernel skip-by-callId recovery, result/call pairing, and the
 * client-endpoint echo check all key on it. Re-stamping after the hook means
 * a careless object rebuild cannot desync the durable record from its
 * tool.call — content is the host's to sanitize, identity is not.
 *
 * A hook that throws is treated as a defect on this specific tool call, not
 * the turn (framework spec §8.6: tool failures become results, never turn
 * failures): the throw is not swallowed into a scrubbed-by-default result —
 * silently substituting content the host did not author would be worse than
 * a loud failure — so it becomes this call's own `isError: true` result
 * carrying `output.code: "tool_result_sanitization_failed"`.
 *
 * Exported so every application site of the seam (the gateway chokepoint in
 * {@link stageAndEmitResult} and the pre-staged provider message path in
 * `runtime-core-iteration.ts`) shares byte-identical semantics.
 */
export const applySanitizeHookToPart = (
  hook: SanitizeToolResultHook,
  result: ToolResultPart,
  executionClass: ExecutionClass | undefined
): ToolResultPart => {
  const context: SanitizeToolResultContext = {
    callId: result.callId,
    toolName: result.name,
    ...(executionClass === undefined ? {} : { executionClass }),
  };

  try {
    const sanitized = hook(result, context);
    return {
      callId: result.callId,
      ...(sanitized.isError === undefined
        ? {}
        : { isError: sanitized.isError }),
      name: result.name,
      output: sanitized.output,
      ...(sanitized.providerMetadata === undefined
        ? {}
        : { providerMetadata: sanitized.providerMetadata }),
      type: "tool_result",
    };
  } catch (error: unknown) {
    return {
      callId: result.callId,
      isError: true,
      name: result.name,
      output: {
        code: TOOL_RESULT_SANITIZATION_FAILED,
        error: `sanitizeToolResult threw: ${normalizeError(error).message}`,
      },
      type: "tool_result",
    };
  }
};

/**
 * Applies the host's {@link ToolBatchEnvironment.sanitizeToolResult} hook
 * (ADR-0064) to a would-be-staged result, if one is configured.
 *
 * A no-op when the hook is absent — byte-identical behavior to today.
 * Delegates the actual hook application (context construction, identity
 * re-stamp, throw handling) to {@link applySanitizeHookToPart}, the same
 * pure helper the pre-staged-provider staging path in
 * `runtime-core-iteration.ts` uses — one shared implementation, two
 * application sites (the Tool Execution Gateway chokepoint here, and the
 * AY003 pre-staged provider message path), per ADR-0064 §3.
 */
const applySanitizeToolResult = (
  environment: ToolBatchEnvironment,
  result: ToolResultPart,
  executionClass: ExecutionClass | undefined
): ToolResultPart => {
  const hook = environment.sanitizeToolResult;

  if (hook === undefined) {
    return result;
  }

  return applySanitizeHookToPart(hook, result, executionClass);
};

/**
 * Publishes the `tool.result` stream event for a staged result, attaching
 * capability attribution when the tool is still resolvable from the registry
 * (immediate error results for unregistered tools have no attribution).
 */
const emitToolResultEvent = (
  environment: ToolBatchEnvironment,
  result: ToolResultPart
): void => {
  const tool = environment.toolRegistry.get(result.name);
  environment.publishEvent({
    attribution: tool === undefined ? undefined : buildToolAttribution(tool),
    callId: result.callId,
    isError: result.isError,
    name: result.name,
    output: result.output,
    timestamp: environment.now(),
    type: "tool.result",
  });
};

/**
 * Durably stages one tool result and then publishes its `tool.result` event.
 *
 * Waits on the wave's start barrier first, enforcing the §6.4 invariant that
 * no `tool.result` of a wave is emitted before every `tool.start` of that
 * wave. `environment.sanitizeToolResult` (ADR-0064), when configured, is
 * applied here before either durable staging or event emission — this is the
 * single chokepoint for both, so the scrubbed form is what lands in kernel
 * history *and* what the canonical `tool.result` event carries; the
 * pre-sanitization form never reaches either. Staging precedes emission so a
 * crash between the two loses only the event, never the durable result
 * (framework spec §8.6 incremental staging).
 *
 * @param orderIndex - Original tool-call position used as the durable order
 *   key.
 * @param executionClass - The result's resolved execution class, when known;
 *   absent for outcomes decided before a binding was resolved (unknown tool,
 *   input-validation failure, policy denial, resume rejection) per ADR-0064 §3.
 * @returns The staged (sanitized) result paired with its content hash. The
 *   returned `result` — not the caller's input — is what was durably staged
 *   and emitted; callers must thread it into every in-memory downstream
 *   consumer (batch outcomes, after-iteration hooks) so the in-memory view
 *   never diverges from durable state.
 */
export const stageAndEmitResult = async (
  environment: ToolBatchEnvironment,
  result: ToolResultPart,
  orderIndex: number,
  startBarrier: ToolStartBarrier,
  executionClass?: ExecutionClass,
  updates: ExtensionStateUpdate[] = []
): Promise<StagedToolResult> => {
  await startBarrier.waitUntilReady();
  const sanitized = applySanitizeToolResult(
    environment,
    result,
    executionClass
  );
  const hash = await environment.stageResult(sanitized, orderIndex, updates);
  emitToolResultEvent(environment, sanitized);
  return { hash, result: sanitized };
};

/**
 * Sequentially stages and emits several results that share one order index —
 * e.g. the `completedResults` accompanying an approval pause.
 *
 * @param executionClass - See {@link stageAndEmitResult}; applies to every
 *   result in `results`.
 * @returns Staged (sanitized) results, index-aligned with `results`.
 */
export const stageAndEmitResults = async (
  environment: ToolBatchEnvironment,
  results: ToolResultPart[],
  orderIndex: number,
  startBarrier: ToolStartBarrier,
  executionClass?: ExecutionClass,
  updates: ExtensionStateUpdate[] = []
): Promise<StagedToolResult[]> => {
  const staged: StagedToolResult[] = [];
  const stageResultAtIndex = async (index: number): Promise<void> => {
    if (index >= results.length) {
      return;
    }
    const result = results[index];
    staged.push(
      await stageAndEmitResult(
        environment,
        result,
        orderIndex,
        startBarrier,
        executionClass,
        index === 0 ? updates : []
      )
    );
    await stageResultAtIndex(index + 1);
  };

  await stageResultAtIndex(0);

  return staged;
};

/**
 * Stages and emits the batch's immediate (non-executing) outcomes — unknown
 * tool, invalid input, policy denial, resume rejections — recording each
 * under its original call index in `orderedResults`.
 *
 * The start barrier still gates emission: with executable siblings present,
 * immediate `tool.result` events wait for the first wave's `tool.start`
 * events; with none, callers pass a zero-count (already-ready) barrier.
 */
export const stageImmediateResults = async (
  environment: ToolBatchEnvironment,
  immediateResults: ToolResultPart[][],
  orderedResults: StagedToolResult[][],
  startBarrier: ToolStartBarrier
): Promise<void> => {
  const stageResultsAtIndex = async (startIndex: number): Promise<void> => {
    let index = startIndex;

    while (
      index < immediateResults.length &&
      immediateResults[index].length === 0
    ) {
      index += 1;
    }

    if (index >= immediateResults.length) {
      return;
    }
    const results = immediateResults[index];

    const staged = await stageAndEmitResults(
      environment,
      results,
      index,
      startBarrier
    );
    orderedResults[index].push(...staged);
    await stageResultsAtIndex(index + 1);
  };

  await stageResultsAtIndex(0);
};

/**
 * Creates a countdown latch over `totalCalls` calls (see
 * {@link ToolStartBarrier}). A count of `0` yields an immediately-ready
 * barrier; extra `markSettled` calls beyond the count are ignored.
 */
export const createToolStartBarrier = (
  totalCalls: number
): ToolStartBarrier => {
  let pendingCalls = totalCalls;
  const { promise: ready, resolve: resolveReady } =
    Promise.withResolvers<boolean>();
  if (pendingCalls === 0) {
    resolveReady(true);
  }

  return {
    markSettled() {
      if (pendingCalls === 0) {
        return;
      }

      pendingCalls -= 1;

      if (pendingCalls === 0) {
        resolveReady(true);
      }
    },
    async waitUntilReady() {
      await ready;
    },
  };
};

/**
 * Runs a parallel batch's executable calls while concurrently staging its
 * immediate (non-executing) outcomes.
 *
 * Per framework spec §6.4, already-known outcomes are not artificially
 * delayed behind slower executable siblings — they are staged as soon as the
 * first wave's `tool.start` events have been emitted (the shared barrier is
 * sized to the first wave). Execution failures are captured and rethrown
 * only after immediate staging finishes, so known results still become
 * durable when an executable sibling fails.
 *
 * @param executeConcurrent - Injected wave executor (the gateway passes
 *   `executeConcurrentToolCalls`), which keeps this helper free of a module
 *   cycle with tool-execution.ts.
 * @returns Outcomes of the executable calls, aligned with `executable`.
 */
export const stageImmediateResultsWhileExecuting = async (
  environment: ToolBatchEnvironment,
  immediateResults: ToolResultPart[][],
  orderedResults: StagedToolResult[][],
  executable: OrderedExecutableToolCall[],
  executeConcurrent: (
    executableCalls: OrderedExecutableToolCall[],
    scopedEnvironment: ToolBatchEnvironment,
    startBarrier: ToolStartBarrier
  ) => Promise<SingleToolOutcome[]>
): Promise<SingleToolOutcome[]> => {
  const startBarrier = createToolStartBarrier(
    Math.min(executable.length, environment.maxParallelToolCalls)
  );
  const captureExecutableOutcome = async () => {
    try {
      return {
        outcomes: await executeConcurrent(
          executable,
          environment,
          startBarrier
        ),
        rejected: false as const,
      };
    } catch (error: unknown) {
      return { error, rejected: true as const };
    }
  };
  const executablePromise = captureExecutableOutcome();

  // Known non-executing outcomes are staged before slower siblings finish so they
  // survive crashes, but they still wait for the first execution wave to emit
  // `tool.start` events before any immediate `tool.result` is published.
  await stageImmediateResults(
    environment,
    immediateResults,
    orderedResults,
    startBarrier
  );

  const result = await executablePromise;

  if (result.rejected) {
    throw result.error;
  }

  return result.outcomes;
};
