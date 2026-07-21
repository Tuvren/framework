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

import { TuvrenRuntimeError } from "@tuvren/core";
import type { ExecutionClass } from "@tuvren/core/capabilities";
import { TOOL_RESULT_SANITIZATION_FAILED } from "@tuvren/core/errors";
import type { EventSource, TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  SanitizeToolResultContext,
  SanitizeToolResultHook,
} from "@tuvren/core/execution";
import type {
  AroundToolContext,
  AroundToolResult,
  TuvrenExtension,
} from "@tuvren/core/extensions";
import type { ToolCallPart, ToolResultPart } from "@tuvren/core/messages";
import type {
  ApprovalDecision,
  ApprovalRequest,
  PendingToolCall,
  ToolExecutionContext,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";
import { assertApprovalRequest } from "@tuvren/core/tools";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv from "ajv";
import { buildToolAttribution } from "./capability-attribution.js";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import { deriveIdempotencyKey } from "./idempotency-identity.js";
import { cloneSnapshotPreservingFunctions } from "./runtime-core-shared.js";
import type {
  EditedApprovalAudit,
  ExecutableToolCall,
  OrderedExecutableToolCall,
  RawSingleToolOutcome,
  SingleToolOutcome,
  StagedToolResult,
  ToolBatchEnvironment,
  ToolStartBarrier,
  ToolStartState,
} from "./tool-execution.js";

/** Decision types offered to the host for every pending approval. */
const DEFAULT_APPROVAL_DECISIONS = ["approve", "edit", "reject"];
/** Shared Ajv instance for JSON Schema input/output validation. */
const ajv = new Ajv({
  allErrors: true,
  strict: false,
});
/** Memoized compiled validators, keyed by schema object identity. */
const validatorCache = new WeakMap<object, ValidateFunction>();

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
 * Control-flow signal that unwinds the `aroundTool` chain when a nested
 * layer requests an approval pause.
 *
 * Carries the `ApprovalRequest` to surface to the host plus the extension
 * state updates accumulated on the way up, so a pause does not lose state
 * written by outer handlers. Callers of the chain catch this signal and
 * convert it into the approval arm of a tool outcome; it is never surfaced
 * as a tool failure.
 */
// This remains throw-based intentionally: aroundTool handlers receive
// `next(): Promise<ToolResultPart>`, so a nested pause has no value-level way to
// short-circuit that contract without widening the public handler surface.
export class ToolPauseSignal extends Error {
  readonly approval: ApprovalRequest;
  readonly updates: ExtensionStateUpdate[];

  constructor(approval: ApprovalRequest, updates: ExtensionStateUpdate[]) {
    super("tool execution paused");
    this.approval = approval;
    this.updates = updates;
  }
}

/**
 * Wraps a {@link ToolBatchEnvironment} with a fence composed from the
 * environment's own signal and a batch-level abort signal.
 *
 * Once the fence aborts, `publishEvent`, `publishCustom`, and
 * `reportSoftError` become silent no-ops, and `stageResult` throws the abort
 * reason both before and after the underlying staging call — the
 * commit-under-valid-authority gate of ADR-052 / KRT-BG004: a result produced
 * after execution authority is lost (lease loss, cancellation, wall-clock
 * deadline, or sibling batch failure) is never committed to durable history
 * under the dead owner.
 *
 * @param batchSignal - Signal aborted when any sibling call in the parallel
 *   batch fails (see `executeConcurrentToolCalls`).
 * @returns A shallow copy of the environment with fenced publication and
 *   staging seams and `signal` set to the composed fence signal.
 */
export function createBatchScopedEnvironment(
  environment: ToolBatchEnvironment,
  batchSignal: AbortSignal
): ToolBatchEnvironment {
  const fenceSignal =
    environment.signal === undefined
      ? batchSignal
      : AbortSignal.any([environment.signal, batchSignal]);
  const throwIfAborted = () => {
    if (!fenceSignal.aborted) {
      return;
    }

    throw normalizeError(fenceSignal.reason);
  };

  return {
    ...environment,
    publishCustom(event) {
      if (fenceSignal.aborted) {
        return;
      }

      environment.publishCustom(event);
    },
    publishEvent(event) {
      if (fenceSignal.aborted) {
        return;
      }

      environment.publishEvent(event);
    },
    reportSoftError(error) {
      if (fenceSignal.aborted) {
        return;
      }

      environment.reportSoftError(error);
    },
    signal: fenceSignal,
    async stageResult(result, orderIndex) {
      // Commit-under-valid-authority gate (ADR-052: a result becomes durable
      // state only through a commit performed while the run still holds write
      // authority). The fence signal aborts on lease loss, cancellation, or the
      // wall-clock deadline, so a result produced after authority is lost is not
      // committed to history under the dead owner. (KRT-BG004)
      throwIfAborted();
      const hash = await environment.stageResult(result, orderIndex);
      throwIfAborted();
      return hash;
    },
  };
}

/**
 * Builds the `ToolExecutionContext` handed to `tool.execute` (and to
 * declarative approval-policy functions, framework spec §8.3/§8.4).
 *
 * `emit`/`forward` publish onto the turn stream but become no-ops once
 * `timeoutSignal` aborts, so a timed-out tool cannot keep emitting events.
 * `idempotencyKey` is derived from `(turnId, callId)` — the logical call
 * identity, which survives retries, approval resumes, and recovery — so
 * external systems can deduplicate a side effect re-dispatched under a new
 * Run or a new execution owner (ADR-052 side-effect-once as amended by
 * ADR-065; see `deriveIdempotencyKey` in idempotency-identity.ts). Tool
 * `metadata` is
 * deep-cloned (preserving functions) so the tool cannot mutate the registry's
 * definition, and `signal` falls back to the batch signal when no per-call
 * timeout signal exists.
 */
export function createToolExecutionContext(
  toolCall: ToolCallPart,
  tool: TuvrenToolDefinition,
  environment: ToolBatchEnvironment,
  timeoutSignal: AbortSignal | undefined
): ToolExecutionContext {
  return {
    callId: toolCall.callId,
    emit: (event: { data: unknown; name: string }) => {
      if (timeoutSignal?.aborted) {
        return;
      }

      environment.publishCustom(event);
    },
    forward: (event: TuvrenStreamEvent, source: EventSource) => {
      if (timeoutSignal?.aborted) {
        return;
      }

      environment.publishEvent({
        ...event,
        source,
      });
    },
    idempotencyKey: deriveIdempotencyKey(environment.turnId, toolCall.callId),
    metadata:
      tool.metadata === undefined
        ? undefined
        : cloneSnapshotPreservingFunctions(tool.metadata),
    name: tool.name,
    signal: timeoutSignal ?? environment.signal,
  };
}

/**
 * Builds the isolated `AroundToolContext` passed to one `aroundTool` handler.
 *
 * Every data field (`input`, `manifest`, `sharedExports`, `extensionState`,
 * `tool`, `toolCall`) is a deep clone — handlers observe snapshots and cannot
 * mutate runtime state in place; state flows back only through the handler's
 * returned `state` and through the context object it passes to `next()`.
 * `emit`/`forward` publish to the turn stream and are silenced once the
 * handler's timeout signal aborts. `extensionState` is this extension's own
 * slice of the context manifest.
 */
export function createAroundToolContext(
  toolCall: ExecutableToolCall,
  extensionName: string,
  environment: ToolBatchEnvironment,
  sharedExports: Record<string, Record<string, unknown>>,
  timeoutSignal: AbortSignal | undefined
): AroundToolContext {
  return {
    approvalDecision: toolCall.approvalDecision,
    callId: toolCall.toolCall.callId,
    emit: (event: { data: unknown; name: string }) => {
      if (timeoutSignal?.aborted) {
        return;
      }

      environment.publishCustom(event);
    },
    extensionState: cloneRecord(environment.manifest.extensions[extensionName]),
    forward: (event: TuvrenStreamEvent, source: EventSource) => {
      if (timeoutSignal?.aborted) {
        return;
      }

      environment.publishEvent({
        ...event,
        source,
      });
    },
    input: cloneValue(toolCall.input),
    iterationCount: environment.iterationCount,
    manifest: cloneValue(environment.manifest),
    sharedExports: cloneValue(sharedExports),
    tool: cloneSnapshotPreservingFunctions(toolCall.tool),
    toolCall: cloneValue(toolCall.toolCall),
  };
}

/**
 * Applies the (optional) replacement context an `aroundTool` handler passed
 * to `next(context)` onto the executable call for the rest of the chain.
 *
 * The handler-controlled fields (`input`, `tool`, `toolCall`, and an
 * overriding `approvalDecision`) come from the replacement context, while the
 * runtime-owned `approvalAudit` and `sandboxExecutor` are always preserved
 * from the base call — a handler cannot bypass the configured sandbox
 * isolation boundary (AX004) or erase edit-audit provenance. With no
 * replacement context, the base call is returned unchanged.
 */
export function toExecutableToolCall(
  base: ExecutableToolCall,
  nextContext: AroundToolContext | undefined
): ExecutableToolCall {
  if (nextContext === undefined) {
    return base;
  }

  return {
    approvalAudit: base.approvalAudit,
    approvalDecision: nextContext.approvalDecision ?? base.approvalDecision,
    input: nextContext.input,
    // Preserve sandbox executor so aroundTool handlers that call next(context)
    // do not silently bypass the configured isolation boundary. (AX004)
    sandboxExecutor: base.sandboxExecutor,
    tool: nextContext.tool,
    toolCall: nextContext.toolCall,
  };
}

/**
 * Emits the call's `tool.start` event exactly once, in wave turn order.
 *
 * Waits for the call's turn in the wave's start chain, re-checks `emitted`
 * (a nested `aroundTool` `next()` may have emitted while waiting), publishes
 * `tool.start` with capability attribution, then settles the wave barrier and
 * releases the next call's turn. Per framework spec §6.4, `tool.start` fires
 * only when the framework actually enters the first executable step for the
 * call — never merely because the model requested the tool.
 */
export async function emitToolStartIfNeeded(
  toolCall: ExecutableToolCall,
  environment: ToolBatchEnvironment,
  toolStartState: ToolStartState,
  startBarrier: ToolStartBarrier
): Promise<void> {
  if (toolStartState.emitted) {
    return;
  }

  await toolStartState.waitForTurn();

  if (toolStartState.emitted) {
    return;
  }

  toolStartState.emitted = true;
  toolStartState.settled = true;
  environment.publishEvent({
    attribution: buildToolAttribution(toolCall.tool),
    callId: toolCall.toolCall.callId,
    input: toolCall.input,
    name: toolCall.tool.name,
    timestamp: environment.now(),
    type: "tool.start",
  });
  startBarrier.markSettled();
  toolStartState.releaseTurn();
}

/**
 * Builds the `PendingToolCall` entry for a call awaiting host approval,
 * offering the default decision set (`approve`, `edit`, `reject`).
 *
 * @param input - The validated input the call would execute with.
 * @param message - Optional prompt override (e.g. the policy engine's
 *   `requiresApproval` reason).
 * @defaultValue message - `Approve tool "<name>"?`
 */
export function createPendingToolCall(
  toolCall: { callId: string; name: string },
  input: unknown,
  message?: string
): PendingToolCall {
  return {
    callId: toolCall.callId,
    decisions: [...DEFAULT_APPROVAL_DECISIONS],
    input,
    message: message ?? `Approve tool "${toolCall.name}"?`,
    name: toolCall.name,
  };
}

/**
 * Guarantees that an `aroundTool`-supplied `ApprovalRequest` includes the
 * call being paused.
 *
 * If the extension already listed the call, its entry is refreshed with the
 * current input and name; otherwise a default pending entry is appended.
 * This keeps the extension free to add other pending calls while making it
 * impossible to pause a call without representing it in the request.
 * Returns a new request object; the input is not mutated.
 */
export function normalizeApprovalRequest(
  toolCall: { callId: string; name: string },
  input: unknown,
  request: ApprovalRequest
): ApprovalRequest {
  const existingIndex = request.toolCalls.findIndex(
    (pending) => pending.callId === toolCall.callId
  );

  if (existingIndex >= 0) {
    return {
      completedResults: request.completedResults,
      toolCalls: request.toolCalls.map((pending, index) =>
        index === existingIndex
          ? {
              ...pending,
              input,
              name: toolCall.name,
            }
          : pending
      ),
    };
  }

  return {
    completedResults: request.completedResults,
    toolCalls: [
      ...request.toolCalls,
      {
        callId: toolCall.callId,
        decisions: [...DEFAULT_APPROVAL_DECISIONS],
        input,
        message: `Approve tool "${toolCall.name}"?`,
        name: toolCall.name,
      },
    ],
  };
}

/**
 * True when the error is the `invalid_approval_request` runtime error raised
 * for a malformed or misused `aroundTool` approval (e.g. requesting approval
 * after `next()` already ran). These are extension programming errors and
 * propagate out of the batch instead of becoming tool-failure results.
 */
export function isApprovalRequestValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "invalid_approval_request"
  );
}

