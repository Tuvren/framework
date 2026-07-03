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

@doc("Stable neutral error envelope shared by runtime, runner, provider, and adapter seams.")
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

model ProviderUsage {
  @minValue(0)
  @maxValue(9007199254740991)
  inputTokens: safeint;
  @minValue(0)
  @maxValue(9007199254740991)
  outputTokens: safeint;
}

model TuvrenModelResponse {
  finishReason: "stop" | "tool_call" | "length" | "error" | "content_filter";
  parts: ContentPart[];
  providerMetadata?: Metadata;
  usage?: ProviderUsage;
}

model TelemetryLineage {
  threadId: NonEmptyString;
  branchId: NonEmptyString;
  turnId: NonEmptyString;
  runId?: NonEmptyString;
  turnNodeHash?: HashString;
}

union TelemetryAttributeValue {
  string: string,
  number: float64,
  boolean: boolean,
}

union TelemetrySpanKind {
  turn: "turn",
  run: "run",
  iteration: "iteration",
  modelCall: "model_call",
  toolCall: "tool_call",
  checkpoint: "checkpoint",
  recovery: "recovery",
}

union TelemetrySpanStatus {
  ok: "ok",
  error: "error",
}

model TelemetrySpanError {
  code: NonEmptyString;
  message: string;
}

model TelemetrySpan {
  kind: TelemetrySpanKind;
  name: NonEmptyString;
  lineage: TelemetryLineage;
  startMs: EpochMs;
  endMs: EpochMs;
  status: TelemetrySpanStatus;
  attributes: Record<TelemetryAttributeValue>;
  error?: TelemetrySpanError;
}

union TelemetryEventKind {
  turnStart: "turn.start",
  turnEnd: "turn.end",
  approvalRequested: "approval.requested",
  approvalResolved: "approval.resolved",
  stateCheckpoint: "state.checkpoint",
  recoveryResumed: "recovery.resumed",
  recoveryFailed: "recovery.failed",
  executionBounded: "execution.bounded",
  error: "error",
}

model TelemetryEvent {
  kind: TelemetryEventKind;
  lineage: TelemetryLineage;
  atMs: EpochMs;
  attributes: Record<TelemetryAttributeValue>;
}

@doc("Hard-stop execution bound whose breach finalizes a turn as failed. maxConcurrentToolCalls is excluded because it is a concurrency throttle, not a terminal bound. (ADR-043 §3.11)")
union ExecutionBoundKind {
  maxIterations: "maxIterations",
  maxToolCalls: "maxToolCalls",
  maxWallClockMs: "maxWallClockMs",
}

@doc("Framework-enforced per-turn execution bounds (ADR-043 §3.11), applied above the runner's loop policy. Unset fields take the documented safe defaults; every configured bound must be a finite positive integer. A runner cannot raise or disable a bound.")
model ExecutionBounds {
  @doc("Maximum ReAct iterations per turn. Default 64.")
  @minValue(1)
  @maxValue(9007199254740991)
  maxIterations?: safeint;

  @doc("Maximum cumulative tool calls per turn. Default 256.")
  @minValue(1)
  @maxValue(9007199254740991)
  maxToolCalls?: safeint;

  @doc("End-to-end wall-clock deadline in milliseconds. Default 600000.")
  @minValue(1)
  @maxValue(9007199254740991)
  maxWallClockMs?: safeint;

  @doc("Maximum concurrent tool calls (throttle, not a terminal bound). Default 16.")
  @minValue(1)
  @maxValue(9007199254740991)
  maxConcurrentToolCalls?: safeint;
}

@doc("Details carried by the execution_bound_exceeded error, the fatal canonical error event, and the bounded-execution telemetry event when a hard-stop bound is breached. (ADR-043)")
model ExecutionBoundExceededDetails {
  bound: ExecutionBoundKind;

  @doc("The configured limit for the breached bound.")
  @minValue(1)
  @maxValue(9007199254740991)
  limit: safeint;

  @doc("The observed value at breach time.")
  @minValue(0)
  @maxValue(9007199254740991)
  observed: safeint;
}
