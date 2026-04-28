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

import type { TuvrenStreamEvent } from "@tuvren/event-stream";
import type { ExecutionHandle, LoopPolicy } from "@tuvren/runtime-api";
import { toAgUiEvents } from "@tuvren/stream-agui";
import { teeTuvrenStreamEvents } from "@tuvren/stream-core";
import { toSseFrames } from "@tuvren/stream-sse";
import { createPlaygroundHost } from "./playground-host.js";
import { createPlaygroundTools, textSignal } from "./playground-tools.js";
import type {
  PlaygroundConfig,
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

  return createReport({
    checks: {
      aguiObserved: projection.agui.length > 0,
      canonicalObserved: projection.canonical.length > 0,
      completed: handle.status().phase === "completed",
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
        (event) => event.type === "tool.result" && event.callId === "call-email"
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
  const branch = await host.branchFromHead({
    threadId: thread.threadId,
    turnNodeHash: thread.rootTurnNodeHash,
  });
  const branchHandle = host.executeTurn({
    branchId: branch.branchId,
    signal: textSignal("Run alternate branch"),
    threadId: thread.threadId,
  });
  const branchProjection = await host.project(branchHandle);
  const projection = mergeProjections(firstProjection, branchProjection);

  return createReport({
    checks: {
      branchCreated: branch.branchId !== thread.branchId,
      branchCompleted: branchHandle.status().phase === "completed",
      sourceCompleted: firstHandle.status().phase === "completed",
    },
    config,
    handle: branchHandle,
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
  const reloadedHost = createPlaygroundHost(config);
  const reloadedThread = await reloadedHost.runtime.getThread(thread.threadId);

  return createReport({
    checks: {
      completedBeforeReload: handle.status().phase === "completed",
      sqliteReloadAttempted: config.backend === "sqlite",
      threadVisibleAfterReload: reloadedThread !== null,
    },
    config,
    handle,
    projection,
    thread: withHead(thread, projection),
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
