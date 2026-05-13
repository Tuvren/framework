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
  createOrchestrationRuntime,
  type LoopPolicy,
  type TuvrenStreamEvent,
} from "@tuvren/runtime";
import { createPlaygroundHost } from "./playground-host.js";
import {
  countDurableToolCallProviderCallIds,
  countDurableToolCallThoughtSignatures,
  countToolCallProviderCallIdEvents,
  countToolCallThoughtSignatureEvents,
  createReport,
  createScenarioExecutionPlan,
  isEditedEmailToolStart,
  mergeProjections,
  projectContinuationCapture,
  readApprovalToolMetadataHistory,
  readApprovalToolMetadataObserved,
  readMetadataObserved,
  readProjectionError,
  readSteeringMessageDurable,
  readToolHistoryPreserved,
  readToolTraceObserved,
  startProjectionCapture,
  steerWhenRunning,
  waitFor,
  withHead,
} from "./playground-scenarios-support.js";
import { textSignal } from "./playground-tools.js";
import type {
  PlaygroundConfig,
  PlaygroundScenarioReport,
} from "./playground-types.js";
import {
  createProofExtension,
  PROOF_EXTENSION_EVENT_NAME,
  PROOF_EXTENSION_NAME,
} from "./proof-extension.js";

const CONTINUE_ONCE_POLICY: LoopPolicy = {
  evaluate(_response, _manifest, iterationCount) {
    return {
      continue: iterationCount < 2,
      executeTools: true,
      reason: "playground_continue_once",
    };
  },
};

export async function runPlaygroundScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  switch (config.scenario) {
    case "approval":
      return await runApprovalScenario(config);
    case "branching":
      return await runBranchingScenario(config);
    case "cancel":
      return await runCancelScenario(config);
    case "extension":
      return await runSingleTurnScenario(config);
    case "metadata":
    case "orchestration":
    case "streaming":
    case "structured":
    case "tools":
      return config.scenario === "orchestration"
        ? await runOrchestrationScenario(config)
        : await runSingleTurnScenario(config);
    case "reload":
      return await runReloadScenario(config);
    case "steering":
      return await runSteeringScenario(config);
    default:
      return await runSingleTurnScenario(config);
  }
}

async function runSingleTurnScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const executionPlan = createScenarioExecutionPlan(config);
  const handle = host.executeTurn({
    branchId: thread.branchId,
    config: {
      ...executionPlan.config,
      extensions:
        config.scenario === "extension" ? [createProofExtension()] : undefined,
      model: executionPlan.model,
      name: "primary",
      responseFormat:
        config.scenario === "structured"
          ? {
              name: "playground_summary",
              schema: {
                properties: {
                  scenario: { type: "string" },
                  status: { type: "string" },
                },
                required: ["scenario", "status"],
                type: "object",
              },
            }
          : undefined,
      tools: executionPlan.tools,
    },
    signal: executionPlan.signal,
    threadId: thread.threadId,
  });
  const projection = await host.project(handle);
  const messages = await host.readBranchMessages(thread.branchId);
  const toolResultCount = projection.canonical.filter(
    (event) => event.type === "tool.result"
  ).length;
  const toolCallThoughtSignatureCount =
    countToolCallThoughtSignatureEvents(projection);
  const durableToolCallThoughtSignatureCount =
    countDurableToolCallThoughtSignatures(messages);
  const toolCallProviderCallIdCount =
    countToolCallProviderCallIdEvents(projection);
  const durableToolCallProviderCallIdCount =
    countDurableToolCallProviderCallIds(messages);
  const metadataObserved = readMetadataObserved(config, messages);
  const toolHistoryPreserved = readToolHistoryPreserved(
    config,
    durableToolCallProviderCallIdCount,
    durableToolCallThoughtSignatureCount
  );
  const toolTraceObserved = readToolTraceObserved(
    config,
    toolCallProviderCallIdCount,
    toolCallThoughtSignatureCount
  );

  return createReport({
    checks: {
      aguiObserved: projection.agui.length > 0,
      canonicalObserved: projection.canonical.length > 0,
      completed: handle.status().phase === "completed",
      metadataObserved,
      sseObserved: projection.sse.length > 0,
      extensionEventObserved:
        config.scenario !== "extension" ||
        projection.canonical.some(
          (event) =>
            event.type === "custom" && event.name === PROOF_EXTENSION_EVENT_NAME
        ),
      extensionStatePersisted:
        config.scenario !== "extension" ||
        Boolean(handle.status().manifest?.extensions[PROOF_EXTENSION_NAME]),
      structuredObserved:
        config.scenario !== "structured" ||
        projection.canonical.some((event) => event.type === "structured.done"),
      toolObserved:
        config.scenario !== "tools" ||
        (config.providerMode === "ai-sdk-google"
          ? toolResultCount >= 2
          : toolResultCount > 0),
      toolHistoryPreserved,
      toolTraceObserved,
    },
    config,
    error: readProjectionError(projection),
    handle,
    projection,
    thread: withHead(thread, projection),
  });
}

