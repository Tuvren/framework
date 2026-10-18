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

import { randomUUID } from "node:crypto";

import { assertScope, DEFAULT_SCOPE } from "@tuvren/core";
import type { EpochMs, Scope } from "@tuvren/core";
import type {
  AgentConfig,
  ExecutionBounds,
  HandoffContextBuilder,
} from "@tuvren/core/execution";
import { IDENTITY_PAYLOAD_CODEC } from "@tuvren/core/lifecycle";
import type { PayloadCodec } from "@tuvren/core/lifecycle";
import type { RunnerRegistry } from "@tuvren/core/runner";
import type { TelemetryRouting } from "@tuvren/core/telemetry";
import type { RuntimeKernel, TurnTreeSchema } from "@tuvren/kernel-protocol";

import { createRunnerRegistry } from "./runner-registry.js";
import { normalizeExecutionBounds } from "./runtime-core-bounds.js";
import type { ResolvedExecutionBounds } from "./runtime-core-bounds.js";
import {
  normalizeManifestExtensionStateWarningBudget,
  normalizeMaxParallelToolCalls,
  normalizeRunLivenessOptions,
} from "./runtime-core-facade-utils.js";

/** Schema id registered for {@link DEFAULT_AGENT_SCHEMA}. */
export const DEFAULT_AGENT_SCHEMA_ID = "tuvren.agent.v1";
/**
 * Default cap on tool calls executed concurrently within one iteration when
 * neither the runtime options nor the active agent config narrows it.
 */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;
/**
 * Default per-extension manifest state budget (256 KiB). When an extension's
 * serialized manifest state exceeds this, the runtime emits a
 * {@link RuntimeWarning} through `onWarning` (once per extension per handle).
 */
export const DEFAULT_MANIFEST_EXTENSION_STATE_WARNING_BUDGET_BYTES = 256 * 1024;

/**
 * Configuration for kernel-backed run liveness leases.
 *
 * When supplied via {@link RuntimeCoreOptions.runLiveness}, the runtime
 * acquires a lease per tracked run and renews it while the run is active, so
 * a crashed owner's runs become recoverable after `leaseDurationMs`. Requires
 * a kernel that implements the `kernel.run-liveness` extension; the runtime
 * constructor rejects the combination otherwise.
 */
export interface RuntimeRunLivenessOptions {
  /** Stable identifier of the process/host that owns leases it acquires. */
  executionOwnerId: string;
  /** Lease lifetime in milliseconds; must outlive one renewal interval. */
  leaseDurationMs: number;
  /** How long before expiry a renewal is attempted, in milliseconds. */
  renewBeforeMs?: number;
}

/**
 * The default turn-tree schema (`tuvren.agent.v1`) the runtime registers for
 * threads created without an explicit schema: an ordered `messages`
 * collection plus single-value `context.manifest`, `turn.lineage`, and
 * `runtime.status` paths, with matching incorporation rules per object type.
 */
export const DEFAULT_AGENT_SCHEMA: TurnTreeSchema = {
  incorporationRules: [
    { objectType: "message", targetPath: "messages" },
    { objectType: "context_manifest", targetPath: "context.manifest" },
    { objectType: "turn_lineage", targetPath: "turn.lineage" },
    { objectType: "runtime_status", targetPath: "runtime.status" },
  ],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
    { collection: "single", path: "turn.lineage" },
    { collection: "single", path: "runtime.status" },
  ],
  schemaId: DEFAULT_AGENT_SCHEMA_ID,
};

/**
 * Construction options for {@link createTuvrenRuntime}, the internal engine
 * factory behind `createTuvren` (which forwards its `runtimeOptions` here).
 */
