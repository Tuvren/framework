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

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOrchestrationRuntime,
  type ExecutionHandle,
  type InputSignal,
  type LoopPolicy,
  type OrchestrationHandle,
  type TuvrenStreamEvent,
} from "@tuvren/runtime";
import { createPlaygroundHost } from "./playground-host.js";
import {
  createScenarioExecutionPlan,
  mergeProjections,
  projectContinuationCapture,
  readProjectionError,
  startProjectionCapture,
  withHead,
} from "./playground-scenarios-support.js";
import { textSignal } from "./playground-tools.js";
import type {
  PlaygroundConfig,
  PlaygroundHost,
  PlaygroundScenarioName,
  PlaygroundStreamProjection,
  PlaygroundThreadSummary,
} from "./playground-types.js";
import { createProofExtension } from "./proof-extension.js";

const COMMAND_SPLIT_PATTERN = /\s+/u;
const SCENARIO_NAMES = new Set<PlaygroundScenarioName>([
  "approval",
  "branching",
  "cancel",
  "extension",
  "metadata",
  "orchestration",
  "reload",
  "steering",
  "streaming",
  "structured",
  "tools",
]);

const CONTINUE_ONCE_POLICY: LoopPolicy = {
  evaluate(_response, _manifest, iterationCount) {
    return {
      continue: iterationCount < 2,
      executeTools: true,
      reason: "repl_continue_once",
    };
  },
};

export const REPL_HELP_TEXT = [
  ".help                         Show available commands",
  ".exit                         Exit the REPL host",
  ".status                       Show current shell state",
  ".backend <memory|sqlite> [path|auto]",
  ".thread new                   Create a new active thread",
  ".thread show                  Show the active thread",
  ".branch fork                  Fork the active branch from the current head",
  ".messages show                Show durable messages for the active branch",
  ".events show                  Show the last captured canonical events",
  ".turn start <scenario|text>   Start a turn on the active branch",
  ".turn await                   Await the active turn and capture projections",
  ".turn approve [approve|edit|reject]",
  ".turn steer <text>            Inject steering into the active turn",
  ".turn cancel                  Cancel the active turn",
  ".orch start                   Start a root orchestration turn",
  ".orch spawn <agent> <text>    Spawn a child orchestration handle",
  ".orch await                   Await current orchestration handles",
  ".orch events                  Show the last orchestration event types",
] as const;

interface ActiveTurnState {
  handle: ExecutionHandle;
  projectionPromise: Promise<PlaygroundStreamProjection>;
  thread: PlaygroundThreadSummary;
}

interface ActiveOrchestrationState {
  childHandle?: OrchestrationHandle;
  childResult?: unknown;
  eventsPromise: Promise<TuvrenStreamEvent[]>;
  handle: OrchestrationHandle;
  rootResult?: unknown;
  thread: PlaygroundThreadSummary;
}

export interface ReplShell {
  activeOrchestration?: ActiveOrchestrationState;
  activeTurn?: ActiveTurnState;
  config: PlaygroundConfig;
  host: PlaygroundHost;
  lastOrchestrationEvents?: TuvrenStreamEvent[];
  lastProjection?: PlaygroundStreamProjection;
  thread?: PlaygroundThreadSummary;
}

export interface ReplCommandResult {
  exit?: boolean;
  output?: string;
}

export function createReplShell(config: PlaygroundConfig): ReplShell {
  return {
    config,
    host: createPlaygroundHost(config),
  };
}

export async function runReplCommand(
  shell: ReplShell,
  input: string
): Promise<ReplCommandResult> {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return {};
  }

  const [command, ...args] = trimmed.split(COMMAND_SPLIT_PATTERN);

  switch (command) {
    case ".help":
      return { output: REPL_HELP_TEXT.join("\n") };
    case ".exit":
      return { exit: true };
    case ".status":
      return { output: formatJson(readShellStatus(shell)) };
    case ".backend":
      return await selectBackend(shell, args);
    case ".thread":
      return await handleThreadCommand(shell, args);
    case ".branch":
      return await handleBranchCommand(shell, args);
    case ".messages":
      return await showMessages(shell, args);
    case ".events":
      return await showEvents(shell, args);
    case ".turn":
      return await handleTurnCommand(shell, args);
    case ".orch":
      return await handleOrchestrationCommand(shell, args);
    default:
      return {
        output: `Unknown command "${command}". Use .help to inspect the command tree.`,
      };
  }
}

