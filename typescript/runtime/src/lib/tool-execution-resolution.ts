/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { TuvrenSandboxExecutor } from "@tuvren/core/capabilities";
import {
  TOOL_INPUT_VALIDATION_FAILED,
  TOOL_INVOCATION_RATE_LIMITED,
} from "@tuvren/core/errors";
import type { ToolCallPart, ToolResultPart } from "@tuvren/core/messages";
import type { ApprovalDecision, PendingToolCall } from "@tuvren/core/tools";

import {
  createBindingResolver,
  isClientEndpointTool,
} from "./binding-resolver.js";
import {
  createPendingToolCall,
  createToolExecutionContext,
  emitToolAuditEvent,
  evaluateApprovalPolicy,
} from "./tool-execution-helpers.js";
import {
  createErrorToolResult,
  createRejectedToolResult,
  createValidationErrorToolResult,
  isExecutableApprovalDecision,
} from "./tool-execution-staging.js";
import { validateToolInput } from "./tool-execution-validation.js";
import type {
  ExecutableToolCall,
  ToolBatchEnvironment,
} from "./tool-execution.js";
import { resolveToolDefinition } from "./tool-registry.js";

/**
 * Runs the gateway admission pipeline for one freshly requested call and
 * classifies it as executable, pending approval, or immediately decided.
 *
 * Pipeline order (framework spec §8.6 steps 1-3, extended by ADR-0046 §4.21):
 *
 * 1. Registry lookup — unknown tool becomes an error result.
 * 2. Input validation against `inputSchema` — failure becomes a
 *    `TOOL_INPUT_VALIDATION_FAILED` result; an `input_validated` audit event
 *    is emitted either way (except for tuvren-client tools, KRT-AZ005).
 * 3. Invocation-time capability policy, when a policy engine is configured —
 *    denial becomes an error result with a `policy_denied` audit event;
 *    `requiresApproval` routes the call into the pending-approval flow
 *    (BB002 risk-based gate).
 * 4. Tuvren-server rate limit (AX003) — exhaustion becomes a
 *    `TOOL_INVOCATION_RATE_LIMITED` result with a `rate_limited` audit event.
 * 5. Sandbox executor resolution for tools declaring
 *    `metadata.sandbox.endpointId` (AX004).
 * 6. Declarative approval policy from `tool.approval` (spec §8.4) — `true`
 *    routes the call into the pending-approval flow.
 *
 * Only calls that clear every gate become {@link ExecutableToolCall}s
 * carrying the validated input.
 */
export const resolveExecutableToolCall = async (
  toolCall: ToolCallPart,
  environment: ToolBatchEnvironment
): Promise<
  | { executable: ExecutableToolCall }
  | { pendingToolCall: PendingToolCall }
  | { result: ToolResultPart }
