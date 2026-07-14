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
  onError?(input: { error: Error; extensionName: string }): void;
}

interface HookRunResult {
  cePlan?: ContextEngineeringPlan;
  resolution?: RuntimeResolution;
  updates: ExtensionStateUpdate[];
}

interface HookExecutionOptions {
  emit(event: { data: unknown; name: string }): void;
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

/**
 * Projects each extension's `exports`-listed keys out of its manifest state
 * slice into the cross-extension visibility map handed to hooks as
 * `sharedExports` (KrakenFrameworkSpecification §9). Extensions that declare
 * no exports are omitted; declared keys absent from state are skipped, and
 * exported values are cloned so consumers cannot mutate manifest state.
 */
export function buildSharedExports(
  extensions: TuvrenExtension[],
  manifest: ContextManifest
): Record<string, Record<string, unknown>> {
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
}

/**
 * Collects extension `systemPrompt` contributions in registration order,
 * accepting both static strings and computed contributions (called with
 * cloned extension state, the manifest, and {@link buildSharedExports}
 * output). A computed contribution that throws is skipped and surfaced via
 * {@link CollectSystemPromptsOptions.onError}; one returning `undefined`
 * contributes nothing (KrakenFrameworkSpecification §9).
 */
export function collectSystemPrompts(
  extensions: TuvrenExtension[],
  manifest: ContextManifest,
  iterationCount: number,
  options?: CollectSystemPromptsOptions
): string[] {
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
}

/**
 * Runs `beforeTurn` hooks in registration order and composes their verdicts
 * by RuntimeResolution precedence (KrakenFrameworkSpecification §9). A hook
 * that throws or exceeds its extension `timeout` contributes a `softFail`
 * resolution instead of aborting the pass.
 */
export async function runBeforeTurnHooks(
  options: HookExecutionOptions
): Promise<HookRunResult> {
  return await runInterceptHooks(options, "beforeTurn", false);
}

/**
 * Runs `beforeIteration` hooks in registration order. Behaves like
 * {@link runBeforeTurnHooks}, and additionally surfaces the first
 * context-engineering plan (`cePlan`) a hook returns.
 */
export async function runBeforeIterationHooks(
  options: HookExecutionOptions
): Promise<HookRunResult> {
  return await runInterceptHooks(options, "beforeIteration", false);
}

/**
 * Runs `afterTurn` hooks in reverse registration order
 * (KrakenFrameworkSpecification §9); otherwise behaves like
 * {@link runBeforeTurnHooks}.
 */
export async function runAfterTurnHooks(
  options: HookExecutionOptions
): Promise<HookRunResult> {
  return await runInterceptHooks(options, "afterTurn", true);
}

/**
 * Runs `afterIteration` hooks in reverse registration order, giving each the
 * complete committed iteration — model response, tool results, and the loop
 * resolution — alongside the standard hook context
 * (KrakenFrameworkSpecification §9). Verdicts compose by RuntimeResolution
 * precedence, and a hook that throws or times out contributes a `softFail`.
 */
export async function runAfterIterationHooks(
  options: AfterIterationOptions
): Promise<HookRunResult> {
  const { extensions } = options;
  const updates: ExtensionStateUpdate[] = [];
  let resolution: RuntimeResolution | undefined;

  for (const extension of [...extensions].reverse()) {
    if (extension.afterIteration === undefined) {
      continue;
    }

    const timeoutController = new AbortController();

    try {
      const result = await runWithTimeout(
        () =>
          extension.afterIteration?.({
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
  }

  return {
    resolution,
    updates,
  };
}

function composeResolution(
  left: RuntimeResolution | undefined,
  right: RuntimeResolution | undefined
): RuntimeResolution | undefined {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return resolutionRank(left) >= resolutionRank(right) ? left : right;
}

function resolutionRank(resolution: RuntimeResolution): number {
  switch (resolution.type) {
    case "fail":
      return resolution.fatality === "hard" ? 6 : 2;
    case "pause":
      return 5;
    case "handoff":
      return 4;
    case "end_turn":
      return 3;
    case "continue_iteration":
      return 1;
    default:
      return 0;
  }
}

async function runInterceptHooks(
  options: HookExecutionOptions,
  hookName: "afterTurn" | "beforeIteration" | "beforeTurn",
  reverseOrder: boolean
): Promise<HookRunResult> {
  const orderedExtensions = reverseOrder
    ? [...options.extensions].reverse()
    : options.extensions;
  const updates: ExtensionStateUpdate[] = [];
  let cePlan: ContextEngineeringPlan | undefined;
  let resolution: RuntimeResolution | undefined;

  for (const extension of orderedExtensions) {
    const handler = extension[hookName];

    if (handler === undefined) {
      continue;
    }

    const timeoutController = new AbortController();

    try {
      const result = await runWithTimeout(
        () =>
          handler.call(
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
  }

  return {
    cePlan,
    resolution,
    updates,
  };
}

function createInterceptContext(
  extension: TuvrenExtension,
  options: HookExecutionOptions,
  timeoutSignal: AbortSignal
): InterceptContext {
  return {
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
  };
}

function collectHookState(
  extensionName: string,
  result: (InterceptResult & { cePlan?: ContextEngineeringPlan }) | undefined,
  updates: ExtensionStateUpdate[]
): void {
  if (result?.state !== undefined) {
    updates.push({
      extensionName,
      state: result.state,
    });
  }
}

function liftInterceptResult(
  result: InterceptResult | undefined
): RuntimeResolution | undefined {
  switch (result?.verdict) {
    case "endTurn":
      if (result.reason === undefined) {
        throw new TuvrenRuntimeError("endTurn verdicts require a reason", {
          code: "invalid_extension_verdict",
        });
      }
      return {
        reason: result.reason,
        type: "end_turn",
      };
    case "hardFail":
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
    case "softFail":
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
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function buildContextSharedExports(
  extensions: TuvrenExtension[],
  manifest: ContextManifest
): Record<string, Record<string, unknown>> {
  return cloneValue(buildSharedExports(extensions, manifest));
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return asRecord(cloneValue(asRecord(value)));
}

function cloneValue<T>(value: T): T {
  return globalThis.structuredClone(value);
}

function createTimedEmit(
  emit: (event: { data: unknown; name: string }) => void,
  timeoutSignal: AbortSignal
): (event: { data: unknown; name: string }) => void {
  return (event) => {
    if (timeoutSignal.aborted) {
      return;
    }

    emit(event);
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function hasContextEngineeringPlan(
  value: InterceptResult & { cePlan?: ContextEngineeringPlan }
): value is InterceptResult & { cePlan: ContextEngineeringPlan } {
  return value.cePlan !== undefined;
}
