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
import { TOOL_RESULT_VALIDATION_FAILED } from "@tuvren/core/errors";
import type { AroundToolHandler } from "@tuvren/core/extensions";
import type { ToolResultPart } from "@tuvren/core/messages";

import { isClientEndpointTool } from "./binding-resolver.js";
import { buildToolAttribution } from "./capability-attribution.js";
import { runWithTimeout } from "./execution-timeouts.js";
import { buildSharedExports } from "./extension-runtime.js";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import { ToolBatchStagingError } from "./tool-execution-errors.js";
import {
  composeAbortSignals,
  createAroundToolContext,
  createToolExecutionContext,
  emitToolAuditEvent,
  emitToolStartIfNeeded,
  getAroundToolHandlers,
  isApprovalRequestValidationError,
  normalizeAroundToolResult,
  normalizeError,
  settleToolStartIfNeeded,
  ToolPauseSignalError,
  toExecutableToolCall,
} from "./tool-execution-helpers.js";
import {
  applyApprovalDecisionMetadata,
  createExecutionFailureResult,
  createValidationErrorToolResult,
  stageAndEmitResult,
  stageAndEmitResults,
} from "./tool-execution-staging.js";
import { validateToolOutput } from "./tool-execution-validation.js";
import type {
  ExecutableToolCall,
  RawSingleToolOutcome,
  SingleToolOutcome,
  ToolBatchEnvironment,
  ToolStartBarrier,
  ToolStartState,
} from "./tool-execution.js";

const createSequentialToolStartState = (): ToolStartState => ({
  emitted: false,
  releaseTurn: () => {
    // There is no following call in sequential mode.
  },
  settled: false,
  waitForTurn: () => {
    // There is no predecessor call in sequential mode.
  },
});

/**
 * Result of {@link applyOutputValidation}: the (possibly coerced) value to
 * forward, or a ready-made validation-failure outcome.
 */
type OutputValidationResult =
  | { ok: true; resolved: unknown }
  | { ok: false; outcome: RawSingleToolOutcome };

const prepareToolAttempt = (
  attempt: number,
  toolCall: ExecutableToolCall,
  environment: ToolBatchEnvironment
): boolean => {
  // Authority loss aborts retries; a running call keeps its existing outcome.
  if (attempt > 0 && environment.signal?.aborted === true) {
    return false;
  }
  // Client calls cannot retry, so this event is only for auditable server tools.
  if (attempt > 0 && !isClientEndpointTool(toolCall.tool)) {
    emitToolAuditEvent(
      environment,
      toolCall.toolCall.callId,
      toolCall.tool.name,
      "retry_attempt",
      { attempt }
    );
  }
  return true;
};

/**
 * Detects a tool `execute` return value that is already a complete
 * `ToolResultPart` for this exact call (matching `callId` and tool name).
 * Such direct results pass through as-is — letting a tool set `isError` or
 * shape its own part — instead of being wrapped as a plain `output` value.
 * Client-endpoint tools rely on this to surface typed error results
 * (see `buildClientEndpointTools` in tool-registry.ts).
 */
const isDirectToolResult = (
  value: unknown,
  toolCall: ExecutableToolCall
): value is ToolResultPart =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  value.type === "tool_result" &&
  "callId" in value &&
  value.callId === toolCall.toolCall.callId &&
  "name" in value &&
  value.name === toolCall.tool.name &&
  "output" in value;

