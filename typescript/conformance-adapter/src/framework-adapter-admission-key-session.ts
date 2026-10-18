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

import type { RuntimeRunner } from "@tuvren/core/runner";
import { createDuplexSessionBinding } from "@tuvren/host-session";
import type { SessionSteerFrame } from "@tuvren/host-session";
import { createRunnerRegistry, createTuvrenRuntime } from "@tuvren/runtime";

import type { AdapterProjection } from "./framework-adapter-runtime.ts";
import {
  AGENT_NAME,
  assistantText,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  RUNNER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

const SESSION_ID = "sess-host-session-admission-key-1";
const INITIAL_TEXT = "Start host-session admission-key carriage";
const STEERING_TEXT = "Host-session keyed steering";
const ADMISSION_KEY = "host-session-admission-key";

function containsSteeringMessage(
  messages: Parameters<RuntimeRunner["execute"]>[0]["messages"]
): boolean {
  return messages.some(
    (message) =>
      "role" in message &&
      message.role === "user" &&
      message.parts.some(
        (part) => part.type === "text" && part.text === STEERING_TEXT
      )
  );
}

export async function runAdmissionKeySteerCarriage(): Promise<AdapterProjection> {
  const harness = createConformanceKernelHarness();
  let releaseInitialIteration: (() => void) | undefined;
  let signalInitialIterationStarted: (() => void) | undefined;
  const initialIterationStarted = new Promise<void>((resolve) => {
    signalInitialIterationStarted = resolve;
  });
  const initialIterationRelease = new Promise<void>((resolve) => {
    releaseInitialIteration = resolve;
  });
  const runner: RuntimeRunner = {
    async execute(context) {
      if (containsSteeringMessage(context.messages)) {
        return {
          messages: [assistantText("Keyed steering incorporated.")],
          resolution: { reason: "done", type: "end_turn" },
        };
      }

      signalInitialIterationStarted?.();
      await initialIterationRelease;
      return {
        messages: [assistantText("Waiting for steering.")],
        resolution: { type: "continue_iteration" },
      };
    },
    id: RUNNER_ID,
  };
  const runtime = createTuvrenRuntime({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal(INITIAL_TEXT),
    threadId: thread.threadId,
  });
  const binding = createDuplexSessionBinding(handle, { sessionId: SESSION_ID });
  const outboundPromise = collectValues(binding.outbound());

  await initialIterationStarted;
  const dispatchedFrame: SessionSteerFrame = {
    correlationId: "corr-host-session-admission-key-1",
    kind: "steer",
    protocolVersion: "1",
    sessionId: SESSION_ID,
    signal: {
      admissionKey: ADMISSION_KEY,
      parts: [{ text: STEERING_TEXT, type: "text" }],
    },
  };
  binding.dispatchInbound(dispatchedFrame);
  releaseInitialIteration?.();
  await outboundPromise;
  await handle.awaitResult();

  const { messages: committedMessages } = await runtime.readBranchMessages({
    branchId: thread.branchId,
  });
  const observation = { committedMessages, dispatchedFrame };
  return { evidence: observation, result: observation };
}
