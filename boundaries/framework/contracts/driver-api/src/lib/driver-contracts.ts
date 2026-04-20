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

import type { KrakenStreamEvent } from "@kraken/framework-runtime-api/events";
import type {
  AgentConfig,
  ContextManifest,
  HandoffContextBuilder,
  HandoffContextMode,
  HandoffContextPlan,
  HandoffSourceContext,
  KrakenMessage,
  RuntimeResolution,
} from "@kraken/framework-runtime-api/execution";
import {
  assertContextManifest,
  assertKrakenMessage,
} from "@kraken/framework-runtime-api/execution";
import type {
  ApprovalResponse,
  ToolRegistry,
} from "@kraken/framework-runtime-api/tools";
import { assertApprovalRequest } from "@kraken/framework-runtime-api/tools";
import type { EpochMs, HashString } from "@kraken/shared-core-types";
import { KrakenValidationError } from "@kraken/shared-core-types";

export interface DriverRuntimePort {
  emit(event: KrakenStreamEvent): Promise<void> | void;
  now(): EpochMs;
}

export interface DriverHandoffPort {
  createContextPlan(input: {
    builder?: HandoffContextBuilder;
    mode?: HandoffContextMode;
    payload?: unknown;
    reason: string;
    targetAgent: string;
  }): HandoffContextPlan;
}

export interface DriverExecutionContext {
  branchId: string;
  config: Readonly<AgentConfig>;
  handoff: DriverHandoffPort;
  iterationCount: number;
  manifest: Readonly<ContextManifest>;
  messages: readonly KrakenMessage[];
  runtime: DriverRuntimePort;
  schemaId: string;
  signal?: AbortSignal;
  threadId: string;
  toolRegistry: Readonly<ToolRegistry>;
  turnId: string;
}

export interface DriverResumeContext extends DriverExecutionContext {
  approval: ApprovalResponse;
  resumedFrom?: HashString;
}

export interface DriverExecutionResult {
  messages?: KrakenMessage[];
  partial?: boolean;
  resolution: RuntimeResolution;
}

export interface KrakenDriver {
  execute(context: DriverExecutionContext): Promise<DriverExecutionResult>;
  readonly id: string;
  resume(context: DriverResumeContext): Promise<DriverExecutionResult>;
}

export interface KrakenDriverFactory {
  create(): KrakenDriver;
  readonly id: string;
}

export interface DriverRegistry {
  list(): Array<KrakenDriver | KrakenDriverFactory>;
  register(driver: KrakenDriver | KrakenDriverFactory): void;
  resolve(driverId: string): KrakenDriver | KrakenDriverFactory | undefined;
}

export function isKrakenDriver(value: unknown): value is KrakenDriver {
  // Driver installation guards stay structural on purpose. Verifying execute
  // or resume result semantics would require invoking arbitrary plugin code,
  // so runtime-core validates the returned data at the call boundary instead.
  return safePredicate(
    () =>
      value !== null &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      value.id.trim().length > 0 &&
      "execute" in value &&
      typeof value.execute === "function" &&
      "resume" in value &&
      typeof value.resume === "function"
  );
}

export function assertKrakenDriver(
  value: unknown,
  label = "value"
): asserts value is KrakenDriver {
  if (!isKrakenDriver(value)) {
    throw new KrakenValidationError(`${label} must be a valid KrakenDriver`, {
      code: "invalid_driver_contract",
      details: value,
    });
  }
}

