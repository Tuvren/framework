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

import type { RuntimeDriver } from "@tuvren/driver-api";
import type { AgentConfig } from "@tuvren/runtime-api";
import {
  createDriverRegistry,
  createOrchestrationRuntime,
  createTuvrenRuntimeCore,
  DEFAULT_AGENT_SCHEMA,
} from "../../runtime-core/src/index.ts";
import { createFakeKernelHarness } from "../../runtime-core/test/fake-kernel.ts";
import { createFrameworkAdapterOrchestrationLifecycle } from "./framework-adapter-orchestration-lifecycle.ts";
import {
  type AdapterProjection,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createStaticDriver,
  DRIVER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

export interface FrameworkAdapterOrchestrationDependencies {
  createObservedErrorEnvelope(error: unknown): Record<string, unknown>;
  isRecord(value: unknown): value is Record<string, unknown>;
  readOperationScenario(
    input: unknown,
    operation: string
  ): Record<string, unknown>;
  readRecordString(record: unknown, key: string): string | undefined;
  readStringProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): string;
}

export function createFrameworkAdapterOrchestration(
  dependencies: FrameworkAdapterOrchestrationDependencies
): {
  runOrchestrationEventSurfaces(input: unknown): Promise<AdapterProjection>;
  runOrchestrationExecutionInheritance(
    input: unknown
  ): Promise<AdapterProjection>;
  runOrchestrationLaunchPreconditions(
    input: unknown
  ): Promise<AdapterProjection>;
  runOrchestrationLifecycleLocality(input: unknown): Promise<AdapterProjection>;
  runOrchestrationNestedAttribution(input: unknown): Promise<AdapterProjection>;
} {
  const lifecycleScenarios = createFrameworkAdapterOrchestrationLifecycle({
    createObservedErrorEnvelope: dependencies.createObservedErrorEnvelope,
    readOperationScenario: dependencies.readOperationScenario,
    readStringProperty: dependencies.readStringProperty,
  });

  async function runOrchestrationLaunchPreconditions(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.orchestration.launch-preconditions"
    );
    const parentText = dependencies.readStringProperty(
      scenario,
      "parentText",
      "runtime.orchestration.launch-preconditions.parentText"
    );
    const childText = dependencies.readStringProperty(
      scenario,
      "childText",
      "runtime.orchestration.launch-preconditions.childText"
    );
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            await sleep(5);
            return {
              messages: [assistantText(childText)],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          await sleep(20);
          return {
            messages: [assistantText(parentText)],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }),
      ]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("launch"),
      threadId: thread.threadId,
    });
    const preStartSpawnError = captureActionError(() =>
      handle.spawn({
        agent: "worker",
        signal: textSignal("too-early"),
      })
    );
    const preStartAwaitResultError = await captureAsyncActionError(async () => {
      await handle.awaitResult();
    });
    const postAwaitSpawnError = captureActionError(() =>
      handle.spawn({
        agent: "worker",
        signal: textSignal("still-too-early"),
      })
    );
    const subtreeEventsPromise = collectValues(handle.allEvents());

    await sleep(0);

    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("child"),
    });
    const childEventsPromise = collectValues(childHandle.events());
    const childResult = await childHandle.awaitResult();
    const [subtreeEvents, childEvents] = await Promise.all([
      subtreeEventsPromise,
      childEventsPromise,
    ]);
    const childThreadId = findThreadId(childEvents);

    return {
      evidence: {
        orchestration: {
          launch: {
            childResult,
            childRunsOnOwnThread:
              childThreadId !== undefined && childThreadId !== thread.threadId,
            childThreadId,
            descendantThreadId: findDescendantThreadId(subtreeEvents),
            parentThreadId: thread.threadId,
            postAwaitSpawnError,
            preStartAwaitResultError,
            preStartSpawnError,
          },
        },
      },
    };
  }

  async function runOrchestrationLifecycleLocality(
    input: unknown
  ): Promise<AdapterProjection> {
    return await lifecycleScenarios.runOrchestrationLifecycleLocality(input);
  }

  async function runOrchestrationEventSurfaces(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.orchestration.event-surfaces"
    );
    const reviewerText =
      typeof scenario.reviewerText === "string"
        ? scenario.reviewerText
        : undefined;

    if (reviewerText !== undefined) {
      return await runOrchestrationHandoffAttribution(
        dependencies.readStringProperty(
          scenario,
          "parentText",
          "runtime.orchestration.event-surfaces.parentText"
        ),
        reviewerText
      );
    }

    const parentText = dependencies.readStringProperty(
      scenario,
      "parentText",
      "runtime.orchestration.event-surfaces.parentText"
    );
    const childText = dependencies.readStringProperty(
      scenario,
      "childText",
      "runtime.orchestration.event-surfaces.childText"
    );
    const failureMessage = dependencies.readStringProperty(
      scenario,
      "failureMessage",
      "runtime.orchestration.event-surfaces.failureMessage"
    );
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            await sleep(5);
            return {
              messages: [assistantText(childText)],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          await sleep(20);
          return {
            messages: [assistantText(parentText)],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }),
      ]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("root"),
      threadId: thread.threadId,
    });
    const parentEventsPromise = collectValues(handle.events());
    const subtreeEventsPromise = collectValues(handle.allEvents());

    await sleep(0);

    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("child"),
    });
    const childSubtreeEventsPromise = collectValues(childHandle.allEvents());
    const childResult = await childHandle.awaitResult();
    const [parentEvents, subtreeEvents, childSubtreeEvents, parentMessages] =
      await Promise.all([
        parentEventsPromise,
        subtreeEventsPromise,
        childSubtreeEventsPromise,
        harness.readBranchMessages(thread.branchId),
      ]);
    const descendantEvent = findTextEventWithWorker(subtreeEvents, childText);
    const failedAwaitResultError =
      await runFailedOrchestrationAwaitResult(failureMessage);

    return {
      evidence: {
        orchestration: {
          surfaces: {
            allEventsIncludeDescendants: descendantEvent !== undefined,
            childAllEventsRemainAvailable:
              findTextEvent(childSubtreeEvents, childText) !== undefined,
            childResult,
            descendantSourceAttributed:
              dependencies.readRecordString(
                descendantEvent?.source,
                "agent"
              ) !== undefined &&
              dependencies.readRecordString(
                descendantEvent?.source,
                "threadId"
              ) !== undefined &&
              dependencies.readRecordString(
                descendantEvent?.source,
                "workerId"
              ) !== undefined,
            descendantSource: descendantEvent?.source,
            eventsSelfOnly: !parentEvents.some(
              (event) =>
                dependencies.readRecordString(event, "type") === "text.done" &&
                dependencies.readRecordString(event, "text") === childText
            ),
            failedAwaitResultError,
            failedAwaitResultRejected:
              failedAwaitResultError?.message === failureMessage,
            noCanonicalWorkerResultInjection:
              !containsWorkerResult(parentMessages),
          },
        },
      },
    };
  }

  async function runOrchestrationExecutionInheritance(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.orchestration.execution-inheritance"
    );
    const childToolStatus = dependencies.readStringProperty(
      scenario,
      "childToolStatus",
      "runtime.orchestration.execution-inheritance.childToolStatus"
    );
    const defaultDriver = {
      async execute(context) {
        if (context.config.name === "worker") {
          return {
            messages: [assistantText("Default worker driver.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await sleep(20);
        return {
          messages: [assistantText("Default parent driver.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "default",
    } satisfies RuntimeDriver;
    const specialDriver = {
      async execute(context) {
        if (context.config.name === "worker") {
          const toolMessages = context.messages.filter(
            (message) => message.role === "tool"
          );

          if (toolMessages.length === 0) {
            return {
              messages: [
                assistantToolCalls([
                  {
                    callId: "call-research",
                    input: { query: "inherit" },
                    name: "research",
                  },
                ]),
              ],
              resolution: {
                type: "continue_iteration",
              },
              toolExecutionMode: "parallel",
            };
          }

          return {
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await sleep(20);
        return {
          messages: [assistantText("Special parent driver.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "special",
    } satisfies RuntimeDriver;
    const harness = createFakeKernelHarness();
    await harness.kernel.schema.register({
      ...structuredClone(DEFAULT_AGENT_SCHEMA),
      schemaId: "custom.agent.v1",
    });
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: "default",
      driverRegistry: createDriverRegistry([defaultDriver, specialDriver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      driverId: "special",
      schemaId: "custom.agent.v1",
      signal: textSignal("root"),
      threadId: thread.threadId,
      tools: [
        {
          description: "Inherited research tool",
          execute() {
            return { status: childToolStatus };
          },
          inputSchema: {
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
            type: "object",
          },
          name: "research",
        },
      ],
    });

    const parentEventsPromise = collectValues(handle.events());

    await sleep(0);

    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("child"),
    });
    const childEvents = await collectValues(childHandle.events());
    const childResult = await childHandle.awaitResult();

    await parentEventsPromise;

    const childThreadId = findThreadId(childEvents);
    const childThread =
      childThreadId === undefined
        ? null
        : await framework.getThread(childThreadId);

    return {
      evidence: {
        orchestration: {
          inheritance: {
            childResult,
            childThreadId,
            driverIdInherited: childEvents.some(
              (event) =>
                dependencies.readRecordString(event, "type") ===
                  "tool.result" &&
                dependencies.isRecord(event.source) &&
                event.source.driver === "special"
            ),
            schemaInherited: childThread?.schemaId === "custom.agent.v1",
            toolsInherited: firstVisiblePartType(childResult) === "tool_result",
          },
        },
      },
    };
  }

  async function runOrchestrationNestedAttribution(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.orchestration.nested-attribution"
    );
    const grandchildText = dependencies.readStringProperty(
      scenario,
      "grandchildText",
      "runtime.orchestration.nested-attribution.grandchildText"
    );
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            await sleep(20);
            return {
              messages: [assistantText("Child complete.")],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          if (context.config.name === "worker-2") {
            return {
              messages: [assistantText(grandchildText)],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          await sleep(20);
          return {
            messages: [assistantText("Root complete.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }),
      ]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
        "worker-2": { name: "worker-2" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("root"),
      threadId: thread.threadId,
    });
    const rootEventsPromise = collectValues(handle.allEvents());

    await Promise.resolve();

    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("child"),
    });
    const childEventsPromise = collectValues(childHandle.allEvents());

    await Promise.resolve();

    const grandchildHandle = childHandle.spawn({
      agent: "worker-2",
      signal: textSignal("grandchild"),
    });
    const grandchildResult = await grandchildHandle.awaitResult();
    const [rootEvents, childEvents] = await Promise.all([
      rootEventsPromise,
      childEventsPromise,
    ]);
    const rootGrandchildEvent = findTextEvent(rootEvents, grandchildText);
    const childGrandchildEvent = findTextEvent(childEvents, grandchildText);

    return {
      evidence: {
        orchestration: {
          nested: {
            childGrandchildSource: childGrandchildEvent?.source,
            childReceivesGrandchild: childGrandchildEvent !== undefined,
            grandchildResult,
            rootGrandchildSource: rootGrandchildEvent?.source,
            rootReceivesGrandchild: rootGrandchildEvent !== undefined,
          },
        },
      },
    };
  }

  return {
    runOrchestrationEventSurfaces,
    runOrchestrationExecutionInheritance,
    runOrchestrationLaunchPreconditions,
    runOrchestrationLifecycleLocality,
    runOrchestrationNestedAttribution,
  };

  async function runFailedOrchestrationAwaitResult(
    failureMessage: string
  ): Promise<Record<string, unknown> | undefined> {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            throw new Error(failureMessage);
          }

          await sleep(20);
          return {
            messages: [assistantText("Parent finished.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }),
      ]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("root"),
      threadId: thread.threadId,
    });

    const parentEventsPromise = collectValues(handle.allEvents());
    await sleep(0);

    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("failure"),
    });

    const childError = await captureAsyncActionError(async () => {
      await childHandle.awaitResult();
    });
    await parentEventsPromise;
    return childError;
  }

  async function runOrchestrationHandoffAttribution(
    parentText: string,
    reviewerText: string
  ): Promise<AdapterProjection> {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
      worker: { name: "worker" },
    };
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            return {
              messages: [assistantText("Passing this to reviewer.")],
              resolution: {
                contextPlan: context.handoff.createContextPlan({
                  mode: "last_output_only",
                  reason: "review_handoff",
                  targetAgent: "reviewer",
                }),
                targetAgent: "reviewer",
                type: "handoff",
              },
            };
          }

          if (context.config.name === "reviewer") {
            return {
              messages: [assistantText(reviewerText)],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          await sleep(20);
          return {
            messages: [assistantText(parentText)],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }),
      ]),
      kernel: harness.kernel,
      resolveAgentConfig(agentName) {
        return agents[agentName];
      },
    });
    const orchestration = createOrchestrationRuntime({
      agents,
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Start root"),
      threadId: thread.threadId,
    });
    const rootEventsPromise = collectValues(handle.allEvents());

    await sleep(0);

    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("handoff child"),
    });
    const childEvents = await collectValues(childHandle.events());
    const childResult = await childHandle.awaitResult();
    const rootEvents = await rootEventsPromise;
    const childReviewerEvent = findTextEvent(childEvents, reviewerText);
    const rootReviewerEvent = rootEvents.find(
      (event) =>
        dependencies.isRecord(event) &&
        event.type === "text.done" &&
        event.text === reviewerText &&
        dependencies.isRecord(event.source) &&
        typeof event.source.workerId === "string"
    );

    return {
      evidence: {
        orchestration: {
          surfaces: {
            childResult,
            handoffDescendantAgentPreserved:
              readSourceAgent(childReviewerEvent) === "reviewer" &&
              readSourceAgent(rootReviewerEvent) === "reviewer",
            handoffRootSource: dependencies.isRecord(rootReviewerEvent)
              ? rootReviewerEvent.source
              : undefined,
          },
        },
      },
    };
  }

  function findThreadId(events: readonly unknown[]): string | undefined {
    for (const event of events) {
      const threadId = dependencies.readRecordString(event, "threadId");

      if (threadId !== undefined) {
        return threadId;
      }
    }

    return undefined;
  }

  function findDescendantThreadId(
    events: readonly unknown[]
  ): string | undefined {
    for (const event of events) {
      if (
        !(dependencies.isRecord(event) && dependencies.isRecord(event.source))
      ) {
        continue;
      }

      const threadId =
        typeof event.source.threadId === "string"
          ? event.source.threadId
          : undefined;

      if (threadId !== undefined) {
        return threadId;
      }
    }

    return undefined;
  }

  function findTextEvent(
    events: readonly unknown[],
    text: string
  ): Record<string, unknown> | undefined {
    for (const event of events) {
      if (
        dependencies.isRecord(event) &&
        event.type === "text.done" &&
        typeof event.text === "string" &&
        event.text === text
      ) {
        return event;
      }
    }

    return undefined;
  }

  function findTextEventWithWorker(
    events: readonly unknown[],
    text: string
  ): Record<string, unknown> | undefined {
    for (const event of events) {
      if (
        !(dependencies.isRecord(event) && dependencies.isRecord(event.source))
      ) {
        continue;
      }

      if (
        event.type === "text.done" &&
        typeof event.text === "string" &&
        event.text === text &&
        typeof event.source.workerId === "string"
      ) {
        return event;
      }
    }

    return undefined;
  }

  function readSourceAgent(event: unknown): string | undefined {
    return dependencies.isRecord(event) && dependencies.isRecord(event.source)
      ? dependencies.readRecordString(event.source, "agent")
      : undefined;
  }

  function containsWorkerResult(messages: readonly unknown[]): boolean {
    for (const message of messages) {
      if (
        !dependencies.isRecord(message) ||
        message.role !== "user" ||
        !Array.isArray(message.parts)
      ) {
        continue;
      }

      for (const part of message.parts) {
        if (
          dependencies.isRecord(part) &&
          part.type === "structured" &&
          part.name === "worker_result"
        ) {
          return true;
        }
      }
    }

    return false;
  }

  function firstVisiblePartType(result: unknown): string | undefined {
    if (!Array.isArray(result)) {
      return undefined;
    }

    const [firstPart] = result;
    return dependencies.readRecordString(firstPart, "type");
  }

  function captureActionError(
    action: () => unknown
  ): Record<string, unknown> | undefined {
    try {
      action();
      return undefined;
    } catch (error: unknown) {
      return dependencies.createObservedErrorEnvelope(error);
    }
  }

  async function captureAsyncActionError(
    action: () => Promise<unknown>
  ): Promise<Record<string, unknown> | undefined> {
    try {
      await action();
      return undefined;
    } catch (error: unknown) {
      return dependencies.createObservedErrorEnvelope(error);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