async function runOrchestrationScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const orchestration = createOrchestrationRuntime({
    agents: {
      primary: {
        model: host.provider,
        name: "primary",
        ...(config.systemPrompt === undefined
          ? {}
          : {
              systemPrompt: config.systemPrompt,
            }),
      },
      worker: {
        model: host.provider,
        name: "worker",
        ...(config.systemPrompt === undefined
          ? {}
          : {
              systemPrompt: config.systemPrompt,
            }),
      },
    },
    framework: host.runtime,
  });
  const handle = orchestration.executeTurn({
    agent: "primary",
    branchId: thread.branchId,
    signal: textSignal("Run orchestration root"),
    threadId: thread.threadId,
  });
  const allEventsPromise = collectEvents(handle.allEvents());

  await waitFor(() => handle.status().phase === "running");

  const childHandle = handle.spawn({
    agent: "worker",
    signal: textSignal("Run orchestration child"),
  });
  const childResult = await childHandle.awaitResult();
  const rootResult = await handle.awaitResult();
  const canonical = await allEventsPromise;
  const projection = {
    agui: [],
    canonical,
    sse: [],
  };

  return createReport({
    checks: {
      childCompleted: childHandle.status().phase === "completed",
      childResultObserved: Array.isArray(childResult) && childResult.length > 0,
      descendantEventsObserved: canonical.some(
        (event) => event.source?.workerId !== undefined
      ),
      rootCompleted: handle.status().phase === "completed",
      rootResultObserved: Array.isArray(rootResult) && rootResult.length > 0,
    },
    config,
    handle,
    projection,
    thread: withHead(thread, projection),
  });
}

