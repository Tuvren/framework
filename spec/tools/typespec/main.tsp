import "@typespec/http";
import "@typespec/json-schema";
import "@typespec/openapi3";

using Http;

@service(#{ title: "Tuvren Tool Contracts" })
@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/framework/tool-contracts/")
namespace Tuvren.Framework.ToolContracts;

// Epic S promotes only serializable payload contracts here. Callable seams such
// as execute(), approval policies, and custom schema validators stay in the
// TypeScript runtime contract because they are not artifact-safe wire shapes.
@doc("Opaque JSON Schema accepted by the Tuvren tool contract surface.")
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

@minLength(1)
@pattern(".*\\S.*", "Must contain non-whitespace content.")
scalar NonEmptyString extends string;

union TuvrenJsonSchema {
  object: TuvrenJsonSchemaObject,
  boolean: boolean,
}

@doc("Opaque serializable metadata projected across framework tool boundaries.")
model Metadata is Record<unknown>;

@doc("Tool call content emitted by the provider-facing model contract.")
model ToolCallPart {
  type: "tool_call";
  callId: NonEmptyString;
  name: NonEmptyString;
  input: unknown;
  providerMetadata?: Metadata;
}

@doc("Tool result content staged by the framework after tool execution.")
model ToolResultPart {
  type: "tool_result";
  callId: NonEmptyString;
  name: NonEmptyString;
  output: unknown;
  isError?: boolean;
  providerMetadata?: Metadata;
}

@doc("Provider-facing projection of an executable runtime tool.")
model RenderedToolDefinition {
  name: NonEmptyString;
  description: string;
  inputSchema: TuvrenJsonSchema;
}

@doc("A tool call waiting for host approval.")
model PendingToolCall {
  callId: NonEmptyString;
  name: NonEmptyString;
  input: unknown;
  @minItems(1)
  decisions: NonEmptyString[];
  message: NonEmptyString;
}

@doc("Approval request surfaced to a host while a tool batch is paused.")
model ApprovalRequest {
  completedResults: ToolResultPart[];
  @minItems(1)
  toolCalls: PendingToolCall[];
}

enum ApprovalDecisionType {
  approve: "approve",
  edit: "edit",
  reject: "reject",
}

@doc("A host decision for one pending tool call.")
@TypeSpec.JsonSchema.extension(
  "allOf",
  #[
    #{
      `if`: #{properties: #{type: #{`const`: "edit"}}, required: #["type"]},
      then: #{required: #["editedInput"]},
    },
    #{
      `if`: #{properties: #{type: #{not: #{`const`: "edit"}}}, required: #["type"]},
      then: #{not: #{required: #["editedInput"]}},
    },
  ]
)
model ApprovalDecision {
  callId: NonEmptyString;
  // The standalone artifact captures response-local shape only. Request-aware
  // decision coverage and custom decision semantics remain enforced by the
  // runtime predicate because they require the paused ApprovalRequest context.
  type: ApprovalDecisionType | string;
  editedInput?: unknown;
  message?: NonEmptyString;
}

@doc("A host response covering pending approval decisions.")
model ApprovalResponse {
  @minItems(1)
  decisions: ApprovalDecision[];
}

@doc("Serializable validation error payload used by tool schema validation.")
model ValidationErrorPayload {
  message: string;
  details?: unknown;
}

model ValidValidationResult {
  valid: true;
  value: unknown;
}

model InvalidValidationResult {
  valid: false;
  error: ValidationErrorPayload;
}

@doc("Result of validating candidate tool input.")
union ValidationResult {
  valid: ValidValidationResult,
  invalid: InvalidValidationResult,
}

model CompletedToolResultBatch {
  results: ToolResultPart[];
  state?: Metadata;
}

model ApprovalToolResultBatch {
  approval: ApprovalRequest;
  results: ToolResultPart[];
  state?: Metadata;
}

@doc("Shared serializable tool execution result batch shape.")
union TuvrenToolResultBatch {
  completed: CompletedToolResultBatch,
  approval: ApprovalToolResultBatch,
}
