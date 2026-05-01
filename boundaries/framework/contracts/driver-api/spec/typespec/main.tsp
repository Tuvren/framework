import "@typespec/json-schema";

@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/framework/driver-api/")
namespace Tuvren.Framework.DriverApi;

@minLength(1)
@pattern(".*\\S.*", "Must contain non-whitespace content.")
scalar NonEmptyString extends string;

scalar EpochMs extends safeint;

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

model DriverExecutionContext {
  threadId: NonEmptyString;
  branchId: NonEmptyString;
  turnId: NonEmptyString;
  schemaId: NonEmptyString;
  iterationCount: int32;
  messages: unknown[];
  manifest: Metadata;
  config: Metadata;
  controls?: Metadata;
}

model DriverResumeContext extends DriverExecutionContext {
  approval: unknown;
  resumedFrom?: string;
}

model DriverExtensionStateUpdate {
  extensionName: NonEmptyString;
  state: Metadata;
}

model DriverRuntimeResolution {
  type: "continue_iteration" | "end_turn" | "pause" | "handoff" | "fail";
  reason?: string;
  targetAgent?: string;
  approval?: unknown;
  error?: ErrorEnvelope;
  fatality?: "hard" | "soft";
  contextPlan?: Metadata;
}

model DriverExecutionResult {
  resolution: DriverRuntimeResolution;
  messages?: unknown[];
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
