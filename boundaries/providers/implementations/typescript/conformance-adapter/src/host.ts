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

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { TuvrenProviderError } from "@tuvren/core-types";
import {
  assertProviderFinishChunk,
  assertProviderStructuredDoneChunk,
  providerTestkitFixtures,
  verifyProviderGenerate,
  verifyProviderRejects,
  verifyProviderStream,
} from "@tuvren/provider-testkit";
import type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { createAdapterErrorEnvelope } from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { serveStdioAdapter } from "../../../../../../tools/conformance/adapter-protocol/stdio-host.js";
import { createAiSdkProviderBridge } from "../../bridge-ai-sdk/src/index.ts";

class TypeScriptProviderAdapter {
  initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities> {
    return Promise.resolve({
      adapterId: "typescript-providers",
      capabilities: [
        "providers.provider-api",
        "providers.ai-sdk-bridge",
        "providers.executed-tool-support",
        "providers.structured-output-strictness",
      ],
      packetId,
      planVersion,
    });
  }

  async dispatch(
    operation: string,
    _input: unknown,
    _controls: AdapterControls
  ): Promise<OperationOutcome> {
    try {
      switch (operation) {
        case "providers.bridge.generate-mapping":
          return result(await generateMapping());
        case "providers.bridge.stream-metadata-continuity":
          return result(await streamMetadataContinuity());
        case "providers.bridge.structured-output-stream":
          return result(await structuredOutputStream());
        case "providers.bridge.provider-failure-normalization":
          return result(await providerFailureNormalization());
        default:
          return {
            error: {
              code: "adapter_operation_not_implemented",
              message: `provider adapter does not implement ${operation}`,
            },
            kind: "error",
          };
      }
    } catch (error: unknown) {
      return {
        error: createAdapterErrorEnvelope(error),
        kind: "error",
      };
    }
  }
}

await serveStdioAdapter(new TypeScriptProviderAdapter());

async function generateMapping(): Promise<Record<string, unknown>> {
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
  const providerMetadata = isRecord(response.providerMetadata)
    ? response.providerMetadata
    : {};

  return {
    evidence: {
      generate: {
        providerMetadataKeys: Object.keys(providerMetadata),
        responseFormatName:
          capturedOptions?.responseFormat?.type === "json"
            ? capturedOptions.responseFormat.name
            : undefined,
        responseFormatType: capturedOptions?.responseFormat?.type,
        responsePartTypes: response.parts.map((part) => part.type),
      },
    },
  };
}

async function streamMetadataContinuity(): Promise<Record<string, unknown>> {
  const bridge = createAiSdkProviderBridge({
    model: createMockModel({
      doStream() {
        return Promise.resolve({
          stream: streamFromParts([
            {
              id: "call-1",
              providerMetadata: {
                google: { thoughtSignature: "tool-thought-1" },
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
              finishReason: { raw: "tool-calls", unified: "tool-calls" },
              providerMetadata: { openai: { requestId: "req-stream-1" } },
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

  return {
    evidence: {
      stream: {
        chunkTypes: chunks.map((chunk) => chunk.type),
        finishMetadataKeys: isRecord(finishChunk.providerMetadata)
          ? Object.keys(finishChunk.providerMetadata)
          : [],
      },
    },
  };
}

async function structuredOutputStream(): Promise<Record<string, unknown>> {
  const bridge = createAiSdkProviderBridge({
    model: createMockModel({
      doStream() {
        return Promise.resolve({
          stream: streamFromParts([
            { id: "message-1", type: "text-start" },
            {
              delta: '{"answer":"ready"}',
              id: "message-1",
              type: "text-delta",
            },
            { id: "message-1", type: "text-end" },
            {
              finishReason: { raw: "stop", unified: "stop" },
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

  return {
    evidence: {
      structured: {
        chunkTypes: chunks.map((chunk) => chunk.type),
        doneName: structuredDoneChunk.name,
      },
    },
  };
}

async function providerFailureNormalization(): Promise<
  Record<string, unknown>
> {
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

  return {
    evidence: {
      failure: {
        errorCode:
          error instanceof TuvrenProviderError ? error.code : "unknown",
        errorName:
          error instanceof TuvrenProviderError
            ? "TuvrenProviderError"
            : error.constructor.name,
      },
    },
  };
}

function result(value: Record<string, unknown>): OperationOutcome {
  return {
    kind: "result",
    value,
  };
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
            finishReason: { raw: "stop", unified: "stop" },
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
    content: [{ text: "default", type: "text" }],
    finishReason: { raw: "stop", unified: "stop" },
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
    raw: { provider: "mock-provider" },
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
