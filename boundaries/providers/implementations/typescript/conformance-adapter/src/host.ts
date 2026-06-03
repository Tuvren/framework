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
import { TuvrenProviderError } from "@tuvren/core";
import type { ToolExecutionContext, ToolResultPart } from "@tuvren/core/tools";
import {
  assertProviderStreamChunk,
  assertTuvrenModelResponse,
  type ProviderStreamChunk,
  type StructuredOutputRequest,
} from "@tuvren/provider-api";
import {
  createOfficialMcpEverythingStdioCommand,
  startMockMcpHttpServer,
  startOfficialMcpEverythingStreamableHttpServer,
} from "@tuvren/provider-testkit";
import type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { createAdapterErrorEnvelope } from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { serveStdioAdapter } from "../../../../../../tools/conformance/adapter-protocol/stdio-host.js";
import { createAiSdkProviderBridge } from "../../bridge-ai-sdk/src/index.ts";
import { createMcpToolSource } from "../../mcp-client/src/index.ts";
import type { MCPClient } from "../../mcp-client/src/lib/mcp-sdk-client.ts";
import { createMcpToolSourceInternal } from "../../mcp-client/src/lib/mcp-tool-source.ts";
import { providerConformanceFixtures } from "./provider-conformance-fixtures.ts";
import { runProviderMediatedAttribution } from "./provider-mediated-execution-class.ts";
import { runProviderNativeAttribution } from "./provider-native-execution-class.ts";

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
        "providers.framework-owned-approval-boundary",
        "providers.framework-owned-tool-execution",
        "providers.mcp-client",
        "providers.rejects-native-strict-structured-output",
        "providers.provider-native-execution-class",
        "providers.provider-mediated-execution-class",
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
        case "providers.bridge.strict-structured-output-rejection":
          return result(await strictStructuredOutputRejection());
        case "providers.bridge.provider-owned-tool-result-rejection":
          return result(await providerOwnedToolResultRejection());
        case "providers.bridge.provider-owned-tool-execution-rejection":
          return result(await providerOwnedToolExecutionRejection());
        case "providers.bridge.provider-approval-request-rejection":
          return result(await providerApprovalRequestRejection());
        case "providers.mcp-client.translation-rules":
          return result(await mcpClientTranslationRules());
        case "providers.mcp-client.auth-headers":
          return result(await mcpClientAuthHeaders());
        case "providers.mcp-client.validation-errors":
          return result(await mcpClientValidationErrors());
        case "providers.mcp-client.transport-error-normalization":
          return result(await mcpClientTransportErrorNormalization());
        case "providers.provider-native.attribution":
          return result(await runProviderNativeAttribution());
        case "providers.provider-mediated.attribution":
          return result(await runProviderMediatedAttribution());
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
  const response = await bridge.generate(
    providerConformanceFixtures.structuredPrompt
  );
  assertTuvrenModelResponse(
    response,
    "providers.bridge.generate-mapping generate response"
  );
  const providerMetadata = isRecord(response.providerMetadata)
    ? response.providerMetadata
    : {};

  return createProjection({
    generate: {
      providerMetadataKeys: Object.keys(providerMetadata),
      responseFormatName:
        capturedOptions?.responseFormat?.type === "json"
          ? capturedOptions.responseFormat.name
          : undefined,
      responseFormatType: capturedOptions?.responseFormat?.type,
      responsePartTypes: response.parts.map((part) => part.type),
    },
  });
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
  const chunks = await collectProviderStreamChunks(
    bridge.stream(providerConformanceFixtures.toolPrompt)
  );
  const finishChunk = findFinishChunk(chunks, "tool_call");

  return createProjection({
    stream: {
      chunkTypes: chunks.map((chunk) => chunk.type),
      finishMetadataKeys: isRecord(finishChunk.providerMetadata)
        ? Object.keys(finishChunk.providerMetadata)
        : [],
    },
  });
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
  const chunks = await collectProviderStreamChunks(
    bridge.stream(providerConformanceFixtures.structuredPrompt)
  );
  const structuredDoneChunk = findStructuredDoneChunk(chunks, "answer");

  return createProjection({
    structured: {
      chunkTypes: chunks.map((chunk) => chunk.type),
      doneName: structuredDoneChunk.name,
    },
  });
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
  const error = await collectProviderOperationError(() =>
    bridge.generate(providerConformanceFixtures.prompt)
  );

  return createProjection({
    failure: {
      errorCode: error instanceof TuvrenProviderError ? error.code : "unknown",
      errorName:
        error instanceof TuvrenProviderError
          ? "TuvrenProviderError"
          : error.constructor.name,
    },
  });
}

