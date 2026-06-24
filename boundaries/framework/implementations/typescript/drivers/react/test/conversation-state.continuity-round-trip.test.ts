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

// KRT-BH003 — AY005 multi-turn continuity round-trip, end to end (ADR-053).
//
// AY005 wired `TuvrenPrompt.providerContinuity` into the provider call and
// persisted a response's continuity onto the durable assistant message, but the
// round-trip was "structurally wired but not covered by a multi-turn test"
// (TechSpec changelog v0.29.3). The continuity actually round-trips through the
// durable lineage: a response's continuity is extracted into lineage, and the
// next turn's request is reconstructed from that lineage — so the continuity it
// carries can only have come from the durable DAG, never from a provider that
// held state across turns.
//
// This is the end-to-end runtime/durability proof of that round-trip: it drives
// two real turns through the runtime against a deliberately stateless provider
// and asserts the continuity survives the durable round-trip.
//
// Layering note — what this test does and does NOT prove. It exercises the
// *framework carriage* seam: the runtime hands the reconstructed prompt to a raw
// `TuvrenProvider`, one layer above the AI SDK bridge. It proves the framework
// durably carries assistant continuity metadata across a DAG-reconstructed turn
// boundary with no provider-held state. It does NOT by itself prove that any
// specific token reaches the actual provider request: the AI SDK bridge
// re-injects only allowlisted *part-level* continuity keys (e.g.
// `google.thoughtSignature`) and never message-level metadata, so the bridge
// would drop the message-level blob used here. That provider-boundary replay is
// the separate, complementary proof owned by the conversation-state conformance
// op (which uses an allowlisted part-level signature); the reconstruct-from-DAG
// proof covers structural head-state reconstruction. The Gherkin round-trip is
// satisfied by these artifacts together, each proving a distinct dimension.

import { describe, expect, test } from "bun:test";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/core/provider";
import { createDriverRegistry } from "../../../runtime/src/lib/driver-registry.ts";
import { createTuvrenRuntime as createTuvrenRuntimeCore } from "../../../runtime/src/lib/runtime-core.ts";
import { createFakeKernelHarness } from "../../../runtime/test/fake-kernel.ts";
import { createReActDriver, REACT_DRIVER_ID } from "../src/index.ts";
import { textSignal } from "./react-driver-test-helpers.ts";

// A provider-namespaced continuity token carried back on turn 1's response as
// message-level metadata — modelled on an OpenAI Responses continuation id, the
// kind of server-side-state handle ADR-053 keeps reconstructable rather than
// authoritative. From the framework's view it is an opaque blob: this test only
// asserts the runtime durably carries it into the next turn's reconstructed
// prompt. See the layering note above — this exact token would NOT be re-injected
// by the AI SDK bridge (which replays only allowlisted part-level keys), so do
// not read this as proof that `previousResponseId` reaches the provider request.
const CONTINUITY = { openai: { previousResponseId: "resp-turn-1-9f3a" } };

/**
 * A stateless recording provider. It records the prompt it is handed on every
 * call and returns a turn-1 reply whose *message-level* `providerMetadata`
 * carries a continuity token. It holds no cross-turn state of its own, so any
 * continuity seen on a later turn must have come from the durable lineage.
 */
function createRecordingProvider(): {
  capturedPrompts: TuvrenMessage[][];
  provider: TuvrenProvider;
} {
  const capturedPrompts: TuvrenMessage[][] = [];
  let call = 0;
  const provider: TuvrenProvider = {
    async generate(prompt: TuvrenPrompt) {
      capturedPrompts.push(structuredClone(prompt.messages));
      call += 1;
      if (call === 1) {
        return {
          finishReason: "stop",
          parts: [{ text: "first answer", type: "text" }],
          providerMetadata: structuredClone(CONTINUITY),
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

function lastAssistantContinuity(
  messages: TuvrenMessage[]
): Record<string, unknown> | undefined {
  const assistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  return assistant && "providerMetadata" in assistant
    ? assistant.providerMetadata
    : undefined;
}

describe("KRT-BH003 multi-turn continuity round-trip", () => {
  test("a response's continuity is extracted into lineage and re-injected into the next turn's request, with no provider-held state", async () => {
    const { capturedPrompts, provider } = createRecordingProvider();
    const runtime = buildRuntime(provider);
    const thread = await runtime.runtime.createThread({});
    const ids = { branchId: thread.branchId, threadId: thread.threadId };

    // Turn 1 — the provider returns a reply carrying a continuity token.
    await runTurn(runtime, ids, "first question");

    // (1) Extracted into lineage: the continuity token was persisted onto the
    // durable assistant message, readable purely from the DAG.
    const durableAfterTurn1 = (await runtime.harness.readBranchMessages(
      ids.branchId
    )) as TuvrenMessage[];
    expect(lastAssistantContinuity(durableAfterTurn1)).toEqual(CONTINUITY);

    // Turn 2 — same branch; head-state is rebuilt from the DAG.
    await runTurn(runtime, ids, "second question");

    expect(capturedPrompts).toHaveLength(2);
    const secondRequest = capturedPrompts[1];
    if (secondRequest === undefined) {
      throw new Error("expected a second provider request");
    }

    // (2) Re-injected into the next request: turn 2's reconstructed request
    // carries the prior turn's continuity-bearing assistant message.
    expect(lastAssistantContinuity(secondRequest)).toEqual(CONTINUITY);

    // (3) No provider-held state: the continuity in turn 2's request is exactly
    // what the durable lineage yields — the DAG, not a provider session, carried
    // it forward.
    expect(lastAssistantContinuity(secondRequest)).toEqual(
      lastAssistantContinuity(durableAfterTurn1)
    );
  });
});
