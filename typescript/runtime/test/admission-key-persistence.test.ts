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

// biome-ignore-all lint/suspicious/useAwait: Test runners intentionally match the async framework runner contract.
import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryBackend } from "@tuvren/backend-memory";
import type { InputSignal, TuvrenRuntime } from "@tuvren/core/execution";
import { assertTuvrenMessage } from "@tuvren/core/messages";
import type { TuvrenMessage } from "@tuvren/core/messages";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { build, spawn } from "bun";

import {
  createOrchestrationRuntime,
  createTuvrenRuntime,
  DEFAULT_AGENT_SCHEMA,
} from "../src/index.ts";
import {
  createRunnerRegistry,
  createStaticRunner,
} from "./orchestration-runtime-runner-helpers.ts";
import {
  assistantText,
  collectEvents,
  delay,
  startEventCapture,
  textSignal,
} from "./runtime-core-test-helpers.ts";

const BACKEND_NAMES = ["memory", "sqlite"] as const;
const SQLITE_READY_PREFIX = "READY\n";

describe("KRT-CS002 admission-key persistence", () => {
  for (const backendName of BACKEND_NAMES) {
    test(`returns keyed initial and equal-text steering messages from the ${backendName} durable read`, async () => {
      if (backendName === "sqlite") {
        expect(await runSqlitePersistenceScenario()).toEqual(
          expectedKeyedUserMessages()
        );
        return;
      }

      const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
      const firstIterationReady = Promise.withResolvers<void>();
      const releaseFirstIteration = Promise.withResolvers<void>();
      const runner = createStaticRunner(async (context) => {
        const repeatedSteeringCount = context.messages.filter(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.text === "Repeated steering"
            )
        ).length;

        if (repeatedSteeringCount === 0) {
          firstIterationReady.resolve();
          await releaseFirstIteration.promise;
          return {
            messages: [assistantText("Waiting for repeated steering.")],
            resolution: { type: "continue_iteration" },
          };
        }

        if (repeatedSteeringCount === 1) {
          return {
            messages: [],
            resolution: { type: "continue_iteration" },
          };
        }

        return {
          messages: [assistantText("Both steering messages incorporated.")],
          resolution: { reason: "done", type: "end_turn" },
        };
      });
      const runtime = createTuvrenRuntime({
        defaultRunnerId: "fake",
        kernel,
        runnerRegistry: createRunnerRegistry([runner]),
      });
      const thread = await runtime.createThread({});
      const handle = runtime.executeTurn({
        branchId: thread.branchId,
        config: { name: "primary" },
        signal: keyedSignal("Initial keyed input", "initial-key"),
        threadId: thread.threadId,
      });
      const eventsPromise = collectEvents(handle.events());

      await firstIterationReady.promise;
      handle.steer(keyedSignal("Repeated steering", "steering-key-a"));
      handle.steer(keyedSignal("Repeated steering", "steering-key-b"));
      releaseFirstIteration.resolve();
      await eventsPromise;

      const { messages } = await runtime.readBranchMessages({
        branchId: thread.branchId,
      });
      const keyedUserMessages = messages.filter(
        (message): message is UserMessage =>
          "role" in message &&
          message.role === "user" &&
          message.admissionKey !== undefined
      );

      expect(keyedUserMessages).toEqual(expectedKeyedUserMessages());
    });
  }

  test("stores the keyless initial message under its pre-change hash", async () => {
    const fixture = await readAdmissionKeylessFixture();
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel,
      runnerRegistry: createRunnerRegistry([
        createStaticRunner(async () => ({
          messages: [],
          resolution: { reason: "done", type: "end_turn" },
        })),
      ]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: { parts: fixture.message.parts },
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    const snapshot = await runtime.getTurnState({
      branchId: thread.branchId,
      threadId: thread.threadId,
    });
    const messageHashes = snapshot.paths.messages;

    expect(Array.isArray(messageHashes)).toBe(true);
    expect(messageHashes).toEqual([fixture.identityPayloadCodec.messageHash]);
  });

  test("reaps a child that misses the SQLite process deadline and removes only its directory", async () => {
    const temporaryParent = await mkdtemp(
      join(tmpdir(), "tuvren-cs002-timeout-parent-")
    );
    const unrelatedFile = join(temporaryParent, "keep.txt");
    await writeFile(unrelatedFile, "unrelated");
    let childReaped = false;

    try {
      await expect(
        runSqlitePersistenceScenario({
          childMode: "hang-after-ready",
          onChildReaped: () => {
            childReaped = true;
          },
          processTimeoutMs: 150,
          readinessTimeoutMs: 1000,
          temporaryDirectoryParent: temporaryParent,
        })
      ).rejects.toThrow(
        "SQLite child scenario exceeded its 150ms process deadline"
      );

      expect(childReaped).toBe(true);
      expect(await readdir(temporaryParent)).toEqual(["keep.txt"]);
      expect(await readFile(unrelatedFile, "utf-8")).toBe("unrelated");
    } finally {
      await rm(temporaryParent, { force: true, recursive: true });
    }
  });

  test("keeps a keyed staged steering message atomic through stale-run preemption", async () => {
    let nowMs = 1;
    const backend = createMemoryBackend({ now: () => nowMs });
    const kernel = createRuntimeKernel({ backend });
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "unused",
      kernel,
    });
    const thread = await runtime.createThread({});
    const staleTurn = await kernel.turn.create(
      "turn-keyed-staged-steering",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "expired-owner",
      leaseExpiresAtMs: 10,
      runId: "run-keyed-staged-steering",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [
        {
          deterministic: false,
          id: "incorporate_steering",
          sideEffects: false,
        },
      ],
      turnId: staleTurn.turnId,
    });
    await kernel.run.beginStep(
      "run-keyed-staged-steering",
      "incorporate_steering"
    );
    await kernel.staging.stage(
      "run-keyed-staged-steering",
      encodeDeterministicKernelRecord({
        admissionKey: "staged-before-checkpoint",
        parts: [{ text: "Durable staged steering", type: "text" }],
        role: "user",
      }),
      "steering_message",
      "message",
      "completed"
    );

    nowMs = 11;
    await kernel.runLiveness.preemptExpired(
      "run-keyed-staged-steering",
      "recovery-owner",
      nowMs,
      "stale_running_recovery"
    );

    expect(
      (await runtime.readBranchMessages({ branchId: thread.branchId })).messages
    ).toEqual([
      {
        admissionKey: "staged-before-checkpoint",
        parts: [{ text: "Durable staged steering", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("leaves no message or key when stale-run preemption happens before staging", async () => {
    let nowMs = 1;
    const backend = createMemoryBackend({ now: () => nowMs });
    const kernel = createRuntimeKernel({ backend });
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "unused",
      kernel,
    });
    const thread = await runtime.createThread({});
    const staleTurn = await kernel.turn.create(
      "turn-fault-before-steering-stage",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "expired-owner",
      leaseExpiresAtMs: 10,
      runId: "run-fault-before-steering-stage",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [
        {
          deterministic: false,
          id: "incorporate_steering",
          sideEffects: false,
        },
      ],
      turnId: staleTurn.turnId,
    });
    await kernel.run.beginStep(
      "run-fault-before-steering-stage",
      "incorporate_steering"
    );

    nowMs = 11;
    await kernel.runLiveness.preemptExpired(
      "run-fault-before-steering-stage",
      "recovery-owner",
      nowMs,
      "stale_running_recovery"
    );

    expect(
      (await runtime.readBranchMessages({ branchId: thread.branchId })).messages
    ).toEqual([]);
  });

  test("preserves a key through bound orchestration steering", async () => {
    const { orchestration, runtime } = createOrchestrationFixture();
    const thread = await runtime.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Start bound orchestration steering"),
      threadId: thread.threadId,
    });
    const capture = startEventCapture(handle.events());

    await delay(0);
    handle.steer(keyedSignal("Orchestration steering", "bound-key"));
    await capture.done;

    expect(
      (await runtime.readBranchMessages({ branchId: thread.branchId })).messages
    ).toContainEqual({
      admissionKey: "bound-key",
      parts: [{ text: "Orchestration steering", type: "text" }],
      role: "user",
    });
  });

  test("preserves a key queued before an orchestration child binding resolves", async () => {
    const { orchestration, releaseChildBinding, runtime } =
      createOrchestrationFixture({
        delayChildBinding: true,
      });
    const thread = await runtime.createThread({});
    const rootHandle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Start root before child"),
      threadId: thread.threadId,
    });
    const rootCapture = startEventCapture(rootHandle.allEvents());

    await delay(0);
    const childHandle = rootHandle.spawn({
      agent: "worker",
      signal: textSignal("Start child"),
    });
    childHandle.steer(keyedSignal("Pre-bind steering", "pre-bind-key"));
    releaseChildBinding();
    const childResult = await childHandle.awaitResult();
    await rootCapture.done;

    expect(childResult.status).toBe("completed");
    const childThread = (
      await runtime.listThreads({
        filter: { schemaId: DEFAULT_AGENT_SCHEMA.schemaId },
      })
    ).threads.find((candidate) => candidate.threadId !== thread.threadId);

    if (childThread === undefined) {
      throw new Error("expected the orchestration child thread");
    }

    const [childBranch] = await runtime.listBranches({
      threadId: childThread.threadId,
    });

    if (childBranch === undefined) {
      throw new Error("expected the orchestration child branch");
    }

    expect(
      (await runtime.readBranchMessages({ branchId: childBranch.branchId }))
        .messages
    ).toContainEqual({
      admissionKey: "pre-bind-key",
      parts: [{ text: "Pre-bind steering", type: "text" }],
      role: "user",
    });
  });
});

