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

import { EventSchemas } from "@ag-ui/core";
import { assertHashString, type HashString } from "@tuvren/core-types";
import type {
  DriverExecutionContext,
  DriverExecutionResult,
  RuntimeDriver,
} from "@tuvren/driver-api";
import { assertDriverExecutionResult } from "@tuvren/driver-api";
import type { ProviderStreamChunk, TuvrenProvider } from "@tuvren/provider-api";
import type {
  ApprovalDecision,
  ContextManifest,
  InputSignal,
  StructuredOutputRequest,
  ToolCallPart,
  ToolRegistry,
  TuvrenExtension,
  TuvrenJsonSchema,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
} from "@tuvren/runtime-api";
import {
  assertProviderStreamChunk,
  assertTuvrenMessage,
  assertTuvrenModelResponse,
} from "@tuvren/runtime-api";
import { toAgUiEvents } from "@tuvren/stream-agui";
import { teeTuvrenStreamEvents } from "@tuvren/stream-core";
import { toSseFrames } from "@tuvren/stream-sse";
import {
  type AdapterCapabilities,
  type AdapterControls,
  createAdapterErrorEnvelope,
  type OperationOutcome,
} from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { createReActDriver } from "../../drivers/react/src/index.ts";
import {
  executeGenerateCall,
  executeStreamCall,
} from "../../drivers/react/src/lib/react-driver-stream.ts";
import {
  createDriverRegistry,
  createTuvrenRuntimeCore,
  DEFAULT_AGENT_SCHEMA,
} from "../../runtime-core/src/index.ts";
import { createFakeKernelHarness } from "../../runtime-core/test/fake-kernel.ts";

export type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../../../../../tools/conformance/adapter-protocol/index.js";

export interface EvidenceRecord {
  readonly checkId: string;
  readonly key: string;
  readonly payload: unknown;
}

export interface ImplementationAdapter {
  dispatch(
    operation: string,
    input: unknown,
    controls: AdapterControls
  ): Promise<OperationOutcome>;
  emitEvidence(checkId: string, key: string, payload: unknown): Promise<void>;
  events(
    operation: string,
    input: unknown,
    controls: AdapterControls
  ): AsyncIterable<unknown>;
  initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities>;
  inspectState?(query: unknown): Promise<unknown | null>;
  shutdown(): Promise<void>;
}

interface AdapterProjection {
  events?: readonly unknown[];
  evidence?: Record<string, unknown>;
  result?: unknown;
  state?: Record<string, unknown>;
}

interface OperationObservation {
  adapterEvents: number;
  initialized: boolean;
  status: OperationStatus;
}

const DRIVER_ID = "typescript-conformance-driver";
const AGENT_NAME = "typescript-conformance-agent";

type OperationStatus = "completed" | "failed" | "paused";

function createConformanceIdFactory(): () => string {
  let nextId = 1;

  // Compatibility evidence is checked in, so conformance-only runtime IDs stay
  // deterministic while the production runtime keeps its random default IDs.
  return () => `conformance-id-${nextId++}`;
}

export class TypeScriptFrameworkAdapter implements ImplementationAdapter {
  readonly evidence: EvidenceRecord[] = [];
  private capabilities?: AdapterCapabilities;
  private readonly observations = new Map<string, OperationObservation>();
  private latestState: Record<string, unknown> | null = null;

  async dispatch(
    operation: string,
    input: unknown,
    controls: AdapterControls
  ): Promise<OperationOutcome> {
    this.requireInitialized();
    throwIfCancelled(controls);

    try {
      const projection = await this.projectOperation(
        operation,
        input,
        controls
      );
      const status = projectionStatus(projection);
      this.latestState = projection.state ?? null;
      this.observations.set(operation, {
        adapterEvents: 0,
        initialized: true,
        status,
      });

      return {
        kind: "result",
        value: projection,
      };
    } catch (error: unknown) {
      const envelope = createAdapterErrorEnvelope(error);
      this.latestState = {
        adapterError: envelope,
      };
      this.observations.set(operation, {
        adapterEvents: 0,
        initialized: true,
        status: "failed",
      });

      return {
        error: envelope,
        kind: "error",
      };
    }
  }

  emitEvidence(checkId: string, key: string, payload: unknown): Promise<void> {
    this.evidence.push({ checkId, key, payload });
    return Promise.resolve();
  }

  async *events(
    operation: string,
    _input: unknown,
    controls: AdapterControls
  ): AsyncIterable<unknown> {
    await Promise.resolve();
    this.requireInitialized();
    throwIfCancelled(controls);

    const observation = this.observations.get(operation);
    const event = {
      operation,
      status: observation?.status ?? "completed",
      type: "adapter.operation.observed",
    };

    if (observation !== undefined) {
      this.observations.set(operation, {
        ...observation,
        adapterEvents: observation.adapterEvents + 1,
      });
    }

    yield event;
  }

  initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities> {
    this.capabilities = {
      adapterId: "typescript-framework",
      packetId,
      planVersion,
    };
    return Promise.resolve(this.capabilities);
  }

  inspectState(query: unknown): Promise<unknown | null> {
    if (!isRecord(query) || typeof query.operation !== "string") {
      return Promise.resolve(this.latestState);
    }

    const observation = this.observations.get(query.operation);

    return Promise.resolve({
      ...(this.latestState ?? {}),
      adapter: observation,
    });
  }

  shutdown(): Promise<void> {
    this.capabilities = undefined;
    this.evidence.length = 0;
    this.latestState = null;
    this.observations.clear();
    return Promise.resolve();
  }

  private requireInitialized(): AdapterCapabilities {
    if (this.capabilities === undefined) {
      throw new Error("implementation adapter must be initialized first");
    }

    return this.capabilities;
  }

  private projectOperation(
    operation: string,
    input: unknown,
    controls: AdapterControls
  ): Promise<AdapterProjection> {
    // This switch is language-local adapter routing only; shared plans own the
    // assertions and expected semantics, and this file must only measure TS behavior.
    switch (operation) {
      case "runtime.execute-turn":
        return runCompletedRuntimeTurn();
      case "runtime.cancel-execution":
        return runCancelledRuntimeTurn(controls);
      case "runtime.approval-resolve":
        return runApprovalResume(input);
      case "runtime.branch-create":
        return runBranchCreate();
      case "runtime.provider-generate":
        return runProviderGenerate(input);
      case "runtime.provider-stream":
        return runProviderStream(input);
      case "runtime.tool-execute":
        return runToolExecution(input);
      case "runtime.validate-structured-output":
        return runStructuredValidationFailure(input);
      case "runtime.context-transform":
        return runContextTransform(input);
      case "runtime.recover-result":
        return runRecoverResult(input);
      case "driver.execute":
        return runDriverExecute(input);
      case "driver.resume":
        return runDriverResume(input);
      case "driver.checkpoint":
        return runDriverCheckpoint(input);
      case "event-stream.runtime-agui-projection":
        return runAgUiProjection(input);
      case "event-stream.runtime-sse-eager-subscription":
        return runSseEagerSubscription(input);
      case "event-stream.runtime-sse-projection":
        return runSseProjection(input);
      default:
        throw new Error(
          `unsupported promoted framework operation ${operation}`
        );
    }
  }
}

async function runSseProjection(input: unknown): Promise<AdapterProjection> {
  const events = await runEventStreamScenario(input, "event-stream");
  const frames = await collectValues(toSseFrames(createEventStream(events)));

  return {
    evidence: {
      sourceEventTypes: events.map((event) => event.type),
      frameEvents: frames.map((frame) => frame.event),
      framePayloads: frames.map((frame) => parseJsonValue(frame.data)),
    },
  };
}

async function runSseEagerSubscription(
  input: unknown
): Promise<AdapterProjection> {
  const events = await runEventStreamScenario(input, "event-stream");
  const [sseBranch, directBranch] = teeTuvrenStreamEvents(
    createEventStream(events),
    2
  );
  const sseFrames = toSseFrames(sseBranch);
  const directIterator = directBranch[Symbol.asyncIterator]();
  const firstDirectEvent = await directIterator.next();

  await Promise.resolve();
  await directIterator.return?.();

  const frames = await collectValues(sseFrames);

  return {
    evidence: {
      firstDirectEventType:
        firstDirectEvent.done === false
          ? readRecordString(firstDirectEvent.value, "type")
          : undefined,
      firstFrameEvent: frames[0]?.event,
    },
  };
}

async function runAgUiProjection(input: unknown): Promise<AdapterProjection> {
  const sourceEvents = await runEventStreamScenario(input, "event-stream");
  const warningCodes: string[] = [];
  const rawEvents = await collectValues(
    toAgUiEvents(createEventStream(sourceEvents), {
      onWarning(warning) {
        warningCodes.push(warning.code);
      },
    })
  );
  const events = rawEvents.map((event) => EventSchemas.parse(event));

  return {
    evidence: {
      sourceEventTypes: sourceEvents.map((event) => event.type),
      eventTypes: events.map((event) => event.type),
      events,
      warningCodes,
    },
  };
}

function runEventStreamScenario(
  input: unknown,
  label: string
): Promise<readonly TuvrenStreamEvent[]> {
  const scenario = readScenarioInput(input, label);
  const operation = readStringProperty(
    scenario,
    "operation",
    `${label}.scenario.operation`
  );

  switch (operation) {
    case "event-stream.completed-tool-turn":
      return runCompletedToolEventStreamTurn(scenario, label);
    case "event-stream.failed-provider-turn":
      return runFailedProviderEventStreamTurn(scenario, label);
    case "event-stream.paused-approval-turn":
      return runPausedApprovalEventStreamTurn(scenario, label);
    default:
      throw new Error(`${label} scenario declared unsupported ${operation}`);
  }
}