function readShellStatus(shell: ReplShell): Record<string, unknown> {
  return {
    activeBranchId: shell.thread?.branchId,
    activeOrchestrationPhase: shell.activeOrchestration?.handle.status().phase,
    activeThreadId: shell.thread?.threadId,
    activeTurnPhase: shell.activeTurn?.handle.status().phase,
    backend: shell.config.backend,
    kernelMode: shell.config.kernelMode ?? "typescript-local",
    providerMode: shell.config.providerMode,
  };
}

function selectBackend(
  shell: ReplShell,
  args: readonly string[]
): ReplCommandResult {
  const backend = args[0];

  if (backend !== "memory" && backend !== "sqlite") {
    return {
      output: 'Expected ".backend <memory|sqlite> [path|auto]".',
    };
  }

  const nextConfig: PlaygroundConfig =
    backend === "memory"
      ? {
          ...shell.config,
          backend,
          sqlitePath: undefined,
        }
      : {
          ...shell.config,
          backend,
          sqlitePath:
            args[1] === "auto"
              ? join(tmpdir(), `tuvren-repl-${randomUUID()}.sqlite`)
              : args[1],
        };

  if (backend === "sqlite" && nextConfig.sqlitePath === undefined) {
    return {
      output: 'SQLite mode requires a path or the literal value "auto".',
    };
  }

  shell.config = nextConfig;
  shell.host = createPlaygroundHost(nextConfig);
  shell.activeOrchestration = undefined;
  shell.activeTurn = undefined;
  shell.lastOrchestrationEvents = undefined;
  shell.lastProjection = undefined;
  shell.thread = undefined;

  return {
    output: formatJson({
      backend: shell.config.backend,
      sqlitePath: shell.config.sqlitePath ?? null,
    }),
  };
}

async function handleThreadCommand(
  shell: ReplShell,
  args: readonly string[]
): Promise<ReplCommandResult> {
  const subcommand = args[0];

  switch (subcommand) {
    case "new":
      shell.thread = await shell.host.createThread();
      shell.activeOrchestration = undefined;
      shell.activeTurn = undefined;
      shell.lastProjection = undefined;
      shell.lastOrchestrationEvents = undefined;
      return { output: formatJson(shell.thread) };
    case "show":
      return { output: formatJson(shell.thread ?? null) };
    default:
      return { output: 'Expected ".thread <new|show>".' };
  }
}

async function handleBranchCommand(
  shell: ReplShell,
  args: readonly string[]
): Promise<ReplCommandResult> {
  if (args[0] !== "fork") {
    return { output: 'Expected ".branch fork".' };
  }

  const thread = await ensureThread(shell);
  const turnNodeHash = thread.headTurnNodeHash ?? thread.rootTurnNodeHash;
  const branch = await shell.host.branchFromHead({
    threadId: thread.threadId,
    turnNodeHash,
  });

  shell.thread = {
    ...thread,
    branchId: branch.branchId,
    headTurnNodeHash: branch.headTurnNodeHash,
  };

  return { output: formatJson(shell.thread) };
}

async function showMessages(
  shell: ReplShell,
  args: readonly string[]
): Promise<ReplCommandResult> {
  if (args[0] !== "show") {
    return { output: 'Expected ".messages show".' };
  }

  const thread = await ensureThread(shell);
  const messages = await shell.host.readBranchMessages(thread.branchId);
  return { output: formatJson(messages) };
}

function showEvents(
  shell: ReplShell,
  args: readonly string[]
): ReplCommandResult {
  if (args[0] !== "show") {
    return { output: 'Expected ".events show".' };
  }

  return { output: formatJson(shell.lastProjection?.canonical ?? []) };
}

async function handleTurnCommand(
  shell: ReplShell,
  args: readonly string[]
): Promise<ReplCommandResult> {
  const subcommand = args[0];

  switch (subcommand) {
    case "start":
      return await startTurn(shell, args.slice(1));
    case "await":
      return await awaitTurn(shell);
    case "approve":
      return await approveTurn(shell, args[1] ?? "approve");
    case "steer":
      return steerTurn(shell, args.slice(1).join(" "));
    case "cancel":
      return cancelTurn(shell);
    default:
      return {
        output: 'Expected ".turn <start|await|approve|steer|cancel> ...".',
      };
  }
}