export function assertDriverExecutionResult(
  value: unknown,
  label = "value"
): asserts value is DriverExecutionResult {
  if (
    !isRecord(value) ||
    ("partial" in value && typeof value.partial !== "boolean")
  ) {
    throw new KrakenValidationError(
      `${label} must include only valid optional driver metadata fields`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  if ("messages" in value && value.messages !== undefined) {
    if (!Array.isArray(value.messages)) {
      throw new KrakenValidationError(`${label}.messages must be an array`, {
        code: "invalid_driver_result",
        details: value,
      });
    }

    for (const [index, message] of value.messages.entries()) {
      assertKrakenMessage(message, `${label}.messages[${index}]`);
      assertDriverMessage(message, `${label}.messages[${index}]`);
    }
  }

  for (const key of Object.keys(value)) {
    if (key === "messages" || key === "partial" || key === "resolution") {
      continue;
    }

    throw new KrakenValidationError(
      `${label} must not include unsupported driver result field "${key}"`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  assertDriverRuntimeResolution(value.resolution, `${label}.resolution`);
  assertDriverPartialResult(
    {
      messages: Array.isArray(value.messages) ? value.messages : undefined,
      partial: value.partial === true,
      resolution: value.resolution,
    },
    `${label}`
  );
}

export function assertDriverRuntimeResolution(
  value: unknown,
  label = "value"
): asserts value is RuntimeResolution {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new KrakenValidationError(`${label} must be a valid resolution`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  switch (value.type) {
    case "continue_iteration":
      return;
    case "end_turn":
      if (typeof value.reason === "string") {
        return;
      }
      break;
    case "pause":
      if (typeof value.reason === "string" && "approval" in value) {
        assertApprovalRequest(value.approval, `${label}.approval`);
        return;
      }
      break;
    case "handoff":
      if (typeof value.targetAgent === "string") {
        assertDriverHandoffContextPlan(
          value.contextPlan,
          `${label}.contextPlan`
        );

        if (value.contextPlan.targetAgent !== value.targetAgent) {
          throw new KrakenValidationError(
            `${label}.targetAgent must match ${label}.contextPlan.targetAgent`,
            {
              code: "invalid_driver_result",
              details: {
                contextPlanTargetAgent: value.contextPlan.targetAgent,
                resolutionTargetAgent: value.targetAgent,
              },
            }
          );
        }

        return;
      }
      break;
    case "fail":
      if (
        value.error instanceof Error &&
        (value.fatality === "hard" || value.fatality === "soft")
      ) {
        return;
      }
      break;
    default:
      break;
  }

  throw new KrakenValidationError(`${label} must be a valid resolution`, {
    code: "invalid_driver_result",
    details: value,
  });
}

export function assertDriverHandoffContextPlan(
  value: unknown,
  label = "value"
): asserts value is HandoffContextPlan {
  if (
    !isRecord(value) ||
    typeof value.targetAgent !== "string" ||
    typeof value.reason !== "string" ||
    typeof value.mode !== "string" ||
    typeof value.builder !== "function" ||
    !isRecord(value.sourceContext)
  ) {
    throw new KrakenValidationError(`${label} must be a valid handoff plan`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  assertDriverHandoffSourceContext(
    value.sourceContext,
    `${label}.sourceContext`
  );
}

export function assertDriverHandoffSourceContext(
  value: unknown,
  label = "value"
): asserts value is HandoffSourceContext {
  if (!isRecord(value)) {
    throw new KrakenValidationError(`${label} must be a valid handoff source`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  if (!Array.isArray(value.messages)) {
    throw new KrakenValidationError(`${label}.messages must be an array`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  for (const [index, message] of value.messages.entries()) {
    assertKrakenMessage(message, `${label}.messages[${index}]`);
  }

  assertContextManifest(value.manifest, `${label}.manifest`);

  if (
    !isRecord(value.handoffIntent) ||
    typeof value.handoffIntent.targetAgent !== "string" ||
    !isRecord(value.sourceAgent) ||
    typeof value.sourceAgent.name !== "string" ||
    !isRecord(value.targetAgent) ||
    typeof value.targetAgent.name !== "string" ||
    !isRecord(value.helpers) ||
    typeof value.helpers.loadMessage !== "function" ||
    typeof value.helpers.storeMessage !== "function" ||
    typeof value.helpers.storeMessages !== "function"
  ) {
    throw new KrakenValidationError(`${label} must be a valid handoff source`, {
      code: "invalid_driver_result",
      details: value,
    });
  }
}

function safePredicate(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function assertDriverMessage(message: KrakenMessage, label: string): void {
  if (message.role !== "assistant") {
    throw new KrakenValidationError(`${label} must be an assistant message`, {
      code: "invalid_driver_result",
      details: message,
    });
  }

  for (const [index, part] of message.parts.entries()) {
    if (part.type === "tool_result") {
      throw new KrakenValidationError(
        `${label}.parts[${index}] must not be a tool_result`,
        {
          code: "invalid_driver_result",
          details: part,
        }
      );
    }
  }
}

function assertDriverPartialResult(
  value: {
    messages?: KrakenMessage[];
    partial: boolean;
    resolution: RuntimeResolution;
  },
  label: string
): void {
  if (!value.partial) {
    return;
  }

  if (value.resolution.type !== "fail") {
    throw new KrakenValidationError(
      `${label}.partial is only valid for failed execution results`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  if (!value.messages?.some((message) => message.role === "assistant")) {
    throw new KrakenValidationError(
      `${label}.partial requires a staged assistant message`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
