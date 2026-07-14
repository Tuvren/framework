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

/** The MCP transport kind: a spawned stdio child process, or an HTTP-based server (Streamable HTTP under the hood). */
export type McpTransport = "stdio" | "http-sse";

/**
 * Credential material for an `http-sse` transport connection. Confined to
 * this package's transport edge — never copied onto a runtime surface that
 * can be observed, persisted, or replayed (README "Secret Isolation — Edge
 * Confinement", ADR-044).
 */
export type McpAuth =
  | { kind: "bearer"; token: string }
  | { kind: "header"; name: string; value: string };

/**
 * Transport-specific connection settings for {@link createMcpToolSource}.
 * `stdio` spawns a child process; `http-sse` connects to a URL over
 * Streamable HTTP. Any `env`/`headers`/`auth` values here are secret-bearing
 * transport material and are subject to the same edge-confinement guarantee
 * as {@link McpAuth}.
 */
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

/**
 * A live connection to one MCP server, exposing its tools as Tuvren tool
 * definitions. Returned by {@link createMcpToolSource}.
 */
export interface McpToolSource {
  /** Closes the underlying MCP transport/connection. */
  close(): Promise<void>;
  /** Re-lists the server's tools and replaces {@link tools} with the refreshed set. */
  refresh(): Promise<{ tools: TuvrenToolDefinition[] }>;
  /** The connected server's advertised name, or the `name` option override. */
  readonly serverName: string;
  /** The current set of translated Tuvren tool definitions (a defensive copy). */
  readonly tools: TuvrenToolDefinition[];
}

/**
 * Options for {@link createMcpToolSource}.
 */
export type CreateMcpToolSourceOptions = McpTransportConfig & {
  /**
   * Prefixes every tool name as `{name}{toolNameSeparator}{originalName}`
   * (e.g. `"docs.search"`), and overrides {@link McpToolSource.serverName}.
   * Without a `name`, tools keep the server's advertised names unprefixed.
   */
  name?: string;
  /** Called with the normalized provider error whenever a tool invocation fails after listing succeeds. */
  onError?: (error: TuvrenProviderError) => void;
  /** Separator used between `name` and the original tool name; defaults to `"."`. */
  toolNameSeparator?: string;
};

/** {@link CreateMcpToolSourceOptions} plus a test-only client injection point used by {@link createMcpToolSourceInternal}. */
type McpToolSourcePrivateOptions = CreateMcpToolSourceOptions & {
  client?: MCPClient;
};

/** Any JSON-serializable value: primitive, `null`, array, or object thereof. */
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The public/advertised name pairing and compiled output validator produced for one translated MCP tool. */
interface TranslatedToolBinding {
  advertisedName: string;
  outputValidator?: ValidateFunction;
  publicName: string;
  tool: TuvrenToolDefinition;
}

/** The JSON-safe shape a `TuvrenProviderError` is serialized to inside a `tool_result` error output. */
interface SerializedProviderError {
  code: string;
  details?: unknown;
  message: string;
  name: "TuvrenProviderError";
}

/** Default separator between a source's `name` and a tool's original name. */
const DEFAULT_TOOL_NAME_SEPARATOR = ".";

/**
 * Connects to an MCP server (§ README) and lists its tools as an
 * {@link McpToolSource}: the entry point host code uses to add MCP tools to a
 * Tuvren agent.
 *
 * @throws TuvrenProviderError with code `mcp_initialize_failed` or
 *   `mcp_tool_list_failed` when connecting or the initial tool listing fails.
 */
export function createMcpToolSource(
  options: CreateMcpToolSourceOptions
): Promise<McpToolSource> {
  return createMcpToolSourceInternal(options);
}

/**
 * Implementation behind {@link createMcpToolSource}, extended with a
 * test-only `client` injection point so tests can substitute a fake
 * `MCPClient` without a real MCP server.
 *
 * @throws TuvrenProviderError with code `mcp_initialize_failed` or
 *   `mcp_tool_list_failed` when connecting or the initial tool listing fails;
 *   the client is closed before the error propagates.
 */
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

