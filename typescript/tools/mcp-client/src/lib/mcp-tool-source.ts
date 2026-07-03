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

import {
  TuvrenProviderError,
  TuvrenValidationError,
} from "@tuvren/core/errors";
import type {
  ToolExecutionContext,
  ToolResultPart,
  TuvrenJsonSchema,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";
import { defineTool, jsonSchema } from "@tuvren/sdk";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv from "ajv";
import {
  createProviderError,
  createSdkMcpClient,
  type MCPClient,
  type McpSdkTool,
  type McpSdkToolResult,
} from "./mcp-sdk-client.js";

export type McpTransport = "stdio" | "http-sse";

export type McpAuth =
  | { kind: "bearer"; token: string }
  | { kind: "header"; name: string; value: string };

export type McpTransportConfig =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      transport: "http-sse";
      endpoint: string;
      headers?: Record<string, string>;
      auth?: McpAuth;
    };

export interface McpToolSource {
  close(): Promise<void>;
  refresh(): Promise<{ tools: TuvrenToolDefinition[] }>;
  readonly serverName: string;
  readonly tools: TuvrenToolDefinition[];
}

export type CreateMcpToolSourceOptions = McpTransportConfig & {
  name?: string;
  onError?: (error: TuvrenProviderError) => void;
  toolNameSeparator?: string;
};

type McpToolSourcePrivateOptions = CreateMcpToolSourceOptions & {
  client?: MCPClient;
};

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface TranslatedToolBinding {
  advertisedName: string;
  outputValidator?: ValidateFunction;
  publicName: string;
  tool: TuvrenToolDefinition;
}

interface SerializedProviderError {
  code: string;
  details?: unknown;
  message: string;
  name: "TuvrenProviderError";
}

const DEFAULT_TOOL_NAME_SEPARATOR = ".";

export function createMcpToolSource(
  options: CreateMcpToolSourceOptions
): Promise<McpToolSource> {
  return createMcpToolSourceInternal(options);
}

export async function createMcpToolSourceInternal(
  options: McpToolSourcePrivateOptions
): Promise<McpToolSource> {
  const client = options.client ?? createSdkMcpClient(options);
  const initialized = await client.initialize();
  const serverName = options.name ?? initialized.serverName;
  const source = new DefaultMcpToolSource(client, serverName, options);
  try {
    await source.refresh();
  } catch (error: unknown) {
    await client.close();
    throw error;
  }
  return source;
}

class DefaultMcpToolSource implements McpToolSource {
  private readonly ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  private readonly client: MCPClient;
  private readonly options: McpToolSourcePrivateOptions;
  private currentTools: TuvrenToolDefinition[] = [];

  readonly serverName: string;

  constructor(
    client: MCPClient,
    serverName: string,
    options: McpToolSourcePrivateOptions
  ) {
    this.client = client;
    this.serverName = serverName;
    this.options = options;
  }

  get tools(): TuvrenToolDefinition[] {
    return this.currentTools.map((tool) => ({ ...tool }));
  }

