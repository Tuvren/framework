import "@typespec/json-schema";

@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/framework/driver-api/")
namespace Tuvren.Framework.DriverApi;

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

@pattern("^[0-9a-f]{64}$")
scalar HashString extends string;

model Metadata is Record<unknown>;

model ErrorEnvelope {
  code: NonEmptyString;
  message: string;
  details?: unknown;
  cause?: ErrorEnvelope;
}

model DriverManifest {
  id: NonEmptyString;
  version?: string;
  capabilities?: Metadata;
}

model DriverRuntimePortEvent {
  type: NonEmptyString;
  timestamp: EpochMs;
  payload?: unknown;
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

model DriverExecutionContext {
  threadId: NonEmptyString;
  branchId: NonEmptyString;
  turnId: NonEmptyString;
  schemaId: NonEmptyString;
  iterationCount: NonNegativeSafeInt;
  messages: TuvrenMessage[];
  manifest: ContextManifest;
  config: Metadata;
  controls?: Metadata;
}

model DriverResumeContext extends DriverExecutionContext {
  approval: ApprovalResponse;
  resumedFrom?: HashString;
}

model DriverExtensionStateUpdate {
  extensionName: NonEmptyString;
  state: Metadata;
}

model ContinueIterationResolution {
  type: "continue_iteration";
}

model EndTurnResolution {
  type: "end_turn";
  reason: string;
}

model PauseResolution {
  type: "pause";
  reason: string;
  approval: ApprovalRequest;
}

model HandoffResolution {
  type: "handoff";
  targetAgent: NonEmptyString;
  contextPlan: Metadata;
}

model FailResolution {
  type: "fail";
  error: ErrorEnvelope;
  fatality: "hard" | "soft";
}

union DriverRuntimeResolution {
  continueIteration: ContinueIterationResolution,
  endTurn: EndTurnResolution,
  pause: PauseResolution,
  handoff: HandoffResolution,
  fail: FailResolution,
}

model DriverExecutionResult {
  resolution: DriverRuntimeResolution;
  messages?: TuvrenMessage[];
  partial?: boolean;
  toolExecutionMode?: "parallel" | "sequential";
  assistantEventReconciliation?: "allow_final_sequence_divergence";
  stateUpdates?: DriverExtensionStateUpdate[];
}

enum DriverOperationName {
  initialize: "driver.initialize",
  execute: "driver.execute",
  resume: "driver.resume",
  emitEvent: "driver.emit-event",
  checkpoint: "driver.checkpoint",
  cancel: "driver.cancel",
}

model DriverOperation {
  operation: DriverOperationName;
  manifest?: DriverManifest;
  context?: DriverExecutionContext | DriverResumeContext;
  result?: DriverExecutionResult;
}
