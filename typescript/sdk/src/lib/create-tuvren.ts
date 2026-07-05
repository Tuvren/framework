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

// The batteries-included composition entrypoint (ADR-040, retargeted by
// ADR-057). It lives on `@tuvren/sdk`, the host-facing composition tier: it
// composes the internal `@tuvren/runtime` engine with host-constructed leaf
// instances (backend, runner, provider, tools). Per ADR-057 §2 the options are
// instances-only — the kind-tagged string shorthands (`"memory"`, `"react"`,
// …) are retired, so this file carries no backend/runner/provider dependency;
// the host constructs those from the leaf packages it chose and passes them in.

import { TuvrenValidationError } from "@tuvren/core";
import type {
  AgentConfig,
  ExecutionBounds,
  OrchestrationRuntime,
  TuvrenRuntime,
} from "@tuvren/core/execution";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { PayloadCodec } from "@tuvren/core/lifecycle";
import type { TuvrenProvider } from "@tuvren/core/provider";
import type { RuntimeRunnerFactory } from "@tuvren/core/runner";
import type { TuvrenTelemetrySink } from "@tuvren/core/telemetry";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import type { RuntimeBackend, RuntimeKernel } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import {
  createOrchestrationRuntime,
  createRunnerRegistry,
  createTuvrenRuntime,
  type RuntimeCoreOptions,
} from "@tuvren/runtime";

// ── Public options ────────────────────────────────────────────────────────────

/**
 * Structural shape of an MCP tool source. Declared here — structurally identical
 * to `@tuvren/mcp-client`'s `McpToolSource` — so `@tuvren/sdk` does not depend on
 * `@tuvren/mcp-client` (which itself depends on `@tuvren/sdk` for `defineTool`;
 * a package dependency would form a cycle). A real `createMcpToolSource(...)`
 * result from `@tuvren/mcp-client` is structurally assignable to this type, so a
 * host passes it straight into `tools` with no adapter. `createTuvren` only
 * duck-types this shape (via `isMcpToolSource`), never a nominal import.
 */
export interface McpToolSource {
  close(): Promise<void>;
  refresh(): Promise<{ tools: TuvrenToolDefinition[] }>;
  readonly serverName: string;
  readonly tools: TuvrenToolDefinition[];
}

export interface CreateTuvrenOptions {
  /**
   * Pre-built durable backend instance (ADR-057: instances only — no
   * `"memory"`/`"sqlite"`/`"postgres"` string shorthand). Construct it from the
   * leaf package you chose — `createMemoryBackend()`, `createSqliteBackend({
   * databasePath })`, `createPostgresBackend({ ... })` — and pass the instance.
   * `createTuvren` takes ownership: `[Symbol.asyncDispose]` calls `close()` on
   * it. Do not share a backend across multiple `TuvrenInstance` objects unless
   * you manage its lifecycle externally and pass a no-op-closing wrapper.
   */
  backend: RuntimeBackend;
  /**
   * Framework-enforced per-turn execution bounds (ADR-043, KRT-BD006). Supply
   * at the top level or via `runtimeOptions.bounds`, but not both. Unset fields
   * take the §3.11 safe defaults; a runner cannot raise or disable a bound.
   */
  bounds?: ExecutionBounds;
  extensions?: TuvrenExtension[];
  /** Pre-built kernel — when supplied the factory skips kernel construction. */
  kernel?: RuntimeKernel;
  /**
   * Opt-in crypto-shredding codec (ADR-051, KRT-BF005). Supply at the top level
   * or via `runtimeOptions.payloadCodec`, but not both. Unset defaults to a
   * plaintext identity codec, leaving existing hosts unchanged. Use
   * `createAesGcmPayloadCodec({ keyring })` from `@tuvren/sdk` for the
   * batteries-included AES-256-GCM codec, or implement `PayloadCodec` over a
   * KMS/HSM.
   */
  payloadCodec?: PayloadCodec;
  provider?: TuvrenProvider;
  /**
   * Pre-built runner factory instance (ADR-057: instances only — no `"react"`
   * string shorthand and no implicit default). Construct it from the leaf
   * package you chose, e.g. `createReActRunner()` from `@tuvren/runner-react`,
   * and pass the instance.
   */
  runner: RuntimeRunnerFactory;
  runtimeOptions?: Omit<
    RuntimeCoreOptions,
    "defaultRunnerId" | "runnerRegistry" | "kernel"
  >;
  telemetry?: TuvrenTelemetrySink;
  tools?: Array<McpToolSource | TuvrenToolDefinition>;
}

