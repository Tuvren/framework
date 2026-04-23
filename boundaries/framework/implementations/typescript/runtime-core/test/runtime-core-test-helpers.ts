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

import type { KrakenDriver } from "@tuvren/driver-api";
import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  type KrakenKernel,
} from "@tuvren/kernel-protocol";
import type {
  AgentConfig,
  ContextManifest,
  ExecutionHandle,
  ExecutionStatus,
  HandoffContextPlan,
  HandoffSourceContext,
  InputSignal,
  KernelRecord,
  TuvrenMessage,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import {
  assertContextManifest,
  assertTuvrenMessage,
} from "@tuvren/runtime-api";

export async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

export async function readBranchCheckpointEventTypes(
  kernel: KrakenKernel,
  branchId: string
): Promise<string[]> {
  const branch = await kernel.branch.get(branchId);

  if (branch === null) {
    throw new Error(`expected branch "${branchId}" to exist`);
  }

  const eventTypes: string[] = [];

  for await (const turnNode of kernel.node.walkBack(branch.headTurnNodeHash)) {
    if (turnNode.eventHash === null) {
      continue;
    }

    const payload = await kernel.store.get(turnNode.eventHash);

    if (payload === null) {
      throw new Error(`expected event "${turnNode.eventHash}" to exist`);
    }

    const decoded = decodeDeterministicKernelRecord(payload);

    if (
      decoded !== null &&
      typeof decoded === "object" &&
      !Array.isArray(decoded) &&
      "type" in decoded &&
      typeof decoded.type === "string"
    ) {
      eventTypes.push(decoded.type);
    }
  }

  return eventTypes;
}

export function toKrakenMessages(
  messages: readonly unknown[]
): TuvrenMessage[] {
  return messages.map((message, index) => {
    assertTuvrenMessage(message, `messages[${index}]`);
    return message;
  });
}

export function toOptionalRecord(
  value: unknown
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(value));
}

export function detachTestPromise(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

export const TIMEOUT_TOKEN = Symbol("timeout");

export async function collectEventsForDuration<T>(
  events: AsyncIterable<T>,
  durationMilliseconds: number
): Promise<T[]> {
  const collected: T[] = [];
  const iterator = events[Symbol.asyncIterator]();
  const deadline = Date.now() + durationMilliseconds;

  try {
    while (Date.now() < deadline) {
      const nextValue = await settleWithin(
        iterator.next(),
        deadline - Date.now()
      );

      if (nextValue === TIMEOUT_TOKEN || nextValue.done) {
        break;
      }

      collected.push(nextValue.value);
    }
  } finally {
    await iterator.return?.();
  }

  return collected;
}

export function startEventCapture<T>(events: AsyncIterable<T>): {
  done: Promise<void>;
  events: T[];
} {
  const collected: T[] = [];

  return {
    done: (async () => {
      for await (const event of events) {
        collected.push(event);
      }
    })(),
    events: collected,
  };
}

export async function collectToolResultTimeline(
  events: AsyncIterable<{ callId?: string; type: string }>,
  timeline: string[]
): Promise<void> {
  for await (const event of events) {
    if (event.type === "tool.result" && typeof event.callId === "string") {
      timeline.push(`event:${event.callId}`);
    }
  }
}

export async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number
): Promise<T | typeof TIMEOUT_TOKEN> {
  return await Promise.race<T | typeof TIMEOUT_TOKEN>([
    promise,
    delay(timeoutMilliseconds).then((): typeof TIMEOUT_TOKEN => TIMEOUT_TOKEN),
  ]);
}

export async function waitFor(
  condition: () => boolean,
  timeoutMilliseconds = 1000
): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMilliseconds) {
      throw new Error("timed out waiting for condition");
    }

    await delay(5);
  }
}

export async function waitForAsync(
  condition: () => Promise<boolean>,
  timeoutMilliseconds = 1000
): Promise<void> {
  const startedAt = Date.now();

  while (!(await condition())) {
    if (Date.now() - startedAt >= timeoutMilliseconds) {
      throw new Error("timed out waiting for condition");
    }

    await delay(5);
  }
}