async function runCompletedToolEventStreamTurn(
  scenario: Record<string, unknown>,
  label: string
): Promise<readonly TuvrenStreamEvent[]> {
  const prompt = readStringProperty(scenario, "prompt", `${label}.prompt`);
  const providerResponses = readModelResponseArrayProperty(
    scenario,
    "providerResponses",
    `${label}.providerResponses`
  );
  const toolName = readFirstToolCallName(
    providerResponses,
    `${label}.providerResponses`
  );
  const toolResult = readProperty(
    scenario,
    "toolResult",
    `${label}.toolResult`
  );
  const runtime = createRuntimeWithReactDriver();
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      model: createScenarioProvider(providerResponses, () => undefined),
      name: AGENT_NAME,
      tools: [
        {
          description: "Shared event-stream conformance tool",
          execute() {
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

  return await collectValues(handle.events());
}

async function runFailedProviderEventStreamTurn(
  scenario: Record<string, unknown>,
  label: string
): Promise<readonly TuvrenStreamEvent[]> {
  const prompt = readStringProperty(scenario, "prompt", `${label}.prompt`);
  const providerResponses = readModelResponseArrayProperty(
    scenario,
    "providerResponses",
    `${label}.providerResponses`
  );
  const runtime = createRuntimeWithReactDriver();
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      model: createScenarioProvider(providerResponses, () => undefined),
      name: AGENT_NAME,
    },
    signal: textSignal(prompt),
    threadId: thread.threadId,
  });

  return await collectValues(handle.events());
}

async function runPausedApprovalEventStreamTurn(
  scenario: Record<string, unknown>,
  label: string
): Promise<readonly TuvrenStreamEvent[]> {
  const prompt = readStringProperty(scenario, "prompt", `${label}.prompt`);
  const providerResponses = readModelResponseArrayProperty(
    scenario,
    "providerResponses",
    `${label}.providerResponses`
  );
  const toolName = readFirstToolCallName(
    providerResponses,
    `${label}.providerResponses`
  );
  const runtime = createRuntimeWithReactDriver();
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      model: createScenarioProvider(providerResponses, () => undefined),
      name: AGENT_NAME,
      tools: [
        {
          approval: true,
          description: "Shared event-stream approval tool",
          execute() {
            return readProperty(scenario, "toolResult", `${label}.toolResult`);
          },
          inputSchema: { type: "object" },
          name: toolName,
        },
      ],
    },
    signal: textSignal(prompt),
    threadId: thread.threadId,
  });

  return await collectValues(handle.events());
}

