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

import type { DriverRuntimePort } from "@tuvren/core/driver";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import { assertTuvrenStreamEvent } from "@tuvren/core/events";
import type {
  ProviderStreamChunk,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/provider-api";
import {
  executeGenerateCall,
  executeStreamCall,
  flushBufferedAssistantSequences,
} from "../src/lib/react-driver-stream.ts";

const SAMPLE_COUNT = 5;
const WARMUP_ITERATIONS = 10;
const bunRuntime = globalThis as typeof globalThis & {
  Bun: { nanoseconds(): number };
};
const PROMPT_FIXTURE: TuvrenPrompt = {
  messages: [
    {
      parts: [{ text: "Benchmark the stream path.", type: "text" }],
      role: "user",
    },
  ],
  tools: [
    {
      description: "Search documentation",
      inputSchema: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      name: "search",
    },
  ],
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
}

const cases: BenchmarkCase[] = [
  {
    iterations: 220,
    name: "react stream publication with shared-core clone simulation",
    async run(iterations) {
      for (let index = 0; index < iterations; index += 1) {
        const runtime = createRuntimePort();
        await executeStreamCall({
          now,
          prompt: PROMPT_FIXTURE,
          provider: createStreamingProvider(80),
          runtime,
        });
      }
    },
  },
  {
    iterations: 800,
    name: "react generate buffered flush with shared-core clone simulation",
    async run(iterations) {
      const provider = createGenerateProvider();

      for (let index = 0; index < iterations; index += 1) {
        const runtime = createRuntimePort();
        const sequence = await executeGenerateCall({
          now,
          prompt: PROMPT_FIXTURE,
          provider,
        });
        await flushBufferedAssistantSequences([sequence], runtime);
      }
    },
  },
];

await main();

async function main(): Promise<void> {
  process.stdout.write("react driver stream benchmark\n");

  for (const benchmarkCase of cases) {
    const result = await measure(benchmarkCase);
    process.stdout.write(
      `${result.name}: best ${formatNs(result.bestNs)} total, ${formatNs(
        result.bestNs / result.iterations
      )}/iter; avg ${formatNs(result.averageNs)} total\n`
    );
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
  };
}

function createRuntimePort(): DriverRuntimePort {
  const events: TuvrenStreamEvent[] = [];

  return {
    emit(event) {
      const clonedEvent = structuredClone(event);
      assertTuvrenStreamEvent(clonedEvent, "stream event");
      events.push(clonedEvent);
    },
    now,
  };
}

function createStreamingProvider(chunkCount: number): TuvrenProvider {
  return {
    generate() {
      return Promise.reject(
        new Error("generate should not be called by stream benchmark")
      );
    },
    id: "bench-provider",
    async *stream() {
      await Promise.resolve();

      for (let index = 0; index < chunkCount; index += 1) {
        yield {
          text: `chunk-${index}-`,
          type: "text_delta",
        } satisfies ProviderStreamChunk;
      }

      yield {
        finishReason: "stop",
        providerMetadata: {
          traceId: "bench-trace",
        },
        type: "finish",
        usage: {
          inputTokens: 10,
          outputTokens: chunkCount,
        },
      } satisfies ProviderStreamChunk;
    },
  };
}

function createGenerateProvider(): TuvrenProvider {
  const response: TuvrenModelResponse = {
    finishReason: "stop",
    parts: [
      {
        text: "Buffered response body",
        type: "text",
      },
      {
        data: {
          items: Array.from({ length: 16 }, (_, index) => ({
            index,
            value: `value-${index}`,
          })),
        },
        name: "bench_data",
        type: "structured",
      },
    ],
  };

  return {
    generate() {
      return Promise.resolve(response);
    },
    id: "bench-provider",
    async *stream() {
      await Promise.resolve();
      yield* [];
    },
  };
}

function now(): number {
  return 1;
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
