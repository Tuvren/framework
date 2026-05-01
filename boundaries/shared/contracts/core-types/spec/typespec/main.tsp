import "@typespec/json-schema";

@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/shared/core-types/")
namespace Tuvren.Shared.CoreTypes;

@minLength(1)
@pattern(".*\\S.*", "Must contain non-whitespace content.")
scalar NonEmptyString extends string;

@doc("Milliseconds since Unix epoch.")
scalar EpochMs extends safeint;

@doc("Stable lowercase hash string projected across authority packets.")
@pattern("^[0-9a-f]{64}$")
scalar HashString extends string;

@doc("Opaque JSON object used for metadata maps.")
model Metadata is Record<unknown>;

@doc("Opaque JSON Schema accepted by runtime and provider surfaces.")
model TuvrenJsonSchemaObject is Record<unknown>;

union TuvrenJsonSchema {
  object: TuvrenJsonSchemaObject,
  boolean: boolean,
}

@doc("Opaque byte sequence represented portably as base64 text.")
model ByteSequence {
  encoding: "base64";
  data: string;
}

@doc("Stable neutral error envelope shared by runtime, driver, provider, and adapter seams.")
model ErrorEnvelope {
  code: NonEmptyString;
  message: string;
  details?: unknown;
  cause?: ErrorEnvelope;
}

model TextPart {
  type: "text";
  text: string;
  providerMetadata?: Metadata;
}

model ReasoningPart {
  type: "reasoning";
  text: string;
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
  mediaType: NonEmptyString;
  filename?: string;
  data: ByteSequence;
  providerMetadata?: Metadata;
}

model StructuredPart {
  type: "structured";
  data: unknown;
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

model ProviderUsage {
  inputTokens: int32;
  outputTokens: int32;
}

model TuvrenModelResponse {
  finishReason: "stop" | "tool_call" | "length" | "error" | "content_filter";
  parts: ContentPart[];
  providerMetadata?: Metadata;
  usage?: ProviderUsage;
}