async function strictStructuredOutputRejection(): Promise<
  Record<string, unknown>
> {
  let generateCalls = 0;
  let streamCalls = 0;
  const responseFormat = readStructuredResponseFormat();
  const generateBridge = createAiSdkProviderBridge({
    model: createMockModel({
      doGenerate() {
        generateCalls += 1;
        return Promise.resolve(createGenerateResult());
      },
    }),
  });
  const generateError = await collectProviderOperationError(async () => {
    await generateBridge.generate({
      ...providerConformanceFixtures.structuredPrompt,
      responseFormat: {
        ...responseFormat,
        strict: true,
      },
    });
  });
  const streamBridge = createAiSdkProviderBridge({
    model: createMockModel({
      doStream() {
        streamCalls += 1;
        return Promise.resolve({
          stream: streamFromParts([]),
        });
      },
    }),
  });
  const streamError = await collectProviderOperationError(async () => {
    await collectProviderStreamChunks(
      streamBridge.stream({
        ...providerConformanceFixtures.structuredPrompt,
        responseFormat: {
          ...responseFormat,
          strict: true,
        },
      })
    );
  });

  return createProjection({
    strictStructuredOutput: {
      generateCalls,
      generateErrorCode:
        generateError instanceof TuvrenProviderError
          ? generateError.code
          : "unknown",
      generateErrorReason: readProviderErrorReason(generateError),
      streamCalls,
      streamErrorCode:
        streamError instanceof TuvrenProviderError
          ? streamError.code
          : "unknown",
      streamErrorReason: readProviderErrorReason(streamError),
    },
  });
}

async function providerOwnedToolExecutionRejection(): Promise<
  Record<string, unknown>
> {
  const generateBridge = createAiSdkProviderBridge({
    model: createMockModel({
      doGenerate() {
        return Promise.resolve(
          createGenerateResult({
            content: [
              {
                input: '{"query":"docs"}',
                providerExecuted: true,
                toolCallId: "provider-tool-call-1",
                toolName: "search",
                type: "tool-call",
              },
            ],
          })
        );
      },
    }),
  });
  const generateError = await collectProviderOperationError(async () => {
    await generateBridge.generate(providerConformanceFixtures.toolPrompt);
  });
  const streamBridge = createAiSdkProviderBridge({
    model: createMockModel({
      doStream() {
        return Promise.resolve({
          stream: streamFromParts([
            {
              id: "provider-tool-call-1",
              providerExecuted: true,
              toolName: "search",
              type: "tool-input-start",
            },
          ]),
        });
      },
    }),
  });
  const streamError = await collectProviderOperationError(async () => {
    await collectProviderStreamChunks(
      streamBridge.stream(providerConformanceFixtures.toolPrompt)
    );
  });

  return createProjection({
    frameworkOwnedToolExecution: {
      generateErrorCode:
        generateError instanceof TuvrenProviderError
          ? generateError.code
          : "unknown",
      generateErrorReason: readProviderErrorReason(generateError),
      streamErrorCode:
        streamError instanceof TuvrenProviderError
          ? streamError.code
          : "unknown",
      streamErrorReason: readProviderErrorReason(streamError),
    },
  });
}

async function providerOwnedToolResultRejection(): Promise<
  Record<string, unknown>
