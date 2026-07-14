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
  LanguageModelV3ProviderTool,
} from "@ai-sdk/provider";
import type {
  ProviderMediatedToolConfig,
  ProviderNativeToolDeclaration,
  TuvrenPrompt,
} from "@tuvren/provider-api";
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

/** A single Tuvren prompt message (KrakenFrameworkSpecification §1.2). */
type TuvrenMessage = TuvrenPrompt["messages"][number];
/** A single content part of any Tuvren message that carries a `parts` array. */
type TuvrenPromptPart = Extract<
  TuvrenMessage,
  {
    parts: unknown[];
  }
>["parts"][number];
/** A single Tuvren client function tool definition (KrakenFrameworkSpecification §8.1). */
type TuvrenToolDefinition = NonNullable<TuvrenPrompt["tools"]>[number];

/**
 * Maps the full Tuvren message list (KrakenFrameworkSpecification §1.2) into
 * an AI SDK `LanguageModelV3Prompt`. `activeProvider` drives
 * provider-specific replay behavior such as Gemini thought-signature
 * propagation.
 */
export function mapPromptMessages(
  activeProvider: string,
  messages: TuvrenPrompt["messages"]
): LanguageModelV3Prompt {
  return messages.map((message) => mapPromptMessage(activeProvider, message));
}

/**
 * Maps a `TuvrenToolDefinition` (KrakenFrameworkSpecification §8.1) to an AI
 * SDK function tool, cloning the input schema defensively.
 */
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

/**
 * Maps provider-native declarations to `LanguageModelV3ProviderTool` entries
 * (AY002).
 *
 * @throws Error when a declaration id is not in `{provider}.{tool}` format.
 */
export function mapProviderNativeToolDeclarations(
  declarations: ProviderNativeToolDeclaration[]
): LanguageModelV3ProviderTool[] {
  return declarations.map((decl) => {
    if (!decl.id.includes(".")) {
      throw new Error(
        `ProviderNativeToolDeclaration.id must be in "{provider}.{tool}" format, got: ${decl.id}`
      );
    }
    return {
      args: decl.args ?? {},
      id: decl.id as `${string}.${string}`,
      name: decl.name,
      type: "provider",
    };
  });
}

/**
 * Maps provider-mediated MCP configs to the OpenAI `openai.mcp` provider
 * tool (AY004), threading the endpoint as `server_url` plus any
 * provider-specific options.
 *
 * @throws Error when a config's `mediationType` is not `"mcp"`.
 */
export function mapProviderMediatedToolConfigs(
  configs: ProviderMediatedToolConfig[]
): LanguageModelV3ProviderTool[] {
  return configs.map((config) => {
    if (config.mediationType !== "mcp") {
      throw new Error(
        `Unsupported mediationType "${config.mediationType}": only "mcp" is supported`
      );
    }
    return {
      args: {
        server_url: config.endpoint,
        ...(config.providerOptions === undefined ? {} : config.providerOptions),
      },
      id: "openai.mcp" as `${string}.${string}`,
      name: config.name,
      type: "provider",
    };
  });
}

/**
 * Builds the declared provider tool name set for conditional acceptance of
 * provider-owned results. Includes both native and mediated tool names. (AY002/AY004)
 */
export function buildDeclaredProviderToolNames(
  providerNativeTools: ProviderNativeToolDeclaration[] | undefined,
  providerMediatedTools: ProviderMediatedToolConfig[] | undefined
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const decl of providerNativeTools ?? []) {
    names.add(decl.name);
  }
  for (const config of providerMediatedTools ?? []) {
    names.add(config.name);
  }
  return names;
}

/**
 * Returns the execution class for a given declared provider tool name
 * (`"provider-native"` before `"provider-mediated"` when both lists are
 * searched), or `undefined` when the name was never declared. Used to tag
 * provider-owned results with the correct class for attribution.
 */
export function resolveProviderToolExecutionClass(
  toolName: string,
  providerNativeTools: ProviderNativeToolDeclaration[] | undefined,
  providerMediatedTools: ProviderMediatedToolConfig[] | undefined
): "provider-native" | "provider-mediated" | undefined {
  for (const decl of providerNativeTools ?? []) {
    if (decl.name === toolName) {
      return "provider-native";
    }
  }
  for (const config of providerMediatedTools ?? []) {
    if (config.name === toolName) {
      return "provider-mediated";
    }
  }
  return undefined;
}

/**
 * Maps one Tuvren message to its AI SDK equivalent by role: `system` content
 * passes through verbatim, `user`/`tool` parts map part-by-part, and
 * `assistant` parts route through {@link mapAssistantParts} for replay
 * handling.
 *
 * @throws TuvrenProviderError with code `unsupported_ai_sdk_prompt_part` for
 *   an unrecognized message role.
 */
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

/**
 * Maps an assistant message's parts to AI SDK content, first threading
 * Gemini parallel tool-call thought signatures via
 * {@link propagateParallelToolCallThoughtSignatures} and then mapping each
 * part with {@link mapAssistantPart}.
 */
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

/**
 * For Google/Vertex-active providers, copies the first `tool_call` part's
 * Gemini `thoughtSignature` onto any sibling `tool_call` part in the same
 * assistant turn that lacks one, so replaying a parallel tool-call turn does
 * not drop the signature Gemini requires on every call in the batch.
 * Non-Google providers and turns with no signature are returned unchanged.
 */
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

/**
 * Finds the first `tool_call` part in an assistant turn that carries a
 * Gemini `thoughtSignature` (checking `google` then `vertex` provider
 * metadata namespaces), or `undefined` if none does.
 */
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

/**
 * Maps a user-message part to AI SDK content: `text` and `file` parts pass
 * through with replay `providerOptions`, and `structured` parts are
 * serialized to a `text` content entry.
 *
 * @throws TuvrenProviderError with code `unsupported_ai_sdk_prompt_part` for
 *   any other part type.
 */
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

/**
 * Maps an assistant-message part to AI SDK content: `text`, `reasoning`, and
 * `file` parts pass through with replay `providerOptions` filtered by
 * {@link mapAssistantReplayProviderOptions}; `tool_call` becomes a
 * `tool-call` content entry; `tool_result` delegates to
 * {@link mapToolResultPart}; and `structured` is serialized to a `text`
 * entry.
 *
 * @throws TuvrenProviderError with code `unsupported_ai_sdk_prompt_part` for
 *   any other part type.
 */
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

/**
 * Maps a `tool_result` part to an AI SDK `tool-result` content entry, mapping
 * its output via {@link mapToolResultOutput} and threading replay
 * `providerOptions`.
 */
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

/**
 * Classifies a tool result's output for the AI SDK's tagged `tool-result`
 * output union: string outputs become `text`/`error-text`, JSON-serializable
 * outputs become `json`/`error-json` (cloned defensively), tagged by
 * `part.isError`.
 *
 * @throws TuvrenProviderError with code `invalid_ai_sdk_tool_result_output`
 *   when the output is neither a string nor JSON-serializable.
 */
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
