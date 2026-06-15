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
      // Mirror the focused provider binding exactly: unredacted reasoning
      // must be non-empty, but whitespace-only payloads are still portable.
      then: #{properties: #{text: #{type: "string", minLength: 1}}},
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
  // Binary byte arrays are represented as uint8[] in JSON artifacts so the emitted
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
  // This packet follows the transport-oriented provider binding surface rather
  // than the stricter durable-runtime message validator, so empty strings stay
  // representable here.
  content: string;
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

// Provider-native tool declaration: the provider owns execution; Tuvren configures
// the surface and records provider-exposed events/results only. (AY002)
model ProviderNativeToolDeclaration {
  // Provider-owned tool ID: "{provider}.{tool-name}" e.g. "anthropic.code_execution_20260120"
  id: NonEmptyString;
  // Model-facing tool name (must be unique among all tools in the prompt)
  name: NonEmptyString;
  // Provider-specific configuration arguments (non-secret)
  args?: Metadata;
  // Optional Tuvren capability ID for attribution; if absent, name is used as capabilityId
  capabilityId?: string;
}

// Provider-mediated tool config: developer supplies the endpoint; the provider
// invokes it. Tuvren configures the relationship and records partial observability. (AY004)
model ProviderMediatedToolConfig {
  // Model-facing tool name
  name: NonEmptyString;
  // Mediation type — "mcp" is the initial supported type (provider-invoked remote MCP)
  mediationType: "mcp";
  // Developer-provided endpoint URL or connector reference (non-secret connection config)
  endpoint: NonEmptyString;
  // Provider-specific options (e.g. headers; must not carry auth secrets inline)
  providerOptions?: Metadata;
  // Optional Tuvren capability ID for attribution; if absent, name is used
  capabilityId?: string;
}

model TuvrenModelConfig {
  // The focused provider package re-exports the provider prompt types only; it
  // does not add stricter runtime predicates for optional string fields here.
  `model`?: string;
  provider?: string;
  settings?: Metadata;
}

model StructuredOutputRequest {
  schema: TuvrenJsonSchema;
  // Empty optional schema names remain valid on the provider-facing packet for
  // parity with the binding surface and the broader runtime contract.
  name?: string;
  strict?: boolean;
}

@TypeSpec.JsonSchema.extension(
  "$comment",
  "The TypeScript binding additionally carries a non-serializable cooperative-cancellation `signal` out-of-band so the framework execution-bounds guard (ADR-043) can abort an in-flight model request at maxWallClockMs. It is intentionally absent from this JSON payload schema; owned bridges forward it to the underlying provider call."
)
model TuvrenPrompt {
  messages: TuvrenMessage[];
  // Function-style tools that Tuvren executes (tuvren-server class)
  tools?: RenderedToolDefinition[];
  // Provider-native tools: provider owns execution; Tuvren enables/configures (AY002)
  providerNativeTools?: ProviderNativeToolDeclaration[];
  // Provider-mediated tools: provider invokes developer endpoint (AY004)
  providerMediatedTools?: ProviderMediatedToolConfig[];
  // Opaque non-secret provider continuity artifacts for multi-turn operation (AY005)
  providerContinuity?: Metadata;
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

// Stream chunk emitted when a provider-native or provider-mediated tool executes
// and the provider returns its result in the stream. (AY003)
model ProviderToolResultChunk {
  type: "provider_tool_result";
  providerCallId: NonEmptyString;
  name: NonEmptyString;
  result: unknown;
  isError?: boolean;
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
  providerToolResult: ProviderToolResultChunk,
  finish: FinishChunk,
  error: ErrorChunk,
}

/** Record of a single provider-native or provider-mediated tool invocation. (AY002/AY004) */
model ProviderNativeInvocationRecord {
  callId: NonEmptyString;
  name: NonEmptyString;
  result: unknown;
  isError?: boolean;
  executionClass: "provider-native" | "provider-mediated";
  providerCallId: NonEmptyString;
  providerMetadata?: Metadata;
}

model TuvrenModelResponse {
  finishReason: FinishReason;
  parts: ContentPart[];
  // Provider-native and provider-mediated invocation records, separate from parts
  // so they do not contaminate the model-facing content flow. (AY002/AY004)
  providerToolResults?: ProviderNativeInvocationRecord[];
  usage?: ProviderUsage;
  providerMetadata?: Metadata;
}
