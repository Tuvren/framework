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

import type { DriverExecutionContext } from "@tuvren/driver-api";
import { assertDriverExecutionResult } from "@tuvren/driver-api";
import type { ProviderStreamChunk, TuvrenProvider } from "@tuvren/provider-api";
import type {
  StructuredOutputRequest,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import { createReActDriver } from "../../drivers/react/src/index.ts";
import {
  executeGenerateCall,
  executeStreamCall,
} from "../../drivers/react/src/lib/react-driver-stream.ts";
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
  createClock,
  createConformanceIdFactory,
  createDriverExecutionContext,
  createStaticDriver,
  DRIVER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

export interface FrameworkAdapterProviderScenarioDependencies {
  readAssistantText(
    messages: readonly unknown[],
    expectedText: string
  ): string | undefined;
  readFirstErrorEnvelope(
    events: readonly unknown[]
  ): Record<string, unknown> | undefined;
  readModelResponseProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): TuvrenModelResponse;
  readOperationScenario(
    input: unknown,
    operation: string
  ): Record<string, unknown>;
  readPromptProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): TuvrenPrompt;
  readProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): unknown;
  readProviderStreamChunks(
    record: Record<string, unknown>,
    path: string
  ): ProviderStreamChunk[];
  readResponseFormatProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): StructuredOutputRequest | undefined;
  readScenarioToolCall(
    record: Record<string, unknown>,
    path: string
  ): {
    readonly callId: string;
    readonly input: unknown;
    readonly name: string;
    readonly output?: unknown;
    readonly requiresApproval?: boolean;
  };
  readStringProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): string;
}