export interface RuntimeCoreOptions {
  /**
   * Framework-enforced per-turn execution bounds (ADR-0043, KRT-BD006). Applied
   * above the runner's loop policy; unset fields take the §3.11 safe defaults
   * and every configured bound must be a finite positive integer.
   */
  bounds?: ExecutionBounds;
  /**
   * Identifier factory for thread/branch/run/step ids.
   *
   * @default `node:crypto` `randomUUID`
   */
  createId?: () => string;
  /**
   * Cap on tool calls executed concurrently within one iteration when the
   * active agent config does not narrow it further; always clamped to the
   * `maxConcurrentToolCalls` execution bound.
   *
   * @default {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}
   */
  defaultMaxParallelToolCalls?: number;
  /** Id of the runner used when a request does not name one; must resolve in
   * the runner registry when an execution materializes it. */
  defaultRunnerId: string;
  /**
   * Whether the runtime emits `state.checkpoint` observability events as turn
   * state advances.
   *
   * @default `true`
   */
  enableStateObservability?: boolean;
  /** Overrides the built-in default handoff context builders used when an
   * agent transition does not carry its own. */
  handoffContextBuilder?: HandoffContextBuilder;
  /** The kernel this runtime executes against — the transport-seam contract,
   * not a specific engine implementation. */
  kernel: RuntimeKernel;
  /**
   * Per-extension manifest state budget in bytes, or `false` to disable the
   * check. Warnings are only produced when `onWarning` is also set.
   *
   * @default {@link DEFAULT_MANIFEST_EXTENSION_STATE_WARNING_BUDGET_BYTES}
   */
  manifestExtensionStateWarningBudgetBytes?: false | number;
  /**
   * Clock used for timestamps, deadlines, and telemetry.
   *
   * @default `Date.now`
   */
  now?: () => EpochMs;
  /** Receives non-fatal {@link RuntimeWarning} notifications (currently the
   * manifest extension-state budget warning). */
  onWarning?: (warning: RuntimeWarning) => void;
  /**
   * Opt-in crypto-shredding codec (ADR-0051, KRT-BF005). When supplied, durable
   * untrusted-edge message payloads are encrypted under host-held keys before
   * `store.put`/`staging.stage` and decrypted on durable read; destroying a key
   * renders the payload unrecoverable while leaving the lineage hash structure
   * intact. Defaults to a plaintext identity codec, so unset hosts are unchanged.
   */
  payloadCodec?: PayloadCodec;
  /**
   * Substrate partition-drop callback for full tenant offboarding (ADR-0051,
   * §4.17). Wired by `createTuvren` from the owned backend's `purgeScope`; left
   * unset when the runtime is constructed against an externally-supplied kernel
   * (no owned substrate), in which case `maintenance.purgeScope()` rejects.
   */
  purgeScope?: () => Promise<void>;
  /**
   * Resolves an agent name to its configuration for multi-agent execution
   * (handoffs, failure attribution, recovered runs). Returning `undefined`
   * falls back to a minimal `{ name }` config for transition targets.
   */
  resolveAgentConfig?: (agentName: string) => AgentConfig | undefined;
  /**
   * Host hook that supplies the parent turn id for a new turn when the
   * request does not carry one explicitly; consulted before the kernel-derived
   * fallback.
   */
  resolveParentTurnId?: (
    threadId: string,
    branchId: string
  ) => Promise<string | null> | string | null;
  /**
   * Enables kernel-backed run liveness leases; requires a kernel implementing
   * the `kernel.run-liveness` extension (the constructor throws
   * `missing_run_liveness_extension` otherwise).
   */
  runLiveness?: RuntimeRunLivenessOptions;
  /**
   * Registry the runtime resolves runner ids against.
   *
   * @default An empty registry from `createRunnerRegistry()`.
   */
  runnerRegistry?: RunnerRegistry;
  /**
   * The host-bound Scope this runtime is constructed against (ADR-0048). It is
   * correlation context for operational telemetry and transcripts only — never
   * a kernel syscall argument — and should match the Scope the host bound to
   * the durable backend. Defaults to the single-tenant default Scope.
   */
  scope?: Scope;
  /**
   * Telemetry funnel routing: a bare sink, a destination, or a route combining
   * both. Unset disables runtime telemetry emission.
   */
  telemetry?: TelemetryRouting;
}

