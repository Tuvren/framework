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

import type { HashString } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import { assertTuvrenStreamEvent } from "@tuvren/core/events";
import type {
  ContextManifest,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type {
  ToolCallPart,
  ToolResultPart,
  TuvrenMessage,
} from "@tuvren/core/messages";
import type { ToolRegistry, TuvrenToolDefinition } from "@tuvren/core/tools";

import {
  createContextManifest,
  createToolRegistry,
  runAfterIterationHooks,
  runBeforeIterationHooks,
  updateContextManifest,
} from "../src/index.ts";
import { buildSharedExports } from "../src/lib/extension-runtime.ts";
import {
  AsyncEventQueue,
  cloneValue,
  createFrozenSnapshot,
} from "../src/lib/runtime-core-shared.ts";
import { RuntimeExecutionHandle } from "../src/lib/runtime-execution-handle.ts";
import type { RuntimeExecutionHandleRuntime } from "../src/lib/runtime-execution-handle.ts";
import type { ExecutionSessionRequest } from "../src/lib/runtime-execution-types.ts";
import {
  createAroundToolContext,
  createToolExecutionContext,
} from "../src/lib/tool-execution-helpers.ts";
import type {
  ExecutableToolCall,
  ToolBatchEnvironment,
} from "../src/lib/tool-execution.ts";

const SAMPLE_COUNT = 5;
const WARMUP_ITERATIONS = 25;
const FIXTURE_HASH = "a".repeat(64);
const FIXTURE_HASH_PROMISE = Promise.resolve(FIXTURE_HASH);
const STARTED_PROMISE = Promise.resolve();
const bunRuntime = globalThis as typeof globalThis & {
  Bun: { nanoseconds: () => number };
};

interface BenchmarkCase {
  iterations: number;
  name: string;
  run: (iterations: number) => Promise<void> | void;
}

interface BenchmarkResult {
  averageNs: number;
  bestNs: number;
  iterations: number;
  name: string;
  samples: number[];
}

const createStructuredStreamEvent = (
  payloadSize: number
): TuvrenStreamEvent => ({
  data: {
    items: Array.from({ length: payloadSize }, (_, index) => ({
      index,
      label: `payload-${index}`,
      nested: {
        even: index % 2 === 0,
        values: [index, index + 1, index + 2],
      },
    })),
  },
  messageId: "message-bench",
  name: "bench_payload",
  timestamp: 1,
  type: "structured.done",
});

const streamEventFixture = createStructuredStreamEvent(24);

const createUserMessage = (text: string): TuvrenMessage => ({
  parts: [
    {
      text,
      type: "text",
    },
  ],
  role: "user",
});

const createMessages = (count: number): TuvrenMessage[] => {
  const messages: TuvrenMessage[] = [];

  for (let index = 0; index < count; index += 1) {
    messages.push(
      index % 2 === 0
        ? createUserMessage(`user request ${index}`)
        : {
            parts: [
              {
                text: `assistant answer ${index}`,
                type: "text",
              },
            ],
            role: "assistant",
          }
    );
  }

  return messages;
};
const messagesFixture = createMessages(80);

const createExtensionState = (
  extensionCount: number,
  keysPerExtension: number
): Record<string, unknown> => {
  const state: Record<string, unknown> = {};

  for (
    let extensionIndex = 0;
    extensionIndex < extensionCount;
    extensionIndex += 1
  ) {
    const namespace: Record<string, unknown> = {};

    for (let keyIndex = 0; keyIndex < keysPerExtension; keyIndex += 1) {
      namespace[`key${keyIndex}`] = {
        enabled: keyIndex % 2 === 0,
        value: `ext-${extensionIndex}-value-${keyIndex}`,
      };
    }

    state[`ext${extensionIndex}`] = namespace;
  }

  return state;
};
const extensionStateFixture = createExtensionState(6, 48);
const manifestFixture = createContextManifest(
  messagesFixture,
  extensionStateFixture
);

const createExtensions = (count: number): TuvrenExtension[] => {
  const extensions: TuvrenExtension[] = [];

  for (let index = 0; index < count; index += 1) {
    extensions.push({
      afterIteration(context) {
        Boolean(context.sharedExports.ext0?.key0);
        return {
          state: {
            lastIteration: context.iterationCount,
          },
        };
      },
      beforeIteration(context) {
        Boolean(context.sharedExports.ext0?.key0);
        return {
          state: {
            lastIteration: context.iterationCount,
          },
        };
      },
      exports: ["key0", "key1", "key2", "key3"],
      name: `ext${index}`,
    });
  }

  return extensions;
};
const extensionFixture = createExtensions(6);

const createToolDefinition = (): TuvrenToolDefinition => ({
  description: "Benchmark tool",
  execute(_input, _context) {
    return {
      ok: true,
    };
  },
  inputSchema: {
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
    type: "object",
  },
  metadata: {
    labels: Array.from({ length: 24 }, (_, index) => `label-${index}`),
    nested: {
      owner: "bench",
      priority: 1,
    },
  },
  name: "bench_tool",
});
const toolFixture = createToolDefinition();

const createToolCall = (): ToolCallPart => ({
  callId: "call-bench",
  input: {
    filters: Array.from({ length: 16 }, (_, index) => ({
      field: `field-${index}`,
      value: `value-${index}`,
    })),
    query: "benchmark",
  },
  name: "bench_tool",
  type: "tool_call",
});
const toolCallFixture = createToolCall();
const toolRegistryFixture = createToolRegistry([toolFixture], extensionFixture);

const createToolEnvironment = (
  manifest: ContextManifest,
  extensions: TuvrenExtension[],
  toolRegistry: ToolRegistry
): ToolBatchEnvironment => ({
  activeAgent: "agent",
  branchId: "branch",
  extensions,
  iterationCount: 3,
  manifest,
  maxParallelToolCalls: 10,
  now() {
    return 1;
  },
  publishCustom() {
    // Intentionally discard benchmark emissions.
  },
  publishEvent() {
    // Intentionally discard benchmark emissions.
  },
  reportSoftError() {
    // Intentionally discard benchmark soft errors.
  },
  runId: "run",
  async stageResult(result: ToolResultPart): Promise<HashString> {
    if (result.callId.length === 0) {
      throw new Error("benchmark tool results require a call id");
    }
    return await FIXTURE_HASH_PROMISE;
  },
  threadId: "thread",
  toolRegistry,
  turnId: "turn",
});
const toolEnvironmentFixture = createToolEnvironment(
  manifestFixture,
  extensionFixture,
  toolRegistryFixture
);
const sharedExportsFixture = buildSharedExports(
  extensionFixture,
  manifestFixture
);

const createBenchmarkExecutionRequest = (): ExecutionSessionRequest => ({
  branchId: "branch-bench",
  config: {
    name: "agent",
  },
  signal: {
    parts: [{ text: "benchmark", type: "text" }],
  },
  threadId: "thread-bench",
});

const benchmarkExecutionHandleRuntime: RuntimeExecutionHandleRuntime = {
  cancelPausedExecution() {
    // The event-queue benchmark never enters a paused execution.
  },
  createResumedExecutionHandle() {
    throw new Error("resume is not used by the event queue benchmark");
  },
  async startExecution() {
    await STARTED_PROMISE;
  },
};

const runSequentially = async (
  iterations: number,
  action: (index: number) => Promise<void>
): Promise<void> => {
  let index = 0;
  const actions = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<undefined>> {
          if (index >= iterations) {
            return { done: true, value: undefined };
          }

          await action(index);
          index += 1;
          return { done: false, value: undefined };
        },
      };
    },
  };

  for await (const _ of actions) {
    // Each next() awaits one action before producing the next iteration.
  }
};

