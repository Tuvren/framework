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

import { assertHashString } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { IterationDecision, LoopPolicy } from "@tuvren/core/execution";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import { assertRunnerExecutionResult } from "@tuvren/core/runner";
import type { ApprovalDecision } from "@tuvren/core/tools";
import type { ProviderStreamChunk, TuvrenProvider } from "@tuvren/provider-api";
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import { createReActRunner } from "../../runners/react/src/index.ts";
import {
  type AdapterProjection,
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createRunnerExecutionContext,
  createScenarioProvider,
  createStaticRunner,
  RUNNER_ID,
  type ScenarioToolCall,
  textSignal,
} from "./framework-adapter-runtime.ts";

export interface FrameworkAdapterRunnerDependencies {
  errorToEnvelope(error: unknown): Record<string, unknown>;
  readApprovalDecisions(
    scenario: Record<string, unknown>,
    path: string
  ): ApprovalDecision[];
  readFirstToolCallNameOptional(
    responses: readonly TuvrenModelResponse[],
    path: string
  ): string | undefined;
  readModelResponseArrayProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): TuvrenModelResponse[];
  readOperationScenario(
    input: unknown,
    operation: string
  ): Record<string, unknown>;
  readPendingToolCalls(
    scenario: Record<string, unknown>,
    path: string
  ): ScenarioToolCall[];
  readProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): unknown;
  readProviderStreamChunks(
    record: Record<string, unknown>,
    path: string
  ): ProviderStreamChunk[];
  readStringProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): string;
}