async function runApprovalScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const executionPlan = createScenarioExecutionPlan(config);
  const pausedHandle = host.executeTurn({
    branchId: thread.branchId,
    config: {
      ...executionPlan.config,
      model: executionPlan.model,
      maxParallelToolCalls: 2,
      name: "primary",
      tools: executionPlan.tools,
    },
    signal: executionPlan.signal,
    threadId: thread.threadId,
  });
  const pausedProjection = await host.project(pausedHandle);
  const approval = pausedHandle.status().approval;
  const pausedMessages = await host.readBranchMessages(thread.branchId);
  const pausedToolCallProviderCallIdCount =
    countDurableToolCallProviderCallIds(pausedMessages);
  const pausedToolMetadataObserved = readApprovalToolMetadataObserved(
    config,
    pausedProjection,
    pausedMessages
  );
  const pausedToolMetadataHistoryPreserved = readApprovalToolMetadataHistory(
    config,
    pausedMessages,
    pausedToolCallProviderCallIdCount
  );

  if (approval === undefined) {
    return createReport({
      checks: {
        approvalRequested: false,
        approvalResolved: false,
        editedEmailInputExecuted: false,
        pausedFirst: pausedHandle.status().phase === "paused",
        resumedCompleted: false,
        toolMetadataHistoryPreserved: pausedToolMetadataHistoryPreserved,
        toolMetadataObserved: pausedToolMetadataObserved,
        toolResultAfterResume: false,
      },
      config,
      error: readProjectionError(pausedProjection) ?? {
        message: "approval scenario did not pause for approval",
      },
      handle: pausedHandle,
      projection: pausedProjection,
      thread: withHead(thread, pausedProjection),
    });
  }

  const emailApproval = approval.toolCalls.find(
    (toolCall) => toolCall.name === "email"
  );

  if (emailApproval === undefined) {
    return createReport({
      checks: {
        approvalRequested: pausedProjection.canonical.some(
          (event) => event.type === "approval.requested"
        ),
        approvalResolved: false,
        editedEmailInputExecuted: false,
        pausedFirst: pausedHandle.status().phase === "paused",
        resumedCompleted: false,
        toolMetadataHistoryPreserved: pausedToolMetadataHistoryPreserved,
        toolMetadataObserved: pausedToolMetadataObserved,
        toolResultAfterResume: false,
      },
      config,
      error: {
        message: "approval scenario did not request email approval",
      },
      handle: pausedHandle,
      projection: pausedProjection,
      thread: withHead(thread, pausedProjection),
    });
  }

  const resumedHandle = host.approve(pausedHandle, {
    decisions: approval.toolCalls.map((toolCall) => {
      if (toolCall.name === "email") {
        return {
          callId: toolCall.callId,
          editedInput: {
            subject: "Edited status update",
            to: "ops@example.com",
          },
          message: "Playground approved with deterministic input.",
          type: "edit",
        };
      }

      return {
        callId: toolCall.callId,
        message: "Playground approved with deterministic input.",
        type: "approve",
      };
    }),
  });
  const resumedProjection = await projectContinuationCapture(resumedHandle);
  const projection = mergeProjections(pausedProjection, resumedProjection);
  const resumedMessages = await host.readBranchMessages(thread.branchId);

  return createReport({
    checks: {
      approvalRequested: projection.canonical.some(
        (event) => event.type === "approval.requested"
      ),
      approvalResolved: projection.canonical.some(
        (event) => event.type === "approval.resolved"
      ),
      editedEmailInputExecuted: resumedProjection.canonical.some(
        isEditedEmailToolStart
      ),
      pausedFirst: pausedHandle.status().phase === "paused",
      resumedCompleted: resumedHandle.status().phase === "completed",
      thoughtSignatureHistoryPreserved:
        config.providerMode === "ai-sdk-google"
          ? countDurableToolCallThoughtSignatures(resumedMessages) >= 1
          : true,
      thoughtSignatureObserved:
        config.providerMode === "ai-sdk-google"
          ? countToolCallThoughtSignatureEvents(projection) >= 1
          : true,
      toolMetadataHistoryPreserved: readApprovalToolMetadataHistory(
        config,
        resumedMessages,
        countDurableToolCallProviderCallIds(resumedMessages)
      ),
      toolMetadataObserved: readApprovalToolMetadataObserved(
        config,
        projection,
        resumedMessages
      ),
      toolResultAfterResume: resumedProjection.canonical.some(
        (event) =>
          event.type === "tool.result" && event.callId === emailApproval.callId
      ),
    },
    config,
    error: readProjectionError(projection),
    handle: resumedHandle,
    projection,
    thread: withHead(thread, projection),
  });
}

async function runBranchingScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const firstHandle = host.executeTurn({
    branchId: thread.branchId,
    signal: textSignal("Create branch source"),
    threadId: thread.threadId,
  });
  const firstProjection = await host.project(firstHandle);
  const sourceThread = withHead(thread, firstProjection);
  const branch = await host.branchFromHead({
    threadId: thread.threadId,
    turnNodeHash: sourceThread.headTurnNodeHash ?? thread.rootTurnNodeHash,
  });
  const branchedThread = {
    ...sourceThread,
    branchId: branch.branchId,
    headTurnNodeHash: branch.headTurnNodeHash,
  };
  const branchMessagesBeforeTurn = await host.readBranchMessages(
    branch.branchId
  );
  const branchHandle = host.executeTurn({
    branchId: branch.branchId,
    signal: textSignal("Run alternate branch"),
    threadId: thread.threadId,
  });
  const branchProjection = await host.project(branchHandle);
  const branchMessagesAfterTurn = await host.readBranchMessages(
    branch.branchId
  );
  const projection = mergeProjections(firstProjection, branchProjection);

  return createReport({
    checks: {
      branchCreated: branch.branchId !== thread.branchId,
      branchCompleted: branchHandle.status().phase === "completed",
      branchedFromSourceHead:
        branch.headTurnNodeHash === sourceThread.headTurnNodeHash,
      branchMessagesAdvanced:
        branchMessagesAfterTurn.length > branchMessagesBeforeTurn.length,
      branchMessagesVisible: branchMessagesBeforeTurn.length > 0,
      sourceCompleted: firstHandle.status().phase === "completed",
    },
    config,
    handle: branchHandle,
    projection,
    thread: withHead(branchedThread, projection),
  });
}