/** Type guard narrowing a `Promise.allSettled` entry to a rejection. */
export function isRejectedPromiseResult(
  result: PromiseSettledResult<unknown>
): result is PromiseRejectedResult {
  return result.status === "rejected";
}

/**
 * Evaluates a tool's declarative approval policy (framework spec §8.4):
 * a boolean is returned as-is, a function policy is invoked with the
 * validated input and the tool's execution context.
 *
 * @returns `true` when the invocation must pause for host approval.
 */
export async function evaluateApprovalPolicy(
  policy: NonNullable<TuvrenToolDefinition["approval"]>,
  input: unknown,
  context: ToolExecutionContext
): Promise<boolean> {
  return typeof policy === "function" ? await policy(input, context) : policy;
}

/**
 * Validates a tool's output value against its declared `outputSchema`
 * (AX001).
 *
 * Supports both schema flavors from framework spec §8.2: a custom schema
 * object exposing `validate()` (whose returned `value` may be a coerced or
 * transformed copy), or a plain JSON Schema compiled with Ajv (in which case
 * `value` is the input untouched). A `validate()` implementation that throws
 * is reported as a validation failure, not an execution error.
 *
 * @returns `{ valid: true, value }` with the value to forward, or
 *   `{ valid: false, details }` with validator diagnostics.
 */