export function createFrameworkAdapterRunner(
  dependencies: FrameworkAdapterRunnerDependencies
): {
  runRunnerCheckpoint(input: unknown): Promise<AdapterProjection>;
  runRunnerExecute(input: unknown): Promise<AdapterProjection>;
  runRunnerResume(input: unknown): Promise<AdapterProjection>;
} {
  async function runRunnerExecute(input: unknown): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runner.execute"
    );
    const providerResponses = dependencies.readModelResponseArrayProperty(
      scenario,
      "providerResponses",
      "runner.execute.providerResponses"
    );
    const toolName = dependencies.readFirstToolCallNameOptional(
      providerResponses,
      "runner.execute.providerResponses"
    );
    const loopPolicy = readLoopPolicyOptional(scenario);
    const caseName = readOptionalString(scenario, "case");

    if (caseName === "around_model_post_stream_replacement") {
      return await runAroundModelPostStreamReplacement(scenario);
    }

    if (caseName === "around_model_retry_final_response") {
      return await runAroundModelRetryFinalResponse(providerResponses);
    }

    if (toolName === undefined || loopPolicy !== undefined) {
      return runDirectRunnerExecute(providerResponses, loopPolicy);
    }

    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      "runner.execute.prompt"
    );
    const toolResult = dependencies.readProperty(
      scenario,
      "toolResult",
      "runner.execute.toolResult"
    );
    const harness = createConformanceKernelHarness();
    const hooks = createHookCounters();
    let generateCalls = 0;
    let toolCalls = 0;
    const provider = createScenarioProvider(providerResponses, () => {
      generateCalls += 1;
    });
    const reactRunner = createReActRunner({
      providerCallMode: "generate",
    }).create();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: reactRunner.id,
      runnerRegistry: createRunnerRegistry([reactRunner]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [createMeasuredExtension(hooks)],
        model: provider,
        name: AGENT_NAME,
        tools: [
          {
            description: "Search docs",
            execute() {
              hooks.aroundToolTrace.push("tool.execute");
              toolCalls += 1;
              return toolResult;
            },
            inputSchema: { type: "object" },
            name: toolName,
          },
        ],
      },
      signal: textSignal(prompt),
      threadId: thread.threadId,
    });

    await collectValues(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    return {
      evidence: {
        runner: {
          phase: handle.status().phase,
        },
        hooks: {
          afterIteration: hooks.afterIteration,
          aroundModel: hooks.aroundModel,
          aroundModelTrace: hooks.aroundModelTrace,
          aroundTool: hooks.aroundTool,
          aroundToolTrace: hooks.aroundToolTrace,
          terminalMutationAttempted: hooks.terminalMutationAttempted,
          terminalMutationDurableText: readAssistantText(messages),
          beforeIteration: hooks.beforeIteration,
          phaseTrace: hooks.phaseTrace,
        },
        provider: {
          generate: {
            callCount: generateCalls,
          },
        },
        tool: {
          execution: {
            callCount: toolCalls,
          },
        },
      },
      result: {
        runner: {
          phase: handle.status().phase,
        },
        hooks: {
          afterIteration: hooks.afterIteration,
          aroundModel: hooks.aroundModel,
          aroundModelTrace: hooks.aroundModelTrace,
          aroundTool: hooks.aroundTool,
          aroundToolTrace: hooks.aroundToolTrace,
          terminalMutationAttempted: hooks.terminalMutationAttempted,
          terminalMutationDurableText: readAssistantText(messages),
          beforeIteration: hooks.beforeIteration,
          phaseTrace: hooks.phaseTrace,
        },
        provider: {
          generate: {
            callCount: generateCalls,
          },
        },
        tool: {
          execution: {
            callCount: toolCalls,
          },
        },
      },
      state: {
        hookCounts: hooks,
      },
    };
  }

  async function runAroundModelPostStreamReplacement(
    scenario: Record<string, unknown>
  ): Promise<AdapterProjection> {
    const chunks = dependencies.readProviderStreamChunks(
      scenario,
      "runner.execute.streamChunks"
    );
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider: TuvrenProvider = {
      generate() {
        return Promise.reject(
          new Error("generate must not run during stream replacement")
        );
      },
      id: "provider",
      async *stream() {
        await Promise.resolve();
        for (const chunk of chunks) {
          yield structuredClone(chunk);
        }
      },
    };
    const runner = createReActRunner({
      providerCallMode: "stream",
    }).create();
    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(_context, next) {
                const response = await next();
                return {
                  ...response,
                  parts: [{ text: "modified", type: "text" }],
                };
              },
              name: "rewriter",
            },
          ],
          model: provider,
          name: AGENT_NAME,
        },
        emittedEvents,
      })
    );

    assertRunnerExecutionResult(result, "runner aroundModel replacement");

    const projection = {
      aroundModel: {
        finalAssistantText: readResultAssistantText(result),
        messageStartCount: countEventsByType(emittedEvents, "message.start"),
        streamedTextDone: readTextDoneValues(emittedEvents),
      },
      runner: {
        resolutionType: result.resolution.type,
      },
    };

    return {
      evidence: projection,
      result: projection,
    };
  }

  async function runAroundModelRetryFinalResponse(
    providerResponses: readonly TuvrenModelResponse[]
  ): Promise<AdapterProjection> {
    let generateCalls = 0;
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();
    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(context, next) {
                await next(context);
                return await next({
                  ...context,
                  prompt: {
                    ...context.prompt,
                    messages: [
                      ...context.prompt.messages,
                      {
                        content: "Retry with shared fallback behavior",
                        role: "system" as const,
                      },
                    ],
                  },
                });
              },
              name: "retry",
            },
          ],
          model: createScenarioProvider(providerResponses, () => {
            generateCalls += 1;
          }),
          name: AGENT_NAME,
        },
      })
    );

    assertRunnerExecutionResult(result, "runner aroundModel retry");

    const projection = {
      aroundModel: {
        finalAssistantText: readResultAssistantText(result),
      },
      runner: {
        resolutionType: result.resolution.type,
      },
      provider: {
        generate: {
          callCount: generateCalls,
        },
      },
    };

    return {
      evidence: projection,
      result: projection,
    };
  }

  async function runDirectRunnerExecute(
    providerResponses: readonly TuvrenModelResponse[],
    loopPolicy?: LoopPolicy
  ): Promise<AdapterProjection> {
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();
    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          ...(loopPolicy === undefined ? {} : { loopPolicy }),
          model: createScenarioProvider(providerResponses, () => undefined),
          name: AGENT_NAME,
        },
      })
    );

    assertRunnerExecutionResult(result, "runner execute result");

    const error =
      result.resolution.type === "fail"
        ? dependencies.errorToEnvelope(result.resolution.error)
        : undefined;

    return {
      evidence: {
        runner: {
          errorCode: error?.code,
          resolutionType: result.resolution.type,
        },
      },
      result: {
        runner: {
          errorCode: error?.code,
          resolutionType: result.resolution.type,
        },
        error,
      },
    };
  }

  async function runRunnerResume(input: unknown): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(input, "runner.resume");
    const pendingToolCalls = dependencies.readPendingToolCalls(
      scenario,
      "runner.resume.pendingToolCalls"
    );
    const decisions = dependencies.readApprovalDecisions(
      scenario,
      "runner.resume.approvalDecisions"
    );
    const providerResponses = dependencies.readModelResponseArrayProperty(
      scenario,
      "providerResponses",
      "runner.resume.providerResponses"
    );
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    if (runner.resume === undefined) {
      throw new Error("implementation runner does not expose resume");
    }

    const resumedFrom = "0".repeat(64);
    assertHashString(resumedFrom, "runner.resume.resumedFrom");

    const result = await runner.resume({
      ...createRunnerExecutionContext(),
      approval: {
        decisions,
      },
      config: {
        model: createScenarioProvider(providerResponses, () => undefined),
        name: AGENT_NAME,
      },
      messages: [
        {
          parts: [{ text: "resume pending tool calls", type: "text" }],
          role: "user",
        },
        assistantToolCalls(pendingToolCalls),
      ],
      resumedFrom,
    });

    assertRunnerExecutionResult(result, "runner resume result");

    return {
      evidence: {
        runner: {
          approvalDecisionCallIds: decisions.map((decision) => decision.callId),
          pendingToolCallIds: pendingToolCalls.map((call) => call.callId),
          resolutionType: result.resolution.type,
        },
      },
      result: {
        runner: {
          approvalDecisionCallIds: decisions.map((decision) => decision.callId),
          pendingToolCallIds: pendingToolCalls.map((call) => call.callId),
          resolutionType: result.resolution.type,
        },
        error:
          result.resolution.type === "fail"
            ? dependencies.errorToEnvelope(result.resolution.error)
            : undefined,
      },
    };
  }

  async function runRunnerCheckpoint(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runner.checkpoint"
    );
    const finalText = dependencies.readStringProperty(
      scenario,
      "finalText",
      "runner.checkpoint.finalText"
    );
    const harness = createConformanceKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      runnerRegistry: createRunnerRegistry([
        createStaticRunner(() => ({
          messages: [assistantText(finalText)],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT_NAME },
      signal: textSignal("checkpoint"),
      threadId: thread.threadId,
    });

    await collectValues(handle.events());

    const manifest = await harness.readBranchManifest(thread.branchId);

    return {
      evidence: {
        checkpoint: {
          manifestPathCount: Object.keys(manifest).length,
        },
        runtime: {
          phase: handle.status().phase,
        },
      },
    };
  }

  return {
    runRunnerCheckpoint,
    runRunnerExecute,
    runRunnerResume,
  };
}