> {
  let generateResolved = false;
  let streamChunkCount = 0;
  const generateBridge = createAiSdkProviderBridge({
    model: createMockModel({
      doGenerate() {
        return Promise.resolve(
          createGenerateResult({
            content: [
              {
                result: {
                  status: "done",
                },
                toolCallId: "provider-tool-call-1",
                toolName: "search",
                type: "tool-result",
              },
            ],
          })
        );
      },
    }),
  });
  const generateError = await collectProviderOperationError(async () => {
    await generateBridge.generate(providerConformanceFixtures.toolPrompt);
    generateResolved = true;
  });
  const streamBridge = createAiSdkProviderBridge({
    model: createMockModel({
      doStream() {
        return Promise.resolve({
          stream: streamFromParts([
            {
              result: {
                ok: true,
              },
              toolCallId: "provider-tool-call-1",
              toolName: "search",
              type: "tool-result",
            },
          ]),
        });
      },
    }),
  });
  const streamError = await collectProviderOperationError(async () => {
    for await (const _chunk of streamBridge.stream(
      providerConformanceFixtures.toolPrompt
    )) {
      streamChunkCount += 1;
    }
  });

  return createProjection({
    frameworkOwnedToolResultBoundary: {
      generateErrorCode:
        generateError instanceof TuvrenProviderError
          ? generateError.code
          : "unknown",
      generateErrorReason: readProviderErrorReason(generateError),
      generateResolved,
      streamChunkCount,
      streamErrorCode:
        streamError instanceof TuvrenProviderError
          ? streamError.code
          : "unknown",
      streamErrorReason: readProviderErrorReason(streamError),
    },
  });
}

async function providerApprovalRequestRejection(): Promise<
  Record<string, unknown>
> {
  const bridge = createAiSdkProviderBridge({
    model: createMockModel({
      doStream() {
        return Promise.resolve({
          stream: streamFromParts([
            {
              approvalId: "approval-1",
              toolCallId: "provider-tool-call-1",
              type: "tool-approval-request",
            },
          ]),
        });
      },
    }),
  });
  const error = await collectProviderOperationError(async () => {
    await collectProviderStreamChunks(
      bridge.stream(providerConformanceFixtures.toolPrompt)
    );
  });

  return createProjection({
    frameworkOwnedApprovalBoundary: {
      errorCode: error instanceof TuvrenProviderError ? error.code : "unknown",
      errorReason: readProviderErrorReason(error),
    },
  });
}

async function mcpClientTranslationRules(): Promise<Record<string, unknown>> {
  const stdio = createOfficialMcpEverythingStdioCommand();
  const httpServer = await startOfficialMcpEverythingStreamableHttpServer();
  const stdioSource = await createMcpToolSource({
    ...stdio,
    name: "mcp",
    transport: "stdio",
  });
  const httpSource = await createMcpToolSource({
    endpoint: httpServer.endpoint,
    name: "mcp",
    transport: "http-sse",
  });

  try {
    const stdioProjection = await projectMcpToolSource(stdioSource.tools);
    const httpProjection = await projectMcpToolSource(httpSource.tools);

    return createProjection({
      mcpClient: {
        http: httpProjection,
        parity: {
          echoOutputEqual:
            JSON.stringify(stdioProjection.echoOutput) ===
            JSON.stringify(httpProjection.echoOutput),
          structuredOutputEqual:
            JSON.stringify(stdioProjection.structuredOutput) ===
            JSON.stringify(httpProjection.structuredOutput),
          toolNamesEqual:
            JSON.stringify(stdioProjection.toolNames) ===
            JSON.stringify(httpProjection.toolNames),
        },
        stdio: stdioProjection,
      },
    });
  } finally {
    await stdioSource.close();
    await httpSource.close();
    await httpServer.close();
  }
}

async function mcpClientAuthHeaders(): Promise<Record<string, unknown>> {
  const server = await startMockMcpHttpServer({
    requireHeaders: {
      authorization: "Bearer conformance-token",
      "x-mcp-conformance": "enabled",
    },
  });
  const source = await createMcpToolSource({
    auth: { kind: "bearer", token: "conformance-token" },
    endpoint: server.endpoint,
    headers: { "x-mcp-conformance": "enabled" },
    name: "auth",
    transport: "http-sse",
  });

  try {
    const echo = requireMcpTool(source.tools, "auth.echo");
    const output = await echo.execute(
      { message: "headers" },
      createToolContext("mcp-auth", "auth.echo")
    );

    return createProjection({
      mcpClient: {
        auth: {
          output,
          succeeded: true,
        },
      },
    });
  } finally {
    await source.close();
    await server.close();
  }
}