export function validateToolOutput(
  schema: NonNullable<TuvrenToolDefinition["outputSchema"]>,
  output: unknown
):
  | { details?: unknown; valid: true; value: unknown }
  | { details?: unknown; valid: false } {
  if (
    schema !== null &&
    typeof schema === "object" &&
    "validate" in schema &&
    typeof schema.validate === "function"
  ) {
    let result: ReturnType<typeof schema.validate>;

    try {
      result = schema.validate(output);
    } catch (error: unknown) {
      return {
        details: { error: normalizeError(error).message },
        valid: false,
      };
    }

    return result.valid
      ? { valid: true, value: result.value }
      : { details: result.error, valid: false };
  }

  const validator = getCompiledValidator(schema);
  const valid = validator(output);

  if (valid) {
    return { valid: true, value: output };
  }

  return { details: formatAjvErrors(validator.errors), valid: false };
}

/**
 * Validates a tool-call input against the tool's `inputSchema` (framework
 * spec §8.6 step 2; re-run on the resume path for `edit` decisions).
 *
 * Same dual-flavor semantics as {@link validateToolOutput}: custom
 * `validate()` schemas may return a coerced `value`, Ajv-compiled JSON
 * Schemas return the original input. Compiled validators are cached per
 * schema object (see `getCompiledValidator`), so repeated invocations of the
 * same tool do not recompile.
 *
 * @returns `{ valid: true, value }` with the value the tool should execute
 *   with, or `{ valid: false, details }` with validator diagnostics.
 */
