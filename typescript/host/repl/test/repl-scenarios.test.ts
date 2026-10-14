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

import { expect, test } from "bun:test";

import { createReplHost, runReplScenarioMatrix } from "@tuvren/repl-host";
import type { ProviderStreamChunk } from "@tuvren/sdk";

import {
  readProjectionError,
  waitFor,
  withHead,
} from "../src/lib/repl-scenarios-support.js";

test("fixture generation retains response and part metadata", async () => {
  const host = createReplHost({
    backend: "memory",
    providerMode: "fixture",
    scenario: "metadata",
  });
  const response = await host.provider.generate({ messages: [] });

  expect(response).toEqual({
    finishReason: "stop",
    parts: [
      {
        providerMetadata: { fixture: { traceId: "fixture-trace-1" } },
        text: "Provider metadata preserved.",
        type: "text",
      },
    ],
    providerMetadata: { repl: { requestId: "fixture-request-1" } },
    usage: { inputTokens: 8, outputTokens: 5 },
  });
});

test("fixture stream preserves chunk order and terminal metadata", async () => {
  const host = createReplHost({
    backend: "memory",
    providerMode: "fixture",
    scenario: "metadata",
  });
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of host.provider.stream({ messages: [] })) {
    chunks.push(chunk);
  }

  expect(chunks).toEqual([
    { text: "Provider metadata preserved.", type: "text_delta" },
    {
      finishReason: "stop",
      providerMetadata: { repl: { requestId: "fixture-request-1" } },
      type: "finish",
      usage: { inputTokens: 8, outputTokens: 5 },
    },
  ]);
});

test("scenario matrix keeps repeated scenario order around a failed report", async () => {
  const matrix = await runReplScenarioMatrix({
    config: { backend: "memory", providerMode: "fixture" },
    scenarios: ["streaming", "reload", "streaming"],
  });

  expect(matrix.reports.map((report) => report.scenario)).toEqual([
    "streaming",
    "reload",
    "streaming",
  ]);
  expect(matrix.summary).toEqual({
    allChecksPassed: false,
    failedScenarioCount: 1,
    failedScenarios: ["reload"],
    passedScenarioCount: 2,
  });
  expect(matrix.reports.map((report) => report.status.phase)).toEqual([
    "completed",
    "completed",
    "completed",
  ]);
  const [first, , last] = matrix.reports;
  expect(first?.thread.threadId).not.toBe(last?.thread.threadId);
});

test("empty scenario matrix completes without creating reports", async () => {
  const matrix = await runReplScenarioMatrix({
    config: { backend: "memory", providerMode: "fixture" },
    scenarios: [],
  });

  expect(matrix.reports).toEqual([]);
  expect(matrix.summary).toEqual({
    allChecksPassed: true,
    failedScenarioCount: 0,
    failedScenarios: [],
    passedScenarioCount: 0,
  });
});

test("projection helpers select the latest error and active-thread checkpoint without mutation", () => {
  const thread = {
    branchId: "branch",
    headTurnNodeHash: "previous-head",
    rootTurnNodeHash: "root",
    rootTurnTreeHash: "root-tree",
    threadId: "active-thread",
  };
  const projection = {
    agui: [],
    canonical: [
      {
        error: { code: "first", message: "first failure" },
        fatal: false,
        timestamp: 0,
        type: "error",
      },
      {
        iterationCount: 1,
        source: { agent: "primary", threadId: "active-thread" },
        timestamp: 1,
        turnNodeHash: "head-one",
        type: "state.checkpoint",
      },
      {
        error: { code: "last", message: "last failure" },
        fatal: true,
        timestamp: 2,
        type: "error",
      },
      {
        iterationCount: 2,
        source: { agent: "primary", threadId: "active-thread" },
        timestamp: 3,
        turnNodeHash: "head-two",
        type: "state.checkpoint",
      },
      {
        iterationCount: 3,
        source: {
          agent: "worker",
          threadId: "child-thread",
          workerId: "child",
        },
        timestamp: 4,
        turnNodeHash: "child-head",
        type: "state.checkpoint",
      },
    ],
    sse: [],
  } satisfies Parameters<typeof readProjectionError>[0];
  const originalEvents = [...projection.canonical];

  expect(readProjectionError(projection)).toEqual({
    code: "last",
    message: "last failure",
  });
  expect(withHead(thread, projection).headTurnNodeHash).toBe("head-two");
  expect(projection.canonical).toEqual(originalEvents);
  expect(thread.headTurnNodeHash).toBe("previous-head");
});

test("condition polling retries sequentially and stops at the first successful observation", async () => {
  let observations = 0;
  await waitFor(() => {
    observations += 1;
    return observations === 3;
  });

  expect(observations).toBe(3);
});

test("condition polling preserves immediate success and timeout messages", async () => {
  await waitFor(() => true, -1);
  let failure: unknown;
  try {
    await waitFor(() => false, -1);
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : undefined).toBe(
    "timed out waiting for repl condition"
  );
});
