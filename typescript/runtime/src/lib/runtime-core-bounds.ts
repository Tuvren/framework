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

/**
 * Framework-enforced execution bounds guard (ADR-043, KRT-BD006).
 *
 * These helpers resolve and validate the per-runtime {@link ExecutionBounds} and
 * build the stable `execution_bound_exceeded` terminal error. The guard lives
 * above the driver's `LoopPolicy` so a misbehaving or adversarial driver cannot
 * raise or disable a bound.
 *
 * Model or tool work whose completion arrives after the framework has stopped
 * awaiting it at a bounded abort reaches the `"ignored"` `InvocationLifecycleState`
 * (forward-declared in Epic BA): the late result is discarded by the terminal
 * settle guard and cannot reopen or mutate the bounded turn. See
 * `RuntimeExecutionHandle.settleResult`.
 */

import { TuvrenRuntimeError } from "@tuvren/core";
import { EXECUTION_BOUND_EXCEEDED } from "@tuvren/core/errors";
import type {
  ExecutionBoundExceededDetails,
  ExecutionBoundKind,
  ExecutionBounds,
} from "@tuvren/core/execution";

/** Fully-resolved bounds with every field present (defaults applied). */
export interface ResolvedExecutionBounds {
  maxConcurrentToolCalls: number;
  maxIterations: number;
  maxToolCalls: number;
  maxWallClockMs: number;
}

/** §3.11 safe defaults applied to any unset bound field. */
export const DEFAULT_EXECUTION_BOUNDS: ResolvedExecutionBounds = {
  maxConcurrentToolCalls: 16,
  maxIterations: 64,
  maxToolCalls: 256,
  maxWallClockMs: 600_000,
};

/**
 * Resolve host-supplied bounds against the §3.11 safe defaults, validating that
 * every configured field is a finite positive integer. Hosts may raise or lower
 * finite limits but may not disable the guard with `Infinity`, `NaN`, zero, or
 * negative values.
 */
export function normalizeExecutionBounds(
  bounds: ExecutionBounds | undefined
): ResolvedExecutionBounds {
  if (bounds === undefined) {
    return DEFAULT_EXECUTION_BOUNDS;
  }

  return {
    maxConcurrentToolCalls: normalizeBoundField(
      bounds.maxConcurrentToolCalls,
      "maxConcurrentToolCalls"
    ),
    maxIterations: normalizeBoundField(bounds.maxIterations, "maxIterations"),
    maxToolCalls: normalizeBoundField(bounds.maxToolCalls, "maxToolCalls"),
    maxWallClockMs: normalizeBoundField(
      bounds.maxWallClockMs,
      "maxWallClockMs"
    ),
  };
}

function normalizeBoundField(
  value: number | undefined,
  field: keyof ResolvedExecutionBounds
): number {
  if (value === undefined) {
    return DEFAULT_EXECUTION_BOUNDS[field];
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TuvrenRuntimeError(
      `bounds.${field} must be a finite positive integer`,
      {
        code: "invalid_runtime_options",
        details: { [`bounds.${field}`]: value },
      }
    );
  }

  return value;
}

/**
 * Build the stable terminal error finalized on the failed `ExecutionResult`,
 * the fatal canonical `error` event, and the bounded-execution telemetry event.
 */
export function createBoundExceededError(
  bound: ExecutionBoundKind,
  limit: number,
  observed: number
): TuvrenRuntimeError {
  const details: ExecutionBoundExceededDetails = { bound, limit, observed };
  return new TuvrenRuntimeError(
    `Execution bound ${bound} exceeded: observed ${observed} exceeds limit ${limit}`,
    {
      code: EXECUTION_BOUND_EXCEEDED,
      details,
    }
  );
}

/** Narrow an unknown value to the bounds terminal error carrying its details. */
export function isBoundExceededError(
  value: unknown
): value is TuvrenRuntimeError & { details: ExecutionBoundExceededDetails } {
  return (
    value instanceof TuvrenRuntimeError &&
    value.code === EXECUTION_BOUND_EXCEEDED &&
    isExecutionBoundExceededDetails(value.details)
  );
}

/** Extract the bound details from a bounds terminal error, if present. */
export function getBoundExceededDetails(
  error: unknown
): ExecutionBoundExceededDetails | undefined {
  return isBoundExceededError(error) ? error.details : undefined;
}

function isExecutionBoundExceededDetails(
  value: unknown
): value is ExecutionBoundExceededDetails {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.bound === "maxIterations" ||
      record.bound === "maxToolCalls" ||
      record.bound === "maxWallClockMs") &&
    typeof record.limit === "number" &&
    typeof record.observed === "number"
  );
}
