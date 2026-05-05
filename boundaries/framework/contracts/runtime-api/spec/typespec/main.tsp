import "@typespec/json-schema";

@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/framework/runtime-api/")
namespace Tuvren.Framework.RuntimeApi;

@minLength(1)
@pattern(".*\\S.*", "Must contain non-whitespace content.")
scalar NonEmptyString extends string;

scalar EpochMs extends safeint;

@minValue(0)
@maxValue(9007199254740991)
scalar NonNegativeSafeInt extends safeint;

@minValue(-1)
@maxValue(9007199254740991)
scalar MessageIndex extends safeint;

model Metadata is Record<unknown>;
model TuvrenJsonSchemaObject is Record<unknown>;

union TuvrenJsonSchema {
  object: TuvrenJsonSchemaObject,
  boolean: boolean,
}

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

@TypeSpec.JsonSchema.extension(
  "allOf",
  #[
    #{
      `if`: #{properties: #{redacted: #{`const`: false}}, required: #["redacted"]},
      // Mirror the current binding validator exactly: unredacted reasoning
      // must be non-empty, but whitespace-only payloads are still valid here.
      then: #{properties: #{text: #{type: "string", minLength: 1}}},
    },
  ]
)
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
  data: string | uint8[];
  mediaType: NonEmptyString;
  filename?: string;
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

model InputSignal {
  @minItems(1)
  parts: ContentPart[];
}

model TuvrenModelConfig {
  `model`?: string;
  provider?: string;
  settings?: Metadata;
}

enum FinishReason {
  stop: "stop",
  toolCall: "tool_call",
  length: "length",
  error: "error",
  contentFilter: "content_filter",
}

model ProviderUsage {
  inputTokens: NonNegativeSafeInt;
  outputTokens: NonNegativeSafeInt;
}

model TuvrenModelResponse {
  finishReason: FinishReason;
  parts: ContentPart[];
  providerMetadata?: Metadata;
  usage?: ProviderUsage;
}

model RenderedToolDefinition {
  name: NonEmptyString;
  description: string;
  inputSchema: TuvrenJsonSchema;
}

model StructuredOutputRequest {
  name?: string;
  schema: TuvrenJsonSchema;
  strict?: boolean;
}

model TuvrenPrompt {
  messages: TuvrenMessage[];
  tools?: RenderedToolDefinition[];
  responseFormat?: StructuredOutputRequest;
  config?: TuvrenModelConfig;
}

model PendingToolCall {
  callId: NonEmptyString;
  name: NonEmptyString;
  input: unknown;
  @minItems(1)
  decisions: NonEmptyString[];
  message: NonEmptyString;
}

model ApprovalRequest {
  completedResults: ToolResultPart[];
  @minItems(1)
  toolCalls: PendingToolCall[];
}

model ApprovalDecision {
  callId: NonEmptyString;
  type: "approve" | "edit" | "reject" | string;
  editedInput?: unknown;
  message?: NonEmptyString;
}

model ApprovalResponse {
  @minItems(1)
  decisions: ApprovalDecision[];
}

model ContextManifestCounters {
  assistant: NonNegativeSafeInt;
  system: NonNegativeSafeInt;
  tool: NonNegativeSafeInt;
  user: NonNegativeSafeInt;
}

@TypeSpec.JsonSchema.extension(
  "propertyNames",
  #{
    type: "string",
    minLength: 1,
    pattern: ".*\\S.*",
  }
)
model ContextManifestNameCountMap is Record<NonNegativeSafeInt>;

model ContextManifestNameCounters {
  byName: ContextManifestNameCountMap;
  total: NonNegativeSafeInt;
}

model ContextManifest {
  byRole: ContextManifestCounters;
  extensions: Metadata;
  lastAssistantMessageIndex: MessageIndex;
  lastUserMessageIndex: MessageIndex;
  messageCount: NonNegativeSafeInt;
  @minValue(0)
  tokenEstimate: float64;
  toolCalls: ContextManifestNameCounters;
  toolResults: ContextManifestNameCounters;
  turnBoundaries: NonNegativeSafeInt[];
}

model ExecutionStatus {
  phase: "running" | "paused" | "completed" | "failed";
  iterationCount: NonNegativeSafeInt;
  activeAgent?: NonEmptyString;
  approval?: ApprovalRequest;
  manifest?: ContextManifest;
  pauseReason?: string;
}

model RuntimeOperationInput {
  threadId?: NonEmptyString;
  branchId?: NonEmptyString;
  turnId?: NonEmptyString;
  prompt?: TuvrenPrompt;
  messages?: TuvrenMessage[];
  approval?: ApprovalResponse;
  toolName?: NonEmptyString;
  toolInput?: unknown;
  controls?: Metadata;
}

model RuntimeOperationOutcome {
  status: "completed" | "paused" | "failed" | "running";
  response?: TuvrenModelResponse;
  approval?: ApprovalRequest;
  error?: ErrorEnvelope;
  manifest?: ContextManifest;
  events?: unknown[];
}

enum RuntimeOperationName {
  executeTurn: "runtime.execute-turn",
  providerGenerate: "runtime.provider-generate",
  providerStream: "runtime.provider-stream",
  toolExecute: "runtime.tool-execute",
  approvalResolve: "runtime.approval-resolve",
  contextTransform: "runtime.context-transform",
  branchCreate: "runtime.branch-create",
  cancelExecution: "runtime.cancel-execution",
  recoverResult: "runtime.recover-result",
  recoverStaleRun: "runtime.recover-stale-run",
  validateStructuredOutput: "runtime.validate-structured-output",
  orchestrationLaunchPreconditions:
    "runtime.orchestration.launch-preconditions",
  orchestrationLifecycleLocality: "runtime.orchestration.lifecycle-locality",
  orchestrationEventSurfaces: "runtime.orchestration.event-surfaces",
  orchestrationExecutionInheritance:
    "runtime.orchestration.execution-inheritance",
  orchestrationNestedAttribution:
    "runtime.orchestration.nested-attribution",
}

model RuntimeOperation {
  operation: RuntimeOperationName;
  input: RuntimeOperationInput;
  outcome?: RuntimeOperationOutcome;
}