const runExecutionHandleEventQueueBench = async (
  iterations: number
): Promise<void> => {
  const handle = new RuntimeExecutionHandle(
    benchmarkExecutionHandleRuntime,
    createBenchmarkExecutionRequest(),
    "turn-bench",
    "schema-bench"
  );
  const iterator = handle.events()[Symbol.asyncIterator]();

  await runSequentially(iterations, async () => {
    const nextEvent = iterator.next();
    handle.publish(streamEventFixture);
    await nextEvent;
  });

  handle.finish();
  await iterator.return?.();
};

const runSubtreeForwardingBench = async (
  iterations: number,
  queueCount: number
): Promise<void> => {
  const queues = Array.from(
    { length: queueCount },
    () => new AsyncEventQueue<TuvrenStreamEvent>()
  );
  const iterators = queues.map((queue) => queue[Symbol.asyncIterator]());

  await runSequentially(iterations, async () => {
    const nextEvents: Promise<IteratorResult<TuvrenStreamEvent>>[] = [];
    for (const iterator of iterators) {
      nextEvents.push(iterator.next());
    }

    for (const queue of queues) {
      queue.push(cloneValue(streamEventFixture));
    }

    await Promise.all(nextEvents);
  });

  for (const queue of queues) {
    queue.close();
  }
};

const createExecutableToolCall = (
  tool: TuvrenToolDefinition,
  toolCall: ToolCallPart
): ExecutableToolCall => ({
  input: toolCall.input,
  tool,
  toolCall,
});

