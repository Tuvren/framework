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

import type { ToolResultPart } from "@tuvren/core/messages";
import type { PendingToolCall } from "@tuvren/core/tools";

import type { ExtensionStateUpdate } from "./extension-runtime.js";
import {
  createBatchScopedEnvironment,
  normalizeError,
} from "./tool-execution-helpers.js";
import { executeSingleTool } from "./tool-execution-single.js";
import {
  createToolStartBarrier,
  stageAndEmitResults,
  stageImmediateResults,
  stageImmediateResultsWhileExecuting,
} from "./tool-execution-staging.js";
import type {
  ExecutableToolCall,
  OrderedExecutableToolCall,
  SingleToolOutcome,
  StagedToolResult,
  ToolBatchEnvironment,
  ToolBatchOutcome,
  ToolExecutionMode,
  ToolStartBarrier,
  ToolStartState,
} from "./tool-execution.js";

/**
 * Result of the synchronous resolve/validate/approve phase for one call
 * (framework spec §8.6 steps 1-3): admitted for execution, pending host
 * approval, or already decided with an immediate (usually error) result.
 */
type ResolvedToolBatchStep =
  | { executable: ExecutableToolCall }
  | { pendingToolCall: PendingToolCall }
  | { result: ToolResultPart };

type ToolBatchStepResolver = (
  index: number
) =>
  | ResolvedToolBatchStep
  | undefined
  | Promise<ResolvedToolBatchStep | undefined>;

/**
 * Flattens per-call-index staged results into the final index-aligned
 * `results`/`resultHashes` arrays and, when any calls are still pending,
 * wraps them in an `ApprovalRequest` whose `completedResults` mirrors the
 * completed set.
 */
const buildToolBatchOutcome = (
  orderedResults: StagedToolResult[][],
  pendingToolCalls: PendingToolCall[],
  updates: ExtensionStateUpdate[]
): ToolBatchOutcome => {
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
};

/**
 * Sequential-mode strategy: resolves and fully executes one call at a time in
 * model order, emitting each call's `tool.start`/`tool.result` pair before
 * moving on. The first call that requires approval — whether from resolution
 * (declarative policy, risk-based policy gate) or from an `aroundTool` pause —
 * stops the batch; later calls are not resolved or executed and are left for
 * the resume path (framework spec §8.6 sequential execution).
 */
const runSequentialToolBatch = async (
  totalCalls: number,
  environment: ToolBatchEnvironment,
  resolveStep: ToolBatchStepResolver
): Promise<ToolBatchOutcome> => {
  const orderedResults = Array.from(
    { length: totalCalls },
    (): StagedToolResult[] => []
  );
  const pendingToolCalls: PendingToolCall[] = [];
  const updates: ExtensionStateUpdate[] = [];
  const runCallAtIndex = async (index: number): Promise<void> => {
    if (index >= totalCalls) {
      return;
    }
    const resolved = await resolveStep(index);

    if (resolved === undefined) {
      await runCallAtIndex(index + 1);
      return;
    }

    if ("pendingToolCall" in resolved) {
      pendingToolCalls.push(resolved.pendingToolCall);
      return;
    }

    if ("result" in resolved) {
      const staged = await stageAndEmitResults(
        environment,
        [resolved.result],
        index,
        createToolStartBarrier(0)
      );
      orderedResults[index].push(...staged);
      await runCallAtIndex(index + 1);
      return;
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
      orderedResults[index].push(...outcome.completedStagedResults);
      return;
    }

    orderedResults[index].push({
      hash: outcome.resultHash,
      result: outcome.result,
    });
    await runCallAtIndex(index + 1);
  };

  await runCallAtIndex(0);

  return buildToolBatchOutcome(orderedResults, pendingToolCalls, updates);
};

/**
 * Runs the resolve/validate/approve phase for every call up front (framework
 * spec §8.6: parallel mode performs steps 1-3 synchronously for all calls
 * before any execution starts). Resolution is sequential and in call order,
 * so audit events from this phase are deterministically ordered.
 */
const resolveToolBatchSteps = async (
  totalCalls: number,
  resolveStep: ToolBatchStepResolver
): Promise<(ResolvedToolBatchStep | undefined)[]> => {
  const resolvedSteps: (ResolvedToolBatchStep | undefined)[] = [];
  const resolveAtIndex = async (index: number): Promise<void> => {
    if (index >= totalCalls) {
      return;
    }
    resolvedSteps[index] = await resolveStep(index);
    await resolveAtIndex(index + 1);
  };

  await resolveAtIndex(0);

  return resolvedSteps;
};

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
const executeToolCallWave = async (
  executable: OrderedExecutableToolCall[],
  environment: ToolBatchEnvironment,
  startBarrier: ToolStartBarrier,
  batchAbortController: AbortController
): Promise<SingleToolOutcome[]> => {
  let previousTurn = Promise.resolve();
  const toolStartStates = executable.map(() => {
    const turn: PromiseWithResolvers<void> = Promise.withResolvers();
    const waitForTurn = previousTurn;
    previousTurn = turn.promise;

    return {
      emitted: false,
      releaseTurn() {
        turn.resolve();
      },
      settled: false,
      waitForTurn: (): void | Promise<void> => waitForTurn,
    } satisfies ToolStartState;
  });

  const outcomes = executable.map(
    async (toolCall, index) =>
      await executeSingleTool(
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
};

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
const executeConcurrentToolCalls = async (
  executable: OrderedExecutableToolCall[],
  environment: ToolBatchEnvironment,
  startBarrier: ToolStartBarrier
): Promise<SingleToolOutcome[]> => {
  const batchAbortController = new AbortController();
  const scopedEnvironment = createBatchScopedEnvironment(
    environment,
    batchAbortController.signal
  );
  const outcomes: SingleToolOutcome[] = [];
  const executeWaveAtIndex = async (index: number): Promise<void> => {
    if (index >= executable.length) {
      return;
    }
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
    await executeWaveAtIndex(index + environment.maxParallelToolCalls);
  };

  await executeWaveAtIndex(0);

  return outcomes;
};

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
const runParallelToolBatch = async (
  resolvedSteps: (ResolvedToolBatchStep | undefined)[],
  environment: ToolBatchEnvironment
): Promise<ToolBatchOutcome> => {
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
      orderedResults[resultIndex].push(...outcome.completedStagedResults);
      continue;
    }

    orderedResults[resultIndex].push({
      hash: outcome.resultHash,
      result: outcome.result,
    });
  }

  return buildToolBatchOutcome(orderedResults, pendingToolCalls, updates);
};

/**
 * Shared driver behind {@link executeToolBatch} and {@link resumeToolBatch}:
 * routes to the sequential or parallel strategy, with `resolveStep` supplying
 * either fresh-resolution or approval-decision semantics per call index.
 * A step resolving to `undefined` (undecided resume call) is skipped.
 */
export const runToolBatch = async (
  totalCalls: number,
  environment: ToolBatchEnvironment,
  mode: ToolExecutionMode,
  resolveStep: ToolBatchStepResolver
): Promise<ToolBatchOutcome> => {
  if (mode === "sequential") {
    return await runSequentialToolBatch(totalCalls, environment, resolveStep);
  }

  const resolvedSteps = await resolveToolBatchSteps(totalCalls, resolveStep);
  return await runParallelToolBatch(resolvedSteps, environment);
};
