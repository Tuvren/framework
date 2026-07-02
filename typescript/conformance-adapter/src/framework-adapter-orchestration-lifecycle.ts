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

import {
  createDriverRegistry,
  createOrchestrationRuntime,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import {
  type AdapterProjection,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createStaticDriver,
  DRIVER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

export interface FrameworkAdapterOrchestrationLifecycleDependencies {
  createObservedErrorEnvelope(error: unknown): Record<string, unknown>;
  readOperationScenario(
    input: unknown,
    operation: string
  ): Record<string, unknown>;
  readStringProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): string;
}

export function createFrameworkAdapterOrchestrationLifecycle(
  dependencies: FrameworkAdapterOrchestrationLifecycleDependencies
): {
  runOrchestrationLifecycleLocality(input: unknown): Promise<AdapterProjection>;
} {
  async function runOrchestrationLifecycleLocality(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.orchestration.lifecycle-locality"
    );
    const lifecycleCase = dependencies.readStringProperty(
      scenario,
      "case",
      "runtime.orchestration.lifecycle-locality.case"
    );

    switch (lifecycleCase) {
      case "parent_pause_child_continues":
        return await runOrchestrationParentPauseChildContinues(
          dependencies.readStringProperty(
            scenario,
            "childText",
            "runtime.orchestration.lifecycle-locality.childText"
          ),
          dependencies.readStringProperty(
            scenario,
            "parentText",
            "runtime.orchestration.lifecycle-locality.parentText"
          )
        );
      case "child_pause_parent_completes":
        return await runOrchestrationChildPauseParentCompletes(
          dependencies.readStringProperty(
            scenario,
            "childText",
            "runtime.orchestration.lifecycle-locality.childText"
          ),
          dependencies.readStringProperty(
            scenario,
            "parentText",
            "runtime.orchestration.lifecycle-locality.parentText"
          )
        );
      case "child_cancel_parent_completes":
        return await runOrchestrationChildCancelParentCompletes(
          dependencies.readStringProperty(
            scenario,
            "childText",
            "runtime.orchestration.lifecycle-locality.childText"
          ),
          dependencies.readStringProperty(
            scenario,
            "parentText",
            "runtime.orchestration.lifecycle-locality.parentText"
          )
        );
      case "parent_cancel_child_completes":
        return await runOrchestrationParentCancelChildCompletes(
          dependencies.readStringProperty(
            scenario,
            "childText",
            "runtime.orchestration.lifecycle-locality.childText"
          ),
          dependencies.readStringProperty(
            scenario,
            "parentText",
            "runtime.orchestration.lifecycle-locality.parentText"
          )
        );
      case "spawn_requires_running_handle":
        return await runOrchestrationSpawnRequiresRunningHandle();
      default:
        throw new Error(
          `runtime.orchestration.lifecycle-locality declared unsupported case ${lifecycleCase}`
        );
    }
  }

  return {
    runOrchestrationLifecycleLocality,
  };

  async function runOrchestrationParentPauseChildContinues(
    childText: string,
    parentText: string
  ): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            await sleep(40);
            return {
              messages: [assistantText(childText)],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          const toolMessages = context.messages.filter(
            (message) => message.role === "tool"
          );

          if (toolMessages.length === 0) {
            return {
              messages: [
                assistantToolCalls([
                  {
                    callId: "call-hold",
                    input: { hold: true },
                    name: "hold",
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
        primary: {
          name: "primary",
          tools: [
            {
              approval: true,
              description: "Pause the parent turn",
              execute() {
                return { approved: true };
              },
              inputSchema: {
                properties: {
                  hold: { type: "boolean" },
                },
                required: ["hold"],
                type: "object",
              },
              name: "hold",
            },
          ],
        },
        worker: { name: "worker" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("pause"),
      threadId: thread.threadId,
    });
    const subtreeEventsPromise = collectValues(handle.allEvents());

    await sleep(0);

    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("background"),
    });
    await waitUntil(() => handle.status().phase === "paused");
    const childResult = await childHandle.awaitResult();
    const pausedPhase = handle.status().phase;
    const resumedHandle = handle.resolveApproval({
      decisions: [{ callId: "call-hold", type: "approve" }],
    });
    const resumedResult = await resumedHandle.awaitResult();
    await subtreeEventsPromise;

    const lifecycle = {
      childResult,
      parentPausedWhileChildCompleted:
        pausedPhase === "paused" && firstVisibleText(childResult) === childText,
      resumedParentPhase: resumedHandle.status().phase,
      resumedParentResult: resumedResult,
    };

    return {
      evidence: { orchestration: { lifecycle } },
      result: { orchestration: { lifecycle } },
    };
  }

  async function runOrchestrationChildPauseParentCompletes(
    childText: string,
    parentText: string
  ): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          const toolMessages = context.messages.filter(
            (message) => message.role === "tool"
          );

          if (context.config.name === "worker") {
            if (toolMessages.length === 0) {
              return {
                messages: [
                  assistantToolCalls([
                    {
                      callId: "call-approve-worker",
                      input: { hold: true },
                      name: "hold",
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
        worker: {
          name: "worker",
          tools: [
            {
              approval: true,
              description: "Pause worker review",
              execute() {
                return { approved: true };
              },
              inputSchema: {
                properties: {
                  hold: { type: "boolean" },
                },
                required: ["hold"],
                type: "object",
              },
              name: "hold",
            },
          ],
        },
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
      signal: textSignal("approval"),
    });
    await collectValues(childHandle.events());
    // Child is now paused. Wait for the parent to complete independently (it does not
    // collect child results), then resume the child and collect both results.
    const pausedPhase = childHandle.status().phase;
    await waitUntil(() => handle.status().phase === "completed");
    const parentPhaseWhileChildPaused = handle.status().phase;
    const resumedChildHandle = childHandle.resolveApproval({
      decisions: [{ callId: "call-approve-worker", type: "approve" }],
    });
    const resumedChildResult = await resumedChildHandle.awaitResult();
    const parentResult = await handle.awaitResult();
    await parentEventsPromise;

    const lifecycle = {
      childPausedPhase: pausedPhase,
      childResumedPhase: resumedChildHandle.status().phase,
      parentCompletedWhileChildPaused:
        pausedPhase === "paused" &&
        parentPhaseWhileChildPaused === "completed" &&
        firstVisibleText(parentResult) === parentText,
      resumedChildResult,
    };

    return {
      evidence: { orchestration: { lifecycle } },
      result: { orchestration: { lifecycle } },
    };
  }

  async function runOrchestrationChildCancelParentCompletes(
    childText: string,
    parentText: string
  ): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            await sleep(100);
            return {
              messages: [assistantText(childText)],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          await sleep(30);
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

    await Promise.resolve();

    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("child"),
    });
    await sleep(10);
    childHandle.cancel();
    const childError = await captureAsyncActionError(async () => {
      await childHandle.awaitResult();
    });
    const parentResult = await handle.awaitResult();
    await parentEventsPromise;

    const lifecycle = {
      childCancelError: childError,
      childCancelledWhileParentCompleted:
        childHandle.status().phase === "failed" &&
        handle.status().phase === "completed" &&
        firstVisibleText(parentResult) === parentText,
    };

    return {
      evidence: { orchestration: { lifecycle } },
      result: { orchestration: { lifecycle } },
    };
  }

  async function runOrchestrationParentCancelChildCompletes(
    childText: string,
    _parentText: string
  ): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            await sleep(80);
            return {
              messages: [assistantText(childText)],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          await sleep(200);
          return {
            messages: [assistantText("Parent done.")],
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

    await Promise.resolve();

    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("child"),
    });
    await sleep(10);
    handle.cancel();
    const parentCancelError = await captureAsyncActionError(async () => {
      await handle.awaitResult();
    });
    const childResult = await childHandle.awaitResult();
    await parentEventsPromise;

    const lifecycle = {
      childResult,
      parentCancelError,
      parentCancelledWhileChildCompleted:
        handle.status().phase === "failed" &&
        childHandle.status().phase === "completed" &&
        firstVisibleText(childResult) === childText,
    };

    return {
      evidence: { orchestration: { lifecycle } },
      result: { orchestration: { lifecycle } },
    };
  }

  async function runOrchestrationSpawnRequiresRunningHandle(): Promise<AdapterProjection> {
    const pausedSpawnError = await runPausedParentSpawnRejection();
    const completedSpawnError = await runCompletedParentSpawnRejection();

    const lifecycle = {
      completedSpawnError,
      pausedSpawnError,
    };

    return {
      evidence: { orchestration: { lifecycle } },
      result: { orchestration: { lifecycle } },
    };
  }

  async function runPausedParentSpawnRejection(): Promise<
    Record<string, unknown> | undefined
  > {
    const harness = createConformanceKernelHarness();
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver((context) => {
          const toolMessages = context.messages.filter(
            (message) => message.role === "tool"
          );

          if (toolMessages.length === 0) {
            return {
              messages: [
                assistantToolCalls([
                  {
                    callId: "call-hold",
                    input: { hold: true },
                    name: "hold",
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
            messages: [assistantText("Parent resumed.")],
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
        primary: {
          name: "primary",
          tools: [
            {
              approval: true,
              description: "Pause the parent turn",
              execute() {
                return { approved: true };
              },
              inputSchema: {
                properties: {
                  hold: { type: "boolean" },
                },
                required: ["hold"],
                type: "object",
              },
              name: "hold",
            },
          ],
        },
        worker: { name: "worker" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("pause"),
      threadId: thread.threadId,
    });

    await collectValues(handle.events());

    if (handle.status().phase !== "paused") {
      throw new Error("paused spawn rejection scenario did not pause");
    }

    return captureActionError(() =>
      handle.spawn({
        agent: "worker",
        signal: textSignal("background"),
      })
    );
  }

  async function runCompletedParentSpawnRejection(): Promise<
    Record<string, unknown> | undefined
  > {
    const harness = createConformanceKernelHarness();
    const framework = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(async () => ({
          messages: [assistantText("Parent complete.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
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
      signal: textSignal("complete"),
      threadId: thread.threadId,
    });

    await collectValues(handle.events());

    if (handle.status().phase !== "completed") {
      throw new Error("completed spawn rejection scenario did not complete");
    }

    return captureActionError(() =>
      handle.spawn({
        agent: "worker",
        signal: textSignal("too-late"),
      })
    );
  }

  function firstVisibleText(result: unknown): string | undefined {
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result)
    ) {
      return undefined;
    }
    type KV = Record<string, unknown>;
    const r = result as KV;
    const msg = r.finalAssistantMessage;
    if (typeof msg !== "object" || msg === null) {
      return undefined;
    }
    const parts = (msg as KV).parts;
    if (!Array.isArray(parts)) {
      return undefined;
    }
    const textPart = parts.find(
      (p) => typeof p === "object" && p !== null && (p as KV).type === "text"
    );
    if (textPart === undefined) {
      return undefined;
    }
    const text = (textPart as KV).text;
    return typeof text === "string" ? text : undefined;
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

  async function waitUntil(
    predicate: () => boolean,
    timeoutMs = 1000
  ): Promise<void> {
    const start = Date.now();

    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out after ${timeoutMs}ms`);
      }

      await sleep(5);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