export function createStubExecutionHandle(
  initialPhase: ExecutionStatus["phase"]
): ExecutionHandle {
  let phase = initialPhase;
  let closed = initialPhase !== "running";
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;

    if (closed) {
      resolve();
    }
  });

  const handle: ExecutionHandle = {
    cancel() {
      phase = "failed";

      if (!closed) {
        closed = true;
        resolveClosed?.();
      }
    },
    events() {
      return (async function* () {
        await closedPromise;
        yield* [];
      })();
    },
    resolveApproval() {
      return handle;
    },
    status() {
      return {
        iterationCount: 0,
        phase,
      };
    },
    steer() {
      return;
    },
  };

  return handle;
}

export function assistantText(text: string): TuvrenMessage {
  return {
    parts: [{ text, type: "text" }],
    role: "assistant",
  };
}

export function assistantStructured(
  name: string,
  data: unknown
): TuvrenMessage {
  return {
    parts: [{ data, name, type: "structured" }],
    role: "assistant",
  };
}

export function assistantToolCalls(
  calls: [
    {
      callId: string;
      input: unknown;
      name: string;
    },
    ...Array<{
      callId: string;
      input: unknown;
      name: string;
    }>,
  ]
): TuvrenMessage {
  const parts = toNonEmptyArray(
    calls.map((call) => ({
      callId: call.callId,
      input: call.input,
      name: call.name,
      type: "tool_call" as const,
    }))
  );

  if (parts === undefined) {
    throw new Error("assistantToolCalls requires at least one tool call");
  }

  return {
    parts,
    role: "assistant",
  };
}

function toNonEmptyArray<T>(values: T[]): [T, ...T[]] | undefined {
  const [firstValue, ...remainingValues] = values;

  if (firstValue === undefined) {
    return undefined;
  }

  return [firstValue, ...remainingValues];
}

export function buildHandoffPlan(
  context: Parameters<KrakenDriver["execute"]>[0],
  sourceAgent: AgentConfig,
  targetAgent: AgentConfig,
  builder: HandoffContextPlan["builder"]
): HandoffContextPlan {
  return {
    builder,
    mode: "preserve_trace",
    reason: "delegate",
    sourceContext: {
      handoffIntent: {
        reason: "delegate",
        targetAgent: targetAgent.name,
      },
      helpers: {
        loadMessage() {
          return null;
        },
        storeMessage() {
          return "0".repeat(64);
        },
        storeMessages() {
          return [];
        },
      },
      manifest: structuredClone(context.manifest),
      messages: [...context.messages],
      sourceAgent,
      targetAgent,
    } satisfies HandoffSourceContext,
    targetAgent: targetAgent.name,
  };
}

export function createStaticExecutionHandle(
  events: TuvrenStreamEvent[],
  status: ExecutionStatus
): ExecutionHandle {
  return {
    cancel() {
      return undefined;
    },
    async *events() {
      await Promise.resolve();

      for (const event of events) {
        yield event;
      }
    },
    resolveApproval() {
      throw new Error("resolveApproval was not expected");
    },
    status() {
      return status;
    },
    steer() {
      return undefined;
    },
  };
}

