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
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import type { TuvrenPrompt } from "@tuvren/provider-api";
import {
  bridgeError,
  cloneFileData,
  cloneJsonSchema,
  cloneMetadataValue,
  isJsonValue,
  isPlainObject,
  mapAssistantReplayProviderOptions,
  mapPromptProviderOptions,
  mergePromptProviderNamespace,
  sanitizeRecord,
} from "./ai-sdk-provider-bridge-utils.js";

type TuvrenMessage = TuvrenPrompt["messages"][number];
type TuvrenPromptPart = Extract<
  TuvrenMessage,
  {
    parts: unknown[];
  }
>["parts"][number];
type TuvrenToolDefinition = NonNullable<TuvrenPrompt["tools"]>[number];

export function mapPromptMessages(
  activeProvider: string,
  messages: TuvrenPrompt["messages"]
): LanguageModelV3Prompt {
  return messages.map((message) => mapPromptMessage(activeProvider, message));
}

export function mapToolDefinition(
  tool: TuvrenToolDefinition
): LanguageModelV3FunctionTool {
  return {
    description: tool.description,
    inputSchema: cloneJsonSchema(tool.inputSchema),
    name: tool.name,
    type: "function",
  };
}

function mapPromptMessage(
  activeProvider: string,
  message: TuvrenMessage
): LanguageModelV3Message {
  switch (message.role) {
    case "system":
      return {
        content: message.content,
        role: "system",
      };
    case "user":
      return {
        content: message.parts.map((part) => mapUserPart(part)),
        role: "user",
      };
    case "assistant":
      return {
        content: mapAssistantParts(activeProvider, message.parts),
        role: "assistant",
      };
    case "tool":
      return {
        content: message.parts.map((part) => mapToolResultPart(part)),
        role: "tool",
      };
    default:
      throw bridgeError(
        "unsupported Tuvren message role in AI SDK prompt mapping",
        "unsupported_ai_sdk_prompt_part",
        {
          role: (message as { role?: unknown }).role,
        }
      );
  }
}

function mapAssistantParts(
  activeProvider: string,
  parts: Extract<TuvrenMessage, { role: "assistant" }>["parts"]
): Extract<LanguageModelV3Message, { role: "assistant" }>["content"] {
  const propagatedParts = propagateParallelToolCallThoughtSignatures(
    activeProvider,
    parts
  );

  return propagatedParts.map((part) => mapAssistantPart(activeProvider, part));
}

function propagateParallelToolCallThoughtSignatures(
  activeProvider: string,
  parts: Extract<TuvrenMessage, { role: "assistant" }>["parts"]
): Extract<TuvrenMessage, { role: "assistant" }>["parts"] {
  if (
    !(activeProvider.includes("google") || activeProvider.includes("vertex"))
  ) {
    return parts;
  }

  const signature = readFirstGoogleToolCallThoughtSignature(parts);

  if (signature === undefined) {
    return parts;
  }

  return parts.map((part) => {
    if (part.type !== "tool_call") {
      return part;
    }

    const providerMetadata = sanitizeRecord(part.providerMetadata);
    const googleNamespace = activeProvider.includes("vertex")
      ? "vertex"
      : "google";
    const existingNamespace = providerMetadata?.[googleNamespace];

    if (
      isPlainObject(existingNamespace) &&
      typeof existingNamespace.thoughtSignature === "string"
    ) {
      return part;
    }

    return {
      ...part,
      providerMetadata: {
        ...(providerMetadata === undefined ? {} : providerMetadata),
        [googleNamespace]: mergePromptProviderNamespace(
          providerMetadata?.[googleNamespace],
          {
            thoughtSignature: signature,
          }
        ),
      },
    };
  }) as Extract<TuvrenMessage, { role: "assistant" }>["parts"];
}

function readFirstGoogleToolCallThoughtSignature(
  parts: Extract<TuvrenMessage, { role: "assistant" }>["parts"]
): string | undefined {
  for (const part of parts) {
    if (part.type !== "tool_call") {
      continue;
    }

    const providerMetadata = sanitizeRecord(part.providerMetadata);
    const googleMetadata = providerMetadata?.google;
    const vertexMetadata = providerMetadata?.vertex;

    if (
      isPlainObject(googleMetadata) &&
      typeof googleMetadata.thoughtSignature === "string"
    ) {
      return googleMetadata.thoughtSignature;
    }

    if (
      isPlainObject(vertexMetadata) &&
      typeof vertexMetadata.thoughtSignature === "string"
    ) {
      return vertexMetadata.thoughtSignature;
    }
  }

  return undefined;
}