export function validateToolInput(
  tool: TuvrenToolDefinition,
  input: unknown
):
  | { details?: unknown; valid: true; value: unknown }
  | { details?: unknown; valid: false } {
  const schema = tool.inputSchema;

  if (
    schema !== null &&
    typeof schema === "object" &&
    "validate" in schema &&
    typeof schema.validate === "function"
  ) {
    let result: ReturnType<typeof schema.validate>;

    try {
      result = schema.validate(input);
    } catch (error: unknown) {
      return {
        details: {
          error: normalizeError(error).message,
        },
        valid: false,
      };
    }

    return result.valid
      ? { valid: true, value: result.value }
      : { details: result.error, valid: false };
  }

  const validator = getCompiledValidator(schema);
  const valid = validator(input);

  if (valid) {
    return {
      valid: true,
      value: input,
    };
  }

  return {
    details: formatAjvErrors(validator.errors),
    valid: false,
  };
}

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
export function applyApprovalDecisionMetadata(
  result: ToolResultPart,
  decision: ApprovalDecision | undefined,
  audit: EditedApprovalAudit | undefined
): ToolResultPart {
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
}

/**
 * Builds the canonical `isError: true` result for a pending call the host
 * rejected (or answered with an unrecognized decision type). The output
 * carries the decision type and either the host's message or a default
 * rejection message; the call is never executed (framework spec §4.8).
 */
export function createRejectedToolResult(
  toolCall: PendingToolCall,
  decision: ApprovalDecision
): ToolResultPart {
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
}

/**
 * Builds the `isError: true` result for a call whose execution (or
 * `aroundTool` chain) threw after exhausting its retry budget. The error
 * message is surfaced in `output.error`, with approval provenance attached
 * when the call ran under a host decision. Tool failures become results —
 * they never fail the run (framework spec §8.6).
 */
export function createExecutionFailureResult(
  toolCall: ToolCallPart,
  error: unknown,
  decision: ApprovalDecision | undefined,
  audit: EditedApprovalAudit | undefined
): ToolResultPart {
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
}

/**
 * Builds a generic `isError: true` result for a call decided without
 * execution — unknown tool, capability-policy denial, or a malformed resume
 * decision. `details` lands next to `output.error` when provided, and
 * approval provenance is attached when a host decision led here.
 */