async function runCompletedRuntimeTurn(): Promise<AdapterProjection> {
  const harness = createFakeKernelHarness();
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([
      createStaticDriver(() => ({
        messages: [assistantText("completed")],
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
    signal: textSignal("run"),
    threadId: thread.threadId,
  });
  const events = await collectValues(handle.events());

  return {
    evidence: {
      runtime: {
        eventCount: events.length,
        phase: handle.status().phase,
      },
    },
  };
}

async function runCancelledRuntimeTurn(
  controls: AdapterControls
): Promise<AdapterProjection> {
  const harness = createFakeKernelHarness();
  let executeCount = 0;
  const driver = {
    async execute(context) {
      executeCount += 1;

      if (executeCount === 1) {
        return {
          messages: [assistantText("first pass")],
          resolution: { type: "continue_iteration" },
        };
      }

      await waitForAbort(context.signal);
      return {
        messages: [assistantText("interrupted")],
        partial: true,
        resolution: {
          error: new Error("driver observed cancellation"),
          fatality: "hard",
          type: "fail",
        },
      };
    },
    id: DRIVER_ID,
  } satisfies RuntimeDriver;
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("cancel"),
    threadId: thread.threadId,
  });
  const events: unknown[] = [];
  const cancelAfterEvent = controls.cancelAfterEvent;
  let cancelInvocations = 0;
  let observedEventIndex: number | undefined;
  let observedEventType: string | undefined;

  if (cancelAfterEvent === undefined) {
    throw new Error(
      "runtime cancellation checks must declare cancelAfterEvent"
    );
  }

  for await (const event of handle.events()) {
    events.push(event);

    if (observedEventType !== undefined) {
      continue;
    }

    const eventType = readRecordString(event, "type");

    if (eventType === cancelAfterEvent) {
      observedEventIndex = events.length - 1;
      observedEventType = eventType;
      // The second cancel call proves the handle's cancellation surface is
      // idempotent for the measured stream, instead of only proving one abort.
      handle.cancel();
      cancelInvocations += 1;
      handle.cancel();
      cancelInvocations += 1;
    }
  }

  return {
    evidence: {
      cancellation: {
        cancelInvocations,
        errorEventCount: countEventsByType(events, "error"),
        observedEventIndex,
        observedEventType,
      },
      controls: {
        cancelAfterEvent: controls.cancelAfterEvent,
        deadlineMs: controls.deadlineMs,
      },
      runtime: {
        iterationCount: handle.status().iterationCount,
        phase: handle.status().phase,
      },
    },
    result: {
      error: readFirstErrorEnvelope(events),
    },
  };
}

async function runApprovalResume(input: unknown): Promise<AdapterProjection> {
  const scenario = readOperationScenario(input, "runtime.approval-resolve");
  const prompt = readStringProperty(
    scenario,
    "prompt",
    "runtime.approval-resolve.prompt"
  );
  const calls = readScenarioToolCalls(
    scenario,
    "runtime.approval-resolve.toolCalls"
  );
  const decisions = readApprovalDecisions(
    scenario,
    "runtime.approval-resolve.approvalDecisions"
  );
  const finalText = readStringProperty(
    scenario,
    "finalText",
    "runtime.approval-resolve.finalText"
  );
  const harness = createFakeKernelHarness();
  const executedNames: string[] = [];
  const driver = {
    async execute(context) {
      await Promise.resolve();

      if (!hasToolMessage(context.messages)) {
        return {
          messages: [assistantToolCalls(calls)],
          resolution: { type: "continue_iteration" },
          toolExecutionMode: "parallel",
        };
      }

      return {
        messages: [assistantText(finalText)],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      };
    },
    id: DRIVER_ID,
  } satisfies RuntimeDriver;
  const tools = calls.map(
    (call): TuvrenToolDefinition => ({
      approval: call.requiresApproval,
      description: `Shared conformance tool ${call.name}`,
      execute() {
        executedNames.push(call.name);
        return call.output;
      },
      inputSchema: { type: "object" },
      name: call.name,
    })
  );
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const pausedHandle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME, tools },
    signal: textSignal(prompt),
    threadId: thread.threadId,
  });

  const pausedEvents = await collectValues(pausedHandle.events());
  const pausedPhase = pausedHandle.status().phase;

  if (pausedPhase !== "paused") {
    return {
      evidence: {
        approval: {
          pausedPhase,
        },
        tool: { execution: { executedNames } },
      },
      state: {
        approvalError: readFirstErrorEnvelope(pausedEvents),
        approval: pausedHandle.status(),
      },
    };
  }

  const resumedHandle = pausedHandle.resolveApproval({
    decisions,
  });

  await collectValues(resumedHandle.events());

  return {
    evidence: {
      approval: {
        decisions,
        pausedPhase,
        resumedPhase: resumedHandle.status().phase,
      },
      tool: { execution: { executedNames } },
    },
  };
}

