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

import { assertHashString } from "@tuvren/core-types";
import { assertDriverExecutionResult } from "@tuvren/driver-api";
import type { ProviderStreamChunk, TuvrenProvider } from "@tuvren/provider-api";
import type {
  ApprovalDecision,
  IterationDecision,
  LoopPolicy,
  TuvrenExtension,
  TuvrenModelResponse,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import { createReActDriver } from "../../drivers/react/src/index.ts";
import {
  createDriverRegistry,
  createTuvrenRuntimeCore,
} from "../../runtime-core/src/index.ts";
import { createFakeKernelHarness } from "../../runtime-core/test/fake-kernel.ts";
import {
  type AdapterProjection,
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createDriverExecutionContext,
  createScenarioProvider,
  createStaticDriver,
  DRIVER_ID,
  type ScenarioToolCall,
  textSignal,
} from "./framework-adapter-runtime.ts";

export interface FrameworkAdapterDriverDependencies {
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

export function createFrameworkAdapterDriver(
  dependencies: FrameworkAdapterDriverDependencies
): {
  runDriverCheckpoint(input: unknown): Promise<AdapterProjection>;
  runDriverExecute(input: unknown): Promise<AdapterProjection>;
  runDriverResume(input: unknown): Promise<AdapterProjection>;
} {
  async function runDriverExecute(input: unknown): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "driver.execute"
    );
    const providerResponses = dependencies.readModelResponseArrayProperty(
      scenario,
      "providerResponses",
      "driver.execute.providerResponses"
    );
    const toolName = dependencies.readFirstToolCallNameOptional(
      providerResponses,
      "driver.execute.providerResponses"
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
      return runDirectDriverExecute(providerResponses, loopPolicy);
    }

    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      "driver.execute.prompt"
    );
    const toolResult = dependencies.readProperty(
      scenario,
      "toolResult",
      "driver.execute.toolResult"
    );
    const harness = createFakeKernelHarness();
    const hooks = createHookCounters();
    let generateCalls = 0;
    let toolCalls = 0;
    const provider = createScenarioProvider(providerResponses, () => {
      generateCalls += 1;
    });
    const reactDriver = createReActDriver({
      providerCallMode: "generate",
    }).create();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: reactDriver.id,
      driverRegistry: createDriverRegistry([reactDriver]),
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
        driver: {
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
      "driver.execute.streamChunks"
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
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();
    const result = await driver.execute(
      createDriverExecutionContext({
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

    assertDriverExecutionResult(result, "driver aroundModel replacement");

    return {
      evidence: {
        aroundModel: {
          finalAssistantText: readResultAssistantText(result),
          messageStartCount: countEventsByType(emittedEvents, "message.start"),
          streamedTextDone: readTextDoneValues(emittedEvents),
        },
        driver: {
          resolutionType: result.resolution.type,
        },
      },
    };
  }

  async function runAroundModelRetryFinalResponse(
    providerResponses: readonly TuvrenModelResponse[]
  ): Promise<AdapterProjection> {
    let generateCalls = 0;
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();
    const result = await driver.execute(
      createDriverExecutionContext({
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

    assertDriverExecutionResult(result, "driver aroundModel retry");

    return {
      evidence: {
        aroundModel: {
          finalAssistantText: readResultAssistantText(result),
        },
        driver: {
          resolutionType: result.resolution.type,
        },
        provider: {
          generate: {
            callCount: generateCalls,
          },
        },
      },
    };
  }

  async function runDirectDriverExecute(
    providerResponses: readonly TuvrenModelResponse[],
    loopPolicy?: LoopPolicy
  ): Promise<AdapterProjection> {
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();
    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          ...(loopPolicy === undefined ? {} : { loopPolicy }),
          model: createScenarioProvider(providerResponses, () => undefined),
          name: AGENT_NAME,
        },
      })
    );

    assertDriverExecutionResult(result, "driver execute result");

    return {
      evidence: {
        driver: {
          errorCode:
            result.resolution.type === "fail"
              ? dependencies.errorToEnvelope(result.resolution.error).code
              : undefined,
          resolutionType: result.resolution.type,
        },
      },
      result: {
        error:
          result.resolution.type === "fail"
            ? dependencies.errorToEnvelope(result.resolution.error)
            : undefined,
      },
    };
  }

  async function runDriverResume(input: unknown): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(input, "driver.resume");
    const pendingToolCalls = dependencies.readPendingToolCalls(
      scenario,
      "driver.resume.pendingToolCalls"
    );
    const decisions = dependencies.readApprovalDecisions(
      scenario,
      "driver.resume.approvalDecisions"
    );
    const providerResponses = dependencies.readModelResponseArrayProperty(
      scenario,
      "providerResponses",
      "driver.resume.providerResponses"
    );
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    if (driver.resume === undefined) {
      throw new Error("implementation driver does not expose resume");
    }

    const resumedFrom = "0".repeat(64);
    assertHashString(resumedFrom, "driver.resume.resumedFrom");

    const result = await driver.resume({
      ...createDriverExecutionContext(),
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

    assertDriverExecutionResult(result, "driver resume result");

    return {
      evidence: {
        driver: {
          approvalDecisionCallIds: decisions.map((decision) => decision.callId),
          pendingToolCallIds: pendingToolCalls.map((call) => call.callId),
          resolutionType: result.resolution.type,
        },
      },
      result: {
        error:
          result.resolution.type === "fail"
            ? dependencies.errorToEnvelope(result.resolution.error)
            : undefined,
      },
    };
  }

  async function runDriverCheckpoint(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "driver.checkpoint"
    );
    const finalText = dependencies.readStringProperty(
      scenario,
      "finalText",
      "driver.checkpoint.finalText"
    );
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(() => ({
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
    runDriverCheckpoint,
    runDriverExecute,
    runDriverResume,
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
    throw new Error("driver.execute.loopPolicy must be an object");
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
    throw new Error("driver.execute.loopPolicy.continue must be a boolean");
  }

  if (typeof executeTools !== "boolean") {
    throw new Error("driver.execute.loopPolicy.executeTools must be a boolean");
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
        firstPart.text === "driver hook turn completed"
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
    name: "measured-driver-hooks",
  };
}
