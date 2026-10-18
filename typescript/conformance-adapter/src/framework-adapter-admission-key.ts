import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryBackend } from "@tuvren/backend-memory";
import { createSqliteBackend } from "@tuvren/backend-sqlite";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { InputSignal } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/core/provider";
import type { RuntimeRunner } from "@tuvren/core/runner";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import type {
  RecoveryState,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createReActRunner, REACT_RUNNER_ID } from "@tuvren/runner-react";
import {
  createRunnerRegistry,
  createTuvrenRuntime,
  DEFAULT_AGENT_SCHEMA,
} from "@tuvren/runtime";

import type { AdapterProjection } from "./framework-adapter-runtime.ts";

const CHILD_MARKER = "__tuvren_admission_key_child__";
const CHILD_WAIT_MS = 30_000;
const PARENT_PHASE_WAIT_MS = 15_000;
const PARENT_EXIT_WAIT_MS = 5000;
const WRITER_NOW_MS = 1000;
const RECOVERY_NOW_MS = 10_000;
const RUNNER_ID = "admission-key-conformance";
const TEMPORARY_PREFIX = join(tmpdir(), "tuvren-admission-key-");
type CrashPoint = "committed_before_event" | "queued" | "staged";
interface AdmissionKeyScenarioDependencies {
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
interface CrashScenario {
  crashPoint: CrashPoint;
  initialKey: string;
  steeringKeys: [string, string];
  text: string;
}
interface WriterChildConfig extends CrashScenario {
  databasePath: string;
}
interface RecoveryChildConfig {
  branchId: string;
  databasePath: string;
  text: string;
  threadId: string;
}
interface KeyedTextUserMessage {
  admissionKey: string;
  parts: [{ text: string; type: "text" }];
  role: "user";
}
interface PhaseReadyMessage {
  branchId: string;
  events: TuvrenStreamEvent[];
  kind: "phase-ready";
  suppliedSignals: InputSignal[];
  threadId: string;
}
interface RecoveryMessage {
  kind: "recovery-result";
  observation: Record<string, unknown>;
}
type NodeChild = Bun.Subprocess<"ignore", "pipe", "ignore">;
interface SpawnedNodeChild {
  process: NodeChild;
}
export function createFrameworkAdapterAdmissionKeyScenarios(
  dependencies: AdmissionKeyScenarioDependencies
) {
  return {
    runCrashRecovery: async (input: unknown) =>
      await runCrashRecoveryScenario(dependencies, input),
    runInitialInputRecovery: async (input: unknown) =>
      await runInitialInputRecoveryScenario(dependencies, input),
    runKeylessIdentity: async (input: unknown) =>
      await runKeylessIdentityScenario(dependencies, input),
    runProviderExclusion: async (input: unknown) =>
      await runProviderExclusionScenario(dependencies, input),
  };
}
async function runCrashRecoveryScenario(
  dependencies: AdmissionKeyScenarioDependencies,
  input: unknown
): Promise<AdapterProjection> {
  const scenario = readCrashScenario(
    dependencies,
    dependencies.readOperationScenario(
      input,
      "runtime.admission-key.crash-recovery"
    )
  );
  const temporaryDirectory = await mkdtemp(TEMPORARY_PREFIX);
  const databasePath = join(temporaryDirectory, "runtime.sqlite");
  let writer: SpawnedNodeChild | undefined;
  let recovery: SpawnedNodeChild | undefined;
  try {
    const childPath = await buildNodeChild(temporaryDirectory);
    await linkNodeChildAssets(temporaryDirectory);
    writer = spawnNodeChild(childPath, "write", [
      databasePath,
      scenario.crashPoint,
      scenario.text,
      scenario.initialKey,
      ...scenario.steeringKeys,
    ]);
    const phaseMessage = readPhaseReadyMessage(
      await readChildMessage(writer.process, PARENT_PHASE_WAIT_MS)
    );
    writer.process.kill("SIGKILL");
    const writerExitCode = await awaitChildExit(writer.process);
    if (writer.process.signalCode !== "SIGKILL") {
      throw new Error(
        `admission-key writer was not killed by SIGKILL: code=${writerExitCode.toString()}`
      );
    }
    recovery = spawnNodeChild(childPath, "recover", [
      databasePath,
      phaseMessage.branchId,
      phaseMessage.threadId,
      scenario.text,
    ]);
    const recoveryMessage = readRecoveryMessage(
      await readChildMessage(recovery.process, PARENT_PHASE_WAIT_MS)
    );
    const recoveryExitCode = await awaitChildExit(recovery.process);
    if (recoveryExitCode !== 0) {
      throw new Error(
        `admission-key recovery child exited ${recoveryExitCode.toString()}`
      );
    }
    return {
      events: phaseMessage.events,
      result: {
        admissionKeyCrash: {
          crashPoint: scenario.crashPoint,
          recovery: recoveryMessage.observation,
          suppliedSignals: phaseMessage.suppliedSignals,
          writerProcess: {
            exitCode: writerExitCode,
            signalCode: writer.process.signalCode,
          },
        },
      },
    };
  } finally {
    try {
      if (writer !== undefined) {
        await killAndReap(writer.process);
      }
    } finally {
      try {
        if (recovery !== undefined) {
          await killAndReap(recovery.process);
        }
      } finally {
        assertOwnedTemporaryDirectory(temporaryDirectory);
        await rm(temporaryDirectory, { force: true, recursive: true });
      }
    }
  }
}
async function runProviderExclusionScenario(
  dependencies: AdmissionKeyScenarioDependencies,
  input: unknown
): Promise<AdapterProjection> {
  const scenario = dependencies.readOperationScenario(
    input,
    "runtime.admission-key.provider-exclusion"
  );
  const initialText = dependencies.readStringProperty(
    scenario,
    "initialText",
    "providerExclusion.initialText"
  );
  const initialKey = dependencies.readStringProperty(
    scenario,
    "initialKey",
    "providerExclusion.initialKey"
  );
  const steeringText = dependencies.readStringProperty(
    scenario,
    "steeringText",
    "providerExclusion.steeringText"
  );
  const steeringKey = dependencies.readStringProperty(
    scenario,
    "steeringKey",
    "providerExclusion.steeringKey"
  );
  const capturedPrompts: TuvrenMessage[][] = [];
  const firstRequestReceived = Promise.withResolvers<void>();
  const releaseFirstRequest = Promise.withResolvers<void>();
  let requestCount = 0;
  const provider: TuvrenProvider = {
    async generate(prompt: TuvrenPrompt): Promise<TuvrenModelResponse> {
      capturedPrompts.push(structuredClone(prompt.messages));
      requestCount += 1;
      if (requestCount === 1) {
        firstRequestReceived.resolve();
        await withDeadline(
          releaseFirstRequest.promise,
          "provider first-request release",
          CHILD_WAIT_MS
        );
      }
      return {
        finishReason: "stop",
        parts: [
          {
            text: requestCount === 1 ? "Continue." : "Completed.",
            type: "text",
          },
        ],
      };
    },
    id: "admission-key-recording-provider",
    async *stream() {
      await Promise.resolve();
      yield* [];
    },
  };
  const runtime = createTuvrenRuntime({
    defaultRunnerId: REACT_RUNNER_ID,
    kernel: createRuntimeKernel({ backend: createMemoryBackend() }),
    runnerRegistry: createRunnerRegistry([
      createReActRunner({ providerCallMode: "generate" }),
    ]),
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      loopPolicy: {
        evaluate(_response, _manifest, iterationCount) {
          return {
            continue: iterationCount === 1,
            executeTools: false,
            reason: "done",
          };
        },
      },
      model: provider,
      name: "primary",
    },
    signal: keyedSignal(initialText, initialKey),
    threadId: thread.threadId,
  });
  const eventsPromise = collectEvents(handle.events());
  await withDeadline(
    firstRequestReceived.promise,
    "provider first request",
    CHILD_WAIT_MS
  );
  handle.steer(keyedSignal(steeringText, steeringKey));
  releaseFirstRequest.resolve();
  const events = await withDeadline(
    eventsPromise,
    "provider exclusion execution",
    CHILD_WAIT_MS
  );
  const { messages } = await runtime.readBranchMessages({
    branchId: thread.branchId,
  });
  return {
    events,
    result: {
      providerExclusion: {
        capturedPrompts,
        durableMessages: messages,
      },
    },
  };
}
async function runInitialInputRecoveryScenario(
  dependencies: AdmissionKeyScenarioDependencies,
  input: unknown
): Promise<AdapterProjection> {
  const scenario = dependencies.readOperationScenario(
    input,
    "runtime.admission-key.initial-input-recovery"
  );
  const recoveryCase = dependencies.readStringProperty(
    scenario,
    "recoveryCase",
    "initialInputRecovery.recoveryCase"
  );
  const text = dependencies.readStringProperty(
    scenario,
    "text",
    "initialInputRecovery.text"
  );
  const initialKey = dependencies.readStringProperty(
    scenario,
    "initialKey",
    "initialInputRecovery.initialKey"
  );
  const steeringKey = dependencies.readStringProperty(
    scenario,
    "steeringKey",
    "initialInputRecovery.steeringKey"
  );
  const retryKey = dependencies.readStringProperty(
    scenario,
    "retryKey",
    "initialInputRecovery.retryKey"
  );
  let nowMs = 1;
  const backend = createMemoryBackend({ now: () => nowMs });
  const baseKernel = createRuntimeKernel({ backend, now: () => nowMs });
  const setupRuntime = createTuvrenRuntime({
    defaultRunnerId: RUNNER_ID,
    kernel: baseKernel,
  });
  const thread = await setupRuntime.createThread({});
  const turnId = `turn-admission-recovery-${recoveryCase}`;
  const turn = await baseKernel.turn.create(
    turnId,
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );
  const inputHead = await checkpointUserMessage(baseKernel, {
    branchId: thread.branchId,
    message: keyedUserMessage(text, initialKey),
    runId: `run-admission-input-${recoveryCase}`,
    startTurnNodeHash: thread.rootTurnNodeHash,
    stepId: "incorporate_input",
    turnId: turn.turnId,
  });
  const steeringHead = await checkpointUserMessage(baseKernel, {
    branchId: thread.branchId,
    message: keyedUserMessage(text, steeringKey),
    runId: `run-admission-steering-${recoveryCase}`,
    startTurnNodeHash: inputHead,
    stepId: "incorporate_steering",
    turnId: turn.turnId,
  });
  await baseKernel.runLiveness.createLeasedRun({
    branchId: thread.branchId,
    executionOwnerId: "crashed-owner",
    leaseExpiresAtMs: 10,
    runId: `run-admission-stale-${recoveryCase}`,
    schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
    startTurnNodeHash: steeringHead,
    steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
    turnId: turn.turnId,
  });
  await baseKernel.run.beginStep(
    `run-admission-stale-${recoveryCase}`,
    "iterate"
  );
  nowMs = 11;
  const expiredRunsBefore = await baseKernel.runLiveness.listExpired(nowMs);
  const preemptions: RecoveryState[] = [];
  const kernel = observePreemptions(baseKernel, preemptions);
  let idCounter = 0;
  const runner: RuntimeRunner = {
    execute: () =>
      Promise.resolve({
        messages: [],
        resolution: { reason: "done", type: "end_turn" },
      }),
    id: RUNNER_ID,
  };
  const runtime = createTuvrenRuntime({
    createId: () => `recovery-${recoveryCase}-${(idCounter++).toString()}`,
    defaultRunnerId: RUNNER_ID,
    kernel,
    now: () => nowMs,
    runLiveness: {
      executionOwnerId: `recovery-owner-${recoveryCase}`,
      leaseDurationMs: 50,
    },
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary" },
    signal: keyedSignal(text, retryKey),
    threadId: thread.threadId,
  });
  const recoveryEvents = await withDeadline(
    collectEvents(handle.events()),
    "initial-input recovery execution",
    CHILD_WAIT_MS
  );
  const { messages } = await runtime.readBranchMessages({
    branchId: thread.branchId,
  });
  return {
    events: recoveryEvents,
    result: {
      initialInputRecovery: {
        branchMessages: messages,
        expiredRunsBefore,
        preemptions,
        recoveryEvents,
      },
    },
  };
}
async function runKeylessIdentityScenario(
  dependencies: AdmissionKeyScenarioDependencies,
  input: unknown
): Promise<AdapterProjection> {
  const scenario = dependencies.readOperationScenario(
    input,
    "runtime.admission-key.keyless-identity"
  );
  const text = dependencies.readStringProperty(
    scenario,
    "text",
    "keylessIdentity.text"
  );
  const runtime = createTuvrenRuntime({
    defaultRunnerId: RUNNER_ID,
    kernel: createRuntimeKernel({ backend: createMemoryBackend() }),
    runnerRegistry: createRunnerRegistry([
      {
        execute: () =>
          Promise.resolve({
            messages: [],
            resolution: { reason: "done", type: "end_turn" },
          }),
        id: RUNNER_ID,
      },
    ]),
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary" },
    signal: { parts: [{ text, type: "text" }] },
    threadId: thread.threadId,
  });
  const events = await collectEvents(handle.events());
  const [{ messages }, snapshot] = await Promise.all([
    runtime.readBranchMessages({ branchId: thread.branchId }),
    runtime.getTurnState({
      branchId: thread.branchId,
      threadId: thread.threadId,
    }),
  ]);
  return {
    events,
    result: {
      keylessIdentity: {
        branchMessages: messages,
        messageHashes: snapshot.paths.messages,
      },
    },
  };
}
async function buildNodeChild(temporaryDirectory: string): Promise<string> {
  const childPath = join(temporaryDirectory, "admission-key-child.mjs");
  // biome-ignore lint/correctness/noUndeclaredVariables: This parent path runs under Bun; the Node child never calls it.
  const buildResult = await Bun.build({
    entrypoints: [import.meta.path],
    external: ["better-sqlite3"],
    format: "esm",
    naming: "admission-key-child.mjs",
    outdir: temporaryDirectory,
    target: "node",
  });
  if (!buildResult.success) {
    throw new Error(
      `failed to build admission-key process helper: ${buildResult.logs.join("\n")}`
    );
  }
  return childPath;
}
async function linkNodeChildAssets(temporaryDirectory: string): Promise<void> {
  await Promise.all([
    symlink(
      new URL("../../kernel/backends/sqlite/node_modules", import.meta.url)
        .pathname,
      join(temporaryDirectory, "node_modules"),
      "dir"
    ),
    symlink(
      new URL("../../kernel/backends/sqlite/migrations", import.meta.url)
        .pathname,
      join(temporaryDirectory, "migrations"),
      "dir"
    ),
  ]);
}
function spawnNodeChild(
  childPath: string,
  role: "recover" | "write",
  args: string[]
): SpawnedNodeChild {
  // biome-ignore lint/correctness/noUndeclaredVariables: This parent path runs under Bun; the Node child never calls it.
  const child = Bun.spawn({
    cmd: ["node", childPath, CHILD_MARKER, role, ...args],
    stderr: "ignore",
    stdin: "ignore",
    stdout: "pipe",
  });
  return { process: child };
}
async function readChildMessage(
  child: NodeChild,
  timeoutMs: number
): Promise<unknown> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        return JSON.parse(buffer.slice(0, newlineIndex));
      }
      const read = await withDeadline(
        reader.read(),
        "child IPC message",
        timeoutMs
      );
      if (read.done) {
        throw new Error("admission-key child closed IPC before a message");
      }
      buffer += decoder.decode(read.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
async function awaitChildExit(child: NodeChild): Promise<number> {
  return await withDeadline(
    child.exited,
    `child ${child.pid.toString()} exit`,
    PARENT_EXIT_WAIT_MS
  );
}
async function killAndReap(child: NodeChild): Promise<void> {
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
  await awaitChildExit(child);
}
async function withDeadline<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () =>
        reject(new Error(`${label} timed out after ${timeoutMs.toString()}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
function assertOwnedTemporaryDirectory(directory: string): void {
  if (
    !directory.startsWith(TEMPORARY_PREFIX) ||
    directory === TEMPORARY_PREFIX
  ) {
    throw new Error(
      `refusing to remove unowned temporary directory ${directory}`
    );
  }
}
function readCrashScenario(
  dependencies: AdmissionKeyScenarioDependencies,
  scenario: Record<string, unknown>
): CrashScenario {
  const crashPointValue = dependencies.readStringProperty(
    scenario,
    "crashPoint",
    "crashRecovery.crashPoint"
  );
  if (
    crashPointValue !== "queued" &&
    crashPointValue !== "staged" &&
    crashPointValue !== "committed_before_event"
  ) {
    throw new Error("crashRecovery.crashPoint is unsupported");
  }
  const steeringKeysValue = scenario.steeringKeys;
  if (
    !Array.isArray(steeringKeysValue) ||
    steeringKeysValue.length !== 2 ||
    typeof steeringKeysValue[0] !== "string" ||
    typeof steeringKeysValue[1] !== "string"
  ) {
    throw new Error("crashRecovery.steeringKeys must contain two strings");
  }
  return {
    crashPoint: crashPointValue,
    initialKey: dependencies.readStringProperty(
      scenario,
      "initialKey",
      "crashRecovery.initialKey"
    ),
    steeringKeys: [steeringKeysValue[0], steeringKeysValue[1]],
    text: dependencies.readStringProperty(
      scenario,
      "text",
      "crashRecovery.text"
    ),
  };
}
function readPhaseReadyMessage(value: unknown): PhaseReadyMessage {
  if (
    !isRecord(value) ||
    value.kind !== "phase-ready" ||
    typeof value.branchId !== "string" ||
    typeof value.threadId !== "string" ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.suppliedSignals)
  ) {
    throw new Error("writer child returned malformed phase-ready IPC");
  }
  return {
    branchId: value.branchId,
    events: value.events.filter(isStreamEvent),
    kind: value.kind,
    suppliedSignals: value.suppliedSignals.filter(isInputSignal),
    threadId: value.threadId,
  };
}
function readRecoveryMessage(value: unknown): RecoveryMessage {
  if (
    !isRecord(value) ||
    value.kind !== "recovery-result" ||
    !isRecord(value.observation)
  ) {
    throw new Error("recovery child returned malformed IPC");
  }
  return { kind: value.kind, observation: value.observation };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStreamEvent(value: unknown): value is TuvrenStreamEvent {
  return isRecord(value) && typeof value.type === "string";
}
function isInputSignal(value: unknown): value is InputSignal {
  return isRecord(value) && Array.isArray(value.parts);
}
function keyedSignal(text: string, admissionKey: string): InputSignal {
  return { admissionKey, parts: [{ text, type: "text" }] };
}
function keyedUserMessage(
  text: string,
  admissionKey: string
): KeyedTextUserMessage {
  return { admissionKey, parts: [{ text, type: "text" }], role: "user" };
}
async function collectEvents(
  iterable: AsyncIterable<TuvrenStreamEvent>
): Promise<TuvrenStreamEvent[]> {
  const events: TuvrenStreamEvent[] = [];
  await captureEvents(iterable, events);
  return events;
}
async function captureEvents(
  iterable: AsyncIterable<TuvrenStreamEvent>,
  events: TuvrenStreamEvent[]
): Promise<void> {
  for await (const event of iterable) {
    events.push(event);
  }
}
function observePreemptions(
  kernel: RuntimeKernel & RuntimeKernelRunLiveness,
  observations: RecoveryState[]
): RuntimeKernel & RuntimeKernelRunLiveness {
  return {
    ...kernel,
    runLiveness: {
      ...kernel.runLiveness,
      async preemptExpired(runId, ownerId, nowMs, reason) {
        const recovery = await kernel.runLiveness.preemptExpired(
          runId,
          ownerId,
          nowMs,
          reason
        );
        observations.push(structuredClone(recovery));
        return recovery;
      },
    },
  };
}
async function checkpointUserMessage(
  kernel: RuntimeKernel,
  input: {
    branchId: string;
    message: KeyedTextUserMessage;
    runId: string;
    startTurnNodeHash: string;
    stepId: "incorporate_input" | "incorporate_steering";
    turnId: string;
  }
): Promise<string> {
  await kernel.run.create(
    input.runId,
    input.turnId,
    input.branchId,
    DEFAULT_AGENT_SCHEMA.schemaId,
    input.startTurnNodeHash,
    [{ deterministic: false, id: input.stepId, sideEffects: false }]
  );
  await kernel.run.beginStep(input.runId, input.stepId);
  await kernel.staging.stage(
    input.runId,
    encodeDeterministicKernelRecord({
      admissionKey: input.message.admissionKey,
      parts: input.message.parts.map((part) => ({
        text: part.text,
        type: part.type,
      })),
      role: input.message.role,
    }),
    input.stepId === "incorporate_input" ? "input_message" : "steering_message",
    "message",
    "completed"
  );
  await kernel.staging.stage(
    input.runId,
    encodeDeterministicKernelRecord({ activeTurnId: input.turnId }),
    `${input.stepId}_turn_lineage`,
    "turn_lineage",
    "completed"
  );
  const step = await kernel.run.completeStep(input.runId, input.stepId);
  await kernel.run.complete(input.runId, "completed");
  if (step.turnNodeHash === undefined) {
    throw new Error(`${input.stepId} did not checkpoint`);
  }
  await kernel.turn.updateHead(input.turnId, step.turnNodeHash);
  await kernel.branch.setHead(input.branchId, step.turnNodeHash);
  return step.turnNodeHash;
}
async function runWriterChild(config: WriterChildConfig): Promise<void> {
  const backend = createSqliteBackend({
    databasePath: config.databasePath,
    now: () => WRITER_NOW_MS,
  });
  const baseKernel = createRuntimeKernel({
    backend,
    now: () => WRITER_NOW_MS,
  });
  const events: TuvrenStreamEvent[] = [];
  const suppliedSignals = [
    keyedSignal(config.text, config.initialKey),
    keyedSignal(config.text, config.steeringKeys[0]),
    keyedSignal(config.text, config.steeringKeys[1]),
  ];
  let threadId = "";
  let branchId = "";
  let steeringTurnNodeHash: string | undefined;
  const phaseReady = async (): Promise<never> => {
    await Promise.resolve();
    writeChildMessage({
      branchId,
      events,
      kind: "phase-ready",
      suppliedSignals,
      threadId,
    });
    return await withDeadline(
      new Promise<never>(() => {
        // This barrier stays pending until the parent terminates the child.
      }),
      "writer crash barrier",
      CHILD_WAIT_MS
    );
  };
  const kernel: RuntimeKernel & RuntimeKernelRunLiveness = {
    ...baseKernel,
    branch: {
      ...baseKernel.branch,
      async setHead(targetBranchId, turnNodeHash) {
        const result = await baseKernel.branch.setHead(
          targetBranchId,
          turnNodeHash
        );
        if (
          config.crashPoint === "committed_before_event" &&
          steeringTurnNodeHash === turnNodeHash
        ) {
          await phaseReady();
        }
        return result;
      },
    },
    run: {
      ...baseKernel.run,
      async completeStep(runId, stepId, eventHash, observeResults, treeHash) {
        if (
          config.crashPoint === "staged" &&
          stepId === "incorporate_steering"
        ) {
          await phaseReady();
        }
        const result = await baseKernel.run.completeStep(
          runId,
          stepId,
          eventHash,
          observeResults,
          treeHash
        );
        if (stepId === "incorporate_steering") {
          steeringTurnNodeHash = result.turnNodeHash;
        }
        return result;
      },
    },
  };
  const firstRunnerEntered = Promise.withResolvers<void>();
  const releaseFirstRunner = Promise.withResolvers<void>();
  let runnerCalls = 0;
  const runner: RuntimeRunner = {
    async execute() {
      runnerCalls += 1;
      if (runnerCalls === 1) {
        firstRunnerEntered.resolve();
        await withDeadline(
          releaseFirstRunner.promise,
          "writer first runner release",
          CHILD_WAIT_MS
        );
        return { messages: [], resolution: { type: "continue_iteration" } };
      }
      return {
        messages: [],
        resolution: { reason: "done", type: "end_turn" },
      };
    },
    id: RUNNER_ID,
  };
  const runtime = createTuvrenRuntime({
    defaultRunnerId: RUNNER_ID,
    kernel,
    now: () => WRITER_NOW_MS,
    runLiveness: {
      executionOwnerId: "writer-owner",
      leaseDurationMs: 100,
    },
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  threadId = thread.threadId;
  branchId = thread.branchId;
  const handle = runtime.executeTurn({
    branchId,
    config: { name: "primary" },
    signal: suppliedSignals[0],
    threadId,
  });
  const draining = captureEvents(handle.events(), events);
  await withDeadline(
    firstRunnerEntered.promise,
    "writer first runner entry",
    CHILD_WAIT_MS
  );
  handle.steer(suppliedSignals[1]);
  handle.steer(suppliedSignals[2]);
  if (config.crashPoint === "queued") {
    await phaseReady();
  }
  releaseFirstRunner.resolve();
  await withDeadline(draining, "writer execution", CHILD_WAIT_MS);
  throw new Error("writer execution passed its requested crash barrier");
}
async function runRecoveryChild(config: RecoveryChildConfig): Promise<void> {
  const backend = createSqliteBackend({
    databasePath: config.databasePath,
    now: () => RECOVERY_NOW_MS,
  });
  try {
    const baseKernel = createRuntimeKernel({
      backend,
      now: () => RECOVERY_NOW_MS,
    });
    const expiredRunsBefore =
      await baseKernel.runLiveness.listExpired(RECOVERY_NOW_MS);
    const preemptions: RecoveryState[] = [];
    const kernel = observePreemptions(baseKernel, preemptions);
    const runner: RuntimeRunner = {
      execute: () =>
        Promise.resolve({
          messages: [],
          resolution: { reason: "done", type: "end_turn" },
        }),
      id: RUNNER_ID,
    };
    const runtime = createTuvrenRuntime({
      defaultRunnerId: RUNNER_ID,
      kernel,
      now: () => RECOVERY_NOW_MS,
      runLiveness: {
        executionOwnerId: "recovery-owner",
        leaseDurationMs: 100,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const handle = runtime.executeTurn({
      branchId: config.branchId,
      config: { name: "primary" },
      signal: { parts: [{ text: config.text, type: "text" }] },
      threadId: config.threadId,
    });
    const events = await withDeadline(
      collectEvents(handle.events()),
      "recovery child execution",
      CHILD_WAIT_MS
    );
    const { messages } = await runtime.readBranchMessages({
      branchId: config.branchId,
    });
    writeChildMessage({
      kind: "recovery-result",
      observation: {
        branchMessages: messages,
        events,
        expiredRunsAfter: await kernel.runLiveness.listExpired(RECOVERY_NOW_MS),
        expiredRunsBefore,
        preemptions,
        runtimeStatus: handle.status(),
      },
    });
  } finally {
    await backend.close();
  }
}
function writeChildMessage(message: PhaseReadyMessage | RecoveryMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
if (process.argv[2] === CHILD_MARKER) {
  const role = process.argv[3];
  if (role !== "write" && role !== "recover") {
    throw new Error("invalid admission-key child invocation");
  }
  const childArg = (index: number): string => {
    const value = process.argv[index];
    if (value === undefined || value.length === 0) {
      throw new Error(
        `missing admission-key child argument ${index.toString()}`
      );
    }
    return value;
  };
  if (role === "write") {
    const crashPoint = childArg(5);
    if (
      crashPoint !== "queued" &&
      crashPoint !== "staged" &&
      crashPoint !== "committed_before_event"
    ) {
      throw new Error("invalid writer crash point");
    }
    await runWriterChild({
      crashPoint,
      databasePath: childArg(4),
      initialKey: childArg(7),
      steeringKeys: [childArg(8), childArg(9)],
      text: childArg(6),
    });
  } else {
    await runRecoveryChild({
      branchId: childArg(5),
      databasePath: childArg(4),
      text: childArg(7),
      threadId: childArg(6),
    });
  }
}