async function runBranchCreate(): Promise<AdapterProjection> {
  const harness = createFakeKernelHarness();
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([
      createStaticDriver(() => ({
        messages: [assistantText("branch base")],
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
    signal: textSignal("complete before branch"),
    threadId: thread.threadId,
  });
  const completedEvents = await collectValues(handle.events());
  const completedHeadTurnNodeHash = readLastCheckpointHash(completedEvents);
  const sourceMessages = await harness.readBranchMessages(thread.branchId);
  const branch = await runtime.createBranch({
    fromTurnNodeHash: completedHeadTurnNodeHash,
    threadId: thread.threadId,
  });

  return {
    state: {
      branch: {
        completedTurnPhase: handle.status().phase,
        createdBranchId: branch.branchId,
        createdHeadTurnNodeHash: branch.headTurnNodeHash,
        sourceBranchId: thread.branchId,
        sourceHeadTurnNodeHash: completedHeadTurnNodeHash,
        sourceMessageCount: sourceMessages.length,
      },
    },
  };
}

async function runProviderGenerate(input: unknown): Promise<AdapterProjection> {
  const scenario = readOperationScenario(input, "runtime.provider-generate");
  const response = readModelResponseProperty(
    scenario,
    "providerResponse",
    "runtime.provider-generate.providerResponse"
  );
  const prompt = readPromptProperty(
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
  const scenario = readOperationScenario(input, "runtime.provider-stream");
  const chunks = readProviderStreamChunks(
    scenario,
    "runtime.provider-stream.streamChunks"
  );
  const prompt = readPromptProperty(
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
  const scenario = readOperationScenario(input, "runtime.tool-execute");
  const prompt = readStringProperty(
    scenario,
    "prompt",
    "runtime.tool-execute.prompt"
  );
  const call = readScenarioToolCall(
    readRecordProperty(scenario, "toolCall", "runtime.tool-execute.toolCall"),
    "runtime.tool-execute.toolCall"
  );
  const toolResult = readProperty(
    scenario,
    "toolResult",
    "runtime.tool-execute.toolResult"
  );
  const finalText = readStringProperty(
    scenario,
    "finalText",
    "runtime.tool-execute.finalText"
  );
  const harness = createFakeKernelHarness();
  let toolCalls = 0;
  const toolInputs: unknown[] = [];
  const toolOutputs: unknown[] = [];
  const driver = {
    async execute(context) {
      await Promise.resolve();

      if (!hasToolMessage(context.messages)) {
        return {
          messages: [assistantToolCalls([call])],
          resolution: { type: "continue_iteration" },
          toolExecutionMode: "parallel",
        };
      }

      return {
        messages: [assistantText(finalText)],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      };
    },
    id: DRIVER_ID,
  } satisfies RuntimeDriver;
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
        error: readFirstErrorEnvelope(events),
        status: handle.status(),
      },
    },
  };
}

async function runStructuredValidationFailure(
  input: unknown
): Promise<AdapterProjection> {
  const scenario = readOperationScenario(
    input,
    "runtime.validate-structured-output"
  );
  const response = readModelResponseProperty(
    scenario,
    "providerResponse",
    "runtime.validate-structured-output.providerResponse"
  );
  const responseFormat = readResponseFormatProperty(
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

async function runContextTransform(input: unknown): Promise<AdapterProjection> {
  const scenario = readOperationScenario(input, "runtime.context-transform");
  const prompt = readStringProperty(
    scenario,
    "prompt",
    "runtime.context-transform.prompt"
  );
  const summaryText = readStringProperty(
    scenario,
    "summaryText",
    "runtime.context-transform.summaryText"
  );
  const finalText = readStringProperty(
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
        summaryText: readAssistantText(messages, summaryText),
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

async function runRecoverResult(input: unknown): Promise<AdapterProjection> {
  const scenario = readOperationScenario(input, "runtime.recover-result");
  const stagedObject = readRecordProperty(
    scenario,
    "stagedObject",
    "runtime.recover-result.stagedObject"
  );
  const taskId = readStringProperty(
    stagedObject,
    "taskId",
    "runtime.recover-result.stagedObject.taskId"
  );
  const objectType = readStringProperty(
    stagedObject,
    "objectType",
    "runtime.recover-result.stagedObject.objectType"
  );
  const payload = readProperty(
    stagedObject,
    "payload",
    "runtime.recover-result.stagedObject.payload"
  );
  const harness = createFakeKernelHarness();
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([
      createStaticDriver(() => ({
        messages: [assistantText("recovery placeholder")],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      })),
    ]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const runId = "shared-recovery-run";

  await harness.kernel.run.create(
    runId,
    "shared-recovery-turn",
    thread.branchId,
    DEFAULT_AGENT_SCHEMA.schemaId,
    thread.rootTurnNodeHash,
    [
      {
        deterministic: false,
        id: taskId,
        sideEffects: false,
      },
    ]
  );
  await harness.kernel.staging.stage(
    runId,
    new TextEncoder().encode(JSON.stringify(payload)),
    taskId,
    objectType,
    "completed"
  );

  const recovery = await harness.kernel.run.recover(runId);
  const [firstStagedResult] = recovery.uncommittedStagedResults;

  return {
    evidence: {
      recovery: {
        firstObjectType: firstStagedResult?.objectType,
        firstTaskId: firstStagedResult?.taskId,
        lastTurnNodeHash: recovery.lastTurnNodeHash,
        uncommittedStagedResults: recovery.uncommittedStagedResults.length,
      },
    },
    state: {
      recovery,
    },
  };
}

async function runDriverExecute(input: unknown): Promise<AdapterProjection> {
  const scenario = readOperationScenario(input, "driver.execute");
  const providerResponses = readModelResponseArrayProperty(
    scenario,
    "providerResponses",
    "driver.execute.providerResponses"
  );
  const toolName = readFirstToolCallNameOptional(
    providerResponses,
    "driver.execute.providerResponses"
  );
  if (toolName === undefined) {
    return runDirectDriverExecute(providerResponses);
  }

  const prompt = readStringProperty(
    scenario,
    "prompt",
    "driver.execute.prompt"
  );
  const toolResult = readProperty(
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
          ? errorToEnvelope(result.resolution.error)
          : undefined,
    },
  };
}

async function runDriverResume(input: unknown): Promise<AdapterProjection> {
  const scenario = readOperationScenario(input, "driver.resume");
  const pendingToolCalls = readPendingToolCalls(
    scenario,
    "driver.resume.pendingToolCalls"
  );
  const decisions = readApprovalDecisions(
    scenario,
    "driver.resume.approvalDecisions"
  );
  const providerResponses = readModelResponseArrayProperty(
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
    approval: {
      decisions,
    },
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
          ? errorToEnvelope(result.resolution.error)
          : undefined,
    },
  };
}

async function runDriverCheckpoint(input: unknown): Promise<AdapterProjection> {
  const scenario = readOperationScenario(input, "driver.checkpoint");
  const finalText = readStringProperty(
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

function createScenarioProvider(
  responses: readonly TuvrenModelResponse[],
  onGenerate: () => void
): TuvrenProvider {
  let responseIndex = 0;

  return {
    generate() {
      onGenerate();

      const response = responses[responseIndex] ?? responses.at(-1);

      if (response === undefined) {
        return Promise.reject(
          new Error("driver scenario must provide at least one response")
        );
      }

      responseIndex += 1;
      return Promise.resolve(structuredClone(response));
    },
    id: "provider",
    async *stream() {
      await Promise.resolve();
      yield* [];
    },
  };
}

function createRuntimeWithReactDriver(): ReturnType<
  typeof createTuvrenRuntimeCore
> {
  const reactDriver = createReActDriver({
    providerCallMode: "generate",
  }).create();

  return createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: reactDriver.id,
    driverRegistry: createDriverRegistry([reactDriver]),
    kernel: createFakeKernelHarness().kernel,
  });
}

function createStaticDriver(
  execute: (
    context: DriverExecutionContext
  ) => DriverExecutionResult | Promise<DriverExecutionResult>
): RuntimeDriver {
  return {
    execute(context) {
      return Promise.resolve(execute(context));
    },
    id: DRIVER_ID,
  };
}

function createDriverExecutionContext(input?: {
  config?: DriverExecutionContext["config"];
  emittedEvents?: TuvrenStreamEvent[];
  manifest?: ContextManifest;
  messages?: readonly TuvrenMessage[];
  signal?: AbortSignal;
  toolDefinitions?: TuvrenToolDefinition[];
}): DriverExecutionContext {
  const emittedEvents = input?.emittedEvents ?? [];
  const toolDefinitions = input?.toolDefinitions ?? [];

  return {
    branchId: "branch-1",
    config: input?.config ?? { name: AGENT_NAME },
    handoff: {
      createContextPlan({ reason, targetAgent }) {
        return {
          builder() {
            return [];
          },
          mode: "preserve_trace",
          reason,
          sourceContext: {
            handoffIntent: { targetAgent },
            helpers: {
              loadMessage() {
                return null;
              },
              storeMessage() {
                return "0".repeat(64);
              },
              storeMessages() {
                return [];
              },
            },
            manifest: createContextManifest(),
            messages: [],
            sourceAgent: { name: AGENT_NAME },
            targetAgent: { name: targetAgent },
          },
          targetAgent,
        };
      },
    },
    iterationCount: 1,
    manifest: input?.manifest ?? createContextManifest(),
    messages: input?.messages ?? [
      {
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      },
    ],
    runtime: {
      emit(event) {
        emittedEvents.push(event);
      },
      now: createClock(),
    },
    schemaId: "tuvren.agent.v1",
    signal: input?.signal,
    threadId: "thread-1",
    toolRegistry: createToolRegistry(toolDefinitions),
    turnId: "turn-1",
  };
}

function createToolRegistry(
  tools: readonly TuvrenToolDefinition[]
): ToolRegistry {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    get(name: string) {
      return toolsByName.get(name);
    },
    has(name: string) {
      return toolsByName.has(name);
    },
    list() {
      return [...toolsByName.values()];
    },
    register(tool: TuvrenToolDefinition) {
      toolsByName.set(tool.name, tool);
    },
    toDefinitions() {
      return [...toolsByName.values()].map((tool) => ({
        description: tool.description,
        inputSchema: { type: "object" },
        name: tool.name,
      }));
    },
  };
}

function createContextManifest(): ContextManifest {
  return {
    byRole: {
      assistant: 0,
      system: 0,
      tool: 0,
      user: 1,
    },
    extensions: {},
    lastAssistantMessageIndex: -1,
    lastUserMessageIndex: 0,
    messageCount: 1,
    tokenEstimate: 0,
    toolCalls: {
      byName: {},
      total: 0,
    },
    toolResults: {
      byName: {},
      total: 0,
    },
    turnBoundaries: [0],
  };
}

function assistantText(text: string): TuvrenMessage {
  return {
    parts: [{ text, type: "text" }],
    role: "assistant",
  };
}

function assistantToolCalls(calls: readonly ScenarioToolCall[]): TuvrenMessage {
  const firstCall = calls[0];

  if (firstCall === undefined) {
    throw new Error("tool call scenario must contain at least one call");
  }

  const remainingCalls = calls.slice(1);
  const parts: [ToolCallPart, ...ToolCallPart[]] = [
    toToolCallPart(firstCall),
    ...remainingCalls.map(toToolCallPart),
  ];

  return {
    parts,
    role: "assistant",
  };
}

function toToolCallPart(call: {
  callId: string;
  input: unknown;
  name: string;
}): ToolCallPart {
  return {
    callId: call.callId,
    input: call.input,
    name: call.name,
    type: "tool_call",
  };
}

function textSignal(text: string): InputSignal {
  return {
    parts: [{ text, type: "text" }],
  };
}

function hasToolMessage(messages: readonly TuvrenMessage[]): boolean {
  return messages.some((message) => message.role === "tool");
}

function createClock(): () => number {
  let now = 1;
  return () => now++;
}

function createEventStream(
  events: readonly TuvrenStreamEvent[]
): AsyncIterable<TuvrenStreamEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<TuvrenStreamEvent> {
      await Promise.resolve();

      for (const event of events) {
        yield structuredClone(event);
      }
    },
  };
}

async function collectValues<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const value of values) {
    collected.push(value);
  }

  return collected;
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined || signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function readFirstErrorEnvelope(
  events: readonly unknown[]
): Record<string, unknown> | undefined {
  for (const event of events) {
    if (isRecord(event) && isRecord(event.error)) {
      return event.error;
    }
  }

  return undefined;
}

function countEventsByType(events: readonly unknown[], type: string): number {
  let count = 0;

  for (const event of events) {
    if (readRecordString(event, "type") === type) {
      count += 1;
    }
  }

  return count;
}

function readLastCheckpointHash(events: readonly unknown[]): HashString {
  let checkpointHash: HashString | undefined;

  for (const event of events) {
    const turnNodeHash = readRecordString(event, "turnNodeHash");

    if (turnNodeHash !== undefined) {
      assertHashString(turnNodeHash, "state.checkpoint.turnNodeHash");
      checkpointHash = turnNodeHash;
    }
  }

  if (checkpointHash === undefined) {
    throw new Error("completed branch scenario did not emit a checkpoint hash");
  }

  return checkpointHash;
}

function errorToEnvelope(error: Error): Record<string, unknown> {
  const errorRecord: Record<string, unknown> = isRecord(error) ? error : {};
  const code =
    typeof errorRecord.code === "string" ? errorRecord.code : "driver_error";
  const envelope: Record<string, unknown> = {
    code,
    message: error.message,
  };

  if (errorRecord.details !== undefined) {
    envelope.details = errorRecord.details;
  }

  return envelope;
}

function readRecordString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function parseJsonValue(value: string): unknown {
  return JSON.parse(value);
}

function projectionStatus(projection: AdapterProjection): OperationStatus {
  if (isRecord(projection.result) && projection.result.error !== undefined) {
    return "failed";
  }

  return "completed";
}

function throwIfCancelled(controls: AdapterControls): void {
  if (controls.cancel !== undefined) {
    throw new Error(controls.cancel.reason);
  }
}

interface ScenarioToolCall {
  readonly callId: string;
  readonly input: unknown;
  readonly name: string;
  readonly output?: unknown;
  readonly requiresApproval?: boolean;
}

type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function readOperationScenario(
  input: unknown,
  operation: string
): Record<string, unknown> {
  const scenario = readScenarioInput(input, operation);
  const scenarioOperation = readStringProperty(
    scenario,
    "operation",
    `${operation}.scenario.operation`
  );

  if (scenarioOperation !== operation) {
    throw new Error(
      `${operation} scenario declared operation ${scenarioOperation}`
    );
  }

  return scenario;
}

function readScenarioInput(
  input: unknown,
  label: string
): Record<string, unknown> {
  const envelope = readRecord(input, `${label}.input`);
  const scenario = readRecordProperty(
    envelope,
    "scenario",
    `${label}.input.scenario`
  );

  return scenario;
}

function readPromptProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenPrompt {
  const value = readRecordProperty(source, key, label);
  const messages = readArrayProperty(value, "messages", `${label}.messages`);
  const promptMessages = messages.map((message, index) => {
    assertTuvrenMessage(message, `${label}.messages[${index}]`);
    return structuredClone(message);
  });
  const responseFormat =
    value.responseFormat === undefined
      ? undefined
      : readResponseFormat(value.responseFormat, `${label}.responseFormat`);

  return responseFormat === undefined
    ? { messages: promptMessages }
    : { messages: promptMessages, responseFormat };
}

function readModelResponseProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenModelResponse {
  const value = readRecordProperty(source, key, label);
  assertTuvrenModelResponse(value, label);
  return structuredClone(value);
}

function readModelResponseArrayProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenModelResponse[] {
  return readArrayProperty(source, key, label).map((value, index) => {
    assertTuvrenModelResponse(value, `${label}[${index}]`);
    return structuredClone(value);
  });
}

function readFirstToolCallName(
  responses: readonly TuvrenModelResponse[],
  label: string
): string {
  const toolCallName = readFirstToolCallNameOptional(responses, label);

  if (toolCallName !== undefined) {
    return toolCallName;
  }

  throw new Error(`${label} must contain a tool_call part`);
}

function readFirstToolCallNameOptional(
  responses: readonly TuvrenModelResponse[],
  _label: string
): string | undefined {
  for (const response of responses) {
    for (const part of response.parts) {
      if (part.type === "tool_call") {
        return part.name;
      }
    }
  }

  return undefined;
}

function readProviderStreamChunks(
  scenario: Record<string, unknown>,
  label: string
): ProviderStreamChunk[] {
  const values = readArrayProperty(scenario, "streamChunks", label);
  return values.map((value, index) => {
    assertProviderStreamChunk(value, `${label}[${index}]`);
    return structuredClone(value);
  });
}

function readResponseFormatProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): StructuredOutputRequest {
  return readResponseFormat(readProperty(source, key, label), label);
}

