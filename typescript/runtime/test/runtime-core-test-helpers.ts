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

import type { KernelRecord } from "@tuvren/core";
import { TuvrenRuntimeError } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  AgentConfig,
  ContextManifest,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  HandoffContextPlan,
  HandoffSourceContext,
  InputSignal,
} from "@tuvren/core/execution";
import { assertContextManifest } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import { assertTuvrenMessage } from "@tuvren/core/messages";
import type { RuntimeRunner } from "@tuvren/core/runner";
import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
} from "@tuvren/kernel-protocol";
import type { RuntimeKernel } from "@tuvren/kernel-protocol";

export const collectEvents = async <T>(
  events: AsyncIterable<T>
): Promise<T[]> => {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
};

export const fromSynchronousVariadicAwaited = <
  Arguments extends unknown[],
  Value,
>(
  operation: (this: undefined, ...arguments_: Arguments) => Value
): ((...arguments_: Arguments) => Promise<Awaited<Value>>) =>
  Promise.try.bind<
    typeof Promise,
    [(this: undefined, ...arguments_: Arguments) => Value],
    Arguments,
    Promise<Awaited<Value>>
  >(Promise, operation);

export const readBranchCheckpointEventTypes = async (
  kernel: RuntimeKernel,
  branchId: string
): Promise<string[]> => {
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
};

export const toKrakenMessages = (
  messages: readonly unknown[]
): TuvrenMessage[] =>
  messages.map((message, index) => {
    assertTuvrenMessage(message, `messages[${index}]`);
    return message;
  });

export const toOptionalRecord = (
  value: unknown
): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(value));
};

const ignoreTestPromiseRejection = async (
  promise: Promise<unknown>
): Promise<void> => {
  try {
    await promise;
  } catch {
    // Detached test work intentionally discards its terminal rejection.
  }
};

const detachedTestPromises = new WeakSet<Promise<void>>();

export const detachTestPromise = (promise: Promise<unknown>): void => {
  detachedTestPromises.add(ignoreTestPromiseRejection(promise));
};

export const TIMEOUT_TOKEN = Symbol("timeout");

export const delay = async (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<null>();
  setTimeout(() => {
    resolve(null);
  }, milliseconds);
  await promise;
};

export const settleWithin = async <T>(
  promise: Promise<T>,
  timeoutMilliseconds: number
): Promise<T | typeof TIMEOUT_TOKEN> => {
  const timeout = (async (): Promise<typeof TIMEOUT_TOKEN> => {
    await delay(timeoutMilliseconds);
    return TIMEOUT_TOKEN;
  })();

  return await Promise.race<T | typeof TIMEOUT_TOKEN>([promise, timeout]);
};

const collectNextForDuration = async <T>(
  iterator: AsyncIterator<T>,
  deadline: number,
  collected: T[]
): Promise<void> => {
  if (Date.now() >= deadline) {
    return;
  }

  const nextValue = await settleWithin(iterator.next(), deadline - Date.now());

  if (nextValue === TIMEOUT_TOKEN || nextValue.done === true) {
    return;
  }

  collected.push(nextValue.value);
  await collectNextForDuration(iterator, deadline, collected);
};

export const collectEventsForDuration = async <T>(
  events: AsyncIterable<T>,
  durationMilliseconds: number
): Promise<T[]> => {
  const collected: T[] = [];
  const iterator = events[Symbol.asyncIterator]();
  const deadline = Date.now() + durationMilliseconds;

  try {
    await collectNextForDuration(iterator, deadline, collected);
  } finally {
    await iterator.return?.();
  }

  return collected;
};

export const startEventCapture = <T>(
  events: AsyncIterable<T>
): {
  done: Promise<void>;
  events: T[];
} => {
  const collected: T[] = [];

  return {
    done: (async () => {
      for await (const event of events) {
        collected.push(event);
      }
    })(),
    events: collected,
  };
};

export const collectToolResultTimeline = async (
  events: AsyncIterable<{ callId?: string; type: string }>,
  timeline: string[]
): Promise<void> => {
  for await (const event of events) {
    if (event.type === "tool.result" && typeof event.callId === "string") {
      timeline.push(`event:${event.callId}`);
    }
  }
};

export const waitForAsync = async (
  condition: () => Promise<boolean>,
  timeoutMilliseconds = 1000
): Promise<void> => {
  const startedAt = Date.now();
  const poll = async (): Promise<void> => {
    if (await condition()) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMilliseconds) {
      throw new Error("timed out waiting for condition");
    }

    await delay(5);
    await poll();
  };

  await poll();
};

export const waitFor = async (
  condition: () => boolean,
  timeoutMilliseconds = 1000
): Promise<void> => {
  await waitForAsync(
    fromSynchronousVariadicAwaited(condition),
    timeoutMilliseconds
  );
};

const awaitClosedEvents = <T>(
  closedPromise: Promise<null>
): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    return {
      async next(): Promise<IteratorResult<T>> {
        await closedPromise;
        return { done: true, value: undefined };
      },
    };
  },
});

const staticEventStream = <T>(events: readonly T[]): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    const iterator = events.values();
    return {
      next: fromSynchronousVariadicAwaited(() => iterator.next()),
    };
  },
});