interface HookCounters {
  afterIteration: number;
  aroundModel: number;
  aroundModelTrace: string[];
  aroundTool: number;
  aroundToolTrace: string[];
  beforeIteration: number;
  phaseTrace: string[];
  terminalMutationAttempted: boolean;
}

function createHookCounters(): HookCounters {
  return {
    afterIteration: 0,
    aroundModel: 0,
    aroundModelTrace: [],
    aroundTool: 0,
    aroundToolTrace: [],
    beforeIteration: 0,
    phaseTrace: [],
    terminalMutationAttempted: false,
  };
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function readLoopPolicyOptional(
  scenario: Record<string, unknown>
): LoopPolicy | undefined {
  const loopPolicy = scenario.loopPolicy;

  if (loopPolicy === undefined) {
    return undefined;
  }

  if (!isRecord(loopPolicy)) {
    throw new Error("runner.execute.loopPolicy must be an object");
  }

  const decision = readIterationDecision(loopPolicy);

  return {
    evaluate() {
      return decision;
    },
  };
}

function readIterationDecision(
  record: Record<string, unknown>
): IterationDecision {
  const continueDecision = record.continue;
  const executeTools = record.executeTools;
  const reason = record.reason;

  if (typeof continueDecision !== "boolean") {
    throw new Error("runner.execute.loopPolicy.continue must be a boolean");
  }

  if (typeof executeTools !== "boolean") {
    throw new Error("runner.execute.loopPolicy.executeTools must be a boolean");
  }

  return {
    continue: continueDecision,
    executeTools,
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countEventsByType(
  events: readonly TuvrenStreamEvent[],
  type: string
): number {
  let count = 0;

  for (const event of events) {
    if (event.type === type) {
      count += 1;
    }
  }

  return count;
}

function readTextDoneValues(events: readonly TuvrenStreamEvent[]): string[] {
  const values: string[] = [];

  for (const event of events) {
    if (event.type === "text.done") {
      values.push(event.text);
    }
  }

  return values;
}

function readResultAssistantText(result: {
  messages?: readonly unknown[];
}): string | undefined {
  return readAssistantText(result.messages ?? []);
}

function readAssistantText(messages: readonly unknown[]): string | undefined {
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }

    const parts = message.parts;

    if (!Array.isArray(parts)) {
      continue;
    }

    for (const part of parts) {
      if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
    }
  }

  return undefined;
}

function createMeasuredExtension(hooks: HookCounters): TuvrenExtension {
  return {
    afterIteration(context) {
      const firstPart = context.response.parts[0];

      if (
        firstPart?.type === "text" &&
        firstPart.text === "runner hook turn completed"
      ) {
        firstPart.text = "mutated by afterIteration";
        hooks.terminalMutationAttempted = true;
      }

      hooks.phaseTrace.push("afterIteration");
      hooks.afterIteration += 1;
    },
    async aroundModel(_context, next) {
      hooks.phaseTrace.push("aroundModel.before");
      hooks.aroundModelTrace.push("before");
      hooks.aroundModel += 1;
      const result = await next();
      hooks.aroundModelTrace.push("after");
      hooks.phaseTrace.push("aroundModel.after");
      return result;
    },
    async aroundTool(_context, next) {
      hooks.phaseTrace.push("aroundTool.before");
      hooks.aroundToolTrace.push("aroundTool.before");
      hooks.aroundTool += 1;
      const result = await next();
      hooks.aroundToolTrace.push("aroundTool.after");
      hooks.phaseTrace.push("aroundTool.after");
      return result;
    },
    beforeIteration() {
      hooks.phaseTrace.push("beforeIteration");
      hooks.beforeIteration += 1;
    },
    name: "measured-runner-hooks",
  };
}
