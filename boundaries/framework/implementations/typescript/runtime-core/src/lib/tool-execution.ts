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
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResponse,
  AroundToolHandler,
  ContextManifest,
  EpochMs,
  KrakenExtension,
  KrakenStreamEvent,
  KrakenToolDefinition,
  PendingToolCall,
  ToolCallPart,
  ToolRegistry,
  ToolResultPart,
} from "@kraken/framework-runtime-api";
import type { HashString } from "@kraken/shared-core-types";
import { runWithTimeout } from "./execution-timeouts.js";
import {
  buildSharedExports,
  type ExtensionStateUpdate,
} from "./extension-runtime.js";
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
  emitToolStartIfNeeded,
  evaluateApprovalPolicy,
  getAroundToolHandlers,
  isApprovalRequestValidationError,
  isExecutableApprovalDecision,
  isRejectedPromiseResult,
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
  zipStagedToolResults,
} from "./tool-execution-helpers.js";

export interface ToolBatchEnvironment {
  activeAgent: string;
  branchId: string;
  extensions: KrakenExtension[];
  iterationCount: number;
  manifest: ContextManifest;
  now(): EpochMs;
  publishCustom(event: { data: unknown; name: string }): void;
  publishEvent(event: KrakenStreamEvent): void;
  reportSoftError(error: Error): void;
  runId: string;
  signal?: AbortSignal;
  stageResult(result: ToolResultPart, orderIndex: number): Promise<HashString>;
  threadId: string;
  toolRegistry: ToolRegistry;
  turnId: string;
}

export interface ToolBatchOutcome {
  approval?: ApprovalRequest;
  resultHashes: HashString[];
  results: ToolResultPart[];
  updates: ExtensionStateUpdate[];
}

export interface ExecutableToolCall {
  approvalDecision?: ApprovalDecision;
  input: unknown;
  tool: KrakenToolDefinition;
  toolCall: ToolCallPart;
}

export interface OrderedExecutableToolCall {
  executable: ExecutableToolCall;
  index: number;
}

export interface StagedToolResult {
  hash: HashString;
  result: ToolResultPart;
}

export interface ToolStartState {
  emitted: boolean;
  settled: boolean;
}

export interface ToolStartBarrier {
  markSettled(): void;
  waitUntilReady(): Promise<void>;
}

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

type ResolvedToolBatchStep =
  | { executable: ExecutableToolCall }
  | { pendingToolCall: PendingToolCall }
  | { result: ToolResultPart };

export async function executeToolBatch(
  toolCalls: ToolCallPart[],
  environment: ToolBatchEnvironment
): Promise<ToolBatchOutcome> {
  return await runToolBatch(toolCalls.length, environment, async (index) => {
    return await resolveExecutableToolCall(toolCalls[index], environment);
  });
}