  async refresh(): Promise<{ tools: TuvrenToolDefinition[] }> {
    try {
      const advertisedTools = await this.client.listTools();
      const translated = advertisedTools.map((tool) =>
        this.translateTool(tool)
      );
      this.currentTools = translated.map((binding) => binding.tool);
      return { tools: this.tools };
    } catch (error: unknown) {
      throw createProviderError(
        "mcp_tool_list_failed",
        "MCP tool listing failed.",
        error
      );
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private translateTool(advertisedTool: McpSdkTool): TranslatedToolBinding {
    const inputSchema = toTuvrenJsonSchema(
      advertisedTool.inputSchema,
      `${advertisedTool.name}.inputSchema`
    );
    const inputValidator = this.compileValidator(inputSchema);
    const outputSchema =
      advertisedTool.outputSchema === undefined
        ? undefined
        : toTuvrenJsonSchema(
            advertisedTool.outputSchema,
            `${advertisedTool.name}.outputSchema`
          );
    const outputValidator =
      outputSchema === undefined
        ? undefined
        : this.compileValidator(outputSchema);
    const publicName = this.createPublicToolName(advertisedTool.name);

    return {
      advertisedName: advertisedTool.name,
      outputValidator,
      publicName,
      tool: defineTool({
        description: advertisedTool.description ?? "",
        execute: async (input, context) =>
          this.executeTool({
            advertisedName: advertisedTool.name,
            context,
            input,
            inputValidator,
            outputValidator,
            publicName,
          }),
        inputSchema: jsonSchema<unknown>(inputSchema, {
          validate: (value) => validateSchemaValue(inputValidator, value),
        }),
        metadata: {
          mcp: {
            ...(advertisedTool.annotations === undefined
              ? {}
              : { annotations: advertisedTool.annotations }),
            originalName: advertisedTool.name,
            serverName: this.serverName,
          },
        },
        name: publicName,
      }),
    };
  }

  private async executeTool(params: {
    advertisedName: string;
    context: ToolExecutionContext;
    input: unknown;
    inputValidator: ValidateFunction;
    outputValidator?: ValidateFunction;
    publicName: string;
  }): Promise<unknown> {
    const inputValidation = validateSchemaValue(
      params.inputValidator,
      params.input
    );

    if (!inputValidation.success) {
      return createErrorResult(
        params.context,
        params.publicName,
        createProviderError(
          "mcp_tool_input_invalid",
          `MCP tool "${params.publicName}" input failed validation.`,
          inputValidation.error
        )
      );
    }

    let result: McpSdkToolResult;

    try {
      result = await this.client.invokeTool(
        params.advertisedName,
        inputValidation.value
      );
    } catch (error: unknown) {
      const providerError = normalizeProviderError(error);
      this.options.onError?.(providerError);
      return createErrorResult(
        params.context,
        params.publicName,
        providerError
      );
    }

    if ("isError" in result && result.isError === true) {
      return createErrorResult(
        params.context,
        params.publicName,
        createProviderError(
          "mcp_tool_error",
          createMcpToolErrorMessage(params.publicName, result),
          undefined,
          normalizeMcpToolFailure(result)
        )
      );
    }

    const output = normalizeToolOutput(result);

    if (params.outputValidator !== undefined) {
      const outputValidation = validateSchemaValue(
        params.outputValidator,
        output
      );

      if (!outputValidation.success) {
        const providerError = createProviderError(
          "mcp_tool_output_invalid",
          `MCP tool "${params.publicName}" output failed validation.`,
          outputValidation.error
        );
        this.options.onError?.(providerError);
        return createErrorResult(
          params.context,
          params.publicName,
          providerError
        );
      }
    }

    return output;
  }

  private createPublicToolName(advertisedName: string): string {
    if (this.options.name === undefined) {
      return advertisedName;
    }

    return `${this.options.name}${
      this.options.toolNameSeparator ?? DEFAULT_TOOL_NAME_SEPARATOR
    }${advertisedName}`;
  }

  private compileValidator(schema: TuvrenJsonSchema): ValidateFunction {
    return this.ajv.compile(schema);
  }
}

function createMcpToolErrorMessage(
  toolName: string,
  result: McpSdkToolResult
): string {
  const text = readFirstTextContent(result);

  return text === undefined
    ? `MCP tool "${toolName}" returned an error result.`
    : `MCP tool "${toolName}" returned an error result: ${text}`;
}

function readFirstTextContent(result: McpSdkToolResult): string | undefined {
  if (!("content" in result && Array.isArray(result.content))) {
    return undefined;
  }

  const textContent = result.content.find(
    (part): part is { text: string; type: "text" } =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
  );

  return textContent?.text;
}

function normalizeMcpToolFailure(
  result: McpSdkToolResult
): Record<string, unknown> {
  if (!("content" in result && Array.isArray(result.content))) {
    return { isError: true };
  }

  return {
    content: result.content,
    isError: true,
  };
}

function validateSchemaValue(
  validator: ValidateFunction,
  value: unknown
):
  | { success: true; value: unknown }
  | { success: false; error: TuvrenValidationError } {
  if (validator(value)) {
    return { success: true, value };
  }

  return {
    error: new TuvrenValidationError("MCP schema validation failed.", {
      code: "invalid_mcp_schema_value",
      details: formatAjvErrors(validator.errors ?? []),
    }),
    success: false,
  };
}

function normalizeToolOutput(result: McpSdkToolResult): unknown {
  if ("structuredContent" in result && result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  if ("toolResult" in result) {
    return result.toolResult;
  }

  return {
    content: result.content,
    isError: result.isError === true,
  };
}

function createErrorResult(
  context: ToolExecutionContext,
  toolName: string,
  error: TuvrenProviderError
): ToolResultPart {
  return {
    callId: context.callId,
    isError: true,
    name: toolName,
    output: {
      error: serializeProviderError(error),
    },
    type: "tool_result",
  };
}

function normalizeProviderError(error: unknown): TuvrenProviderError {
  if (error instanceof TuvrenProviderError) {
    return error;
  }

  return createProviderError(
    "mcp_transport_failure",
    "MCP transport failed while invoking a tool.",
    error
  );
}

function serializeProviderError(
  error: TuvrenProviderError
): SerializedProviderError {
  return {
    code: error.code,
    details: error.details,
    message: error.message,
    name: "TuvrenProviderError",
  };
}

function formatAjvErrors(errors: readonly ErrorObject[]): string[] {
  return errors.map((error) => {
    const path = error.instancePath.length === 0 ? "/" : error.instancePath;
    return `${path} ${error.message ?? "failed validation"}`;
  });
}

function toTuvrenJsonSchema(value: unknown, label: string): TuvrenJsonSchema {
  if (isTuvrenJsonSchema(value)) {
    return value;
  }

  throw createProviderError(
    "mcp_tool_list_failed",
    `${label} must be JSON-serializable schema authority.`
  );
}

function isTuvrenJsonSchema(value: unknown): value is TuvrenJsonSchema {
  return typeof value === "boolean" || isJsonRecord(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonRecord(value);
}

function isJsonRecord(value: unknown): value is { [key: string]: JsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}