async function runSteeringScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const handle = host.executeTurn({
    branchId: thread.branchId,
    signal: textSignal("Run steering source"),
    threadId: thread.threadId,
  });
  const capture = startProjectionCapture(handle);
  await steerWhenRunning(host, handle, textSignal("Injected steering"));

  const projection = await capture;
  const messages = await host.readBranchMessages(thread.branchId);

  return createReport({
    checks: {
      completed: handle.status().phase === "completed",
      steeringEventObserved: projection.canonical.some(
        (event) => event.type === "steering.incorporated"
      ),
      steeringMessageDurable: readSteeringMessageDurable(messages),
      steeringResponseObserved: projection.canonical.some(
        (event) =>
          event.type === "text.done" && event.text === "Steering incorporated."
      ),
    },
    config,
    handle,
    projection,
    thread: withHead(thread, projection),
  });
}

async function runCancelScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const handle = host.executeTurn({
    branchId: thread.branchId,
    config: {
      loopPolicy: CONTINUE_ONCE_POLICY,
      name: "primary",
    },
    signal: textSignal("Run cancellation"),
    threadId: thread.threadId,
  });
  const capture = startProjectionCapture(handle);

  await waitFor(() => handle.status().iterationCount >= 2);
  host.cancel(handle);

  const projection = await capture;

  return createReport({
    checks: {
      cancelled: handle.status().phase === "failed",
      errorObserved: projection.canonical.some(
        (event) => event.type === "error"
      ),
      terminalFailed: projection.canonical.some(
        (event) => event.type === "turn.end" && event.status === "failed"
      ),
    },
    config,
    handle,
    projection,
    thread: withHead(thread, projection),
  });
}

async function runReloadScenario(
  config: PlaygroundConfig
): Promise<PlaygroundScenarioReport> {
  const host = createPlaygroundHost(config);
  const thread = await host.createThread();
  const handle = host.executeTurn({
    branchId: thread.branchId,
    signal: textSignal("Run reload source"),
    threadId: thread.threadId,
  });
  const projection = await host.project(handle);
  const sourceThread = withHead(thread, projection);
  const supportsReloadPersistence =
    config.backend === "postgres" ||
    config.backend === "sqlite" ||
    (config.kernelMode ?? "typescript-local") === "rust-grpc";

  if (!supportsReloadPersistence) {
    return createReport({
      checks: {
        completedBeforeReload: handle.status().phase === "completed",
        durableReloadAttempted: false,
        continuedAfterReload: false,
        durableMessagesVisibleAfterReload: false,
        headAdvancedAfterReload: false,
        rootPreservedAfterReload: false,
        threadVisibleAfterReload: false,
      },
      config,
      handle,
      projection,
      thread: sourceThread,
    });
  }

  const reloadedHost = createPlaygroundHost(config);
  const reloadedThread = await reloadedHost.runtime.getThread(thread.threadId);
  const reloadedMessages = await reloadedHost.readBranchMessages(
    thread.branchId
  );
  const continuationHandle = reloadedHost.executeTurn({
    branchId: thread.branchId,
    signal: textSignal("Run reload continuation"),
    threadId: thread.threadId,
  });
  const continuationProjection = await reloadedHost.project(continuationHandle);
  const projectionAfterReload = mergeProjections(
    projection,
    continuationProjection
  );
  const continuedThread = withHead(sourceThread, continuationProjection);

  return createReport({
    checks: {
      completedBeforeReload: handle.status().phase === "completed",
      durableReloadAttempted: true,
      continuedAfterReload: continuationHandle.status().phase === "completed",
      durableMessagesVisibleAfterReload: reloadedMessages.length >= 2,
      headAdvancedAfterReload:
        sourceThread.headTurnNodeHash !== continuedThread.headTurnNodeHash,
      rootPreservedAfterReload:
        reloadedThread?.rootTurnNodeHash === thread.rootTurnNodeHash,
      threadVisibleAfterReload: reloadedThread !== null,
    },
    config,
    handle: continuationHandle,
    projection: projectionAfterReload,
    thread: continuedThread,
  });
}

async function collectEvents(
  events: AsyncIterable<TuvrenStreamEvent>
): Promise<TuvrenStreamEvent[]> {
  const output: TuvrenStreamEvent[] = [];

  for await (const event of events) {
    output.push(event);
  }

  return output;
}
