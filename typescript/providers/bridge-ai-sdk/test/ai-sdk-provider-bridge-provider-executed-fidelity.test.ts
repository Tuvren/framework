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

// biome-ignore-all lint/suspicious/useAwait: Mock AI SDK model hooks intentionally preserve async provider signatures.

// KRT-BH005 — Bridge providerExecuted/dynamic fidelity audit (ADR-055).
//
// AI SDK v6 (ai@6.0.142) models a provider-executed tool round-trip as a
// `tool-call` content/stream part carrying `providerExecuted: true` (and, for
// runtime-defined provider tools such as MCP, `dynamic: true`) FOLLOWED BY a
// `tool-result` part. vercel/ai #10888 (open as of 2026-06) is the landmine in
// the AI SDK's own higher-level orchestration: `parseToolCall` — reached only
// through `generateText`/`streamText` — validates these provider-executed
// tool-calls against the USER's function tool map and injects a spurious
// "invalid tool" error when the provider-executed tool name is absent from that
// map (which it always is — the user never declared the provider's built-in).
//
// Tuvren's bridge consumes the LOW-LEVEL `LanguageModelV3.doGenerate`/`doStream`
// contract directly, so `parseToolCall` is never in the path. This audit proves
// that structural immunity behaviourally: a provider-executed tool round-trip is
// driven through the bridge with a user function tool map that deliberately does
// NOT contain the provider-executed tool name (the exact #10888 trigger), and
// the bridge must attribute the round-trip to the provider-native execution
// class WITHOUT injecting a validation error and WITHOUT contaminating the
// client-facing `parts` with a function tool_call the runtime would try to run.

import { describe, expect, test } from "bun:test";
import { TuvrenProviderError } from "@tuvren/core";
import { createAiSdkProviderBridge } from "../src/index.ts";
import {
  collectAsyncIterable,
  createGenerateResult,
  createMockModel,
  createUsage,
  streamFromParts,
} from "./ai-sdk-provider-bridge-test-helpers.ts";

// A user function tool map that does NOT contain the provider-executed tool
// name — the exact configuration that makes AI SDK #10888 fire in generateText.
const USER_FUNCTION_TOOLS = [
  {
    name: "my_function",
    description: "a user-owned function tool",
    inputSchema: { type: "object" as const },
  },
];

// A provider-executed web search, declared to Tuvren as a provider-native tool.
const WEB_SEARCH_DECLARATION = {
  id: "openai.web_search_preview",
  name: "web_search",
};

const WEB_SEARCH_RESULT = {
  results: [{ title: "Tuvren", url: "https://example.com" }],
};