/**
 * Validates a tool's raw `execute` output against its `outputSchema` when one
 * is declared (AX001, ADR-0046 §4.21).
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
const applyOutputValidation = (
  toolCall: ExecutableToolCall,
  output: unknown,
  environment: ToolBatchEnvironment
): OutputValidationResult => {
  if (toolCall.tool.outputSchema === undefined) {
    return { ok: true, resolved: output };
  }
  const isDirectResult = isDirectToolResult(output, toolCall);
  const isErrorResult = isDirectResult && output.isError === true;
  if (isErrorResult) {
    return { ok: true, resolved: output };
  }
  const valueToValidate = isDirectResult ? output.output : output;
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
    ? { ...output, output: outputValidation.value }
    : outputValidation.value;
  return { ok: true, resolved };
};

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
 *   `next()`, propagates as {@link ToolPauseSignalError} with accumulated
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
const runAroundToolHandlers = async (
  handlers: {
    extensionName: string;
    handler: AroundToolHandler;
    receiver: object;
    timeout?: number;
  }[],
  index: number,
  toolCall: ExecutableToolCall,
  environment: ToolBatchEnvironment,
  sharedExports: Record<string, Record<string, unknown>>,
  toolStartState: ToolStartState,
  startBarrier: ToolStartBarrier
): Promise<RawSingleToolOutcome> => {
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
    const { sandboxExecutor } = toolCall;
    const executeFunction =
      sandboxExecutor === undefined
        ? (input: unknown) => toolCall.tool.execute(input, executionContext)
        : (input: unknown) => sandboxExecutor.execute(input, executionContext);

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
        result: resolvedOutput,
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
      async () =>
        await handler.call(receiver, context, async (nextContext) => {
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
            throw new ToolPauseSignalError(outcome.approval, outcome.updates);
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
    if (error instanceof ToolPauseSignalError) {
      throw new ToolPauseSignalError(error.approval, [
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
};

const stageSingleToolOutcome = async (
  outcome: RawSingleToolOutcome,
  toolCall: ExecutableToolCall,
  environment: ToolBatchEnvironment,
  orderIndex: number,
  startBarrier: ToolStartBarrier,
  executionClass: ExecutionClass
): Promise<SingleToolOutcome> => {
  if (outcome.approval !== undefined) {
    return {
      approval: outcome.approval,
      completedStagedResults: await stageAndEmitResults(
        environment,
        outcome.approval.completedResults,
        orderIndex,
        startBarrier,
        executionClass,
        outcome.updates
      ),
      updates: outcome.updates,
    };
  }

  const result = applyApprovalDecisionMetadata(
    outcome.result,
    toolCall.approvalDecision,
    toolCall.approvalAudit
  );
  const staged = await stageAndEmitResult(
    environment,
    result,
    orderIndex,
    startBarrier,
    executionClass,
    outcome.updates
  );
  return {
    result: staged.result,
    resultHash: staged.hash,
    updates: outcome.updates,
  };
};

/**
 * Executes one admitted call through the `aroundTool` chain with the tool's
 * retry budget, then durably stages and emits its outcome.
 *
 * The retry budget is `1 + (maxRetries ?? 1)` attempts only when the tool
 * declares `idempotent: true` and is not marked `nonRetryable` (AX002/BB004);
 * everything else gets exactly one attempt. Retries stop immediately once
 * `environment.signal` aborts (lease loss, cancellation, deadline —
 * KRT-BG004 / ADR-0052), and each attempt after the first emits a
 * `retry_attempt` audit event (non-client tools only).
 *
 * Outcome handling:
 * - A completed result is annotated with approval-decision metadata (resume
 *   path), staged via `stageAndEmitResult`, and returned with its hash.
 * - An approval pause — returned by the chain or thrown as
 *   {@link ToolPauseSignalError} from a nested `next()` — stages any
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
 * @throws {Error} An `invalid_approval_request` error from a malformed `aroundTool`
 *   approval propagates (it is an extension programming error, not a tool
 *   failure). Staging failures from the batch-scoped authority fence also
 *   propagate.
 */
export const executeSingleTool = async (
  toolCall: ExecutableToolCall,
  orderIndex: number,
  environment: ToolBatchEnvironment,
  startBarrier: ToolStartBarrier,
  toolStartState?: ToolStartState
): Promise<SingleToolOutcome> => {
  const startState = toolStartState ?? createSequentialToolStartState();
  // Resolved once per call: this ExecutableToolCall's binding is already
  // settled (registry lookup, input validation, policy admission, approval
  // all cleared), so every result this call produces — success, approval
  // pause, or execution failure — carries a known execution class into the
  // sanitization seam (ADR-0064), unlike stageImmediateResults' pre-binding
  // outcomes.
  const { executionClass } = buildToolAttribution(toolCall.tool);
  // Idempotent retry per §4.21 / AX002. Non-idempotent tools are never
  // retried. maxRetries defaults to 1 when idempotent is true and unset.
  // BB004: nonRetryable overrides idempotent: true — policy governs retry.
  // KRT-BG004 (ADR-0052): on loss of execution authority an in-flight invocation
  // marked nonRetryable is never re-run under the dead owner — its budget is
  // structurally one attempt, and a recovering owner picks up only durably
  // staged completed results by callId (§4.9). The abort-break below additionally
  // abandons retries of retryable tools the instant authority is lost.
  const maxAttempts =
    toolCall.tool.idempotent === true && toolCall.tool.nonRetryable !== true
      ? 1 + (toolCall.tool.maxRetries ?? 1)
      : 1;

  let lastError: unknown;
  const executeAttempt = async (
    attempt: number
  ): Promise<SingleToolOutcome | undefined> => {
    if (
      attempt >= maxAttempts ||
      !prepareToolAttempt(attempt, toolCall, environment)
    ) {
      return undefined;
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
        startState,
        startBarrier
      );

      return await stageSingleToolOutcome(
        outcome,
        toolCall,
        environment,
        orderIndex,
        startBarrier,
        executionClass
      );
    } catch (error: unknown) {
      if (error instanceof ToolBatchStagingError) {
        throw error;
      }

      if (error instanceof ToolPauseSignalError) {
        await settleToolStartIfNeeded(startState, startBarrier);
        const completedStagedResults = await stageAndEmitResults(
          environment,
          error.approval.completedResults,
          orderIndex,
          startBarrier,
          executionClass,
          error.updates
        );
        return {
          approval: error.approval,
          completedStagedResults,
          updates: error.updates,
        };
      }

      if (isApprovalRequestValidationError(error)) {
        await settleToolStartIfNeeded(startState, startBarrier);
        throw error;
      }

      lastError = error;
      return await executeAttempt(attempt + 1);
    }
  };

  const attemptOutcome = await executeAttempt(0);
  if (attemptOutcome !== undefined) {
    return attemptOutcome;
  }

  const result = createExecutionFailureResult(
    toolCall.toolCall,
    lastError,
    toolCall.approvalDecision,
    toolCall.approvalAudit
  );
  await settleToolStartIfNeeded(startState, startBarrier);
  const staged = await stageAndEmitResult(
    environment,
    result,
    orderIndex,
    startBarrier,
    executionClass
  );

  return {
    result: staged.result,
    resultHash: staged.hash,
    updates: [],
  };
};
