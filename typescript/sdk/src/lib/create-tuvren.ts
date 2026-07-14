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
import type { TelemetryRouting } from "@tuvren/core/telemetry";
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
  /**
   * Closes the underlying MCP connection. Called automatically for every
   * source passed to {@link createTuvren} when the returned
   * {@link TuvrenInstance} is disposed via `Symbol.asyncDispose`.
   */
  close(): Promise<void>;
  /** Re-lists the server's tools, returning the refreshed definitions. */
  refresh(): Promise<{ tools: TuvrenToolDefinition[] }>;
  /** Human-readable identifier of the MCP server backing this source. */
  readonly serverName: string;
  /**
   * The tool definitions currently exposed by the server. `createTuvren`
   * flattens these into the default agent's tool list at construction time.
   */
  readonly tools: TuvrenToolDefinition[];
}

/**
 * Options for {@link createTuvren}, the batteries-included composition
 * entrypoint (ADR-040, ADR-057).
 *
 * Per ADR-057 §2 the options are instances-only: the host constructs the
 * backend, runner, and provider from the leaf packages it chose and passes
 * the instances in — there are no kind-tagged string shorthands.
 */
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
  /** Extensions attached to the default agent configuration. */
  extensions?: TuvrenExtension[];
  /**
   * Pre-built kernel — when supplied the factory skips kernel construction
   * entirely and ignores backend ownership: the kernel already owns its
   * substrate, so `createTuvren` neither closes a backend on dispose nor
   * exposes `maintenance.purgeScope` on the resulting runtime.
   */
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
  /**
   * Default model provider wired into the default agent configuration and
   * surfaced on {@link TuvrenInstance.provider}. When omitted, the default
   * agent has no model; execution paths that need one must receive it another
   * way (for example per-agent configuration on the orchestration surface).
   */
  provider?: TuvrenProvider;
  /**
   * Pre-built runner factory instance (ADR-057: instances only — no `"react"`
   * string shorthand and no implicit default). Construct it from the leaf
   * package you chose, e.g. `createReActRunner()` from `@tuvren/runner-react`,
   * and pass the instance.
   */
  runner: RuntimeRunnerFactory;
  /**
   * Pass-through engine options forwarded to the internal
   * `createTuvrenRuntime` factory. The composition-owned fields
   * (`defaultRunnerId`, `runnerRegistry`, `kernel`) are excluded because
   * `createTuvren` derives them from `runner`, `backend`, and `kernel`.
   * `telemetry`, `bounds`, and `payloadCodec` may be supplied here or at the
   * top level, but not both places at once.
   */
  runtimeOptions?: Omit<
    RuntimeCoreOptions,
    "defaultRunnerId" | "runnerRegistry" | "kernel"
  >;
  /**
   * Construction-time telemetry funnel routing (ADR-058). Accepts a bare
   * `TuvrenTelemetrySink` (ADR-042, backward-compatible), a bare
   * `TelemetryDestination`, or a `TelemetryRoute` combining both — the seam a
   * host uses to choose split, unified, or mixed-substrate topologies without
   * changing session behavior.
   */
  telemetry?: TelemetryRouting;
  /**
   * Global tools for the default agent: plain {@link TuvrenToolDefinition}
   * values (for example from `defineTool`) and/or {@link McpToolSource}
   * instances, freely mixed. MCP sources are duck-typed by shape, their tools
   * are flattened into the agent's tool list at construction time, and every
   * source is closed when the instance is disposed.
   */
  tools?: Array<McpToolSource | TuvrenToolDefinition>;
}

/**
 * The composed framework instance returned by {@link createTuvren}.
 *
 * Dispose it with `await using` (or by calling `[Symbol.asyncDispose]()`
 * directly) when done: disposal closes every MCP tool source and, unless a
 * pre-built kernel was supplied, the owned backend. Disposal errors are
 * aggregated — every resource is attempted before a combined error is thrown.
 */
export interface TuvrenInstance {
  /** The kernel in use — either the host-supplied one or the one constructed
   * over `options.backend`. */
  kernel: RuntimeKernel;
  /**
   * The orchestration surface, pre-configured with a single default agent
   * named `"agent"` that carries the supplied provider, extensions, and
   * global tools.
   */
  orchestration: OrchestrationRuntime;
  /** The provider passed in `options.provider`, when one was supplied. */
  provider?: TuvrenProvider;
  /** The underlying framework runtime composed over the kernel. */
  runtime: TuvrenRuntime;
  /** Closes MCP tool sources and the owned backend; aggregates errors. */
  [Symbol.asyncDispose](): Promise<void>;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Composes a ready-to-use Tuvren framework instance from host-constructed
 * leaf instances (ADR-040, retargeted by ADR-057).
 *
 * Builds a kernel over the supplied backend (unless a pre-built `kernel` is
 * given), registers the supplied runner as the default, flattens plain tools
 * and MCP tool sources into a single default agent named `"agent"`, and wires
 * the runtime plus orchestration surfaces on top. The returned instance owns
 * the backend and MCP sources: dispose it to release them.
 *
 * @param options - Instances-only composition options; `backend` and `runner`
 *   are required, everything else is optional.
 * @returns A promise of the composed {@link TuvrenInstance}. The factory is
 *   currently synchronous internally; the promise shape leaves room for async
 *   composition steps without a signature break.
 * @throws TuvrenValidationError (code `invalid_createtuvren_options`) when
 *   `telemetry`, `bounds`, or `payloadCodec` is supplied both at the top
 *   level and inside `runtimeOptions`.
 *
 * @example
 * ```ts
 * import { createTuvren } from "@tuvren/sdk";
 * import { createMemoryBackend } from "@tuvren/backend-memory";
 * import { createReActRunner } from "@tuvren/runner-react";
 *
 * await using tuvren = await createTuvren({
 *   backend: createMemoryBackend(),
 *   runner: createReActRunner(),
 *   provider: myProvider, // a TuvrenProvider instance
 * });
 *
 * const { threadId } = await tuvren.runtime.createThread({});
 * ```
 */
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
