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
  AroundToolContext,
  AroundToolHandler,
  AroundToolResult,
  ContextManifest,
  EpochMs,
  EventSource,
  KrakenExtension,
  KrakenStreamEvent,
  KrakenToolDefinition,
  PendingToolCall,
  ToolCallPart,
  ToolExecutionContext,
  ToolRegistry,
  ToolResultPart,
} from "@kraken/framework-runtime-api";
import { assertApprovalRequest } from "@kraken/framework-runtime-api";
import type { HashString } from "@kraken/shared-core-types";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { runWithTimeout } from "./execution-timeouts.js";
import {
  buildSharedExports,
  type ExtensionStateUpdate,
} from "./extension-runtime.js";

const DEFAULT_APPROVAL_DECISIONS = ["approve", "edit", "reject"];
const ajv = new Ajv({
  allErrors: true,
  strict: false,
});
const validatorCache = new WeakMap<object, ValidateFunction>();

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

interface ExecutableToolCall {
  approvalDecision?: ApprovalDecision;
  input: unknown;
  tool: KrakenToolDefinition;
  toolCall: ToolCallPart;
}

interface OrderedExecutableToolCall {
  executable: ExecutableToolCall;
  index: number;
}

interface StagedToolResult {
  hash: HashString;
  result: ToolResultPart;
}

interface ToolStartState {
  emitted: boolean;
}

interface ApprovalPendingSource {
  callId: string;
  name: string;
}

type SingleToolOutcome =
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

type RawSingleToolOutcome =
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

class ToolPauseSignal extends Error {
  readonly approval: ApprovalRequest;
  readonly updates: ExtensionStateUpdate[];

  constructor(approval: ApprovalRequest, updates: ExtensionStateUpdate[]) {
    super("tool execution paused");
    this.approval = approval;
    this.updates = updates;
  }
}