export function createErrorToolResult(
  toolCall: ToolCallPart,
  message: string,
  details?: unknown,
  decision?: ApprovalDecision,
  audit?: EditedApprovalAudit
): ToolResultPart {
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
}

/**
 * Builds an `isError: true` result carrying a machine-readable `output.code`
 * for typed rejections: `TOOL_INPUT_VALIDATION_FAILED`,
 * `TOOL_RESULT_VALIDATION_FAILED`, and `TOOL_INVOCATION_RATE_LIMITED`.
 * Validator diagnostics ride in `output.details`, and approval provenance is
 * attached on the resume path.
 */
export function createValidationErrorToolResult(
  toolCall: ToolCallPart,
  code: string,
  message: string,
  details?: unknown,
  decision?: ApprovalDecision,
  audit?: EditedApprovalAudit
): ToolResultPart {
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
}

/**
 * Derives the {@link ApprovalResultMetadata} for a result produced under a
 * host decision. `edit` decisions always yield metadata (with cloned
 * original/edited inputs when an audit is available); other decision types
 * yield metadata only when the host attached a message. Returns `undefined`
 * when there is nothing worth recording.
 */
function createApprovalResultMetadata(
  decision: ApprovalDecision | undefined,
  audit: EditedApprovalAudit | undefined
): ApprovalResultMetadata | undefined {
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
}

/**
 * Durably stages one tool result and then publishes its `tool.result` event.
 *
 * Waits on the wave's start barrier first, enforcing the §6.4 invariant that
 * no `tool.result` of a wave is emitted before every `tool.start` of that
 * wave. `environment.sanitizeToolResult` (ADR-064), when configured, is
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
 *   input-validation failure, policy denial, resume rejection) per ADR-064 §3.
 * @returns The staged (sanitized) result paired with its content hash. The
 *   returned `result` — not the caller's input — is what was durably staged
 *   and emitted; callers must thread it into every in-memory downstream
 *   consumer (batch outcomes, after-iteration hooks) so the in-memory view
 *   never diverges from durable state.
 */
export async function stageAndEmitResult(
  environment: ToolBatchEnvironment,
  result: ToolResultPart,
  orderIndex: number,
  startBarrier: ToolStartBarrier,
  executionClass?: ExecutionClass
): Promise<StagedToolResult> {
  await startBarrier.waitUntilReady();
  const sanitized = applySanitizeToolResult(
    environment,
    result,
    executionClass
  );
  const hash = await environment.stageResult(sanitized, orderIndex);
  emitToolResultEvent(environment, sanitized);
  return { hash, result: sanitized };
}

/**
 * Sequentially stages and emits several results that share one order index —
 * e.g. the `completedResults` accompanying an approval pause.
 *
 * @param executionClass - See {@link stageAndEmitResult}; applies to every
 *   result in `results`.
 * @returns Staged (sanitized) results, index-aligned with `results`.
 */
export async function stageAndEmitResults(
  environment: ToolBatchEnvironment,
  results: ToolResultPart[],
  orderIndex: number,
  startBarrier: ToolStartBarrier,
  executionClass?: ExecutionClass
): Promise<StagedToolResult[]> {
  const staged: StagedToolResult[] = [];

  for (const result of results) {
    staged.push(
      await stageAndEmitResult(
        environment,
        result,
        orderIndex,
        startBarrier,
        executionClass
      )
    );
  }

  return staged;
}

/**
 * Applies the host's {@link ToolBatchEnvironment.sanitizeToolResult} hook
 * (ADR-064) to a would-be-staged result, if one is configured.
 *
 * A no-op when the hook is absent — byte-identical behavior to today.
 * Delegates the actual hook application (context construction, identity
 * re-stamp, throw handling) to {@link applySanitizeHookToPart}, the same
 * pure helper the pre-staged-provider staging path in
 * `runtime-core-iteration.ts` uses — one shared implementation, two
 * application sites (the Tool Execution Gateway chokepoint here, and the
 * AY003 pre-staged provider message path), per ADR-064 §3.
 */
function applySanitizeToolResult(
  environment: ToolBatchEnvironment,
  result: ToolResultPart,
  executionClass: ExecutionClass | undefined
): ToolResultPart {
  const hook = environment.sanitizeToolResult;

  if (hook === undefined) {
    return result;
  }

  return applySanitizeHookToPart(hook, result, executionClass);
}