export const createStubExecutionHandle = (
  initialPhase: ExecutionStatus["phase"]
): ExecutionHandle => {
  let phase = initialPhase;
  let closed = initialPhase !== "running";
  const { promise: closedPromise, resolve: resolveClosed } =
    Promise.withResolvers<null>();

  if (closed) {
    resolveClosed(null);
  }

  const handle: ExecutionHandle = {
    async awaitResult(): Promise<ExecutionResult> {
      await closedPromise;

      if (phase === "failed") {
        throw new TuvrenRuntimeError("Execution was cancelled", {
          code: "execution_cancelled",
        });
      }

      return {
        executionStatus: { iterationCount: 0, phase },
        status: "completed",
      };
    },
    cancel() {
      phase = "failed";

      if (!closed) {
        closed = true;
        resolveClosed(null);
      }
    },
    events() {
      return awaitClosedEvents(closedPromise);
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
      // The stub deliberately ignores steering input.
    },
  };

  return handle;
};

export const assistantText = (text: string): TuvrenMessage => ({
  parts: [{ text, type: "text" }],
  role: "assistant",
});

export const assistantStructured = (
  name: string,
  data: unknown
): TuvrenMessage => ({
  parts: [{ data, name, type: "structured" }],
  role: "assistant",
});

const toNonEmptyArray = <T>(values: T[]): [T, ...T[]] | undefined => {
  const [firstValue, ...remainingValues] = values;

  if (firstValue === undefined) {
    return undefined;
  }

  return [firstValue, ...remainingValues];
};

export const assistantToolCalls = (
  calls: [
    {
      callId: string;
      input: unknown;
      name: string;
    },
    ...{
      callId: string;
      input: unknown;
      name: string;
    }[],
  ]
): TuvrenMessage => {
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
};

export const buildHandoffPlan = (
  context: Parameters<RuntimeRunner["execute"]>[0],
  sourceAgent: AgentConfig,
  targetAgent: AgentConfig,
  builder: HandoffContextPlan["builder"]
): HandoffContextPlan => ({
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
});

export const createStaticExecutionHandle = (
  events: TuvrenStreamEvent[],
  status: ExecutionStatus
): ExecutionHandle => ({
  awaitResult: fromSynchronousVariadicAwaited((): ExecutionResult => {
    if (status.phase === "completed") {
      return {
        executionStatus: status,
        status: "completed",
      };
    }

    return {
      error: new TuvrenRuntimeError("Execution failed", {
        code: "execution_failed",
      }),
      executionStatus: status,
      status: "failed",
    };
  }),
  cancel() {
    // Static handles have no in-flight work to cancel.
  },
  events() {
    return staticEventStream(events);
  },
  resolveApproval() {
    throw new Error("resolveApproval was not expected");
  },
  status() {
    return status;
  },
  steer() {
    // Static handles deliberately ignore steering input.
  },
});

export const overwriteBranchSinglePath = async (
  kernel: RuntimeKernel,
  branchId: string,
  turnId: string,
  path: "context.manifest" | "runtime.status",
  value: KernelRecord
): Promise<void> => {
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
};

export const extractToolMessages = (
  messages: readonly unknown[]
): Extract<TuvrenMessage, { role: "tool" }>[] =>
  messages.filter(
    (message): message is Extract<TuvrenMessage, { role: "tool" }> =>
      message !== null &&
      typeof message === "object" &&
      "role" in message &&
      message.role === "tool" &&
      "parts" in message &&
      Array.isArray(message.parts)
  );

export const hasAssistantText = (
  messages: readonly unknown[],
  text: string
): boolean =>
  messages.some((message) => {
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

    const parts: unknown[] = message.parts;
    return parts.some(
      (part) =>
        part !== null &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        part.text === text
    );
  });

export const hasCountData = (value: unknown): value is { count: number } =>
  value !== null &&
  typeof value === "object" &&
  "count" in value &&
  typeof value.count === "number";

export const hasOkData = (value: unknown): value is { ok: boolean } =>
  value !== null &&
  typeof value === "object" &&
  "ok" in value &&
  typeof value.ok === "boolean";

export const extractSingleUserText = (
  message: TuvrenMessage | null
): string => {
  if (message === null || message.role !== "user") {
    throw new Error("expected a captured user handoff message");
  }

  const [firstPart] = message.parts;

  if (firstPart?.type !== "text") {
    throw new Error("expected the captured handoff message to start with text");
  }

  return firstPart.text;
};

export const requireStoredHandoffMessage = (
  message: TuvrenMessage | null
): TuvrenMessage => {
  if (message === null) {
    throw new Error("expected the handoff builder to store a user message");
  }

  return message;
};

export const extractLastMessageHash = (manifest: {
  messages?: unknown;
}): string | undefined =>
  Array.isArray(manifest.messages)
    ? manifest.messages.findLast(
        (hash): hash is string => typeof hash === "string"
      )
    : undefined;

export const readBranchContextManifest = async (
  kernel: RuntimeKernel,
  branchId: string
): Promise<ContextManifest> => {
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
};

export const extractTurnId = (
  events: { type: string; turnId?: string }[]
): string => {
  for (const event of events) {
    if (event.type === "turn.start" && typeof event.turnId === "string") {
      return event.turnId;
    }
  }

  throw new Error("turn.start event was not observed");
};

export const readQueryInput = (input: unknown): string => {
  if (
    input !== null &&
    typeof input === "object" &&
    "query" in input &&
    typeof input.query === "string"
  ) {
    return input.query;
  }

  throw new Error("tool input did not contain a query string");
};

export const waitForAbort = async (
  signal: AbortSignal | undefined
): Promise<void> => {
  if (signal === undefined) {
    throw new Error("expected an abort signal");
  }

  if (signal.aborted) {
    return;
  }

  const { promise, resolve } = Promise.withResolvers<null>();
  signal.addEventListener(
    "abort",
    () => {
      resolve(null);
    },
    { once: true }
  );
  await promise;
};

export const textSignal = (text: string): InputSignal => ({
  parts: [{ text, type: "text" }],
});