async function mcpClientValidationErrors(): Promise<Record<string, unknown>> {
  const command = createOfficialMcpEverythingStdioCommand();
  const source = await createMcpToolSource({
    ...command,
    name: "validating",
    transport: "stdio",
  });
  const invalidSource = await createMcpToolSourceInternal({
    client: createInvalidStructuredOutputMcpClient(),
    command: "unused",
    name: "invalid",
    transport: "stdio",
  });

  try {
    const sum = requireMcpTool(source.tools, "validating.get-sum");
    const inputError = asToolResultPart(
      await sum.execute(
        { a: "one", b: 2 },
        createToolContext("mcp-input", "validating.get-sum")
      )
    );
    const echo = requireMcpTool(invalidSource.tools, "invalid.echo");
    const outputError = asToolResultPart(
      await echo.execute(
        { message: "bad-output" },
        createToolContext("mcp-output", "invalid.echo")
      )
    );

    return createProjection({
      mcpClient: {
        validation: {
          inputErrorCode: readToolErrorCode(inputError),
          inputIsError: inputError.isError === true,
          outputErrorCode: readToolErrorCode(outputError),
          outputIsError: outputError.isError === true,
        },
      },
    });
  } finally {
    await source.close();
    await invalidSource.close();
  }
}

async function mcpClientTransportErrorNormalization(): Promise<
  Record<string, unknown>
> {
  const server = await startMockMcpHttpServer({
    failToolCallsWithTransportClose: true,
  });
  const observedErrors: TuvrenProviderError[] = [];
  const source = await createMcpToolSource({
    endpoint: server.endpoint,
    name: "failure",
    onError(error) {
      observedErrors.push(error);
    },
    transport: "http-sse",
  });

  try {
    const echo = requireMcpTool(source.tools, "failure.echo");
    const resultPart = asToolResultPart(
      await echo.execute(
        { message: "boom" },
        createToolContext("mcp-transport", "failure.echo")
      )
    );

    return createProjection({
      mcpClient: {
        transportFailure: {
          errorCode: readToolErrorCode(resultPart),
          isError: resultPart.isError === true,
          observedErrorCount: observedErrors.length,
        },
      },
    });
  } finally {
    await source.close();
    await server.close();
  }
}

async function projectMcpToolSource(
  tools: readonly {
    description: string;
    execute: (
      input: unknown,
      context: ToolExecutionContext
    ) => Promise<unknown> | unknown;
    inputSchema: unknown;
    metadata?: Record<string, unknown>;
    name: string;
  }[]
): Promise<Record<string, unknown>> {
  const echo = requireMcpTool(tools, "mcp.echo");
  const structured = requireMcpTool(tools, "mcp.get-structured-content");
  const echoOutput = await echo.execute(
    { message: "hello" },
    createToolContext("mcp-echo", "mcp.echo")
  );
  const structuredOutput = await structured.execute(
    { location: "Chicago" },
    createToolContext("mcp-structured", "mcp.get-structured-content")
  );

  return {
    echoDescription: echo.description,
    echoInputSchemaType: readInputSchemaType(echo.inputSchema),
    echoMetadataOriginalName: readMcpOriginalName(echo.metadata),
    echoOutput,
    structuredOutput,
    toolNames: tools.map((tool) => tool.name).sort(),
  };
}

function requireMcpTool<
  T extends {
    execute: (
      input: unknown,
      context: ToolExecutionContext
    ) => Promise<unknown> | unknown;
    name: string;
  },
>(tools: readonly T[], name: string): T {
  const tool = tools.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    throw new Error(`missing MCP tool ${name}`);
  }

  return tool;
}

function createToolContext(callId: string, name: string): ToolExecutionContext {
  return { callId, name };
}

function asToolResultPart(value: unknown): ToolResultPart {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "tool_result"
  ) {
    return value as ToolResultPart;
  }

  throw new Error("expected MCP tool result part");
}