/**
 * Pure application of the ADR-064 host sanitization hook to a single
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
export function applySanitizeHookToPart(
  hook: SanitizeToolResultHook,
  result: ToolResultPart,
  executionClass: ExecutionClass | undefined
): ToolResultPart {
  const context: SanitizeToolResultContext = {
    callId: result.callId,
    toolName: result.name,
    ...(executionClass === undefined ? {} : { executionClass }),
  };

  try {
    const sanitized = hook(result, context);
    return {
      ...sanitized,
      callId: result.callId,
      name: result.name,
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
}

/**
 * Stages and emits the batch's immediate (non-executing) outcomes — unknown
 * tool, invalid input, policy denial, resume rejections — recording each
 * under its original call index in `orderedResults`.
 *
 * The start barrier still gates emission: with executable siblings present,
 * immediate `tool.result` events wait for the first wave's `tool.start`
 * events; with none, callers pass a zero-count (already-ready) barrier.
 */
export async function stageImmediateResults(
  environment: ToolBatchEnvironment,
  immediateResults: ToolResultPart[][],
  orderedResults: StagedToolResult[][],
  startBarrier: ToolStartBarrier
): Promise<void> {
  for (const [index, results] of immediateResults.entries()) {
    if (results.length === 0) {
      continue;
    }

    const staged = await stageAndEmitResults(
      environment,
      results,
      index,
      startBarrier
    );
    orderedResults[index].push(...staged);
  }
}

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
export async function stageImmediateResultsWhileExecuting(
  environment: ToolBatchEnvironment,
  immediateResults: ToolResultPart[][],
  orderedResults: StagedToolResult[][],
  executable: OrderedExecutableToolCall[],
  executeConcurrent: (
    executableCalls: OrderedExecutableToolCall[],
    scopedEnvironment: ToolBatchEnvironment,
    startBarrier: ToolStartBarrier
  ) => Promise<SingleToolOutcome[]>
): Promise<SingleToolOutcome[]> {
  const startBarrier = createToolStartBarrier(
    Math.min(executable.length, environment.maxParallelToolCalls)
  );
  const executablePromise = executeConcurrent(
    executable,
    environment,
    startBarrier
  ).then(
    (outcomes) => ({ outcomes, rejected: false as const }),
    (error: unknown) => ({ error, rejected: true as const })
  );

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
}

/**
 * Appends an extension's returned `state` (if any) to the updates gathered
 * from nested `aroundTool` layers, tagging it with the extension name so the
 * iteration checkpoint can merge it into the right manifest slice.
 */
export function collectExtensionStateUpdate(
  extensionName: string,
  state: Record<string, unknown> | undefined,
  nestedUpdates: ExtensionStateUpdate[]
): ExtensionStateUpdate[] {
  if (state === undefined) {
    return nestedUpdates;
  }

  return [...nestedUpdates, { extensionName, state }];
}

/**
 * Collects the `aroundTool` handlers that apply to a given tool, in extension
 * registration order (which is the chain's outermost-to-innermost order).
 *
 * An extension's `aroundTool` may be a bare handler function (applies to
 * every tool, invoked with the extension as receiver) or a
 * `{ tools, handler }` spec (applies only to the listed tool names, invoked
 * with the spec as receiver). Each entry carries the extension's `timeout`
 * for per-handler timeout enforcement in the chain.
 */
export function getAroundToolHandlers(
  extensions: TuvrenExtension[],
  toolName: string
): Array<{
  extensionName: string;
  handler: (
    context: AroundToolContext,
    next: (context?: AroundToolContext) => Promise<ToolResultPart>
  ) => Promise<AroundToolResult> | AroundToolResult;
  receiver: object;
  timeout?: number;
}> {
  const handlers: Array<{
    extensionName: string;
    handler: (
      context: AroundToolContext,
      next: (context?: AroundToolContext) => Promise<ToolResultPart>
    ) => Promise<AroundToolResult> | AroundToolResult;
    receiver: object;
    timeout?: number;
  }> = [];

  for (const extension of extensions) {
    const spec = extension.aroundTool;

    if (spec === undefined) {
      continue;
    }

    if (typeof spec === "function") {
      handlers.push({
        extensionName: extension.name,
        handler: spec,
        receiver: extension,
        timeout: extension.timeout,
      });
      continue;
    }

    if (spec.tools.includes(toolName)) {
      handlers.push({
        extensionName: extension.name,
        handler: spec.handler,
        receiver: spec,
        timeout: extension.timeout,
      });
    }
  }

  return handlers;
}

