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

import { createHash } from "node:crypto";
import {
  assertKernelRecord,
  type HashString,
  TuvrenRuntimeError,
} from "@tuvren/core";
import type { ClientEndpointBoundary } from "@tuvren/core/capabilities";
import type { AgentConfig, ContextManifest } from "@tuvren/core/execution";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { ToolRegistry, TuvrenToolDefinition } from "@tuvren/core/tools";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import { createClientEndpointBoundary } from "./client-endpoint-boundary.js";
import type { ExtensionStateUpdate } from "./extension-runtime.js";
import type { RuntimeRunLivenessOptions } from "./runtime-core.js";
import {
  cloneSnapshotPreservingFunctions,
  cloneValue,
  createFrozenSnapshot,
} from "./runtime-core-shared.js";
import {
  buildClientEndpointTools,
  createToolRegistry,
} from "./tool-registry.js";

/**
 * Per-registry cache so {@link createReadonlyRunnerToolRegistry} returns the
 * same frozen view for repeated calls with the same underlying registry.
 */
const readonlyRunnerToolRegistryCache = new WeakMap<
  ToolRegistry,
  ToolRegistry
>();

/**
 * Create or resolve the ClientEndpointBoundary for the given AgentConfig.
 *
 * When `config.clientEndpointBoundary` is provided, that pre-built boundary
 * is used directly — this lets hosts call `boundary.detach()` before the turn
 * to prove the `capability_binding_unavailable` typed outcome (KRT-AZ003).
 * When absent, a fresh boundary is created from `config.clientEndpoints`.
 * Returns undefined when no client endpoints or boundary are configured.
 * (KRT-AZ001)
 */
export function createClientEndpointBoundaryFromConfig(
  config: AgentConfig
): ClientEndpointBoundary | undefined {
  if (config.clientEndpointBoundary !== undefined) {
    return config.clientEndpointBoundary;
  }
  const endpoints = config.clientEndpoints ?? [];
  return endpoints.length > 0
    ? createClientEndpointBoundary(endpoints)
    : undefined;
}

/**
 * Create the active tool registry for a turn.
 *
 * When a clientEndpointBoundary is provided (created from AgentConfig.clientEndpoints),
 * synthetic tuvren-client tool definitions are added to the registry for each
 * advertised capability. The boundary must be stored on LoopState so the
 * tool-execution path can dispatch to the correct endpoint. (KRT-AZ001)
 */
export function createActiveToolRegistry(
  requestTools: TuvrenToolDefinition[] | undefined,
  config: AgentConfig,
  clientEndpointBoundary?: ClientEndpointBoundary
): ToolRegistry {
  const clientEndpointTools = clientEndpointBoundary
    ? buildClientEndpointTools(
        config.clientEndpoints ?? [],
        clientEndpointBoundary
      )
    : [];

  const activeTools = [
    ...(requestTools ?? config.tools ?? []),
    ...clientEndpointTools,
  ];
  return createToolRegistry(activeTools, config.extensions ?? []);
}

/**
 * Resolves the effective parallel-tool-call limit for a turn from
 * `config.maxParallelToolCalls`, falling back to the runtime default.
 *
 * @throws TuvrenRuntimeError with code `invalid_runtime_options` when the
 *   resolved value is not a positive safe integer.
 */
export function resolveActiveMaxParallelToolCalls(
  config: AgentConfig,
  defaultMaxParallelToolCalls: number
): number {
  return normalizeMaxParallelToolCalls(
    config.maxParallelToolCalls ?? defaultMaxParallelToolCalls,
    "AgentConfig.maxParallelToolCalls"
  );
}

/**
 * Validates that a numeric runtime option is a positive safe integer,
 * returning it unchanged.
 *
 * @param label - Option name used in the error message and details (for
 *   example `"AgentConfig.maxParallelToolCalls"`).
 * @throws TuvrenRuntimeError with code `invalid_runtime_options` otherwise.
 */
export function normalizeMaxParallelToolCalls(
  value: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TuvrenRuntimeError(`${label} must be a positive safe integer`, {
      code: "invalid_runtime_options",
      details: {
        [label]: value,
      },
    });
  }

  return value;
}