function readToolErrorCode(part: ToolResultPart): string | undefined {
  if (!isRecord(part.output)) {
    return undefined;
  }

  const error = part.output.error;

  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

function readInputSchemaType(schema: unknown): unknown {
  if (
    typeof schema === "object" &&
    schema !== null &&
    "toJSONSchema" in schema &&
    typeof schema.toJSONSchema === "function"
  ) {
    const jsonSchema = schema.toJSONSchema();
    return isRecord(jsonSchema) ? jsonSchema.type : undefined;
  }

  return isRecord(schema) ? schema.type : undefined;
}

function readMcpOriginalName(metadata: unknown): string | undefined {
  if (!(isRecord(metadata) && isRecord(metadata.mcp))) {
    return undefined;
  }

  return typeof metadata.mcp.originalName === "string"
    ? metadata.mcp.originalName
    : undefined;
}

function createInvalidStructuredOutputMcpClient(): MCPClient {
  return {
    close() {
      return Promise.resolve();
    },
    initialize() {
      return Promise.resolve({ serverName: "invalid-output" });
    },
    invokeTool() {
      return Promise.resolve({
        content: [{ text: "bad structured output", type: "text" }],
        structuredContent: { echoed: 123 },
      });
    },
    listTools() {
      return Promise.resolve([
        {
          description: "Returns invalid structured output.",
          inputSchema: {
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
            type: "object",
          },
          name: "echo",
          outputSchema: {
            properties: {
              echoed: { type: "string" },
            },
            required: ["echoed"],
            type: "object",
          },
        },
      ]);
    },
  };
}

function result(value: Record<string, unknown>): OperationOutcome {
  return {
    kind: "result",
    value,
  };
}

function createProjection<T extends Record<string, unknown>>(
  evidence: T
): Record<string, unknown> {
  return {
    evidence,
    result: evidence,
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

async function collectProviderStreamChunks(
  stream: AsyncIterable<ProviderStreamChunk>
): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = [];
  let index = 0;

  for await (const chunk of stream) {
    assertProviderStreamChunk(chunk, `provider stream chunk ${index}`);
    chunks.push(structuredClone(chunk));
    index += 1;
  }

  return chunks;
}

async function collectProviderOperationError(
  run: () => Promise<unknown> | unknown
): Promise<Error> {
  try {
    await run();
  } catch (error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  }

  throw new Error("provider operation did not fail");
}

function findFinishChunk(
  chunks: readonly ProviderStreamChunk[],
  expected: "tool_call" | "stop"
): Extract<ProviderStreamChunk, { type: "finish" }> {
  const finishChunk = chunks.find(
    (chunk): chunk is Extract<ProviderStreamChunk, { type: "finish" }> =>
      chunk.type === "finish"
  );

  if (finishChunk === undefined) {
    throw new Error("provider stream did not emit a finish chunk");
  }

  if (finishChunk.finishReason !== expected) {
    throw new Error(
      `provider stream finished with ${String(
        finishChunk.finishReason
      )}; expected ${expected}`
    );
  }

  return finishChunk;
}

function findStructuredDoneChunk(
  chunks: readonly ProviderStreamChunk[],
  expectedName: string
): Extract<ProviderStreamChunk, { type: "structured_done" }> {
  const structuredDoneChunk = chunks.find(
    (
      chunk
    ): chunk is Extract<ProviderStreamChunk, { type: "structured_done" }> =>
      chunk.type === "structured_done"
  );

  if (structuredDoneChunk === undefined) {
    throw new Error("provider stream did not emit a structured_done chunk");
  }

  if (structuredDoneChunk.name !== expectedName) {
    throw new Error(
      `provider stream structured_done name was ${String(
        structuredDoneChunk.name
      )}; expected ${expectedName}`
    );
  }

  return structuredDoneChunk;
}

function readProviderErrorReason(error: unknown): string | undefined {
  if (!(error instanceof TuvrenProviderError && isRecord(error.details))) {
    return undefined;
  }

  return typeof error.details.reason === "string"
    ? error.details.reason
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStructuredResponseFormat(): StructuredOutputRequest {
  const { responseFormat } = providerConformanceFixtures.structuredPrompt;

  if (responseFormat === undefined) {
    throw new Error(
      "provider structured prompt fixture must define responseFormat"
    );
  }

  return responseFormat;
}
