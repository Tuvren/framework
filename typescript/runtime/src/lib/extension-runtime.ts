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
import type {
  ContextEngineeringPlan,
  ContextManifest,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type {
  AfterIterationContext,
  InterceptContext,
  InterceptResult,
  TuvrenExtension,
} from "@tuvren/core/extensions";
import type { TuvrenMessage } from "@tuvren/core/messages";

import { runWithTimeout } from "./execution-timeouts.js";

/**
 * A state patch returned by one extension's hook, keyed by extension name.
 * The runtime shallow-merges `state` into that extension's slice of
 * `ContextManifest.extensions` when the iteration's manifest is updated
 * (KrakenFrameworkSpecification §9).
 */
export interface ExtensionStateUpdate {
  extensionName: string;
  state: Record<string, unknown>;
}

/** Options for {@link collectSystemPrompts}. */
export interface CollectSystemPromptsOptions {
  /**
   * Called when a computed `systemPrompt` contribution throws; the failing
   * extension is skipped and collection continues with the remaining ones.
   */
  onError?: (input: { error: Error; extensionName: string }) => void;
}

interface HookRunResult {
  cePlan?: ContextEngineeringPlan;
  resolution?: RuntimeResolution;
  updates: ExtensionStateUpdate[];
}

interface HookExecutionOptions {
  emit: (event: { data: unknown; name: string }) => void;
  extensions: TuvrenExtension[];
  iterationCount: number;
  manifest: ContextManifest;
  messages: TuvrenMessage[];
  runId: string;
  turnId: string;
}

interface AfterIterationOptions extends HookExecutionOptions {
  resolution: RuntimeResolution;
  response: AfterIterationContext["response"];
  toolResults?: AfterIterationContext["toolResults"];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const cloneValue = <T>(value: T): T => globalThis.structuredClone(value);

/**
 * Projects each extension's `exports`-listed keys out of its manifest state
 * slice into the cross-extension visibility map handed to hooks as
 * `sharedExports` (KrakenFrameworkSpecification §9). Extensions that declare
 * no exports are omitted; declared keys absent from state are skipped, and
 * exported values are cloned so consumers cannot mutate manifest state.
 */
export const buildSharedExports = (
  extensions: TuvrenExtension[],
  manifest: ContextManifest
): Record<string, Record<string, unknown>> => {
  const sharedExports: Record<string, Record<string, unknown>> = {};

  for (const extension of extensions) {
    const exportedState = extension.exports;

    if (exportedState === undefined || exportedState.length === 0) {
      continue;
    }

    const extensionState = asRecord(manifest.extensions[extension.name]);
    const visibleState: Record<string, unknown> = {};

    for (const key of exportedState) {
      if (key in extensionState) {
        visibleState[key] = cloneValue(extensionState[key]);
      }
    }

    sharedExports[extension.name] = visibleState;
  }

  return sharedExports;
};

const cloneRecord = (value: unknown): Record<string, unknown> =>
  asRecord(cloneValue(asRecord(value)));

const buildContextSharedExports = (
  extensions: TuvrenExtension[],
  manifest: ContextManifest
): Record<string, Record<string, unknown>> =>
  cloneValue(buildSharedExports(extensions, manifest));

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * Collects extension `systemPrompt` contributions in registration order,
 * accepting both static strings and computed contributions (called with
 * cloned extension state, the manifest, and {@link buildSharedExports}
 * output). A computed contribution that throws is skipped and surfaced via
 * {@link CollectSystemPromptsOptions.onError}; one returning `undefined`
 * contributes nothing (KrakenFrameworkSpecification §9).
 */
export const collectSystemPrompts = (
  extensions: TuvrenExtension[],
  manifest: ContextManifest,
  iterationCount: number,
  options?: CollectSystemPromptsOptions
): string[] => {
  const prompts: string[] = [];

  for (const extension of extensions) {
    const contribution = extension.systemPrompt;

    if (contribution === undefined) {
      continue;
    }

    try {
      const prompt =
        typeof contribution === "string"
          ? contribution
          : contribution.call(extension, {
              extensionState: cloneRecord(manifest.extensions[extension.name]),
              iterationCount,
              manifest: cloneValue(manifest),
              sharedExports: buildContextSharedExports(extensions, manifest),
            });

      if (prompt !== undefined) {
        prompts.push(prompt);
      }
    } catch (error: unknown) {
      options?.onError?.({
        error: normalizeError(error),
        extensionName: extension.name,
      });
    }
  }

  return prompts;
};

const createTimedEmit =
  (
    emit: (event: { data: unknown; name: string }) => void,
    timeoutSignal: AbortSignal
  ): ((event: { data: unknown; name: string }) => void) =>
  (event) => {
    if (timeoutSignal.aborted) {
      return;
    }

    emit(event);
  };

const createInterceptContext = (
  extension: TuvrenExtension,
  options: HookExecutionOptions,
  timeoutSignal: AbortSignal
): InterceptContext => ({
  emit: createTimedEmit(options.emit, timeoutSignal),
  extensionState: cloneRecord(options.manifest.extensions[extension.name]),
  iterationCount: options.iterationCount,
  manifest: cloneValue(options.manifest),
  messages: cloneValue(options.messages),
  runId: options.runId,
  sharedExports: buildContextSharedExports(
    options.extensions,
    options.manifest
  ),
  turnId: options.turnId,
});

const collectHookState = (
  extensionName: string,
  result: (InterceptResult & { cePlan?: ContextEngineeringPlan }) | undefined,
  updates: ExtensionStateUpdate[]
): void => {
  if (result?.state !== undefined) {
    updates.push({
      extensionName,
      state: result.state,
    });
  }
};

const hasContextEngineeringPlan = (
  value: InterceptResult & { cePlan?: ContextEngineeringPlan }
): value is InterceptResult & { cePlan: ContextEngineeringPlan } =>
  value.cePlan !== undefined;

const resolutionRank = (resolution: RuntimeResolution): number => {
  switch (resolution.type) {
    case "fail": {
      return resolution.fatality === "hard" ? 6 : 2;
    }
    case "pause": {
      return 5;
    }
    case "handoff": {
      return 4;
    }
    case "end_turn": {
      return 3;
    }
    case "continue_iteration": {
      return 1;
    }
    default: {
      return 0;
    }
  }
};

const composeResolution = (
  left: RuntimeResolution | undefined,
  right: RuntimeResolution | undefined
): RuntimeResolution | undefined => {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return resolutionRank(left) >= resolutionRank(right) ? left : right;
};

const liftInterceptResult = (
  result: InterceptResult | undefined
): RuntimeResolution | undefined => {
  switch (result?.verdict) {
    case "endTurn": {
      if (result.reason === undefined) {
        throw new TuvrenRuntimeError("endTurn verdicts require a reason", {
          code: "invalid_extension_verdict",
        });
      }
      return {
        reason: result.reason,
        type: "end_turn",
      };
    }
    case "hardFail": {
      if (result.error === undefined) {
        throw new TuvrenRuntimeError("hardFail verdicts require an error", {
          code: "invalid_extension_verdict",
        });
      }
      return {
        error: result.error,
        fatality: "hard",
        type: "fail",
      };
    }
    case "softFail": {
      if (result.error === undefined) {
        throw new TuvrenRuntimeError("softFail verdicts require an error", {
          code: "invalid_extension_verdict",
        });
      }
      return {
        error: result.error,
        fatality: "soft",
        type: "fail",
      };
    }
    case undefined: {
      return undefined;
    }
    default: {
      return undefined;
    }
  }
};

const runInterceptHooks = async (
  options: HookExecutionOptions,
  hookName: "afterTurn" | "beforeIteration" | "beforeTurn",
  reverseOrder: boolean
): Promise<HookRunResult> => {
  const orderedExtensions = reverseOrder
    ? options.extensions.toReversed()
    : options.extensions;
  const updates: ExtensionStateUpdate[] = [];
  let cePlan: ContextEngineeringPlan | undefined;
  let resolution: RuntimeResolution | undefined;

  const runHookAt = async (index: number): Promise<void> => {
    let nextIndex = index;
    let extension = orderedExtensions[nextIndex];
    let handler = extension?.[hookName];

    while (extension !== undefined && handler === undefined) {
      nextIndex += 1;
      extension = orderedExtensions[nextIndex];
      handler = extension?.[hookName];
    }

    if (extension === undefined || handler === undefined) {
      return;
    }

    const timeoutController = new AbortController();

    try {
      const result = await runWithTimeout(
        async () =>
          await handler.call(
            extension,
            createInterceptContext(extension, options, timeoutController.signal)
          ),
        extension.timeout,
        () =>
          new Error(
            `extension "${extension.name}" ${hookName} timed out after ${extension.timeout}ms`
          ),
        {
          onTimeout: (error) => {
            timeoutController.abort(error);
          },
        }
      );
      collectHookState(extension.name, result, updates);

      if (
        hookName === "beforeIteration" &&
        result !== undefined &&
        hasContextEngineeringPlan(result)
      ) {
        cePlan ??= result.cePlan;
      }

      resolution = composeResolution(resolution, liftInterceptResult(result));
    } catch (error: unknown) {
      resolution = composeResolution(
        resolution,
        liftInterceptResult({
          error: normalizeError(error),
          verdict: "softFail",
        })
      );
    }

    await runHookAt(nextIndex + 1);
  };

  await runHookAt(0);

  return {
    cePlan,
    resolution,
    updates,
  };
};

/**
 * Runs `beforeTurn` hooks in registration order and composes their verdicts
 * by RuntimeResolution precedence (KrakenFrameworkSpecification §9). A hook
 * that throws or exceeds its extension `timeout` contributes a `softFail`
 * resolution instead of aborting the pass.
 */
export const runBeforeTurnHooks = async (
  options: HookExecutionOptions
): Promise<HookRunResult> =>
  await runInterceptHooks(options, "beforeTurn", false);

/**
 * Runs `beforeIteration` hooks in registration order. Behaves like
 * {@link runBeforeTurnHooks}, and additionally surfaces the first
 * context-engineering plan (`cePlan`) a hook returns.
 */
export const runBeforeIterationHooks = async (
  options: HookExecutionOptions
): Promise<HookRunResult> =>
  await runInterceptHooks(options, "beforeIteration", false);

/**
 * Runs `afterTurn` hooks in reverse registration order
 * (KrakenFrameworkSpecification §9); otherwise behaves like
 * {@link runBeforeTurnHooks}.
 */
export const runAfterTurnHooks = async (
  options: HookExecutionOptions
): Promise<HookRunResult> =>
  await runInterceptHooks(options, "afterTurn", true);

/**
 * Runs `afterIteration` hooks in reverse registration order, giving each the
 * complete committed iteration — model response, tool results, and the loop
 * resolution — alongside the standard hook context
 * (KrakenFrameworkSpecification §9). Verdicts compose by RuntimeResolution
 * precedence, and a hook that throws or times out contributes a `softFail`.
 */
export const runAfterIterationHooks = async (
  options: AfterIterationOptions
): Promise<HookRunResult> => {
  const { extensions } = options;
  const updates: ExtensionStateUpdate[] = [];
  let resolution: RuntimeResolution | undefined;

  const orderedExtensions = extensions.toReversed();
  const runHookAt = async (index: number): Promise<void> => {
    let nextIndex = index;
    let extension = orderedExtensions[nextIndex];
    let handler = extension?.afterIteration;

    while (extension !== undefined && handler === undefined) {
      nextIndex += 1;
      extension = orderedExtensions[nextIndex];
      handler = extension?.afterIteration;
    }

    if (extension === undefined || handler === undefined) {
      return;
    }
    const timeoutController = new AbortController();

    try {
      const result = await runWithTimeout(
        async () =>
          await handler.call(extension, {
            emit: createTimedEmit(options.emit, timeoutController.signal),
            extensionState: cloneRecord(
              options.manifest.extensions[extension.name]
            ),
            iterationCount: options.iterationCount,
            manifest: cloneValue(options.manifest),
            messages: cloneValue(options.messages),
            resolution: cloneValue(options.resolution),
            response: cloneValue(options.response),
            runId: options.runId,
            sharedExports: buildContextSharedExports(
              extensions,
              options.manifest
            ),
            toolResults: cloneValue(options.toolResults),
            turnId: options.turnId,
          }),
        extension.timeout,
        () =>
          new Error(
            `extension "${extension.name}" afterIteration timed out after ${extension.timeout}ms`
          ),
        {
          onTimeout: (error) => {
            timeoutController.abort(error);
          },
        }
      );

      collectHookState(extension.name, result, updates);
      resolution = composeResolution(resolution, liftInterceptResult(result));
    } catch (error: unknown) {
      resolution = composeResolution(
        resolution,
        liftInterceptResult({
          error: normalizeError(error),
          verdict: "softFail",
        })
      );
    }

    await runHookAt(nextIndex + 1);
  };

  await runHookAt(0);

  return {
    resolution,
    updates,
  };
};
