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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { TuvrenProviderError } from "@tuvren/core-types";
import {
  assertProviderChunkTypes,
  assertProviderFinishChunk,
  assertProviderStructuredDoneChunk,
  providerTestkitFixtures,
  verifyProviderGenerate,
  verifyProviderRejects,
  verifyProviderStream,
} from "@tuvren/provider-testkit";
import {
  type ConformanceCheckResult,
  type ConformanceEvidence,
  createAssertionResult,
  createCheckResult,
  createConformanceEvidenceSummary,
} from "../../../../../../tools/scripts/lib/conformance-contract.js";
import {
  emitConformanceEvidence,
  readConformanceSuiteManifest,
  selectImplementationChecks,
} from "../../../../../../tools/scripts/lib/conformance-runner.js";
import { createAiSdkProviderBridge } from "../../bridge-ai-sdk/src/index.ts";

const PROVIDER_MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../conformance/scenarios/suite-manifest.json"
);
const IMPLEMENTATION_ID = "typescript-providers";
const LANGUAGE = "typescript";

await main();

async function main(): Promise<void> {
  const manifest = await readConformanceSuiteManifest(PROVIDER_MANIFEST_PATH);
  const checkResults: ConformanceCheckResult[] = [];

  for (const check of selectImplementationChecks(manifest, IMPLEMENTATION_ID)) {
    checkResults.push(await runCheck(check.checkId));
  }

  const summary = createConformanceEvidenceSummary(checkResults);
  const evidence: ConformanceEvidence = {
    boundary: manifest.boundary,
    checkResults,
    implementationId: IMPLEMENTATION_ID,
    language: LANGUAGE,
    status: summary.failedChecks === 0 ? "pass" : "fail",
    suiteId: manifest.suiteId,
    suiteVersion: manifest.suiteVersion,
    summary,
  };

  emitConformanceEvidence(evidence);
}

function runCheck(checkId: string): Promise<ConformanceCheckResult> {
  switch (checkId) {
    case "providers.fixture.prompt_shape":
      return Promise.resolve(createPromptFixtureCheck());
    case "providers.fixture.response_shape":
      return Promise.resolve(createResponseFixtureCheck());
    case "providers.fixture.structured_output_shape":
      return Promise.resolve(createStructuredFixtureCheck());
    case "providers.fixture.tool_prompt_shape":
      return Promise.resolve(createToolPromptFixtureCheck());
    case "providers.bridge.generate_mapping":
      return createGenerateBridgeCheck();
    case "providers.bridge.stream_metadata_continuity":
      return createStreamBridgeCheck();
    case "providers.bridge.structured_output_stream":
      return createStructuredBridgeCheck();
    case "providers.bridge.provider_failure_normalization":
      return createFailureBridgeCheck();
    default:
      throw new Error(`unsupported provider conformance check ${checkId}`);
  }
}

function createPromptFixtureCheck(): ConformanceCheckResult {
  const roles = providerTestkitFixtures.prompt.messages.map(
    (message) => message.role
  );

  return createCheckResult(
    "providers.fixture.prompt_shape",
    [
      createAssertionResult(
        "prompt_has_messages",
        providerTestkitFixtures.prompt.messages.length > 0
      ),
      createAssertionResult(
        "prompt_has_single_user_message",
        providerTestkitFixtures.prompt.messages.length === 1 &&
          providerTestkitFixtures.prompt.messages[0]?.role === "user"
      ),
    ],
    {
      messageRoles: roles,
    }
  );
}

function createResponseFixtureCheck(): ConformanceCheckResult {
  return createCheckResult(
    "providers.fixture.response_shape",
    [
      createAssertionResult(
        "response_finish_reason_stop",
        providerTestkitFixtures.response.finishReason === "stop"
      ),
      createAssertionResult(
        "response_contains_text_part",
        providerTestkitFixtures.response.parts[0]?.type === "text" &&
          providerTestkitFixtures.response.parts[0].text === "ready"
      ),
      createAssertionResult(
        "response_usage_shape",
        providerTestkitFixtures.response.usage?.inputTokens === 4 &&
          providerTestkitFixtures.response.usage.outputTokens === 1
      ),
    ],
    {
      finishReason: providerTestkitFixtures.response.finishReason,
    }
  );
}