function readResponseFormat(
  value: unknown,
  label: string
): StructuredOutputRequest {
  const record = readRecord(value, label);
  const schema = readJsonSchemaProperty(record, "schema", `${label}.schema`);
  const name =
    record.name === undefined
      ? undefined
      : readStringProperty(record, "name", `${label}.name`);
  const strict =
    record.strict === undefined
      ? undefined
      : readBooleanProperty(record, "strict", `${label}.strict`);

  return {
    ...(name === undefined ? {} : { name }),
    schema,
    ...(strict === undefined ? {} : { strict }),
  };
}

function readScenarioToolCalls(
  scenario: Record<string, unknown>,
  label: string
): ScenarioToolCall[] {
  return readArrayProperty(scenario, "toolCalls", label).map((value, index) =>
    readScenarioToolCall(
      readRecord(value, `${label}[${index}]`),
      `${label}[${index}]`
    )
  );
}

function readScenarioToolCall(
  record: Record<string, unknown>,
  label: string
): ScenarioToolCall {
  return {
    callId: readStringProperty(record, "callId", `${label}.callId`),
    input: readProperty(record, "input", `${label}.input`),
    name: readStringProperty(record, "name", `${label}.name`),
    output: record.output,
    requiresApproval:
      record.requiresApproval === undefined
        ? undefined
        : readBooleanProperty(
            record,
            "requiresApproval",
            `${label}.requiresApproval`
          ),
  };
}