/**
 * Normalizes the value returned by an `aroundTool` handler into a
 * {@link RawSingleToolOutcome}, enforcing the handler contract.
 *
 * - Pause verdict (`{ verdict: "pause", approval }`): rejected with an
 *   `invalid_approval_request` error if the handler already called `next()`
 *   (approval must be requested before execution). Otherwise the approval
 *   request is normalized to include this call, validated via
 *   `assertApprovalRequest`, and returned as an approval outcome after the
 *   call is marked as never-starting for the wave barrier.
 * - `{ result, state }`: the substituted result is returned and `state` is
 *   collected; `tool.start` is emitted first if the handler short-circuited
 *   without calling `next()` (the framework still entered execution for this
 *   call).
 * - A bare `ToolResultPart` identical to the nested `next()` result passes
 *   through with the accumulated updates; a different part is treated as a
 *   substitution and likewise triggers `tool.start` emission when needed.
 */
export function normalizeAroundToolResult(
  extensionName: string,
  result: AroundToolResult,
  nestedUpdates: ExtensionStateUpdate[],
  nestedResult: ToolResultPart | undefined,
  context: AroundToolContext,
  environment: ToolBatchEnvironment,
  toolStartState: ToolStartState,
  startBarrier: ToolStartBarrier
): Promise<RawSingleToolOutcome> {
  if (isPauseResult(result)) {
    if (nestedResult !== undefined) {
      return Promise.reject(
        new TuvrenRuntimeError(
          `aroundTool extension "${extensionName}" must request approval before calling next()`,
          {
            code: "invalid_approval_request",
            details: {
              callId: context.callId,
              extensionName,
              toolName: context.tool.name,
            },
          }
        )
      );
    }

    return settleToolStartIfNeeded(toolStartState, startBarrier).then(() => {
      const approval = normalizeApprovalRequest(
        context.toolCall,
        context.input,
        result.approval
      );
      assertApprovalRequest(
        approval,
        `aroundTool approval from extension "${extensionName}"`
      );

      return {
        approval,
        updates: collectExtensionStateUpdate(
          extensionName,
          result.state,
          nestedUpdates
        ),
      };
    });
  }

  if (isResultWithState(result)) {
    return emitToolStartIfNeeded(
      toExecutableToolCall(
        {
          approvalDecision: context.approvalDecision,
          input: context.input,
          tool: context.tool,
          toolCall: context.toolCall,
        },
        undefined
      ),
      environment,
      toolStartState,
      startBarrier
    ).then(() => ({
      result: result.result,
      updates: collectExtensionStateUpdate(
        extensionName,
        result.state,
        nestedUpdates
      ),
    }));
  }

  if (nestedResult !== undefined && result === nestedResult) {
    return Promise.resolve({
      result,
      updates: nestedUpdates,
    });
  }

  return emitToolStartIfNeeded(
    toExecutableToolCall(
      {
        approvalDecision: context.approvalDecision,
        input: context.input,
        tool: context.tool,
        toolCall: context.toolCall,
      },
      undefined
    ),
    environment,
    toolStartState,
    startBarrier
  ).then(() => ({
    result,
    updates: nestedUpdates,
  }));
}

/**
 * Creates a countdown latch over `totalCalls` calls (see
 * {@link ToolStartBarrier}). A count of `0` yields an immediately-ready
 * barrier; extra `markSettled` calls beyond the count are ignored.
 */
export function createToolStartBarrier(totalCalls: number): ToolStartBarrier {
  let pendingCalls = totalCalls;
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;

    if (pendingCalls === 0) {
      resolve();
    }
  });

  return {
    markSettled() {
      if (pendingCalls === 0) {
        return;
      }

      pendingCalls -= 1;

      if (pendingCalls === 0) {
        resolveReady?.();
      }
    },
    async waitUntilReady() {
      await ready;
    },
  };
}

/**
 * Marks a call as settled without emitting `tool.start` — used when a call
 * pauses for approval or fails before execution begins. Waits for the call's
 * turn (so start ordering stays intact for siblings), decrements the wave
 * barrier, and releases the next call's turn; no-op when the call already
 * emitted or settled.
 */
export async function settleToolStartIfNeeded(
  toolStartState: ToolStartState,
  startBarrier: ToolStartBarrier
): Promise<void> {
  if (toolStartState.settled) {
    return;
  }

  await toolStartState.waitForTurn();

  if (toolStartState.settled) {
    return;
  }

  toolStartState.settled = true;
  startBarrier.markSettled();
  toolStartState.releaseTurn();
}

/**
 * Combines two optional abort signals into one that aborts when either does
 * (`AbortSignal.any`); returns the present one when only one exists, or
 * `undefined` when neither does. Used to compose the batch signal with
 * per-call timeout signals.
 */
export function composeAbortSignals(
  left: AbortSignal | undefined,
  right: AbortSignal | undefined
): AbortSignal | undefined {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return AbortSignal.any([left, right]);
}