function mapUserPart(part: TuvrenPromptPart) {
  switch (part.type) {
    case "text": {
      const providerOptions = mapPromptProviderOptions(part.providerMetadata);

      return {
        ...(providerOptions === undefined
          ? {}
          : {
              providerOptions,
            }),
        text: part.text,
        type: "text",
      } satisfies Extract<
        LanguageModelV3Message["content"][number],
        { type: "text" }
      >;
    }
    case "file": {
      const providerOptions = mapPromptProviderOptions(part.providerMetadata);

      return {
        data: cloneFileData(part.data),
        ...(typeof part.filename === "string"
          ? {
              filename: part.filename,
            }
          : {}),
        mediaType: part.mediaType,
        ...(providerOptions === undefined
          ? {}
          : {
              providerOptions,
            }),
        type: "file",
      } satisfies Extract<
        LanguageModelV3Message["content"][number],
        { type: "file" }
      >;
    }
    case "structured": {
      const providerOptions = mapPromptProviderOptions(part.providerMetadata);

      return {
        ...(providerOptions === undefined
          ? {}
          : {
              providerOptions,
            }),
        text: JSON.stringify(part.data),
        type: "text",
      } satisfies Extract<
        LanguageModelV3Message["content"][number],
        { type: "text" }
      >;
    }
    default:
      throw bridgeError(
        "user messages only support text, file, and structured parts in the AI SDK bridge baseline",
        "unsupported_ai_sdk_prompt_part",
        {
          partType: part.type,
          role: "user",
        }
      );
  }
}

function mapAssistantPart(activeProvider: string, part: TuvrenPromptPart) {
  switch (part.type) {
    case "text": {
      const providerOptions = mapAssistantReplayProviderOptions(
        activeProvider,
        part
      );

      return {
        ...(providerOptions === undefined
          ? {}
          : {
              providerOptions,
            }),
        text: part.text,
        type: "text",
      } satisfies Extract<
        LanguageModelV3Message["content"][number],
        { type: "text" }
      >;
    }
    case "reasoning": {
      const providerOptions = mapAssistantReplayProviderOptions(
        activeProvider,
        part
      );

      return {
        ...(providerOptions === undefined
          ? {}
          : {
              providerOptions,
            }),
        text: part.text,
        type: "reasoning",
      } satisfies Extract<
        LanguageModelV3Message["content"][number],
        { type: "reasoning" }
      >;
    }
    case "file": {
      const providerOptions = mapAssistantReplayProviderOptions(
        activeProvider,
        part
      );

      return {
        data: cloneFileData(part.data),
        ...(typeof part.filename === "string"
          ? {
              filename: part.filename,
            }
          : {}),
        mediaType: part.mediaType,
        ...(providerOptions === undefined
          ? {}
          : {
              providerOptions,
            }),
        type: "file",
      } satisfies Extract<
        LanguageModelV3Message["content"][number],
        { type: "file" }
      >;
    }
    case "tool_call": {
      const providerOptions = mapAssistantReplayProviderOptions(
        activeProvider,
        part
      );

      return {
        input: cloneMetadataValue(part.input),
        ...(providerOptions === undefined
          ? {}
          : {
              providerOptions,
            }),
        toolCallId: part.callId,
        toolName: part.name,
        type: "tool-call",
      } satisfies Extract<
        LanguageModelV3Message["content"][number],
        { type: "tool-call" }
      >;
    }
    case "tool_result":
      return mapToolResultPart(part);
    case "structured": {
      const providerOptions = mapAssistantReplayProviderOptions(
        activeProvider,
        part
      );

      return {
        ...(providerOptions === undefined
          ? {}
          : {
              providerOptions,
            }),
        text: JSON.stringify(part.data),
        type: "text",
      } satisfies Extract<
        LanguageModelV3Message["content"][number],
        { type: "text" }
      >;
    }
    default:
      throw bridgeError(
        "assistant messages contain a part that the AI SDK bridge baseline does not support",
        "unsupported_ai_sdk_prompt_part",
        {
          role: "assistant",
        }
      );
  }
}

function mapToolResultPart(
  part: Extract<TuvrenPromptPart, { type: "tool_result" }>
) {
  const providerOptions = mapPromptProviderOptions(part.providerMetadata);

  return {
    output: mapToolResultOutput(part),
    ...(providerOptions === undefined
      ? {}
      : {
          providerOptions,
        }),
    toolCallId: part.callId,
    toolName: part.name,
    type: "tool-result",
  } satisfies Extract<
    LanguageModelV3Message["content"][number],
    { type: "tool-result" }
  >;
}

function mapToolResultOutput(
  part: Extract<TuvrenPromptPart, { type: "tool_result" }>
) {
  if (typeof part.output === "string") {
    return {
      type: part.isError === true ? "error-text" : "text",
      value: part.output,
    } as const;
  }

  if (isJsonValue(part.output)) {
    return {
      type: part.isError === true ? "error-json" : "json",
      value: cloneMetadataValue(part.output),
    } as const;
  }

  throw bridgeError(
    "tool result output must be string or JSON-serializable to cross the AI SDK bridge baseline",
    "invalid_ai_sdk_tool_result_output",
    {
      toolName: part.name,
    }
  );
}