describe("KRT-BH005 provider-executed/dynamic fidelity (generate)", () => {
  test("attributes a providerExecuted+dynamic round-trip to provider-native without a spurious validation error", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doGenerate() {
          // Realistic provider-executed round-trip: the provider's own tool-call
          // record (providerExecuted + dynamic) precedes the tool-result.
          return createGenerateResult({
            content: [
              {
                dynamic: true,
                input: JSON.stringify({ query: "tuvren runtime" }),
                providerExecuted: true,
                toolCallId: "ws-1",
                toolName: "web_search",
                type: "tool-call",
              },
              {
                result: WEB_SEARCH_RESULT,
                toolCallId: "ws-1",
                toolName: "web_search",
                type: "tool-result",
              },
              {
                text: "Based on the search, Tuvren is a runtime.",
                type: "text",
              },
            ],
            finishReason: { raw: "stop", unified: "stop" },
          });
        },
      }),
    });

    const response = await bridge.generate({
      messages: [{ parts: [{ text: "search", type: "text" }], role: "user" }],
      tools: USER_FUNCTION_TOOLS,
      providerNativeTools: [WEB_SEARCH_DECLARATION],
    });

    // (1) The provider-executed result is attributed to provider-native.
    expect(response.providerToolResults).toHaveLength(1);
    const record = response.providerToolResults?.[0];
    expect(record?.name).toBe("web_search");
    expect(record?.executionClass).toBe("provider-native");

    // (2) No spurious validation error: the provider-executed tool-call did NOT
    // get mis-validated against the user function tool map (#10888). The
    // assistant text part is produced normally.
    expect(
      response.parts.some(
        (part) => part.type === "text" && part.text.includes("Tuvren")
      )
    ).toBe(true);

    // (3) The provider-executed tool-call does NOT contaminate the client-facing
    // parts with a function tool_call the runtime would attempt to execute.
    expect(
      response.parts.some(
        (part) => part.type === "tool_call" || part.type === "tool_result"
      )
    ).toBe(false);
  });

  test("still rejects an UNDECLARED providerExecuted tool-call (baseline protection)", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doGenerate() {
          return createGenerateResult({
            content: [
              {
                dynamic: true,
                input: "{}",
                providerExecuted: true,
                toolCallId: "ws-2",
                toolName: "undeclared_tool",
                type: "tool-call",
              },
            ],
            finishReason: { raw: "tool-calls", unified: "tool-calls" },
          });
        },
      }),
    });

    // No providerNativeTools declared → the provider-owned execution is genuinely
    // out of scope for the baseline bridge and must still be rejected.
    await expect(
      bridge.generate({
        messages: [{ parts: [{ text: "go", type: "text" }], role: "user" }],
      })
    ).rejects.toBeInstanceOf(TuvrenProviderError);
  });

  test("a DECLARED provider-executed tool-call with no matching result yields no observation (provider bookkeeping, not a silent function call)", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doGenerate() {
          // A declared provider-executed tool-call WITHOUT its tool-result: a
          // truncated/interrupted provider turn. The call is the provider's own
          // bookkeeping — only a tool-result is an attributable observation — so
          // skipping the call produces no provider-native record and no
          // client-facing function tool_call the runtime would execute. It must
          // NOT throw (the prior over-broad rejection did), and assistant text
          // still flows. An orphan call simply yields no observation; a degraded
          // diagnostic record is deferred to the ADR-055 native-client phases.
          return createGenerateResult({
            content: [
              {
                dynamic: true,
                input: JSON.stringify({ query: "tuvren runtime" }),
                providerExecuted: true,
                toolCallId: "ws-orphan",
                toolName: "web_search",
                type: "tool-call",
              },
              { text: "No results yet.", type: "text" },
            ],
            finishReason: { raw: "stop", unified: "stop" },
          });
        },
      }),
    });

    const response = await bridge.generate({
      messages: [{ parts: [{ text: "search", type: "text" }], role: "user" }],
      tools: USER_FUNCTION_TOOLS,
      providerNativeTools: [WEB_SEARCH_DECLARATION],
    });

    // No matching tool-result → no provider-native observation is fabricated.
    expect(response.providerToolResults ?? []).toHaveLength(0);
    // The orphan call does not contaminate client-facing parts with a function
    // tool_call/tool_result the runtime would attempt to execute.
    expect(
      response.parts.some(
        (part) => part.type === "tool_call" || part.type === "tool_result"
      )
    ).toBe(false);
    // The turn is not aborted: assistant content still flows.
    expect(
      response.parts.some(
        (part) => part.type === "text" && part.text.length > 0
      )
    ).toBe(true);
  });
});

