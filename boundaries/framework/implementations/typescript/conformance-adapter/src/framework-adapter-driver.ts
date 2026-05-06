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
import type {
  ApprovalDecision,
  TuvrenExtension,
  TuvrenModelResponse,
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

    if (toolName === undefined) {
      return runDirectDriverExecute(providerResponses);
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

    return {
      evidence: {
        driver: {
          phase: handle.status().phase,
        },
        hooks: {
          afterIteration: hooks.afterIteration,
          aroundModel: hooks.aroundModel,
          aroundTool: hooks.aroundTool,
          beforeIteration: hooks.beforeIteration,
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

  async function runDirectDriverExecute(
    providerResponses: readonly TuvrenModelResponse[]
  ): Promise<AdapterProjection> {
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();
    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: createScenarioProvider(providerResponses, () => undefined),
          name: AGENT_NAME,
        },
      })
    );

    assertDriverExecutionResult(result, "driver execute result");

    return {
      evidence: {
        driver: {
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
  aroundTool: number;
  beforeIteration: number;
}

function createHookCounters(): HookCounters {
  return {
    afterIteration: 0,
    aroundModel: 0,
    aroundTool: 0,
    beforeIteration: 0,
  };
}

function createMeasuredExtension(hooks: HookCounters): TuvrenExtension {
  return {
    afterIteration() {
      hooks.afterIteration += 1;
    },
    async aroundModel(_context, next) {
      hooks.aroundModel += 1;
      return await next();
    },
    async aroundTool(_context, next) {
      hooks.aroundTool += 1;
      return await next();
    },
    beforeIteration() {
      hooks.beforeIteration += 1;
    },
    name: "measured-driver-hooks",
  };
}
