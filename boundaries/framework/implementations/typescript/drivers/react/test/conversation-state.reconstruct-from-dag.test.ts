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

// biome-ignore-all lint/suspicious/useAwait: Mock async provider interfaces intentionally preserve promise-based signatures.

// KRT-BH002 — Reconstruct-from-DAG proof (ADR-053).
//
// ADR-053 makes the durable lineage the unconditional source of truth: the
// provider request for the next turn must be reconstructable from durable
// lineage alone, never depending on any provider-held server-side state. This
// test drives the real ReAct driver through the runtime for two turns against a
// deliberately *stateless* provider that records the prompt it is handed. The
// provider keeps nothing between turns, so the only way the second turn's
// request can carry the first turn's continuity artifact is by reconstructing it
// from the durable DAG.

import { describe, expect, test } from "bun:test";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  TuvrenModelResponse,
  TuvrenProvider,
} from "@tuvren/core/provider";
import { createDriverRegistry } from "../../../runtime/src/lib/driver-registry.ts";
import { createTuvrenRuntime as createTuvrenRuntimeCore } from "../../../runtime/src/lib/runtime-core.ts";
import { createFakeKernelHarness } from "../../../runtime/test/fake-kernel.ts";
import { createReActDriver, REACT_DRIVER_ID } from "../src/index.ts";
import { textSignal } from "./react-driver-test-helpers.ts";

// A provider-namespaced continuity artifact carried back on the first turn's
// assistant message (e.g. a Google thought signature / response continuation).
const CONTINUITY = "thought-signature-turn-1-abc";

/**
 * A stateless recording provider. It records the messages handed to it on every
 * call and returns a first-turn assistant reply carrying a continuity artifact
 * in `providerMetadata`. It holds no cross-turn session state of its own.
 */
function createRecordingProvider(): {
  capturedPrompts: TuvrenMessage[][];
  provider: TuvrenProvider;
} {
  const capturedPrompts: TuvrenMessage[][] = [];
  let call = 0;
  const provider: TuvrenProvider = {
    async generate(prompt) {
      capturedPrompts.push(structuredClone(prompt.messages));
      call += 1;
      if (call === 1) {
        return {
          finishReason: "stop",
          parts: [
            {
              providerMetadata: { google: { thoughtSignature: CONTINUITY } },
              text: "first answer",
              type: "text",
            },
          ],
          providerMetadata: { google: { thoughtSignature: CONTINUITY } },
        } satisfies TuvrenModelResponse;
      }
      return {
        finishReason: "stop",
        parts: [{ text: "second answer", type: "text" }],
      } satisfies TuvrenModelResponse;
    },
    id: "recording-provider",
    async *stream() {
      yield* [];
    },
  };
  return { capturedPrompts, provider };
}

function buildRuntime(provider: TuvrenProvider) {
  const harness = createFakeKernelHarness();
  const runtime = createTuvrenRuntimeCore({
    defaultDriverId: REACT_DRIVER_ID,
    driverRegistry: createDriverRegistry([
      createReActDriver({ providerCallMode: "generate" }),
    ]),
    kernel: harness.kernel,
  });
  return { harness, provider, runtime };
}

async function runTurn(
  runtime: ReturnType<typeof buildRuntime>,
  ids: { branchId: string; threadId: string },
  text: string
): Promise<void> {
  const handle = runtime.runtime.executeTurn({
    branchId: ids.branchId,
    config: { model: runtime.provider, name: "primary" },
    signal: textSignal(text),
    threadId: ids.threadId,
  });
  const result = await handle.awaitResult();
  expect(result.status).toBe("completed");
}

function assistantContinuity(messages: TuvrenMessage[]): unknown {
  const assistant = messages.find((message) => message.role === "assistant");
  const firstPart = assistant?.parts[0];
  return firstPart && "providerMetadata" in firstPart
    ? firstPart.providerMetadata
    : undefined;
}

describe("KRT-BH002 reconstruct-from-DAG", () => {
  test("the next turn's provider request is reconstructed from durable lineage carrying the prior continuity, with no provider-held state", async () => {
    const { capturedPrompts, provider } = createRecordingProvider();
    const runtime = buildRuntime(provider);
    const thread = await runtime.runtime.createThread({});
    const ids = { branchId: thread.branchId, threadId: thread.threadId };

    // Turn 1 — the provider returns an assistant reply carrying continuity.
    await runTurn(runtime, ids, "first question");

    // The durable lineage after turn 1, read back purely from the DAG.
    const durableAfterTurn1 = (await runtime.harness.readBranchMessages(
      ids.branchId
    )) as TuvrenMessage[];
    expect(durableAfterTurn1).toHaveLength(2);
    expect(durableAfterTurn1[0]?.role).toBe("user");
    expect(durableAfterTurn1[1]?.role).toBe("assistant");
    // The continuity artifact was persisted onto the durable assistant message.
    expect(JSON.stringify(durableAfterTurn1)).toContain(CONTINUITY);

    // Turn 2 — same branch. The runtime rebuilds head-state from the DAG and
    // hands the ReAct driver/provider the reconstructed history.
    await runTurn(runtime, ids, "second question");

    // The provider was called twice; the second call's prompt is what the
    // Provider Gateway built for the next turn.
    expect(capturedPrompts).toHaveLength(2);
    const secondRequest = capturedPrompts[1];
    if (secondRequest === undefined) {
      throw new Error("expected a second provider request");
    }

    // (1) Reconstructed from durable lineage: the second request's leading
    // history is exactly the durable reconstruction after turn 1 (user +
    // continuity-bearing assistant), not anything the provider retained.
    expect(secondRequest.slice(0, durableAfterTurn1.length)).toEqual(
      durableAfterTurn1
    );

    // (2) The carried continuity rode through the DAG into the next request.
    expect(JSON.stringify(secondRequest)).toContain(CONTINUITY);
    expect(assistantContinuity(secondRequest)).toEqual(
      assistantContinuity(durableAfterTurn1)
    );

    // (3) No provider-held state: the continuity in the next request is
    // identical to what the DAG yields, so the durable lineage — not a provider
    // session — is what carried it forward.
    expect(assistantContinuity(secondRequest)).toEqual({
      google: { thoughtSignature: CONTINUITY },
    });
  });
});