> => {
  const tool = resolveToolDefinition(environment.toolRegistry, toolCall.name);

  if (tool === undefined) {
    return {
      result: createErrorToolResult(
        toolCall,
        `Tool "${toolCall.name}" is not registered.`
      ),
    };
  }

  const validation = validateToolInput(tool, toolCall.input);
  // Tuvren-client tools carry partial observability: canAudit is false, so
  // tool.audit events must not be emitted for them. The isClientEndpointTool
  // guard gates all audit-event emission points in this function. (KRT-AZ005)
  const isClientTool = isClientEndpointTool(tool);

  if (!isClientTool) {
    emitToolAuditEvent(
      environment,
      toolCall.callId,
      toolCall.name,
      "input_validated",
      {
        validationPassed: validation.valid,
      }
    );
  }

  if (!validation.valid) {
    return {
      result: createValidationErrorToolResult(
        toolCall,
        TOOL_INPUT_VALIDATION_FAILED,
        "Tool input failed validation.",
        validation.details
      ),
    };
  }

  // Invocation-time policy check per ADR-0046 §4.21 (Epic BB: context populated).
  if (environment.capabilityPolicyEngine !== undefined) {
    const resolver = createBindingResolver();
    const binding = resolver.resolveFromToolDefinition(tool);
    const inputs = environment.policyContextInputs ?? {};
    const policyContext = {
      allowedResidencies: inputs.allowedResidencies,
      availableCredentialScopes: inputs.availableCredentialScopes,
      capabilityMetadata: environment.policyCapabilityMetadata,
      modelId: "",
      permissions: [] as string[],
      providerId: "",
      userPresent: inputs.userPresent,
    };
    const decision = environment.capabilityPolicyEngine.evaluateInvocation(
      binding,
      policyContext
    );
    if (!decision.admitted) {
      if (!isClientTool) {
        emitToolAuditEvent(
          environment,
          toolCall.callId,
          toolCall.name,
          "policy_denied"
        );
      }
      return {
        result: createErrorToolResult(
          toolCall,
          decision.reason ?? "invocation denied by capability policy"
        ),
      };
    }
    // BB002: risk-based approval gate. When the policy engine signals that
    // this capability requires explicit approval (e.g. high-risk class), gate
    // execution through the existing pending-approval flow. The framework
    // owns this decision above runner discretion per §4.21 / ADR-0046.
    if (decision.requiresApproval === true) {
      return {
        pendingToolCall: createPendingToolCall(
          toolCall,
          validation.value,
          decision.reason
        ),
      };
    }
  }

  // Rate-limit check for Tuvren-server execution class per §4.21 / AX003.
  // Client endpoint tools are not subject to server-side rate limiting.
  if (
    !isClientTool &&
    environment.serverExecutionRateLimiter !== undefined &&
    !environment.serverExecutionRateLimiter.tryAcquire()
  ) {
    emitToolAuditEvent(
      environment,
      toolCall.callId,
      toolCall.name,
      "rate_limited"
    );
    return {
      result: createValidationErrorToolResult(
        toolCall,
        TOOL_INVOCATION_RATE_LIMITED,
        `Tool "${tool.name}" invocation rejected: server execution rate limit exceeded.`
      ),
    };
  }

  // Resolve sandbox executor for tools declared with metadata.sandbox.endpointId.
  // The resolver produces endpoint.id = "sandbox:<endpointId>"; we strip the
  // prefix before the lookup so AgentConfig.sandboxExecutors is keyed by the
  // raw endpointId the host declared in metadata.sandbox.endpointId. (AX004)
  const binding = createBindingResolver().resolveFromToolDefinition(tool);
  let sandboxExecutor: TuvrenSandboxExecutor | undefined;
  if (
    binding.endpoint.kind === "tuvren-sandbox" &&
    environment.resolveSandboxExecutor !== undefined
  ) {
    sandboxExecutor = environment.resolveSandboxExecutor(binding.endpoint.id);
  }

  const toolContext = createToolExecutionContext(
    toolCall,
    tool,
    environment,
    environment.signal
  );
  const approvalRequired =
    tool.approval === undefined
      ? false
      : await evaluateApprovalPolicy(
          tool.approval,
          validation.value,
          toolContext
        );

  if (approvalRequired) {
    return {
      pendingToolCall: createPendingToolCall(toolCall, validation.value),
    };
  }

  return {
    executable: {
      input: validation.value,
      sandboxExecutor,
      tool,
      toolCall,
    },
  };
};

/**
 * Translates one host approval decision for a paused call into either an
 * {@link ExecutableToolCall} or an immediate result.
 *
 * - `reject` (and unknown decision types) produce the canonical rejection
 *   result without executing.
 * - `approve` executes with the original pending input; input validation is
 *   not repeated because the input already passed it before the pause.
 * - `edit` requires `editedInput`, which is re-validated against the tool's
 *   `inputSchema`; failures produce a `TOOL_INPUT_VALIDATION_FAILED` result
 *   annotated with the decision, and successes carry an
 *   {@link EditedApprovalAudit} into the result metadata.
 *
 * For `approve`/`edit`, the invocation-time capability policy is re-checked
 * for hard denials against current (not pause-time) policy context inputs
 * (BB005); the risk-based `requiresApproval` gate is intentionally skipped
 * since the host just approved this call. A tool that disappeared from the
 * registry between pause and resume produces an error result.
 */