function createStructuredFixtureCheck(): ConformanceCheckResult {
  const responseFormat =
    providerTestkitFixtures.structuredPrompt.responseFormat;
  const schema =
    responseFormat?.schema !== undefined &&
    typeof responseFormat.schema === "object" &&
    responseFormat.schema !== null
      ? responseFormat.schema
      : undefined;
  const required =
    schema !== undefined &&
    "required" in schema &&
    Array.isArray(schema.required)
      ? schema.required
      : [];

  return createCheckResult(
    "providers.fixture.structured_output_shape",
    [
      createAssertionResult(
        "structured_prompt_has_response_format",
        responseFormat !== undefined
      ),
      createAssertionResult(
        "structured_prompt_schema_requires_answer",
        required.includes("answer")
      ),
    ],
    {
      schemaKeys:
        schema === undefined
          ? []
          : Object.keys(schema).sort((left, right) =>
              left.localeCompare(right)
            ),
    }
  );
}

function createToolPromptFixtureCheck(): ConformanceCheckResult {
  const tool = providerTestkitFixtures.toolPrompt.tools?.[0];
  const inputSchema =
    tool?.inputSchema !== undefined &&
    typeof tool.inputSchema === "object" &&
    tool.inputSchema !== null
      ? tool.inputSchema
      : undefined;
  const required =
    inputSchema !== undefined &&
    "required" in inputSchema &&
    Array.isArray(inputSchema.required)
      ? inputSchema.required
      : [];

  return createCheckResult(
    "providers.fixture.tool_prompt_shape",
    [
      createAssertionResult(
        "tool_prompt_has_search_tool",
        tool?.name === "search"
      ),
      createAssertionResult(
        "tool_prompt_tool_schema_requires_query",
        required.includes("query")
      ),
    ],
    {
      toolNames:
        providerTestkitFixtures.toolPrompt.tools?.map((entry) => entry.name) ??
        [],
    }
  );
}

async function createGenerateBridgeCheck(): Promise<ConformanceCheckResult> {
  let capturedOptions: LanguageModelV3CallOptions | undefined;
  const bridge = createAiSdkProviderBridge({
    model: createMockModel({
      doGenerate(options) {
        capturedOptions = options;
        return Promise.resolve(
          createGenerateResult({
            content: [
              {
                text: '{"answer":"ready"}',
                type: "text",
              },
            ],
            providerMetadata: {
              openai: {
                requestId: "req-bridge-generate",
              },
            },
          })
        );
      },
    }),
  });
  const response = await verifyProviderGenerate({
    prompt: providerTestkitFixtures.structuredPrompt,
    provider: bridge,
  });
  const providerMetadata =
    response.providerMetadata !== undefined &&
    typeof response.providerMetadata === "object" &&
    response.providerMetadata !== null
      ? response.providerMetadata
      : undefined;

  return createCheckResult(
    "providers.bridge.generate_mapping",
    [
      createAssertionResult(
        "bridge_generate_returns_text_response",
        response.parts.some((part) => part.type === "structured")
      ),
      createAssertionResult(
        "bridge_generate_maps_structured_schema",
        capturedOptions?.responseFormat?.type === "json" &&
          capturedOptions.responseFormat.name === "answer"
      ),
      createAssertionResult(
        "bridge_generate_preserves_provider_metadata",
        providerMetadata !== undefined && "openai" in providerMetadata
      ),
    ],
    {
      providerMetadataKeys:
        providerMetadata === undefined ? [] : Object.keys(providerMetadata),
    }
  );
}

async function createStreamBridgeCheck(): Promise<ConformanceCheckResult> {
  const bridge = createAiSdkProviderBridge({
    model: createMockModel({
      doStream() {
        return Promise.resolve({
          stream: streamFromParts([
            {
              id: "call-1",
              providerMetadata: {
                google: {
                  thoughtSignature: "tool-thought-1",
                },
              },
              toolName: "search",
              type: "tool-input-start",
            },
            {
              delta: '{"query":"docs"}',
              id: "call-1",
              type: "tool-input-delta",
            },
            {
              id: "call-1",
              type: "tool-input-end",
            },
            {
              finishReason: {
                raw: "tool-calls",
                unified: "tool-calls",
              },
              providerMetadata: {
                openai: {
                  requestId: "req-stream-1",
                },
              },
              type: "finish",
              usage: createUsage(4, 2),
            },
          ]),
        });
      },
    }),
  });
  const chunks = await verifyProviderStream({
    prompt: providerTestkitFixtures.toolPrompt,
    provider: bridge,
  });
  const finishChunk = assertProviderFinishChunk(chunks, "tool_call");

  return createCheckResult(
    "providers.bridge.stream_metadata_continuity",
    [
      createAssertionResult(
        "bridge_stream_emits_text_delta",
        chunks[1]?.type === "tool_call_args_delta" &&
          chunks[1].delta === '{"query":"docs"}'
      ),
      createAssertionResult(
        "bridge_stream_emits_tool_call_chunks",
        assertChunkTypes(chunks, [
          "tool_call_start",
          "tool_call_args_delta",
          "tool_call_done",
          "finish",
        ])
      ),
      createAssertionResult(
        "bridge_stream_preserves_finish_metadata",
        finishChunk.providerMetadata !== undefined
      ),
    ],
    {
      chunkTypes: chunks.map((chunk) => chunk.type),
    }
  );
}