function keyedSignal(text: string, admissionKey: string): InputSignal {
  return {
    admissionKey,
    parts: [{ text, type: "text" }],
  };
}

function createOrchestrationFixture(options?: { delayChildBinding?: boolean }) {
  const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
  const runner = createStaticRunner(async (context) => {
    const steeringSeen = context.messages.some(
      (message) =>
        message.role === "user" &&
        message.parts.some(
          (part) =>
            part.type === "text" &&
            (part.text === "Orchestration steering" ||
              part.text === "Pre-bind steering")
        )
    );

    if (steeringSeen) {
      return {
        messages: [assistantText("Steering incorporated.")],
        resolution: { reason: "done", type: "end_turn" },
      };
    }

    const startsRootBeforeChild = context.messages.some(
      (message) =>
        message.role === "user" &&
        message.parts.some(
          (part) =>
            part.type === "text" && part.text === "Start root before child"
        )
    );

    if (startsRootBeforeChild) {
      await delay(30);
      return {
        messages: [assistantText("Root completed after child launch.")],
        resolution: { reason: "done", type: "end_turn" },
      };
    }

    await delay(context.config.name === "primary" ? 30 : 10);
    return {
      messages: [assistantText("Waiting for orchestration steering.")],
      resolution: { type: "continue_iteration" },
    };
  });
  const runtime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    kernel,
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const childBindingGate = Promise.withResolvers<void>();
  if (!options?.delayChildBinding) {
    childBindingGate.resolve();
  }
  const framework: TuvrenRuntime = {
    createBranch: async (input) => await runtime.createBranch(input),
    createThread: async (input) => await runtime.createThread(input),
    executeTurn: (input) => runtime.executeTurn(input),
    getThread: async (threadId) => {
      await childBindingGate.promise;
      return await runtime.getThread(threadId);
    },
    getTurnHistory: (input, historyOptions) =>
      runtime.getTurnHistory(input, historyOptions),
    getTurnState: async (input) => await runtime.getTurnState(input),
    listBranches: async (input) => await runtime.listBranches(input),
    listThreads: async (listOptions) => await runtime.listThreads(listOptions),
    maintenance: runtime.maintenance,
    readBranchMessages: async (input) =>
      await runtime.readBranchMessages(input),
    setBranchHead: async (input) => await runtime.setBranchHead(input),
  };
  const orchestration = createOrchestrationRuntime({
    agents: {
      primary: { name: "primary" },
      worker: { name: "worker" },
    },
    framework,
  });

  return {
    orchestration,
    releaseChildBinding: () => childBindingGate.resolve(),
    runtime,
  };
}