export async function resumeToolBatch(
  request: ApprovalRequest,
  response: ApprovalResponse,
  environment: ToolBatchEnvironment
): Promise<ToolBatchOutcome> {
  const responseMap = new Map<string, ApprovalDecision>();
  for (const decision of response.decisions) {
    responseMap.set(decision.callId, decision);
  }
  return await runToolBatch(
    request.toolCalls.length,
    environment,
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

async function runToolBatch(
  totalCalls: number,
  environment: ToolBatchEnvironment,
  resolveStep: (index: number) => Promise<ResolvedToolBatchStep | undefined>
): Promise<ToolBatchOutcome> {
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

  for (let index = 0; index < totalCalls; index += 1) {
    const resolved = await resolveStep(index);

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

  await executePlannedToolCalls(
    environment,
    immediateResults,
    orderedResults,
    executable,
    pendingToolCalls,
    updates
  );

  return buildToolBatchOutcome(orderedResults, pendingToolCalls, updates);
}

async function executePlannedToolCalls(
  environment: ToolBatchEnvironment,
  immediateResults: ToolResultPart[][],
  orderedResults: StagedToolResult[][],
  executable: OrderedExecutableToolCall[],
  pendingToolCalls: PendingToolCall[],
  updates: ExtensionStateUpdate[]
): Promise<void> {
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
}

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

async function resolveExecutableToolCall(
  toolCall: ToolCallPart,
  environment: ToolBatchEnvironment
): Promise<
  | { executable: ExecutableToolCall }
  | { pendingToolCall: PendingToolCall }
  | { result: ToolResultPart }
> {
  const tool = environment.toolRegistry.get(toolCall.name);

  if (tool === undefined) {
    return {
      result: createErrorToolResult(
        toolCall,
        `Tool "${toolCall.name}" is not registered.`
      ),
    };
  }

  const validation = validateToolInput(tool, toolCall.input);

  if (!validation.valid) {
    return {
      result: createErrorToolResult(
        toolCall,
        "Tool input failed validation.",
        validation.details
      ),
    };
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
      tool,
      toolCall,
    },
  };
}

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

  const tool = environment.toolRegistry.get(pendingToolCall.name);

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
        }
      ),
    };
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
        }
      ),
    };
  }

  const validation = validateToolInput(tool, input);

  if (!validation.valid) {
    return {
      result: createErrorToolResult(
        {
          callId: pendingToolCall.callId,
          input,
          name: pendingToolCall.name,
          type: "tool_call",
        },
        "Approved tool input failed validation.",
        {
          decisionType: decision.type,
          validation: validation.details,
        }
      ),
    };
  }

  return {
    executable: {
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

async function executeSingleTool(
  toolCall: ExecutableToolCall,
  orderIndex: number,
  environment: ToolBatchEnvironment,
  startBarrier: ToolStartBarrier
): Promise<SingleToolOutcome> {
  const toolStartState: ToolStartState = {
    emitted: false,
    settled: false,
  };

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
      toolCall.approvalDecision
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
      settleToolStartIfNeeded(toolStartState, startBarrier);
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
      settleToolStartIfNeeded(toolStartState, startBarrier);
      throw error;
    }

    const result = createExecutionFailureResult(
      toolCall.toolCall,
      error,
      toolCall.approvalDecision
    );
    settleToolStartIfNeeded(toolStartState, startBarrier);
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
}

async function executeConcurrentToolCalls(
  executable: OrderedExecutableToolCall[],
  environment: ToolBatchEnvironment,
  startBarrier: ToolStartBarrier
): Promise<SingleToolOutcome[]> {
  const batchAbortController = new AbortController();
  const batchEnvironment = createBatchScopedEnvironment(
    environment,
    batchAbortController.signal
  );
  const outcomes = executable.map((toolCall) =>
    executeSingleTool(
      toolCall.executable,
      toolCall.index,
      batchEnvironment,
      startBarrier
    ).catch((error: unknown) => {
      if (!batchAbortController.signal.aborted) {
        batchAbortController.abort(error);
      }

      throw error;
    })
  );
  const settledOutcomes = await Promise.allSettled(outcomes);
  const rejection = settledOutcomes.find(isRejectedPromiseResult);

  if (rejection !== undefined) {
    throw rejection.reason;
  }

  const successfulOutcomes: SingleToolOutcome[] = [];

  for (const outcome of settledOutcomes) {
    if (outcome.status === "fulfilled") {
      successfulOutcomes.push(outcome.value);
    }
  }

  return successfulOutcomes;
}

async function runAroundToolHandlers(
  handlers: Array<{
    extensionName: string;
    handler: AroundToolHandler;
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
    emitToolStartIfNeeded(toolCall, environment, toolStartState, startBarrier);
    const output = await runWithTimeout(
      () =>
        toolCall.tool.execute(
          toolCall.input,
          createToolExecutionContext(
            toolCall.toolCall,
            toolCall.tool,
            environment,
            composeAbortSignals(environment.signal, timeoutController.signal)
          )
        ),
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

    return {
      result: {
        callId: toolCall.toolCall.callId,
        name: toolCall.tool.name,
        output,
        type: "tool_result",
      },
      updates: [],
    };
  }

  const { extensionName, handler, timeout } = handlers[index];
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
        handler(context, async (nextContext) => {
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

    return normalizeAroundToolResult(
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
        context.toolCall,
        error,
        context.approvalDecision
      ),
      updates: nestedUpdates,
    };
  }
}
