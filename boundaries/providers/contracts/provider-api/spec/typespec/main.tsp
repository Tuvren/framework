import "@typespec/http";
import "@typespec/json-schema";
import "@typespec/openapi3";

using Http;

@service(#{ title: "Tuvren Provider API" })
@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/providers/provider-api/")
namespace Tuvren.Providers.ProviderApi;

// Epic S publishes provider payload shapes only. The provider implementation
// function surface stays in TypeScript because callables are not portable
// JSON Schema/OpenAPI artifacts.
@minLength(1)
@pattern(".*\\S.*", "Must contain non-whitespace content.")
scalar NonEmptyString extends string;

model Metadata is Record<unknown>;
@TypeSpec.JsonSchema.extension(
  "$comment",
  "Opaque JSON Schema carrier. This artifact validates portable container shape and selected runtime keyword guards, but it is not a full JSON Schema metaschema replacement."
)
@TypeSpec.JsonSchema.extension(
  "allOf",
  #[
    #{
      `if`: #{required: #["type"]},
      then: #{
        properties: #{
          type: #{
            anyOf: #[
              #{`enum`: #["null", "boolean", "object", "array", "number", "integer", "string"]},
              #{
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: #{`enum`: #["null", "boolean", "object", "array", "number", "integer", "string"]},
              },
            ],
          },
        },
      },
    },
  ]
)
model TuvrenJsonSchemaObject is Record<unknown>;

union TuvrenJsonSchema {
  object: TuvrenJsonSchemaObject,
  boolean: boolean,
}

model TextPart {
  type: "text";
  text: string;
  providerMetadata?: Metadata;
}

@TypeSpec.JsonSchema.extension(
  "allOf",
  #[
    #{
      `if`: #{properties: #{redacted: #{`const`: false}}, required: #["redacted"]},
      then: #{properties: #{text: #{type: "string", minLength: 1, pattern: ".*\\S.*"}}},
    },
  ]
)
model ReasoningPart {
  type: "reasoning";
  text: string;
  // Runtime validation permits empty reasoning text only when the provider has
  // redacted it; the JSON artifact mirrors that conditional invariant above.
  redacted: boolean;
  providerMetadata?: Metadata;
}

model ToolCallPart {
  type: "tool_call";
  callId: NonEmptyString;
  name: NonEmptyString;
  input: unknown;
  providerMetadata?: Metadata;
}

model ToolResultPart {
  type: "tool_result";
  callId: NonEmptyString;
  name: NonEmptyString;
  output: unknown;
  isError?: boolean;
  providerMetadata?: Metadata;
}

model FilePart {
  type: "file";
  // Uint8Array is represented as uint8[] in JSON artifacts so the emitted
  // schema remains JSON-native; binary transport encoding is outside Epic S.
  data: string | uint8[];
  mediaType: NonEmptyString;
  filename?: string;
  providerMetadata?: Metadata;
}

model StructuredPart {
  type: "structured";
  data: unknown;
  // Mirrors the framework/runtime durable contract: an emitted empty name is
  // still a valid optional schema identifier, so this must not use NonEmptyString.
  name?: string;
  providerMetadata?: Metadata;
}

union ContentPart {
  text: TextPart,
  reasoning: ReasoningPart,
  toolCall: ToolCallPart,
  toolResult: ToolResultPart,
  file: FilePart,
  structured: StructuredPart,
}

model SystemMessage {
  role: "system";
  content: NonEmptyString;
}

model UserMessage {
  role: "user";
  @minItems(1)
  parts: ContentPart[];
}

model AssistantMessage {
  role: "assistant";
  @minItems(1)
  parts: ContentPart[];
  providerMetadata?: Metadata;
}

model ToolMessage {
  role: "tool";
  @minItems(1)
  parts: ToolResultPart[];
}

union TuvrenMessage {
  system: SystemMessage,
  user: UserMessage,
  assistant: AssistantMessage,
  tool: ToolMessage,
}

model RenderedToolDefinition {
  name: NonEmptyString;
  description: string;
  inputSchema: TuvrenJsonSchema;
}

model TuvrenModelConfig {
  `model`?: NonEmptyString;
  provider?: NonEmptyString;
  settings?: Metadata;
}

model StructuredOutputRequest {
  schema: TuvrenJsonSchema;
  name?: NonEmptyString;
  strict?: boolean;
}

model TuvrenPrompt {
  messages: TuvrenMessage[];
  tools?: RenderedToolDefinition[];
  config?: TuvrenModelConfig;
  responseFormat?: StructuredOutputRequest;
}

model ProviderUsage {
  @minValue(0)
  @maxValue(9007199254740991)
  inputTokens: safeint;
  @minValue(0)
  @maxValue(9007199254740991)
  outputTokens: safeint;
}

enum FinishReason {
  stop: "stop",
  toolCall: "tool_call",
  length: "length",
  error: "error",
  contentFilter: "content_filter",
}

model TextDeltaChunk {
  type: "text_delta";
  text: string;
}

model ReasoningDeltaChunk {
  type: "reasoning_delta";
  text: string;
  signature?: string;
}

model ReasoningDoneChunk {
  type: "reasoning_done";
}

model StructuredDeltaChunk {
  type: "structured_delta";
  delta: string;
}

model StructuredDoneChunk {
  type: "structured_done";
  data: unknown;
  name?: string;
}

model ToolCallStartChunk {
  type: "tool_call_start";
  providerCallId: NonEmptyString;
  name: NonEmptyString;
}

model ToolCallArgsDeltaChunk {
  type: "tool_call_args_delta";
  providerCallId: NonEmptyString;
  delta: string;
}

model ToolCallDoneChunk {
  type: "tool_call_done";
  providerCallId: NonEmptyString;
  name: NonEmptyString;
  input: unknown;
  providerMetadata?: Metadata;
}

model FinishChunk {
  type: "finish";
  finishReason: FinishReason;
  usage?: ProviderUsage;
  providerMetadata?: Metadata;
}

model ErrorChunk {
  type: "error";
  error: unknown;
}

union ProviderStreamChunk {
  textDelta: TextDeltaChunk,
  reasoningDelta: ReasoningDeltaChunk,
  reasoningDone: ReasoningDoneChunk,
  structuredDelta: StructuredDeltaChunk,
  structuredDone: StructuredDoneChunk,
  toolCallStart: ToolCallStartChunk,
  toolCallArgsDelta: ToolCallArgsDeltaChunk,
  toolCallDone: ToolCallDoneChunk,
  finish: FinishChunk,
  error: ErrorChunk,
}

model TuvrenModelResponse {
  finishReason: FinishReason;
  parts: ContentPart[];
  usage?: ProviderUsage;
  providerMetadata?: Metadata;
}
