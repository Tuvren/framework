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
  TuvrenModelResponse,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import { toAgUiEvents } from "@tuvren/stream-agui";
import { teeTuvrenStreamEvents } from "@tuvren/stream-core";
import { toSseFrames } from "@tuvren/stream-sse";
import {
  type AdapterProjection,
  AGENT_NAME,
  collectValues,
  createRuntimeWithReactDriver,
  createScenarioProvider,
  textSignal,
} from "./framework-adapter-runtime.ts";

export interface FrameworkAdapterEventStreamDependencies {
  isRecord(value: unknown): value is Record<string, unknown>;
  parseJsonValue(value: string): unknown;
  readApprovalDecisions(
    record: Record<string, unknown>,
    path: string
  ): ApprovalDecision[];
  readFirstToolCallName(
    responses: readonly TuvrenModelResponse[],
    path: string
  ): string;
  readModelResponseArrayProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): TuvrenModelResponse[];
  readProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): unknown;
  readRecordString(record: unknown, key: string): string | undefined;
  readScenarioInput(input: unknown, operation: string): Record<string, unknown>;
  readStringProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): string;
}

export function createFrameworkAdapterEventStream(
  dependencies: FrameworkAdapterEventStreamDependencies
): {
  runAgUiProjection(input: unknown): Promise<AdapterProjection>;
  runSseEagerSubscription(input: unknown): Promise<AdapterProjection>;
  runSseProjection(input: unknown): Promise<AdapterProjection>;
} {
  async function runSseProjection(input: unknown): Promise<AdapterProjection> {
    const sourceEvents = await runEventStreamScenario(input, "event-stream");
    const frames = await collectValues(
      toSseFrames(createEventStream(sourceEvents))
    );
    const projectedEvents = frames.map((frame) => ({
      event: frame.event,
      payload: dependencies.parseJsonValue(frame.data),
    }));

    return {
      events: projectedEvents,
      result: {
        events: projectedEvents,
        sourceEvents,
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
    const projectedEvents = frames.map((frame) => ({
      event: frame.event,
      payload: dependencies.parseJsonValue(frame.data),
    }));

    return {
      events: projectedEvents,
      result: {
        events: projectedEvents,
        ...(firstDirectEvent.done === false
          ? { firstDirectEvent: firstDirectEvent.value }
          : {}),
      },
    };
  }

  async function runAgUiProjection(input: unknown): Promise<AdapterProjection> {
    const sourceEvents = await runEventStreamScenario(input, "event-stream");
    const warnings: Array<{ code: string }> = [];
    const events = await collectValues(
      toAgUiEvents(createEventStream(sourceEvents), {
        onWarning(warning) {
          warnings.push({ code: warning.code });
        },
      })
    );

    return {
      events,
      result: {
        events,
        sourceEvents,
        warnings,
      },
    };
  }

  return {
    runAgUiProjection,
    runSseEagerSubscription,
    runSseProjection,
  };

  function runEventStreamScenario(
    input: unknown,
    label: string
  ): Promise<readonly TuvrenStreamEvent[]> {
    const scenario = dependencies.readScenarioInput(input, label);
    const operation = dependencies.readStringProperty(
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
      case "event-stream.resumed-approval-turn":
        return runResumedApprovalEventStreamTurn(scenario, label);
      default:
        throw new Error(`${label} scenario declared unsupported ${operation}`);
    }
  }

  async function runCompletedToolEventStreamTurn(
    scenario: Record<string, unknown>,
    label: string
  ): Promise<readonly TuvrenStreamEvent[]> {
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      `${label}.prompt`
    );
    const providerResponses = dependencies.readModelResponseArrayProperty(
      scenario,
      "providerResponses",
      `${label}.providerResponses`
    );
    const toolName = dependencies.readFirstToolCallName(
      providerResponses,
      `${label}.providerResponses`
    );
    const toolResult = dependencies.readProperty(
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
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      `${label}.prompt`
    );
    const providerResponses = dependencies.readModelResponseArrayProperty(
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
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      `${label}.prompt`
    );
    const providerResponses = dependencies.readModelResponseArrayProperty(
      scenario,
      "providerResponses",
      `${label}.providerResponses`
    );
    const toolName = dependencies.readFirstToolCallName(
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
              return dependencies.readProperty(
                scenario,
                "toolResult",
                `${label}.toolResult`
              );
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

  async function runResumedApprovalEventStreamTurn(
    scenario: Record<string, unknown>,
    label: string
  ): Promise<readonly TuvrenStreamEvent[]> {
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      `${label}.prompt`
    );
    const providerResponses = dependencies.readModelResponseArrayProperty(
      scenario,
      "providerResponses",
      `${label}.providerResponses`
    );
    const toolName = dependencies.readFirstToolCallName(
      providerResponses,
      `${label}.providerResponses`
    );
    const approvalDecisions = dependencies.readApprovalDecisions(
      scenario,
      `${label}.approvalDecisions`
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
            description: "Shared resumed event-stream approval tool",
            execute() {
              return dependencies.readProperty(
                scenario,
                "toolResult",
                `${label}.toolResult`
              );
            },
            inputSchema: { type: "object" },
            name: toolName,
          },
        ],
      },
      signal: textSignal(prompt),
      threadId: thread.threadId,
    });
    const pausedEvents = await collectValues(handle.events());

    if (handle.status().phase !== "paused") {
      throw new Error(`${label} did not pause before resuming`);
    }

    const resumedHandle = handle.resolveApproval({
      decisions: approvalDecisions,
    });
    const resumedEvents = await collectValues(resumedHandle.events());

    if (resumedHandle.status().phase !== "completed") {
      throw new Error(`${label} did not complete after approval resume`);
    }

    const combinedEvents = [...pausedEvents, ...resumedEvents];
    const finalEvent = combinedEvents.at(-1);

    if (
      !dependencies.isRecord(finalEvent) ||
      dependencies.readRecordString(finalEvent, "type") !== "turn.end" ||
      dependencies.readRecordString(finalEvent, "status") !== "completed"
    ) {
      throw new Error(`${label} did not emit a completed turn.end event`);
    }

    if (
      !combinedEvents.some(
        (event) =>
          dependencies.readRecordString(event, "type") === "approval.resolved"
      )
    ) {
      throw new Error(`${label} did not emit approval.resolved after resume`);
    }

    return combinedEvents;
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
}
