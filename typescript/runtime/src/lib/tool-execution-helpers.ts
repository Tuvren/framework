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
import type {
  EventSource,
  ToolAuditEvent,
  TuvrenStreamEvent,
} from "@tuvren/core/events";
import type {
  AroundToolContext,
  AroundToolResult,
  TuvrenExtension,
} from "@tuvren/core/extensions";
import type { ToolCallPart, ToolResultPart } from "@tuvren/core/messages";
import type {
  ApprovalRequest,
  PendingToolCall,
  ToolExecutionContext,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";
import { assertApprovalRequest } from "@tuvren/core/tools";

import { buildToolAttribution } from "./capability-attribution.js";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import { deriveIdempotencyKey } from "./idempotency-identity.js";
import { cloneSnapshotPreservingFunctions } from "./runtime-core-shared.js";
import type {
  ExecutableToolCall,
  RawSingleToolOutcome,
  ToolBatchEnvironment,
  ToolStartBarrier,
  ToolStartState,
} from "./tool-execution.js";

/** Decision types offered to the host for every pending approval. */
const DEFAULT_APPROVAL_DECISIONS = ["approve", "edit", "reject"];

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
export class ToolPauseSignalError extends Error {
  readonly approval: ApprovalRequest;
  readonly updates: ExtensionStateUpdate[];

  constructor(approval: ApprovalRequest, updates: ExtensionStateUpdate[]) {
    super("tool execution paused");
    this.name = "ToolPauseSignalError";
    this.approval = approval;
    this.updates = updates;
  }
}

/** Coerces an arbitrary thrown value into an `Error`, stringifying non-errors. */
export const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * Wraps a {@link ToolBatchEnvironment} with a fence composed from the
 * environment's own signal and a batch-level abort signal.
 *
 * Once the fence aborts, `publishEvent`, `publishCustom`, and
 * `reportSoftError` become silent no-ops, and `stageResult` throws the abort
 * reason both before and after the underlying staging call — the
 * commit-under-valid-authority gate of ADR-0052 / KRT-BG004: a result produced
 * after execution authority is lost (lease loss, cancellation, wall-clock
 * deadline, or sibling batch failure) is never committed to durable history
 * under the dead owner.
 *
 * @param batchSignal - Signal aborted when any sibling call in the parallel
 *   batch fails (see `executeConcurrentToolCalls`).
 * @returns A shallow copy of the environment with fenced publication and
 *   staging seams and `signal` set to the composed fence signal.
 */
export const createBatchScopedEnvironment = (
  environment: ToolBatchEnvironment,
  batchSignal: AbortSignal
): ToolBatchEnvironment => {
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
    async stageResult(result, orderIndex, updates = []) {
      // Commit-under-valid-authority gate (ADR-0052: a result becomes durable
      // state only through a commit performed while the run still holds write
      // authority). The fence signal aborts on lease loss, cancellation, or the
      // wall-clock deadline, so a result produced after authority is lost is not
      // committed to history under the dead owner. (KRT-BG004)
      throwIfAborted();
      const hash = await environment.stageResult(result, orderIndex, updates);
      throwIfAborted();
      return hash;
    },
  };
};

/**
 * Builds the `ToolExecutionContext` handed to `tool.execute` (and to
 * declarative approval-policy functions, framework spec §8.3/§8.4).
 *
 * `emit`/`forward` publish onto the turn stream but become no-ops once
 * `timeoutSignal` aborts, so a timed-out tool cannot keep emitting events.
 * `idempotencyKey` is derived from `(turnId, callId)` — the logical call
 * identity, which survives retries, approval resumes, and recovery — so
 * external systems can deduplicate a side effect re-dispatched under a new
 * Run or a new execution owner (ADR-0052 side-effect-once as amended by
 * ADR-0065; see `deriveIdempotencyKey` in idempotency-identity.ts). Tool
 * `metadata` is
 * deep-cloned (preserving functions) so the tool cannot mutate the registry's
 * definition, and `signal` falls back to the batch signal when no per-call
 * timeout signal exists.
 */