/**
 * Validates the manifest extension-state warning budget option.
 *
 * `false` disables the warning entirely and is returned as-is; any other
 * value must be a positive safe integer byte budget.
 *
 * @throws TuvrenRuntimeError with code `invalid_runtime_options` when the
 *   value is neither `false` nor a positive safe integer.
 */
export function normalizeManifestExtensionStateWarningBudget(
  value: false | number
): false | number {
  if (value === false) {
    return false;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TuvrenRuntimeError(
      "manifestExtensionStateWarningBudgetBytes must be false or a positive safe integer",
      {
        code: "invalid_runtime_options",
        details: {
          manifestExtensionStateWarningBudgetBytes: value,
        },
      }
    );
  }

  return value;
}

/**
 * Normalizes and validates {@link RuntimeRunLivenessOptions} for run-lease
 * liveness.
 *
 * `executionOwnerId` must be non-empty, `leaseDurationMs` must be a positive
 * safe integer, and `renewBeforeMs` (defaulting to half the lease duration,
 * minimum 1) must be strictly smaller than `leaseDurationMs`.
 *
 * @returns The normalized options with `renewBeforeMs` filled in.
 * @throws TuvrenRuntimeError with code `invalid_runtime_options` when any
 *   constraint is violated.
 */
export function normalizeRunLivenessOptions(value: RuntimeRunLivenessOptions): {
  executionOwnerId: string;
  leaseDurationMs: number;
  renewBeforeMs: number;
} {
  if (value.executionOwnerId.length === 0) {
    throw new TuvrenRuntimeError(
      "runLiveness.executionOwnerId must be a non-empty string",
      {
        code: "invalid_runtime_options",
      }
    );
  }

  const leaseDurationMs = normalizeMaxParallelToolCalls(
    value.leaseDurationMs,
    "runLiveness.leaseDurationMs"
  );
  const renewBeforeMs = normalizeMaxParallelToolCalls(
    value.renewBeforeMs ?? Math.max(1, Math.floor(leaseDurationMs / 2)),
    "runLiveness.renewBeforeMs"
  );

  if (renewBeforeMs >= leaseDurationMs) {
    throw new TuvrenRuntimeError(
      "runLiveness.renewBeforeMs must be smaller than runLiveness.leaseDurationMs",
      {
        code: "invalid_runtime_options",
        details: {
          leaseDurationMs,
          renewBeforeMs,
        },
      }
    );
  }

  return {
    executionOwnerId: value.executionOwnerId,
    leaseDurationMs,
    renewBeforeMs,
  };
}

/**
 * Creates a frozen, read-only view of a tool registry for handing to runners.
 *
 * Listed tools are frozen snapshots whose `execute` throws (see
 * {@link createRunnerToolDefinitionSnapshot}), and `register` throws with
 * code `invalid_runner_result` so runners cannot mutate the execution
 * registry. `toDefinitions()` returns fresh clones on every call. Views are
 * cached per source registry, so repeated calls return the same instance.
 */
export function createReadonlyRunnerToolRegistry(
  registry: ToolRegistry
): ToolRegistry {
  const cachedRegistry = readonlyRunnerToolRegistryCache.get(registry);

  if (cachedRegistry !== undefined) {
    return cachedRegistry;
  }

  const toolSnapshots = registry
    .list()
    .map((tool) =>
      createFrozenSnapshot(createRunnerToolDefinitionSnapshot(tool))
    );
  const toolsByName = new Map(toolSnapshots.map((tool) => [tool.name, tool]));
  const renderedDefinitions = registry
    .toDefinitions()
    .map((tool) => cloneValue(tool));

  const readonlyRegistry = Object.freeze({
    get(name) {
      return toolsByName.get(name);
    },
    has(name) {
      return toolsByName.has(name);
    },
    list() {
      return [...toolSnapshots];
    },
    register(tool) {
      throw new TuvrenRuntimeError(
        `runners must not mutate the execution tool registry with "${tool.name}"`,
        {
          code: "invalid_runner_result",
          details: {
            toolName: tool.name,
          },
        }
      );
    },
    toDefinitions() {
      return renderedDefinitions.map((tool) => cloneValue(tool));
    },
  } satisfies ToolRegistry);
  readonlyRunnerToolRegistryCache.set(registry, readonlyRegistry);
  return readonlyRegistry;
}