/**
 * Default {@link McpToolSource} implementation: lists an MCP server's tools,
 * translates each into a Tuvren tool definition with Ajv-validated
 * input/output schemas, and dispatches invocations through the underlying
 * {@link MCPClient}.
 */
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

  /**
   * Re-lists the server's tools, replaces the translated tool set, and
   * returns a defensive copy.
   *
   * @throws TuvrenProviderError with code `mcp_tool_list_failed` when
   *   listing fails.
   */
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

  /** Closes the underlying MCP transport/connection. */
  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Translates one MCP-advertised tool into a Tuvren tool definition:
   * compiles Ajv validators for its input/output JSON schemas, computes its
   * public name via {@link createPublicToolName}, and wires `execute` to
   * {@link executeTool}. The original name and server name are preserved
   * under `metadata.mcp` for host introspection.
   */
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

  /**
   * Executes one MCP tool call: validates the input against the tool's
   * advertised input schema, invokes it through the underlying
   * {@link MCPClient}, and on success validates the output against the
   * advertised output schema (when declared). Every failure path (input
   * validation, transport, server-reported tool error, output validation)
   * is normalized into a `tool_result` with `isError: true` rather than
   * thrown, so a single bad tool call cannot fail the whole agent turn;
   * transport and output-validation failures are also reported through
   * `onError` before being returned.
   */
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

  /**
   * Builds the tool's public-facing name: the advertised name unprefixed
   * when no `name` option was given, or `{name}{separator}{advertisedName}`
   * otherwise.
   */
  private createPublicToolName(advertisedName: string): string {
    if (this.options.name === undefined) {
      return advertisedName;
    }

    return `${this.options.name}${
      this.options.toolNameSeparator ?? DEFAULT_TOOL_NAME_SEPARATOR
    }${advertisedName}`;
  }

  /** Compiles an Ajv validator for one JSON Schema. */
  private compileValidator(schema: TuvrenJsonSchema): ValidateFunction {
    return this.ajv.compile(schema);
  }
}

/** Builds a human-readable message for a server-reported tool error, including its first text content part if present. */
function createMcpToolErrorMessage(
  toolName: string,
  result: McpSdkToolResult
): string {
  const text = readFirstTextContent(result);

  return text === undefined
    ? `MCP tool "${toolName}" returned an error result.`
    : `MCP tool "${toolName}" returned an error result: ${text}`;
}

/** Returns the first `text`-type content part's text from a tool result, if any. */
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

/** Extracts the error details attached to a server-reported tool failure, for the thrown provider error's `details`. */
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

/** Runs a compiled Ajv validator against a value, returning a success/failure result instead of throwing. */
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

/**
 * Picks a tool result's output value in priority order: `structuredContent`
 * (schema-validated output) when present, then the legacy `toolResult`
 * field, else the raw `content`/`isError` shape.
 */
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

/** Builds an `isError: true` `tool_result` part carrying a serialized provider error, in place of throwing. */
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

/** Passes an existing `TuvrenProviderError` through unchanged; wraps anything else as `mcp_transport_failure`. */
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

/** Reduces a `TuvrenProviderError` to the JSON-safe shape stored in a `tool_result` error output. */
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

/** Formats Ajv validation errors as `"{instancePath or '/'} {message}"` strings. */
function formatAjvErrors(errors: readonly ErrorObject[]): string[] {
  return errors.map((error) => {
    const path = error.instancePath.length === 0 ? "/" : error.instancePath;
    return `${path} ${error.message ?? "failed validation"}`;
  });
}

/**
 * Narrows an MCP-advertised schema to a `TuvrenJsonSchema`.
 *
 * @throws TuvrenProviderError with code `mcp_tool_list_failed` when the
 *   value is not a boolean or JSON-serializable object.
 */
function toTuvrenJsonSchema(value: unknown, label: string): TuvrenJsonSchema {
  if (isTuvrenJsonSchema(value)) {
    return value;
  }

  throw createProviderError(
    "mcp_tool_list_failed",
    `${label} must be JSON-serializable schema authority.`
  );
}

/** True for a boolean JSON Schema or a JSON-serializable object schema. */
function isTuvrenJsonSchema(value: unknown): value is TuvrenJsonSchema {
  return typeof value === "boolean" || isJsonRecord(value);
}

/** Recursive JSON-value predicate. */
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

/** True for a non-array object whose own values are all JSON values. */
function isJsonRecord(value: unknown): value is { [key: string]: JsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}
