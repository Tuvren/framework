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

import { TuvrenRuntimeError } from "@tuvren/core-types";
import type { TuvrenStreamEvent } from "@tuvren/event-stream";
import type {
  ExecutionHandle,
  InputSignal,
  LoopPolicy,
} from "@tuvren/runtime-api";
import { toAgUiEvents } from "@tuvren/stream-agui";
import { teeTuvrenStreamEvents } from "@tuvren/stream-core";
import { toSseFrames } from "@tuvren/stream-sse";
import { createPlaygroundHost } from "./playground-host.js";
import { createPlaygroundTools, textSignal } from "./playground-tools.js";
import type {
  PlaygroundConfig,
  PlaygroundHost,
  PlaygroundScenarioReport,
  PlaygroundStreamProjection,
  PlaygroundThreadSummary,
} from "./playground-types.js";

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
    case "metadata":
    case "streaming":
    case "structured":
    case "tools":
      return await runSingleTurnScenario(config);
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
  const handle = host.executeTurn({
    branchId: thread.branchId,
    config: {
      name: "primary",
      tools: createPlaygroundTools(),
    },
    signal: textSignal(`Run ${config.scenario}`),
    threadId: thread.threadId,
  });
  const projection = await host.project(handle);
  const messages = await host.readBranchMessages(thread.branchId);

  return createReport({
    checks: {
      aguiObserved: projection.agui.length > 0,
      canonicalObserved: projection.canonical.length > 0,
      completed: handle.status().phase === "completed",
      metadataObserved:
        config.scenario !== "metadata" ||
        messages.some(hasProviderMetadataEvidence),
      sseObserved: projection.sse.length > 0,
      structuredObserved:
        config.scenario !== "structured" ||
        projection.canonical.some((event) => event.type === "structured.done"),
      toolObserved:
        config.scenario !== "tools" ||
        projection.canonical.some((event) => event.type === "tool.result"),
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
  const pausedHandle = host.executeTurn({
    branchId: thread.branchId,
    config: {
      maxParallelToolCalls: 2,
      name: "primary",
      tools: createPlaygroundTools(),
    },
    signal: textSignal("Run approval"),
    threadId: thread.threadId,
  });
  const pausedProjection = await host.project(pausedHandle);
  const approval = pausedHandle.status().approval;

  if (approval === undefined) {
    throw new Error("approval scenario did not pause for approval");
  }

  const emailApproval = approval.toolCalls.find(
    (toolCall) => toolCall.name === "email"
  );

  if (emailApproval === undefined) {
    throw new Error("approval scenario did not request email approval");
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

  return createReport({
    checks: {
      approvalRequested: projection.canonical.some(
        (event) => event.type === "approval.requested"
      ),
      approvalResolved: projection.canonical.some(
        (event) => event.type === "approval.resolved"
      ),
      pausedFirst: pausedHandle.status().phase === "paused",
      resumedCompleted: resumedHandle.status().phase === "completed",
      toolResultAfterResume: resumedProjection.canonical.some(
        (event) =>
          event.type === "tool.result" && event.callId === emailApproval.callId
      ),
    },
    config,
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
    thread: withHead(thread, projection),
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
      steeringMessageDurable: messages.some(hasInjectedSteeringMessage),
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

  if (config.backend !== "sqlite") {
    // Reload evidence is meaningful only across a fresh durable host; memory
    // mode reports explicit failed checks so CLI callers do not mistake it for
    // a partial reload validation.
    return createReport({
      checks: {
        completedBeforeReload: handle.status().phase === "completed",
        continuedAfterReload: false,
        durableMessagesVisibleAfterReload: false,
        headAdvancedAfterReload: false,
        rootPreservedAfterReload: false,
        sqliteReloadAttempted: false,
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
      continuedAfterReload: continuationHandle.status().phase === "completed",
      durableMessagesVisibleAfterReload: reloadedMessages.length >= 2,
      headAdvancedAfterReload:
        sourceThread.headTurnNodeHash !== continuedThread.headTurnNodeHash,
      rootPreservedAfterReload:
        reloadedThread?.rootTurnNodeHash === thread.rootTurnNodeHash,
      sqliteReloadAttempted: config.backend === "sqlite",
      threadVisibleAfterReload: reloadedThread !== null,
    },
    config,
    handle: continuationHandle,
    projection: projectionAfterReload,
    thread: continuedThread,
  });
}

function createReport(input: {
  checks: Record<string, boolean | number | string>;
  config: PlaygroundConfig;
  handle: ExecutionHandle;
  projection: PlaygroundStreamProjection;
  thread: PlaygroundThreadSummary;
}): PlaygroundScenarioReport {
  return {
    backend: input.config.backend,
    checks: input.checks,
    events: {
      aguiTypes: input.projection.agui.map((event) => String(event.type)),
      canonicalTypes: input.projection.canonical.map((event) => event.type),
      sseEvents: input.projection.sse.map((event) => event.event ?? "message"),
    },
    providerMode: input.config.providerMode,
    scenario: input.config.scenario,
    status: input.handle.status(),
    thread: input.thread,
  };
}

function startProjectionCapture(
  handle: ExecutionHandle
): Promise<PlaygroundStreamProjection> {
  const [canonicalBranch, sseBranch, aguiBranch] = teeTuvrenStreamEvents(
    handle.events(),
    3
  );

  return Promise.all([
    collect(canonicalBranch),
    collect(toSseFrames(sseBranch)),
    collect(toAgUiEvents(aguiBranch)),
  ]).then(([canonical, sse, agui]) => ({
    agui,
    canonical,
    sse,
  }));
}

function projectContinuationCapture(
  handle: ExecutionHandle
): Promise<PlaygroundStreamProjection> {
  const [canonicalBranch, sseBranch] = teeTuvrenStreamEvents(
    handle.events(),
    2
  );

  return Promise.all([
    collect(canonicalBranch),
    collect(toSseFrames(sseBranch)),
  ]).then(([canonical, sse]) => ({
    agui: [],
    canonical,
    sse,
  }));
}

function mergeProjections(
  left: PlaygroundStreamProjection,
  right: PlaygroundStreamProjection
): PlaygroundStreamProjection {
  return {
    agui: [...left.agui, ...right.agui],
    canonical: [...left.canonical, ...right.canonical],
    sse: [...left.sse, ...right.sse],
  };
}

function withHead(
  thread: PlaygroundThreadSummary,
  projection: PlaygroundStreamProjection
): PlaygroundThreadSummary {
  const checkpoint = [...projection.canonical]
    .reverse()
    .find(
      (
        event
      ): event is Extract<TuvrenStreamEvent, { type: "state.checkpoint" }> =>
        event.type === "state.checkpoint"
    );

  return {
    ...thread,
    headTurnNodeHash: checkpoint?.turnNodeHash ?? thread.rootTurnNodeHash,
  };
}

function hasProviderMetadataEvidence(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }

  const providerMetadata = value.providerMetadata;

  if (
    isPlainRecord(providerMetadata) &&
    (isPlainRecord(providerMetadata.playground) ||
      isPlainRecord(providerMetadata.fixture) ||
      isPlainRecord(providerMetadata.aiSdkBridge))
  ) {
    return true;
  }

  return Object.values(value).some((entry) => {
    if (Array.isArray(entry)) {
      return entry.some(hasProviderMetadataEvidence);
    }

    return hasProviderMetadataEvidence(entry);
  });
}

function hasInjectedSteeringMessage(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }

  if (value.role !== "user" || !Array.isArray(value.parts)) {
    return false;
  }

  return value.parts.some(
    (part) =>
      isPlainRecord(part) &&
      part.type === "text" &&
      part.text === "Injected steering"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];

  for await (const event of events) {
    output.push(event);
  }

  return output;
}

async function waitFor(
  condition: () => boolean,
  timeoutMilliseconds = 1000
): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMilliseconds) {
      throw new Error("timed out waiting for playground condition");
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

async function steerWhenRunning(
  host: PlaygroundHost,
  handle: ExecutionHandle,
  signal: InputSignal,
  timeoutMilliseconds = 1000
): Promise<void> {
  const startedAt = Date.now();

  while (true) {
    try {
      host.steer(handle, signal);
      return;
    } catch (error: unknown) {
      if (
        !(
          error instanceof TuvrenRuntimeError &&
          error.code === "invalid_steering_state" &&
          handle.status().phase === "running"
        )
      ) {
        throw error;
      }
    }

    if (Date.now() - startedAt >= timeoutMilliseconds) {
      throw new Error("timed out waiting for playground steering acceptance");
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}