describe("KRT-BH005 provider-executed/dynamic fidelity (stream)", () => {
  test("attributes a streamed providerExecuted+dynamic round-trip to provider-native without a spurious validation error", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doStream() {
          return {
            stream: streamFromParts([
              {
                dynamic: true,
                input: JSON.stringify({ query: "tuvren runtime" }),
                providerExecuted: true,
                toolCallId: "ws-1",
                toolName: "web_search",
                type: "tool-call",
              },
              {
                result: WEB_SEARCH_RESULT,
                toolCallId: "ws-1",
                toolName: "web_search",
                type: "tool-result",
              },
              { delta: "ok", id: "t-1", type: "text-delta" },
              {
                finishReason: { raw: "stop", unified: "stop" },
                type: "finish",
                usage: createUsage(3, 2),
              },
            ]),
          };
        },
      }),
    });

    const chunks = await collectAsyncIterable(
      bridge.stream({
        messages: [{ parts: [{ text: "search", type: "text" }], role: "user" }],
        tools: USER_FUNCTION_TOOLS,
        providerNativeTools: [WEB_SEARCH_DECLARATION],
      })
    );

    // (1) The provider-executed result surfaces as a provider_tool_result chunk
    // attributed to the provider-native execution class.
    const providerResult = chunks.find(
      (chunk) => chunk.type === "provider_tool_result"
    );
    expect(providerResult).toBeDefined();
    expect((providerResult as { name: string }).name).toBe("web_search");
    expect(
      (providerResult as { providerMetadata?: Record<string, unknown> })
        .providerMetadata?.executionClass
    ).toBe("provider-native");
    // The stream chunk also carries the runtime-facing owner attribution
    // (AY002/AY004): provider-executed results are owned by the provider, never
    // the host. (The generate-side record exposes executionClass at the bridge
    // seam; owner is attached when the runtime maps the result to tool.result.)
    expect(
      (providerResult as { providerMetadata?: Record<string, unknown> })
        .providerMetadata?.owner
    ).toBe("provider");

    // (2) No spurious validation error and no client-facing tool_call chunk for
    // the provider-executed call: only the provider_tool_result carries it.
    expect(
      chunks.some(
        (chunk) =>
          chunk.type === "tool_call_start" || chunk.type === "tool_call_done"
      )
    ).toBe(false);
  });

  test("a DECLARED streamed provider-executed tool-call with no matching result yields no provider_tool_result and no client tool_call", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doStream() {
          // Streamed counterpart of the orphan case: the provider-executed
          // tool-call streams but its tool-result never arrives this turn. The
          // skipped call emits no chunk; no provider_tool_result is fabricated;
          // the stream completes without throwing.
          return {
            stream: streamFromParts([
              {
                dynamic: true,
                input: JSON.stringify({ query: "tuvren runtime" }),
                providerExecuted: true,
                toolCallId: "ws-orphan",
                toolName: "web_search",
                type: "tool-call",
              },
              { delta: "ok", id: "t-1", type: "text-delta" },
              {
                finishReason: { raw: "stop", unified: "stop" },
                type: "finish",
                usage: createUsage(3, 2),
              },
            ]),
          };
        },
      }),
    });

    const chunks = await collectAsyncIterable(
      bridge.stream({
        messages: [{ parts: [{ text: "search", type: "text" }], role: "user" }],
        tools: USER_FUNCTION_TOOLS,
        providerNativeTools: [WEB_SEARCH_DECLARATION],
      })
    );

    // No matching tool-result → no provider_tool_result chunk is fabricated.
    expect(chunks.some((chunk) => chunk.type === "provider_tool_result")).toBe(
      false
    );
    // The skipped provider-executed call emits no client-facing tool_call chunk.
    expect(
      chunks.some(
        (chunk) =>
          chunk.type === "tool_call_start" || chunk.type === "tool_call_done"
      )
    ).toBe(false);
  });

  test("attributes an INCREMENTALLY-streamed providerExecuted round-trip (tool-input-start → delta → end → tool-call → tool-result) to provider-native without surfacing a client tool_call", async () => {
    // The shape real providers actually emit. @ai-sdk/openai@3.0.53 streams
    // provider-executed Responses tools (web_search, code_interpreter,
    // computer_use, …) as tool-input-start{providerExecuted} → tool-input-delta →
    // tool-input-end → tool-call{providerExecuted} → tool-result. Only
    // tool-input-start carries the providerExecuted/dynamic flags, so the bridge
    // must recognise the declared provider tool at the START of the input stream
    // and stay silent through the whole prelude — never throwing
    // provider_owned_tool_execution_unsupported (KRT-BH005 regression guard) and
    // never emitting a tool_call_start/args_delta/done the runtime would execute.
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doStream() {
          return {
            stream: streamFromParts([
              {
                dynamic: true,
                id: "ws-1",
                providerExecuted: true,
                toolName: "web_search",
                type: "tool-input-start",
              },
              { delta: '{"query":', id: "ws-1", type: "tool-input-delta" },
              { delta: '"tuvren"}', id: "ws-1", type: "tool-input-delta" },
              { id: "ws-1", type: "tool-input-end" },
              {
                dynamic: true,
                input: JSON.stringify({ query: "tuvren" }),
                providerExecuted: true,
                toolCallId: "ws-1",
                toolName: "web_search",
                type: "tool-call",
              },
              {
                result: WEB_SEARCH_RESULT,
                toolCallId: "ws-1",
                toolName: "web_search",
                type: "tool-result",
              },
              { delta: "ok", id: "t-1", type: "text-delta" },
              {
                finishReason: { raw: "stop", unified: "stop" },
                type: "finish",
                usage: createUsage(3, 2),
              },
            ]),
          };
        },
      }),
    });

    const chunks = await collectAsyncIterable(
      bridge.stream({
        messages: [{ parts: [{ text: "search", type: "text" }], role: "user" }],
        tools: USER_FUNCTION_TOOLS,
        providerNativeTools: [WEB_SEARCH_DECLARATION],
      })
    );

    // (1) The provider-executed result is attributed to provider-native.
    const providerResult = chunks.find(
      (chunk) => chunk.type === "provider_tool_result"
    );
    expect(providerResult).toBeDefined();
    expect((providerResult as { name: string }).name).toBe("web_search");
    expect(
      (providerResult as { providerMetadata?: Record<string, unknown> })
        .providerMetadata?.executionClass
    ).toBe("provider-native");

    // (2) The entire provider-executed input prelude stays out of the client tool
    // stream: no tool_call_start, no tool_call_args_delta, no tool_call_done.
    expect(
      chunks.some(
        (chunk) =>
          chunk.type === "tool_call_start" ||
          chunk.type === "tool_call_args_delta" ||
          chunk.type === "tool_call_done"
      )
    ).toBe(false);

    // (3) Stream/generate finish-reason parity: the provider finished the turn
    // with `stop`, and the skipped provider-executed tool — even though it seeds a
    // providerOwned tool-state — must NOT push the turn through the tool-call
    // finish-reason normalization. A spurious `tool_call` here would drive a
    // continue/execute-tools iteration with no client call to run (KRT-BH005).
    const finishChunk = chunks.find((chunk) => chunk.type === "finish");
    expect((finishChunk as { finishReason?: string }).finishReason).toBe(
      "stop"
    );
  });

  test("still rejects an UNDECLARED provider-executed tool-input-start (baseline protection on the incremental path)", async () => {
    // The incremental-path counterpart of the undeclared generate case: a
    // provider-executed tool-input-start whose tool is NOT declared as a provider
    // tool is genuinely out of scope and must still be rejected — the new
    // declared-lookup guard must not become a blanket allow.
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doStream() {
          return {
            stream: streamFromParts([
              {
                dynamic: true,
                id: "u-1",
                providerExecuted: true,
                toolName: "undeclared_tool",
                type: "tool-input-start",
              },
            ]),
          };
        },
      }),
    });

    await expect(
      collectAsyncIterable(
        bridge.stream({
          messages: [{ parts: [{ text: "go", type: "text" }], role: "user" }],
        })
      )
    ).rejects.toBeInstanceOf(TuvrenProviderError);
  });

  test("a lingering provider-owned tool-state never hijacks the client tool-call correlation scan", async () => {
    // Regression guard for the lingering-provider-owned-state correlation hazard:
    // a declared provider-executed tool seeds a tool-state with inputBuffer "" and
    // name "web_search". A later CLIENT tool-call (no provider flags, its own
    // toolCallId) sharing that name must never be content-correlated to the
    // provider tool's bookkeeping. The only input that could collide with the
    // provider state's always-empty inputBuffer is "" — itself invalid client JSON
    // — so the correct outcome is the precise input-validation error, NOT the
    // misleading "mismatched incremental tool-input id" correlation error the
    // lingering provider-owned state produced before the scan excluded it.
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        provider: "openai",
        async doStream() {
          return {
            stream: streamFromParts([
              // Declared provider-executed tool, incremental — seeds the lingering
              // providerOwned state (name "web_search", inputBuffer "").
              {
                dynamic: true,
                id: "pv-1",
                providerExecuted: true,
                toolName: "web_search",
                type: "tool-input-start",
              },
              { id: "pv-1", type: "tool-input-end" },
              // A client tool-call sharing the name, with empty input and its own id.
              {
                input: "",
                toolCallId: "cl-1",
                toolName: "web_search",
                type: "tool-call",
              },
              {
                finishReason: { raw: "stop", unified: "stop" },
                type: "finish",
                usage: createUsage(3, 2),
              },
            ]),
          };
        },
      }),
    });

    let caught: unknown;
    try {
      await collectAsyncIterable(
        bridge.stream({
          messages: [
            { parts: [{ text: "search", type: "text" }], role: "user" },
          ],
          tools: USER_FUNCTION_TOOLS,
          providerNativeTools: [WEB_SEARCH_DECLARATION],
        })
      );
    } catch (error: unknown) {
      caught = error;
    }

    // The accurate input-validation error — proving the client call reached its
    // own JSON parse rather than being aborted by the provider tool's lingering
    // bookkeeping (which would have thrown `unsupported_ai_sdk_stream_part`).
    expect(caught).toMatchObject({ code: "invalid_ai_sdk_tool_call_input" });
  });
});
