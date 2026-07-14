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
  isProviderOwnedToolPart,
  mergeProviderMetadataRecords,
  parseJsonInput,
  providerOwnedToolExecutionUnsupportedError,
  sanitizeGenerateResponseMetadata,
  sanitizeMetadataValue,
  sanitizeRecord,
} from "./ai-sdk-provider-bridge-utils.js";
/** Lookup function that returns the execution class for a provider-owned tool name, or undefined if not declared. */
export type ProviderToolClassLookup = (
  toolName: string
) => "provider-native" | "provider-mediated" | undefined;

/**
 * Mapping callbacks injected by the bridge so the generate mapper shares the
 * exact finish-reason, usage, and structured-output semantics of the stream
 * path (defined once in `ai-sdk-provider-bridge.ts`).
 */
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

/** Accumulator threaded through the content-part loop of {@link mapGenerateResult}. */
interface GenerateResultState {
  parts: TuvrenModelResponse["parts"];
  providerToolResults: NonNullable<TuvrenModelResponse["providerToolResults"]>;
  responseFormat?: StructuredOutputRequest;
  sources: unknown[];
  structuredChunks: string[];
  structuredProviderMetadata?: Record<string, unknown>;
}

/**
 * Maps a complete `doGenerate` result into a `TuvrenModelResponse`
 * (KrakenFrameworkSpecification §3.1): content parts become response parts,
 * declared provider-executed tool results become `providerToolResults`
 * entries, structured output is parsed and validated when requested (§3.5),
 * and usage plus finish reason are normalized via the shared helpers.
 *
 * @param providerToolClassLookup - Resolves a tool name to its declared
 *   provider execution class; `undefined` keeps the baseline rejection of
 *   all provider-owned execution in force.
 * @throws TuvrenProviderError with code `unsupported_ai_sdk_content`,
 *   `structured_output_validation`, or `invalid_ai_sdk_tool_call_input` when
 *   the result cannot be mapped.
 */
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

/**
 * Routes one AI SDK content part into the accumulator: text (or structured
 * buffer), reasoning, file, tool-call, declared provider tool-result, or
 * source. Undeclared provider tool results and tool-approval requests are
 * rejected as out of baseline scope.
 */
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
    case "tool-call": {
      const toolCallPart = mapGeneratedToolCallPart(
        contentPart,
        result,
        providerToolClassLookup
      );
      if (toolCallPart !== undefined) {
        state.parts.push(toolCallPart);
      }
      return;
    }
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

/**
 * Maps a declared provider-executed tool result into a
 * `providerToolResults` record tagged with its execution class (AY002/AY004),
 * minting a fresh `callId` while preserving the provider's own call id.
 */
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

/**
 * Appends a text part, or in structured-output mode buffers the text (and
 * merges its provider metadata) for the final `structured` part.
 */
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

/**
 * Maps a tool-call content part to a client `tool_call` response part with a
 * fresh `callId`, parsing the call input as JSON. Declared provider-owned
 * calls are skipped (their attribution flows through the matching
 * tool-result — see the inline KRT-BH005 / ADR-055 note); undeclared
 * provider-owned calls are rejected.
 */
function mapGeneratedToolCallPart(
  contentPart: Extract<
    LanguageModelV3GenerateResult["content"][number],
    { type: "tool-call" }
  >,
  result: LanguageModelV3GenerateResult,
  providerToolClassLookup?: ProviderToolClassLookup
):
  | Extract<TuvrenModelResponse["parts"][number], { type: "tool_call" }>
  | undefined {
  // KRT-BH005 / ADR-055: a provider-executed (providerExecuted/dynamic) tool-call
  // is the provider's own record of a tool IT ran. When the host declared that
  // tool as provider-native/mediated, skip the call here — the matching
  // tool-result carries the provider-native attribution (AY002/AY004) and the
  // call must NOT contaminate the client-facing parts with a function tool_call
  // the runtime would try to execute. Undeclared provider-owned execution stays
  // out of scope for the baseline bridge (baseline protection).
  if (isProviderOwnedToolPart(contentPart)) {
    if (providerToolClassLookup?.(contentPart.toolName) !== undefined) {
      return undefined;
    }
    throw providerOwnedToolExecutionUnsupportedError(contentPart.toolName, {
      modelId: result.response?.modelId ?? "unknown",
      provider: "unknown",
    });
  }
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

/**
 * Emits the final `structured` part from the buffered structured-output
 * text. A missing structured document is tolerated only when the turn ended
 * in client tool calls (the model finishes the document on a later
 * iteration); otherwise it is a `structured_output_validation` failure.
 */
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

/**
 * Structured output may be omitted only for a `tool-calls` finish that
 * actually emitted client `tool_call` parts.
 */
function canOmitStructuredOutputForToolCallTurn(
  parts: TuvrenModelResponse["parts"],
  finishReason: LanguageModelV3GenerateResult["finishReason"]["unified"]
): boolean {
  return (
    finishReason === "tool-calls" &&
    parts.some((part) => part.type === "tool_call")
  );
}

/** Maps a text content part to a `text` response part with sanitized metadata. */
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

/**
 * Maps a reasoning content part to a `reasoning` response part, flagging
 * Anthropic redacted reasoning (`anthropic.redactedData`) as `redacted`.
 */
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

/** True when provider metadata marks the reasoning as Anthropic redacted content. */
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

/**
 * Aggregates the generate call's raw usage, request body, response metadata,
 * sources, and warnings into the response's provider metadata. Bridge extras
 * are secret-screened inside {@link buildProviderMetadata} (ADR-044).
 */
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

/** Maps a generated file to a `file` response part, cloning binary data. */
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
