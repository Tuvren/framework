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
import {
  RuntimeExecutionHandle,
  type RuntimeExecutionHandleRuntime,
} from "../src/lib/runtime-execution-handle.ts";
import type { ExecutionSessionRequest } from "../src/lib/runtime-execution-types.ts";
import type {
  ExecutableToolCall,
  ToolBatchEnvironment,
} from "../src/lib/tool-execution.ts";
import {
  createAroundToolContext,
  createToolExecutionContext,
} from "../src/lib/tool-execution-helpers.ts";

const SAMPLE_COUNT = 5;
const WARMUP_ITERATIONS = 25;
const FIXTURE_HASH = "a".repeat(64) as HashString;
const bunRuntime = globalThis as typeof globalThis & {
  Bun: { nanoseconds(): number };
};

interface BenchmarkCase {
  iterations: number;
  name: string;
  run(iterations: number): Promise<void> | void;
}

interface BenchmarkResult {
  averageNs: number;
  bestNs: number;
  iterations: number;
  name: string;
  samples: number[];
}

const streamEventFixture = createStructuredStreamEvent(24);
const messagesFixture = createMessages(80);
const extensionStateFixture = createExtensionState(6, 48);
const manifestFixture = createContextManifest(
  messagesFixture,
  extensionStateFixture
);
const extensionFixture = createExtensions(6);
const toolFixture = createToolDefinition();
const toolCallFixture = createToolCall();
const toolRegistryFixture = createToolRegistry([toolFixture], extensionFixture);
const toolEnvironmentFixture = createToolEnvironment(
  manifestFixture,
  extensionFixture,
  toolRegistryFixture
);
const sharedExportsFixture = buildSharedExports(
  extensionFixture,
  manifestFixture
);

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
    run(iterations) {
      return runExecutionHandleEventQueueBench(iterations);
    },
  },
  {
    iterations: 3000,
    name: "subtree queue forwarding to four queues",
    run(iterations) {
      return runSubtreeForwardingBench(iterations, 4);
    },
  },
  {
    iterations: 700,
    name: "extension beforeIteration context snapshots",
    async run(iterations) {
      for (let index = 0; index < iterations; index += 1) {
        await runBeforeIterationHooks({
          emit() {
            return undefined;
          },
          extensions: extensionFixture,
          iterationCount: index,
          manifest: manifestFixture,
          messages: messagesFixture,
          runId: "run-bench",
          turnId: "turn-bench",
        });
      }
    },
  },
  {
    iterations: 700,
    name: "extension afterIteration context snapshots",
    async run(iterations) {
      const resolution: RuntimeResolution = {
        type: "continue_iteration",
      };

      for (let index = 0; index < iterations; index += 1) {
        await runAfterIterationHooks({
          emit() {
            return undefined;
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
      }
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
          undefined
        );
        createAroundToolContext(
          executable,
          "ext0",
          toolEnvironmentFixture,
          sharedExportsFixture,
          undefined
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
    name: "driver immutable snapshot creation",
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

const benchmarkExecutionHandleRuntime: RuntimeExecutionHandleRuntime = {
  cancelPausedExecution() {
    return undefined;
  },
  createResumedExecutionHandle() {
    throw new Error("resume is not used by the event queue benchmark");
  },
  startExecution() {
    return Promise.resolve();
  },
};

await main();

async function main(): Promise<void> {
  process.stdout.write("runtime-core boundary benchmark\n");

  for (const benchmarkCase of cases) {
    const result = await measure(benchmarkCase);
    writeResult(result);
  }
}

async function measure(benchmarkCase: BenchmarkCase): Promise<BenchmarkResult> {
  await benchmarkCase.run(
    Math.min(WARMUP_ITERATIONS, benchmarkCase.iterations)
  );

  const samples: number[] = [];

  for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
    const startedAt = nanoseconds();
    await benchmarkCase.run(benchmarkCase.iterations);
    samples.push(nanoseconds() - startedAt);
  }

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
}

function writeResult(result: BenchmarkResult): void {
  process.stdout.write(
    `${result.name}: best ${formatNs(result.bestNs)} total, ${formatNs(
      result.bestNs / result.iterations
    )}/iter; avg ${formatNs(result.averageNs)} total\n`
  );
}

async function runExecutionHandleEventQueueBench(
  iterations: number
): Promise<void> {
  const handle = new RuntimeExecutionHandle(
    benchmarkExecutionHandleRuntime,
    createBenchmarkExecutionRequest(),
    "turn-bench",
    "schema-bench"
  );
  const iterator = handle.events()[Symbol.asyncIterator]();

  for (let index = 0; index < iterations; index += 1) {
    const nextEvent = iterator.next();
    handle.publish(streamEventFixture);
    await nextEvent;
  }

  handle.finish();
  await iterator.return?.();
}

async function runSubtreeForwardingBench(
  iterations: number,
  queueCount: number
): Promise<void> {
  const queues = Array.from(
    { length: queueCount },
    () => new AsyncEventQueue<TuvrenStreamEvent>()
  );
  const iterators = queues.map((queue) => queue[Symbol.asyncIterator]());

  for (let index = 0; index < iterations; index += 1) {
    const nextEvents = iterators.map((iterator) => iterator.next());

    for (const queue of queues) {
      queue.push(cloneValue(streamEventFixture));
    }

    await Promise.all(nextEvents);
  }

  for (const queue of queues) {
    queue.close();
  }
}

function createBenchmarkExecutionRequest(): ExecutionSessionRequest {
  return {
    branchId: "branch-bench",
    config: {
      name: "agent",
    },
    signal: {
      parts: [{ text: "benchmark", type: "text" }],
    },
    threadId: "thread-bench",
  };
}

function createStructuredStreamEvent(payloadSize: number): TuvrenStreamEvent {
  return {
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
  };
}

function createMessages(count: number): TuvrenMessage[] {
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
}

function createUserMessage(text: string): TuvrenMessage {
  return {
    parts: [
      {
        text,
        type: "text",
      },
    ],
    role: "user",
  };
}

function createExtensionState(
  extensionCount: number,
  keysPerExtension: number
): Record<string, unknown> {
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
}

function createExtensions(count: number): TuvrenExtension[] {
  const extensions: TuvrenExtension[] = [];

  for (let index = 0; index < count; index += 1) {
    extensions.push({
      afterIteration(context) {
        context.sharedExports.ext0?.key0;
        return {
          state: {
            lastIteration: context.iterationCount,
          },
        };
      },
      beforeIteration(context) {
        context.sharedExports.ext0?.key0;
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
}

function createToolDefinition(): TuvrenToolDefinition {
  return {
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
  };
}

function createToolCall(): ToolCallPart {
  return {
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
  };
}

function createExecutableToolCall(
  tool: TuvrenToolDefinition,
  toolCall: ToolCallPart
): ExecutableToolCall {
  return {
    input: toolCall.input,
    tool,
    toolCall,
  };
}

function createToolEnvironment(
  manifest: ContextManifest,
  extensions: TuvrenExtension[],
  toolRegistry: ToolRegistry
): ToolBatchEnvironment {
  return {
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
      return undefined;
    },
    publishEvent() {
      return undefined;
    },
    reportSoftError() {
      return undefined;
    },
    runId: "run",
    stageResult(result: ToolResultPart): Promise<HashString> {
      result.callId;
      return Promise.resolve(FIXTURE_HASH);
    },
    threadId: "thread",
    toolRegistry,
    turnId: "turn",
  };
}

function formatNs(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}ms`;
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}us`;
  }

  return `${value.toFixed(0)}ns`;
}

function nanoseconds(): number {
  return bunRuntime.Bun.nanoseconds();
}