export async function overwriteBranchSinglePath(
  kernel: KrakenKernel,
  branchId: string,
  turnId: string,
  path: "context.manifest" | "runtime.status",
  value: KernelRecord
): Promise<void> {
  const branch = await kernel.branch.get(branchId);

  if (branch === null) {
    throw new Error(`missing branch "${branchId}"`);
  }

  const headNode = await kernel.node.get(branch.headTurnNodeHash);

  if (headNode === null) {
    throw new Error(`missing turn node "${branch.headTurnNodeHash}"`);
  }

  const objectHash = await kernel.store.put(
    encodeDeterministicKernelRecord(value)
  );
  const nextTreeHash =
    path === "context.manifest"
      ? await kernel.tree.create(
          headNode.schemaId,
          { "context.manifest": objectHash },
          headNode.turnTreeHash
        )
      : await kernel.tree.create(
          headNode.schemaId,
          { "runtime.status": objectHash },
          headNode.turnTreeHash
        );
  const runId = globalThis.crypto.randomUUID();
  const stepId = `overwrite_${path.replace(".", "_")}`;

  await kernel.run.create(
    runId,
    turnId,
    branchId,
    headNode.schemaId,
    branch.headTurnNodeHash,
    [
      {
        deterministic: false,
        id: stepId,
        sideEffects: false,
      },
    ]
  );
  await kernel.run.beginStep(runId, stepId);
  const stepResult = await kernel.run.completeStep(
    runId,
    stepId,
    await kernel.store.put(
      encodeDeterministicKernelRecord({
        turnId,
        type: `overwrite_${path.replace(".", "_")}`,
      })
    ),
    undefined,
    nextTreeHash
  );
  await kernel.run.complete(runId, "completed");

  if (stepResult.turnNodeHash === undefined) {
    throw new Error(`missing checkpointed turn node for "${stepId}"`);
  }

  await kernel.turn.updateHead(turnId, stepResult.turnNodeHash);
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function extractToolMessages(
  messages: readonly unknown[]
): Extract<TuvrenMessage, { role: "tool" }>[] {
  return messages.filter(
    (message): message is Extract<TuvrenMessage, { role: "tool" }> =>
      message !== null &&
      typeof message === "object" &&
      "role" in message &&
      message.role === "tool" &&
      "parts" in message &&
      Array.isArray(message.parts)
  );
}

export function hasAssistantText(
  messages: readonly unknown[],
  text: string
): boolean {
  return messages.some((message) => {
    if (
      message === null ||
      typeof message !== "object" ||
      !("role" in message) ||
      message.role !== "assistant" ||
      !("parts" in message) ||
      !Array.isArray(message.parts)
    ) {
      return false;
    }

    return message.parts.some(
      (part) =>
        part !== null &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        part.text === text
    );
  });
}

export function hasCountData(value: unknown): value is { count: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    "count" in value &&
    typeof value.count === "number"
  );
}

export function hasOkData(value: unknown): value is { ok: boolean } {
  return (
    value !== null &&
    typeof value === "object" &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

export function extractSingleUserText(message: TuvrenMessage | null): string {
  if (message === null || message.role !== "user") {
    throw new Error("expected a captured user handoff message");
  }

  const firstPart = message.parts[0];

  if (firstPart?.type !== "text") {
    throw new Error("expected the captured handoff message to start with text");
  }

  return firstPart.text;
}

export function requireStoredHandoffMessage(
  message: TuvrenMessage | null
): TuvrenMessage {
  if (message === null) {
    throw new Error("expected the handoff builder to store a user message");
  }

  return message;
}

export function extractLastMessageHash(manifest: {
  messages?: unknown;
}): string | undefined {
  return Array.isArray(manifest.messages)
    ? manifest.messages.findLast(
        (hash): hash is string => typeof hash === "string"
      )
    : undefined;
}

export async function readBranchContextManifest(
  kernel: KrakenKernel,
  branchId: string
): Promise<ContextManifest> {
  const branch = await kernel.branch.get(branchId);

  if (branch === null) {
    throw new Error(`expected branch "${branchId}" to exist`);
  }

  const turnNode = await kernel.node.get(branch.headTurnNodeHash);

  if (turnNode === null) {
    throw new Error(
      `expected branch "${branchId}" head turn node "${branch.headTurnNodeHash}" to exist`
    );
  }

  const manifestHash = await kernel.tree.resolve(
    turnNode.turnTreeHash,
    "context.manifest"
  );

  if (manifestHash === null || Array.isArray(manifestHash)) {
    throw new Error(
      `expected branch "${branchId}" to have a context manifest hash`
    );
  }

  const manifestRecord = await kernel.store.get(manifestHash);

  if (manifestRecord === null) {
    throw new Error(`expected context manifest "${manifestHash}" to exist`);
  }

  const manifest = decodeDeterministicKernelRecord(manifestRecord);
  assertContextManifest(manifest, `manifest "${manifestHash}"`);
  return manifest;
}

export function extractTurnId(
  events: Array<{ type: string; turnId?: string }>
): string {
  for (const event of events) {
    if (event.type === "turn.start" && typeof event.turnId === "string") {
      return event.turnId;
    }
  }

  throw new Error("turn.start event was not observed");
}

export function readQueryInput(input: unknown): string {
  if (
    input !== null &&
    typeof input === "object" &&
    "query" in input &&
    typeof input.query === "string"
  ) {
    return input.query;
  }

  throw new Error("tool input did not contain a query string");
}

export function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    throw new Error("expected an abort signal");
  }

  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function textSignal(text: string): InputSignal {
  return {
    parts: [{ text, type: "text" }],
  };
}