export async function executeToolBatch(
  toolCalls: ToolCallPart[],
  environment: ToolBatchEnvironment
): Promise<ToolBatchOutcome> {
  const orderedResults = toolCalls.map((): StagedToolResult[] => []);
  const pendingToolCalls: PendingToolCall[] = [];
  const updates: ExtensionStateUpdate[] = [];
  const executable: OrderedExecutableToolCall[] = [];

  for (const [index, toolCall] of toolCalls.entries()) {
    const resolved = await resolveExecutableToolCall(toolCall, environment);

    if ("pendingToolCall" in resolved) {
      pendingToolCalls.push(resolved.pendingToolCall);
      continue;
    }

    if ("result" in resolved) {
      const hash = await stageAndEmitResult(
        environment,
        resolved.result,
        index
      );
      orderedResults[index].push({
        hash,
        result: resolved.result,
      });
      continue;
    }

    executable.push({
      executable: resolved.executable,
      index,
    });
  }

  const executableOutcomes = await Promise.all(
    executable.map((toolCall) =>
      executeSingleTool(toolCall.executable, toolCall.index, environment)
    )
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

export async function resumeToolBatch(
  request: ApprovalRequest,
  response: ApprovalResponse,
  environment: ToolBatchEnvironment
): Promise<ToolBatchOutcome> {
  const orderedResults = request.toolCalls.map((): StagedToolResult[] => []);
  const updates: ExtensionStateUpdate[] = [];
  const executable: OrderedExecutableToolCall[] = [];
  const responseMap = new Map<string, ApprovalDecision>();

  for (const decision of response.decisions) {
    responseMap.set(decision.callId, decision);
  }

  for (const [index, pendingToolCall] of request.toolCalls.entries()) {
    const decision = responseMap.get(pendingToolCall.callId);

    if (decision === undefined) {
      continue;
    }

    const resumePlan = await resolveResumeDecision(
      pendingToolCall,
      decision,
      environment
    );

    if ("result" in resumePlan) {
      const hash = await stageAndEmitResult(
        environment,
        resumePlan.result,
        index
      );
      orderedResults[index].push({
        hash,
        result: resumePlan.result,
      });
      continue;
    }

    executable.push({
      executable: resumePlan.executable,
      index,
    });
  }

  const executedOutcomes = await Promise.all(
    executable.map((toolCall) =>
      executeSingleTool(toolCall.executable, toolCall.index, environment)
    )
  );
  const pendingToolCalls: PendingToolCall[] = [];

  for (const [outcomeIndex, outcome] of executedOutcomes.entries()) {
    updates.push(...outcome.updates);
    const resultIndex = executable[outcomeIndex]?.index;

    if (resultIndex === undefined) {
      continue;
    }

    if (outcome.approval !== undefined) {
      orderedResults[resultIndex].push(
        ...zipStagedToolResults(
          outcome.approval.completedResults,
          outcome.completedResultHashes
        )
      );
      pendingToolCalls.push(...outcome.approval.toolCalls);
      continue;
    }

    orderedResults[resultIndex].push({
      hash: outcome.resultHash,
      result: outcome.result,
    });
  }

  const stagedResults = orderedResults.flat();
  const results = stagedResults.map((entry) => entry.result);
  const resultHashes = stagedResults.map((entry) => entry.hash);

  return {
    approval:
      pendingToolCalls.length === 0
        ? undefined
        : {
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

  const toolContext = createToolExecutionContext(toolCall, tool, environment);
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
  environment: ToolBatchEnvironment
): Promise<SingleToolOutcome> {
  const toolStartState: ToolStartState = {
    emitted: false,
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
      toolStartState
    );

    if (outcome.approval !== undefined) {
      const completedResultHashes = await stageAndEmitResults(
        environment,
        outcome.approval.completedResults,
        orderIndex
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
      orderIndex
    );

    return {
      resultHash,
      result,
      updates: outcome.updates,
    };
  } catch (error: unknown) {
    if (error instanceof ToolPauseSignal) {
      const completedResultHashes = await stageAndEmitResults(
        environment,
        error.approval.completedResults,
        orderIndex
      );
      return {
        approval: error.approval,
        completedResultHashes,
        updates: error.updates,
      };
    }

    if (isApprovalRequestValidationError(error)) {
      throw error;
    }

    const result = createExecutionFailureResult(
      toolCall.toolCall,
      error,
      toolCall.approvalDecision
    );
    const resultHash = await stageAndEmitResult(
      environment,
      result,
      orderIndex
    );

    return {
      resultHash,
      result,
      updates: [],
    };
  }
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
  toolStartState: ToolStartState
): Promise<RawSingleToolOutcome> {
  if (index >= handlers.length) {
    emitToolStartIfNeeded(toolCall, environment, toolStartState);
    const output = await runWithTimeout(
      () =>
        toolCall.tool.execute(
          toolCall.input,
          createToolExecutionContext(
            toolCall.toolCall,
            toolCall.tool,
            environment
          )
        ),
      toolCall.tool.timeout,
      () =>
        new Error(
          `tool "${toolCall.tool.name}" timed out after ${toolCall.tool.timeout}ms`
        )
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
  const context = createAroundToolContext(
    toolCall,
    extensionName,
    environment,
    sharedExports
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
            toolStartState
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
        )
    );

    return normalizeAroundToolResult(
      extensionName,
      handlerResult,
      nestedUpdates,
      nestedResult,
      context,
      environment,
      toolStartState
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

function normalizeAroundToolResult(
  extensionName: string,
  result: AroundToolResult,
  nestedUpdates: ExtensionStateUpdate[],
  nestedResult: ToolResultPart | undefined,
  context: AroundToolContext,
  environment: ToolBatchEnvironment,
  toolStartState: ToolStartState
): RawSingleToolOutcome {
  if (isPauseResult(result)) {
    if (nestedResult !== undefined) {
      return {
        result: nestedResult,
        updates: collectExtensionStateUpdate(
          extensionName,
          result.state,
          nestedUpdates
        ),
      };
    }

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
    emitToolStartIfNeeded(
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
      toolStartState
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

  emitToolStartIfNeeded(
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
    toolStartState
  );
  return {
    result,
    updates: nestedUpdates,
  };
}

function collectExtensionStateUpdate(
  extensionName: string,
  state: Record<string, unknown> | undefined,
  nestedUpdates: ExtensionStateUpdate[]
): ExtensionStateUpdate[] {
  if (state === undefined) {
    return nestedUpdates;
  }

  return [...nestedUpdates, { extensionName, state }];
}

function getAroundToolHandlers(
  extensions: KrakenExtension[],
  toolName: string
): Array<{
  extensionName: string;
  handler: AroundToolHandler;
  timeout?: number;
}> {
  const handlers: Array<{
    extensionName: string;
    handler: AroundToolHandler;
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
        timeout: extension.timeout,
      });
      continue;
    }

    if (spec.tools.includes(toolName)) {
      handlers.push({
        extensionName: extension.name,
        handler: spec.handler,
        timeout: extension.timeout,
      });
    }
  }

  return handlers;
}

function createToolExecutionContext(
  toolCall: ToolCallPart,
  tool: KrakenToolDefinition,
  environment: ToolBatchEnvironment
): ToolExecutionContext {
  return {
    callId: toolCall.callId,
    emit: (event: { data: unknown; name: string }) => {
      environment.publishCustom(event);
    },
    forward: (event: KrakenStreamEvent, source: EventSource) => {
      environment.publishEvent({
        ...event,
        source,
      });
    },
    metadata: tool.metadata,
    name: tool.name,
    signal: environment.signal,
  };
}

function createAroundToolContext(
  toolCall: ExecutableToolCall,
  extensionName: string,
  environment: ToolBatchEnvironment,
  sharedExports: Record<string, Record<string, unknown>>
): AroundToolContext {
  return {
    approvalDecision: toolCall.approvalDecision,
    callId: toolCall.toolCall.callId,
    emit: (event: { data: unknown; name: string }) => {
      environment.publishCustom(event);
    },
    extensionState: asRecord(environment.manifest.extensions[extensionName]),
    forward: (event: KrakenStreamEvent, source: EventSource) => {
      environment.publishEvent({
        ...event,
        source,
      });
    },
    input: toolCall.input,
    iterationCount: environment.iterationCount,
    manifest: environment.manifest,
    sharedExports,
    tool: toolCall.tool,
    toolCall: toolCall.toolCall,
  };
}

function toExecutableToolCall(
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

function emitToolStartIfNeeded(
  toolCall: ExecutableToolCall,
  environment: ToolBatchEnvironment,
  toolStartState: ToolStartState
): void {
  if (toolStartState.emitted) {
    return;
  }

  toolStartState.emitted = true;
  environment.publishEvent({
    callId: toolCall.toolCall.callId,
    input: toolCall.input,
    name: toolCall.tool.name,
    timestamp: environment.now(),
    type: "tool.start",
  });
}

function createPendingToolCall(
  toolCall: ApprovalPendingSource,
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

function normalizeApprovalRequest(
  toolCall: ApprovalPendingSource,
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

function isApprovalRequestValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "invalid_approval_request"
  );
}

async function evaluateApprovalPolicy(
  policy: NonNullable<KrakenToolDefinition["approval"]>,
  input: unknown,
  context: ToolExecutionContext
): Promise<boolean> {
  return typeof policy === "function" ? await policy(input, context) : policy;
}

function validateToolInput(
  tool: KrakenToolDefinition,
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

function getCompiledValidator(
  schema: KrakenToolDefinition["inputSchema"]
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

function applyApprovalDecisionMetadata(
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

function createRejectedToolResult(
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

function createExecutionFailureResult(
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

function createErrorToolResult(
  toolCall: ToolCallPart,
  message: string,
  details?: unknown
): ToolResultPart {
  return {
    callId: toolCall.callId,
    isError: true,
    name: toolCall.name,
    output:
      details === undefined ? { error: message } : { details, error: message },
    type: "tool_result",
  };
}

async function stageAndEmitResult(
  environment: ToolBatchEnvironment,
  result: ToolResultPart,
  orderIndex: number
): Promise<HashString> {
  const hash = await environment.stageResult(result, orderIndex);
  emitToolResultEvent(environment, result);
  return hash;
}

async function stageAndEmitResults(
  environment: ToolBatchEnvironment,
  results: ToolResultPart[],
  orderIndex: number
): Promise<HashString[]> {
  const hashes: HashString[] = [];

  for (const result of results) {
    hashes.push(await stageAndEmitResult(environment, result, orderIndex));
  }

  return hashes;
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

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function zipStagedToolResults(
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

function isExecutableApprovalDecision(
  decision: ApprovalDecision
): decision is ApprovalDecision & { type: "approve" | "edit" } {
  return decision.type === "approve" || decision.type === "edit";
}

function isPauseResult(
  result: AroundToolResult
): result is Extract<AroundToolResult, { verdict: "pause" }> {
  return "verdict" in result && result.verdict === "pause";
}

function isResultWithState(
  result: AroundToolResult
): result is Extract<AroundToolResult, { result: ToolResultPart }> {
  return "result" in result;
}
