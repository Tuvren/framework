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

import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { InputSignal } from "@tuvren/core/execution";

import type { AdapterProjection } from "./framework-adapter-runtime.ts";

const PARENT_PHASE_WAIT_MS = 15_000;
const PARENT_EXIT_WAIT_MS = 5000;
const TEMPORARY_PREFIX = path.join(tmpdir(), "tuvren-admission-key-");

export type CrashPoint = "committed_before_event" | "queued" | "staged";

interface AdmissionKeyCrashDependencies {
  buildNodeChild: (temporaryDirectory: string) => Promise<string>;
  readOperationScenario: (
    input: unknown,
    operation: string
  ) => Record<string, unknown>;
  readStringProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => string;
  spawnNodeChild: (
    childPath: string,
    role: "recover" | "write",
    args: string[]
  ) => SpawnedNodeChild;
}

interface CrashScenario {
  crashPoint: CrashPoint;
  initialKey: string;
  steeringKeys: [string, string];
  text: string;
}

export interface WriterChildConfig extends CrashScenario {
  databasePath: string;
}

export interface RecoveryChildConfig {
  branchId: string;
  databasePath: string;
  text: string;
  threadId: string;
}

export interface PhaseReadyMessage {
  branchId: string;
  events: TuvrenStreamEvent[];
  kind: "phase-ready";
  suppliedSignals: InputSignal[];
  threadId: string;
}

export interface RecoveryMessage {
  kind: "recovery-result";
  observation: Record<string, unknown>;
}

export interface NodeChild {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly pid: number;
  readonly signalCode: string | null;
  readonly stdout: ReadableStream<Uint8Array>;
  kill: (signal?: NodeJS.Signals | number) => void;
}

export interface SpawnedNodeChild {
  process: NodeChild;
}

const readCrashScenario = (
  dependencies: AdmissionKeyCrashDependencies,
  scenario: Record<string, unknown>
): CrashScenario => {
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
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStreamEvent = (value: unknown): value is TuvrenStreamEvent =>
  isRecord(value) && typeof value.type === "string";

const isInputSignal = (value: unknown): value is InputSignal =>
  isRecord(value) && Array.isArray(value.parts);

const readPhaseReadyMessage = (value: unknown): PhaseReadyMessage => {
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
};

export const withDeadline = async <T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number
): Promise<T> => {
  const timeoutPromise = Promise.withResolvers<never>();
  const timeout = setTimeout(() => {
    timeoutPromise.reject(
      new Error(`${label} timed out after ${timeoutMs.toString()}ms`)
    );
  }, timeoutMs);
  try {
    return await Promise.race([promise, timeoutPromise.promise]);
  } finally {
    clearTimeout(timeout);
  }
};

const readChildMessageChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
  timeoutMs: number
): Promise<unknown> => {
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
  return await readChildMessageChunk(
    reader,
    decoder,
    buffer + decoder.decode(read.value, { stream: true }),
    timeoutMs
  );
};

const readChildMessage = async (
  child: NodeChild,
  timeoutMs: number
): Promise<unknown> => {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  try {
    return await readChildMessageChunk(reader, decoder, "", timeoutMs);
  } finally {
    reader.releaseLock();
  }
};

const awaitChildExit = async (child: NodeChild): Promise<number> =>
  await withDeadline(
    child.exited,
    `child ${child.pid.toString()} exit`,
    PARENT_EXIT_WAIT_MS
  );

const readRecoveryMessage = (value: unknown): RecoveryMessage => {
  if (
    !isRecord(value) ||
    value.kind !== "recovery-result" ||
    !isRecord(value.observation)
  ) {
    throw new Error("recovery child returned malformed IPC");
  }
  return { kind: value.kind, observation: value.observation };
};

const killAndReap = async (child: NodeChild): Promise<void> => {
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
  await awaitChildExit(child);
};

const assertOwnedTemporaryDirectory = (directory: string): void => {
  if (
    !directory.startsWith(TEMPORARY_PREFIX) ||
    directory === TEMPORARY_PREFIX
  ) {
    throw new Error(
      `refusing to remove unowned temporary directory ${directory}`
    );
  }
};

const linkNodeChildAssets = async (
  temporaryDirectory: string
): Promise<void> => {
  await Promise.all([
    symlink(
      new URL("../../kernel/backends/sqlite/node_modules", import.meta.url)
        .pathname,
      path.join(temporaryDirectory, "node_modules"),
      "dir"
    ),
    symlink(
      new URL("../../kernel/backends/sqlite/migrations", import.meta.url)
        .pathname,
      path.join(temporaryDirectory, "migrations"),
      "dir"
    ),
  ]);
};

export const runCrashRecoveryScenario = async (
  dependencies: AdmissionKeyCrashDependencies,
  input: unknown
): Promise<AdapterProjection> => {
  const scenario = readCrashScenario(
    dependencies,
    dependencies.readOperationScenario(
      input,
      "runtime.admission-key.crash-recovery"
    )
  );
  const temporaryDirectory = await mkdtemp(TEMPORARY_PREFIX);
  const databasePath = path.join(temporaryDirectory, "runtime.sqlite");
  let writer: SpawnedNodeChild | undefined;
  let recovery: SpawnedNodeChild | undefined;
  try {
    const childPath = await dependencies.buildNodeChild(temporaryDirectory);
    await linkNodeChildAssets(temporaryDirectory);
    writer = dependencies.spawnNodeChild(childPath, "write", [
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
    recovery = dependencies.spawnNodeChild(childPath, "recover", [
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
};
