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

export interface AdapterCancelControl {
  readonly reason: string;
}

export interface AdapterControls {
  readonly cancel?: AdapterCancelControl;
  readonly cancelAfterEvent?: string;
  readonly deadlineMs?: number;
}

export interface AdapterCapabilities {
  readonly adapterId: string;
  readonly capabilities: readonly string[];
  readonly packetId: string;
  readonly planVersion: string;
}

export interface AdapterErrorEnvelope {
  readonly cause?: AdapterErrorEnvelope;
  readonly code: string;
  readonly details?: unknown;
  readonly message: string;
}

export interface OperationResultOutcome {
  readonly kind: "result";
  readonly value: unknown;
}

export interface OperationErrorOutcome {
  readonly error: AdapterErrorEnvelope;
  readonly kind: "error";
}

export type OperationOutcome = OperationErrorOutcome | OperationResultOutcome;

export function createAdapterErrorEnvelope(
  error: unknown,
  code = "adapter_operation_failed"
): AdapterErrorEnvelope {
  if (error instanceof Error) {
    return {
      code,
      message: error.message,
    };
  }

  return {
    code,
    message: String(error),
  };
}

export function assertOperationOutcome(
  value: unknown,
  label: string
): asserts value is OperationOutcome {
  if (!isOperationOutcome(value)) {
    throw new Error(`${label} must match the adapter OperationOutcome schema`);
  }
}

export function isOperationOutcome(value: unknown): value is OperationOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  if (value.kind === "result") {
    return "value" in value;
  }

  return value.kind === "error" && isAdapterErrorEnvelope(value.error);
}

function isAdapterErrorEnvelope(value: unknown): value is AdapterErrorEnvelope {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string"
  ) {
    return false;
  }

  return value.cause === undefined || isAdapterErrorEnvelope(value.cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