export const resolveResumeDecision = (
  pendingToolCall: PendingToolCall,
  decision: ApprovalDecision,
  environment: ToolBatchEnvironment
): { executable: ExecutableToolCall } | { result: ToolResultPart } => {
  if (decision.type === "reject" || !isExecutableApprovalDecision(decision)) {
    return {
      result: createRejectedToolResult(pendingToolCall, decision),
    };
  }

  const tool = resolveToolDefinition(
    environment.toolRegistry,
    pendingToolCall.name
  );

  if (tool === undefined) {
    return {
      result: createErrorToolResult(
        {
          callId: pendingToolCall.callId,
          input: pendingToolCall.input,
          name: pendingToolCall.name,
          type: "tool_call",
        },
        `Tool "${pendingToolCall.name}" is not registered.`,
        {
          decisionType: decision.type,
        },
        decision,
        decision.type === "edit"
          ? {
              editedInput: decision.editedInput,
              originalInput: pendingToolCall.input,
            }
          : undefined
      ),
    };
  }

  // BB005: re-evaluate invocation-time policy on the resume path. Inputs
  // come from the current agent config (environment.policyContextInputs),
  // not a snapshot captured at pause time. Static dimensions therefore
  // produce the same decision as pre-pause unless the host mutates config
  // between pause and resume. The guard is meaningful for context-sensitive
  // custom engines that consult external mutable state (e.g. live credential
  // validity) independently of policyContextInputs.
  // The risk-based approval path (requiresApproval) is intentionally not
  // re-raised here: the host has just approved this specific invocation,
  // so we honour that approval and only check for hard denials.
  if (environment.capabilityPolicyEngine !== undefined) {
    const resolver = createBindingResolver();
    const binding = resolver.resolveFromToolDefinition(tool);
    const inputs = environment.policyContextInputs ?? {};
    const policyContext = {
      allowedResidencies: inputs.allowedResidencies,
      availableCredentialScopes: inputs.availableCredentialScopes,
      capabilityMetadata: environment.policyCapabilityMetadata,
      modelId: "",
      permissions: [] as string[],
      providerId: "",
      userPresent: inputs.userPresent,
    };
    const resumeDecision =
      environment.capabilityPolicyEngine.evaluateInvocation(
        binding,
        policyContext
      );
    if (!resumeDecision.admitted) {
      if (!isClientEndpointTool(tool)) {
        emitToolAuditEvent(
          environment,
          pendingToolCall.callId,
          pendingToolCall.name,
          "policy_denied"
        );
      }
      return {
        result: createErrorToolResult(
          {
            callId: pendingToolCall.callId,
            input: pendingToolCall.input,
            name: pendingToolCall.name,
            type: "tool_call",
          },
          resumeDecision.reason ?? "invocation denied by capability policy"
        ),
      };
    }
  }

  if (decision.type === "approve") {
    return {
      executable: {
        approvalDecision: decision,
        input: pendingToolCall.input,
        tool,
        toolCall: {
          callId: pendingToolCall.callId,
          input: pendingToolCall.input,
          name: pendingToolCall.name,
          type: "tool_call",
        },
      },
    };
  }

  const input = decision.editedInput;

  if (decision.editedInput === undefined) {
    return {
      result: createErrorToolResult(
        {
          callId: pendingToolCall.callId,
          input,
          name: pendingToolCall.name,
          type: "tool_call",
        },
        `Approval decision "edit" for tool "${pendingToolCall.name}" requires editedInput.`,
        {
          decisionType: decision.type,
        },
        decision
      ),
    };
  }

  const validation = validateToolInput(tool, input);

  if (!validation.valid) {
    return {
      result: createValidationErrorToolResult(
        {
          callId: pendingToolCall.callId,
          input,
          name: pendingToolCall.name,
          type: "tool_call",
        },
        TOOL_INPUT_VALIDATION_FAILED,
        "Approved tool input failed validation.",
        {
          decisionType: decision.type,
          validation: validation.details,
        },
        decision,
        {
          editedInput: input,
          originalInput: pendingToolCall.input,
        }
      ),
    };
  }

  return {
    executable: {
      approvalAudit: {
        editedInput: input,
        originalInput: pendingToolCall.input,
      },
      approvalDecision: decision,
      input: validation.value,
      tool,
      toolCall: {
        callId: pendingToolCall.callId,
        input,
        name: pendingToolCall.name,
        type: "tool_call",
      },
    },
  };
};
