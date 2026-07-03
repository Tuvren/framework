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

// biome-ignore-all lint/suspicious/useAwait: Test drivers intentionally match the async framework driver contract.
import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "@tuvren/core/execution";
import type {
  RuntimeRunner as KrakenRunner,
  RuntimeRunnerFactory as KrakenRunnerFactory,
  RunnerExecutionResult,
} from "@tuvren/core/runner";
import {
  createRunnerRegistry as createBaseRunnerRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  collectEvents,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("seeds extension initial state into the first turn manifest", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Extension state observed.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            beforeTurn(context) {
              context.emit({
                data: context.extensionState,
                name: "seed.beforeTurn",
              });
              return undefined;
            },
            name: "seeded",
            state: {
              seeded: true,
            },
          },
        ],
        name: "primary",
      },
      signal: textSignal("Observe extension state"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const seedEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "custom" }> =>
        event.type === "custom" && event.name === "seed.beforeTurn"
    );

    expect(seedEvent?.data).toEqual({
      seeded: true,
    });
    expect(handle.status().manifest?.extensions.seeded).toEqual({
      seeded: true,
    });
  });

  test("deep-clones nested initial extension state before first-turn seeding", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([
        {
          async execute(_context) {
            return {
              messages: [assistantText("Seeded state captured.")],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          },
          id: "fake",
          async resume() {
            throw new Error("resume was not expected");
          },
        } satisfies KrakenRunner,
      ]),
      kernel: harness.kernel,
    });
    const nestedState = {
      limits: {
        remaining: 3,
      },
    };
    const config: AgentConfig = {
      extensions: [
        {
          name: "seeded",
          state: nestedState,
        },
      ],
      name: "primary",
    };
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config,
      signal: textSignal("Seed initial state"),
      threadId: thread.threadId,
    });

    nestedState.limits.remaining = 0;

    await collectEvents(handle.events());

    expect(handle.status().manifest?.extensions.seeded).toEqual({
      limits: {
        remaining: 3,
      },
    });
  });
});

function createRunnerRegistry(
  drivers: Array<KrakenRunner | KrakenRunnerFactory> = []
) {
  return createBaseRunnerRegistry(drivers.map(wrapRunnerEntry));
}

function wrapRunnerEntry(
  entry: KrakenRunner | KrakenRunnerFactory
): KrakenRunner | KrakenRunnerFactory {
  if (isKrakenRunnerFactory(entry)) {
    return {
      create() {
        return wrapRunner(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapRunner(entry);
}

function isKrakenRunnerFactory(
  entry: KrakenRunner | KrakenRunnerFactory
): entry is KrakenRunnerFactory {
  return "create" in entry && typeof entry.create === "function";
}

function wrapRunner(driver: KrakenRunner): KrakenRunner {
  const resume = driver.resume;

  return {
    async execute(context) {
      return normalizeRunnerResult(await driver.execute(context));
    },
    id: driver.id,
    ...(resume === undefined
      ? {}
      : {
          async resume(context) {
            return normalizeRunnerResult(await resume(context));
          },
        }),
  };
}

function normalizeRunnerResult(
  result: RunnerExecutionResult
): RunnerExecutionResult {
  if (
    result.toolExecutionMode !== undefined ||
    !requestsToolExecution(result)
  ) {
    return result;
  }

  return {
    ...result,
    toolExecutionMode: "parallel",
  };
}

function requestsToolExecution(result: RunnerExecutionResult): boolean {
  return (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );
}