function readPendingToolCalls(
  scenario: Record<string, unknown>,
  label: string
): ScenarioToolCall[] {
  return readArrayProperty(scenario, "pendingToolCalls", label).map(
    (value, index) =>
      readScenarioToolCall(
        readRecord(value, `${label}[${index}]`),
        `${label}[${index}]`
      )
  );
}

function readApprovalDecisions(
  scenario: Record<string, unknown>,
  label: string
): ApprovalDecision[] {
  return readArrayProperty(scenario, "approvalDecisions", label).map(
    (value, index) => {
      const record = readRecord(value, `${label}[${index}]`);
      return {
        callId: readStringProperty(
          record,
          "callId",
          `${label}[${index}].callId`
        ),
        type: readStringProperty(record, "type", `${label}[${index}].type`),
      };
    }
  );
}

function readAssistantText(
  messages: readonly unknown[],
  expectedText: string
): string | undefined {
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
        part.text === expectedText
      ) {
        return expectedText;
      }
    }
  }

  return undefined;
}

function readJsonSchemaProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenJsonSchema {
  const value = readProperty(source, key, label);

  if (typeof value === "boolean") {
    return value;
  }

  return readJsonObject(value, label);
}

function readArrayProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): unknown[] {
  const value = readProperty(source, key, label);

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value;
}

function readRecordProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): Record<string, unknown> {
  return readRecord(readProperty(source, key, label), label);
}

function readStringProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = readProperty(source, key, label);

  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}

function readBooleanProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): boolean {
  const value = readProperty(source, key, label);

  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return value;
}

function readProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): unknown {
  if (!(key in source)) {
    throw new Error(`${label} is required`);
  }

  return source[key];
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
}

function readJsonValue(value: unknown, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      readJsonValue(item, `${label}[${index}]`)
    );
  }

  return readJsonObject(value, label);
}

function readJsonObject(
  value: unknown,
  label: string
): { [key: string]: JsonValue } {
  const record = readRecord(value, label);
  const object: { [key: string]: JsonValue } = {};

  for (const [key, item] of Object.entries(record)) {
    object[key] = readJsonValue(item, `${label}.${key}`);
  }

  return object;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