async function handleOrchestrationCommand(
  shell: ReplShell,
  args: readonly string[]
): Promise<ReplCommandResult> {
  const subcommand = args[0];

  switch (subcommand) {
    case "start":
      return await startOrchestration(shell);
    case "spawn":
      return await spawnOrchestrationChild(shell, args.slice(1));
    case "await":
      return await awaitOrchestration(shell);
    case "events":
      return {
        output: formatJson(
          shell.lastOrchestrationEvents?.map((event) => event.type) ?? []
        ),
      };
    default:
      return {
        output: 'Expected ".orch <start|spawn|await|events>".',
      };
  }
}

async function startTurn(
  shell: ReplShell,
  args: readonly string[]
): Promise<ReplCommandResult> {
  const input = args.join(" ").trim();

  if (input.length === 0) {
    return {
      output:
        'Expected ".turn start <scenario|text>". Example: ".turn start approval".',
    };
  }

  const thread = await ensureThread(shell);
  const execution = createTurnExecutionRequest(shell.config, input);
  const handle = shell.host.executeTurn({
    branchId: thread.branchId,
    config: execution.config,
    signal: execution.signal,
    threadId: thread.threadId,
  });

  shell.activeTurn = {
    handle,
    projectionPromise: startProjectionCapture(handle),
    thread,
  };

  return {
    output: formatJson({
      branchId: thread.branchId,
      phase: handle.status().phase,
      threadId: thread.threadId,
    }),
  };
}

async function awaitTurn(shell: ReplShell): Promise<ReplCommandResult> {
  const activeTurn = shell.activeTurn;

  if (activeTurn === undefined) {
    return { output: "No active turn is currently running." };
  }

  const projection = await activeTurn.projectionPromise;
  shell.lastProjection = projection;
  shell.thread = withHead(activeTurn.thread, projection);

  return {
    output: formatJson({
      checks: {
        error: readProjectionError(projection) ?? null,
        phase: activeTurn.handle.status().phase,
      },
      eventTypes: projection.canonical.map((event) => event.type),
      thread: shell.thread,
    }),
  };
}

async function approveTurn(
  shell: ReplShell,
  mode: string
): Promise<ReplCommandResult> {
  const activeTurn = shell.activeTurn;

  if (activeTurn === undefined) {
    return { output: "No active turn is available for approval." };
  }

  const approval = activeTurn.handle.status().approval;

  if (approval === undefined) {
    return { output: "The active turn is not paused for approval." };
  }

  const baseProjection = await activeTurn.projectionPromise;
  const response = createApprovalResponse(approval, mode);
  const resumedHandle = shell.host.approve(activeTurn.handle, response);
  const continuationPromise = projectContinuationCapture(resumedHandle).then(
    (continuation) => mergeProjections(baseProjection, continuation)
  );

  shell.activeTurn = {
    handle: resumedHandle,
    projectionPromise: continuationPromise,
    thread: activeTurn.thread,
  };

  return {
    output: formatJson({
      decisions: response.decisions.map((decision) => decision.type),
      phase: resumedHandle.status().phase,
    }),
  };
}

function steerTurn(shell: ReplShell, text: string): ReplCommandResult {
  if (text.trim().length === 0) {
    return { output: 'Expected ".turn steer <text>".' };
  }

  const activeTurn = shell.activeTurn;

  if (activeTurn === undefined) {
    return { output: "No active turn is currently running." };
  }

  shell.host.steer(activeTurn.handle, textSignal(text));
  return { output: "Injected steering into the active turn." };
}

function cancelTurn(shell: ReplShell): ReplCommandResult {
  const activeTurn = shell.activeTurn;

  if (activeTurn === undefined) {
    return { output: "No active turn is currently running." };
  }

  shell.host.cancel(activeTurn.handle);
  return { output: "Cancellation requested for the active turn." };
}

