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

import { TuvrenRuntimeError } from "@tuvren/core";
import type { RuntimeResolution } from "@tuvren/core/execution";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { RunnerExecutionResult } from "@tuvren/core/runner";

import type { ExtensionStateUpdate } from "./extension-runtime.js";
import { cloneValue } from "./runtime-core-shared.js";

/**
 * Rejects runner resolutions that are inconsistent with the requested tool
 * calls.
 *
 * A runner that requests tool calls must resolve with "continue_iteration"
 * (or a partial "fail"); any other terminal resolution is invalid.
 * Runner-returned "pause" resolutions are always rejected here: approval
 * pauses may only originate from the shared core's own tool-approval flow.
 *
 * @returns A `TuvrenRuntimeError` with code `invalid_runner_resolution`, or
 * `undefined` when the combination is valid.
 */
export const findInvalidRunnerResolution = (
  requestedToolCallCount: number,
  resolution: RuntimeResolution,
  partial: boolean
): TuvrenRuntimeError | undefined => {
  if (
    requestedToolCallCount > 0 &&
    resolution.type !== "continue_iteration" &&
    !(partial && resolution.type === "fail")
  ) {
    return new TuvrenRuntimeError(
      "runners must not return executable tool calls with a terminal resolution",
      {
        code: "invalid_runner_resolution",
        details: {
          pauseRequiresToolCalls: resolution.type === "pause",
          resolutionType: resolution.type,
          toolCallCount: requestedToolCallCount,
        },
      }
    );
  }

  if (requestedToolCallCount === 0 && resolution.type === "pause") {
    return new TuvrenRuntimeError(
      "shared core only permits approval pauses that originate from requested tool calls",
      {
        code: "invalid_runner_resolution",
        details: {
          pauseRequiresToolCalls: true,
          resolutionType: resolution.type,
          toolCallCount: requestedToolCallCount,
        },
      }
    );
  }

  return undefined;
};

/**
 * Validates that every runner-returned extension state update targets an
 * extension active in the current agent config.
 *
 * @returns A `TuvrenRuntimeError` with code `invalid_runner_result` naming
 * the first unknown extension, or `undefined` when all targets are active
 * (or no updates were returned).
 */
export const findInvalidRunnerStateUpdateError = (
  activeExtensions: TuvrenExtension[],
  stateUpdates: RunnerExecutionResult["stateUpdates"]
): TuvrenRuntimeError | undefined => {
  if (stateUpdates === undefined || stateUpdates.length === 0) {
    return undefined;
  }

  const activeExtensionNames = new Set(
    activeExtensions.map((extension) => extension.name)
  );

  for (const update of stateUpdates) {
    if (activeExtensionNames.has(update.extensionName)) {
      continue;
    }

    return new TuvrenRuntimeError(
      "runner state updates must target extensions active in the current agent config",
      {
        code: "invalid_runner_result",
        details: {
          extensionName: update.extensionName,
        },
      }
    );
  }

  return undefined;
};

/**
 * Appends runner-returned extension state updates to the loop's carried
 * updates, cloning each state payload so later mutation by the runner cannot
 * leak into staged manifests.
 */
export const applyRunnerStateUpdates = (
  loopState: {
    carriedStateUpdates: ExtensionStateUpdate[];
  },
  stateUpdates: RunnerExecutionResult["stateUpdates"]
): void => {
  if (stateUpdates === undefined) {
    return;
  }

  loopState.carriedStateUpdates.push(
    ...stateUpdates.map((update) => ({
      extensionName: update.extensionName,
      state: cloneValue(update.state),
    }))
  );
};

/**
 * Aggregates the runner-result validations for one iteration in precedence
 * order: resolution/tool-call consistency (skipped when a cancellation
 * resolution overrides the runner's), assistant event validation, then
 * extension state-update targeting.
 *
 * @returns The first validation error found, or `undefined` when the runner
 * result is acceptable.
 */
export const findInvalidRunnerExecutionError = (
  activeExtensions: TuvrenExtension[],
  requestedToolCallCount: number,
  resolution: RuntimeResolution,
  cancellationResolution: RuntimeResolution | undefined,
  partial: boolean,
  assistantEventValidationError: TuvrenRuntimeError | undefined,
  stateUpdates: RunnerExecutionResult["stateUpdates"]
): TuvrenRuntimeError | undefined => {
  if (cancellationResolution === undefined) {
    const invalidRunnerResolutionError = findInvalidRunnerResolution(
      requestedToolCallCount,
      resolution,
      partial
    );

    if (invalidRunnerResolutionError !== undefined) {
      return invalidRunnerResolutionError;
    }
  }

  if (assistantEventValidationError !== undefined) {
    return assistantEventValidationError;
  }

  return findInvalidRunnerStateUpdateError(activeExtensions, stateUpdates);
};
