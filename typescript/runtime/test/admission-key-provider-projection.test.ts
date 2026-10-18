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

import { describe, expect, test } from "bun:test";

import { createMemoryBackend } from "@tuvren/backend-memory";
import type { InputSignal } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/core/provider";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createReActRunner, REACT_RUNNER_ID } from "@tuvren/runner-react";

import { createTuvrenRuntime } from "../src/index.ts";
import { createRunnerRegistry } from "./orchestration-runtime-runner-helpers.ts";
import { startEventCapture } from "./runtime-core-test-helpers.ts";

interface RecordingProvider {
  capturedPrompts: TuvrenMessage[][];
  firstRequestReceived: Promise<void>;
  provider: TuvrenProvider;
  releaseFirstRequest(): void;
}

const createRecordingProvider = (): RecordingProvider => {
  const capturedPrompts: TuvrenMessage[][] = [];
  const firstRequestReceived = Promise.withResolvers<void>();
  const firstRequestRelease = Promise.withResolvers<void>();
  let requestCount = 0;
  const provider: TuvrenProvider = {
    async generate(prompt: TuvrenPrompt) {
      capturedPrompts.push(structuredClone(prompt.messages));
      requestCount += 1;

      if (requestCount === 1) {
        firstRequestReceived.resolve();
        await firstRequestRelease.promise;
      }

      return {
        finishReason: "stop",
        parts: [
          {
            text:
              requestCount === 1
                ? "Continue after steering."
                : "Steering incorporated.",
            type: "text",
          },
        ],
      } satisfies TuvrenModelResponse;
    },
    id: "recording-provider",
    async *stream() {
      yield* [];
    },
  };

  return {
    capturedPrompts,
    firstRequestReceived: firstRequestReceived.promise,
    provider,
    releaseFirstRequest: () => firstRequestRelease.resolve(),
  };
};

const keyedSignal = (text: string, admissionKey: string): InputSignal => {
  return {
    admissionKey,
    parts: [{ text, type: "text" }],
  };
};

describe("KRT-CS008 provider request admission-key exclusion", () => {
  test("keeps keyed initial input and steering out of every ReAct provider request", async () => {
    const recordingProvider = createRecordingProvider();
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
        model: recordingProvider.provider,
        name: "primary",
      },
      signal: keyedSignal("Initial keyed input", "initial-provider-key"),
      threadId: thread.threadId,
    });
    const eventCapture = startEventCapture(handle.events());

    await recordingProvider.firstRequestReceived;
    handle.steer(keyedSignal("Keyed steering", "steering-provider-key"));
    recordingProvider.releaseFirstRequest();
    await eventCapture.done;

    expect(recordingProvider.capturedPrompts).toHaveLength(2);
    for (const promptMessages of recordingProvider.capturedPrompts) {
      for (const message of promptMessages) {
        expect("admissionKey" in message).toBe(false);
      }
    }

    const { messages } = await runtime.readBranchMessages({
      branchId: thread.branchId,
    });
    expect(
      messages.filter(
        (message) =>
          "role" in message &&
          message.role === "user" &&
          "admissionKey" in message
      )
    ).toEqual([
      {
        admissionKey: "initial-provider-key",
        parts: [{ text: "Initial keyed input", type: "text" }],
        role: "user",
      },
      {
        admissionKey: "steering-provider-key",
        parts: [{ text: "Keyed steering", type: "text" }],
        role: "user",
      },
    ]);
  });
});