async function createStructuredBridgeCheck(): Promise<ConformanceCheckResult> {
  const bridge = createAiSdkProviderBridge({
    model: createMockModel({
      doStream() {
        return Promise.resolve({
          stream: streamFromParts([
            {
              id: "message-1",
              type: "text-start",
            },
            {
              delta: '{"answer":"ready"}',
              id: "message-1",
              type: "text-delta",
            },
            {
              id: "message-1",
              type: "text-end",
            },
            {
              finishReason: {
                raw: "stop",
                unified: "stop",
              },
              type: "finish",
              usage: createUsage(7, 2),
            },
          ]),
        });
      },
    }),
  });
  const chunks = await verifyProviderStream({
    prompt: providerTestkitFixtures.structuredPrompt,
    provider: bridge,
  });
  const structuredDoneChunk = assertProviderStructuredDoneChunk(
    chunks,
    "answer"
  );

  return createCheckResult(
    "providers.bridge.structured_output_stream",
    [
      createAssertionResult(
        "bridge_structured_stream_emits_delta",
        chunks[0]?.type === "structured_delta" &&
          chunks[0].delta === '{"answer":"ready"}'
      ),
      createAssertionResult(
        "bridge_structured_stream_emits_done",
        chunks.some((chunk) => chunk.type === "structured_done")
      ),
      createAssertionResult(
        "bridge_structured_done_name_matches_request",
        structuredDoneChunk.name === "answer"
      ),
    ],
    {
      chunkTypes: chunks.map((chunk) => chunk.type),
    }
  );
}

async function createFailureBridgeCheck(): Promise<ConformanceCheckResult> {
  const bridge = createAiSdkProviderBridge({
    model: createMockModel({
      doGenerate() {
        return Promise.reject(new Error("bridge boom"));
      },
    }),
  });
  const error = await verifyProviderRejects({
    run: () => bridge.generate(providerTestkitFixtures.prompt),
  });

  return createCheckResult(
    "providers.bridge.provider_failure_normalization",
    [
      createAssertionResult(
        "bridge_failure_throws_tuvren_provider_error",
        error instanceof TuvrenProviderError
      ),
      createAssertionResult(
        "bridge_failure_preserves_stable_error_code",
        error instanceof TuvrenProviderError &&
          error.code === "ai_sdk_generate_failed"
      ),
    ],
    {
      errorCode:
        error instanceof TuvrenProviderError ? error.code : "unknown_error",
    }
  );
}

function assertChunkTypes(
  chunks: Parameters<typeof assertProviderChunkTypes>[0],
  expectedTypes: Parameters<typeof assertProviderChunkTypes>[1]
): boolean {
  try {
    assertProviderChunkTypes(chunks, expectedTypes);
    return true;
  } catch {
    return false;
  }
}

function createMockModel(
  overrides: Partial<LanguageModelV3> & {
    doGenerate?: LanguageModelV3["doGenerate"];
    doStream?: LanguageModelV3["doStream"];
  } = {}
): LanguageModelV3 {
  return {
    doGenerate() {
      return Promise.resolve(createGenerateResult());
    },
    doStream() {
      return Promise.resolve({
        stream: streamFromParts([
          {
            finishReason: {
              raw: "stop",
              unified: "stop",
            },
            type: "finish",
            usage: createUsage(1, 1),
          },
        ]),
      });
    },
    modelId: "mock-model",
    provider: "mock-provider",
    specificationVersion: "v3",
    supportedUrls: {},
    ...overrides,
  };
}

function createGenerateResult(
  overrides: Partial<LanguageModelV3GenerateResult> = {}
): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        text: "default",
        type: "text",
      },
    ],
    finishReason: {
      raw: "stop",
      unified: "stop",
    },
    usage: createUsage(1, 1),
    warnings: [],
    ...overrides,
  };
}

function createUsage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      cacheRead: 1,
      cacheWrite: 0,
      noCache: inputTokens - 1,
      total: inputTokens,
    },
    outputTokens: {
      reasoning: outputTokens > 2 ? 2 : 0,
      text: outputTokens > 2 ? outputTokens - 2 : outputTokens,
      total: outputTokens,
    },
    raw: {
      provider: "mock-provider",
    },
  };
}

function streamFromParts(
  parts: readonly LanguageModelV3StreamPart[]
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }

      controller.close();
    },
  });
}
