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

import { randomUUID } from "node:crypto";
import type {
  LanguageModelV3File,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import type {
  StructuredOutputRequest,
  TuvrenModelResponse,
} from "@tuvren/provider-api";
import {
  bridgeError,
  buildProviderMetadata,
  cloneFileData,
  isPlainObject,
  mergeProviderMetadataRecords,
  parseJsonInput,
  rejectUnsupportedProviderOwnedToolPart,
  sanitizeGenerateResponseMetadata,
  sanitizeMetadataValue,
  sanitizeRecord,
} from "./ai-sdk-provider-bridge-utils.js";
/** Lookup function that returns the execution class for a provider-owned tool name, or undefined if not declared. */
export type ProviderToolClassLookup = (
  toolName: string
) => "provider-native" | "provider-mediated" | undefined;

export interface GenerateResultHelpers {
  mapFinishReason(
    reason: Pick<
      LanguageModelV3GenerateResult["finishReason"],
      "raw" | "unified"
    >,
    options: {
      hasToolCalls?: boolean;
    }
  ): TuvrenModelResponse["finishReason"];
  mapUsage(usage: LanguageModelV3GenerateResult["usage"]): {
    canonical?:
      | {
          inputTokens: number;
          outputTokens: number;
        }
      | undefined;
    rawUsage: unknown;
  };
  parseStructuredOutput(
    serialized: string,
    request: StructuredOutputRequest
  ): unknown;
}

interface GenerateResultState {
  parts: TuvrenModelResponse["parts"];
  providerToolResults: NonNullable<TuvrenModelResponse["providerToolResults"]>;
  responseFormat?: StructuredOutputRequest;
  sources: unknown[];
  structuredChunks: string[];
  structuredProviderMetadata?: Record<string, unknown>;
}

export function mapGenerateResult(
  result: LanguageModelV3GenerateResult,
  responseFormat: StructuredOutputRequest | undefined,
  helpers: GenerateResultHelpers,
  providerToolClassLookup?: ProviderToolClassLookup
): TuvrenModelResponse {
  const state: GenerateResultState = {
    parts: [],
    providerToolResults: [],
    responseFormat,
    sources: [],
    structuredChunks: [],
    structuredProviderMetadata: undefined,
  };

  for (const contentPart of result.content) {
    appendGenerateContentPart(
      contentPart,
      state,
      result,
      helpers,
      providerToolClassLookup
    );
  }

  finalizeGenerateStructuredOutput(state, result.finishReason.unified, helpers);

  const usage = helpers.mapUsage(result.usage);
  const providerMetadata = buildGenerateProviderMetadata(
    result,
    state.sources,
    usage.rawUsage
  );

  return {
    finishReason: helpers.mapFinishReason(result.finishReason, {
      hasToolCalls: state.parts.some((part) => part.type === "tool_call"),
    }),
    parts: state.parts,
    ...(state.providerToolResults.length > 0
      ? { providerToolResults: state.providerToolResults }
      : {}),
    ...(providerMetadata === undefined
      ? {}
      : {
          providerMetadata,
        }),
    ...(usage.canonical === undefined
      ? {}
      : {
          usage: usage.canonical,
        }),
  };
}

function appendGenerateContentPart(
  contentPart: LanguageModelV3GenerateResult["content"][number],
  state: GenerateResultState,
  result: LanguageModelV3GenerateResult,
  _helpers: GenerateResultHelpers,
  providerToolClassLookup?: ProviderToolClassLookup
): void {
  switch (contentPart.type) {
    case "text":
      appendGenerateTextPart(contentPart, state);
      return;
    case "reasoning":
      state.parts.push(mapGeneratedReasoningPart(contentPart));
      return;
    case "file":
      state.parts.push(mapGeneratedFilePart(contentPart));
      return;
    case "tool-call":
      state.parts.push(mapGeneratedToolCallPart(contentPart, result));
      return;
    case "tool-result": {
      if (providerToolClassLookup !== undefined) {
        const executionClass = providerToolClassLookup(contentPart.toolName);
        if (executionClass !== undefined) {
          state.providerToolResults.push(
            mapProviderNativeGenerateResult(contentPart, executionClass)
          );
          return;
        }
      }
      throw bridgeError(
        "provider-executed tool results are out of scope for the baseline AI SDK bridge",
        "unsupported_ai_sdk_content",
        {
          partType: contentPart.type,
          reason: "provider_owned_tool_result_unsupported",
          toolName: contentPart.toolName,
        }
      );
    }
    case "tool-approval-request":
      throw bridgeError(
        "provider-executed tool approvals are out of scope for the baseline AI SDK bridge",
        "unsupported_ai_sdk_content",
        {
          partType: contentPart.type,
          reason: "provider_owned_tool_approval_unsupported",
        }
      );
    case "source":
      state.sources.push(sanitizeMetadataValue(contentPart));
      return;
    default:
      throw bridgeError(
        "unsupported AI SDK content surfaced in generate result mapping",
        "unsupported_ai_sdk_content"
      );
  }
}

function mapProviderNativeGenerateResult(
  contentPart: Extract<
    LanguageModelV3GenerateResult["content"][number],
    { type: "tool-result" }
  >,
  executionClass: "provider-native" | "provider-mediated"
): NonNullable<TuvrenModelResponse["providerToolResults"]>[number] {
  const callId = randomUUID();
  const providerMetadata = sanitizeRecord(contentPart.providerMetadata);
  return {
    callId,
    executionClass,
    ...(contentPart.isError === true ? { isError: true } : {}),
    name: contentPart.toolName,
    providerCallId: contentPart.toolCallId,
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
    result: sanitizeMetadataValue(contentPart.result) ?? null,
  };
}

function appendGenerateTextPart(
  contentPart: Extract<
    LanguageModelV3GenerateResult["content"][number],
    { type: "text" }
  >,
  state: GenerateResultState
): void {
  if (state.responseFormat === undefined) {
    state.parts.push(mapGeneratedTextPart(contentPart));
    return;
  }

  state.structuredChunks.push(contentPart.text);
  state.structuredProviderMetadata = mergeProviderMetadataRecords(
    state.structuredProviderMetadata,
    sanitizeRecord(contentPart.providerMetadata)
  );
}

function mapGeneratedToolCallPart(
  contentPart: Extract<
    LanguageModelV3GenerateResult["content"][number],
    { type: "tool-call" }
  >,
  result: LanguageModelV3GenerateResult
): Extract<TuvrenModelResponse["parts"][number], { type: "tool_call" }> {
  rejectUnsupportedProviderOwnedToolPart(contentPart, {
    modelId: result.response?.modelId ?? "unknown",
    provider: "unknown",
  });
  const providerMetadata = sanitizeRecord(contentPart.providerMetadata);

  return {
    callId: randomUUID(),
    input: parseJsonInput(
      contentPart.input,
      "tool call input",
      "invalid_ai_sdk_tool_call_input"
    ),
    name: contentPart.toolName,
    providerMetadata: {
      ...(providerMetadata === undefined ? {} : providerMetadata),
      providerCallId: contentPart.toolCallId,
    },
    type: "tool_call",
  };
}

function finalizeGenerateStructuredOutput(
  state: GenerateResultState,
  finishReason: LanguageModelV3GenerateResult["finishReason"]["unified"],
  helpers: GenerateResultHelpers
): void {
  if (state.responseFormat === undefined) {
    return;
  }

  if (state.structuredChunks.length === 0) {
    if (canOmitStructuredOutputForToolCallTurn(state.parts, finishReason)) {
      return;
    }

    throw bridgeError(
      "AI SDK generate result did not include structured output text",
      "structured_output_validation"
    );
  }

  state.parts.push({
    data: helpers.parseStructuredOutput(
      state.structuredChunks.join(""),
      state.responseFormat
    ),
    ...(state.responseFormat.name === undefined
      ? {}
      : {
          name: state.responseFormat.name,
        }),
    ...(state.structuredProviderMetadata === undefined
      ? {}
      : {
          providerMetadata: state.structuredProviderMetadata,
        }),
    type: "structured",
  });
}

function canOmitStructuredOutputForToolCallTurn(
  parts: TuvrenModelResponse["parts"],
  finishReason: LanguageModelV3GenerateResult["finishReason"]["unified"]
): boolean {
  return (
    finishReason === "tool-calls" &&
    parts.some((part) => part.type === "tool_call")
  );
}

function mapGeneratedTextPart(
  contentPart: Extract<
    LanguageModelV3GenerateResult["content"][number],
    { type: "text" }
  >
): Extract<TuvrenModelResponse["parts"][number], { type: "text" }> {
  return {
    ...(contentPart.providerMetadata === undefined
      ? {}
      : {
          providerMetadata: sanitizeRecord(contentPart.providerMetadata),
        }),
    text: contentPart.text,
    type: "text",
  };
}

function mapGeneratedReasoningPart(
  contentPart: Extract<
    LanguageModelV3GenerateResult["content"][number],
    { type: "reasoning" }
  >
): Extract<TuvrenModelResponse["parts"][number], { type: "reasoning" }> {
  const providerMetadata = sanitizeRecord(contentPart.providerMetadata);

  return {
    ...(providerMetadata === undefined
      ? {}
      : {
          providerMetadata,
        }),
    redacted: isAnthropicRedactedReasoningPart(providerMetadata),
    text: contentPart.text,
    type: "reasoning",
  };
}

function isAnthropicRedactedReasoningPart(
  providerMetadata: Record<string, unknown> | undefined
): boolean {
  if (providerMetadata === undefined) {
    return false;
  }

  const anthropicMetadata = providerMetadata.anthropic;

  return (
    isPlainObject(anthropicMetadata) &&
    typeof anthropicMetadata.redactedData === "string"
  );
}

function buildGenerateProviderMetadata(
  result: LanguageModelV3GenerateResult,
  sources: unknown[],
  rawUsage: unknown
): Record<string, unknown> | undefined {
  return buildProviderMetadata({
    bridgeExtras: {
      rawUsage,
      requestBody:
        result.request?.body === undefined
          ? undefined
          : sanitizeMetadataValue(result.request.body),
      response: sanitizeGenerateResponseMetadata(result.response),
      sources,
      warnings: result.warnings.map(sanitizeMetadataValue),
    },
    providerMetadata: result.providerMetadata,
  });
}

function mapGeneratedFilePart(file: LanguageModelV3File) {
  return {
    data: cloneFileData(file.data),
    mediaType: file.mediaType,
    ...(file.providerMetadata === undefined
      ? {}
      : {
          providerMetadata: sanitizeRecord(file.providerMetadata),
        }),
    type: "file",
  } satisfies Extract<TuvrenModelResponse["parts"][number], { type: "file" }>;
}