type UserMessage = Extract<TuvrenMessage, { role: "user" }>;

function expectedKeyedUserMessages(): UserMessage[] {
  return [
    {
      admissionKey: "initial-key",
      parts: [{ text: "Initial keyed input", type: "text" }],
      role: "user",
    },
    {
      admissionKey: "steering-key-a",
      parts: [{ text: "Repeated steering", type: "text" }],
      role: "user",
    },
    {
      admissionKey: "steering-key-b",
      parts: [{ text: "Repeated steering", type: "text" }],
      role: "user",
    },
  ];
}

interface SqlitePersistenceScenarioOptions {
  childMode?: "hang-after-ready";
  onChildReaped?: () => void;
  processTimeoutMs?: number;
  readinessTimeoutMs?: number;
  temporaryDirectoryParent?: string;
}

const SQLITE_READINESS_TIMEOUT_MS = 1000;
const SQLITE_PROCESS_TIMEOUT_MS = 1500;

async function runSqlitePersistenceScenario(
  options: SqlitePersistenceScenarioOptions = {}
): Promise<TuvrenMessage[]> {
  const temporaryDirectory = await mkdtemp(
    join(options.temporaryDirectoryParent ?? tmpdir(), "tuvren-cs002-sqlite-")
  );
  let child: ReturnType<typeof spawn> | undefined;
  let childExit: Promise<number> | undefined;
  let stdoutTask: Promise<string> | undefined;
  let stderrTask: Promise<string> | undefined;

  try {
    const buildResult = await build({
      entrypoints: [
        new URL("fixtures/admission-key-sqlite-child.ts", import.meta.url)
          .pathname,
      ],
      external: ["better-sqlite3"],
      format: "esm",
      naming: "sqlite-scenario.mjs",
      outdir: temporaryDirectory,
      target: "node",
    });

    if (!buildResult.success) {
      throw new Error(
        `failed to build SQLite child scenario: ${buildResult.logs.join("\n")}`
      );
    }

    await symlink(
      new URL("../../kernel/backends/sqlite/node_modules", import.meta.url)
        .pathname,
      join(temporaryDirectory, "node_modules"),
      "dir"
    );
    await symlink(
      new URL("../../kernel/backends/sqlite/migrations", import.meta.url)
        .pathname,
      join(temporaryDirectory, "migrations"),
      "dir"
    );

    child = spawn(
      [
        "node",
        join(temporaryDirectory, "sqlite-scenario.mjs"),
        join(temporaryDirectory, "runtime.sqlite"),
        options.childMode ?? "",
      ],
      {
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    childExit = child.exited;
    const { stdout } = child;
    const { stderr } = child;
    if (
      !(stdout instanceof ReadableStream && stderr instanceof ReadableStream)
    ) {
      throw new Error("SQLite child scenario did not create output pipes");
    }

    let ready = false;
    const readiness = Promise.withResolvers<void>();
    stdoutTask = readTextStream(stdout, (accumulatedText) => {
      if (!ready && accumulatedText.includes(SQLITE_READY_PREFIX)) {
        ready = true;
        readiness.resolve();
      }
    });
    stderrTask = new Response(stderr).text();
    const exit = childExit;

    await withTimeout(
      Promise.race([
        readiness.promise,
        exit.then(() => {
          throw new Error("SQLite child exited before becoming ready");
        }),
      ]),
      options.readinessTimeoutMs ?? SQLITE_READINESS_TIMEOUT_MS,
      `SQLite child scenario exceeded its ${options.readinessTimeoutMs ?? SQLITE_READINESS_TIMEOUT_MS}ms readiness deadline`
    );
    const exitCode = await withTimeout(
      exit,
      options.processTimeoutMs ?? SQLITE_PROCESS_TIMEOUT_MS,
      `SQLite child scenario exceeded its ${options.processTimeoutMs ?? SQLITE_PROCESS_TIMEOUT_MS}ms process deadline`
    );
    const [standardOutput, standardError] = await Promise.all([
      stdoutTask,
      stderrTask,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `SQLite child scenario exited with ${exitCode.toString()}: ${standardError}`
      );
    }

    const messages: unknown = JSON.parse(
      standardOutput.startsWith(SQLITE_READY_PREFIX)
        ? standardOutput.slice(SQLITE_READY_PREFIX.length)
        : standardOutput
    );
    if (!Array.isArray(messages)) {
      throw new TypeError("SQLite child scenario returned malformed messages");
    }

    const validatedMessages: TuvrenMessage[] = [];
    for (const [index, message] of messages.entries()) {
      assertTuvrenMessage(message, `SQLite child message ${index.toString()}`);
      validatedMessages.push(message);
    }

    return validatedMessages;
  } finally {
    try {
      if (child !== undefined && childExit !== undefined) {
        if (child.exitCode === null) {
          child.kill();
        }
        await childExit;
        options.onChildReaped?.();
        await Promise.allSettled(
          [stdoutTask, stderrTask].filter(
            (task): task is Promise<string> => task !== undefined
          )
        );
      }
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

async function readTextStream(
  stream: ReadableStream<Uint8Array>,
  onText: (accumulatedText: string) => void
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let accumulatedText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        accumulatedText += decoder.decode();
        return accumulatedText;
      }

      const chunk = decoder.decode(value, { stream: true });
      accumulatedText += chunk;
      onText(accumulatedText);
    }
  } finally {
    reader.releaseLock();
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

interface AdmissionKeylessFixture {
  identityPayloadCodec: {
    messageHash: string;
  };
  message: Extract<TuvrenMessage, { role: "user" }>;
}

async function readAdmissionKeylessFixture(): Promise<AdmissionKeylessFixture> {
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL(
        "../../../spec/conformance/engine/fixtures/admission-keyless-user-message.json",
        import.meta.url
      ),
      "utf-8"
    )
  );

  if (
    fixture === null ||
    typeof fixture !== "object" ||
    !("message" in fixture) ||
    fixture.message === null ||
    typeof fixture.message !== "object" ||
    !("role" in fixture.message) ||
    fixture.message.role !== "user" ||
    !("parts" in fixture.message) ||
    !Array.isArray(fixture.message.parts) ||
    fixture.message.parts.length !== 1 ||
    fixture.message.parts[0] === null ||
    typeof fixture.message.parts[0] !== "object" ||
    !("type" in fixture.message.parts[0]) ||
    fixture.message.parts[0].type !== "text" ||
    !("text" in fixture.message.parts[0]) ||
    typeof fixture.message.parts[0].text !== "string" ||
    !("identityPayloadCodec" in fixture) ||
    fixture.identityPayloadCodec === null ||
    typeof fixture.identityPayloadCodec !== "object" ||
    !("messageHash" in fixture.identityPayloadCodec) ||
    typeof fixture.identityPayloadCodec.messageHash !== "string"
  ) {
    throw new Error("admission-keyless user-message fixture is malformed");
  }

  return {
    identityPayloadCodec: {
      messageHash: fixture.identityPayloadCodec.messageHash,
    },
    message: {
      parts: [
        {
          text: fixture.message.parts[0].text,
          type: "text",
        },
      ],
      role: "user",
    },
  };
}
