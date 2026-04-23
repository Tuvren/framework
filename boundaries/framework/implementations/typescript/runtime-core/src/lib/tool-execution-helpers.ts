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

import { type HashString, TuvrenRuntimeError } from "@tuvren/core-types";
import type {
  ApprovalDecision,
  ApprovalRequest,
  AroundToolContext,
  AroundToolResult,
  EventSource,
  PendingToolCall,
  ToolCallPart,
  ToolExecutionContext,
  ToolResultPart,
  TuvrenExtension,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
} from "@tuvren/runtime-api";
import { assertApprovalRequest } from "@tuvren/runtime-api";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv from "ajv";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import { cloneSnapshotPreservingFunctions } from "./runtime-core-shared.js";
import type {
  ExecutableToolCall,
  OrderedExecutableToolCall,
  RawSingleToolOutcome,
  SingleToolOutcome,
  StagedToolResult,
  ToolBatchEnvironment,
  ToolStartBarrier,
  ToolStartState,
} from "./tool-execution.js";

const DEFAULT_APPROVAL_DECISIONS = ["approve", "edit", "reject"];
const ajv = new Ajv({
  allErrors: true,
  strict: false,
});
const validatorCache = new WeakMap<object, ValidateFunction>();

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
      throwIfAborted();
      const hash = await environment.stageResult(result, orderIndex);
      throwIfAborted();
      return hash;
    },
  };
}

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
    metadata:
      tool.metadata === undefined
        ? undefined
        : cloneSnapshotPreservingFunctions(tool.metadata),
    name: tool.name,
    signal: timeoutSignal ?? environment.signal,
  };
}

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

export function toExecutableToolCall(
  base: ExecutableToolCall,
  nextContext: AroundToolContext | undefined
): ExecutableToolCall {
  if (nextContext === undefined) {
    return base;
  }

  return {
    approvalDecision: nextContext.approvalDecision ?? base.approvalDecision,
    input: nextContext.input,
    tool: nextContext.tool,
    toolCall: nextContext.toolCall,
  };
}

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
    callId: toolCall.toolCall.callId,
    input: toolCall.input,
    name: toolCall.tool.name,
    timestamp: environment.now(),
    type: "tool.start",
  });
  startBarrier.markSettled();
  toolStartState.releaseTurn();
}

export function createPendingToolCall(
  toolCall: { callId: string; name: string },
  input: unknown
): PendingToolCall {
  return {
    callId: toolCall.callId,
    decisions: [...DEFAULT_APPROVAL_DECISIONS],
    input,
    message: `Approve tool "${toolCall.name}"?`,
    name: toolCall.name,
  };
}

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

export function isApprovalRequestValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "invalid_approval_request"
  );
}

export function isRejectedPromiseResult(
  result: PromiseSettledResult<unknown>
): result is PromiseRejectedResult {
  return result.status === "rejected";
}

export async function evaluateApprovalPolicy(
  policy: NonNullable<TuvrenToolDefinition["approval"]>,
  input: unknown,
  context: ToolExecutionContext
): Promise<boolean> {
  return typeof policy === "function" ? await policy(input, context) : policy;
}

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

export function applyApprovalDecisionMetadata(
  result: ToolResultPart,
  decision: ApprovalDecision | undefined
): ToolResultPart {
  if (
    decision === undefined ||
    decision.message === undefined ||
    decision.type === "reject" ||
    !isExecutableApprovalDecision(decision)
  ) {
    return result;
  }

  return {
    ...result,
    output: {
      approval: {
        message: decision.message,
        type: decision.type,
      },
      result: result.output,
    },
  };
}

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

export function createExecutionFailureResult(
  toolCall: ToolCallPart,
  error: unknown,
  decision: ApprovalDecision | undefined
): ToolResultPart {
  const message =
    error instanceof Error ? error.message : `Tool "${toolCall.name}" failed.`;
  const approval =
    decision === undefined
      ? undefined
      : {
          message: decision.message,
          type: decision.type,
        };

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

export function createErrorToolResult(
  toolCall: ToolCallPart,
  message: string,
  details?: unknown,
  decision?: ApprovalDecision
): ToolResultPart {
  const approval =
    decision?.message === undefined
      ? undefined
      : {
          message: decision.message,
          type: decision.type,
        };

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

export async function stageAndEmitResult(
  environment: ToolBatchEnvironment,
  result: ToolResultPart,
  orderIndex: number,
  startBarrier: ToolStartBarrier
): Promise<HashString> {
  await startBarrier.waitUntilReady();
  const hash = await environment.stageResult(result, orderIndex);
  emitToolResultEvent(environment, result);
  return hash;
}

export async function stageAndEmitResults(
  environment: ToolBatchEnvironment,
  results: ToolResultPart[],
  orderIndex: number,
  startBarrier: ToolStartBarrier
): Promise<HashString[]> {
  const hashes: HashString[] = [];

  for (const result of results) {
    hashes.push(
      await stageAndEmitResult(environment, result, orderIndex, startBarrier)
    );
  }

  return hashes;
}

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

    const hashes = await stageAndEmitResults(
      environment,
      results,
      index,
      startBarrier
    );
    orderedResults[index].push(...zipStagedToolResults(results, hashes));
  }
}

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
  const startBarrier = createToolStartBarrier(executable.length);
  const executablePromise = executeConcurrent(
    executable,
    environment,
    startBarrier
  ).then(
    (outcomes) => ({ outcomes, rejected: false as const }),
    (error: unknown) => ({ error, rejected: true as const })
  );

  // Known non-executing outcomes are staged before slower siblings finish so they
  // survive crashes, but they still wait on the start barrier to preserve the
  // contract that every executable tool emits `tool.start` before any `tool.result`.
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

export function cloneValue<T>(value: T): T {
  return globalThis.structuredClone(value);
}

export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function zipStagedToolResults(
  results: ToolResultPart[],
  hashes: HashString[]
): StagedToolResult[] {
  if (results.length !== hashes.length) {
    throw new Error("tool result hashes must align with tool results");
  }

  return results.map((result, index) => ({
    hash: hashes[index],
    result,
  }));
}

export function isExecutableApprovalDecision(
  decision: ApprovalDecision
): decision is ApprovalDecision & { type: "approve" | "edit" } {
  return decision.type === "approve" || decision.type === "edit";
}

export function isPauseResult(
  result: AroundToolResult
): result is Extract<AroundToolResult, { verdict: "pause" }> {
  return "verdict" in result && result.verdict === "pause";
}

export function isResultWithState(
  result: AroundToolResult
): result is Extract<AroundToolResult, { result: ToolResultPart }> {
  return "result" in result;
}

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

function formatAjvErrors(errors: ErrorObject[] | null | undefined): unknown {
  return errors?.map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message,
    params: error.params,
    schemaPath: error.schemaPath,
  }));
}

function emitToolResultEvent(
  environment: ToolBatchEnvironment,
  result: ToolResultPart
): void {
  environment.publishEvent({
    callId: result.callId,
    isError: result.isError,
    name: result.name,
    output: result.output,
    timestamp: environment.now(),
    type: "tool.result",
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return asRecord(cloneValue(asRecord(value)));
}