/**
 * Creates the frozen {@link AgentConfig} snapshot exposed to runners, with
 * every tool (top-level and extension-owned) replaced by a non-executable
 * snapshot so runners can inspect but never invoke tool implementations.
 */
export function createRunnerAgentConfigSnapshot(
  config: AgentConfig
): AgentConfig {
  return createFrozenSnapshot({
    ...config,
    extensions: config.extensions?.map((extension) => ({
      ...extension,
      tools: extension.tools?.map((tool) =>
        createRunnerToolDefinitionSnapshot(tool)
      ),
    })),
    tools: config.tools?.map((tool) =>
      createRunnerToolDefinitionSnapshot(tool)
    ),
  });
}

/**
 * Creates a runner-facing snapshot of a tool definition: metadata and schema
 * are frozen copies, and `execute` throws a `TuvrenRuntimeError` with code
 * `invalid_runner_result` because runners must request tool calls through
 * resolutions rather than executing tools directly.
 */
export function createRunnerToolDefinitionSnapshot(
  tool: TuvrenToolDefinition
): TuvrenToolDefinition {
  return {
    approval: tool.approval,
    description: tool.description,
    execute() {
      throw new TuvrenRuntimeError(
        `runners must not execute tool "${tool.name}" from the read-only tool snapshot`,
        {
          code: "invalid_runner_result",
          details: {
            toolName: tool.name,
          },
        }
      );
    },
    inputSchema: createFrozenSnapshot(tool.inputSchema),
    metadata:
      tool.metadata === undefined
        ? undefined
        : createFrozenSnapshot(tool.metadata),
    name: tool.name,
    timeout: tool.timeout,
  };
}

/**
 * Deep-clones an {@link AgentConfig} for a request while preserving function
 * values (tool `execute` implementations, hooks) by reference, so the runtime
 * can mutate its working copy without affecting the caller's config object.
 * The `clientEndpointBoundary` is restored by reference — see the inline
 * comment for why its identity must be preserved.
 */
export function cloneAgentConfigForRequest(config: AgentConfig): AgentConfig {
  const cloned = cloneSnapshotPreservingFunctions(config);
  // clientEndpointBoundary is a stateful, identity-preserving object (the
  // capabilityIndex is mutable and external callers may detach endpoints).
  // Deep-cloning it would sever the connection between the caller's detach()
  // calls and the boundary the tool closures observe. Restore the original
  // reference so the caller and the closures share the same live object.
  if (config.clientEndpointBoundary !== undefined) {
    cloned.clientEndpointBoundary = config.clientEndpointBoundary;
  }
  return cloned;
}

/**
 * Asserts that a value is a valid kernel record and encodes it with the
 * deterministic kernel encoding, so equal records always yield identical
 * bytes (and therefore identical hashes).
 *
 * @param label - Name used in the assertion error when validation fails.
 */
export function encodeKernelRecord(value: unknown, label: string): Uint8Array {
  assertKernelRecord(value, label);
  return encodeDeterministicKernelRecord(value);
}

/**
 * Collects seed state updates for extensions that declare an initial `state`
 * but do not yet have an entry in the manifest's extension-state map.
 *
 * Extensions without initial state, or whose state already exists in the
 * manifest, are skipped; collected states are deep-cloned so later mutation
 * of the extension object cannot leak into the committed update.
 */
export function collectInitialExtensionStateUpdates(
  extensions: TuvrenExtension[],
  manifest: ContextManifest
): ExtensionStateUpdate[] {
  const updates: ExtensionStateUpdate[] = [];

  for (const extension of extensions) {
    if (
      extension.state === undefined ||
      Object.hasOwn(manifest.extensions, extension.name)
    ) {
      continue;
    }

    updates.push({
      extensionName: extension.name,
      state: cloneValue(extension.state),
    });
  }

  return updates;
}

/**
 * Computes a placeholder hash for record bytes that have not been committed
 * to the kernel store yet: a hex SHA-256 over the bytes prefixed with the
 * `tuvren-runtime-pending:` domain string, keeping pending hashes
 * domain-separated from hashes computed over the raw record bytes.
 */
export function createPendingKernelHash(value: Uint8Array): HashString {
  return createHash("sha256")
    .update("tuvren-runtime-pending:")
    .update(value)
    .digest("hex");
}
