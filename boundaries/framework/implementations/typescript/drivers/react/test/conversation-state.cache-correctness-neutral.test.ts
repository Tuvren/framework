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
// correctness dependency. A provider cache miss and a cache hit for the same turn
// must yield the same OUTCOME; only the reported cost may differ.
//
// "Outcome" here is the model-facing produced content — the assistant message
// parts that drive the next turn. That is what cache-neutrality protects, and it
// is what these tests assert is byte-identical across a miss and a hit. Cost is a
// separate, non-correctness-bearing concern, carried on two channels:
//   * the canonical usage total rides on the message.done event and
//     TuvrenModelResponse.usage, segregated from the durable message record; and
//   * the production AI SDK bridge additionally folds a per-turn cost breakdown
//     (providerMetadata.aiSdkBridge.rawUsage, whose `cacheRead` reflects the cache
//     state) onto the assistant message, which the driver persists verbatim.
//
// So the durable record's content-addressed hash is cache-neutral only to the
// extent cost stays off the message: it IS invariant when cost rides solely on
// the usage channel (test 1), and it legitimately VARIES when the bridge folds
// cost onto providerMetadata (test 2) — while in both cases the produced content
// is identical. This milestone's correctness-neutrality claim is therefore scoped
// to the produced content (the outcome), not to the whole durable record. Cost
// bookkeeping persisted on providerMetadata is cost-bearing, not correctness-
// bearing. (Whether the bridge's aiSdkBridge bookkeeping ought to be persisted
// into the content-addressed record at all is a pre-existing coupling, out of
// scope here; recorded as a follow-up observation in the TechSpec changelog.)
//
// (The provider-boundary expression — that the AI SDK bridge maps identical
// content while carrying a differing `cacheRead` breakdown — is covered separately
// by the conversation-state conformance plan, which observes that cost difference
// at the bridge seam.)

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
// return structurally identical parts, so any durable difference can only come
// from cost.
const ANSWER_TEXT = "the cached answer";

// Two cost profiles for the SAME produced content. A cold cache miss bills every
// input token; a warm hit serves most of the prompt from the provider's cache,
// so far fewer input tokens are billed. The output cost is unchanged.
const USAGE_CACHE_MISS: ProviderUsage = { inputTokens: 1024, outputTokens: 40 };
const USAGE_CACHE_HIT: ProviderUsage = { inputTokens: 64, outputTokens: 40 };

// Models the per-turn cost bookkeeping the production AI SDK bridge stamps onto
// the assistant message's providerMetadata (aiSdkBridge.rawUsage) and which the
// driver persists verbatim. `cacheRead` reflects the cache state; the rest is the
// fixed prompt/output accounting.
function bridgeCostMetadata(cacheReadTokens: number): Record<string, unknown> {
  return {
    aiSdkBridge: {
      rawUsage: {
        inputTokens: {
          cacheRead: cacheReadTokens,
          cacheWrite: 0,
          noCache: 1024 - cacheReadTokens,
          total: 1024,
        },
        outputTokens: { reasoning: 0, text: 40, total: 40 },
      },
    },
  };
}

/**
 * A stateless provider that returns fixed produced content with a fixed usage
 * profile and optional message-level providerMetadata, recording every prompt it
 * is handed. It holds no cross-turn state.
 */
