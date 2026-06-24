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

// KRT-BH004 — provider-side caching is correctness-neutral (ADR-053).
//
// ADR-053: provider-side caching is a cost/latency optimization, never a
// correctness dependency. A provider cache miss and a cache hit for the same
// turn must yield the same outcome; only the reported cost may differ.
//
// This is the durable-lineage proof. It runs the same turn twice against a
// provider that returns byte-identical produced content but reports materially
// different usage — a cold cache miss (every input token billed) versus a warm
// hit (most input served from cache, far cheaper). It then shows that:
//   1. the reconstructed request handed to the provider is identical;
//   2. the kernel content-addresses both runs' durable assistant message to the
//      SAME canonical hash (the deterministic-CBOR message hash in the turn-tree
//      manifest), so the durable lineage is invariant to the provider's cache
//      state; while
//   3. the runtime still surfaces the genuinely different cost on message.done.
//
// Cost is segregated from the model-facing content by contract: ProviderUsage
// rides on the message.done event and the TuvrenModelResponse.usage field, never
// on the durable message record (which is only `{ role, parts, providerMetadata? }`).
// That separation is exactly what makes caching correctness-neutral here.
//
// (The provider-boundary expression — that the AI SDK bridge maps identical
// content while carrying a differing `cacheRead` usage breakdown under its
// aiSdkBridge bookkeeping — is covered separately by the conversation-state
// conformance plan, which observes the cost difference at that seam.)

import { describe, expect, test } from "bun:test";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  ProviderUsage,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/core/provider";
import { createDriverRegistry } from "../../../runtime/src/lib/driver-registry.ts";
import { createTuvrenRuntime as createTuvrenRuntimeCore } from "../../../runtime/src/lib/runtime-core.ts";
import { createFakeKernelHarness } from "../../../runtime/test/fake-kernel.ts";
import { createReActDriver, REACT_DRIVER_ID } from "../src/index.ts";
import { collectEvents, textSignal } from "./react-driver-test-helpers.ts";

// The produced content — the "outcome" that must be cache-neutral. Both runs
// return structurally identical parts, so any durable difference could only
// come from cost.
const ANSWER_TEXT = "the cached answer";

// Two cost profiles for the SAME produced content. A cold cache miss bills every
// input token; a warm hit serves most of the prompt from the provider's cache,
// so far fewer input tokens are billed. The output cost is unchanged.
const USAGE_CACHE_MISS: ProviderUsage = { inputTokens: 1024, outputTokens: 40 };
const USAGE_CACHE_HIT: ProviderUsage = { inputTokens: 64, outputTokens: 40 };

/**
 * A stateless provider that returns fixed produced content with a fixed usage
 * profile, recording every prompt it is handed. It holds no cross-turn state.
 */
function createCachingProvider(usage: ProviderUsage): {
  capturedPrompts: TuvrenMessage[][];
  provider: TuvrenProvider;
} {
  const capturedPrompts: TuvrenMessage[][] = [];
  const provider: TuvrenProvider = {
    async generate(prompt: TuvrenPrompt) {
      capturedPrompts.push(structuredClone(prompt.messages));
      return {
        finishReason: "stop",
        parts: [{ text: ANSWER_TEXT, type: "text" }],
        usage,
      } satisfies TuvrenModelResponse;
    },
    id: "caching-provider",
    async *stream() {
      yield* [];
    },
  };
  return { capturedPrompts, provider };
}

function buildRuntime() {
  const harness = createFakeKernelHarness();
  const runtime = createTuvrenRuntimeCore({
    defaultDriverId: REACT_DRIVER_ID,
    driverRegistry: createDriverRegistry([
      createReActDriver({ providerCallMode: "generate" }),
    ]),
    kernel: harness.kernel,
  });
  return { harness, runtime };
}

/**
 * Runs a single turn to completion and returns the branch ids plus the cost the
 * runtime surfaced on the terminal message.done event.
 */
async function runTurn(
  runtime: ReturnType<typeof buildRuntime>,
  provider: TuvrenProvider,
  text: string
): Promise<{ branchId: string; usage: ProviderUsage | undefined }> {
  const thread = await runtime.runtime.createThread({});
  const handle = runtime.runtime.executeTurn({
    branchId: thread.branchId,
    config: { model: provider, name: "primary" },
    signal: textSignal(text),
    threadId: thread.threadId,
  });
  const events = await collectEvents<TuvrenStreamEvent>(handle.events());
  expect(handle.status().phase).toBe("completed");
  const done = events.find(
    (event): event is Extract<TuvrenStreamEvent, { type: "message.done" }> =>
      event.type === "message.done"
  );
  return { branchId: thread.branchId, usage: done?.usage };
}

describe("KRT-BH004 correctness-neutral provider-side caching", () => {
  test("a provider cache miss vs hit yields a byte-identical durable canonical result; only cost differs", async () => {
    const miss = createCachingProvider(USAGE_CACHE_MISS);
    const hit = createCachingProvider(USAGE_CACHE_HIT);
    const runtimeMiss = buildRuntime();
    const runtimeHit = buildRuntime();

    const resultMiss = await runTurn(
      runtimeMiss,
      miss.provider,
      "summarize the doc"
    );
    const resultHit = await runTurn(
      runtimeHit,
      hit.provider,
      "summarize the doc"
    );

    // (1) Reconstructable request identical: each provider was handed the same
    // prompt; the cache state is the provider's concern, not the request's.
    expect(miss.capturedPrompts).toHaveLength(1);
    expect(hit.capturedPrompts).toHaveLength(1);
    expect(hit.capturedPrompts[0]).toEqual(miss.capturedPrompts[0]);

    // (2) Same canonical CBOR/result hash: the kernel content-addresses each
    // durable message via deterministic-CBOR hashing; the manifest message
    // hashes are byte-identical across the miss and the hit, so the durable
    // lineage identity does not depend on the provider's cache state.
    const manifestMiss = await runtimeMiss.harness.readBranchManifest(
      resultMiss.branchId
    );
    const manifestHit = await runtimeHit.harness.readBranchManifest(
      resultHit.branchId
    );
    expect(manifestHit.messages).toEqual(manifestMiss.messages);

    // ...and the decoded durable content is identical too.
    const durableMiss = await runtimeMiss.harness.readBranchMessages(
      resultMiss.branchId
    );
    const durableHit = await runtimeHit.harness.readBranchMessages(
      resultHit.branchId
    );
    expect(durableHit).toEqual(durableMiss);

    // (3) Only cost differs: the runtime surfaced materially different provider
    // usage for the two runs (the whole point of caching), even though every
    // durable artifact above is identical.
    expect(resultMiss.usage).toEqual(USAGE_CACHE_MISS);
    expect(resultHit.usage).toEqual(USAGE_CACHE_HIT);
    expect(resultHit.usage?.inputTokens).not.toBe(
      resultMiss.usage?.inputTokens
    );
  });
});