export interface TuvrenInstance {
  kernel: RuntimeKernel;
  orchestration: OrchestrationRuntime;
  provider?: TuvrenProvider;
  runtime: TuvrenRuntime;
  [Symbol.asyncDispose](): Promise<void>;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createTuvren(
  options: CreateTuvrenOptions
): Promise<TuvrenInstance> {
  if (
    options.telemetry !== undefined &&
    options.runtimeOptions?.telemetry !== undefined
  ) {
    throw new TuvrenValidationError(
      "createTuvren: telemetry must be supplied either at top level or runtimeOptions, not both",
      { code: "invalid_createtuvren_options" }
    );
  }

  if (
    options.bounds !== undefined &&
    options.runtimeOptions?.bounds !== undefined
  ) {
    throw new TuvrenValidationError(
      "createTuvren: bounds must be supplied either at top level or runtimeOptions, not both",
      { code: "invalid_createtuvren_options" }
    );
  }

  if (
    options.payloadCodec !== undefined &&
    options.runtimeOptions?.payloadCodec !== undefined
  ) {
    throw new TuvrenValidationError(
      "createTuvren: payloadCodec must be supplied either at top level or runtimeOptions, not both",
      { code: "invalid_createtuvren_options" }
    );
  }

  // When a pre-built kernel is supplied, skip backend construction entirely.
  // The kernel already owns its backend; constructing a second one would open
  // an idle connection pool / file handle that is immediately discarded.
  const { kernel, disposeBackend, purgeScope } =
    resolveKernelAndDispose(options);

  const runner = options.runner;
  const runnerRegistry = createRunnerRegistry([runner]);

  const mcpSources = collectMcpSources(options.tools);
  const globalTools = collectTools(options.tools);

  const defaultAgentConfig: AgentConfig = {
    name: "agent",
    ...(options.provider === undefined ? {} : { model: options.provider }),
    ...(options.extensions === undefined
      ? {}
      : { extensions: options.extensions }),
    ...(globalTools.length > 0 ? { tools: globalTools } : {}),
  };

  const runtime = createTuvrenRuntime({
    ...options.runtimeOptions,
    bounds: options.bounds ?? options.runtimeOptions?.bounds,
    defaultRunnerId: runner.id,
    runnerRegistry,
    kernel,
    payloadCodec: options.payloadCodec ?? options.runtimeOptions?.payloadCodec,
    ...(purgeScope === undefined ? {} : { purgeScope }),
    telemetry: options.telemetry ?? options.runtimeOptions?.telemetry,
  });

  const orchestration = createOrchestrationRuntime({
    agents: { agent: defaultAgentConfig },
    framework: runtime,
  });

  const instance: TuvrenInstance = {
    kernel,
    orchestration,
    runtime,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    async [Symbol.asyncDispose](): Promise<void> {
      const errors: Error[] = [];

      for (const source of mcpSources) {
        try {
          await source.close();
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }

      try {
        await disposeBackend();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }

      if (errors.length > 0) {
        const message = errors.map((e) => e.message).join("; ");
        throw new Error(`createTuvren disposal encountered errors: ${message}`);
      }
    },
  };

  return Promise.resolve(instance);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function resolveKernelAndDispose(options: CreateTuvrenOptions): {
  kernel: RuntimeKernel;
  disposeBackend: () => Promise<void>;
  purgeScope?: () => Promise<void>;
} {
  if (options.kernel !== undefined) {
    // An externally-supplied kernel owns its substrate; `createTuvren` has no
    // backend handle to drive a partition drop, so `maintenance.purgeScope`
    // stays unavailable on the resulting runtime.
    return { kernel: options.kernel, disposeBackend: () => Promise.resolve() };
  }

  const backend = options.backend;
  return {
    kernel: createRuntimeKernel({ backend }),
    disposeBackend: tryCloseBackend(backend),
    // Surface the substrate partition-drop (ADR-051, §4.17) only when the owned
    // backend implements it; otherwise the runtime maintenance surface reports
    // it as unsupported.
    ...(typeof backend.purgeScope === "function"
      ? {
          purgeScope: (): Promise<void> =>
            backend.purgeScope?.() ?? Promise.resolve(),
        }
      : {}),
  };
}

function collectMcpSources(
  tools: CreateTuvrenOptions["tools"]
): McpToolSource[] {
  if (tools === undefined) {
    return [];
  }
  return tools.filter(isMcpToolSource);
}

function collectTools(
  tools: CreateTuvrenOptions["tools"]
): TuvrenToolDefinition[] {
  if (tools === undefined) {
    return [];
  }
  const result: TuvrenToolDefinition[] = [];
  for (const item of tools) {
    if (isMcpToolSource(item)) {
      result.push(...item.tools);
    } else {
      result.push(item);
    }
  }
  return result;
}

function isMcpToolSource(
  item: McpToolSource | TuvrenToolDefinition
): item is McpToolSource {
  const obj = item as unknown as Record<string, unknown>;
  return (
    typeof obj.serverName === "string" &&
    typeof obj.refresh === "function" &&
    typeof obj.close === "function"
  );
}

function tryCloseBackend(backend: RuntimeBackend): () => Promise<void> {
  const b = backend as unknown as Record<string, unknown>;
  if (typeof b.close === "function") {
    return () => (b.close as () => Promise<void>)();
  }
  return () => Promise.resolve();
}