export function createFrameworkAdapterProviderScenarios(
  dependencies: FrameworkAdapterProviderScenarioDependencies
): {
  runContextTransform(input: unknown): Promise<AdapterProjection>;
  runProviderGenerate(input: unknown): Promise<AdapterProjection>;
  runProviderStream(input: unknown): Promise<AdapterProjection>;
  runStructuredValidationFailure(input: unknown): Promise<AdapterProjection>;
  runToolExecution(input: unknown): Promise<AdapterProjection>;
} {
  async function runProviderGenerate(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.provider-generate"
    );
    const response = dependencies.readModelResponseProperty(
      scenario,
      "providerResponse",
      "runtime.provider-generate.providerResponse"
    );
    const prompt = dependencies.readPromptProperty(
      scenario,
      "prompt",
      "runtime.provider-generate.prompt"
    );
    let generateCalls = 0;
    const provider: TuvrenProvider = {
      generate() {
        generateCalls += 1;
        return Promise.resolve(structuredClone(response));
      },
      id: "provider",
      async *stream() {
        await Promise.resolve();
        yield* [];
      },
    };
    const sequence = await executeGenerateCall({
      now: createClock(),
      prompt,
      provider,
    });

    return {
      evidence: {
        provider: {
          generate: {
            callCount: generateCalls,
            eventTypes: sequence.events.map((event) => event.type),
            response: sequence.response,
          },
        },
      },
    };
  }

  async function runProviderStream(input: unknown): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.provider-stream"
    );
    const chunks = dependencies.readProviderStreamChunks(
      scenario,
      "runtime.provider-stream.streamChunks"
    );
    const prompt = dependencies.readPromptProperty(
      scenario,
      "prompt",
      "runtime.provider-stream.prompt"
    );
    let streamCalls = 0;
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider: TuvrenProvider = {
      generate() {
        return Promise.reject(
          new Error("generate must not run during stream conformance")
        );
      },
      id: "provider",
      async *stream() {
        await Promise.resolve();
        streamCalls += 1;
        for (const chunk of chunks) {
          yield structuredClone(chunk);
        }
      },
    };
    const sequence = await executeStreamCall({
      now: createClock(),
      prompt,
      provider,
      runtime: {
        emit(event) {
          emittedEvents.push(event);
        },
        now: createClock(),
      },
    });

    return {
      evidence: {
        provider: {
          stream: {
            callCount: streamCalls,
            chunkTypes: chunks.map((chunk) => chunk.type),
            emittedEventTypes: emittedEvents.map((event) => event.type),
            response: sequence.response,
          },
        },
      },
    };
  }

  async function runToolExecution(input: unknown): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.tool-execute"
    );
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      "runtime.tool-execute.prompt"
    );
    const call = dependencies.readScenarioToolCall(
      scenario.toolCall as Record<string, unknown>,
      "runtime.tool-execute.toolCall"
    );
    const toolResult = dependencies.readProperty(
      scenario,
      "toolResult",
      "runtime.tool-execute.toolResult"
    );
    const finalText = dependencies.readStringProperty(
      scenario,
      "finalText",
      "runtime.tool-execute.finalText"
    );
    const harness = createFakeKernelHarness();
    let toolCalls = 0;
    const toolInputs: unknown[] = [];
    const toolOutputs: unknown[] = [];
    const driver = createStaticDriver(
      async (context: DriverExecutionContext) => {
        await Promise.resolve();

        if (!context.messages.some((message) => message.role === "tool")) {
          return {
            messages: [assistantToolCalls([call])],
            resolution: { type: "continue_iteration" as const },
            toolExecutionMode: "parallel",
          };
        }

        return {
          messages: [assistantText(finalText)],
          resolution: {
            reason: "done",
            type: "end_turn" as const,
          },
        };
      }
    );
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: AGENT_NAME,
        tools: [
          {
            description: "Search docs",
            execute() {
              toolCalls += 1;
              toolInputs.push(call.input);
              toolOutputs.push(toolResult);
              return toolResult;
            },
            inputSchema: { type: "object" },
            name: call.name,
          },
        ],
      },
      signal: textSignal(prompt),
      threadId: thread.threadId,
    });

    const events = await collectValues(handle.events());

    return {
      evidence: {
        tool: {
          execution: {
            callCount: toolCalls,
            inputs: toolInputs,
            outputs: toolOutputs,
          },
        },
      },
      state: {
        toolExecution: {
          error: dependencies.readFirstErrorEnvelope(events),
          status: handle.status(),
        },
      },
    };
  }

  async function runStructuredValidationFailure(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.validate-structured-output"
    );
    const response = dependencies.readModelResponseProperty(
      scenario,
      "providerResponse",
      "runtime.validate-structured-output.providerResponse"
    );
    const responseFormat = dependencies.readResponseFormatProperty(
      scenario,
      "responseFormat",
      "runtime.validate-structured-output.responseFormat"
    );
    const provider: TuvrenProvider = {
      generate() {
        return Promise.resolve(structuredClone(response));
      },
      id: "provider",
      async *stream() {
        await Promise.resolve();
        yield* [];
      },
    };
    const driver = createReActDriver({ providerCallMode: "generate" }).create();
    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: AGENT_NAME,
          responseFormat,
        },
      })
    );

    assertDriverExecutionResult(result, "structured validation result");

    return {
      evidence: {
        validation: {
          error:
            result.resolution.type === "fail"
              ? {
                  message: result.resolution.error.message,
                }
              : undefined,
          resolutionType: result.resolution.type,
        },
      },
    };
  }

  async function runContextTransform(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.context-transform"
    );
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      "runtime.context-transform.prompt"
    );
    const summaryText = dependencies.readStringProperty(
      scenario,
      "summaryText",
      "runtime.context-transform.summaryText"
    );
    const finalText = dependencies.readStringProperty(
      scenario,
      "finalText",
      "runtime.context-transform.finalText"
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
      config: {
        contextPolicy: {
          evaluate(_manifest, iterationCount) {
            if (iterationCount !== 1) {
              return { action: "none" };
            }

            return {
              action: "append_shared_summary",
              execute(context) {
                return [
                  ...context.messageHashes,
                  context.helpers.storeMessage(assistantText(summaryText)),
                ];
              },
            };
          },
        },
        name: AGENT_NAME,
      },
      signal: textSignal(prompt),
      threadId: thread.threadId,
    });

    await collectValues(handle.events());
    const manifest = await harness.readBranchManifest(thread.branchId);
    const messages = await harness.readBranchMessages(thread.branchId);

    return {
      evidence: {
        context: {
          messageCount: messages.length,
          summaryText: dependencies.readAssistantText(messages, summaryText),
        },
        runtime: {
          phase: handle.status().phase,
        },
      },
      state: {
        context: {
          manifest,
        },
      },
    };
  }

  return {
    runContextTransform,
    runProviderGenerate,
    runProviderStream,
    runStructuredValidationFailure,
    runToolExecution,
  };
}
