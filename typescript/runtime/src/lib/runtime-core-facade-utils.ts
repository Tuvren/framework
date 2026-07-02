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

const readonlyDriverToolRegistryCache = new WeakMap<
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

export function resolveActiveMaxParallelToolCalls(
  config: AgentConfig,
  defaultMaxParallelToolCalls: number
): number {
  return normalizeMaxParallelToolCalls(
    config.maxParallelToolCalls ?? defaultMaxParallelToolCalls,
    "AgentConfig.maxParallelToolCalls"
  );
}

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

export function createReadonlyDriverToolRegistry(
  registry: ToolRegistry
): ToolRegistry {
  const cachedRegistry = readonlyDriverToolRegistryCache.get(registry);

  if (cachedRegistry !== undefined) {
    return cachedRegistry;
  }

  const toolSnapshots = registry
    .list()
    .map((tool) =>
      createFrozenSnapshot(createDriverToolDefinitionSnapshot(tool))
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
        `drivers must not mutate the execution tool registry with "${tool.name}"`,
        {
          code: "invalid_driver_result",
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
  readonlyDriverToolRegistryCache.set(registry, readonlyRegistry);
  return readonlyRegistry;
}

export function createDriverAgentConfigSnapshot(
  config: AgentConfig
): AgentConfig {
  return createFrozenSnapshot({
    ...config,
    extensions: config.extensions?.map((extension) => ({
      ...extension,
      tools: extension.tools?.map((tool) =>
        createDriverToolDefinitionSnapshot(tool)
      ),
    })),
    tools: config.tools?.map((tool) =>
      createDriverToolDefinitionSnapshot(tool)
    ),
  });
}

export function createDriverToolDefinitionSnapshot(
  tool: TuvrenToolDefinition
): TuvrenToolDefinition {
  return {
    approval: tool.approval,
    description: tool.description,
    execute() {
      throw new TuvrenRuntimeError(
        `drivers must not execute tool "${tool.name}" from the read-only tool snapshot`,
        {
          code: "invalid_driver_result",
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

export function encodeKernelRecord(value: unknown, label: string): Uint8Array {
  assertKernelRecord(value, label);
  return encodeDeterministicKernelRecord(value);
}

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

export function createPendingKernelHash(value: Uint8Array): HashString {
  return createHash("sha256")
    .update("tuvren-runtime-pending:")
    .update(value)
    .digest("hex");
}