export interface ResolvedRuntimeCoreOptions {
  bounds: ResolvedExecutionBounds;
  createId: () => string;
  defaultMaxParallelToolCalls: number;
  defaultRunnerId: string;
  enableStateObservability: boolean;
  handoffContextBuilder?: HandoffContextBuilder;
  kernel: RuntimeKernel;
  manifestExtensionStateWarningBudgetBytes: false | number;
  now: () => EpochMs;
  onWarning?: (warning: RuntimeWarning) => void;
  payloadCodec: PayloadCodec;
  purgeScope?: () => Promise<void>;
  resolveAgentConfig?: (agentName: string) => AgentConfig | undefined;
  resolveParentTurnId?: (
    threadId: string,
    branchId: string
  ) => Promise<string | null> | string | null;
  runLiveness?: ResolvedRuntimeRunLivenessOptions;
  runnerRegistry: RunnerRegistry;
  scope: Scope;
  telemetry?: TelemetryRouting;
}

export interface ResolvedRuntimeRunLivenessOptions {
  executionOwnerId: string;
  leaseDurationMs: number;
  renewBeforeMs: number;
}

/**
 * A non-fatal runtime warning delivered to {@link RuntimeCoreOptions.onWarning}.
 *
 * Currently the single variant reports an extension whose serialized manifest
 * state exceeded the configured budget; it is emitted at most once per
 * warning key per execution handle and never interrupts the execution.
 */
export interface RuntimeWarning {
  /** Name of the agent active when the budget was exceeded. */
  activeAgent: string;
  /** The configured budget, in bytes. */
  budgetBytes: number;
  /** Discriminant for the warning variant. */
  code: "manifest_extension_state_budget_exceeded";
  /** The extension whose manifest state exceeded the budget. */
  extensionName: string;
  /** The serialized manifest-state size observed, in bytes. */
  observedBytes: number;
  /** Run correlation id. */
  runId: string;
  /** Thread correlation id. */
  threadId: string;
  /** Turn correlation id. */
  turnId: string;
}

// Resolves the host-supplied correlation Scope, defaulting single-tenant hosts
// to the default Scope and rejecting an empty binding the same way the durable
// backends do (assertScope), so telemetry and transcripts always carry a valid
// Scope identifier.
const resolveRuntimeScope = (scope: Scope | undefined): Scope => {
  const resolved = scope ?? DEFAULT_SCOPE;
  assertScope(resolved);
  return resolved;
};

/** Normalize runtime construction options once before any runtime work begins. */
export const resolveRuntimeCoreOptions = (
  options: RuntimeCoreOptions
): ResolvedRuntimeCoreOptions => ({
  bounds: normalizeExecutionBounds(options.bounds),
  createId: options.createId ?? randomUUID,
  defaultMaxParallelToolCalls: normalizeMaxParallelToolCalls(
    options.defaultMaxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS,
    "defaultMaxParallelToolCalls"
  ),
  defaultRunnerId: options.defaultRunnerId,
  enableStateObservability: options.enableStateObservability ?? true,
  handoffContextBuilder: options.handoffContextBuilder,
  kernel: options.kernel,
  manifestExtensionStateWarningBudgetBytes:
    options.manifestExtensionStateWarningBudgetBytes === undefined
      ? DEFAULT_MANIFEST_EXTENSION_STATE_WARNING_BUDGET_BYTES
      : normalizeManifestExtensionStateWarningBudget(
          options.manifestExtensionStateWarningBudgetBytes
        ),
  now: options.now ?? Date.now,
  onWarning: options.onWarning,
  payloadCodec: options.payloadCodec ?? IDENTITY_PAYLOAD_CODEC,
  purgeScope: options.purgeScope,
  resolveAgentConfig: options.resolveAgentConfig,
  resolveParentTurnId: options.resolveParentTurnId,
  runLiveness:
    options.runLiveness === undefined
      ? undefined
      : normalizeRunLivenessOptions(options.runLiveness),
  runnerRegistry: options.runnerRegistry ?? createRunnerRegistry(),
  scope: resolveRuntimeScope(options.scope),
  telemetry: options.telemetry,
});