export const createToolExecutionContext = (
  toolCall: ToolCallPart,
  tool: TuvrenToolDefinition,
  environment: ToolBatchEnvironment,
  timeoutSignal: AbortSignal | undefined
): ToolExecutionContext => ({
  callId: toolCall.callId,
  emit: (event: { data: unknown; name: string }) => {
    if (timeoutSignal?.aborted === true) {
      return;
    }

    environment.publishCustom(event);
  },
  forward: (event: TuvrenStreamEvent, source: EventSource) => {
    if (timeoutSignal?.aborted === true) {
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
});

/** Returns the value as a plain record, or `{}` for non-record values. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

/**
 * Deep-clones a value with `structuredClone`. Used to hand isolated
 * snapshots to `aroundTool` handlers; values containing functions must use
 * `cloneSnapshotPreservingFunctions` instead.
 */
export const cloneValue = <T>(value: T): T => globalThis.structuredClone(value);

/** Deep-clones a value into a plain record, yielding `{}` for non-records. */
const cloneRecord = (value: unknown): Record<string, unknown> =>
  asRecord(cloneValue(asRecord(value)));

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
export const createAroundToolContext = (
  toolCall: ExecutableToolCall,
  extensionName: string,
  environment: ToolBatchEnvironment,
  sharedExports: Record<string, Record<string, unknown>>,
  timeoutSignal: AbortSignal | undefined
): AroundToolContext => ({
  approvalDecision: toolCall.approvalDecision,
  callId: toolCall.toolCall.callId,
  emit: (event: { data: unknown; name: string }) => {
    if (timeoutSignal?.aborted === true) {
      return;
    }

    environment.publishCustom(event);
  },
  extensionState: cloneRecord(environment.manifest.extensions[extensionName]),
  forward: (event: TuvrenStreamEvent, source: EventSource) => {
    if (timeoutSignal?.aborted === true) {
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
});

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
export const toExecutableToolCall = (
  base: ExecutableToolCall,
  nextContext?: AroundToolContext
): ExecutableToolCall => {
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
};

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
export const emitToolStartIfNeeded = async (
  toolCall: ExecutableToolCall,
  environment: ToolBatchEnvironment,
  toolStartState: ToolStartState,
  startBarrier: ToolStartBarrier
): Promise<void> => {
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
};

/**
 * Builds the `PendingToolCall` entry for a call awaiting host approval,
 * offering the default decision set (`approve`, `edit`, `reject`).
 *
 * @param input - The validated input the call would execute with.
 * @param message - Optional prompt override (e.g. the policy engine's
 *   `requiresApproval` reason).
 * The default message is `Approve tool "<name>"?`.
 */
export const createPendingToolCall = (
  toolCall: { callId: string; name: string },
  input: unknown,
  message?: string
): PendingToolCall => ({
  callId: toolCall.callId,
  decisions: [...DEFAULT_APPROVAL_DECISIONS],
  input,
  message: message ?? `Approve tool "${toolCall.name}"?`,
  name: toolCall.name,
});

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
export const normalizeApprovalRequest = (
  toolCall: { callId: string; name: string },
  input: unknown,
  request: ApprovalRequest
): ApprovalRequest => {
  const existingIndex = request.toolCalls.findIndex(
    (pending) => pending.callId === toolCall.callId
  );

  if (existingIndex !== -1) {
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
};

/**
 * True when the error is the `invalid_approval_request` runtime error raised
 * for a malformed or misused `aroundTool` approval (e.g. requesting approval
 * after `next()` already ran). These are extension programming errors and
 * propagate out of the batch instead of becoming tool-failure results.
 */
export const isApprovalRequestValidationError = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  error.code === "invalid_approval_request";

/** Type guard narrowing a `Promise.allSettled` entry to a rejection. */
export const isRejectedPromiseResult = (
  result: PromiseSettledResult<unknown>
): result is PromiseRejectedResult => result.status === "rejected";

/**
 * Evaluates a tool's declarative approval policy (framework spec §8.4):
 * a boolean is returned as-is, a function policy is invoked with the
 * validated input and the tool's execution context.
 *
 * @returns `true` when the invocation must pause for host approval.
 */
export const evaluateApprovalPolicy = async (
  policy: NonNullable<TuvrenToolDefinition["approval"]>,
  input: unknown,
  context: ToolExecutionContext
): Promise<boolean> =>
  typeof policy === "function" ? await policy(input, context) : policy;

/**
 * Appends an extension's returned `state` (if any) to the updates gathered
 * from nested `aroundTool` layers, tagging it with the extension name so the
 * iteration checkpoint can merge it into the right manifest slice.
 */
export const collectExtensionStateUpdate = (
  extensionName: string,
  state: Record<string, unknown> | undefined,
  nestedUpdates: ExtensionStateUpdate[]
): ExtensionStateUpdate[] => {
  if (state === undefined) {
    return nestedUpdates;
  }

  return [...nestedUpdates, { extensionName, state }];
};

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
export const getAroundToolHandlers = (
  extensions: TuvrenExtension[],
  toolName: string
): {
  extensionName: string;
  handler: (
    context: AroundToolContext,
    next: (context?: AroundToolContext) => Promise<ToolResultPart>
  ) => Promise<AroundToolResult> | AroundToolResult;
  receiver: object;
  timeout?: number;
}[] => {
  const handlers: {
    extensionName: string;
    handler: (
      context: AroundToolContext,
      next: (context?: AroundToolContext) => Promise<ToolResultPart>
    ) => Promise<AroundToolResult> | AroundToolResult;
    receiver: object;
    timeout?: number;
  }[] = [];

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
};

/**
 * Type guard for the `aroundTool` pause verdict
 * (`{ verdict: "pause", approval }`), the imperative approval-gating
 * mechanism of framework spec §8.4/§8.7.
 */
export const isPauseResult = (
  result: AroundToolResult
): result is Extract<AroundToolResult, { verdict: "pause" }> =>
  "verdict" in result && result.verdict === "pause";

/**
 * Marks a call as settled without emitting `tool.start` — used when a call
 * pauses for approval or fails before execution begins. Waits for the call's
 * turn (so start ordering stays intact for siblings), decrements the wave
 * barrier, and releases the next call's turn; no-op when the call already
 * emitted or settled.
 */
export const settleToolStartIfNeeded = async (
  toolStartState: ToolStartState,
  startBarrier: ToolStartBarrier
): Promise<void> => {
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
};

/**
 * Type guard for the `{ result, state }` form of `AroundToolResult`, where a
 * handler returns a result part together with an extension-state update.
 */
export const isResultWithState = (
  result: AroundToolResult
): result is Extract<AroundToolResult, { result: ToolResultPart }> =>
  "result" in result;

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
export const normalizeAroundToolResult = async (
  extensionName: string,
  result: AroundToolResult,
  nestedUpdates: ExtensionStateUpdate[],
  nestedResult: ToolResultPart | undefined,
  context: AroundToolContext,
  environment: ToolBatchEnvironment,
  toolStartState: ToolStartState,
  startBarrier: ToolStartBarrier
): Promise<RawSingleToolOutcome> => {
  if (isPauseResult(result)) {
    if (nestedResult !== undefined) {
      throw new TuvrenRuntimeError(
        `aroundTool extension "${extensionName}" must request approval before calling next()`,
        {
          code: "invalid_approval_request",
          details: {
            callId: context.callId,
            extensionName,
            toolName: context.tool.name,
          },
        }
      );
    }

    await settleToolStartIfNeeded(toolStartState, startBarrier);
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
  }

  if (isResultWithState(result)) {
    await emitToolStartIfNeeded(
      toExecutableToolCall({
        approvalDecision: context.approvalDecision,
        input: context.input,
        tool: context.tool,
        toolCall: context.toolCall,
      }),
      environment,
      toolStartState,
      startBarrier
    );
    return {
      result: result.result,
      updates: collectExtensionStateUpdate(
        extensionName,
        result.state,
        nestedUpdates
      ),
    };
  }

  if (nestedResult !== undefined && result === nestedResult) {
    return {
      result,
      updates: nestedUpdates,
    };
  }

  await emitToolStartIfNeeded(
    toExecutableToolCall({
      approvalDecision: context.approvalDecision,
      input: context.input,
      tool: context.tool,
      toolCall: context.toolCall,
    }),
    environment,
    toolStartState,
    startBarrier
  );
  return {
    result,
    updates: nestedUpdates,
  };
};

/**
 * Combines two optional abort signals into one that aborts when either does
 * (`AbortSignal.any`); returns the present one when only one exists, or
 * `undefined` when neither does. Used to compose the batch signal with
 * per-call timeout signals.
 */
export const composeAbortSignals = (
  left: AbortSignal | undefined,
  right: AbortSignal | undefined
): AbortSignal | undefined => {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return AbortSignal.any([left, right]);
};

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
export const emitToolAuditEvent = (
  environment: ToolBatchEnvironment,
  callId: string,
  toolName: string,
  lifecycle: ToolAuditEvent["lifecycle"],
  extras?: {
    attempt?: number;
    validationPassed?: boolean;
  }
): void => {
  const tool = environment.toolRegistry.get(toolName);
  const executionClass =
    tool === undefined
      ? ("tuvren-server" as const)
      : buildToolAttribution(tool).executionClass;

  const event: ToolAuditEvent = {
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
};