/**
 * Deep-clones a value with `structuredClone`. Used to hand isolated
 * snapshots to `aroundTool` handlers; values containing functions must use
 * `cloneSnapshotPreservingFunctions` instead.
 */
export function cloneValue<T>(value: T): T {
  return globalThis.structuredClone(value);
}

/** Coerces an arbitrary thrown value into an `Error`, stringifying non-errors. */
export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Type guard for decisions that lead to execution (`approve` or `edit`);
 * `reject` and unknown decision types fail the guard and produce rejection
 * results instead.
 */
export function isExecutableApprovalDecision(
  decision: ApprovalDecision
): decision is ApprovalDecision & { type: "approve" | "edit" } {
  return decision.type === "approve" || decision.type === "edit";
}

/**
 * Type guard for the `aroundTool` pause verdict
 * (`{ verdict: "pause", approval }`), the imperative approval-gating
 * mechanism of framework spec §8.4/§8.7.
 */
export function isPauseResult(
  result: AroundToolResult
): result is Extract<AroundToolResult, { verdict: "pause" }> {
  return "verdict" in result && result.verdict === "pause";
}

/**
 * Type guard for the `{ result, state }` form of `AroundToolResult`, where a
 * handler returns a result part together with an extension-state update.
 */
export function isResultWithState(
  result: AroundToolResult
): result is Extract<AroundToolResult, { result: ToolResultPart }> {
  return "result" in result;
}

/**
 * Compiles a JSON Schema with the module's shared Ajv instance, memoizing
 * object schemas in a `WeakMap` so each tool schema compiles at most once.
 * Boolean schemas (valid JSON Schema) are compiled fresh since they cannot
 * key a WeakMap.
 */
function getCompiledValidator(
  schema: TuvrenToolDefinition["inputSchema"]
): ValidateFunction {
  if (typeof schema === "boolean") {
    return ajv.compile(schema);
  }

  const cached = validatorCache.get(schema);

  if (cached !== undefined) {
    return cached;
  }

  const validator = ajv.compile(schema);
  validatorCache.set(schema, validator);
  return validator;
}

/**
 * Projects Ajv error objects to a stable, serializable diagnostic shape for
 * validation-failure `output.details`.
 */
function formatAjvErrors(errors: ErrorObject[] | null | undefined): unknown {
  return errors?.map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message,
    params: error.params,
    schemaPath: error.schemaPath,
  }));
}

/**
 * Publishes the `tool.result` stream event for a staged result, attaching
 * capability attribution when the tool is still resolvable from the registry
 * (immediate error results for unregistered tools have no attribution).
 */
function emitToolResultEvent(
  environment: ToolBatchEnvironment,
  result: ToolResultPart
): void {
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
}

/**
 * Emits a `tool.audit` lifecycle event carrying only structural lineage keys
 * — no input, output, or metadata values that could contain secret material
 * (AX005).
 *
 * Lifecycle values emitted by the gateway are `input_validated`,
 * `output_validated` (both with `validationPassed`), `policy_denied`,
 * `rate_limited`, and `retry_attempt` (with the 1-based `attempt` count).
 * Callers must not invoke this for tuvren-client tools, whose `canAudit` is
 * false (KRT-AZ005); the execution class defaults to `tuvren-server` when the
 * tool is no longer resolvable from the registry.
 */
export function emitToolAuditEvent(
  environment: ToolBatchEnvironment,
  callId: string,
  toolName: string,
  lifecycle: import("@tuvren/core/events").ToolAuditEvent["lifecycle"],
  extras?: {
    attempt?: number;
    validationPassed?: boolean;
  }
): void {
  const tool = environment.toolRegistry.get(toolName);
  const executionClass =
    tool === undefined
      ? ("tuvren-server" as const)
      : buildToolAttribution(tool).executionClass;

  const event: import("@tuvren/core/events").ToolAuditEvent = {
    callId,
    capabilityId: toolName,
    executionClass,
    lifecycle,
    runId: environment.runId,
    timestamp: environment.now(),
    turnId: environment.turnId,
    type: "tool.audit",
  };

  if (extras?.attempt !== undefined) {
    event.attempt = extras.attempt;
  }

  if (extras?.validationPassed !== undefined) {
    event.validationPassed = extras.validationPassed;
  }

  environment.publishEvent(event);
}

/** Returns the value as a plain record, or `{}` for non-record values. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

/** Deep-clones a value into a plain record, yielding `{}` for non-records. */
function cloneRecord(value: unknown): Record<string, unknown> {
  return asRecord(cloneValue(asRecord(value)));
}