const cases: BenchmarkCase[] = [
  {
    iterations: 20_000,
    name: "stream boundary clone and validation",
    run(iterations) {
      for (let index = 0; index < iterations; index += 1) {
        const clonedEvent = structuredClone(streamEventFixture);
        assertTuvrenStreamEvent(clonedEvent, "stream event");
      }
    },
  },
  {
    iterations: 3000,
    name: "execution handle single-consumer event queue",
    async run(iterations) {
      await runExecutionHandleEventQueueBench(iterations);
    },
  },
  {
    iterations: 3000,
    name: "subtree queue forwarding to four queues",
    async run(iterations) {
      await runSubtreeForwardingBench(iterations, 4);
    },
  },
  {
    iterations: 700,
    name: "extension beforeIteration context snapshots",
    async run(iterations) {
      await runSequentially(iterations, async (index) => {
        await runBeforeIterationHooks({
          emit() {
            // Intentionally discard benchmark hook emissions.
          },
          extensions: extensionFixture,
          iterationCount: index,
          manifest: manifestFixture,
          messages: messagesFixture,
          runId: "run-bench",
          turnId: "turn-bench",
        });
      });
    },
  },
  {
    iterations: 700,
    name: "extension afterIteration context snapshots",
    async run(iterations) {
      const resolution: RuntimeResolution = {
        type: "continue_iteration",
      };

      await runSequentially(iterations, async (index) => {
        await runAfterIterationHooks({
          emit() {
            // Intentionally discard benchmark hook emissions.
          },
          extensions: extensionFixture,
          iterationCount: index,
          manifest: manifestFixture,
          messages: messagesFixture,
          resolution,
          response: {
            finishReason: "stop",
            parts: [{ text: "bench response", type: "text" }],
          },
          runId: "run-bench",
          turnId: "turn-bench",
        });
      });
    },
  },
  {
    iterations: 4000,
    name: "tool execution and around-tool context snapshots",
    run(iterations) {
      const executable = createExecutableToolCall(toolFixture, toolCallFixture);

      for (let index = 0; index < iterations; index += 1) {
        createToolExecutionContext(
          toolCallFixture,
          toolFixture,
          toolEnvironmentFixture,
          toolEnvironmentFixture.signal
        );
        createAroundToolContext(
          executable,
          "ext0",
          toolEnvironmentFixture,
          sharedExportsFixture,
          toolEnvironmentFixture.signal
        );
      }
    },
  },
  {
    iterations: 3000,
    name: "manifest append-only incremental updates",
    run(iterations) {
      let manifest = createContextManifest([], extensionStateFixture);

      for (let index = 0; index < iterations; index += 1) {
        manifest = updateContextManifest(manifest, [
          createUserMessage(`message-${index}`),
        ]);
      }
    },
  },
  {
    iterations: 2000,
    name: "manifest extension state merge updates",
    run(iterations) {
      let manifest = createContextManifest(
        messagesFixture,
        extensionStateFixture
      );

      for (let index = 0; index < iterations; index += 1) {
        manifest = updateContextManifest(
          manifest,
          [],
          [
            {
              extensionName: "ext0",
              state: {
                counter: index,
                nested: {
                  value: `updated-${index}`,
                },
              },
            },
          ]
        );
      }
    },
  },
  {
    iterations: 500,
    name: "runner immutable snapshot creation",
    run(iterations) {
      for (let index = 0; index < iterations; index += 1) {
        createFrozenSnapshot({
          config: {
            extensions: extensionFixture,
            name: "agent",
            tools: [toolFixture],
          },
          manifest: manifestFixture,
          messages: messagesFixture,
        });
      }
    },
  },
];

const nanoseconds = (): number => bunRuntime.Bun.nanoseconds();

const measure = async (
  benchmarkCase: BenchmarkCase
): Promise<BenchmarkResult> => {
  await benchmarkCase.run(
    Math.min(WARMUP_ITERATIONS, benchmarkCase.iterations)
  );

  const samples: number[] = [];

  await runSequentially(SAMPLE_COUNT, async () => {
    const startedAt = nanoseconds();
    await benchmarkCase.run(benchmarkCase.iterations);
    samples.push(nanoseconds() - startedAt);
  });

  const bestNs = Math.min(...samples);
  const averageNs =
    samples.reduce((total, sample) => total + sample, 0) / samples.length;

  return {
    averageNs,
    bestNs,
    iterations: benchmarkCase.iterations,
    name: benchmarkCase.name,
    samples,
  };
};

const formatNs = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}ms`;
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}us`;
  }

  return `${value.toFixed(0)}ns`;
};

const writeResult = (result: BenchmarkResult): void => {
  process.stdout.write(
    `${result.name}: best ${formatNs(result.bestNs)} total, ${formatNs(
      result.bestNs / result.iterations
    )}/iter; avg ${formatNs(result.averageNs)} total\n`
  );
};

const main = async (): Promise<void> => {
  process.stdout.write("runtime-core boundary benchmark\n");

  await runSequentially(cases.length, async (index) => {
    const benchmarkCase = cases[index];
    if (benchmarkCase === undefined) {
      return;
    }
    const result = await measure(benchmarkCase);
    writeResult(result);
  });
};

await main();