async function startOrchestration(
  shell: ReplShell
): Promise<ReplCommandResult> {
  const thread = await ensureThread(shell);
  const orchestration = createOrchestrationRuntime({
    agents: {
      primary: {
        model: shell.host.provider,
        name: "primary",
      },
      worker: {
        model: shell.host.provider,
        name: "worker",
      },
    },
    framework: shell.host.runtime,
  });
  const handle = orchestration.executeTurn({
    agent: "primary",
    branchId: thread.branchId,
    signal: textSignal("Run orchestration root"),
    threadId: thread.threadId,
  });

  shell.activeOrchestration = {
    eventsPromise: collect(handle.allEvents()),
    handle,
    thread,
  };

  return {
    output: formatJson({
      branchId: thread.branchId,
      phase: handle.status().phase,
      threadId: thread.threadId,
    }),
  };
}

function spawnOrchestrationChild(
  shell: ReplShell,
  args: readonly string[]
): ReplCommandResult {
  const active = shell.activeOrchestration;

  if (active === undefined) {
    return { output: "No active orchestration root exists." };
  }

  const agent = args[0] ?? "worker";
  const signalText =
    args.slice(1).join(" ").trim() || "Run orchestration child";
  const childHandle = active.handle.spawn({
    agent,
    signal: textSignal(signalText),
  });

  active.childHandle = childHandle;

  return {
    output: formatJson({
      agent,
      phase: childHandle.status().phase,
    }),
  };
}

async function awaitOrchestration(
  shell: ReplShell
): Promise<ReplCommandResult> {
  const active = shell.activeOrchestration;

  if (active === undefined) {
    return { output: "No active orchestration root exists." };
  }

  if (active.childHandle !== undefined) {
    active.childResult = await active.childHandle.awaitResult();
  }

  active.rootResult = await active.handle.awaitResult();
  shell.lastOrchestrationEvents = await active.eventsPromise;
  const projection = {
    agui: [],
    canonical: shell.lastOrchestrationEvents,
    sse: [],
  } satisfies PlaygroundStreamProjection;
  shell.thread = withHead(active.thread, projection);
  active.thread = shell.thread;

  return {
    output: formatJson({
      childResult: active.childResult ?? null,
      eventTypes: shell.lastOrchestrationEvents.map((event) => event.type),
      rootResult: active.rootResult,
    }),
  };
}

async function ensureThread(
  shell: ReplShell
): Promise<PlaygroundThreadSummary> {
  if (shell.thread === undefined) {
    shell.thread = await shell.host.createThread();
  }

  return shell.thread;
}

function createTurnExecutionRequest(
  config: PlaygroundConfig,
  input: string
): {
  config?: Parameters<PlaygroundHost["executeTurn"]>[0]["config"];
  signal: InputSignal;
} {
  if (!isScenarioName(input)) {
    return {
      signal: textSignal(input),
    };
  }

  const scenarioConfig = {
    ...config,
    scenario: input,
  } satisfies PlaygroundConfig;
  const executionPlan = createScenarioExecutionPlan(scenarioConfig);

  return {
    config: {
      ...executionPlan.config,
      ...(input === "approval"
        ? {
            maxParallelToolCalls: 2,
          }
        : {}),
      ...(input === "cancel"
        ? {
            loopPolicy: CONTINUE_ONCE_POLICY,
          }
        : {}),
      ...(input === "extension"
        ? {
            extensions: [createProofExtension()],
          }
        : {}),
      model: executionPlan.model,
      name: "primary",
      responseFormat:
        input === "structured"
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
  };
}

function createApprovalResponse(
  approval: NonNullable<ReturnType<ExecutionHandle["status"]>["approval"]>,
  mode: string
) {
  return {
    decisions: approval.toolCalls.map((toolCall) => {
      switch (mode) {
        case "edit":
          return toolCall.name === "email"
            ? {
                callId: toolCall.callId,
                editedInput: {
                  subject: "Edited status update",
                  to: "ops@example.com",
                },
                message: "Edited through the REPL host.",
                type: "edit" as const,
              }
            : {
                callId: toolCall.callId,
                message: "Approved through the REPL host.",
                type: "approve" as const,
              };
        case "reject":
          return {
            callId: toolCall.callId,
            message: "Rejected through the REPL host.",
            type: "reject" as const,
          };
        default:
          return {
            callId: toolCall.callId,
            message: "Approved through the REPL host.",
            type: "approve" as const,
          };
      }
    }),
  };
}

function isScenarioName(value: string): value is PlaygroundScenarioName {
  return SCENARIO_NAMES.has(value as PlaygroundScenarioName);
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];

  for await (const event of events) {
    output.push(event);
  }

  return output;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
