import "@typespec/json-schema";

@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/framework/event-stream/")
namespace Tuvren.Framework.EventStream;

@minLength(1)
@pattern(".*\\S.*", "Must contain non-whitespace content.")
scalar NonEmptyString extends string;

scalar EpochMs extends safeint;

model Metadata is Record<unknown>;

model ErrorEnvelope {
  code?: NonEmptyString;
  message: string;
  details?: unknown;
}

model ContextManifestCounters {
  total: int32;
  byName?: Metadata;
}

model ContextManifest {
  messageCount: int32;
  tokenEstimate?: int32;
  toolCalls?: ContextManifestCounters;
  toolResults?: ContextManifestCounters;
  byRole?: Metadata;
  extensions?: Metadata;
  lastUserMessageIndex?: int32;
  lastAssistantMessageIndex?: int32;
  turnBoundaries?: int32[];
}

model EventSource {
  agent?: string;
  driver?: string;
  provider?: string;
}

model BaseEvent {
  timestamp: EpochMs;
  source?: EventSource;
}

model TurnStartEvent extends BaseEvent {
  type: "turn.start";
  threadId: NonEmptyString;
  turnId: NonEmptyString;
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
  role: "assistant" | "tool";
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
  data: string;
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

model MessageDoneEvent extends BaseEvent {
  type: "message.done";
  messageId: NonEmptyString;
  finishReason?: string;
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

model ApprovalRequest {
  completedResults: unknown[];
  @minItems(1)
  toolCalls: unknown[];
}

model ApprovalRequestedEvent extends BaseEvent {
  type: "approval.requested";
  request: ApprovalRequest;
}

model ApprovalResolvedEvent extends BaseEvent {
  type: "approval.resolved";
  response: unknown;
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
  checkpoint: NonEmptyString;
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
