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

import type { EpochMs, HashString } from "./kernel-records.js";
import type {
  AgentConfig,
  ApprovalResponse,
  ContextManifest,
  HandoffContextBuilder,
  HandoffContextMode,
  HandoffContextPlan,
  RuntimeResolution,
  ToolRegistry,
  TuvrenMessage,
  TuvrenStreamEvent,
} from "./runtime-contract-shapes.js";

/**
 * Runtime capabilities the framework lends a runner during execution
 * (KrakenFrameworkSpecification §5.6).
 *
 * `emit(...)` is a runner-owned streaming surface for custom events and
 * assistant/provider stream-content events only; framework-owned lifecycle
 * events (`turn.*`, `iteration.*`, `tool.*`, `approval.*`, `state.*`,
 * `error`) are emitted by shared core itself. `now()` is the canonical
 * clock so runner-produced timestamps stay consistent with the framework's.
 */
export interface RunnerRuntimePort {
  emit(event: TuvrenStreamEvent): Promise<void> | void;
  now(): EpochMs;
}

/**
 * Framework-provided factory for handoff context plans
 * (KrakenFrameworkSpecification §5.6). A runner that detects a handoff
 * intent calls `createContextPlan` and returns the resulting plan inside a
 * `handoff` resolution; the framework executes the plan's builder later,
 * during a dedicated handoff context-engineering run, not at resolution
 * time.
 */
export interface RunnerHandoffPort {
  createContextPlan(input: {
    builder?: HandoffContextBuilder;
    mode?: HandoffContextMode;
    payload?: unknown;
    reason: string;
    targetAgent: string;
  }): HandoffContextPlan;
}

/**
 * The immutable execution snapshot handed to a runner for one iteration
 * (KrakenFrameworkSpecification §5.6): snapshots in, capabilities through
 * ports, explicit results out.
 *
 * `config`, `messages`, `manifest`, and `toolRegistry` are read-only
 * snapshots of framework-owned state; a runner must not mutate framework
 * state by aliasing them, and influences the framework only through the
 * returned {@link RunnerExecutionResult}. `runtime` and `handoff` are the
 * capability ports, and `signal`, when present, carries cancellation.
 */
export interface RunnerExecutionContext {
  branchId: string;
  config: Readonly<AgentConfig>;
  handoff: RunnerHandoffPort;
  iterationCount: number;
  manifest: Readonly<ContextManifest>;
  messages: readonly TuvrenMessage[];
  runtime: RunnerRuntimePort;
  schemaId: string;
  signal?: AbortSignal;
  threadId: string;
  toolRegistry: Readonly<ToolRegistry>;
  turnId: string;
}

/**
 * Execution context for an optional runner-owned approval resume: the base
 * snapshot plus the operator's {@link ApprovalResponse} and, when resuming
 * from a checkpoint, the `resumedFrom` turn-node hash. The shared core
 * handles approval resume around the paused tool batch itself, so most
 * runners never receive this context (KrakenFrameworkSpecification §5.6).
 */
export interface RunnerResumeContext extends RunnerExecutionContext {
  approval: ApprovalResponse;
  resumedFrom?: HashString;
}

/**
 * How the framework should dispatch the tool calls requested by the staged
 * assistant message. Required on a {@link RunnerExecutionResult} exactly
 * when its messages request tool calls, and invalid otherwise
 * (KrakenFrameworkSpecification §5.6).
 */
export type RunnerToolExecutionMode = "parallel" | "sequential";

/**
 * Opt-in marker allowing the final emitted assistant event sequence to
 * diverge from the durable assistant message — the `aroundModel`
 * post-stream replacement case. Without it, shared core requires the
 * runner-emitted assistant stream to reconcile exactly with the returned
 * durable message (KrakenFrameworkSpecification §5.6).
 */
export type RunnerAssistantEventReconciliation =
  "allow_final_sequence_divergence";

/**
 * A per-extension state update to merge at the same checkpoint that commits
 * the assistant message and updated manifest
 * (KrakenFrameworkSpecification §5.6).
 */
export interface RunnerExtensionStateUpdate {
  extensionName: string;
  state: Record<string, unknown>;
}

/**
 * The explicit output of one runner iteration — the only channel through
 * which a runner influences framework state
 * (KrakenFrameworkSpecification §5.6).
 *
 * Intentionally minimal: `resolution` is always required; `messages` carry
 * at most one assistant message of durable history (plus pre-staged
 * provider tool messages); `partial` is valid only for failed results that
 * stage an assistant message; `toolExecutionMode` is required exactly when
 * tool calls are requested. `assertRunnerExecutionResult` in
 * `runner-contract-guards.ts` enforces the full invariant set.
 */
export interface RunnerExecutionResult {
  assistantEventReconciliation?: RunnerAssistantEventReconciliation;
  messages?: TuvrenMessage[];
  partial?: boolean;
  resolution: RuntimeResolution;
  stateUpdates?: RunnerExtensionStateUpdate[];
  toolExecutionMode?: RunnerToolExecutionMode;
}

/**
 * The shared runner seam (KrakenFrameworkSpecification §5.6): a stable `id`
 * plus an `execute` function taking an immutable snapshot context and
 * returning an explicit {@link RunnerExecutionResult}. `resume` is optional
 * — approval resume is handled by the framework around the paused tool
 * batch, so a runner-owned resume path sits outside the current shared-core
 * execution path.
 */
export interface RuntimeRunner {
  execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult>;
  readonly id: string;
  resume?(context: RunnerResumeContext): Promise<RunnerExecutionResult>;
}

/**
 * Factory form of the runner seam: shares the runner `id` and creates a
 * fresh {@link RuntimeRunner} instance per use, for runners that keep
 * per-execution state.
 */
export interface RuntimeRunnerFactory {
  create(): RuntimeRunner;
  readonly id: string;
}

/**
 * Registry of runners and runner factories, keyed by their `id`:
 * `register` adds an entry, `resolve` looks one up by runner id, and
 * `list` enumerates everything registered.
 */
export interface RunnerRegistry {
  list(): Array<RuntimeRunner | RuntimeRunnerFactory>;
  register(runner: RuntimeRunner | RuntimeRunnerFactory): void;
  resolve(runnerId: string): RuntimeRunner | RuntimeRunnerFactory | undefined;
}
