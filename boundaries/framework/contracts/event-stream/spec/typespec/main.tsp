import "@typespec/json-schema";

@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/framework/event-stream/")
namespace Tuvren.Framework.EventStream;

@minLength(1)
@pattern(".*\\S.*", "Must contain non-whitespace content.")
scalar NonEmptyString extends string;

scalar EpochMs extends safeint;

@pattern("^[0-9a-f]{64}$")
scalar HashString extends string;

model Metadata is Record<unknown>;

model ErrorEnvelope {
  code?: NonEmptyString;
  message: string;
  details?: unknown;
}

model ContextManifestCounters {
  assistant: safeint;
  system: safeint;
  tool: safeint;
  user: safeint;
}

model ContextManifestNameCountMap is Record<safeint>;

model ContextManifestNameCounters {
  byName: ContextManifestNameCountMap;
  total: safeint;
}

model ContextManifest {
  byRole: ContextManifestCounters;
  extensions: Metadata;
  lastAssistantMessageIndex: safeint;
  lastUserMessageIndex: safeint;
  messageCount: safeint;
  tokenEstimate: safeint;
  toolCalls: ContextManifestNameCounters;
  toolResults: ContextManifestNameCounters;
  turnBoundaries: safeint[];
}

model EventSource {
  agent: NonEmptyString;
  driver?: NonEmptyString;
  threadId?: NonEmptyString;
  workerId?: NonEmptyString;
}

model BaseEvent {
  timestamp: EpochMs;
  source?: EventSource;
}

model TurnStartEvent extends BaseEvent {
  type: "turn.start";
  threadId: NonEmptyString;
  turnId: NonEmptyString;
  resumedFrom?: HashString;
}

model TurnEndEvent extends BaseEvent {
  type: "turn.end";
  turnId: NonEmptyString;
  status: "completed" | "paused" | "failed";
}

model IterationStartEvent extends BaseEvent {
  type: "iteration.start";
  iterationCount: int32;
}

model IterationEndEvent extends BaseEvent {
  type: "iteration.end";
  iterationCount: int32;
}

model MessageStartEvent extends BaseEvent {
  type: "message.start";
  messageId: NonEmptyString;
  role: "assistant";
}

model TextDeltaEvent extends BaseEvent {
  type: "text.delta";
  messageId: NonEmptyString;
  delta: string;
}

model TextDoneEvent extends BaseEvent {
  type: "text.done";
  messageId: NonEmptyString;
  text: string;
}

model ReasoningDeltaEvent extends BaseEvent {
  type: "reasoning.delta";
  messageId: NonEmptyString;
  delta: string;
  signature?: string;
}

model ReasoningDoneEvent extends BaseEvent {
  type: "reasoning.done";
  messageId: NonEmptyString;
}

model FileDoneEvent extends BaseEvent {
  type: "file.done";
  messageId: NonEmptyString;
  data: string | uint8[];
  mediaType: NonEmptyString;
  filename?: string;
}

model StructuredDeltaEvent extends BaseEvent {
  type: "structured.delta";
  messageId: NonEmptyString;
  delta: string;
  name?: string;
}

model StructuredDoneEvent extends BaseEvent {
  type: "structured.done";
  messageId: NonEmptyString;
  data: unknown;
  name?: string;
}

model ToolCallStartEvent extends BaseEvent {
  type: "tool_call.start";
  callId: NonEmptyString;
  messageId: NonEmptyString;
  name: NonEmptyString;
}

model ToolCallArgsDeltaEvent extends BaseEvent {
  type: "tool_call.args_delta";
  callId: NonEmptyString;
  delta: string;
}

model ToolCallDoneEvent extends BaseEvent {
  type: "tool_call.done";
  callId: NonEmptyString;
  name: NonEmptyString;
  input: unknown;
  providerMetadata?: Metadata;
}

enum FinishReason {
  stop: "stop",
  toolCall: "tool_call",
  length: "length",
  error: "error",
  contentFilter: "content_filter",
}

model ProviderUsage {
  @minValue(0)
  @maxValue(9007199254740991)
  inputTokens: safeint;
  @minValue(0)
  @maxValue(9007199254740991)
  outputTokens: safeint;
}

model MessageDoneEvent extends BaseEvent {
  type: "message.done";
  messageId: NonEmptyString;
  finishReason: FinishReason;
  usage?: ProviderUsage;
}

model ToolStartEvent extends BaseEvent {
  type: "tool.start";
  callId: NonEmptyString;
  name: NonEmptyString;
  input: unknown;
}

model ToolResultEvent extends BaseEvent {
  type: "tool.result";
  callId: NonEmptyString;
  name: NonEmptyString;
  output: unknown;
  isError?: boolean;
}

model ToolResultPart {
  type: "tool_result";
  callId: NonEmptyString;
  name: NonEmptyString;
  output: unknown;
  isError?: boolean;
  providerMetadata?: Metadata;
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

model ApprovalRequestedEvent extends BaseEvent {
  type: "approval.requested";
  request: ApprovalRequest;
}

model ApprovalResolvedEvent extends BaseEvent {
  type: "approval.resolved";
  response: ApprovalResponse;
}

model SteeringIncorporatedEvent extends BaseEvent {
  type: "steering.incorporated";
  messageId: NonEmptyString;
}

model StateSnapshotEvent extends BaseEvent {
  type: "state.snapshot";
  manifest: ContextManifest;
}

model StateCheckpointEvent extends BaseEvent {
  type: "state.checkpoint";
  iterationCount: safeint;
  turnNodeHash: HashString;
}

model ErrorEvent extends BaseEvent {
  type: "error";
  error: ErrorEnvelope;
  fatal: boolean;
}

model CustomEvent extends BaseEvent {
  type: "custom";
  name: NonEmptyString;
  data: unknown;
}

union TuvrenStreamEvent {
  turnStart: TurnStartEvent,
  turnEnd: TurnEndEvent,
  iterationStart: IterationStartEvent,
  iterationEnd: IterationEndEvent,
  messageStart: MessageStartEvent,
  textDelta: TextDeltaEvent,
  textDone: TextDoneEvent,
  reasoningDelta: ReasoningDeltaEvent,
  reasoningDone: ReasoningDoneEvent,
  fileDone: FileDoneEvent,
  structuredDelta: StructuredDeltaEvent,
  structuredDone: StructuredDoneEvent,
  toolCallStart: ToolCallStartEvent,
  toolCallArgsDelta: ToolCallArgsDeltaEvent,
  toolCallDone: ToolCallDoneEvent,
  messageDone: MessageDoneEvent,
  toolStart: ToolStartEvent,
  toolResult: ToolResultEvent,
  approvalRequested: ApprovalRequestedEvent,
  approvalResolved: ApprovalResolvedEvent,
  steeringIncorporated: SteeringIncorporatedEvent,
  stateSnapshot: StateSnapshotEvent,
  stateCheckpoint: StateCheckpointEvent,
  error: ErrorEvent,
  custom: CustomEvent,
}