function createCachingProvider(options: {
  providerMetadata?: Record<string, unknown>;
  usage: ProviderUsage;
}): {
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
        ...(options.providerMetadata === undefined
          ? {}
          : { providerMetadata: structuredClone(options.providerMetadata) }),
        usage: options.usage,
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
 * Runs a single turn to completion and returns the branch id plus the cost the
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

function lastAssistantMessage(
  messages: unknown[]
): Extract<TuvrenMessage, { role: "assistant" }> {
  const assistant = [...(messages as TuvrenMessage[])]
    .reverse()
    .find((message) => message.role === "assistant");
  if (assistant === undefined || assistant.role !== "assistant") {
    throw new Error("expected a durable assistant message");
  }
  return assistant;
}

describe("KRT-BH004 correctness-neutral provider-side caching", () => {
  test("with cost on the usage channel, the durable record is byte-identical across a cache miss and hit; only cost differs", async () => {
    // Cost stays where the contract puts it (the usage channel), so nothing
    // cache-varying reaches the durable message.
    const miss = createCachingProvider({ usage: USAGE_CACHE_MISS });
    const hit = createCachingProvider({ usage: USAGE_CACHE_HIT });
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

    // (1) Reconstructable request identical: the cache state is the provider's
    // concern, not the request's.
    expect(miss.capturedPrompts).toHaveLength(1);
    expect(hit.capturedPrompts).toHaveLength(1);
    expect(hit.capturedPrompts[0]).toEqual(miss.capturedPrompts[0]);

    // (2) Durable record byte-identical: the kernel content-addresses each
    // message via deterministic-CBOR hashing. `manifest.messages` is the message
    // lineage (the other manifest paths — context manifest, runtime status, turn
    // lineage — carry no provider cost), and it is identical across the miss and
    // the hit, so lineage identity does not depend on the provider's cache state.
    const manifestMiss = await runtimeMiss.harness.readBranchManifest(
      resultMiss.branchId
    );
    const manifestHit = await runtimeHit.harness.readBranchManifest(
      resultHit.branchId
    );
    expect(manifestHit.messages).toEqual(manifestMiss.messages);
    expect(
      await runtimeHit.harness.readBranchMessages(resultHit.branchId)
    ).toEqual(
      await runtimeMiss.harness.readBranchMessages(resultMiss.branchId)
    );

    // (3) Only cost differs: the runtime surfaced materially different provider
    // usage on message.done, even though every durable artifact above is
    // identical.
    expect(resultMiss.usage).toEqual(USAGE_CACHE_MISS);
    expect(resultHit.usage).toEqual(USAGE_CACHE_HIT);
    expect(resultHit.usage?.inputTokens).not.toBe(
      resultMiss.usage?.inputTokens
    );
  });

  test("the produced content stays cache-neutral even when the bridge folds cache-varying cost onto the assistant message", async () => {
    // Model the production bridge: identical produced content, but the per-turn
    // cost breakdown the bridge stamps onto providerMetadata (aiSdkBridge.rawUsage)
    // carries the cache state, and the driver persists it verbatim. The cold miss
    // reads nothing from cache; the warm hit reads most of the prompt from cache.
    const miss = createCachingProvider({
      providerMetadata: bridgeCostMetadata(0),
      usage: USAGE_CACHE_MISS,
    });
    const hit = createCachingProvider({
      providerMetadata: bridgeCostMetadata(960),
      usage: USAGE_CACHE_HIT,
    });
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

    const assistantMiss = lastAssistantMessage(
      await runtimeMiss.harness.readBranchMessages(resultMiss.branchId)
    );
    const assistantHit = lastAssistantMessage(
      await runtimeHit.harness.readBranchMessages(resultHit.branchId)
    );

    // (1) Reconstructable request identical.
    expect(hit.capturedPrompts[0]).toEqual(miss.capturedPrompts[0]);

    // (2) The produced canonical result is cache-neutral: the model-facing content
    // (the assistant message parts — the outcome that drives the next turn) is
    // byte-identical across the miss and the hit.
    expect(assistantHit.parts).toEqual(assistantMiss.parts);

    // (3) Cost telemetry is segregated from the produced content and is NOT part
    // of the cache-neutral result. The bridge's cost bookkeeping persisted on
    // providerMetadata genuinely varies with cache state, so the full content-
    // addressed durable record legitimately differs across the miss and the hit —
    // even though the produced content above does not. Cache-neutrality is a
    // property of the outcome, not of cost-bearing metadata.
    expect(assistantHit.providerMetadata).not.toEqual(
      assistantMiss.providerMetadata
    );
    const manifestMiss = await runtimeMiss.harness.readBranchManifest(
      resultMiss.branchId
    );
    const manifestHit = await runtimeHit.harness.readBranchManifest(
      resultHit.branchId
    );
    expect(manifestHit.messages).not.toEqual(manifestMiss.messages);

    // (4) ...and the cost difference is also surfaced on message.done.
    expect(resultHit.usage?.inputTokens).not.toBe(
      resultMiss.usage?.inputTokens
    );
  });
});
